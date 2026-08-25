import axios from 'axios';
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
import { PhoneNumber } from '../../core/value-objects/PhoneNumber.js';
import { UnsupportedProviderOperationException } from '../../core/exceptions/UnsupportedProviderOperationException.js';
import {
  ConnectionLost,
  InstanceConnected,
  InstanceDisconnected,
  MessageDelivered,
  MessageRead,
  MessageReceived,
  QRCodeGenerated,
  type DomainEvent,
} from '../../core/events/index.js';
import { ProviderHttpClient } from '../../infrastructure/http/ProviderHttpClient.js';
import type { ZApiProviderConfig } from '../../contracts/dto/index.js';

/**
 * Adapter da Z-API (developer.z-api.io). Os paths abaixo foram confirmados individualmente
 * na documentação (send-button-list, send-carousel, contacts/get-iswhatsapp-batch,
 * instance/status, instance/disconnect, update-webhook-received-delivery); send-image,
 * send-audio, send-video, send-document, send-sticker e send-reaction seguem a mesma
 * convenção de nomes da Z-API mas não foram confirmados com um payload de exemplo — validar
 * contra uma instância real antes de depender deles em produção.
 */
export class ZApiProvider implements CommunicationProvider {
  readonly name = 'zapi' as const;
  private readonly http: ProviderHttpClient;

  constructor(
    config: ZApiProviderConfig,
    private readonly logger: Logger,
    private readonly eventPublisher?: EventPublisher,
  ) {
    const axiosInstance = axios.create({
      baseURL: `https://api.z-api.io/instances/${config.instanceId}/token/${config.token}`,
      timeout: config.timeout ?? 15_000,
      headers: {
        'Content-Type': 'application/json',
        ...(config.clientToken ? { 'Client-Token': config.clientToken } : {}),
      },
    });

    this.http = new ProviderHttpClient({
      provider: this.name,
      axiosInstance,
      logger,
      throwOnError: config.throwOnError ?? true,
    });
  }

  // ==========================================================================
  // Conexão / instância
  // ==========================================================================

  async connect(instanceId: string): Promise<ConnectResult> {
    return this.fetchQrCode(instanceId);
  }

  // Já é só um GET idempotente — não existe "criar instância" separado na Z-API, então
  // connect() e getQrCode() fazem exatamente a mesma coisa, sem risco de recriar nada.
  async getQrCode(instanceId: string): Promise<ConnectResult> {
    return this.fetchQrCode(instanceId);
  }

  private async fetchQrCode(instanceId: string): Promise<ConnectResult> {
    const raw = await this.http.get<Record<string, unknown>>('/instance/qrcode');
    const qrCode = (raw['value'] as string | undefined) ?? (raw['qrcode'] as string | undefined);

    if (qrCode) {
      this.eventPublisher?.publish(QRCodeGenerated(this.name, instanceId, { qrCode }));
    }

    return { status: qrCode ? 'qr_required' : 'connecting', qrCode, raw };
  }

  async disconnect(instanceId: string): Promise<void> {
    await this.http.post('/instance/disconnect');
    this.eventPublisher?.publish(InstanceDisconnected(this.name, instanceId));
  }

  async getStatus(instanceId: string): Promise<InstanceStatus> {
    const raw = await this.http.get<{ connected?: boolean }>('/instance/status');
    const state = raw.connected ? 'open' : 'close';

    if (state === 'open') {
      this.eventPublisher?.publish(InstanceConnected(this.name, instanceId));
    }

    return { instanceId, state, raw };
  }

  async setWebhook(_instanceId: string, config: WebhookConfig): Promise<void> {
    await this.http.put('/update-webhook-received-delivery', { value: config.url });
  }

  async checkNumbers(_instanceId: string, numbers: string[]): Promise<string[]> {
    if (numbers.length === 0) return [];

    const results = await this.http.post<Array<{ exists: boolean; outputPhone: string }>>(
      '/contacts/get-iswhatsapp-batch',
      { phones: numbers },
    );

    if (!Array.isArray(results)) {
      this.logger.warn('checkNumbers: resposta inesperada', { provider: this.name });
      return [];
    }

    return results.filter((item) => item.exists === true).map((item) => PhoneNumber.create(item.outputPhone).toString());
  }

  async getMediaBase64(): Promise<MediaResult> {
    throw new UnsupportedProviderOperationException(
      this.name,
      'getMediaBase64',
      'Ainda não implementado para Z-API — precisa mapear o endpoint de mídia decriptada específico dela.',
    );
  }

  // ==========================================================================
  // Mensagens
  // ==========================================================================

  async sendText(_instanceId: string, to: string, text: string, options?: SendTextOptions): Promise<SendResult> {
    const raw = await this.http.post('/send-text', {
      phone: to,
      message: text,
      delayMessage: options?.delayMs ? Math.ceil(options.delayMs / 1000) : undefined,
    });
    return this.toSendResult(raw);
  }

  async sendImage(_instanceId: string, to: string, mediaUrl: string, caption = ''): Promise<SendResult> {
    const raw = await this.http.post('/send-image', { phone: to, image: mediaUrl, caption });
    return this.toSendResult(raw);
  }

  async sendSticker(_instanceId: string, to: string, mediaUrl: string): Promise<SendResult> {
    const raw = await this.http.post('/send-sticker', { phone: to, sticker: mediaUrl });
    return this.toSendResult(raw);
  }

