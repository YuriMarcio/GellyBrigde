import type {
  ButtonsContent,
  CarouselContent,
  CarouselProviderOptions,
  ListContent,
  SendTextOptions,
  WebhookConfig,
  WhatsAppProviderName,
} from '../dto/index.js';

/**
 * Toda operação da Application layer recebe um Request com essa forma — já preparado para
 * ser mapeado 1:1 a partir de um body HTTP quando a camada api/ existir, sem exigir mudanças
 * nos use-cases.
 */
export interface BaseProviderRequest {
  provider: WhatsAppProviderName;
  instanceId: string;
}

export interface ConnectInstanceRequest extends BaseProviderRequest {}
export interface DisconnectInstanceRequest extends BaseProviderRequest {}
export interface GetInstanceStatusRequest extends BaseProviderRequest {}

export interface SetWebhookRequest extends BaseProviderRequest {
  config: WebhookConfig;
}

export interface CheckNumbersRequest extends BaseProviderRequest {
  numbers: string[];
}

export interface SendTextRequest extends BaseProviderRequest {
  to: string;
  text: string;
  options?: SendTextOptions;
}

export interface SendImageRequest extends BaseProviderRequest {
  to: string;
  mediaUrl: string;
  caption?: string;
}

export interface SendAudioRequest extends BaseProviderRequest {
  to: string;
  mediaUrl: string;
}

export interface SendVideoRequest extends BaseProviderRequest {
  to: string;
  mediaUrl: string;
  caption?: string;
}

export interface SendDocumentRequest extends BaseProviderRequest {
  to: string;
  mediaUrl: string;
  fileName: string;
}

export interface SendLocationRequest extends BaseProviderRequest {
  to: string;
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

export interface SendButtonsRequest extends BaseProviderRequest {
  to: string;
  content: ButtonsContent;
}

export interface SendListRequest extends BaseProviderRequest {
  to: string;
  content: ListContent;
}

export interface SendCarouselRequest extends BaseProviderRequest {
  to: string;
  content: CarouselContent;
  providerOptions?: CarouselProviderOptions;
}

export interface SendReactionRequest extends BaseProviderRequest {
  to: string;
  messageId: string;
  emoji: string;
}

// ============================================================================
// Requests da API HTTP (api/) — só existem nesse nível porque a API gerencia instâncias
// dinamicamente (POST /v1/instances), diferente do SDK embutido, que já conhece o
// provider/instanceId de antemão em cada chamada.
// ============================================================================

/** Credenciais aceitas em POST /v1/instances. Campos de Z-API e Meta convivem no mesmo tipo
 *  porque o provider é escolhido em runtime; cada instância só usa os campos do seu tipo. */
export interface InstanceCredentials {
  // Z-API
  instanceId?: string;
  token?: string;
  clientToken?: string;
  // Meta Cloud API
  phoneNumberId?: string;
  accessToken?: string;
  wabaId?: string;
  apiVersion?: string;
  appSecret?: string;
  /** Gerado automaticamente na criação da instância quando omitido. */
  verifyToken?: string;
}

export interface CreateInstanceApiRequest {
  provider: WhatsAppProviderName;
  /** Id lógico da instância; gerado automaticamente se omitido. */
  instanceId?: string;
  /** Não se aplica à Evolution (credenciais globais via env). Obrigatório para zapi/meta. */
  credentials?: InstanceCredentials;
  /** URL para onde a API repassa os eventos normalizados desta instância. */
  callbackUrl?: string;
  /** Evolution instance already exists and only needs a fresh QR code. */
  existing?: boolean;
}
