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
import type { EvolutionProviderConfig } from '../../contracts/dto/index.js';

export class EvolutionProvider implements CommunicationProvider {
  readonly name = 'evolution' as const;
  private readonly http: ProviderHttpClient;

  constructor(
    config: EvolutionProviderConfig,
    private readonly logger: Logger,
    private readonly eventPublisher?: EventPublisher,
  ) {
    const axiosInstance = axios.create({
      baseURL: config.baseUrl.replace(/\/$/, ''),
      timeout: config.timeout ?? 15_000,
      headers: { apikey: config.apiKey, 'Content-Type': 'application/json' },
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
    await this.http.post('/instance/create', {
      instanceName: instanceId,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    });

    return this.fetchQrCode(instanceId);
  }

  /**
   * Sem `/instance/create` — a instância já existe. Chamar `connect()` de novo pra pegar um
   * QR fresco arriscaria um erro de "instância já existe" no create.
   *
   * Antes de mexer em qualquer coisa, checa o estado atual: se a instância já está `open`,
   * retorna conectado sem deslogar — deslogar uma sessão que já funciona derrubaria um WhatsApp
   * ativo à toa. Só quando ela NÃO está aberta é que faz logout antes de buscar o QR: reconectar
   * sem isso arrisca a Evolution reaproveitar credenciais Baileys de uma tentativa de pareamento
   * anterior que falhou/expirou, o que na prática trava em "connecting" e o WhatsApp recusa o
   * pareamento (mesmo com um QR visualmente válido). Logout limpa esse estado sem apagar a
   * instância nem o histórico — best-effort, ignora erro (ex.: instância que nunca chegou a
   * conectar não tem o que deslogar).
   */
  async getQrCode(instanceId: string): Promise<ConnectResult> {
    const currentStatus = await this.getStatus(instanceId).catch(() => null);
    if (currentStatus?.state === 'open') {
      return { status: 'connected', raw: currentStatus.raw };
    }

    try {
      await this.http.delete(`/instance/logout/${instanceId}`);
    } catch (err) {
      this.logger.debug('Logout antes de gerar novo QR falhou (ignorado — instância pode não estar conectada)', {
        provider: this.name,
        instanceId,
        error: String(err),
      });
    }

    return this.fetchQrCode(instanceId);
  }

  private async fetchQrCode(instanceId: string): Promise<ConnectResult> {
    const raw = await this.http.get<Record<string, unknown>>(`/instance/connect/${instanceId}`);
    const qrCode = this.extractQrCode(raw);

    if (qrCode) {
      this.eventPublisher?.publish(QRCodeGenerated(this.name, instanceId, { qrCode }));
    }

    return { status: qrCode ? 'qr_required' : 'connecting', qrCode, raw };
  }

  async disconnect(instanceId: string): Promise<void> {
    await this.http.delete(`/instance/delete/${instanceId}`);
    this.eventPublisher?.publish(InstanceDisconnected(this.name, instanceId));
  }

  async getStatus(instanceId: string): Promise<InstanceStatus> {
    const raw = await this.http.get<{ instance?: { state?: 'open' | 'close' | 'connecting' } }>(
      `/instance/connectionState/${instanceId}`,
    );
    const state = raw.instance?.state ?? 'close';

    if (state === 'open') {
      this.eventPublisher?.publish(InstanceConnected(this.name, instanceId));
    }

    return { instanceId, state, raw };
  }

  async setWebhook(instanceId: string, config: WebhookConfig): Promise<void> {
    await this.http.post(`/webhook/set/${instanceId}`, {
      webhook: {
        enabled: config.enabled,
        url: config.url,
        events: config.events ?? ['MESSAGES_UPSERT'],
      },
    });
  }

  /**
   * Valida em lote quais números existem no WhatsApp. Sempre chamar antes de disparos em
   * lote — enviar para números inexistentes aumenta o score de ban da instância Baileys.
   */
  async checkNumbers(instanceId: string, numbers: string[]): Promise<string[]> {
    if (numbers.length === 0) return [];

    const results = await this.http.post<Array<{ jid: string; exists: boolean }>>(
      `/chat/whatsappNumbers/${instanceId}`,
      { numbers },
    );

    if (!Array.isArray(results)) {
      this.logger.warn('checkNumbers: resposta inesperada', { provider: this.name, instanceId });
      return [];
    }

    return results.filter((item) => item.exists === true).map((item) => PhoneNumber.create(item.jid).toString());
  }

  /**
   * Mídia recebida (ex.: nota de voz) chega criptografada no webhook (Baileys/E2E) — só a
   * própria Evolution consegue decriptar, usando a mensagem que ela já tem persistida no
   * Postgres dela (busca por `key.id`, não precisamos saber `mediaKey`/`remoteJid` aqui).
   * `convertToMp4:false` porque queremos o áudio original (ogg/opus) pra mandar pro Whisper,
   * não um vídeo. Evolution nunca devolve 200 vazio — toda falha vira erro HTTP, que já sobe
   * como ProviderApiException via `this.http` (mesmo tratamento dos outros métodos).
   */
  async getMediaBase64(instanceId: string, messageId: string): Promise<MediaResult> {
    const raw = await this.http.post<{ base64?: string; mimetype?: string }>(
      `/chat/getBase64FromMediaMessage/${instanceId}`,
      { message: { key: { id: messageId } }, convertToMp4: false },
    );

    if (!raw?.base64 || !raw?.mimetype) {
      this.logger.warn('getMediaBase64: resposta inesperada', { provider: this.name, instanceId, messageId });
      throw new Error('Resposta inesperada de getBase64FromMediaMessage.');
    }

    return { base64: raw.base64, mimetype: raw.mimetype, raw };
  }

  // ==========================================================================
  // Mensagens
  // ==========================================================================

  async sendText(instanceId: string, to: string, text: string, options?: SendTextOptions): Promise<SendResult> {
    const raw = await this.http.post(`/message/sendText/${instanceId}`, {
      number: to,
      text,
      // Sem delay por padrão — resposta imediata. `delayMs` opcional reativa a simulação
      // de digitação da Evolution por mensagem (útil pra disparos em massa, anti-ban).
      ...(options?.delayMs ? { delay: options.delayMs } : {}),
    });
    return this.toSendResult(raw);
  }

  async sendImage(instanceId: string, to: string, mediaUrl: string, caption = ''): Promise<SendResult> {
    const raw = await this.http.post(`/message/sendMedia/${instanceId}`, {
      number: to,
      mediatype: 'image',
      media: mediaUrl,
      caption,
    });
    return this.toSendResult(raw);
  }

  async sendSticker(instanceId: string, to: string, mediaUrl: string): Promise<SendResult> {
    const raw = await this.http.post(`/message/sendSticker/${instanceId}`, { number: to, sticker: mediaUrl });
    return this.toSendResult(raw);
  }

  async sendAudio(instanceId: string, to: string, mediaUrl: string): Promise<SendResult> {
    const raw = await this.http.post(`/message/sendWhatsAppAudio/${instanceId}`, { number: to, audio: mediaUrl });
    return this.toSendResult(raw);
  }

  async sendVideo(instanceId: string, to: string, mediaUrl: string, caption = ''): Promise<SendResult> {
    const raw = await this.http.post(`/message/sendMedia/${instanceId}`, {
      number: to,
      mediatype: 'video',
      media: mediaUrl,
      caption,
    });
    return this.toSendResult(raw);
  }

  async sendDocument(instanceId: string, to: string, mediaUrl: string, fileName: string): Promise<SendResult> {
    const raw = await this.http.post(`/message/sendMedia/${instanceId}`, {
      number: to,
      mediatype: 'document',
      media: mediaUrl,
      fileName,
    });
    return this.toSendResult(raw);
  }

  async sendLocation(
    instanceId: string,
    to: string,
    latitude: number,
    longitude: number,
    name?: string,
    address?: string,
  ): Promise<SendResult> {
    const raw = await this.http.post(`/message/sendLocation/${instanceId}`, {
      number: to,
      latitude,
      longitude,
      name,
      address,
    });
    return this.toSendResult(raw);
  }

  async sendButtons(instanceId: string, to: string, content: ButtonsContent): Promise<SendResult> {
    const raw = await this.http.post(`/message/sendButtons/${instanceId}`, {
      number: to,
      // A Evolution monta o corpo da mensagem como `*${title}*\n\n${description}` sem checar
      // se `title` existe — omitir o campo faz ela interpolar a string literal "undefined"
      // no texto enviado ao destinatário, e título vazio vira "**" solto na mensagem. Por
      // isso sempre mandamos um título não-vazio (fallback pro nome da marca).
      title: content.title?.trim() ? content.title : 'Zapediu',
      description: content.body,
      footer: content.footer ?? '',
      thumbnailUrl: content.imageUrl,
      // Botão sem `type` é a forma legada (ReplyButton) — vira reply. Botões tipados
      // (url/call/copy/reply) já estão no shape que a Evolution espera, passam direto.
      buttons: content.buttons.map((button) =>
        'type' in button ? button : { type: 'reply', displayText: button.displayText, id: button.id },
      ),
    });
    return this.toSendResult(raw);
  }

  async sendList(instanceId: string, to: string, content: ListContent): Promise<SendResult> {
    const raw = await this.http.post(`/message/sendList/${instanceId}`, {
      number: to,
      title: content.title,
      description: content.description,
      buttonText: content.buttonText,
      // Evolution exige footerText (400 se ausente), mas ListContent.footer é opcional pra
      // outros providers (Meta/Z-API não têm esse requisito) — mesmo fallback de sendButtons.
      footerText: content.footer?.trim() ? content.footer : 'Zapediu',
      sections: content.sections,
    });
    return this.toSendResult(raw);
  }

  async sendCarousel(
    instanceId: string,
    to: string,
    content: CarouselContent,
    _providerOptions?: CarouselProviderOptions,
  ): Promise<SendResult> {
    const raw = await this.http.post(`/message/sendCarousel/${instanceId}`, {
      number: to,
      body: content.body,
      cards: content.cards,
    });
    return this.toSendResult(raw);
  }

  async sendReaction(instanceId: string, to: string, messageId: string, emoji: string): Promise<SendResult> {
    const raw = await this.http.post(`/message/sendReaction/${instanceId}`, {
      reactionMessage: {
        key: { remoteJid: PhoneNumber.create(to).toJid(), fromMe: false, id: messageId },
        reaction: emoji,
      },
    });
    return this.toSendResult(raw);
  }

  // ==========================================================================
  // Webhook inbound
  // ==========================================================================

  /**
   * Normaliza o payload de webhook da Evolution (`{ event, instance, data }`). Mapeamento
   * best-effort a partir dos eventos documentados (messages.upsert, messages.update,
   * connection.update) — validar contra uma instância real antes de depender em produção.
   */
  parseWebhookPayload(rawBody: Buffer, _headers: Record<string, string>): DomainEvent[] {
    const body = JSON.parse(rawBody.toString('utf8')) as {
      event?: string;
      instance?: string;
      data?: Record<string, unknown>;
    };
    const instanceId = body.instance ?? 'unknown';
    const data = body.data ?? {};

    switch (body.event) {
      case 'messages.upsert': {
        const key = data['key'] as { id?: string; remoteJid?: string; fromMe?: boolean } | undefined;
        if (key?.fromMe) return [];
        return [
          MessageReceived(this.name, instanceId, {
            from: key?.remoteJid ? PhoneNumber.create(key.remoteJid).toString() : 'unknown',
            messageId: key?.id ?? '',
            content: data['message'],
          }),
        ];
      }
      case 'messages.update': {
        const key = data['key'] as { id?: string } | undefined;
        const messageId = key?.id ?? '';
        const status = String(data['status'] ?? '').toUpperCase();
        if (status === 'READ') return [MessageRead(this.name, instanceId, { messageId })];
        if (status === 'DELIVERY_ACK' || status === 'DELIVERED') {
          return [MessageDelivered(this.name, instanceId, { messageId })];
        }
        return [];
      }
      case 'connection.update': {
        const state = data['state'] as string | undefined;
        if (state === 'open') return [InstanceConnected(this.name, instanceId)];
        if (state === 'close') return [ConnectionLost(this.name, instanceId, { reason: 'connection.update: close' })];
        return [];
      }
      default:
        return [];
    }
  }

  // ==========================================================================

  private toSendResult(raw: unknown): SendResult {
    const messageId = (raw as { key?: { id?: string } } | undefined)?.key?.id;
    return { messageId, raw };
  }

  private extractQrCode(raw: Record<string, unknown>): string | undefined {
    const qrcode = raw['qrcode'] as { base64?: string } | undefined;
    return qrcode?.base64 ?? (raw['base64'] as string | undefined);
  }
}
