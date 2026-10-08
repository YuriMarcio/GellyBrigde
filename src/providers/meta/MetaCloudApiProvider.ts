import axios from 'axios';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  ButtonsContent,
  CarouselContent,
  CarouselProviderOptions,
  CommunicationProvider,
  ConnectResult,
  CreateGroupResult,
  GroupInviteCode,
  GroupParticipantResult,
  InstanceStatus,
  ListContent,
  SendResult,
  MediaResult,
  SendTextOptions,
  WebhookConfig,
} from '../../core/interfaces/CommunicationProvider.js';
import type {
  CoexistenceManager,
  MarkAsReadOptions,
  PhoneNumberInfo,
  ReadReceiptSender,
  TemplateContent,
  TemplateDefinition,
  TemplateInfo,
  TemplateList,
  TemplateListQuery,
  TemplateManager,
  TemplateSender,
} from '../../core/interfaces/BusinessCapabilities.js';
import type { EventPublisher } from '../../core/interfaces/EventPublisher.js';
import type { Logger } from '../../core/interfaces/Logger.js';
import { UnsupportedProviderOperationException } from '../../core/exceptions/UnsupportedProviderOperationException.js';
import { CustomerServiceWindowClosedException } from '../../core/exceptions/CustomerServiceWindowClosedException.js';
import { ProviderApiException } from '../../core/exceptions/ProviderApiException.js';
import {
  AccountUpdated,
  CoexistenceContactSync,
  CoexistenceHistorySync,
  CoexistenceMessageEcho,
  InstanceConnected,
  MessageDelivered,
  MessageFailed,
  MessageRead,
  MessageReceived,
  MessageSent,
  PhoneNumberQualityUpdated,
  TemplateStatusUpdated,
  type DomainEvent,
  type MessageConversation,
  type MessagePricing,
  type NormalizedInboundMessage,
  type ProviderError,
} from '../../core/events/index.js';
import { ProviderHttpClient } from '../../infrastructure/http/ProviderHttpClient.js';
import type { MetaProviderConfig } from '../../contracts/dto/index.js';
import {
  MetaButtonsContentSchema,
  MetaCtaUrlContentSchema,
  MetaListContentSchema,
  MetaTemplateContentSchema,
} from '../../contracts/schemas/meta.js';

/**
 * Adapter da Meta Cloud API (WhatsApp Business Platform). Diferente da Evolution/Z-API, aqui
 * não existe conceito de instância/QR code — o número é provisionado fora da API (Meta
 * Business Manager / Embedded Signup) e fica fixo por client (config.phoneNumberId).
 * `instanceId` é aceito nos métodos só para respeitar a interface CommunicationProvider (e
 * aparece nos eventos/logs), mas não influencia qual número é usado.
 */
/** Erro da Graph API quando a janela de atendimento de 24h do cliente está fechada. */
const ERROR_CODE_WINDOW_CLOSED = 131047;
const PHONE_FIELDS = 'verified_name,code_verification_status,quality_rating,status,platform_type,is_on_biz_app';

