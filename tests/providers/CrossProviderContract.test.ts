import axios from 'axios';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ButtonsContent,
  CarouselContent,
  CommunicationProvider,
  ListContent,
  WhatsAppProviderName,
} from '../../src/core/interfaces/CommunicationProvider.js';
import { PROVIDER_CAPABILITIES } from '../../src/core/interfaces/BusinessCapabilities.js';
import { UnsupportedProviderOperationException } from '../../src/core/exceptions/UnsupportedProviderOperationException.js';
import { ConsoleLogger } from '../../src/infrastructure/logging/ConsoleLogger.js';
import { EvolutionProvider } from '../../src/providers/evolution/EvolutionProvider.js';
import { MetaCloudApiProvider } from '../../src/providers/meta/MetaCloudApiProvider.js';
import { ZApiProvider } from '../../src/providers/zapi/ZApiProvider.js';

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

/**
 * Responde ao mesmo "mock universal" nos três providers: cada um lê o id da mensagem de um
 * campo diferente (`key.id`, `messageId`, `messages[0].id`), e a Evolution lê o JID do grupo
 * em `id` e a mídia em `base64`/`mimetype`. Assim o teste só enxerga diferenças de CONTRATO,
 * não de formato de resposta.
 */
const UNIVERSAL_RESPONSE = {
  data: {
    id: '120363000000000000@g.us',
    key: { id: 'm1' },
    messageId: 'm1',
    messages: [{ id: 'm1' }],
    base64: 'AAAA',
    mimetype: 'audio/ogg',
    // Meta: GET /{media_id} devolve a URL e o mime; o download dessa URL devolve os bytes.
    url: 'https://lookaside.test/media/1',
    mime_type: 'audio/ogg',
  },
};

const MEDIA_DOWNLOAD_RESPONSE = { data: new ArrayBuffer(4), headers: { 'content-type': 'audio/ogg' } };

type Outcome = 'accepted' | 'unsupported' | 'rejected';

function makeProviders(): Record<WhatsAppProviderName, CommunicationProvider> {
  const logger = new ConsoleLogger();
  vi.spyOn(logger, 'error').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});

  return {
    evolution: new EvolutionProvider({ name: 'evolution', baseUrl: 'https://evo.test', apiKey: 'k' }, logger),
    zapi: new ZApiProvider({ name: 'zapi', instanceId: 'inst', token: 'tok' }, logger),
    meta: new MetaCloudApiProvider({ name: 'meta', phoneNumberId: 'PHONE_ID', accessToken: 'tok' }, logger),
  };
}

function httpOf(provider: CommunicationProvider): Record<string, ReturnType<typeof vi.fn>> {
  return (provider as unknown as { http: { options: { axiosInstance: Record<string, ReturnType<typeof vi.fn>> } } }).http
    .options.axiosInstance;
}

function lastPost(provider: CommunicationProvider): [string, any] {
  const calls = httpOf(provider)['post']!.mock.calls;
  return calls[calls.length - 1] as [string, any];
}

// ----------------------------------------------------------------------------
// Objetos de mensagem — UM de cada, enviados idênticos para os três providers.
// ----------------------------------------------------------------------------

const TO = '5598999990000';

const buttonsOk: ButtonsContent = {
  title: 'Pedido',
  body: 'Confirma o pedido?',
  footer: 'Zapediu',
  buttons: [
    { id: 'confirm', displayText: 'Confirmar' },
    { id: 'edit', displayText: 'Editar' },
    { id: 'cancel', displayText: 'Cancelar' },
  ],
};

// 24 caracteres: é o corte que o Zapedio faz hoje (CartFlow/CheckoutFlow).
const buttonsLongLabel: ButtonsContent = {
  body: 'Qual item?',
  buttons: [{ id: 'pick_0', displayText: 'Pizza Calabresa Grande 1' }],
};

const buttonsFour: ButtonsContent = {
  body: 'Escolha',
  buttons: ['a', 'b', 'c', 'd'].map((id) => ({ id, displayText: id.toUpperCase() })),
};

const buttonsTyped: ButtonsContent = {
  body: 'Veja o cardápio',
  buttons: [{ type: 'url', displayText: 'Abrir', url: 'https://zapediu.test/loja' }],
};

