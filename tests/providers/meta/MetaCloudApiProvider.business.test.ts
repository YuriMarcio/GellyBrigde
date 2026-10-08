import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaCloudApiProvider } from '../../../src/providers/meta/MetaCloudApiProvider.js';
import { ConsoleLogger } from '../../../src/infrastructure/logging/ConsoleLogger.js';
import { CustomerServiceWindowClosedException } from '../../../src/core/exceptions/CustomerServiceWindowClosedException.js';
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

interface Options {
  wabaId?: string;
  verifyToken?: string;
  instanceId?: string;
  appSecret?: string;
}

function makeProvider({ wabaId, verifyToken, instanceId, appSecret }: Options = {}) {
  const logger = new ConsoleLogger();
  vi.spyOn(logger, 'error').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'debug').mockImplementation(() => {});
  return new MetaCloudApiProvider(
    { name: 'meta', phoneNumberId: 'PHONE_ID', accessToken: 'token', wabaId, verifyToken, instanceId, appSecret },
    logger,
  );
}

function http(provider: MetaCloudApiProvider) {
  return (provider as unknown as { http: { options: { axiosInstance: Record<string, ReturnType<typeof vi.fn>> } } }).http
    .options.axiosInstance as Record<'post' | 'get' | 'delete', ReturnType<typeof vi.fn>>;
}

const TO = '5598999990000';
const OK = { data: { messages: [{ id: 'wamid.1' }] } };

function webhook(...changes: Array<{ field: string; value: Record<string, unknown> }>): Buffer {
  return Buffer.from(JSON.stringify({ entry: [{ changes }] }));
}

const metadata = { phone_number_id: 'PHONE_ID', display_phone_number: '5598999990000' };

function inbound(message: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return webhook({
    field: 'messages',
    value: {
      metadata,
      contacts: [{ wa_id: TO, profile: { name: 'Maria' } }],
      messages: [{ from: TO, id: 'wamid.in', timestamp: '1700000000', ...message }],
      ...extra,
    },
  });
}

describe('MetaCloudApiProvider — envio', () => {
  let provider: MetaCloudApiProvider;
  beforeEach(() => {
    provider = makeProvider({ wabaId: 'WABA_ID' });
    http(provider).post.mockResolvedValue(OK);
  });

  it('sendText sem opções mantém o payload mínimo (sem context nem preview_url)', async () => {
    await provider.sendText('i', TO, 'oi');
    expect(http(provider).post.mock.calls[0]![1]).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: TO,
      type: 'text',
      text: { body: 'oi' },
    });
  });

  it('sendText com replyToMessageId e previewUrl envia context e preview_url', async () => {
    await provider.sendText('i', TO, 'veja https://zapediu.test', { replyToMessageId: 'wamid.x', previewUrl: true });
    expect(http(provider).post.mock.calls[0]![1]).toMatchObject({
      context: { message_id: 'wamid.x' },
      text: { body: 'veja https://zapediu.test', preview_url: true },
    });
  });

  it('sendButtons: um botão url vira interactive cta_url', async () => {
    await provider.sendButtons('i', TO, {
      title: 'Loja',
      body: 'Veja o cardápio',
      footer: 'Zapediu',
      buttons: [{ type: 'url', displayText: 'Abrir', url: 'https://zapediu.test/loja' }],
    });
    expect(http(provider).post.mock.calls[0]![1]).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        header: { type: 'text', text: 'Loja' },
        body: { text: 'Veja o cardápio' },
        footer: { text: 'Zapediu' },
        action: { name: 'cta_url', parameters: { display_text: 'Abrir', url: 'https://zapediu.test/loja' } },
      },
    });
  });

  it('sendButtons: cta_url respeita o limite de 20 caracteres do texto do botão', async () => {
    await expect(
      provider.sendButtons('i', TO, {
        body: 'x',
        buttons: [{ type: 'url', displayText: 'Abrir o cardápio completo agora', url: 'https://zapediu.test' }],
      }),
    ).rejects.toThrow(/conteúdo inválido/);
  });

  it('sendButtons: botões url/call/copy misturados com reply são recusados com mensagem clara', async () => {
    await expect(
      provider.sendButtons('i', TO, {
        body: 'x',
        buttons: [
          { type: 'reply', id: 'a', displayText: 'A' },
          { type: 'call', displayText: 'Ligar', phoneNumber: '5598999990000' },
        ],
      }),
    ).rejects.toThrow(/não cabe em sendButtons/);
  });

  it('sendButtons: reply tipado sem id usa o texto como id', async () => {
    await provider.sendButtons('i', TO, { body: 'x', buttons: [{ type: 'reply', displayText: 'Sim' }] });
    expect(http(provider).post.mock.calls[0]![1].interactive.action.buttons[0]).toEqual({
      type: 'reply',
      reply: { id: 'Sim', title: 'Sim' },
    });
  });

  it('sendMessage converte o erro 131047 em CustomerServiceWindowClosedException', async () => {
    http(provider).post.mockRejectedValueOnce(
      Object.assign(new Error('Request failed'), {
        isAxiosError: true,
        response: { status: 400, data: { error: { code: 131047, message: 'Re-engagement message' } } },
      }),
    );

    const promise = provider.sendText('i', TO, 'oi');
    await expect(promise).rejects.toBeInstanceOf(CustomerServiceWindowClosedException);
    await expect(promise).rejects.toMatchObject({ to: TO, providerErrorCode: 131047 });
  });

  it('outros erros da Graph API continuam como ProviderApiException', async () => {
    http(provider).post.mockRejectedValueOnce(
      Object.assign(new Error('Request failed'), {
        isAxiosError: true,
        response: { status: 400, data: { error: { code: 100, message: 'Invalid parameter' } } },
      }),
    );
    await expect(provider.sendText('i', TO, 'oi')).rejects.toMatchObject({ name: 'ProviderApiException', statusCode: 400 });
  });
});

