// ============================================================================
// Vocabulário compartilhado da interface CommunicationProvider.
// Definido em core/ (não em contracts/) porque é a linguagem que os próprios providers
// implementam — contracts/dto, contracts/requests e contracts/responses reexportam essas
// formas como API pública estável, sem duplicar a definição.
// ============================================================================

import type { DomainEvent } from '../events/index.js';

export type WhatsAppProviderName = 'evolution' | 'zapi' | 'meta';

export interface ReplyButton {
  id: string;
  displayText: string;
}

/**
 * Botões de card de carrossel. Ao contrário de `ReplyButton` (usado em `sendButtons`, sempre
 * `reply`), a Evolution exige `type` explícito por botão do carrossel — `reply`, `url`, `call`
 * ou `copy` — cada um com seu próprio campo obrigatório (`id`, `url`, `phoneNumber`,
 * `copyCode`). `pix` existe em `sendButtons` mas a Evolution rejeita com 400 dentro de um
 * carrossel, por isso não faz parte desta união.
 */
export interface CarouselReplyButton {
  type: 'reply';
  displayText: string;
  /** Opcional — a Evolution gera um id automaticamente quando omitido. */
  id?: string;
}

export interface CarouselUrlButton {
  type: 'url';
  displayText: string;
  url: string;
}

export interface CarouselCallButton {
  type: 'call';
  displayText: string;
  phoneNumber: string;
}

export interface CarouselCopyButton {
  type: 'copy';
  displayText: string;
  copyCode: string;
}

export type CarouselButton = CarouselReplyButton | CarouselUrlButton | CarouselCallButton | CarouselCopyButton;

/**
 * Botões aceitos por `sendButtons`. `ReplyButton` (sem `type`) é a forma legada e equivale a
 * `{ type: 'reply' }` — mantida na união para não quebrar consumidores existentes. As formas
 * tipadas (`url`, `call`, `copy`, `reply`) reutilizam os mesmos shapes do carrossel.
 */
export type ActionButton = ReplyButton | CarouselButton;

export interface CarouselCard {
  title?: string;
  body: string;
  footer?: string;
  imageUrl?: string;
  /** 1 a 3 botões por card — limite da Evolution, validado no servidor. */
  buttons: CarouselButton[];
}

export interface ListSectionRow {
  rowId: string;
  title: string;
  description?: string;
}

export interface ListSection {
  title: string;
  rows: ListSectionRow[];
}

export interface WebhookConfig {
  url: string;
  enabled: boolean;
  events?: string[];
}

export interface SendTextOptions {
  /** Delay antes do envio, em ms. */
  delayMs?: number;
}

export interface ButtonsContent {
  title?: string;
  body: string;
  footer?: string;
  imageUrl?: string;
  buttons: ActionButton[];
}

export interface ListContent {
  title: string;
  description: string;
  buttonText: string;
  footer?: string;
  sections: ListSection[];
}

export interface CarouselContent {
  body: string;
  cards: CarouselCard[];
}

/**
 * Opções específicas da Meta Cloud API — o carrossel lá só existe como template
 * pré-aprovado (não é freeform como na Evolution/Z-API). Ignorado pelos outros providers.
 */
export interface CarouselProviderOptions {
  templateName?: string;
  languageCode?: string;
}

export interface ConnectResult {
  status: 'connected' | 'connecting' | 'qr_required';
  qrCode?: string;
  raw?: unknown;
}

export interface InstanceStatus {
  instanceId: string;
  state: 'open' | 'close' | 'connecting';
  raw?: unknown;
}

export interface SendResult {
  messageId?: string;
  raw: unknown;
}

export interface MediaResult {
  base64: string;
  mimetype: string;
  raw: unknown;
}

export interface GroupParticipantResult {
  jid: string;
  status: 'added' | 'failed' | 'already_member';
}

export interface CreateGroupResult {
  /** JID do grupo recém-criado (ex.: "120363012345678901@g.us") — chave usada em todas as
   *  operações subsequentes desse grupo (add/promote/inviteCode/sendText). */
  groupJid: string;
  subject: string;
  participants: GroupParticipantResult[];
  raw: unknown;
}

export interface GroupInviteCode {
  code: string;
  /** Link pronto pra compartilhar (`https://chat.whatsapp.com/{code}`). */
  url: string;
}

