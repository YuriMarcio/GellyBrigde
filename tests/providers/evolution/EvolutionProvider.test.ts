import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EvolutionProvider } from '../../../src/providers/evolution/EvolutionProvider.js';
import { ConsoleLogger } from '../../../src/infrastructure/logging/ConsoleLogger.js';

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
  vi.spyOn(logger, 'debug').mockImplementation(() => {});
  const provider = new EvolutionProvider({ name: 'evolution', baseUrl: 'https://evolution.test', apiKey: 'key' }, logger);
  return provider;
}

function getAxios(provider: EvolutionProvider) {
  return (provider as unknown as { http: { options: { axiosInstance: Record<string, ReturnType<typeof vi.fn>> } } }).http
    .options.axiosInstance;
}

describe('EvolutionProvider', () => {
  let provider: EvolutionProvider;

  beforeEach(() => {
    provider = makeProvider();
  });

  it('sendText envia payload sem delay por padrão (resposta imediata)', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({ data: { key: { id: 'abc123' } } });

    const result = await provider.sendText('inst-01', '5598999990000', 'Olá!');

    expect(http['post']).toHaveBeenCalledWith('/message/sendText/inst-01', {
      number: '5598999990000',
      text: 'Olá!',
    });
    expect(result.messageId).toBe('abc123');
  });

  it('sendText respeita delayMs customizado', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({ data: {} });

    await provider.sendText('inst-01', '5598999990000', 'Teste', { delayMs: 3000 });

    expect(http['post']).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ delay: 3000 }));
  });

  it('checkNumbers retorna apenas números válidos limpos', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({
      data: [
        { jid: '5598999990000@s.whatsapp.net', exists: true },
        { jid: '5511000000000@s.whatsapp.net', exists: false },
        { jid: '5521988880000@s.whatsapp.net', exists: true },
      ],
    });

    const result = await provider.checkNumbers('inst-01', ['5598999990000', '5511000000000', '5521988880000']);

    expect(result).toEqual(['5598999990000', '5521988880000']);
  });

  it('checkNumbers não faz request para lista vazia', async () => {
    const http = getAxios(provider);
    const result = await provider.checkNumbers('inst-01', []);
    expect(result).toEqual([]);
    expect(http['post']).not.toHaveBeenCalled();
  });

  it('getMediaBase64 busca a mídia decriptada pelo messageId, sem mediaKey/remoteJid', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({
      data: { base64: 'QUFB', mimetype: 'audio/ogg; codecs=opus', mediaType: 'audioMessage' },
    });

    const result = await provider.getMediaBase64('inst-01', 'MSG123');

    expect(http['post']).toHaveBeenCalledWith('/chat/getBase64FromMediaMessage/inst-01', {
      message: { key: { id: 'MSG123' } },
      convertToMp4: false,
    });
    expect(result.base64).toBe('QUFB');
    expect(result.mimetype).toBe('audio/ogg; codecs=opus');
  });

  it('getMediaBase64 lança erro se a resposta vier sem base64/mimetype', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({ data: { mediaType: 'audioMessage' } });

    await expect(provider.getMediaBase64('inst-01', 'MSG123')).rejects.toThrow();
  });

  it('connect cria a instância e busca o QR code', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({ data: { instance: { instanceName: 'inst-01' } } });
    http['get']!.mockResolvedValueOnce({ data: { qrcode: { base64: 'data:image/png;base64,AAA' } } });

    const result = await provider.connect('inst-01');

    expect(http['post']).toHaveBeenCalledWith(
      '/instance/create',
      expect.objectContaining({ instanceName: 'inst-01', integration: 'WHATSAPP-BAILEYS' }),
    );
    expect(http['get']).toHaveBeenCalledWith('/instance/connect/inst-01');
    expect(result.status).toBe('qr_required');
    expect(result.qrCode).toBe('data:image/png;base64,AAA');
  });

  it('getQrCode faz logout antes de buscar o QR (limpa sessão Baileys obsoleta) e não recria a instância', async () => {
    const http = getAxios(provider);
    http['get']!.mockResolvedValueOnce({ data: { instance: { state: 'close' } } }); // connectionState check
    http['delete']!.mockResolvedValueOnce({ data: {} });
    http['get']!.mockResolvedValueOnce({ data: { qrcode: { base64: 'data:image/png;base64,BBB' } } });

    const result = await provider.getQrCode('inst-01');

    expect(http['post']).not.toHaveBeenCalled();
    expect(http['delete']).toHaveBeenCalledWith('/instance/logout/inst-01');
    expect(http['get']).toHaveBeenCalledWith('/instance/connect/inst-01');
    expect(result.qrCode).toBe('data:image/png;base64,BBB');
  });

  it('getQrCode busca o QR mesmo se o logout falhar (instância pode nunca ter conectado)', async () => {
    const http = getAxios(provider);
    http['get']!.mockResolvedValueOnce({ data: { instance: { state: 'connecting' } } }); // connectionState check
    http['delete']!.mockRejectedValueOnce(new Error('nada pra deslogar'));
    http['get']!.mockResolvedValueOnce({ data: { qrcode: { base64: 'data:image/png;base64,CCC' } } });

    const result = await provider.getQrCode('inst-01');

    expect(result.qrCode).toBe('data:image/png;base64,CCC');
  });

  it('getQrCode não deslogo instância já conectada — retorna status connected direto', async () => {
    const http = getAxios(provider);
    http['get']!.mockResolvedValueOnce({ data: { instance: { state: 'open' } } }); // connectionState check

    const result = await provider.getQrCode('inst-01');

    expect(http['delete']).not.toHaveBeenCalled();
    expect(http['get']).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'connected', raw: { instance: { state: 'open' } } });
  });

  it('getQrCode segue o fluxo normal se a checagem de status falhar', async () => {
    const http = getAxios(provider);
    http['get']!.mockRejectedValueOnce(new Error('instância desconhecida')); // connectionState check falha
    http['delete']!.mockResolvedValueOnce({ data: {} });
    http['get']!.mockResolvedValueOnce({ data: { qrcode: { base64: 'data:image/png;base64,DDD' } } });

    const result = await provider.getQrCode('inst-01');

    expect(http['delete']).toHaveBeenCalledWith('/instance/logout/inst-01');
    expect(result.qrCode).toBe('data:image/png;base64,DDD');
  });

  it('getStatus mapeia o state retornado pela Evolution', async () => {
    const http = getAxios(provider);
    http['get']!.mockResolvedValueOnce({ data: { instance: { state: 'open' } } });

    const status = await provider.getStatus('inst-01');

    expect(status).toEqual({ instanceId: 'inst-01', state: 'open', raw: { instance: { state: 'open' } } });
  });

  it('sendButtons mapeia ButtonsContent para o payload da Evolution', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({ data: {} });

    await provider.sendButtons('inst-01', '5598999990000', {
      title: 'Título',
      body: 'Corpo',
      footer: 'Rodapé',
      buttons: [{ id: 'BTN_SIM', displayText: 'Sim' }],
    });

    expect(http['post']).toHaveBeenCalledWith(
      '/message/sendButtons/inst-01',
      expect.objectContaining({
        number: '5598999990000',
        title: 'Título',
        description: 'Corpo',
        footer: 'Rodapé',
        buttons: [{ type: 'reply', displayText: 'Sim', id: 'BTN_SIM' }],
      }),
    );
  });

  it('sendButtons sem title usa fallback (evita "*undefined*" e "**" no corpo da mensagem)', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({ data: {} });

    await provider.sendButtons('inst-01', '5598999990000', {
      body: 'Corpo sem título',
      buttons: [{ id: 'BTN_SIM', displayText: 'Sim' }],
    });

    expect(http['post']).toHaveBeenCalledWith(
      '/message/sendButtons/inst-01',
      expect.objectContaining({ title: 'Zapediu', footer: '' }),
    );
  });

  it('sendButtons aceita botões tipados (url/call/copy) e passa direto pro payload da Evolution', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({ data: {} });

    await provider.sendButtons('inst-01', '5598999990000', {
      title: 'Título',
      body: 'Corpo',
      buttons: [
        { type: 'call', displayText: 'Fale conosco', phoneNumber: '5598999990000' },
        { type: 'url', displayText: 'Visite nosso site', url: 'https://exemplo.com' },
        { id: 'BTN_ATENDENTE', displayText: 'Falar com atendente' },
      ],
    });

    expect(http['post']).toHaveBeenCalledWith(
      '/message/sendButtons/inst-01',
      expect.objectContaining({
        buttons: [
          { type: 'call', displayText: 'Fale conosco', phoneNumber: '5598999990000' },
          { type: 'url', displayText: 'Visite nosso site', url: 'https://exemplo.com' },
          { type: 'reply', displayText: 'Falar com atendente', id: 'BTN_ATENDENTE' },
        ],
      }),
    );
  });

  it('sendList sem footer usa fallback em footerText (campo obrigatório na Evolution — 400 se ausente)', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({ data: {} });

    await provider.sendList('inst-01', '5598999990000', {
      title: 'Título',
      description: 'Descrição',
      buttonText: 'Ver opções',
      sections: [{ title: 'Seção 1', rows: [{ rowId: 'r1', title: 'Linha 1' }] }],
    });

    expect(http['post']).toHaveBeenCalledWith(
      '/message/sendList/inst-01',
      expect.objectContaining({ buttonText: 'Ver opções', footerText: 'Zapediu' }),
    );
  });

  it('sendCarousel envia cada botão de card com "type" explícito (reply/url/call/copy)', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({ data: {} });

    await provider.sendCarousel('inst-01', '5511999999999', {
      body: 'Confira nossos produtos em destaque:',
      cards: [
        {
          title: 'Produto A',
          body: 'Descrição do Produto A.',
          footer: 'Frete grátis',
          imageUrl: 'https://exemplo.com/imagens/produto-a.jpg',
          buttons: [
            { type: 'url', displayText: 'Ver produto', url: 'https://loja.exemplo.com/produto-a' },
            { type: 'reply', displayText: 'Tenho interesse', id: 'interesse_produto_a' },
          ],
        },
        {
          title: 'Produto B',
          body: 'Descrição do Produto B.',
          footer: 'Últimas unidades',
          buttons: [
            { type: 'call', displayText: 'Ligar para vendas', phoneNumber: '5511988887777' },
            { type: 'copy', displayText: 'Copiar cupom', copyCode: 'DESCONTO10' },
          ],
        },
      ],
    });

    expect(http['post']).toHaveBeenCalledWith('/message/sendCarousel/inst-01', {
      number: '5511999999999',
      body: 'Confira nossos produtos em destaque:',
      cards: [
        {
          title: 'Produto A',
          body: 'Descrição do Produto A.',
          footer: 'Frete grátis',
          imageUrl: 'https://exemplo.com/imagens/produto-a.jpg',
          buttons: [
            { type: 'url', displayText: 'Ver produto', url: 'https://loja.exemplo.com/produto-a' },
            { type: 'reply', displayText: 'Tenho interesse', id: 'interesse_produto_a' },
          ],
        },
        {
          title: 'Produto B',
          body: 'Descrição do Produto B.',
          footer: 'Últimas unidades',
          buttons: [
            { type: 'call', displayText: 'Ligar para vendas', phoneNumber: '5511988887777' },
            { type: 'copy', displayText: 'Copiar cupom', copyCode: 'DESCONTO10' },
          ],
        },
      ],
    });
  });

  it('sendReaction monta o remoteJid a partir do número', async () => {
    const http = getAxios(provider);
    http['post']!.mockResolvedValueOnce({ data: {} });

    await provider.sendReaction('inst-01', '5598999990000', 'MSG_ID', '👍');

    expect(http['post']).toHaveBeenCalledWith('/message/sendReaction/inst-01', {
      reactionMessage: {
        key: { remoteJid: '5598999990000@s.whatsapp.net', fromMe: false, id: 'MSG_ID' },
        reaction: '👍',
      },
    });
  });

  describe('createGroup', () => {
    it('cria o grupo com participantes normalizados (só dígitos) e retorna o JID', async () => {
      const http = getAxios(provider);
      http['post']!.mockResolvedValueOnce({ data: { id: '120363012345678901@g.us', subject: 'Entregadores Centro' } });

      const result = await provider.createGroup('inst-01', 'Entregadores Centro', ['(55) 98999-0000', '5511000000000']);

      expect(http['post']).toHaveBeenCalledWith('/group/create/inst-01', {
        subject: 'Entregadores Centro',
        participants: ['55989990000', '5511000000000'],
      });
      expect(result.groupJid).toBe('120363012345678901@g.us');
      expect(result.participants).toEqual([
        { jid: '55989990000', status: 'added' },
        { jid: '5511000000000', status: 'added' },
      ]);
    });

    it('lança erro quando a resposta não traz o JID do grupo', async () => {
      const http = getAxios(provider);
      http['post']!.mockResolvedValueOnce({ data: {} });

      await expect(provider.createGroup('inst-01', 'Grupo', ['5511000000000'])).rejects.toThrow(
        'JID do grupo ausente',
      );
    });
  });

  describe('addGroupParticipants', () => {
    it('adiciona participantes e normaliza o resultado por status', async () => {
      const http = getAxios(provider);
      http['put']!.mockResolvedValueOnce({
        data: [
          { jid: '5511000000000', status: '200' },
          { jid: '5521000000000', status: '403' },
        ],
      });

      const result = await provider.addGroupParticipants('inst-01', '123@g.us', ['5511000000000', '5521000000000']);

      expect(http['put']).toHaveBeenCalledWith('/group/updateParticipant/inst-01?groupJid=123%40g.us', {
        action: 'add',
        participants: ['5511000000000', '5521000000000'],
      });
      expect(result).toEqual([
        { jid: '5511000000000', status: 'added' },
        { jid: '5521000000000', status: 'failed' },
      ]);
    });

    it('assume "added" quando a resposta não é um array reconhecível', async () => {
      const http = getAxios(provider);
      http['put']!.mockResolvedValueOnce({ data: {} });

      const result = await provider.addGroupParticipants('inst-01', '123@g.us', ['5511000000000']);

      expect(result).toEqual([{ jid: '5511000000000', status: 'added' }]);
    });
  });

  describe('promoteGroupAdmins', () => {
    it('envia action=promote pros participantes informados', async () => {
      const http = getAxios(provider);
      http['put']!.mockResolvedValueOnce({ data: {} });

      await provider.promoteGroupAdmins('inst-01', '123@g.us', ['5511000000000']);

      expect(http['put']).toHaveBeenCalledWith('/group/updateParticipant/inst-01?groupJid=123%40g.us', {
        action: 'promote',
        participants: ['5511000000000'],
      });
    });
  });

  describe('getGroupInviteCode', () => {
    it('monta a URL de convite a partir do código', async () => {
      const http = getAxios(provider);
      http['get']!.mockResolvedValueOnce({ data: { inviteCode: 'AbCdEfG123' } });

      const result = await provider.getGroupInviteCode('inst-01', '123@g.us');

      expect(http['get']).toHaveBeenCalledWith('/group/inviteCode/inst-01?groupJid=123%40g.us');
      expect(result).toEqual({ code: 'AbCdEfG123', url: 'https://chat.whatsapp.com/AbCdEfG123' });
    });

    it('lança erro quando a resposta não traz inviteCode', async () => {
      const http = getAxios(provider);
      http['get']!.mockResolvedValueOnce({ data: {} });

      await expect(provider.getGroupInviteCode('inst-01', '123@g.us')).rejects.toThrow('código ausente');
    });
  });

  describe('parseWebhookPayload', () => {
    function payload(body: unknown): Buffer {
      return Buffer.from(JSON.stringify(body));
    }

    it('messages.upsert de mensagem recebida vira MessageReceived', () => {
      const events = provider.parseWebhookPayload(
        payload({
          event: 'messages.upsert',
          instance: 'inst-01',
          data: { key: { id: 'MSG1', remoteJid: '5598999990000@s.whatsapp.net', fromMe: false }, message: { conversation: 'oi' } },
        }),
        {},
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'MessageReceived',
        instanceId: 'inst-01',
        payload: { from: '5598999990000', messageId: 'MSG1' },
      });
    });

    it('messages.upsert de mensagem própria (fromMe) não gera evento', () => {
      const events = provider.parseWebhookPayload(
        payload({ event: 'messages.upsert', instance: 'inst-01', data: { key: { fromMe: true } } }),
        {},
      );
      expect(events).toEqual([]);
    });

    it('connection.update state=open vira InstanceConnected', () => {
      const events = provider.parseWebhookPayload(
        payload({ event: 'connection.update', instance: 'inst-01', data: { state: 'open' } }),
        {},
      );
      expect(events[0]).toMatchObject({ type: 'InstanceConnected', instanceId: 'inst-01' });
    });

    it('evento desconhecido não gera nenhum DomainEvent', () => {
      const events = provider.parseWebhookPayload(payload({ event: 'algo.novo' }), {});
      expect(events).toEqual([]);
    });
  });
});
