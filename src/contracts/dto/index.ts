// ============================================================================
// DTOs públicos. As formas de mensagem/instância são definidas em core/interfaces/
// CommunicationProvider.ts (é o vocabulário que os providers implementam) — aqui só
// reexportamos como API estável para quem consome o pacote.
// ============================================================================

export type {
  ActionButton,
  ButtonsContent,
  CarouselButton,
  CarouselCallButton,
  CarouselCard,
  CarouselContent,
  CarouselCopyButton,
  CarouselProviderOptions,
  CarouselReplyButton,
  CarouselUrlButton,
  ConnectResult,
  InstanceStatus,
  ListContent,
  ListSection,
  ListSectionRow,
  ReplyButton,
  SendResult,
  SendTextOptions,
  WebhookConfig,
  WhatsAppProviderName,
} from '../../core/interfaces/CommunicationProvider.js';

// ============================================================================
// Configuração de cada provider — usada pela FlowBridgeClientFactory para construir e
// registrar instâncias de CommunicationProvider.
// ============================================================================

export interface EvolutionProviderConfig {
  name: 'evolution';
  baseUrl: string;
  apiKey: string;
  throwOnError?: boolean;
  timeout?: number;
}

export interface ZApiProviderConfig {
  name: 'zapi';
  instanceId: string;
  token: string;
  clientToken?: string;
  throwOnError?: boolean;
  timeout?: number;
}

export interface MetaProviderConfig {
  name: 'meta';
  phoneNumberId: string;
  accessToken: string;
  wabaId?: string;
  apiVersion?: string;
  /** Usado para validar a assinatura X-Hub-Signature-256 dos webhooks recebidos. */
  appSecret?: string;
  /** Token do handshake GET do webhook (`hub.verify_token`). Gerado pela API HTTP na criação da instância. */
  verifyToken?: string;
  /**
   * Id lógico da instância na API HTTP. É o `instanceId` dos eventos emitidos — sem isso cai
   * em `phoneNumberId`, que só serve no modo SDK (um número por processo).
   */
  instanceId?: string;
  throwOnError?: boolean;
  timeout?: number;
}

export type ProviderConfig = EvolutionProviderConfig | ZApiProviderConfig | MetaProviderConfig;

// ============================================================================
// Coexistence (Meta Cloud API) — payloads de webhook exclusivos desse modo, para quem for
// implementar o endpoint receptor. O SDK não roda servidor, então não os recebe diretamente.
// ============================================================================

export interface HistorySyncWebhookPayload {
  phase: 0 | 1 | 2;
  chunkOrder: number;
  progress: number;
  threads: Array<{
    id: string;
    messages: Array<{ from: string; to: string; id: string; timestamp: string; type: string }>;
  }>;
}

export interface SmbAppStateSyncWebhookPayload {
  action: 'add' | 'remove';
  contacts: Array<{ phoneNumber: string; fullName?: string }>;
}

export interface SmbMessageEchoWebhookPayload {
  from: string;
  to: string;
  id: string;
  timestamp: string;
  type: string;
  content: unknown;
}