const buttonsTwoUrls: ButtonsContent = {
  body: 'Links',
  buttons: [
    { type: 'url', displayText: 'Loja', url: 'https://zapediu.test/loja' },
    { type: 'url', displayText: 'Site', url: 'https://zapediu.test' },
  ],
};

const listOk: ListContent = {
  title: 'Lojas',
  description: 'Escolha uma loja',
  buttonText: 'Ver lojas',
  sections: [
    { title: 'Perto de você', rows: [1, 2, 3, 4, 5].map((n) => ({ rowId: `store_${n}`, title: `Loja ${n}` })) },
  ],
};

const listTooBig: ListContent = {
  ...listOk,
  sections: [{ title: 'Todas', rows: Array.from({ length: 12 }, (_, i) => ({ rowId: `s${i}`, title: `Loja ${i}` })) }],
};

const carouselUneven: CarouselContent = {
  body: 'Produtos',
  cards: [
    {
      body: 'Produto 1',
      imageUrl: 'https://zapediu.test/1.jpg',
      buttons: [
        { type: 'reply', id: 'add_1', displayText: 'Adicionar' },
        { type: 'reply', id: 'more_1', displayText: 'Quero mais' },
      ],
    },
    {
      body: 'Ver mais',
      imageUrl: 'https://zapediu.test/2.jpg',
      buttons: [{ type: 'reply', id: 'more', displayText: 'Ver mais' }],
    },
  ],
};

const carouselNoImage: CarouselContent = {
  body: 'Lojas',
  cards: [
    { body: 'Loja 1', imageUrl: 'https://zapediu.test/1.jpg', buttons: [{ type: 'reply', id: 'a', displayText: 'Abrir' }] },
    { body: 'Loja 2', buttons: [{ type: 'reply', id: 'b', displayText: 'Abrir' }] },
  ],
};

const carousel: CarouselContent = {
  body: 'Nossas lojas',
  cards: [
    {
      title: 'Loja 1',
      body: 'Pizzaria do Zé',
      imageUrl: 'https://zapediu.test/1.jpg',
      buttons: [{ type: 'reply', id: 'store_1', displayText: 'Ver cardápio' }],
    },
    {
      title: 'Loja 2',
      body: 'Hamburgueria',
      imageUrl: 'https://zapediu.test/2.jpg',
      buttons: [{ type: 'reply', id: 'store_2', displayText: 'Ver cardápio' }],
    },
  ],
};

// ----------------------------------------------------------------------------
// Cenários e o resultado esperado por provider.
// ----------------------------------------------------------------------------

interface Scenario {
  name: string;
  run: (p: CommunicationProvider) => Promise<unknown>;
  expected: Record<WhatsAppProviderName, Outcome>;
}