export class MetaCloudApiProvider
  implements CommunicationProvider, TemplateSender, TemplateManager, ReadReceiptSender, CoexistenceManager
{
  readonly name = 'meta' as const;
  private readonly http: ProviderHttpClient;
  private readonly phoneNumberId: string;
  private readonly wabaId: string | undefined;
  private readonly appSecret: string | undefined;
  private readonly verifyToken: string | undefined;
  /** Id dos eventos emitidos: o id lógico da API HTTP, ou o phoneNumberId no modo SDK. */
  private readonly eventInstanceId: string;
  private warnedMissingAppSecret = false;

  constructor(
    config: MetaProviderConfig,
    private readonly logger: Logger,
    private readonly eventPublisher?: EventPublisher,
  ) {
    this.phoneNumberId = config.phoneNumberId;
    this.wabaId = config.wabaId;
    this.appSecret = config.appSecret;
    this.verifyToken = config.verifyToken;
    this.eventInstanceId = config.instanceId ?? config.phoneNumberId;

    const axiosInstance = axios.create({
      baseURL: `https://graph.facebook.com/${config.apiVersion ?? 'v23.0'}`,
      timeout: config.timeout ?? 15_000,
      headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
    });

    this.http = new ProviderHttpClient({
      provider: this.name,
      axiosInstance,
      logger,
      throwOnError: config.throwOnError ?? true,
    });
  }

  // ==========================================================================
  // Conexão / instância — sem QR/ciclo de conexão real na Cloud API
  // ==========================================================================

  async connect(instanceId: string): Promise<ConnectResult> {
    const raw = await this.http.get<Record<string, unknown>>(`/${this.phoneNumberId}?fields=${PHONE_FIELDS}`);
    this.eventPublisher?.publish(InstanceConnected(this.name, instanceId));
    return { status: 'connected', raw };
  }

  async getQrCode(): Promise<ConnectResult> {
    throw new UnsupportedProviderOperationException(
      this.name,
      'getQrCode',
      'Cloud API não usa QR code — número é provisionado direto no Meta Business Manager/Embedded Signup.',
    );
  }

  async getPairingCode(): Promise<ConnectResult> {
    throw new UnsupportedProviderOperationException(
      this.name,
      'getPairingCode',
      'Cloud API não usa código de pareamento — número é provisionado direto no Meta Business Manager/Embedded Signup.',
    );
  }

  async disconnect(): Promise<void> {
    throw new UnsupportedProviderOperationException(
      this.name,
      'disconnect',
      'Números na Cloud API são gerenciados no Meta Business Manager; não existe endpoint para desconectar via API.',
    );
  }

  async getStatus(instanceId: string): Promise<InstanceStatus> {
    const raw = await this.http.get<Record<string, unknown>>(`/${this.phoneNumberId}?fields=${PHONE_FIELDS}`);
    return { instanceId, state: this.toConnectionState(raw['status']), raw };
  }

  /**
   * Inscreve o app na WABA (`subscribed_apps`) e, havendo `verifyToken`, aponta o webhook DESTE
   * número para `config.url` com o override de callback no nível do número
   * (`webhook_configuration`) — assim cada instância tem a sua URL sem mexer no callback global
   * do App Dashboard. A Meta chama `GET config.url?hub.mode=subscribe&hub.verify_token=…` ao
   * gravar, então a URL precisa estar acessível e a instância já salva (o handshake lê o token
   * dela). Sem `verifyToken` cai no comportamento antigo: só inscreve o app e avisa que a URL
   * de callback precisa ser configurada à mão no App Dashboard.
   */
  async setWebhook(_instanceId: string, config: WebhookConfig): Promise<void> {
    if (!this.wabaId) {
      throw new UnsupportedProviderOperationException(
        this.name,
        'setWebhook',
        'wabaId não configurado — necessário para inscrever o app na WABA via /subscribed_apps.',
      );
    }

    await this.http.post(`/${this.wabaId}/subscribed_apps`);

    if (!this.verifyToken) {
      this.logger.warn(
        'App inscrito na WABA, mas sem verifyToken não há override de callback: a URL de callback precisa ser configurada manualmente no App Dashboard da Meta.',
        { provider: this.name, url: config.url },
      );
      return;
    }

    await this.http.post(`/${this.phoneNumberId}`, {
      webhook_configuration: { override_callback_uri: config.url, verify_token: this.verifyToken },
    });
  }

  verifyWebhookSubscription(query: Record<string, string | undefined>): string | null {
    if (!this.verifyToken) return null;
    if (query['hub.mode'] !== 'subscribe') return null;

    const received = Buffer.from(query['hub.verify_token'] ?? '');
    const expected = Buffer.from(this.verifyToken);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;

    return query['hub.challenge'] ?? '';
  }

  async checkNumbers(): Promise<string[]> {
    throw new UnsupportedProviderOperationException(
      this.name,
      'checkNumbers',
      'Cloud API não expõe um endpoint público de validação em lote de números.',
    );
  }

  /**
   * Na Meta a mídia é buscada pelo `media_id` (vem em `MessageReceived.normalized.mediaId`), não
   * pelo id da mensagem como na Evolution — o parâmetro `messageId` da interface recebe esse
   * media_id. São dois passos: GET /{media_id} devolve uma URL que expira em 5 minutos, e o
   * download dessa URL exige o mesmo Bearer token.
   */
  async getMediaBase64(_instanceId: string, messageId: string): Promise<MediaResult> {
    const meta = await this.http.get<{ url?: string; mime_type?: string }>(
      `/${messageId}?phone_number_id=${this.phoneNumberId}`,
    );
    if (!meta?.url) {
      throw new Error(`[meta] resposta inesperada ao buscar a mídia "${messageId}": URL ausente.`);
    }

    const file = await this.http.getBinary(meta.url);
    return {
      base64: file.data.toString('base64'),
      mimetype: meta.mime_type ?? file.contentType ?? 'application/octet-stream',
      raw: meta,
    };
  }

  // ==========================================================================
  // Mensagens
  // ==========================================================================

  async sendText(_instanceId: string, to: string, text: string, options?: SendTextOptions): Promise<SendResult> {
    const raw = await this.sendMessage(
      to,
      'text',
      { body: text, ...(options?.previewUrl ? { preview_url: true } : {}) },
      options?.replyToMessageId ? { context: { message_id: options.replyToMessageId } } : {},
    );
    return this.toSendResult(raw);
  }

  async sendImage(_instanceId: string, to: string, mediaUrl: string, caption?: string): Promise<SendResult> {
    const raw = await this.sendMessage(to, 'image', { link: mediaUrl, caption });
    return this.toSendResult(raw);
  }

  async sendSticker(_instanceId: string, to: string, mediaUrl: string): Promise<SendResult> {
    const raw = await this.sendMessage(to, 'sticker', { link: mediaUrl });
    return this.toSendResult(raw);
  }

  async sendAudio(_instanceId: string, to: string, mediaUrl: string): Promise<SendResult> {
    const raw = await this.sendMessage(to, 'audio', { link: mediaUrl });
    return this.toSendResult(raw);
  }

  async sendVideo(_instanceId: string, to: string, mediaUrl: string, caption?: string): Promise<SendResult> {
    const raw = await this.sendMessage(to, 'video', { link: mediaUrl, caption });
    return this.toSendResult(raw);
  }

  async sendDocument(_instanceId: string, to: string, mediaUrl: string, fileName: string): Promise<SendResult> {
    const raw = await this.sendMessage(to, 'document', { link: mediaUrl, filename: fileName });
    return this.toSendResult(raw);
  }

  async sendLocation(
    _instanceId: string,
    to: string,
    latitude: number,
    longitude: number,
    name?: string,
    address?: string,
  ): Promise<SendResult> {
    const raw = await this.sendMessage(to, 'location', { latitude, longitude, name, address });
    return this.toSendResult(raw);
  }

  async sendReaction(_instanceId: string, to: string, messageId: string, emoji: string): Promise<SendResult> {
    const raw = await this.sendMessage(to, 'reaction', { message_id: messageId, emoji });
    return this.toSendResult(raw);
  }

  async createGroup(): Promise<CreateGroupResult> {
    throw new UnsupportedProviderOperationException(this.name, 'createGroup', 'Cloud API não tem conceito de grupos — é 1:1 ou template broadcast.');
  }

  async addGroupParticipants(): Promise<GroupParticipantResult[]> {
    throw new UnsupportedProviderOperationException(this.name, 'addGroupParticipants', 'Cloud API não tem conceito de grupos.');
  }

  async promoteGroupAdmins(): Promise<void> {
    throw new UnsupportedProviderOperationException(this.name, 'promoteGroupAdmins', 'Cloud API não tem conceito de grupos.');
  }

  async getGroupInviteCode(): Promise<GroupInviteCode> {
    throw new UnsupportedProviderOperationException(this.name, 'getGroupInviteCode', 'Cloud API não tem conceito de grupos.');
  }

  async sendButtons(_instanceId: string, to: string, content: ButtonsContent): Promise<SendResult> {
    // Um único botão `url` vira o interactive `cta_url` — é o único botão de link que a Cloud
    // API aceita fora de template.
    const [first] = content.buttons;
    if (content.buttons.length === 1 && first && 'type' in first && first.type === 'url') {
      return this.sendCtaUrl(to, content, first);
    }

    const parsed = this.validate(MetaButtonsContentSchema, { ...content, buttons: this.toReplyButtons(content) }, 'sendButtons');

    const raw = await this.sendMessage(to, 'interactive', {
      type: 'button',
      ...(parsed.title || parsed.imageUrl
        ? { header: parsed.imageUrl ? { type: 'image', image: { link: parsed.imageUrl } } : { type: 'text', text: parsed.title } }
        : {}),
      body: { text: parsed.body },
      ...(parsed.footer ? { footer: { text: parsed.footer } } : {}),
      action: {
        buttons: parsed.buttons.map((button) => ({ type: 'reply', reply: { id: button.id, title: button.displayText } })),
      },
    });
    return this.toSendResult(raw);
  }

  /** Só botões de resposta cabem em `interactive: button`; `reply` tipado sem id usa o texto como id. */
  private toReplyButtons(content: ButtonsContent): Array<{ id: string; displayText: string }> {
    return content.buttons.map((button) => {
      if (!('type' in button)) return button;
      if (button.type !== 'reply') {
        throw new Error(
          `[meta] botão do tipo "${button.type}" não cabe em sendButtons: a Cloud API só aceita botões de resposta, ou UM único botão url (vira CTA).`,
        );
      }
      return { id: button.id ?? button.displayText, displayText: button.displayText };
    });
  }

  private async sendCtaUrl(
    to: string,
    content: ButtonsContent,
    button: { type: 'url'; displayText: string; url: string },
  ): Promise<SendResult> {
    const parsed = this.validate(
      MetaCtaUrlContentSchema,
      {
        title: content.title,
        body: content.body,
        footer: content.footer,
        imageUrl: content.imageUrl,
        button: { displayText: button.displayText, url: button.url },
      },
      'sendButtons (cta_url)',
    );

    const raw = await this.sendMessage(to, 'interactive', {
      type: 'cta_url',
      ...(parsed.imageUrl
        ? { header: { type: 'image', image: { link: parsed.imageUrl } } }
        : parsed.title
          ? { header: { type: 'text', text: parsed.title } }
          : {}),
      body: { text: parsed.body },
      ...(parsed.footer ? { footer: { text: parsed.footer } } : {}),
      action: { name: 'cta_url', parameters: { display_text: parsed.button.displayText, url: parsed.button.url } },
    });
    return this.toSendResult(raw);
  }

  async sendList(_instanceId: string, to: string, content: ListContent): Promise<SendResult> {
    const parsed = this.validate(MetaListContentSchema, content, 'sendList');

    const raw = await this.sendMessage(to, 'interactive', {
      type: 'list',
      header: { type: 'text', text: parsed.title },
      body: { text: parsed.description },
      ...(parsed.footer ? { footer: { text: parsed.footer } } : {}),
      action: {
        button: parsed.buttonText,
        sections: parsed.sections.map((section) => ({
          title: section.title,
          rows: section.rows.map((row) => ({ id: row.rowId, title: row.title, description: row.description })),
        })),
      },
    });
    return this.toSendResult(raw);
  }

  /**
   * Carrossel interativo da Cloud API ("interactive media carousel messages"): mensagem de serviço,
   * sem template nem aprovação, só dentro da janela de 24h — como texto, botões e lista. Regras da
   * Meta, validadas aqui antes de chamar (ela recusa, não corta):
   *  - 2 a 10 cards; corpo principal obrigatório (até 1024 caracteres), sem cabeçalho/rodapé;
   *  - cada card tem imagem (por `link`; a Meta só renderiza JPEG/PNG de até 5 MB, não WebP);
   *  - texto do card opcional: até 160 caracteres e no máximo 2 quebras de linha;
   *  - botões: UM botão de link (url) OU um ou mais botões de resposta (até 20 caracteres, `id` até
   *    256) — e o tipo e a quantidade de botões têm de ser iguais em TODOS os cards;
   *  - o `id` do botão de resposta volta no clique, como nos botões comuns.
   * `providerOptions` (templateName/languageCode) não é usado: não é carrossel de template. Para
   * carrossel de template de Marketing use `sendTemplate` com `components`.
   */
  async sendCarousel(
    _instanceId: string,
    to: string,
    content: CarouselContent,
    _providerOptions?: CarouselProviderOptions,
  ): Promise<SendResult> {
    const { cards } = this.validateCarousel(content);

    const raw = await this.sendMessage(to, 'interactive', {
      type: 'carousel',
      body: { text: content.body },
      action: { cards },
    });
    return this.toSendResult(raw);
  }

  private validateCarousel(content: CarouselContent): { cards: Array<Record<string, unknown>> } {
    const fail = (reason: string): never => {
      throw new Error(`[meta] conteúdo inválido para sendCarousel: ${reason}`);
    };

    if (content.body.trim() === '' || [...content.body].length > 1024) {
      fail('o corpo principal é obrigatório e tem no máximo 1024 caracteres');
    }
    if (content.cards.length < 2 || content.cards.length > 10) {
      fail(`a Meta aceita de 2 a 10 cards (recebeu ${content.cards.length})`);
    }

    let layout: string | undefined;

    const cards = content.cards.map((card, index) => {
      const label = `card ${index + 1}`;

      if (!card.imageUrl) fail(`${label} sem imagem (todo card precisa de imagem ou vídeo)`);

      const body = card.body.trim();
      if ([...body].length > 160) fail(`${label}: texto com mais de 160 caracteres`);
      if (body.split('\n').length - 1 > 2) fail(`${label}: texto com mais de 2 quebras de linha`);

      const replies = card.buttons.filter((button) => !('type' in button) || button.type === 'reply');
      const links = card.buttons.filter((button) => 'type' in button && button.type !== 'reply');

      let action: Record<string, unknown>;
      let cardLayout: string;

      if (replies.length === 0 && links.length === 1 && links[0]!.type === 'url') {
        const link = links[0] as { displayText: string; url: string };
        if ([...link.displayText].length > 20) fail(`${label}: botão "${link.displayText}" com mais de 20 caracteres`);
        action = { name: 'cta_url', parameters: { display_text: link.displayText, url: link.url } };
        cardLayout = 'url';
      } else if (links.length === 0 && replies.length >= 1) {
        action = {
          buttons: replies.map((button) => {
            const reply = button as { id?: string; displayText: string };
            if ([...reply.displayText].length > 20) fail(`${label}: botão "${reply.displayText}" com mais de 20 caracteres`);
            const id = reply.id ?? reply.displayText;
            if (id.length > 256) fail(`${label}: id de botão com mais de 256 caracteres`);
            return { type: 'quick_reply', quick_reply: { id, title: reply.displayText } };
          }),
        };
        cardLayout = `reply:${replies.length}`;
      } else {
        return fail(`${label}: use UM botão de link OU botões de resposta (sem misturar, e ao menos um botão)`);
      }

      layout ??= cardLayout;
      if (cardLayout !== layout) {
        fail(`${label} tem botões diferentes dos outros cards (${cardLayout} ≠ ${layout}) — tipo e quantidade têm de ser iguais em todos`);
      }

      return {
        card_index: index,
        type: 'cta_url',
        header: { type: 'image', image: { link: card.imageUrl } },
        ...(body !== '' ? { body: { text: body } } : {}),
        action,
      };
    });

    return { cards };
  }

  // ==========================================================================
  // Templates (envio e gerenciamento) — exclusivos da Cloud API
  // ==========================================================================

  /**
   * Template aprovado — única forma de iniciar conversa ou responder fora da janela de 24h.
   * Os campos simples (`header`, `bodyParameters`, `buttons`) cobrem o caso comum; `components`
   * manda os componentes crus (carrossel com botões url, Flows, cupom...).
   */
  async sendTemplate(_instanceId: string, to: string, template: TemplateContent): Promise<SendResult> {
    const parsed = this.validate(MetaTemplateContentSchema, template, 'sendTemplate');
    const components = template.components ?? this.buildTemplateComponents(template);

    const raw = await this.http.post(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: parsed.name,
        language: { code: parsed.languageCode },
        ...(components.length > 0 ? { components } : {}),
      },
    });
    return this.toSendResult(raw);
  }

  private buildTemplateComponents(template: TemplateContent): Array<Record<string, unknown>> {
    const components: Array<Record<string, unknown>> = [];

    const { header } = template;
    if (header) {
      if (header.type === 'text') {
        components.push({ type: 'header', parameters: [{ type: 'text', text: header.text }] });
      } else {
        if (!header.url && !header.mediaId) {
          throw new Error(`[meta] header "${header.type}" do template precisa de "url" ou "mediaId".`);
        }
        const media = header.mediaId
          ? { id: header.mediaId }
          : { link: header.url, ...(header.type === 'document' && header.fileName ? { filename: header.fileName } : {}) };
        components.push({ type: 'header', parameters: [{ type: header.type, [header.type]: media }] });
      }
    }

    if (template.bodyParameters && template.bodyParameters.length > 0) {
      components.push({
        type: 'body',
        parameters: template.bodyParameters.map((text) => ({ type: 'text', text })),
      });
    }

    (template.buttons ?? []).forEach((button, position) => {
      components.push({
        type: 'button',
        sub_type: button.type,
        index: String(button.index ?? position),
        parameters:
          button.type === 'quick_reply'
            ? [{ type: 'payload', payload: button.payload }]
            : [{ type: 'text', text: button.urlSuffix }],
      });
    });

    return components;
  }

  private requireWaba(operation: string): string {
    if (!this.wabaId) {
      throw new UnsupportedProviderOperationException(
        this.name,
        operation,
        'wabaId não configurado — templates pertencem à conta WhatsApp Business (WABA), não ao número.',
      );
    }
    return this.wabaId;
  }

  async listTemplates(_instanceId: string, query: TemplateListQuery = {}): Promise<TemplateList> {
    const waba = this.requireWaba('listTemplates');
    const params = new URLSearchParams({
      fields: 'id,name,language,status,category,rejected_reason,components',
      limit: String(query.limit ?? 100),
    });
    if (query.name) params.set('name', query.name);
    if (query.status) params.set('status', query.status);
    if (query.after) params.set('after', query.after);

    const raw = await this.http.get<{
      data?: Array<Record<string, unknown>>;
      paging?: { cursors?: { after?: string }; next?: string };
    }>(`/${waba}/message_templates?${params.toString()}`);

    const data: TemplateInfo[] = (raw.data ?? []).map((item) => ({
      id: item['id'] as string | undefined,
      name: String(item['name']),
      language: String(item['language']),
      status: String(item['status']),
      category: item['category'] as string | undefined,
      rejectedReason: item['rejected_reason'] as string | undefined,
      components: item['components'] as unknown[] | undefined,
    }));
    return { data, ...(raw.paging?.next ? { next: raw.paging.cursors?.after } : {}) };
  }

  /**
   * Cria e envia para aprovação. Cabeçalho de imagem/vídeo (inclusive nos cards de carrossel)
   * exige `example.header_handle` — um handle da Resumable Upload API da Meta, que este
   * provider não gera; para carrossel com imagem é mais simples criar o template no WhatsApp
   * Manager e usar só `listTemplates`/`sendTemplate` por aqui.
   */
  async createTemplate(_instanceId: string, definition: TemplateDefinition): Promise<unknown> {
    const waba = this.requireWaba('createTemplate');
    return this.http.post(`/${waba}/message_templates`, definition);
  }

  /** Apaga todos os idiomas do template com esse nome. */
  async deleteTemplate(_instanceId: string, name: string): Promise<void> {
    const waba = this.requireWaba('deleteTemplate');
    await this.http.delete(`/${waba}/message_templates?name=${encodeURIComponent(name)}`);
  }

  /**
   * Marca como lida a mensagem recebida (e as anteriores da conversa). Com `typingIndicator`
   * mostra "digitando..." ao cliente até a próxima mensagem enviada — a Meta apaga sozinha em
   * 25s. Só vale para mensagens recebidas há menos de 30 dias.
   */
  async markAsRead(_instanceId: string, messageId: string, options?: MarkAsReadOptions): Promise<void> {
    await this.http.post(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      ...(options?.typingIndicator ? { typing_indicator: { type: 'text' } } : {}),
    });
  }

  // ==========================================================================
  // Coexistence — exclusivo da Cloud API, sem equivalente na CommunicationProvider
  // (Evolution/Z-API não têm esse conceito).
  // ==========================================================================

  async getPhoneNumberInfo(): Promise<PhoneNumberInfo> {
    const raw = await this.http.get<{ is_on_biz_app?: boolean; platform_type?: string }>(
      `/${this.phoneNumberId}?fields=is_on_biz_app,platform_type`,
    );
    return { isOnBizApp: raw.is_on_biz_app ?? false, platformType: raw.platform_type, raw };
  }

  async syncContacts(): Promise<void> {
    await this.http.post(`/${this.phoneNumberId}/smb_app_data`, {
      messaging_product: 'whatsapp',
      sync_type: 'smb_app_state_sync',
    });
  }

  async syncHistory(): Promise<void> {
    await this.http.post(`/${this.phoneNumberId}/smb_app_data`, {
      messaging_product: 'whatsapp',
      sync_type: 'history',
    });
  }

  // ==========================================================================
  // Webhook inbound
  // ==========================================================================

  /**
   * Normaliza o payload de webhook da Cloud API (`entry[].changes[]`). Valida a assinatura
   * X-Hub-Signature-256 primeiro (se `appSecret` estiver configurado) — requisito real de
   * segurança da Meta, não best-effort.
   *
   * Cobre: mensagens recebidas (com `normalized`), statuses sent/delivered/read/failed (com
   * janela de 24h e preço quando a Meta manda), status de template, qualidade do número,
   * atualização de conta e os 3 eventos exclusivos de Coexistence.
   */
  parseWebhookPayload(rawBody: Buffer, headers: Record<string, string>): DomainEvent[] {
    this.verifySignature(rawBody, headers);

    const body = JSON.parse(rawBody.toString('utf8')) as {
      entry?: Array<{ changes?: Array<{ field?: string; value?: Record<string, unknown> }> }>;
    };
    const instanceId = this.eventInstanceId;
    const events: DomainEvent[] = [];

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};

        // O app da Meta tem um callback para todos os números; se este chegou aqui com o
        // webhook de outro número, não é desta instância.
        const targetPhoneId = (value['metadata'] as { phone_number_id?: string } | undefined)?.phone_number_id;
        if (targetPhoneId && targetPhoneId !== this.phoneNumberId) {
          this.logger.debug('Webhook da Meta de outro número ignorado', {
            provider: this.name,
            instanceId,
            phoneNumberId: targetPhoneId,
          });
          continue;
        }

        switch (change.field) {
          case 'messages': {
            const profileNames = this.indexProfileNames(value['contacts']);
            for (const message of (value['messages'] as Array<Record<string, unknown>> | undefined) ?? []) {
              const from = String(message['from']);
              events.push(
                MessageReceived(this.name, instanceId, {
                  from,
                  messageId: String(message['id']),
                  content: message,
                  normalized: this.normalizeInbound(message, profileNames.get(from)),
                }),
              );
            }
            for (const status of (value['statuses'] as Array<Record<string, unknown>> | undefined) ?? []) {
              const event = this.statusToEvent(instanceId, status);
              if (event) events.push(event);
            }
            break;
          }
          case 'message_template_status_update':
            events.push(
              TemplateStatusUpdated(this.name, instanceId, {
                templateId: value['message_template_id'] === undefined ? undefined : String(value['message_template_id']),
                templateName: value['message_template_name'] as string | undefined,
                language: value['message_template_language'] as string | undefined,
                status: String(value['event']),
                reason: value['reason'] as string | undefined,
              }),
            );
            break;
          case 'phone_number_quality_update':
            events.push(
              PhoneNumberQualityUpdated(this.name, instanceId, {
                displayPhoneNumber: value['display_phone_number'] as string | undefined,
                event: value['event'] as string | undefined,
                currentLimit: value['current_limit'] as string | undefined,
              }),
            );
            break;
          case 'account_update':
            events.push(AccountUpdated(this.name, instanceId, value));
            break;
          case 'history':
            events.push(CoexistenceHistorySync(this.name, instanceId, value));
            break;
          case 'smb_app_state_sync':
            events.push(CoexistenceContactSync(this.name, instanceId, value));
            break;
          case 'smb_message_echoes':
            events.push(CoexistenceMessageEcho(this.name, instanceId, value));
            break;
          default:
            break;
        }
      }
    }

    return events;
  }

  /** Tipos de mensagem recebida conhecidos que não ganham campo próprio em `normalized`. */
  private static readonly KNOWN_PASSIVE_MESSAGE_TYPES = new Set(['contacts', 'order', 'system', 'unsupported', 'request_welcome', 'ephemeral']);

  /** Mensagem crua para log, limitada para não estourar a linha de log. */
  private rawForLog(message: Record<string, unknown>): string {
    const json = JSON.stringify(message);
    return json.length > 2000 ? `${json.slice(0, 2000)}…` : json;
  }

  private indexProfileNames(contacts: unknown): Map<string, string> {
    const names = new Map<string, string>();
    for (const contact of (contacts as Array<{ wa_id?: string; profile?: { name?: string } }> | undefined) ?? []) {
      if (contact.wa_id && contact.profile?.name) names.set(contact.wa_id, contact.profile.name);
    }
    return names;
  }

  private normalizeInbound(message: Record<string, unknown>, profileName: string | undefined): NormalizedInboundMessage {
    const type = String(message['type'] ?? 'unknown');
    const normalized: NormalizedInboundMessage = { type };

    if (profileName) normalized.profileName = profileName;
    if (message['timestamp'] !== undefined) normalized.timestamp = Number(message['timestamp']);
    const replyTo = (message['context'] as { id?: string } | undefined)?.id;
    if (replyTo) normalized.replyToMessageId = replyTo;

    const section = (message[type] ?? {}) as Record<string, unknown>;

    switch (type) {
      case 'text':
        normalized.text = section['body'] as string | undefined;
        break;
      case 'interactive': {
        const interactive = section as {
          type?: string;
          button_reply?: { id?: string; title?: string };
          list_reply?: { id?: string; title?: string };
          nfm_reply?: { response_json?: string };
        };
        if (interactive.button_reply) {
          normalized.buttonReplyId = interactive.button_reply.id;
          normalized.buttonReplyTitle = interactive.button_reply.title;
        } else if (interactive.list_reply) {
          normalized.listReplyId = interactive.list_reply.id;
          normalized.listReplyTitle = interactive.list_reply.title;
        } else if (interactive.nfm_reply) {
          normalized.flowResponseJson = interactive.nfm_reply.response_json;
        } else {
          // Formato de toque que não conhecemos (ex.: botão de carrossel, se a Meta mandar diferente
          // de button_reply): sem este aviso o clique sumiria em silêncio.
          this.logger.warn('Meta: mensagem interativa recebida em formato desconhecido', {
            provider: this.name,
            instanceId: this.eventInstanceId,
            interactiveType: interactive.type,
            keys: Object.keys(section),
            raw: this.rawForLog(message),
          });
        }
        break;
      }
      // Clique em botão quick_reply de TEMPLATE chega como type "button" (documentado pela Meta),
      // não "interactive". O quick_reply do CARROSSEL interativo provavelmente chega igual — a
      // referência oficial do webhook não o cita, só fontes de terceiros —, então é tratado do
      // mesmo jeito e o payload bruto fica no log para confirmar com o primeiro clique real.
      case 'button':
        normalized.buttonReplyId = section['payload'] as string | undefined;
        normalized.buttonReplyTitle = section['text'] as string | undefined;
        this.logger.info('Meta: toque em botão (type "button") — payload bruto', {
          provider: this.name,
          instanceId: this.eventInstanceId,
          raw: this.rawForLog(message),
        });
        break;
      case 'image':
      case 'video':
      case 'audio':
      case 'document':
      case 'sticker':
        normalized.mediaId = section['id'] as string | undefined;
        normalized.mimeType = section['mime_type'] as string | undefined;
        normalized.caption = section['caption'] as string | undefined;
        normalized.fileName = section['filename'] as string | undefined;
        if (type === 'audio') normalized.isVoiceNote = section['voice'] === true;
        break;
      case 'location':
        normalized.location = {
          latitude: Number(section['latitude']),
          longitude: Number(section['longitude']),
          ...(section['name'] ? { name: String(section['name']) } : {}),
          ...(section['address'] ? { address: String(section['address']) } : {}),
        };
        break;
      case 'reaction':
        normalized.reaction = { messageId: String(section['message_id']), emoji: String(section['emoji'] ?? '') };
        break;
      default:
        // Tipos que a Cloud API documenta e que não precisam de tratamento específico ficam em
        // silêncio; qualquer outro é um formato novo (ou um toque que não reconhecemos) e não pode
        // sumir sem rastro.
        if (!MetaCloudApiProvider.KNOWN_PASSIVE_MESSAGE_TYPES.has(type)) {
          this.logger.warn('Meta: mensagem recebida com tipo desconhecido', {
            provider: this.name,
            instanceId: this.eventInstanceId,
            messageType: type,
            raw: this.rawForLog(message),
          });
        }
        break;
    }

    for (const key of Object.keys(normalized) as Array<keyof NormalizedInboundMessage>) {
      if (normalized[key] === undefined) delete normalized[key];
    }
    return normalized;
  }

  private statusToEvent(instanceId: string, status: Record<string, unknown>): DomainEvent | undefined {
    const messageId = String(status['id']);
    const to = status['recipient_id'] === undefined ? undefined : String(status['recipient_id']);

    const conversationRaw = status['conversation'] as
      | { id?: string; expiration_timestamp?: string | number; origin?: { type?: string } }
      | undefined;
    const conversation: MessageConversation | undefined = conversationRaw && {
      id: conversationRaw.id,
      expirationTimestamp:
        conversationRaw.expiration_timestamp === undefined ? undefined : Number(conversationRaw.expiration_timestamp),
      originType: conversationRaw.origin?.type,
    };
    const pricingRaw = status['pricing'] as { billable?: boolean; pricing_model?: string; category?: string } | undefined;
    const pricing: MessagePricing | undefined = pricingRaw && {
      billable: pricingRaw.billable,
      pricingModel: pricingRaw.pricing_model,
      category: pricingRaw.category,
    };

    switch (status['status']) {
      case 'sent':
        return MessageSent(this.name, instanceId, { to: to ?? '', messageId, conversation, pricing });
      case 'delivered':
        return MessageDelivered(this.name, instanceId, { messageId, to, conversation, pricing });
      case 'read':
        return MessageRead(this.name, instanceId, { messageId, to, conversation, pricing });
      case 'failed': {
        const errors: ProviderError[] = ((status['errors'] as Array<Record<string, unknown>> | undefined) ?? []).map(
          (error) => ({
            code: error['code'] === undefined ? undefined : Number(error['code']),
            title: error['title'] as string | undefined,
            message: error['message'] as string | undefined,
            details: (error['error_data'] as { details?: string } | undefined)?.details,
          }),
        );
        return MessageFailed(this.name, instanceId, {
          messageId,
          to,
          errors,
          customerServiceWindowClosed: errors.some((error) => error.code === ERROR_CODE_WINDOW_CLOSED),
        });
      }
      default:
        return undefined;
    }
  }

  /**
   * Sem `appSecret` configurado, não valida (não bloqueia quem ainda não configurou, mas avisa —
   * qualquer um que descubra a URL do webhook pode forjar eventos).
   */
  private verifySignature(rawBody: Buffer, headers: Record<string, string>): void {
    if (!this.appSecret) {
      if (!this.warnedMissingAppSecret) {
        this.warnedMissingAppSecret = true;
        this.logger.warn(
          'Meta: appSecret não configurado — webhooks recebidos NÃO estão sendo validados (X-Hub-Signature-256). Defina WHATSAPP_CLOUD_APP_SECRET ou credentials.appSecret.',
          { provider: this.name, instanceId: this.eventInstanceId },
        );
      }
      return;
    }

    const signatureHeader = headers['x-hub-signature-256'];
    if (!signatureHeader) {
      throw new Error('Webhook da Meta sem header X-Hub-Signature-256.');
    }

    const expected = `sha256=${createHmac('sha256', this.appSecret).update(rawBody).digest('hex')}`;
    const received = Buffer.from(signatureHeader);
    const expectedBuffer = Buffer.from(expected);

    if (received.length !== expectedBuffer.length || !timingSafeEqual(received, expectedBuffer)) {
      throw new Error('Assinatura X-Hub-Signature-256 inválida.');
    }
  }

  // ==========================================================================

  private async sendMessage(
    to: string,
    type: string,
    content: unknown,
    extra: Record<string, unknown> = {},
  ): Promise<unknown> {
    try {
      return await this.http.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type,
        ...extra,
        [type]: content,
      });
    } catch (err) {
      throw this.translateSendError(err, to);
    }
  }

  /** 131047 vira uma exceção própria — quem chama precisa reagir (cair para template), não só logar 502. */
  private translateSendError(err: unknown, to: string): unknown {
    if (err instanceof ProviderApiException) {
      const code = (err.responseBody as { error?: { code?: number } } | null)?.error?.code;
      if (code === ERROR_CODE_WINDOW_CLOSED) return new CustomerServiceWindowClosedException(this.name, to, code);
    }
    return err;
  }

  /**
   * `status` do número na Graph API → estado de conexão. CONNECTED e FLAGGED enviam normalmente;
   * PENDING/UNVERIFIED ainda não terminaram o cadastro; o resto (DISCONNECTED, BANNED, DELETED,
   * RESTRICTED, MIGRATED...) não está apto a enviar. Sem o campo, mantém o comportamento antigo (open).
   */
  private toConnectionState(status: unknown): InstanceStatus['state'] {
    if (typeof status !== 'string') return 'open';
    if (status === 'CONNECTED' || status === 'FLAGGED') return 'open';
    if (status === 'PENDING' || status === 'UNVERIFIED') return 'connecting';
    return 'close';
  }

  private validate<T extends z.ZodTypeAny>(schema: T, content: unknown, operation: string): z.infer<T> {
    const result = schema.safeParse(content);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => issue.message).join('; ');
      throw new Error(`[meta] conteúdo inválido para ${operation}: ${issues}`);
    }
    return result.data;
  }

  private toSendResult(raw: unknown): SendResult {
    const messageId = (raw as { messages?: Array<{ id?: string }> } | undefined)?.messages?.[0]?.id;
    return { messageId, raw };
  }
}
