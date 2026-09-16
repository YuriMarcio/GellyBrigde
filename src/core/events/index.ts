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
}
export const MessageSent = (provider: string, instanceId: string, payload: MessageSentPayload) =>
  createEvent('MessageSent', provider, instanceId, payload);

// Definidos para uso futuro por quem processar webhooks inbound (o SDK não roda servidor
// e não os emite hoje) — mantidos aqui para que o formato do evento já exista quando essa
// camada for construída.

export interface MessageReceivedPayload {
  from: string;
  messageId: string;
  content: unknown;
  /** true quando a mensagem veio de um grupo — `from` já é o participante real, não o grupo. */
  isGroup?: boolean;
  /** JID do grupo (ex.: "120363...@g.us"), presente só quando isGroup=true. */
  groupJid?: string;
}
export const MessageReceived = (provider: string, instanceId: string, payload: MessageReceivedPayload) =>
  createEvent('MessageReceived', provider, instanceId, payload);

export interface MessageDeliveredPayload {
  messageId: string;
}
export const MessageDelivered = (provider: string, instanceId: string, payload: MessageDeliveredPayload) =>
  createEvent('MessageDelivered', provider, instanceId, payload);

export interface MessageReadPayload {
  messageId: string;
}
export const MessageRead = (provider: string, instanceId: string, payload: MessageReadPayload) =>
  createEvent('MessageRead', provider, instanceId, payload);