  async sendAudio(_instanceId: string, to: string, mediaUrl: string): Promise<SendResult> {
    const raw = await this.http.post('/send-audio', { phone: to, audio: mediaUrl });
    return this.toSendResult(raw);
  }

  async sendVideo(_instanceId: string, to: string, mediaUrl: string, caption = ''): Promise<SendResult> {
    const raw = await this.http.post('/send-video', { phone: to, video: mediaUrl, caption });
    return this.toSendResult(raw);
  }

  async sendDocument(_instanceId: string, to: string, mediaUrl: string, fileName: string): Promise<SendResult> {
    const extension = fileName.includes('.') ? fileName.split('.').pop() : 'pdf';
    const raw = await this.http.post(`/send-document/${extension}`, { phone: to, document: mediaUrl, fileName });
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
    const raw = await this.http.post('/send-location', { phone: to, latitude, longitude, title: name, address });
    return this.toSendResult(raw);
  }

  async sendButtons(_instanceId: string, to: string, content: ButtonsContent): Promise<SendResult> {
    const raw = await this.http.post('/send-button-list', {
      phone: to,
      message: content.body,
      buttonList: {
        // Z-API (/send-button-list) só suporta botões de resposta — url/call/copy degradam
        // pra reply com o mesmo texto (id ausente deixa a Z-API gerar um).
        buttons: content.buttons.map((button) => ({
          label: button.displayText,
          id: 'id' in button ? button.id : undefined,
        })),
      },
    });
    return this.toSendResult(raw);
  }

  async sendList(_instanceId: string, to: string, content: ListContent): Promise<SendResult> {
    // Z-API não tem o conceito de seções — achata ListSection[] numa lista única de opções.
    const options = content.sections.flatMap((section) =>
      section.rows.map((row) => ({ id: row.rowId, title: row.title, description: row.description })),
    );

    const raw = await this.http.post('/send-option-list', {
      phone: to,
      message: content.description,
      optionList: { title: content.title, buttonLabel: content.buttonText, options },
    });
    return this.toSendResult(raw);
  }

  async sendCarousel(
    _instanceId: string,
    to: string,
    content: CarouselContent,
    _providerOptions?: CarouselProviderOptions,
  ): Promise<SendResult> {
    const raw = await this.http.post('/send-carousel', {
      phone: to,
      message: content.body,
      carousel: content.cards.map((card) => ({
        text: card.body,
        image: card.imageUrl,
        // Payload não verificado contra documentação real da Z-API (ao contrário do fix da
        // Evolution, confirmado com o schema real) — mantém compatibilidade com o formato REPLY
        // anterior e faz o melhor esforço pros demais tipos, mas vale validar contra uma
        // instância real antes de depender em produção.
        buttons: card.buttons.map((button) => {
          switch (button.type) {
            case 'reply':
              return { type: 'REPLY', label: button.displayText, id: button.id };
            case 'url':
              return { type: 'URL', label: button.displayText, url: button.url };
            case 'call':
              return { type: 'CALL', label: button.displayText, phone: button.phoneNumber };
            case 'copy':
              return { type: 'COPY', label: button.displayText, copyCode: button.copyCode };
          }
        }),
      })),
    });
    return this.toSendResult(raw);
  }

  async sendReaction(_instanceId: string, to: string, messageId: string, emoji: string): Promise<SendResult> {
    const raw = await this.http.post('/send-reaction', { phone: to, messageId, reaction: emoji });
    return this.toSendResult(raw);
  }

  private toSendResult(raw: unknown): SendResult {
    const messageId = (raw as { messageId?: string } | undefined)?.messageId;
    return { messageId, raw };
  }

  // ==========================================================================
  // Webhook inbound
  // ==========================================================================

  /**
   * Normaliza os webhooks da Z-API. Formato varia por tipo de evento (mensagem recebida,
   * status de entrega, conexão) — mapeamento best-effort a partir da documentação; validar
   * contra uma instância real antes de depender em produção.
   */
  parseWebhookPayload(rawBody: Buffer, _headers: Record<string, string>): DomainEvent[] {
    const body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    const instanceId = (body['instanceId'] as string | undefined) ?? 'unknown';

    if (typeof body['status'] === 'string') {
      const status = (body['status'] as string).toUpperCase();
      const messageId = (body['ids'] as string[] | undefined)?.[0] ?? (body['messageId'] as string | undefined) ?? '';
      if (status === 'READ') return [MessageRead(this.name, instanceId, { messageId })];
      if (status === 'RECEIVED' || status === 'DELIVERED') return [MessageDelivered(this.name, instanceId, { messageId })];
      return [];
    }

    if (typeof body['phone'] === 'string' && (body['text'] || body['image'] || body['audio'] || body['document'])) {
      return [
        MessageReceived(this.name, instanceId, {
          from: PhoneNumber.create(String(body['phone'])).toString(),
          messageId: String(body['messageId'] ?? ''),
          content: body,
        }),
      ];
    }

    if (body['connected'] === true) return [InstanceConnected(this.name, instanceId)];
    if (body['connected'] === false) return [ConnectionLost(this.name, instanceId, { reason: 'webhook: connected=false' })];

    return [];
  }
}
