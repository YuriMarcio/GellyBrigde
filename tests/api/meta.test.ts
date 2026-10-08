import axios from 'axios';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/api/buildServer.js';
import { InMemoryInstanceRepository } from '../../src/infrastructure/persistence/InMemoryInstanceRepository.js';
import { ConsoleLogger } from '../../src/infrastructure/logging/ConsoleLogger.js';

vi.mock('axios', async () => {
  const actual = await vi.importActual<typeof axios>('axios');
  return {
    default: {
      ...actual.default,
      create: vi.fn(() => ({
        post: vi.fn().mockResolvedValue({ data: { messages: [{ id: 'wamid.1' }] } }),
        get: vi.fn().mockResolvedValue({ data: {} }),
        put: vi.fn().mockResolvedValue({ data: {} }),
        delete: vi.fn().mockResolvedValue({ data: {} }),
      })),
      isAxiosError: actual.default.isAxiosError,
    },
  };
});

type Mocked = Record<'post' | 'get' | 'put' | 'delete', ReturnType<typeof vi.fn>>;

/** O axios que o provider recém-criado usa (um por instância Meta/Z-API). */
function lastAxios(): Mocked {
  const results = vi.mocked(axios.create).mock.results;
  return results[results.length - 1]!.value as Mocked;
}

const TO = '5598999990000';
const CALLBACK = 'https://zapediu.test/api/webhooks/flowbridge/secret';