describe('MetaCloudApiProvider — templates', () => {
  let provider: MetaCloudApiProvider;
  beforeEach(() => {
    provider = makeProvider({ wabaId: 'WABA_ID' });
    http(provider).post.mockResolvedValue(OK);
  });

  it('sendTemplate monta header de imagem, corpo e botões na ordem', async () => {
    await provider.sendTemplate('i', TO, {
      name: 'pedido_confirmado',
      languageCode: 'pt_BR',
      header: { type: 'image', url: 'https://zapediu.test/a.jpg' },
      bodyParameters: ['Maria', '#123'],
      buttons: [
        { type: 'quick_reply', payload: 'ver_pedido' },
        { type: 'url', urlSuffix: 'pedido/123' },
      ],
    });

    expect(http(provider).post.mock.calls[0]![1]).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: TO,
      type: 'template',
      template: {
        name: 'pedido_confirmado',
        language: { code: 'pt_BR' },
        components: [
          { type: 'header', parameters: [{ type: 'image', image: { link: 'https://zapediu.test/a.jpg' } }] },
          { type: 'body', parameters: [{ type: 'text', text: 'Maria' }, { type: 'text', text: '#123' }] },
          { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'ver_pedido' }] },
          { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'pedido/123' }] },
        ],
      },
    });
  });

  it('sendTemplate sem parâmetros não manda components', async () => {
    await provider.sendTemplate('i', TO, { name: 'ola', languageCode: 'pt_BR' });
    expect(http(provider).post.mock.calls[0]![1].template).toEqual({ name: 'ola', language: { code: 'pt_BR' } });
  });

  it('sendTemplate com components crus usa exatamente o que foi passado', async () => {
    const components = [{ type: 'carousel', cards: [] }];
    await provider.sendTemplate('i', TO, { name: 'lojas', languageCode: 'pt_BR', bodyParameters: ['ignorado'], components });
    expect(http(provider).post.mock.calls[0]![1].template.components).toBe(components);
  });

  it('sendTemplate valida o nome (minúsculas, números e _)', async () => {
    await expect(provider.sendTemplate('i', TO, { name: 'Pedido Confirmado', languageCode: 'pt_BR' })).rejects.toThrow(
      /name do template/,
    );
  });

  it('sendTemplate com header de mídia sem url nem mediaId falha antes de chamar a API', async () => {
    await expect(
      provider.sendTemplate('i', TO, { name: 'x', languageCode: 'pt_BR', header: { type: 'image' } }),
    ).rejects.toThrow(/precisa de "url" ou "mediaId"/);
    expect(http(provider).post).not.toHaveBeenCalled();
  });

  it('listTemplates consulta a WABA, mapeia os campos e devolve o cursor da próxima página', async () => {
    http(provider).get.mockResolvedValueOnce({
      data: {
        data: [{ id: '1', name: 'lojas', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING', components: [] }],
        paging: { cursors: { after: 'CURSOR' }, next: 'https://graph.facebook.com/next' },
      },
    });

    const result = await provider.listTemplates('i', { status: 'APPROVED', limit: 10 });

    const url = http(provider).get.mock.calls[0]![0] as string;
    expect(url).toContain('/WABA_ID/message_templates?');
    expect(url).toContain('status=APPROVED');
    expect(url).toContain('limit=10');
    expect(result).toEqual({
      data: [{ id: '1', name: 'lojas', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING', rejectedReason: undefined, components: [] }],
      next: 'CURSOR',
    });
  });

  it('createTemplate e deleteTemplate usam /WABA/message_templates', async () => {
    http(provider).delete.mockResolvedValue({ data: { success: true } });
    const definition = { name: 'ola', language: 'pt_BR', category: 'UTILITY' as const, components: [{ type: 'BODY', text: 'Olá' }] };

    await provider.createTemplate('i', definition);
    await provider.deleteTemplate('i', 'ola mundo');

    expect(http(provider).post).toHaveBeenCalledWith('/WABA_ID/message_templates', definition);
    expect(http(provider).delete).toHaveBeenCalledWith('/WABA_ID/message_templates?name=ola%20mundo');
  });

  it('gerenciar templates sem wabaId lança Unsupported com o motivo', async () => {
    const semWaba = makeProvider();
    await expect(semWaba.listTemplates('i')).rejects.toBeInstanceOf(UnsupportedProviderOperationException);
    await expect(semWaba.listTemplates('i')).rejects.toThrow(/wabaId/);
  });
});

describe('MetaCloudApiProvider — leitura, mídia e status', () => {
  let provider: MetaCloudApiProvider;
  beforeEach(() => {
    provider = makeProvider({ wabaId: 'WABA_ID' });
  });

  it('markAsRead envia status read; com typingIndicator inclui typing_indicator', async () => {
    http(provider).post.mockResolvedValue({ data: { success: true } });

    await provider.markAsRead('i', 'wamid.in');
    await provider.markAsRead('i', 'wamid.in', { typingIndicator: true });

    expect(http(provider).post.mock.calls[0]).toEqual([
      '/PHONE_ID/messages',
      { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.in' },
    ]);
    expect(http(provider).post.mock.calls[1]![1]).toMatchObject({ typing_indicator: { type: 'text' } });
  });

  it('getMediaBase64 busca a URL pelo media_id e baixa os bytes com o mesmo token', async () => {
    http(provider).get
      .mockResolvedValueOnce({ data: { url: 'https://lookaside.test/m/1', mime_type: 'audio/ogg' } })
      .mockResolvedValueOnce({ data: Uint8Array.from([1, 2, 3, 4]).buffer, headers: { 'content-type': 'audio/ogg' } });

    const media = await provider.getMediaBase64('i', 'MEDIA_1');

    expect(http(provider).get.mock.calls[0]![0]).toBe('/MEDIA_1?phone_number_id=PHONE_ID');
    expect(http(provider).get.mock.calls[1]).toEqual(['https://lookaside.test/m/1', { responseType: 'arraybuffer' }]);
    expect(media).toMatchObject({ base64: Buffer.from([1, 2, 3, 4]).toString('base64'), mimetype: 'audio/ogg' });
  });

  it('getMediaBase64 falha com clareza se a Meta não devolver URL', async () => {
    http(provider).get.mockResolvedValueOnce({ data: {} });
    await expect(provider.getMediaBase64('i', 'MEDIA_1')).rejects.toThrow(/URL ausente/);
  });

  it.each([
    ['CONNECTED', 'open'],
    ['FLAGGED', 'open'],
    ['PENDING', 'connecting'],
    ['DISCONNECTED', 'close'],
    ['BANNED', 'close'],
  ])('getStatus: status %s da Graph API vira state %s', async (graphStatus, state) => {
    http(provider).get.mockResolvedValueOnce({ data: { status: graphStatus, quality_rating: 'GREEN' } });
    expect(await provider.getStatus('i')).toMatchObject({ instanceId: 'i', state });
  });

  it('getStatus sem o campo status mantém open', async () => {
    http(provider).get.mockResolvedValueOnce({ data: {} });
    expect((await provider.getStatus('i')).state).toBe('open');
  });
});

describe('MetaCloudApiProvider — webhook (configuração e handshake)', () => {
  it('setWebhook com verifyToken inscreve o app e grava o override de callback do número', async () => {
    const provider = makeProvider({ wabaId: 'WABA_ID', verifyToken: 'tok-123' });
    http(provider).post.mockResolvedValue({ data: { success: true } });

    await provider.setWebhook('i', { url: 'https://flowbridge.test/v1/webhooks/meta/i', enabled: true });

    expect(http(provider).post.mock.calls).toEqual([
      ['/WABA_ID/subscribed_apps', {}],
      [
        '/PHONE_ID',
        { webhook_configuration: { override_callback_uri: 'https://flowbridge.test/v1/webhooks/meta/i', verify_token: 'tok-123' } },
      ],
    ]);
  });

  it('setWebhook sem verifyToken só inscreve o app (callback continua manual)', async () => {
    const provider = makeProvider({ wabaId: 'WABA_ID' });
    http(provider).post.mockResolvedValue({ data: {} });

    await provider.setWebhook('i', { url: 'https://x.test', enabled: true });

    expect(http(provider).post.mock.calls).toEqual([['/WABA_ID/subscribed_apps', {}]]);
  });

  it('verifyWebhookSubscription devolve o challenge só com modo e token corretos', () => {
    const provider = makeProvider({ verifyToken: 'tok-123' });
    const query = { 'hub.mode': 'subscribe', 'hub.verify_token': 'tok-123', 'hub.challenge': '98765' };

    expect(provider.verifyWebhookSubscription(query)).toBe('98765');
    expect(provider.verifyWebhookSubscription({ ...query, 'hub.verify_token': 'errado' })).toBeNull();
    expect(provider.verifyWebhookSubscription({ ...query, 'hub.mode': 'unsubscribe' })).toBeNull();
    expect(provider.verifyWebhookSubscription({ 'hub.mode': 'subscribe', 'hub.challenge': '1' })).toBeNull();
  });

  it('verifyWebhookSubscription recusa tudo quando a instância não tem verifyToken', () => {
    const provider = makeProvider();
    expect(
      provider.verifyWebhookSubscription({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' }),
    ).toBeNull();
  });
});

describe('MetaCloudApiProvider — webhook (eventos)', () => {
  const provider = makeProvider({ instanceId: 'loja-1' });
  const parse = (body: Buffer) => provider.parseWebhookPayload(body, {});

  it('os eventos levam o instanceId lógico, não o phoneNumberId (encaminhamento ao callbackUrl)', () => {
    const [event] = parse(inbound({ type: 'text', text: { body: 'oi' } }));
    expect(event).toMatchObject({ type: 'MessageReceived', instanceId: 'loja-1' });
  });

  it('sem instanceId configurado (modo SDK) cai no phoneNumberId', () => {
    const sdk = makeProvider();
    const [event] = sdk.parseWebhookPayload(inbound({ type: 'text', text: { body: 'oi' } }), {});
    expect(event!.instanceId).toBe('PHONE_ID');
  });

  it('texto: normalized traz type, text, nome do contato e horário; content segue cru', () => {
    const [event] = parse(inbound({ type: 'text', text: { body: 'Quero uma pizza' } }));
    expect(event!.payload).toMatchObject({
      from: TO,
      messageId: 'wamid.in',
      content: { type: 'text', text: { body: 'Quero uma pizza' } },
      normalized: { type: 'text', text: 'Quero uma pizza', profileName: 'Maria', timestamp: 1700000000 },
    });
  });

  it('resposta de botão: normalized.buttonReplyId é o mesmo id enviado em sendButtons', () => {
    const [event] = parse(
      inbound({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'confirm', title: 'Confirmar' } } }),
    );
    expect((event!.payload as { normalized: unknown }).normalized).toMatchObject({
      type: 'interactive',
      buttonReplyId: 'confirm',
      buttonReplyTitle: 'Confirmar',
    });
  });

  it('resposta de lista: normalized.listReplyId é o rowId enviado em sendList', () => {
    const [event] = parse(
      inbound({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'store_3', title: 'Loja 3' } } }),
    );
    expect((event!.payload as { normalized: unknown }).normalized).toMatchObject({ listReplyId: 'store_3', listReplyTitle: 'Loja 3' });
  });

  it('clique em botão de template (type "button") vira buttonReplyId a partir do payload', () => {
    const [event] = parse(inbound({ type: 'button', button: { payload: 'store_2', text: 'Ver cardápio' } }));
    expect((event!.payload as { normalized: unknown }).normalized).toMatchObject({ buttonReplyId: 'store_2', buttonReplyTitle: 'Ver cardápio' });
  });

  it('mídia: mediaId, mimeType e legenda; nota de voz marcada', () => {
    const [image] = parse(inbound({ type: 'image', image: { id: 'MEDIA_1', mime_type: 'image/jpeg', caption: 'olha' } }));
    expect((image!.payload as { normalized: unknown }).normalized).toMatchObject({
      type: 'image',
      mediaId: 'MEDIA_1',
      mimeType: 'image/jpeg',
      caption: 'olha',
    });

    const [voice] = parse(inbound({ type: 'audio', audio: { id: 'MEDIA_2', mime_type: 'audio/ogg; codecs=opus', voice: true } }));
    expect((voice!.payload as { normalized: unknown }).normalized).toMatchObject({ mediaId: 'MEDIA_2', isVoiceNote: true });

    const [forwarded] = parse(inbound({ type: 'audio', audio: { id: 'MEDIA_3', mime_type: 'audio/mpeg', voice: false } }));
    expect((forwarded!.payload as { normalized: unknown }).normalized).toMatchObject({ isVoiceNote: false });
  });

  it('localização, reação e reply nativo', () => {
    const [location] = parse(
      inbound({ type: 'location', location: { latitude: -2.5, longitude: -44.3, name: 'Casa', address: 'Rua A' } }),
    );
    expect((location!.payload as { normalized: unknown }).normalized).toMatchObject({
      location: { latitude: -2.5, longitude: -44.3, name: 'Casa', address: 'Rua A' },
    });

    const [reaction] = parse(inbound({ type: 'reaction', reaction: { message_id: 'wamid.out', emoji: '👍' } }));
    expect((reaction!.payload as { normalized: unknown }).normalized).toMatchObject({ reaction: { messageId: 'wamid.out', emoji: '👍' } });

    const [reply] = parse(inbound({ type: 'text', text: { body: 'sim' }, context: { id: 'wamid.out' } }));
    expect((reply!.payload as { normalized: unknown }).normalized).toMatchObject({ replyToMessageId: 'wamid.out' });
  });

  it('tipo desconhecido não quebra: normalized só com type', () => {
    const [event] = parse(inbound({ type: 'order', order: { catalog_id: 'c1' } }));
    expect((event!.payload as { normalized: unknown }).normalized).toMatchObject({ type: 'order' });
  });

  const statusBody = (status: Record<string, unknown>) =>
    webhook({ field: 'messages', value: { metadata, statuses: [{ id: 'wamid.out', recipient_id: TO, timestamp: '1700000001', ...status }] } });

  it('status sent vira MessageSent com a conversa (janela de 24h) e o preço', () => {
    const [event] = parse(
      statusBody({
        status: 'sent',
        conversation: { id: 'conv1', expiration_timestamp: '1700086400', origin: { type: 'service' } },
        pricing: { billable: true, pricing_model: 'CBP', category: 'service' },
      }),
    );
    expect(event).toMatchObject({
      type: 'MessageSent',
      payload: {
        to: TO,
        messageId: 'wamid.out',
        conversation: { id: 'conv1', expirationTimestamp: 1700086400, originType: 'service' },
        pricing: { billable: true, pricingModel: 'CBP', category: 'service' },
      },
    });
  });

  it('delivered e read continuam existindo, agora com o destinatário', () => {
    expect(parse(statusBody({ status: 'delivered' }))[0]).toMatchObject({ type: 'MessageDelivered', payload: { messageId: 'wamid.out', to: TO } });
    expect(parse(statusBody({ status: 'read' }))[0]).toMatchObject({ type: 'MessageRead', payload: { messageId: 'wamid.out', to: TO } });
  });

  it('failed vira MessageFailed e marca a janela de 24h fechada (131047)', () => {
    const [event] = parse(
      statusBody({
        status: 'failed',
        errors: [{ code: 131047, title: 'Re-engagement message', message: 'Re-engagement message', error_data: { details: 'Message failed to send because more than 24 hours have passed' } }],
      }),
    );
    expect(event).toMatchObject({
      type: 'MessageFailed',
      payload: {
        messageId: 'wamid.out',
        to: TO,
        customerServiceWindowClosed: true,
        errors: [{ code: 131047, title: 'Re-engagement message', details: expect.stringContaining('24 hours') }],
      },
    });
  });

  it('failed por outro motivo não marca janela fechada', () => {
    const [event] = parse(statusBody({ status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] }));
    expect(event!.payload).toMatchObject({ customerServiceWindowClosed: false });
  });

  it('status de template, qualidade do número e atualização de conta viram eventos tipados', () => {
    const events = parse(
      webhook(
        {
          field: 'message_template_status_update',
          value: { event: 'REJECTED', message_template_id: 42, message_template_name: 'lojas', message_template_language: 'pt_BR', reason: 'INVALID_FORMAT' },
        },
        { field: 'phone_number_quality_update', value: { display_phone_number: '5598999990000', event: 'DOWNGRADE', current_limit: 'TIER_1K' } },
        { field: 'account_update', value: { event: 'ACCOUNT_VIOLATION' } },
      ),
    );

    expect(events.map((event) => event.type)).toEqual(['TemplateStatusUpdated', 'PhoneNumberQualityUpdated', 'AccountUpdated']);
    expect(events[0]!.payload).toEqual({
      templateId: '42',
      templateName: 'lojas',
      language: 'pt_BR',
      status: 'REJECTED',
      reason: 'INVALID_FORMAT',
    });
    expect(events[1]!.payload).toEqual({ displayPhoneNumber: '5598999990000', event: 'DOWNGRADE', currentLimit: 'TIER_1K' });
  });

  it('webhook de OUTRO número (callback compartilhado do app) é ignorado', () => {
    const events = parse(
      webhook({
        field: 'messages',
        value: {
          metadata: { phone_number_id: 'OUTRO_NUMERO' },
          messages: [{ from: TO, id: 'wamid.x', type: 'text', text: { body: 'oi' } }],
        },
      }),
    );
    expect(events).toEqual([]);
  });

  it('eventos de Coexistence continuam mapeados', () => {
    const events = parse(
      webhook(
        { field: 'history', value: { metadata } },
        { field: 'smb_app_state_sync', value: { metadata } },
        { field: 'smb_message_echoes', value: { metadata } },
      ),
    );
    expect(events.map((event) => event.type)).toEqual(['CoexistenceHistorySync', 'CoexistenceContactSync', 'CoexistenceMessageEcho']);
  });
});
