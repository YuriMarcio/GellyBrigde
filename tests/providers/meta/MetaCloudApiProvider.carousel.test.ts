import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaCloudApiProvider } from '../../../src/providers/meta/MetaCloudApiProvider.js';
import { ConsoleLogger } from '../../../src/infrastructure/logging/ConsoleLogger.js';
import type { CarouselCard, CarouselContent } from '../../../src/core/interfaces/CommunicationProvider.js';

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

const TO = '5598999990000';

function makeProvider() {
  const logger = new ConsoleLogger();
  for (const level of ['error', 'warn', 'debug', 'info'] as const) vi.spyOn(logger, level).mockImplementation(() => {});
  const provider = new MetaCloudApiProvider({ name: 'meta', phoneNumberId: 'PHONE_ID', accessToken: 't', instanceId: 'loja-1' }, logger);
  const http = (provider as unknown as { http: { options: { axiosInstance: Record<string, ReturnType<typeof vi.fn>> } } }).http.options
    .axiosInstance as Record<'post', ReturnType<typeof vi.fn>>;
  http.post.mockResolvedValue({ data: { messages: [{ id: 'wamid.1' }] } });
  return { provider, http, logger };
}

const reply = (id: string, displayText: string) => ({ type: 'reply' as const, id, displayText });

const card = (n: number, overrides: Partial<CarouselCard> = {}): CarouselCard => ({
  body: `Loja ${n}`,
  imageUrl: `https://zapediu.test/${n}.jpg`,
  buttons: [reply(`view_menu_${n}`, '📖 Ver Cardápio')],
  ...overrides,
});

const cards = (count: number, make: (n: number) => CarouselCard = card): CarouselCard[] =>
  Array.from({ length: count }, (_, i) => make(i + 1));