describe('api/meta', () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
    process.env['EVOLUTION_API_URL'] = 'https://evolution.test';
    process.env['EVOLUTION_API_KEY'] = 'key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['EVOLUTION_API_URL'];
    delete process.env['EVOLUTION_API_KEY'];
    delete process.env['WHATSAPP_CLOUD_APP_SECRET'];
  });

  function makeApp() {
    const logger = new ConsoleLogger();
    for (const level of ['warn', 'error', 'info', 'debug'] as const) vi.spyOn(logger, level).mockImplementation(() => {});
    return buildServer({
      logger,
      instanceRepository: new InMemoryInstanceRepository(),
      apiKey: undefined,
      publicUrl: 'https://flowbridge.test',
    });
  }

  async function createMeta(
    app: ReturnType<typeof makeApp>['app'],
    credentials: Record<string, string> = {},
    extra: Record<string, unknown> = {},
  ) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      payload: {
        provider: 'meta',
        instanceId: 'loja-1',
        credentials: { phoneNumberId: 'PHONE_ID', accessToken: 'tok', wabaId: 'WABA_ID', ...credentials },
        callbackUrl: CALLBACK,
        ...extra,
      },
    });
    // Criar a instância já publica InstanceConnected (connect valida o token) e o evento é
    // encaminhado ao callbackUrl de forma assíncrona — espera isso e zera, para os testes
    // olharem só o que acontece depois.
    if (extra['callbackUrl'] !== null) {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body)).toMatchObject({ type: 'InstanceConnected', instanceId: 'loja-1' });
      fetchMock.mockClear();
    }
    return { response, body: response.json(), http: lastAxios() };
  }

  async function createZapi(app: ReturnType<typeof makeApp>['app']): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      payload: { provider: 'zapi', credentials: { instanceId: 'z-1', token: 't' } },
    });
    return response.json().instance.id;
  }

  describe('criação da instância', () => {
    it('gera o verifyToken, devolve a URL de callback e grava o override no número', async () => {
      const { app } = makeApp();
      const { response, body, http } = await createMeta(app);

      expect(response.statusCode).toBe(201);
      expect(body.webhook.callbackUrl).toBe('https://flowbridge.test/v1/webhooks/meta/loja-1');
      expect(body.webhook.verifyToken).toMatch(/^[0-9a-f]{48}$/);

      expect(http.post).toHaveBeenCalledWith('/WABA_ID/subscribed_apps', {});
      expect(http.post).toHaveBeenCalledWith('/PHONE_ID', {
        webhook_configuration: {
          override_callback_uri: 'https://flowbridge.test/v1/webhooks/meta/loja-1',
          verify_token: body.webhook.verifyToken,
        },
      });
    });

    it('respeita um verifyToken informado pelo chamador', async () => {
      const { app } = makeApp();
      const { body } = await createMeta(app, { verifyToken: 'meu-token' });
      expect(body.webhook.verifyToken).toBe('meu-token');
    });

    it('instância Z-API não ganha bloco webhook', async () => {
      const { app } = makeApp();
      const response = await app.inject({
        method: 'POST',
        url: '/v1/instances',
        payload: { provider: 'zapi', credentials: { instanceId: 'z-1', token: 't' } },
      });
      expect(response.json().webhook).toBeUndefined();
    });
  });

  describe('GET /v1/webhooks/meta/:id (handshake hub.challenge)', () => {
    const query = (token: string) => `hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=12345`;

    it('ecoa o challenge em texto puro quando o token confere', async () => {
      const { app } = makeApp();
      const { body } = await createMeta(app);

      const response = await app.inject({ method: 'GET', url: `/v1/webhooks/meta/loja-1?${query(body.webhook.verifyToken)}` });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.body).toBe('12345');
    });

    it('recusa com 403 quando o token não confere', async () => {
      const { app } = makeApp();
      await createMeta(app);

      const response = await app.inject({ method: 'GET', url: `/v1/webhooks/meta/loja-1?${query('errado')}` });

      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain('12345');
    });

    it('é público: funciona mesmo com x-api-key configurada', async () => {
      const logger = new ConsoleLogger();
      for (const level of ['warn', 'error', 'info', 'debug'] as const) vi.spyOn(logger, level).mockImplementation(() => {});
      const { app } = buildServer({ logger, instanceRepository: new InMemoryInstanceRepository(), apiKey: 'secret' });
      const created = await app.inject({
        method: 'POST',
        url: '/v1/instances',
        headers: { 'x-api-key': 'secret' },
        payload: { provider: 'meta', instanceId: 'loja-1', credentials: { phoneNumberId: 'P', accessToken: 't', verifyToken: 'abc' } },
      });
      expect(created.statusCode).toBe(201);

      const response = await app.inject({ method: 'GET', url: `/v1/webhooks/meta/loja-1?${query('abc')}` });
      expect(response.statusCode).toBe(200);
    });

    it('404 para instância inexistente, para provider que não bate e para provider sem handshake', async () => {
      const { app } = makeApp();
      await createMeta(app);
      const zapiId = await createZapi(app);

      expect((await app.inject({ method: 'GET', url: `/v1/webhooks/meta/nao-existe?${query('x')}` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/v1/webhooks/zapi/loja-1?${query('x')}` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/v1/webhooks/zapi/${zapiId}?${query('x')}` })).statusCode).toBe(404);
    });
  });

  describe('POST /v1/webhooks/:provider/:id', () => {
    const textMessage = (phoneNumberId = 'PHONE_ID') =>
      JSON.stringify({
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: phoneNumberId },
                  contacts: [{ wa_id: TO, profile: { name: 'Maria' } }],
                  messages: [{ from: TO, id: 'wamid.in', timestamp: '1700000000', type: 'text', text: { body: 'oi' } }],
                },
              },
            ],
          },
        ],
      });

    const post = (app: ReturnType<typeof makeApp>['app'], url: string, payload: string) =>
      app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload });

    it('REGRESSÃO: o evento chega ao callbackUrl com o instanceId lógico (antes era o phoneNumberId)', async () => {
      const { app } = makeApp();
      await createMeta(app);

      const response = await post(app, '/v1/webhooks/meta/loja-1', textMessage());
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ received: 1 });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(CALLBACK);

      const forwarded = JSON.parse((init as { body: string }).body);
      expect(forwarded).toMatchObject({
        type: 'MessageReceived',
        provider: 'meta',
        instanceId: 'loja-1',
        payload: { from: TO, normalized: { type: 'text', text: 'oi', profileName: 'Maria' } },
      });
    });

    it('clique no carrossel (type "button") chega ao callbackUrl com o id do botão e o id do carrossel respondido', async () => {
      const { app } = makeApp();
      await createMeta(app);

      const click = JSON.stringify({
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: 'PHONE_ID' },
                  contacts: [{ wa_id: TO, profile: { name: 'Maria' } }],
                  messages: [
                    {
                      from: TO,
                      id: 'wamid.click',
                      timestamp: '1700000000',
                      context: { from: '5598988887777', id: 'wamid.carrossel' },
                      type: 'button',
                      button: { payload: 'flow_add1_loja_12', text: 'Adicionar' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      const response = await post(app, '/v1/webhooks/meta/loja-1', click);
      expect(response.statusCode).toBe(200);

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const forwarded = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
      expect(forwarded).toMatchObject({
        type: 'MessageReceived',
        instanceId: 'loja-1',
        payload: { from: TO, normalized: { type: 'button', buttonReplyId: 'flow_add1_loja_12', replyToMessageId: 'wamid.carrossel' } },
      });
    });

    it('webhook de outro número no mesmo callback não é atribuído a esta instância', async () => {
      const { app } = makeApp();
      await createMeta(app);

      const response = await post(app, '/v1/webhooks/meta/loja-1', textMessage('OUTRO_NUMERO'));

      expect(response.json()).toEqual({ received: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('URL com provider diferente do da instância é 404 (não passa pelo parser errado)', async () => {
      const { app } = makeApp();
      await createMeta(app);

      const response = await post(app, '/v1/webhooks/zapi/loja-1', textMessage());

      expect(response.statusCode).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('App Secret global do ambiente passa a valer para instâncias sem appSecret próprio', async () => {
      process.env['WHATSAPP_CLOUD_APP_SECRET'] = 'segredo-do-app';
      const { app } = makeApp();
      await createMeta(app);
      const raw = textMessage();

      const semAssinatura = await post(app, '/v1/webhooks/meta/loja-1', raw);
      expect(semAssinatura.statusCode).toBe(401);

      const assinatura = `sha256=${createHmac('sha256', 'segredo-do-app').update(raw).digest('hex')}`;
      const comAssinatura = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/meta/loja-1',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinatura },
        payload: raw,
      });
      expect(comAssinatura.statusCode).toBe(200);
    });
  });

  describe('envio', () => {
    it('janela de 24h fechada vira 422 com code estável (não 502)', async () => {
      const { app } = makeApp();
      const { http } = await createMeta(app);
      http.post.mockRejectedValueOnce(
        Object.assign(new Error('Request failed'), {
          isAxiosError: true,
          response: { status: 400, data: { error: { code: 131047, message: 'Re-engagement message' } } },
        }),
      );

      const response = await app.inject({ method: 'POST', url: '/v1/instances/loja-1/messages/text', payload: { to: TO, text: 'oi' } });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: 'CUSTOMER_SERVICE_WINDOW_CLOSED', provider: 'meta', to: TO });
    });

    it('POST messages/template envia o template (Meta)', async () => {
      const { app } = makeApp();
      const { http } = await createMeta(app);
      http.post.mockClear();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/instances/loja-1/messages/template',
        payload: { to: TO, template: { name: 'pedido_confirmado', languageCode: 'pt_BR', bodyParameters: ['Maria'] } },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ messageId: 'wamid.1' });
      expect(http.post.mock.calls[0]![1]).toMatchObject({
        type: 'template',
        template: { name: 'pedido_confirmado', components: [{ type: 'body', parameters: [{ type: 'text', text: 'Maria' }] }] },
      });
    });

    it('POST messages/read marca como lida com "digitando..."', async () => {
      const { app } = makeApp();
      const { http } = await createMeta(app);
      http.post.mockClear();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/instances/loja-1/messages/read',
        payload: { messageId: 'wamid.in', typingIndicator: true },
      });

      expect(response.statusCode).toBe(200);
      expect(http.post.mock.calls[0]![1]).toEqual({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: 'wamid.in',
        typing_indicator: { type: 'text' },
      });
    });

    it('template e read em instância Z-API são 501 com explicação', async () => {
      const { app } = makeApp();
      const id = await createZapi(app);

      const template = await app.inject({ method: 'POST', url: `/v1/instances/${id}/messages/template`, payload: { to: TO, template: {} } });
      const read = await app.inject({ method: 'POST', url: `/v1/instances/${id}/messages/read`, payload: { messageId: 'x' } });

      expect(template.statusCode).toBe(501);
      expect(template.json()).toMatchObject({ operation: 'sendTemplate' });
      expect(read.statusCode).toBe(501);
      expect(read.json()).toMatchObject({ operation: 'markAsRead' });
    });

    it('GET media/:mediaId baixa a mídia recebida na Meta', async () => {
      const { app } = makeApp();
      const { http } = await createMeta(app);
      http.get
        .mockResolvedValueOnce({ data: { url: 'https://lookaside.test/m/1', mime_type: 'audio/ogg' } })
        .mockResolvedValueOnce({ data: Uint8Array.from([7, 7]).buffer, headers: { 'content-type': 'audio/ogg' } });

      const response = await app.inject({ method: 'GET', url: '/v1/instances/loja-1/media/MEDIA_1' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ base64: Buffer.from([7, 7]).toString('base64'), mimetype: 'audio/ogg' });
    });
  });

  describe('capacidades, templates e Coexistence', () => {
    it('GET capabilities devolve a matriz do provider da instância, com os limites da Meta', async () => {
      const { app } = makeApp();
      await createMeta(app);
      const zapiId = await createZapi(app);

      const meta = (await app.inject({ method: 'GET', url: '/v1/instances/loja-1/capabilities' })).json();
      const zapi = (await app.inject({ method: 'GET', url: `/v1/instances/${zapiId}/capabilities` })).json();

      expect(meta).toMatchObject({
        provider: 'meta',
        customerServiceWindow24h: true,
        groups: false,
        messaging: { carousel: 'interactive', template: true },
        limits: { maxButtons: 3, buttonTitleMax: 20, listRowsMax: 10, carouselCardsMin: 2, carouselCardsMax: 10, carouselCardBodyMax: 160, carouselCardBodyLineBreaksMax: 2, carouselUniformButtons: true },
      });
      expect(zapi).toMatchObject({ provider: 'zapi', customerServiceWindow24h: false, messaging: { carousel: 'freeform' } });
    });

    it('GET templates lista pela WABA; POST cria; DELETE apaga', async () => {
      const { app } = makeApp();
      const { http } = await createMeta(app);
      http.get.mockResolvedValueOnce({
        data: { data: [{ id: '1', name: 'lojas', language: 'pt_BR', status: 'APPROVED' }] },
      });

      const list = await app.inject({ method: 'GET', url: '/v1/instances/loja-1/templates?status=APPROVED' });
      expect(list.statusCode).toBe(200);
      expect(list.json().data[0]).toMatchObject({ name: 'lojas', status: 'APPROVED' });

      const definition = { name: 'ola', language: 'pt_BR', category: 'UTILITY', components: [{ type: 'BODY', text: 'Olá' }] };
      const create = await app.inject({ method: 'POST', url: '/v1/instances/loja-1/templates', payload: definition });
      expect(create.statusCode).toBe(201);
      expect(http.post).toHaveBeenCalledWith('/WABA_ID/message_templates', definition);

      const remove = await app.inject({ method: 'DELETE', url: '/v1/instances/loja-1/templates/ola' });
      expect(remove.statusCode).toBe(204);
      expect(http.delete).toHaveBeenCalledWith('/WABA_ID/message_templates?name=ola');
    });

    it('templates e coexistence em instância Z-API são 501', async () => {
      const { app } = makeApp();
      const id = await createZapi(app);

      expect((await app.inject({ method: 'GET', url: `/v1/instances/${id}/templates` })).statusCode).toBe(501);
      expect((await app.inject({ method: 'GET', url: `/v1/instances/${id}/coexistence` })).statusCode).toBe(501);
    });

    it('GET coexistence mostra se o número está no app WhatsApp Business', async () => {
      const { app } = makeApp();
      const { http } = await createMeta(app);
      http.get.mockResolvedValueOnce({ data: { is_on_biz_app: true, platform_type: 'CLOUD_API' } });

      const response = await app.inject({ method: 'GET', url: '/v1/instances/loja-1/coexistence' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ isOnBizApp: true, platformType: 'CLOUD_API' });
    });

    it('POST coexistence/sync dispara a sincronização e valida o tipo', async () => {
      const { app } = makeApp();
      const { http } = await createMeta(app);
      http.post.mockClear();

      const contacts = await app.inject({ method: 'POST', url: '/v1/instances/loja-1/coexistence/sync', payload: { type: 'contacts' } });
      const history = await app.inject({ method: 'POST', url: '/v1/instances/loja-1/coexistence/sync', payload: { type: 'history' } });
      const invalid = await app.inject({ method: 'POST', url: '/v1/instances/loja-1/coexistence/sync', payload: { type: 'tudo' } });

      expect(contacts.statusCode).toBe(202);
      expect(history.statusCode).toBe(202);
      expect(invalid.statusCode).toBe(400);
      expect(http.post.mock.calls).toEqual([
        ['/PHONE_ID/smb_app_data', { messaging_product: 'whatsapp', sync_type: 'smb_app_state_sync' }],
        ['/PHONE_ID/smb_app_data', { messaging_product: 'whatsapp', sync_type: 'history' }],
      ]);
    });
  });
});
