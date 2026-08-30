import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../src/registry/ProviderRegistry.js';
import type { CommunicationProvider } from '../../src/core/interfaces/CommunicationProvider.js';

function fakeProvider(name: CommunicationProvider['name']): CommunicationProvider {
  return {
    name,
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

describe('ProviderRegistry', () => {
  it('resolve retorna o provider registrado pelo nome', () => {
    const registry = new ProviderRegistry();
    const evolution = fakeProvider('evolution');
    registry.register(evolution);

    expect(registry.resolve('evolution')).toBe(evolution);
  });

  it('resolve lança erro para provider não registrado', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.resolve('meta')).toThrow('Provider "meta" não está registrado');
  });

  it('has indica se um provider está registrado', () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider('zapi'));

    expect(registry.has('zapi')).toBe(true);
    expect(registry.has('meta')).toBe(false);
  });

  it('permite registrar múltiplos providers simultaneamente', () => {
    const registry = new ProviderRegistry();
    registry.register(fakeProvider('evolution'));
    registry.register(fakeProvider('meta'));

    expect(registry.list().map((p) => p.name).sort()).toEqual(['evolution', 'meta']);
  });
});
