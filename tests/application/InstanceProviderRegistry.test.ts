import { describe, expect, it } from 'vitest';
import { InstanceProviderRegistry } from '../../src/application/InstanceProviderRegistry.js';
import { ProviderRegistry } from '../../src/registry/ProviderRegistry.js';
import { InMemoryInstanceRepository } from '../../src/infrastructure/persistence/InMemoryInstanceRepository.js';
import { ConsoleLogger } from '../../src/infrastructure/logging/ConsoleLogger.js';
import { ZApiProvider } from '../../src/providers/zapi/ZApiProvider.js';
import type { CommunicationProvider } from '../../src/core/interfaces/CommunicationProvider.js';
import type { Instance } from '../../src/core/entities/Instance.js';

function fakeEvolutionProvider(): CommunicationProvider {
  return {
    name: 'evolution',
    connect: async () => ({ status: 'connected' }),
    getQrCode: async () => ({ status: 'connected' }),
    disconnect: async () => {},
    getStatus: async () => ({ instanceId: 'x', state: 'open' }),
    setWebhook: async () => {},
    checkNumbers: async () => [],
    sendText: async () => ({ raw: null }),
    sendImage: async () => ({ raw: null }),
    sendSticker: async () => ({ raw: null }),
    sendAudio: async () => ({ raw: null }),
    sendVideo: async () => ({ raw: null }),
    sendDocument: async () => ({ raw: null }),
    sendLocation: async () => ({ raw: null }),
    sendButtons: async () => ({ raw: null }),
    sendList: async () => ({ raw: null }),
    sendCarousel: async () => ({ raw: null }),
    sendReaction: async () => ({ raw: null }),
    parseWebhookPayload: () => [],
  };
}

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-01',
    provider: 'zapi',
    state: 'open',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('InstanceProviderRegistry', () => {
  it('create para evolution devolve o provider compartilhado do ProviderRegistry', () => {
    const shared = new ProviderRegistry();
    const evolution = fakeEvolutionProvider();
    shared.register(evolution);

    const registry = new InstanceProviderRegistry(shared, new InMemoryInstanceRepository(), new ConsoleLogger());
    const provider = registry.create('inst-01', 'evolution');

    expect(provider).toBe(evolution);
  });

  it('create para zapi constrói um ZApiProvider dedicado a partir das credenciais', async () => {
    const registry = new InstanceProviderRegistry(new ProviderRegistry(), new InMemoryInstanceRepository(), new ConsoleLogger());

    const provider = registry.create('inst-01', 'zapi', { instanceId: 'zapi-inst', token: 'tok' });

    expect(provider).toBeInstanceOf(ZApiProvider);
    expect(await registry.resolve('inst-01', 'zapi')).toBe(provider);
  });

  it('create para zapi sem credenciais lança erro claro', () => {
    const registry = new InstanceProviderRegistry(new ProviderRegistry(), new InMemoryInstanceRepository(), new ConsoleLogger());
    expect(() => registry.create('inst-01', 'zapi')).toThrow(/Credenciais da Z-API/);
  });

  it('create para meta sem credenciais lança erro claro', () => {
    const registry = new InstanceProviderRegistry(new ProviderRegistry(), new InMemoryInstanceRepository(), new ConsoleLogger());
    expect(() => registry.create('inst-01', 'meta')).toThrow(/Credenciais da Meta Cloud API/);
  });

  it('create com provider desconhecido lança erro claro (não cai silenciosamente em meta)', () => {
    const registry = new InstanceProviderRegistry(new ProviderRegistry(), new InMemoryInstanceRepository(), new ConsoleLogger());
    expect(() =>
      registry.create('inst-01', 'discord' as unknown as 'meta', { phoneNumberId: 'x', accessToken: 'y' }),
    ).toThrow(/Provider desconhecido/);
  });

  it('resolve lança erro para instância zapi/meta que nunca existiu (nem em cache, nem persistida)', async () => {
    const registry = new InstanceProviderRegistry(new ProviderRegistry(), new InMemoryInstanceRepository(), new ConsoleLogger());
    await expect(registry.resolve('nunca-criada', 'zapi')).rejects.toThrow(/não encontrada/);
  });

  it('delete remove o provider por instância, mas não afeta o registry compartilhado', async () => {
    const shared = new ProviderRegistry();
    shared.register(fakeEvolutionProvider());
    const registry = new InstanceProviderRegistry(shared, new InMemoryInstanceRepository(), new ConsoleLogger());
    registry.create('inst-01', 'zapi', { instanceId: 'zapi-inst', token: 'tok' });

    registry.delete('inst-01');

    await expect(registry.resolve('inst-01', 'zapi')).rejects.toThrow(/não encontrada/);
    expect(await registry.resolve('qualquer', 'evolution')).toBeDefined();
  });

  it('resolve reconstrói o provider a partir do InstanceRepository quando o cache está vazio (simula restart)', async () => {
    const instanceRepository = new InMemoryInstanceRepository();
    await instanceRepository.save(
      makeInstance({ id: 'inst-01', provider: 'zapi', credentials: { instanceId: 'zapi-inst', token: 'tok' } }),
    );

    // Novo InstanceProviderRegistry "do zero" (cache em memória vazio), como aconteceria
    // depois de um restart do processo — só o InstanceRepository (persistido) sobrevive.
    const registry = new InstanceProviderRegistry(new ProviderRegistry(), instanceRepository, new ConsoleLogger());

    const provider = await registry.resolve('inst-01', 'zapi');

    expect(provider).toBeInstanceOf(ZApiProvider);
    // segunda chamada usa o cache (mesma instância), sem precisar consultar o repositório de novo
    expect(await registry.resolve('inst-01', 'zapi')).toBe(provider);
  });

  it('resolve não reconstrói quando a instância persistida não tem credentials', async () => {
    const instanceRepository = new InMemoryInstanceRepository();
    await instanceRepository.save(makeInstance({ id: 'inst-01', provider: 'zapi', credentials: undefined }));

    const registry = new InstanceProviderRegistry(new ProviderRegistry(), instanceRepository, new ConsoleLogger());

    await expect(registry.resolve('inst-01', 'zapi')).rejects.toThrow(/não encontrada/);
  });
});
