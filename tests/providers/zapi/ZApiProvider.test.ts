import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZApiProvider } from '../../../src/providers/zapi/ZApiProvider.js';
import { ConsoleLogger } from '../../../src/infrastructure/logging/ConsoleLogger.js';
import { UnsupportedProviderOperationException } from '../../../src/core/exceptions/UnsupportedProviderOperationException.js';

vi.mock('axios', async () => {
  const actual = await vi.importActual<typeof axios>('axios');
  return {
    default: {
      ...actual.default,
      create: vi.fn(() => ({ post: vi.fn(), get: vi.fn(), delete: vi.fn(), put: vi.fn() })),
      isAxiosError: actual.default.isAxiosError,
    },
  };
});

function makeProvider() {
  const logger = new ConsoleLogger();
  vi.spyOn(logger, 'error').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  return new ZApiProvider({ name: 'zapi', instanceId: 'inst-01', token: 'token-01' }, logger);
}

function getAxios(provider: ZApiProvider) {
  return (provider as unknown as { http: { options: { axiosInstance: Record<string, ReturnType<typeof vi.fn>> } } }).http
    .options.axiosInstance;
}

describe('ZApiProvider', () => {
  let provider: ZApiProvider;

  beforeEach(() => {
    provider = makeProvider();
  });

  it('connect e getQrCode fazem a mesma chamada GET /instance/qrcode', async () => {
    const http = getAxios(provider);
    http['get']!.mockResolvedValueOnce({ data: { value: 'data:image/png;base64,AAA' } });

    const connectResult = await provider.connect('inst-01');
    expect(connectResult.qrCode).toBe('data:image/png;base64,AAA');

    http['get']!.mockResolvedValueOnce({ data: { value: 'data:image/png;base64,BBB' } });
    const qrResult = await provider.getQrCode('inst-01');
    expect(qrResult.qrCode).toBe('data:image/png;base64,BBB');

    expect(http['get']).toHaveBeenCalledWith('/instance/qrcode');
  });

  it('getPairingCode lança UnsupportedProviderOperationException (não implementado pra Z-API ainda)', async () => {
    await expect(provider.getPairingCode('inst-01', '5511999998888')).rejects.toThrow(UnsupportedProviderOperationException);
  });

  it('sendText envia phone/message no payload', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({ data: { messageId: 'msg-1' } });

    const result = await provider.sendText('inst-01', '5598999990000', 'Olá!');

    expect(http['post']).toHaveBeenCalledWith('/send-text', {
      phone: '5598999990000',
      message: 'Olá!',
      delayMessage: undefined,
    });
    expect(result.messageId).toBe('msg-1');
  });

  it('checkNumbers filtra apenas números existentes e limpa o outputPhone', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({
      data: [
        { exists: true, outputPhone: '5598999990000' },
        { exists: false, outputPhone: '5511000000000' },
      ],
    });

    const result = await provider.checkNumbers('inst-01', ['5598999990000', '5511000000000']);

    expect(http['post']).toHaveBeenCalledWith('/contacts/get-iswhatsapp-batch', {
      phones: ['5598999990000', '5511000000000'],
    });
    expect(result).toEqual(['5598999990000']);
  });

  it('getStatus mapeia connected=true para state "open"', async () => {
    const http = getAxios(provider);
    http['get']!.mockResolvedValueOnce({ data: { connected: true } });

    const status = await provider.getStatus('inst-01');

    expect(status.state).toBe('open');
  });

  it('getStatus mapeia connected=false para state "close"', async () => {
    const http = getAxios(provider);
    http['get']!.mockResolvedValueOnce({ data: { connected: false } });

    const status = await provider.getStatus('inst-01');

    expect(status.state).toBe('close');
  });

  it('sendButtons mapeia ButtonsContent para buttonList.buttons', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({ data: {} });

    await provider.sendButtons('inst-01', '5598999990000', {
      body: 'Corpo',
      buttons: [{ id: 'BTN_SIM', displayText: 'Sim' }],
    });

    expect(http['post']).toHaveBeenCalledWith('/send-button-list', {
      phone: '5598999990000',
      message: 'Corpo',
      buttonList: { buttons: [{ label: 'Sim', id: 'BTN_SIM' }] },
    });
  });

  it('sendList achata as seções numa lista única de opções', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({ data: {} });

    await provider.sendList('inst-01', '5598999990000', {
      title: 'Título',
      description: 'Descrição',
      buttonText: 'Ver opções',
      sections: [
        { title: 'Seção 1', rows: [{ rowId: 'r1', title: 'Linha 1' }] },
        { title: 'Seção 2', rows: [{ rowId: 'r2', title: 'Linha 2', description: 'desc' }] },
      ],
    });

    expect(http['post']).toHaveBeenCalledWith('/send-option-list', {
      phone: '5598999990000',
      message: 'Descrição',
      optionList: {
        title: 'Título',
        buttonLabel: 'Ver opções',
        options: [
          { id: 'r1', title: 'Linha 1', description: undefined },
          { id: 'r2', title: 'Linha 2', description: 'desc' },
        ],
      },
    });
  });

  it('setWebhook chama update-webhook-received-delivery com a url', async () => {
    const http = getAxios(provider);
    http['put']!.mockResolvedValueOnce({ data: {} });

    await provider.setWebhook('inst-01', { url: 'https://app.test/webhook', enabled: true });

    expect(http['put']).toHaveBeenCalledWith('/update-webhook-received-delivery', { value: 'https://app.test/webhook' });
  });

  describe('parseWebhookPayload', () => {
    function payload(body: unknown): Buffer {
      return Buffer.from(JSON.stringify(body));
    }

    it('mensagem de texto recebida vira MessageReceived', () => {
      const events = provider.parseWebhookPayload(
        payload({ instanceId: 'inst-01', phone: '5598999990000', messageId: 'MSG1', text: { message: 'oi' } }),
        {},
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'MessageReceived',
        instanceId: 'inst-01',
        payload: { from: '5598999990000', messageId: 'MSG1' },
      });
    });

    it('status READ vira MessageRead', () => {
      const events = provider.parseWebhookPayload(
        payload({ instanceId: 'inst-01', status: 'READ', ids: ['MSG1'] }),
        {},
      );
      expect(events[0]).toMatchObject({ type: 'MessageRead', payload: { messageId: 'MSG1' } });
    });

    it('connected=false vira ConnectionLost', () => {
      const events = provider.parseWebhookPayload(payload({ instanceId: 'inst-01', connected: false }), {});
      expect(events[0]).toMatchObject({ type: 'ConnectionLost', instanceId: 'inst-01' });
    });

    it('payload não reconhecido não gera nenhum DomainEvent', () => {
      const events = provider.parseWebhookPayload(payload({ instanceId: 'inst-01' }), {});
      expect(events).toEqual([]);
    });
  });
});
