import axios from 'axios';
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaCloudApiProvider } from '../../../src/providers/meta/MetaCloudApiProvider.js';
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

function makeProvider(wabaId?: string, appSecret?: string) {
  const logger = new ConsoleLogger();
  vi.spyOn(logger, 'error').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  return new MetaCloudApiProvider(
    { name: 'meta', phoneNumberId: 'PHONE_ID', accessToken: 'token', wabaId, appSecret },
    logger,
  );
}

function getAxios(provider: MetaCloudApiProvider) {
  return (provider as unknown as { http: { options: { axiosInstance: Record<string, ReturnType<typeof vi.fn>> } } }).http
    .options.axiosInstance;
}

describe('MetaCloudApiProvider', () => {
  let provider: MetaCloudApiProvider;

  beforeEach(() => {
    provider = makeProvider('WABA_ID');
  });

  it('sendText usa o endpoint /messages com type=text', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.1' }] } });

    const result = await provider.sendText('inst-01', '5598999990000', 'Olá!');

    expect(http['post']).toHaveBeenCalledWith('/PHONE_ID/messages', {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5598999990000',
      type: 'text',
      text: { body: 'Olá!' },
    });
    expect(result.messageId).toBe('wamid.1');
  });

  it('sendButtons valida e rejeita mais de 3 botões', async () => {
    await expect(
      provider.sendButtons('inst-01', '5598999990000', {
        body: 'Escolha uma opção',
        buttons: [
          { id: '1', displayText: 'Um' },
          { id: '2', displayText: 'Dois' },
          { id: '3', displayText: 'Três' },
          { id: '4', displayText: 'Quatro' },
        ],
      }),
    ).rejects.toThrow(/no máximo 3 botões/);
  });

  it('sendButtons monta interactive.button para conteúdo válido', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.2' }] } });

    await provider.sendButtons('inst-01', '5598999990000', {
      body: 'Confirma?',
      buttons: [{ id: 'BTN_SIM', displayText: 'Sim' }],
    });

    expect(http['post']).toHaveBeenCalledWith(
      '/PHONE_ID/messages',
      expect.objectContaining({
        type: 'interactive',
        interactive: expect.objectContaining({
          type: 'button',
          body: { text: 'Confirma?' },
          action: { buttons: [{ type: 'reply', reply: { id: 'BTN_SIM', title: 'Sim' } }] },
        }),
      }),
    );
  });

  it('sendCarousel exige providerOptions.templateName e languageCode', async () => {
    await expect(
      provider.sendCarousel('inst-01', '5598999990000', {
        body: 'Confira nossos planos',
        cards: [{ body: 'Plano Pro', buttons: [{ id: 'PRO', displayText: 'Quero esse' }] }],
      }),
    ).rejects.toThrow(UnsupportedProviderOperationException);
  });

  it('sendCarousel monta template quando providerOptions é informado', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.3' }] } });

    await provider.sendCarousel(
      'inst-01',
      '5598999990000',
      { body: 'Confira nossos planos', cards: [{ body: 'Plano Pro', imageUrl: 'https://img/pro.jpg', buttons: [{ id: 'PRO', displayText: 'Quero esse' }] }] },
      { templateName: 'planos_carousel', languageCode: 'pt_BR' },
    );

    expect(http['post']).toHaveBeenCalledWith(
      '/PHONE_ID/messages',
      expect.objectContaining({
        type: 'template',
        template: expect.objectContaining({ name: 'planos_carousel', language: { code: 'pt_BR' } }),
      }),
    );
  });

  it('checkNumbers lança UnsupportedProviderOperationException', async () => {
    await expect(provider.checkNumbers('inst-01', ['5598999990000'])).rejects.toThrow(
      UnsupportedProviderOperationException,
    );
  });

  it('disconnect lança UnsupportedProviderOperationException', async () => {
    await expect(provider.disconnect('inst-01')).rejects.toThrow(UnsupportedProviderOperationException);
  });

  it('getQrCode lança UnsupportedProviderOperationException (Cloud API não usa QR)', async () => {
    await expect(provider.getQrCode('inst-01')).rejects.toThrow(UnsupportedProviderOperationException);
  });

  it('getPairingCode lança UnsupportedProviderOperationException (Cloud API não usa código de pareamento)', async () => {
    await expect(provider.getPairingCode('inst-01', '5511999998888')).rejects.toThrow(UnsupportedProviderOperationException);
  });

  it('setWebhook sem wabaId lança UnsupportedProviderOperationException', async () => {
    const providerSemWaba = makeProvider();
    await expect(providerSemWaba.setWebhook('inst-01', { url: 'https://app.test', enabled: true })).rejects.toThrow(
      UnsupportedProviderOperationException,
    );
  });

  it('setWebhook com wabaId inscreve o app na WABA', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({ data: { success: true } });

    await provider.setWebhook('inst-01', { url: 'https://app.test/webhook', enabled: true });

    expect(http['post']).toHaveBeenCalledWith('/WABA_ID/subscribed_apps', {});
  });

  it('getPhoneNumberInfo (Coexistence) retorna is_on_biz_app e platform_type', async () => {
    const http = getAxios(provider);
    http['get']!.mockResolvedValueOnce({ data: { is_on_biz_app: true, platform_type: 'CLOUD_API' } });

    const info = await provider.getPhoneNumberInfo();

    expect(http['get']).toHaveBeenCalledWith('/PHONE_ID?fields=is_on_biz_app,platform_type');
    expect(info).toEqual({ isOnBizApp: true, platformType: 'CLOUD_API', raw: { is_on_biz_app: true, platform_type: 'CLOUD_API' } });
  });

  it('syncContacts (Coexistence) chama smb_app_data com sync_type=smb_app_state_sync', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({ data: {} });

    await provider.syncContacts();

    expect(http['post']).toHaveBeenCalledWith('/PHONE_ID/smb_app_data', {
      messaging_product: 'whatsapp',
      sync_type: 'smb_app_state_sync',
    });
  });

  it('syncHistory (Coexistence) chama smb_app_data com sync_type=history', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({ data: {} });

    await provider.syncHistory();

    expect(http['post']).toHaveBeenCalledWith('/PHONE_ID/smb_app_data', {
      messaging_product: 'whatsapp',
      sync_type: 'history',
    });
  });

  describe('parseWebhookPayload', () => {
    function payload(body: unknown): Buffer {
      return Buffer.from(JSON.stringify(body));
    }

    it('mensagem recebida vira MessageReceived', () => {
      const events = provider.parseWebhookPayload(
        payload({
          entry: [
            {
              changes: [
                { field: 'messages', value: { messages: [{ from: '5598999990000', id: 'wamid.1', type: 'text' }] } },
              ],
            },
          ],
        }),
        {},
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'MessageReceived',
        instanceId: 'PHONE_ID',
        payload: { from: '5598999990000', messageId: 'wamid.1' },
      });
    });

    it('status read/delivered viram MessageRead/MessageDelivered', () => {
      const events = provider.parseWebhookPayload(
        payload({
          entry: [
            {
              changes: [
                {
                  field: 'messages',
                  value: {
                    statuses: [
                      { id: 'wamid.1', status: 'read' },
                      { id: 'wamid.2', status: 'delivered' },
                    ],
                  },
                },
              ],
            },
          ],
        }),
        {},
      );

      expect(events).toEqual([
        expect.objectContaining({ type: 'MessageRead', payload: { messageId: 'wamid.1' } }),
        expect.objectContaining({ type: 'MessageDelivered', payload: { messageId: 'wamid.2' } }),
      ]);
    });

    it('reconhece os 3 eventos de Coexistence', () => {
      const events = provider.parseWebhookPayload(
        payload({
          entry: [
            {
              changes: [
                { field: 'history', value: { phase: 0 } },
                { field: 'smb_app_state_sync', value: { action: 'add' } },
                { field: 'smb_message_echoes', value: { from: 'x' } },
              ],
            },
          ],
        }),
        {},
      );

      expect(events.map((e) => e.type)).toEqual([
        'CoexistenceHistorySync',
        'CoexistenceContactSync',
        'CoexistenceMessageEcho',
      ]);
    });

    it('sem appSecret configurado, não valida assinatura', () => {
      expect(() => provider.parseWebhookPayload(payload({ entry: [] }), {})).not.toThrow();
    });

    it('com appSecret configurado, rejeita assinatura ausente', () => {
      const secured = makeProvider('WABA_ID', 'shh');
      expect(() => secured.parseWebhookPayload(payload({ entry: [] }), {})).toThrow(/X-Hub-Signature-256/);
    });

    it('com appSecret configurado, rejeita assinatura inválida', () => {
      const secured = makeProvider('WABA_ID', 'shh');
      expect(() =>
        secured.parseWebhookPayload(payload({ entry: [] }), { 'x-hub-signature-256': 'sha256=invalida' }),
      ).toThrow(/inválida/);
    });

    it('com appSecret configurado, aceita assinatura válida', () => {
      const secured = makeProvider('WABA_ID', 'shh');
      const body = payload({ entry: [] });
      const signature = `sha256=${createHmac('sha256', 'shh').update(body).digest('hex')}`;

      expect(() => secured.parseWebhookPayload(body, { 'x-hub-signature-256': signature })).not.toThrow();
    });
  });
});
