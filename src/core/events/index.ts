// ============================================================================
// Domain Events — representam fatos que aconteceram (nunca regras de negócio).
// Core define a forma; contracts/events apenas re-exporta como API pública estável.
// ============================================================================

export interface DomainEvent<TPayload = unknown> {
  readonly type: string;
  readonly occurredAt: Date;
  readonly provider: string;
  readonly instanceId: string;
  readonly payload: TPayload;
}

function createEvent<TPayload>(
  type: string,
  provider: string,
  instanceId: string,
  payload: TPayload,
): DomainEvent<TPayload> {
  return { type, occurredAt: new Date(), provider, instanceId, payload };
}

export interface InstanceConnectedPayload {
  phoneNumber?: string;
}
export const InstanceConnected = (provider: string, instanceId: string, payload: InstanceConnectedPayload = {}) =>
  createEvent('InstanceConnected', provider, instanceId, payload);

export interface InstanceDisconnectedPayload {
  reason?: string;
}
export const InstanceDisconnected = (provider: string, instanceId: string, payload: InstanceDisconnectedPayload = {}) =>
  createEvent('InstanceDisconnected', provider, instanceId, payload);

export interface ConnectionLostPayload {
  reason?: string;
}
export const ConnectionLost = (provider: string, instanceId: string, payload: ConnectionLostPayload = {}) =>
  createEvent('ConnectionLost', provider, instanceId, payload);

export interface QRCodeGeneratedPayload {
  qrCode: string;
}
export const QRCodeGenerated = (provider: string, instanceId: string, payload: QRCodeGeneratedPayload) =>
  createEvent('QRCodeGenerated', provider, instanceId, payload);

export interface MessageSentPayload {
  to: string;
  messageId?: string;
  conversation?: MessageConversation;
  pricing?: MessagePricing;
}
export const MessageSent = (provider: string, instanceId: string, payload: MessageSentPayload) =>
  createEvent('MessageSent', provider, instanceId, payload);

// Definidos para uso futuro por quem processar webhooks inbound (o SDK não roda servidor
// e não os emite hoje) — mantidos aqui para que o formato do evento já exista quando essa
// camada for construída.

/**
 * Forma comum de uma mensagem recebida, independente do provider — é o que permite a quem
 * consome os eventos tratar Evolution, Z-API e Meta com o mesmo código. Hoje só a Meta
 * preenche (`content` continua sendo a mensagem crua de cada provider, sem normalização).
 */
export interface NormalizedInboundMessage {
  type: string;
  text?: string;
  /** Legenda de imagem/vídeo/documento. */
  caption?: string;
  /** Id de resposta de botão (reply button, quick reply de template) — o mesmo `id` enviado em sendButtons. */
  buttonReplyId?: string;
  buttonReplyTitle?: string;
  /** Id da linha escolhida numa lista — o mesmo `rowId` enviado em sendList. */
  listReplyId?: string;
  listReplyTitle?: string;
  /** Resposta de WhatsApp Flow (JSON string). */
  flowResponseJson?: string;
  mediaId?: string;
  mimeType?: string;
  fileName?: string;
  /** true para nota de voz gravada na hora (não áudio encaminhado). */
  isVoiceNote?: boolean;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  reaction?: { messageId: string; emoji: string };
  /** Mensagem citada (reply nativo do WhatsApp). */
  replyToMessageId?: string;
  profileName?: string;
  /** Unix epoch em segundos, como a Meta envia. */
  timestamp?: number;
}

export interface MessageConversation {
  id?: string;
  /** Unix epoch em segundos — quando a janela de 24h dessa conversa fecha. */
  expirationTimestamp?: number;
  originType?: string;
}

export interface MessagePricing {
  billable?: boolean;
  pricingModel?: string;
  category?: string;
}

export interface MessageReceivedPayload {
  from: string;
  messageId: string;
  content: unknown;
  normalized?: NormalizedInboundMessage;
  /** true quando a mensagem veio de um grupo — `from` já é o participante real, não o grupo. */
  isGroup?: boolean;
  /** JID do grupo (ex.: "120363...@g.us"), presente só quando isGroup=true. */
  groupJid?: string;
}
export const MessageReceived = (provider: string, instanceId: string, payload: MessageReceivedPayload) =>
  createEvent('MessageReceived', provider, instanceId, payload);

export interface MessageDeliveredPayload {
  messageId: string;
  to?: string;
  conversation?: MessageConversation;
  pricing?: MessagePricing;
}
export const MessageDelivered = (provider: string, instanceId: string, payload: MessageDeliveredPayload) =>
  createEvent('MessageDelivered', provider, instanceId, payload);

export interface MessageReadPayload {
  messageId: string;
  to?: string;
  conversation?: MessageConversation;
  pricing?: MessagePricing;
}
export const MessageRead = (provider: string, instanceId: string, payload: MessageReadPayload) =>
  createEvent('MessageRead', provider, instanceId, payload);

export interface ProviderError {
  code?: number;
  title?: string;
  message?: string;
  details?: string;
}

export interface MessageFailedPayload {
  messageId: string;
  to?: string;
  errors: ProviderError[];
  /** true quando a falha foi a janela de 24h fechada (Meta 131047) — a saída é um template. */
  customerServiceWindowClosed: boolean;
}
export const MessageFailed = (provider: string, instanceId: string, payload: MessageFailedPayload) =>
  createEvent('MessageFailed', provider, instanceId, payload);

// --- Meta Cloud API: templates, qualidade do número e conta -----------------

export interface TemplateStatusUpdatedPayload {
  templateId?: string;
  templateName?: string;
  language?: string;
  /** APPROVED | REJECTED | PAUSED | DISABLED | PENDING_DELETION | FLAGGED ... (valor cru da Meta). */
  status: string;
  reason?: string;
}
export const TemplateStatusUpdated = (provider: string, instanceId: string, payload: TemplateStatusUpdatedPayload) =>
  createEvent('TemplateStatusUpdated', provider, instanceId, payload);

export interface PhoneNumberQualityUpdatedPayload {
  displayPhoneNumber?: string;
  event?: string;
  currentLimit?: string;
}
export const PhoneNumberQualityUpdated = (provider: string, instanceId: string, payload: PhoneNumberQualityUpdatedPayload) =>
  createEvent('PhoneNumberQualityUpdated', provider, instanceId, payload);

export const AccountUpdated = (provider: string, instanceId: string, payload: Record<string, unknown>) =>
  createEvent('AccountUpdated', provider, instanceId, payload);

// --- Coexistence (Meta Cloud API) -------------------------------------------

export const CoexistenceHistorySync = (provider: string, instanceId: string, payload: Record<string, unknown>) =>
  createEvent('CoexistenceHistorySync', provider, instanceId, payload);
export const CoexistenceContactSync = (provider: string, instanceId: string, payload: Record<string, unknown>) =>
  createEvent('CoexistenceContactSync', provider, instanceId, payload);
export const CoexistenceMessageEcho = (provider: string, instanceId: string, payload: Record<string, unknown>) =>
  createEvent('CoexistenceMessageEcho', provider, instanceId, payload);