const scenarios: Scenario[] = [
  {
    name: 'sendText',
    run: (p) => p.sendText('inst', TO, 'Olá!'),
    expected: { evolution: 'accepted', zapi: 'accepted', meta: 'accepted' },
  },
  {
    name: 'sendImage',
    run: (p) => p.sendImage('inst', TO, 'https://zapediu.test/a.jpg', 'legenda'),
    expected: { evolution: 'accepted', zapi: 'accepted', meta: 'accepted' },
  },
  {
    name: 'sendLocation',
    run: (p) => p.sendLocation('inst', TO, -2.5, -44.3, 'Loja', 'Rua A'),
    expected: { evolution: 'accepted', zapi: 'accepted', meta: 'accepted' },
  },
  {
    name: 'sendReaction',
    run: (p) => p.sendReaction('inst', TO, 'wamid.1', '👍'),
    expected: { evolution: 'accepted', zapi: 'accepted', meta: 'accepted' },
  },
  {
    name: 'sendButtons (3 botões, rótulo curto)',
    run: (p) => p.sendButtons('inst', TO, buttonsOk),
    expected: { evolution: 'accepted', zapi: 'accepted', meta: 'accepted' },
  },
  {
    name: 'sendButtons (rótulo de 24 caracteres)',
    run: (p) => p.sendButtons('inst', TO, buttonsLongLabel),
    expected: { evolution: 'accepted', zapi: 'accepted', meta: 'rejected' },
  },
  {
    name: 'sendButtons (4 botões)',
    run: (p) => p.sendButtons('inst', TO, buttonsFour),
    expected: { evolution: 'accepted', zapi: 'accepted', meta: 'rejected' },
  },
  {
    // Um único botão url vira o interactive `cta_url` na Meta.
    name: 'sendButtons (um botão tipado url)',
    run: (p) => p.sendButtons('inst', TO, buttonsTyped),
    expected: { evolution: 'accepted', zapi: 'accepted', meta: 'accepted' },
  },
  {
    name: 'sendButtons (dois botões url)',
    run: (p) => p.sendButtons('inst', TO, buttonsTwoUrls),
    expected: { evolution: 'accepted', zapi: 'accepted', meta: 'rejected' },
  },
  {
    name: 'sendList (5 linhas)',
    run: (p) => p.sendList('inst', TO, listOk),
    expected: { evolution: 'accepted', zapi: 'accepted', meta: 'accepted' },
  },
  {
    name: 'sendList (12 linhas)',
    run: (p) => p.sendList('inst', TO, listTooBig),
    expected: { evolution: 'accepted', zapi: 'accepted', meta: 'rejected' },
  },
  {
    // Na Meta é o carrossel interativo (mensagem de serviço), sem template.
    name: 'sendCarousel',
    run: (p) => p.sendCarousel('inst', TO, carousel),
    expected: { evolution: 'accepted', zapi: 'accepted', meta: 'accepted' },
  },
  {
    // providerOptions é ignorado: o carrossel da Meta não usa template.
    name: 'sendCarousel (com providerOptions de template)',
    run: (p) => p.sendCarousel('inst', TO, carousel, { templateName: 'lojas_v1', languageCode: 'pt_BR' }),
    expected: { evolution: 'accepted', zapi: 'accepted', meta: 'accepted' },
  },
  {
    // A Meta exige o mesmo tipo e a mesma quantidade de botões em todos os cards.
    name: 'sendCarousel (cards com quantidade de botões diferente)',
    run: (p) => p.sendCarousel('inst', TO, carouselUneven),
    expected: { evolution: 'accepted', zapi: 'accepted', meta: 'rejected' },
  },
  {
    name: 'sendCarousel (card sem imagem)',
    run: (p) => p.sendCarousel('inst', TO, carouselNoImage),
    expected: { evolution: 'accepted', zapi: 'accepted', meta: 'rejected' },
  },
  {
    name: 'sendCarousel (1 card)',
    run: (p) => p.sendCarousel('inst', TO, { body: 'Uma loja', cards: [carousel.cards[0]!] }),
    expected: { evolution: 'accepted', zapi: 'accepted', meta: 'rejected' },
  },
  {
    name: 'createGroup',
    run: (p) => p.createGroup('inst', 'Entregas', [TO]),
    expected: { evolution: 'accepted', zapi: 'unsupported', meta: 'unsupported' },
  },
  {
    name: 'getMediaBase64',
    run: (p) => p.getMediaBase64('inst', 'msg-1'),
    expected: { evolution: 'accepted', zapi: 'unsupported', meta: 'accepted' },
  },
];

async function classify(run: Scenario['run'], provider: CommunicationProvider): Promise<Outcome> {
  try {
    await run(provider);
    return 'accepted';
  } catch (err) {
    return err instanceof UnsupportedProviderOperationException ? 'unsupported' : 'rejected';
  }
}

const observed: Array<Record<string, string>> = [];

/**
 * PROVIDER_CAPABILITIES é o que o Zapedio (e a rota /capabilities) usa para adaptar mensagens.
 * Se a tabela divergir do comportamento medido acima, ela passa a mentir — por isso é travada aqui.
 */
describe('PROVIDER_CAPABILITIES reflete o comportamento real', () => {
  const byScenario = (name: string) => scenarios.find((scenario) => scenario.name === name)!.expected;

  it.each(['evolution', 'zapi', 'meta'] as const)('%s: grupos e download de mídia', (name) => {
    const caps = PROVIDER_CAPABILITIES[name];
    expect(caps.groups).toBe(byScenario('createGroup')[name] === 'accepted');
    expect(caps.mediaDownload).toBe(byScenario('getMediaBase64')[name] === 'accepted');
  });

  it.each(['evolution', 'zapi', 'meta'] as const)('%s: carrossel', (name) => {
    // Evolution/Z-API aceitam qualquer carrossel; a Meta só o interativo, com regras (uniforme, 2-10 cards, imagem).
    const strict = byScenario('sendCarousel (cards com quantidade de botões diferente)')[name] === 'rejected';
    expect(PROVIDER_CAPABILITIES[name].messaging.carousel).toBe(strict ? 'interactive' : 'freeform');
  });

  it('limites da Meta batem com o schema zod', () => {
    const { limits } = PROVIDER_CAPABILITIES.meta;
    expect(limits.maxButtons).toBe(3);
    expect(limits.buttonTitleMax).toBe(20);
    expect(limits.listRowsMax).toBe(10);
    expect(limits.listRowTitleMax).toBe(24);
  });
});

