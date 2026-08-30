import { describe, expect, it, vi } from 'vitest';
import { FlowBridgeClient } from '../../src/application/FlowBridgeClient.js';
import { ProviderRegistry } from '../../src/registry/ProviderRegistry.js';
import type { CommunicationProvider } from '../../src/core/interfaces/CommunicationProvider.js';

function fakeProvider(name: CommunicationProvider['name']): CommunicationProvider {
  return {
    name,
    connect: vi.fn(async () => ({ status: 'connected' as const })),
    disconnect: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({ instanceId: 'x', state: 'open' as const })),
    setWebhook: vi.fn(async () => {}),
    checkNumbers: vi.fn(async () => ['5598999990000']),
    sendText: vi.fn(async () => ({ raw: { from: name } })),
    sendImage: vi.fn(async () => ({ raw: null })),
    sendSticker: vi.fn(async () => ({ raw: null })),
    sendAudio: vi.fn(async () => ({ raw: null })),
    sendVideo: vi.fn(async () => ({ raw: null })),
    sendDocument: vi.fn(async () => ({ raw: null })),
    sendLocation: vi.fn(async () => ({ raw: null })),
    sendButtons: vi.fn(async () => ({ raw: null })),
    sendList: vi.fn(async () => ({ raw: null })),
    sendCarousel: vi.fn(async () => ({ raw: null })),
    sendReaction: vi.fn(async () => ({ raw: null })),
  };
}

describe('FlowBridgeClient', () => {
  it('sendText resolve o provider certo pelo nome, sem ramificação própria', async () => {
    const evolution = fakeProvider('evolution');
    const meta = fakeProvider('meta');
    const registry = new ProviderRegistry();
    registry.register(evolution);
    registry.register(meta);
    const client = new FlowBridgeClient(registry);

    const resultEvolution = await client.sendText({
      provider: 'evolution',
      instanceId: 'inst-01',
      to: '5598999990000',
      text: 'Olá!',
    });
    const resultMeta = await client.sendText({
      provider: 'meta',
      instanceId: 'PHONE_ID',
      to: '5598999990000',
      text: 'Olá!',
    });

    expect(evolution.sendText).toHaveBeenCalledWith('inst-01', '5598999990000', 'Olá!', undefined);
    expect(meta.sendText).toHaveBeenCalledWith('PHONE_ID', '5598999990000', 'Olá!', undefined);
    expect(resultEvolution.raw).toEqual({ from: 'evolution' });
    expect(resultMeta.raw).toEqual({ from: 'meta' });
  });

  it('checkNumbers delega para o provider resolvido', async () => {
    const zapi = fakeProvider('zapi');
    const registry = new ProviderRegistry();
    registry.register(zapi);
    const client = new FlowBridgeClient(registry);

    const result = await client.checkNumbers({ provider: 'zapi', instanceId: 'inst-01', numbers: ['5598999990000'] });

    expect(zapi.checkNumbers).toHaveBeenCalledWith('inst-01', ['5598999990000']);
    expect(result).toEqual(['5598999990000']);
  });

  it('sendButtons repassa o content tal como recebido', async () => {
    const evolution = fakeProvider('evolution');
    const registry = new ProviderRegistry();
    registry.register(evolution);
    const client = new FlowBridgeClient(registry);
    const content = { body: 'Confirma?', buttons: [{ id: 'BTN_SIM', displayText: 'Sim' }] };

    await client.sendButtons({ provider: 'evolution', instanceId: 'inst-01', to: '5598999990000', content });

    expect(evolution.sendButtons).toHaveBeenCalledWith('inst-01', '5598999990000', content);
  });

  it('lança erro claro quando o provider não está registrado', async () => {
    const registry = new ProviderRegistry();
    const client = new FlowBridgeClient(registry);

    await expect(
      client.sendText({ provider: 'meta', instanceId: 'x', to: '123', text: 'oi' }),
    ).rejects.toThrow('Provider "meta" não está registrado');
  });
});
