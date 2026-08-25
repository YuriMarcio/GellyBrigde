import axios from 'axios';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  ButtonsContent,
  CarouselContent,
  CarouselProviderOptions,
  CommunicationProvider,
  ConnectResult,
  InstanceStatus,
  ListContent,
  SendResult,
  MediaResult,
  SendTextOptions,
  WebhookConfig,
} from '../../core/interfaces/CommunicationProvider.js';
import type { EventPublisher } from '../../core/interfaces/EventPublisher.js';
import type { Logger } from '../../core/interfaces/Logger.js';
import { UnsupportedProviderOperationException } from '../../core/exceptions/UnsupportedProviderOperationException.js';
import { InstanceConnected, MessageDelivered, MessageRead, MessageReceived, type DomainEvent } from '../../core/events/index.js';
import { ProviderHttpClient } from '../../infrastructure/http/ProviderHttpClient.js';
import type { MetaProviderConfig } from '../../contracts/dto/index.js';
import {
  MetaButtonsContentSchema,
  MetaCarouselProviderOptionsSchema,
  MetaListContentSchema,
} from '../../contracts/schemas/meta.js';

/**
 * Adapter da Meta Cloud API (WhatsApp Business Platform). Diferente da Evolution/Z-API, aqui
 * não existe conceito de instância/QR code — o número é provisionado fora da API (Meta
 * Business Manager / Embedded Signup) e fica fixo por client (config.phoneNumberId).
 * `instanceId` é aceito nos métodos só para respeitar a interface CommunicationProvider (e
 * aparece nos eventos/logs), mas não influencia qual número é usado.
 */
export class MetaCloudApiProvider implements CommunicationProvider {
  readonly name = 'meta' as const;
  private readonly http: ProviderHttpClient;
  private readonly phoneNumberId: string;
  private readonly wabaId: string | undefined;
  private readonly appSecret: string | undefined;