/**
 * Contrato único que Evolution, Z-API e Meta Cloud API implementam. Nenhuma camada acima
 * (application/use-cases, SDK) conhece detalhes de um provider específico — tudo passa por
 * aqui, resolvido via ProviderRegistry.
 *
 * Operações que um provider genuinamente não suporta (ex.: checkNumbers na Meta) lançam
 * UnsupportedProviderOperationException em vez de simular um comportamento inexistente.
 */
export interface CommunicationProvider {
  readonly name: WhatsAppProviderName;

  connect(instanceId: string): Promise<ConnectResult>;
  /**
   * Busca um QR code novo para uma instância que já existe, sem recriá-la — necessário
   * porque o QR do Baileys (Evolution/Z-API) expira em segundos e `connect()` sozinho não dá
   * para chamar de novo sem risco de tentar recriar a instância. Lança
   * UnsupportedProviderOperationException na Meta (não existe conceito de QR na Cloud API).
   */
  getQrCode(instanceId: string): Promise<ConnectResult>;
  disconnect(instanceId: string): Promise<void>;
  getStatus(instanceId: string): Promise<InstanceStatus>;
  setWebhook(instanceId: string, config: WebhookConfig): Promise<void>;
  checkNumbers(instanceId: string, numbers: string[]): Promise<string[]>;
  /**
   * Busca uma mídia recebida (ex.: nota de voz) já decriptada, em base64 — pra providers
   * Baileys (Evolution/Z-API) a mídia chega criptografada no webhook, só o próprio provider
   * consegue decriptar. Lança UnsupportedProviderOperationException onde não fizer sentido
   * (ex.: Meta Cloud API tem seu próprio fluxo de media ID, ainda não implementado aqui).
   */
  getMediaBase64(instanceId: string, messageId: string): Promise<MediaResult>;

  sendText(instanceId: string, to: string, text: string, options?: SendTextOptions): Promise<SendResult>;
  sendImage(instanceId: string, to: string, mediaUrl: string, caption?: string): Promise<SendResult>;
  /** `mediaUrl` deve apontar para um WEBP — é o único formato que os 3 providers renderizam como sticker nativo (não como imagem comum). */
  sendSticker(instanceId: string, to: string, mediaUrl: string): Promise<SendResult>;
  sendAudio(instanceId: string, to: string, mediaUrl: string): Promise<SendResult>;
  sendVideo(instanceId: string, to: string, mediaUrl: string, caption?: string): Promise<SendResult>;
  sendDocument(instanceId: string, to: string, mediaUrl: string, fileName: string): Promise<SendResult>;
  sendLocation(
    instanceId: string,
    to: string,
    latitude: number,
    longitude: number,
    name?: string,
    address?: string,
  ): Promise<SendResult>;

  sendButtons(instanceId: string, to: string, content: ButtonsContent): Promise<SendResult>;
  sendList(instanceId: string, to: string, content: ListContent): Promise<SendResult>;
  sendCarousel(
    instanceId: string,
    to: string,
    content: CarouselContent,
    providerOptions?: CarouselProviderOptions,
  ): Promise<SendResult>;
  sendReaction(instanceId: string, to: string, messageId: string, emoji: string): Promise<SendResult>;

  /**
   * Cria um grupo de WhatsApp já com os participantes iniciais. `participants` deve ter pelo
   * menos 1 número (WhatsApp não permite grupo sem nenhum membro além do criador). Lança
   * UnsupportedProviderOperationException na Meta Cloud API (não existe API de grupos ali).
   */
  createGroup(instanceId: string, subject: string, participants: string[]): Promise<CreateGroupResult>;
  /** Adiciona números a um grupo já existente. Retorna o resultado por participante porque a
   *  operação é parcialmente falha-tolerante (um número inválido não derruba os demais). */
  addGroupParticipants(instanceId: string, groupJid: string, participants: string[]): Promise<GroupParticipantResult[]>;
  /** Promove participantes (já membros do grupo) a admin. */
  promoteGroupAdmins(instanceId: string, groupJid: string, participants: string[]): Promise<void>;
  getGroupInviteCode(instanceId: string, groupJid: string): Promise<GroupInviteCode>;

  /**
   * Normaliza o corpo bruto de um webhook recebido DO provider em eventos de domínio. Recebe
   * o Buffer bruto (não o JSON já parseado) porque a Meta exige validar a assinatura
   * X-Hub-Signature-256 sobre os bytes originais antes de qualquer parsing.
   */
  parseWebhookPayload(rawBody: Buffer, headers: Record<string, string>): DomainEvent[];
}