describe('Contrato único: o mesmo objeto de mensagem em Evolution, Z-API e Meta', () => {
  let providers: Record<WhatsAppProviderName, CommunicationProvider>;

  beforeEach(() => {
    providers = makeProviders();
    for (const provider of Object.values(providers)) {
      const http = httpOf(provider);
      for (const verb of ['post', 'put'] as const) http[verb]!.mockResolvedValue(UNIVERSAL_RESPONSE);
      http['get']!.mockImplementation(async (url: string) =>
        url.startsWith('https://lookaside.test') ? MEDIA_DOWNLOAD_RESPONSE : UNIVERSAL_RESPONSE,
      );
    }
  });

  afterAll(() => {
    console.table(observed);
  });

  describe.each(scenarios)('$name', ({ name, run, expected }) => {
    it.each(['evolution', 'zapi', 'meta'] as const)('%s', async (providerName) => {
      const outcome = await classify(run, providers[providerName]);
      observed.push({ cenário: name, provider: providerName, resultado: outcome });
      expect(outcome).toBe(expected[providerName]);
    });
  });

  describe('o mesmo objeto vira um request diferente em cada provider', () => {
    it('sendButtons: endpoint e formato próprios, mesmo input e mesmo SendResult', async () => {
      const results = await Promise.all(Object.values(providers).map((p) => p.sendButtons('inst', TO, buttonsOk)));

      expect(results.map((r) => r.messageId)).toEqual(['m1', 'm1', 'm1']);

      expect(lastPost(providers.evolution)[0]).toBe('/message/sendButtons/inst');
      expect(lastPost(providers.zapi)[0]).toBe('/send-button-list');

      const [metaEndpoint, metaBody] = lastPost(providers.meta);
      expect(metaEndpoint).toBe('/PHONE_ID/messages');
      expect(metaBody.type).toBe('interactive');
      expect(metaBody.interactive.action.buttons).toHaveLength(3);
    });

    it('um botão url: Meta vira cta_url, Evolution mantém o botão tipado', async () => {
      await Promise.all(Object.values(providers).map((p) => p.sendButtons('inst', TO, buttonsTyped)));

      expect(lastPost(providers.meta)[1].interactive).toMatchObject({
        type: 'cta_url',
        action: { name: 'cta_url', parameters: { display_text: 'Abrir', url: 'https://zapediu.test/loja' } },
      });
      expect(lastPost(providers.evolution)[1].buttons[0]).toMatchObject({ type: 'url' });
    });

    it('sendCarousel: a Meta vira carrossel interativo (sem template), Evolution e Z-API mantêm os cards', async () => {
      await Promise.all(Object.values(providers).map((p) => p.sendCarousel('inst', TO, carousel)));

      expect(lastPost(providers.evolution)[0]).toBe('/message/sendCarousel/inst');
      expect(lastPost(providers.evolution)[1].cards).toHaveLength(2);
      expect(lastPost(providers.zapi)[0]).toBe('/send-carousel');
      expect(lastPost(providers.zapi)[1].carousel).toHaveLength(2);
      expect(lastPost(providers.meta)[1].type).toBe('interactive');
      expect(lastPost(providers.meta)[1].interactive).toMatchObject({ type: 'carousel', action: { cards: [{ card_index: 0 }, { card_index: 1 }] } });
    });
  });

  describe('degradação silenciosa (não vira erro, mas perde informação)', () => {
    it('Z-API aceita botão url em sendButtons, mas o link some do payload', async () => {
      await providers.zapi.sendButtons('inst', TO, buttonsTyped);

      const [, body] = lastPost(providers.zapi);
      expect(JSON.stringify(body)).not.toContain('https://zapediu.test/loja');
    });

    it('Evolution repassa o botão url com o link', async () => {
      await providers.evolution.sendButtons('inst', TO, buttonsTyped);

      const [, body] = lastPost(providers.evolution);
      expect(JSON.stringify(body)).toContain('https://zapediu.test/loja');
    });
  });
});