  constructor(
    config: MetaProviderConfig,
    private readonly logger: Logger,
    private readonly eventPublisher?: EventPublisher,
  ) {
    this.phoneNumberId = config.phoneNumberId;
    this.wabaId = config.wabaId;
    this.appSecret = config.appSecret;

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
    const raw = await this.http.get<Record<string, unknown>>(
      `/${this.phoneNumberId}?fields=verified_name,code_verification_status,quality_rating`,
    );
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

  async disconnect(): Promise<void> {
    throw new UnsupportedProviderOperationException(
      this.name,
      'disconnect',
      'Números na Cloud API são gerenciados no Meta Business Manager; não existe endpoint para desconectar via API.',
    );
  }

  async getStatus(instanceId: string): Promise<InstanceStatus> {
    const raw = await this.http.get<Record<string, unknown>>(
      `/${this.phoneNumberId}?fields=verified_name,code_verification_status,quality_rating`,
    );
    return { instanceId, state: 'open', raw };
  }

  /**
   * Só é possível inscrever o app atual na WABA (`subscribed_apps`) — a URL de callback em
   * si só pode ser configurada manualmente no App Dashboard da Meta, não existe chamada de
   * API para isso. Se `config` pedir os eventos exclusivos de Coexistence (`history`,
   * `smb_app_state_sync`, `smb_message_echoes`), essas chaves também precisam ser marcadas
   * manualmente no App Dashboard.
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
    this.logger.warn(
      'App inscrito na WABA, mas a URL de callback ainda precisa ser configurada manualmente no App Dashboard da Meta (não existe chamada de API para isso).',
      { provider: this.name, url: config.url },
    );
  }

  async checkNumbers(): Promise<string[]> {
    throw new UnsupportedProviderOperationException(
      this.name,
      'checkNumbers',
      'Cloud API não expõe um endpoint público de validação em lote de números.',
    );
  }

  async getMediaBase64(): Promise<MediaResult> {
    throw new UnsupportedProviderOperationException(
      this.name,
      'getMediaBase64',
      'Ainda não implementado para Meta Cloud API — usa media_id + /media, fluxo diferente do Baileys.',
    );
  }

  // ==========================================================================
  // Mensagens
  // ==========================================================================

  async sendText(_instanceId: string, to: string, text: string, _options?: SendTextOptions): Promise<SendResult> {
    const raw = await this.sendMessage(to, 'text', { body: text });
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

  async sendButtons(_instanceId: string, to: string, content: ButtonsContent): Promise<SendResult> {
    const parsed = this.validate(MetaButtonsContentSchema, content, 'sendButtons');

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
   * Diferente da Evolution/Z-API (carrossel freeform), na Cloud API o carrossel só existe
   * como template pré-aprovado — exige providerOptions.templateName + languageCode. O
   * mapeamento de cards para components é best-effort: a estrutura real de parâmetros por
   * card precisa bater exatamente com o que foi declarado ao criar o template na Meta.
   */
  async sendCarousel(
    _instanceId: string,
    to: string,
    content: CarouselContent,
    providerOptions?: CarouselProviderOptions,
  ): Promise<SendResult> {
    const parsedOptions = MetaCarouselProviderOptionsSchema.safeParse(providerOptions ?? {});
    if (!parsedOptions.success) {
      throw new UnsupportedProviderOperationException(
        this.name,
        'sendCarousel',
        'Cloud API exige um template de carrossel pré-aprovado — informe providerOptions.templateName e languageCode.',
      );
    }

    const raw = await this.http.post(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: parsedOptions.data.templateName,
        language: { code: parsedOptions.data.languageCode },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: content.body }] },
          {
            type: 'carousel',
            cards: content.cards.map((card, index) => ({
              card_index: index,
              components: [
                ...(card.imageUrl ? [{ type: 'header', parameters: [{ type: 'image', image: { link: card.imageUrl } }] }] : []),
                { type: 'body', parameters: [{ type: 'text', text: card.body }] },
                // Templates de carrossel da Meta só suportam quick_reply pré-aprovado — botões
                // url/call/copy do card (que a Evolution aceita) não têm equivalente aqui e são
                // ignorados nesse componente.
                ...(card.buttons[0]?.type === 'reply'
                  ? [
                      {
                        type: 'button',
                        sub_type: 'quick_reply',
                        index: '0',
                        parameters: [{ type: 'payload', payload: card.buttons[0].id ?? card.buttons[0].displayText }],
                      },
                    ]
                  : []),
              ],
            })),
          },
        ],
      },
    });
    return this.toSendResult(raw);
  }

  // ==========================================================================
  // Coexistence — exclusivo da Cloud API, sem equivalente na CommunicationProvider
  // (Evolution/Z-API não têm esse conceito).
  // ==========================================================================

  async getPhoneNumberInfo(): Promise<{ isOnBizApp: boolean; platformType: string | undefined; raw: unknown }> {
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
   * segurança da Meta, não best-effort. Reconhece tanto mensagens/status normais quanto os
   * 3 eventos exclusivos de Coexistence (history, smb_app_state_sync, smb_message_echoes).
   */
  parseWebhookPayload(rawBody: Buffer, headers: Record<string, string>): DomainEvent[] {
    this.verifySignature(rawBody, headers);

    const body = JSON.parse(rawBody.toString('utf8')) as {
      entry?: Array<{ changes?: Array<{ field?: string; value?: Record<string, unknown> }> }>;
    };
    const instanceId = this.phoneNumberId;
    const events: DomainEvent[] = [];

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};

        switch (change.field) {
          case 'messages': {
            for (const message of (value['messages'] as Array<Record<string, unknown>> | undefined) ?? []) {
              events.push(
                MessageReceived(this.name, instanceId, {
                  from: String(message['from']),
                  messageId: String(message['id']),
                  content: message,
                }),
              );
            }
            for (const status of (value['statuses'] as Array<Record<string, unknown>> | undefined) ?? []) {
              const messageId = String(status['id']);
              if (status['status'] === 'read') events.push(MessageRead(this.name, instanceId, { messageId }));
              else if (status['status'] === 'delivered') events.push(MessageDelivered(this.name, instanceId, { messageId }));
            }
            break;
          }
          case 'history':
            events.push({ type: 'CoexistenceHistorySync', occurredAt: new Date(), provider: this.name, instanceId, payload: value });
            break;
          case 'smb_app_state_sync':
            events.push({ type: 'CoexistenceContactSync', occurredAt: new Date(), provider: this.name, instanceId, payload: value });
            break;
          case 'smb_message_echoes':
            events.push({ type: 'CoexistenceMessageEcho', occurredAt: new Date(), provider: this.name, instanceId, payload: value });
            break;
          default:
            break;
        }
      }
    }

    return events;
  }

  /**
   * Sem `appSecret` configurado, não valida (comportamento documentado — não bloqueia quem
   * ainda não configurou, mas também não finge segurança que não existe).
   */
  private verifySignature(rawBody: Buffer, headers: Record<string, string>): void {
    if (!this.appSecret) return;

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

  private async sendMessage(to: string, type: string, content: unknown): Promise<unknown> {
    return this.http.post(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type,
      [type]: content,
    });
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