describe('MetaCloudApiProvider — carrossel interativo', () => {
  let ctx: ReturnType<typeof makeProvider>;
  beforeEach(() => {
    ctx = makeProvider();
  });

  const send = (content: CarouselContent) => ctx.provider.sendCarousel('i', TO, content);

  it('monta exatamente o payload da documentação: interactive/carousel, imagem por link, botões quick_reply', async () => {
    const result = await send({
      body: '🏪 Lojas abertas agora:',
      cards: [
        { body: '*Pizzaria do Zé*\n\n💬 "Melhor pizza"', imageUrl: 'https://zapediu.test/ze.jpg', buttons: [reply('view_menu_ze', '📖 Ver Cardápio')] },
        { body: 'Ver mais lojas', imageUrl: 'https://zapediu.test/mais.jpg', buttons: [reply('view_more_9', 'Ver mais')] },
      ],
    });

    expect(result.messageId).toBe('wamid.1');
    expect(ctx.http.post).toHaveBeenCalledTimes(1);
    expect(ctx.http.post.mock.calls[0]).toEqual([
      '/PHONE_ID/messages',
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: TO,
        type: 'interactive',
        interactive: {
          type: 'carousel',
          body: { text: '🏪 Lojas abertas agora:' },
          action: {
            cards: [
              {
                card_index: 0,
                type: 'cta_url',
                header: { type: 'image', image: { link: 'https://zapediu.test/ze.jpg' } },
                body: { text: '*Pizzaria do Zé*\n\n💬 "Melhor pizza"' },
                action: { buttons: [{ type: 'quick_reply', quick_reply: { id: 'view_menu_ze', title: '📖 Ver Cardápio' } }] },
              },
              {
                card_index: 1,
                type: 'cta_url',
                header: { type: 'image', image: { link: 'https://zapediu.test/mais.jpg' } },
                body: { text: 'Ver mais lojas' },
                action: { buttons: [{ type: 'quick_reply', quick_reply: { id: 'view_more_9', title: 'Ver mais' } }] },
              },
            ],
          },
        },
      },
    ]);
  });

  it('aceita de 2 a 10 cards e recusa 1 e 11', async () => {
    await expect(send({ body: 'x', cards: cards(2) })).resolves.toBeDefined();
    await expect(send({ body: 'x', cards: cards(10) })).resolves.toBeDefined();
    await expect(send({ body: 'x', cards: cards(1) })).rejects.toThrow(/de 2 a 10 cards \(recebeu 1\)/);
    await expect(send({ body: 'x', cards: cards(11) })).rejects.toThrow(/de 2 a 10 cards \(recebeu 11\)/);
  });

  it('não chama a Graph API quando a validação falha', async () => {
    await expect(send({ body: 'x', cards: cards(1) })).rejects.toThrow();
    expect(ctx.http.post).not.toHaveBeenCalled();
  });

  it('o corpo principal é obrigatório e tem no máximo 1024 caracteres', async () => {
    await expect(send({ body: '   ', cards: cards(2) })).rejects.toThrow(/corpo principal/);
    await expect(send({ body: 'x'.repeat(1025), cards: cards(2) })).rejects.toThrow(/corpo principal/);
    await expect(send({ body: 'x'.repeat(1024), cards: cards(2) })).resolves.toBeDefined();
  });

  it('todo card precisa de imagem', async () => {
    await expect(send({ body: 'x', cards: cards(2, (n) => (n === 2 ? card(n, { imageUrl: undefined }) : card(n))) })).rejects.toThrow(
      /card 2 sem imagem/,
    );
  });

  it('texto do card: até 160 caracteres e no máximo 2 quebras de linha', async () => {
    await expect(send({ body: 'x', cards: cards(2, (n) => card(n, { body: 'a'.repeat(160) })) })).resolves.toBeDefined();
    await expect(send({ body: 'x', cards: cards(2, (n) => card(n, { body: 'a'.repeat(161) })) })).rejects.toThrow(/mais de 160/);
    await expect(send({ body: 'x', cards: cards(2, (n) => card(n, { body: 'a\nb\nc' })) })).resolves.toBeDefined();
    await expect(send({ body: 'x', cards: cards(2, (n) => card(n, { body: 'a\nb\nc\nd' })) })).rejects.toThrow(/mais de 2 quebras/);
  });

  it('card sem texto vai sem o campo body', async () => {
    await send({ body: 'x', cards: cards(2, (n) => card(n, { body: '' })) });
    const [first] = ctx.http.post.mock.calls[0]![1].interactive.action.cards;
    expect(first).not.toHaveProperty('body');
  });

  it('botões de resposta: até 20 caracteres no título e id de até 256', async () => {
    await expect(send({ body: 'x', cards: cards(2, (n) => card(n, { buttons: [reply('a', 'x'.repeat(21))] })) })).rejects.toThrow(/mais de 20/);
    await expect(send({ body: 'x', cards: cards(2, (n) => card(n, { buttons: [reply('a'.repeat(257), 'ok')] })) })).rejects.toThrow(/id de botão/);
    await expect(send({ body: 'x', cards: cards(2, (n) => card(n, { buttons: [reply('a'.repeat(256), 'x'.repeat(20))] })) })).resolves.toBeDefined();
  });

  it('botão de resposta sem id usa o texto como id; botão legado sem type conta como resposta', async () => {
    const legacy = { id: 'legacy_1', displayText: 'Legado' } as unknown as CarouselCard['buttons'][number];
    await send({
      body: 'x',
      cards: cards(2, (n) => card(n, { buttons: [{ type: 'reply', displayText: 'Sim' }, legacy] })),
    });
    const [first] = ctx.http.post.mock.calls[0]![1].interactive.action.cards;
    expect(first.action.buttons).toEqual([
      { type: 'quick_reply', quick_reply: { id: 'Sim', title: 'Sim' } },
      { type: 'quick_reply', quick_reply: { id: 'legacy_1', title: 'Legado' } },
    ]);
  });

  it('suporta 2 e 3 botões de resposta por card, desde que todos os cards tenham a mesma quantidade (produto e pizza)', async () => {
    const two = (n: number) => card(n, { buttons: [reply(`add_${n}`, '🛒 Adicionar'), reply(`qty_${n}`, '🔢 Quero mais de um')] });
    const three = (n: number) =>
      card(n, { buttons: [reply(`s_${n}`, 'Pequena — R$ 30'), reply(`m_${n}`, 'Média — R$ 40'), reply(`g_${n}`, '—')] });

    await send({ body: 'x', cards: cards(3, two) });
    await send({ body: 'x', cards: cards(3, three) });

    const sent = ctx.http.post.mock.calls.map((call) => call[1].interactive.action.cards[0].action.buttons.length);
    expect(sent).toEqual([2, 3]);
  });

  it('REGRA DA META: quantidade de botões diferente entre cards é recusada com o card e o motivo', async () => {
    const uneven = cards(3, (n) => (n === 3 ? card(n, { buttons: [reply('more', 'Ver mais')] }) : card(n, { buttons: [reply('a', 'A'), reply('b', 'B')] })));

    await expect(send({ body: 'x', cards: uneven })).rejects.toThrow(/card 3 tem botões diferentes.*reply:1 ≠ reply:2/);
    expect(ctx.http.post).not.toHaveBeenCalled();
  });

  it('botão de link: UM botão url por card vira cta_url; todos os cards precisam ser assim', async () => {
    const url = (n: number): CarouselCard =>
      card(n, { buttons: [{ type: 'url', displayText: 'Abrir', url: `https://zapediu.test/loja/${n}` }] });

    await send({ body: 'x', cards: cards(2, url) });

    const [first] = ctx.http.post.mock.calls[0]![1].interactive.action.cards;
    expect(first.action).toEqual({ name: 'cta_url', parameters: { display_text: 'Abrir', url: 'https://zapediu.test/loja/1' } });

    await expect(send({ body: 'x', cards: [url(1), card(2)] })).rejects.toThrow(/botões diferentes/);
  });

  it('não mistura botão de link com resposta no mesmo card, nem aceita card sem botão', async () => {
    const mixed = cards(2, (n) => card(n, { buttons: [reply('a', 'A'), { type: 'url', displayText: 'Site', url: 'https://x.test' }] }));
    await expect(send({ body: 'x', cards: mixed })).rejects.toThrow(/sem misturar/);
    await expect(send({ body: 'x', cards: cards(2, (n) => card(n, { buttons: [] })) })).rejects.toThrow(/ao menos um botão/);
    await expect(
      send({ body: 'x', cards: cards(2, (n) => card(n, { buttons: [{ type: 'call', displayText: 'Ligar', phoneNumber: '+5598999990000' }] })) }),
    ).rejects.toThrow(/sem misturar/);
  });

  it('providerOptions de template é ignorado: nunca vira mensagem de template', async () => {
    await ctx.provider.sendCarousel('i', TO, { body: 'x', cards: cards(2) }, { templateName: 'lojas_v1', languageCode: 'pt_BR' });

    const payload = ctx.http.post.mock.calls[0]![1];
    expect(payload.type).toBe('interactive');
    expect(JSON.stringify(payload)).not.toContain('lojas_v1');
  });
});

describe('MetaCloudApiProvider — toque num botão do carrossel', () => {
  const wrap = (message: Record<string, unknown>) =>
    Buffer.from(
      JSON.stringify({
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: 'PHONE_ID' },
                  contacts: [{ wa_id: TO, profile: { name: 'Maria' } }],
                  messages: [{ from: TO, id: 'wamid.in', timestamp: '1700000000', ...message }],
                },
              },
            ],
          },
        ],
      }),
    );

  const normalizedOf = (event: { payload: unknown } | undefined) =>
    (event!.payload as { normalized: Record<string, unknown> }).normalized;

  it('type "button" com button.payload (formato do quick_reply do carrossel) vira o id que enviamos', () => {
    const { provider } = makeProvider();

    // Formato descrito para o clique no carrossel: type "button", payload = quick_reply.id, context.id = o carrossel.
    const [event] = provider.parseWebhookPayload(
      wrap({
        context: { from: '5598988887777', id: 'wamid.carrossel' },
        type: 'button',
        button: { payload: 'flow_add1_loja_12', text: '🛒 Adicionar R$ 29,90' },
      }),
      {},
    );

    expect(normalizedOf(event)).toMatchObject({
      type: 'button',
      buttonReplyId: 'flow_add1_loja_12',
      buttonReplyTitle: '🛒 Adicionar R$ 29,90',
      replyToMessageId: 'wamid.carrossel',
      profileName: 'Maria',
    });
  });

  it('os três formatos de toque chegam ao Zapedio como o MESMO campo: button_reply, list_reply e button.payload', () => {
    const { provider } = makeProvider();
    const idOf = (message: Record<string, unknown>) => {
      const [event] = provider.parseWebhookPayload(wrap(message), {});
      const n = normalizedOf(event);
      return n['buttonReplyId'] ?? n['listReplyId'];
    };

    expect(idOf({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'flow_add1_loja_12', title: 'Adicionar' } } })).toBe('flow_add1_loja_12');
    expect(idOf({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'flow_add1_loja_12', title: 'Adicionar' } } })).toBe('flow_add1_loja_12');
    expect(idOf({ type: 'button', button: { payload: 'flow_add1_loja_12', text: 'Adicionar' } })).toBe('flow_add1_loja_12');
  });

  it('guarda o payload bruto do clique (type "button") no log para confirmar o formato com o primeiro clique real', () => {
    const { provider, logger } = makeProvider();
    const info = vi.spyOn(logger, 'info');

    provider.parseWebhookPayload(wrap({ type: 'button', button: { payload: 'flow_add1_loja_12', text: 'Adicionar' } }), {});

    expect(info).toHaveBeenCalledWith(
      'Meta: toque em botão (type "button") — payload bruto',
      expect.objectContaining({ instanceId: 'loja-1', raw: expect.stringContaining('"payload":"flow_add1_loja_12"') }),
    );
  });

  it('interactive de formato desconhecido: aviso com as chaves E o payload bruto, sem perder a mensagem', () => {
    const { provider, logger } = makeProvider();
    const warn = vi.spyOn(logger, 'warn');

    const [event] = provider.parseWebhookPayload(
      wrap({ type: 'interactive', interactive: { type: 'carousel_reply', carousel_reply: { id: 'x' } } }),
      {},
    );

    expect(event!.type).toBe('MessageReceived');
    expect(normalizedOf(event)).toEqual({ type: 'interactive', timestamp: 1700000000, profileName: 'Maria' });
    expect(warn).toHaveBeenCalledWith(
      'Meta: mensagem interativa recebida em formato desconhecido',
      expect.objectContaining({
        interactiveType: 'carousel_reply',
        keys: ['type', 'carousel_reply'],
        raw: expect.stringContaining('carousel_reply'),
      }),
    );
  });

  it('message.type desconhecido é registrado com o payload bruto; tipos conhecidos sem campo próprio ficam em silêncio', () => {
    const { provider, logger } = makeProvider();
    const warn = vi.spyOn(logger, 'warn');

    const [unknown] = provider.parseWebhookPayload(wrap({ type: 'carousel_click', carousel_click: { card: 4 } }), {});
    expect(unknown!.type).toBe('MessageReceived');
    expect(warn).toHaveBeenCalledWith(
      'Meta: mensagem recebida com tipo desconhecido',
      expect.objectContaining({ messageType: 'carousel_click', raw: expect.stringContaining('"card":4') }),
    );

    warn.mockClear();
    for (const type of ['order', 'system', 'unsupported', 'contacts']) {
      provider.parseWebhookPayload(wrap({ type, [type]: {} }), {});
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('o log do payload bruto é limitado para não estourar a linha', () => {
    const { provider, logger } = makeProvider();
    const warn = vi.spyOn(logger, 'warn');

    provider.parseWebhookPayload(wrap({ type: 'algo_novo', algo_novo: { dados: 'x'.repeat(5000) } }), {});

    const call = warn.mock.calls.find(([message]) => message === 'Meta: mensagem recebida com tipo desconhecido');
    const raw = (call![1] as { raw: string }).raw;
    expect(raw.length).toBeLessThanOrEqual(2001);
    expect(raw.endsWith('…')).toBe(true);
  });
});
