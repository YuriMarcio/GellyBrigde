// ============================================================================
// Capacidades opcionais — operações que só alguns providers têm. Ficam fora de
// CommunicationProvider de propósito: assim Evolution e Z-API não precisam de métodos que
// lançam Unsupported só para satisfazer o tipo, e a camada HTTP descobre o que existe com os
// type guards abaixo (sem esses métodos → 501).
// ============================================================================

import type { CommunicationProvider, SendResult, WhatsAppProviderName } from './CommunicationProvider.js';

// --- Template de mensagem (WhatsApp Cloud API) ------------------------------

export type TemplateHeader =
  | { type: 'text'; text: string }
  | { type: 'image' | 'video' | 'document'; url?: string; mediaId?: string; fileName?: string };

export type TemplateButtonParameter =
  | { type: 'quick_reply'; payload: string; index?: number }
  /** Variável do final da URL do botão (`https://loja.com/{{1}}` → `urlSuffix` preenche o `{{1}}`). */
  | { type: 'url'; urlSuffix: string; index?: number };

/**
 * Envio de um template aprovado. Os campos simples cobrem texto, mídia de cabeçalho e botões;
 * `components` é a saída de emergência com os componentes crus da Cloud API (carrossel,
 * Flows, cupom, localização...) e, se informado, substitui os campos simples.
 */
export interface TemplateContent {
  name: string;
  languageCode: string;
  header?: TemplateHeader;
  /** Valores de `{{1}}`, `{{2}}`... do corpo, em ordem. */
  bodyParameters?: string[];
  buttons?: TemplateButtonParameter[];
  components?: Array<Record<string, unknown>>;
}

export interface TemplateSender {
  sendTemplate(instanceId: string, to: string, template: TemplateContent): Promise<SendResult>;
}

export interface TemplateListQuery {
  name?: string;
  status?: string;
  limit?: number;
  after?: string;
}

export interface TemplateInfo {
  id?: string;
  name: string;
  language: string;
  status: string;
  category?: string;
  rejectedReason?: string;
  components?: unknown[];
}

export interface TemplateList {
  data: TemplateInfo[];
  /** Cursor para a próxima página, quando houver. */
  next?: string;
}

export interface TemplateDefinition {
  /** minúsculas, números e `_` */
  name: string;
  language: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  components: Array<Record<string, unknown>>;
}

export interface TemplateManager {
  listTemplates(instanceId: string, query?: TemplateListQuery): Promise<TemplateList>;
  createTemplate(instanceId: string, definition: TemplateDefinition): Promise<unknown>;
  deleteTemplate(instanceId: string, name: string): Promise<void>;
}

// --- Confirmação de leitura / "digitando..." --------------------------------

export interface MarkAsReadOptions {
  /** Mostra "digitando..." até a próxima mensagem enviada (a Meta apaga sozinha em 25s). */
  typingIndicator?: boolean;
}

export interface ReadReceiptSender {
  markAsRead(instanceId: string, messageId: string, options?: MarkAsReadOptions): Promise<void>;
}

// --- Coexistence (número ativo no app WhatsApp Business E na Cloud API) -----

export interface PhoneNumberInfo {
  isOnBizApp: boolean;
  platformType: string | undefined;
  raw: unknown;
}

export interface CoexistenceManager {
  getPhoneNumberInfo(): Promise<PhoneNumberInfo>;
  syncContacts(): Promise<void>;
  syncHistory(): Promise<void>;
}

// --- Type guards -------------------------------------------------------------

const has = (provider: object, method: string): boolean => typeof (provider as Record<string, unknown>)[method] === 'function';

export const isTemplateSender = (p: CommunicationProvider): p is CommunicationProvider & TemplateSender =>
  has(p, 'sendTemplate');
export const isTemplateManager = (p: CommunicationProvider): p is CommunicationProvider & TemplateManager =>
  has(p, 'listTemplates') && has(p, 'createTemplate') && has(p, 'deleteTemplate');
export const isReadReceiptSender = (p: CommunicationProvider): p is CommunicationProvider & ReadReceiptSender =>
  has(p, 'markAsRead');
export const isCoexistenceManager = (p: CommunicationProvider): p is CommunicationProvider & CoexistenceManager =>
  has(p, 'getPhoneNumberInfo') && has(p, 'syncContacts') && has(p, 'syncHistory');

// --- Matriz de capacidades em código -----------------------------------------

export interface ProviderCapabilities {
  provider: WhatsAppProviderName;
  messaging: {
    text: boolean;
    media: boolean;
    location: boolean;
    reaction: boolean;
    buttons: boolean;
    /** Botões `url`/`call`/`copy` em sendButtons (a Meta só aceita 1 botão url, como CTA). */
    typedButtons: 'all' | 'single-url-only' | 'degraded-to-reply';
    list: boolean;
    /** 'interactive' = carrossel de serviço da Meta (sem template, com regras de limites). */
    carousel: 'freeform' | 'interactive';
    template: boolean;
    markAsRead: boolean;
    typingIndicator: boolean;
  };
  /** Limites que o provider impõe; ausente = sem limite conhecido. */
  limits: {
    maxButtons?: number;
    buttonTitleMax?: number;
    listRowsMax?: number;
    listSectionsMax?: number;
    listRowTitleMax?: number;
    listRowDescriptionMax?: number;
    bodyMax?: number;
    carouselCardsMin?: number;
    carouselCardsMax?: number;
    carouselCardBodyMax?: number;
    carouselCardBodyLineBreaksMax?: number;
    /** Tipo e quantidade de botões têm de ser iguais em todos os cards do carrossel. */
    carouselUniformButtons?: boolean;
  };
  /** Mensagem livre só dentro de 24h após a última mensagem do cliente. */
  customerServiceWindow24h: boolean;
  groups: boolean;
  qrConnect: boolean;
  checkNumbers: boolean;
  mediaDownload: boolean;
  templateManagement: boolean;
  coexistence: boolean;
}

/**
 * Fonte única do que cada provider faz. Quem monta mensagens (ex.: o Zapedio) consulta isto
 * para adaptar o conteúdo ao provider em vez de descobrir pelo erro 501/502. Os testes em
 * tests/providers/CrossProviderContract.test.ts travam esta tabela contra o comportamento real.
 */
export const PROVIDER_CAPABILITIES: Record<WhatsAppProviderName, ProviderCapabilities> = {
  evolution: {
    provider: 'evolution',
    messaging: {
      text: true, media: true, location: true, reaction: true, buttons: true, typedButtons: 'all', list: true,
      carousel: 'freeform', template: false, markAsRead: false, typingIndicator: false,
    },
    limits: {},
    customerServiceWindow24h: false,
    groups: true,
    qrConnect: true,
    checkNumbers: true,
    mediaDownload: true,
    templateManagement: false,
    coexistence: false,
  },
  zapi: {
    provider: 'zapi',
    messaging: {
      text: true, media: true, location: true, reaction: true, buttons: true, typedButtons: 'degraded-to-reply', list: true,
      carousel: 'freeform', template: false, markAsRead: false, typingIndicator: false,
    },
    limits: {},
    customerServiceWindow24h: false,
    groups: false,
    qrConnect: true,
    checkNumbers: true,
    mediaDownload: false,
    templateManagement: false,
    coexistence: false,
  },
  meta: {
    provider: 'meta',
    messaging: {
      text: true, media: true, location: true, reaction: true, buttons: true, typedButtons: 'single-url-only', list: true,
      carousel: 'interactive', template: true, markAsRead: true, typingIndicator: true,
    },
    limits: {
      maxButtons: 3,
      buttonTitleMax: 20,
      listRowsMax: 10,
      listSectionsMax: 10,
      listRowTitleMax: 24,
      listRowDescriptionMax: 72,
      bodyMax: 1024,
      carouselCardsMin: 2,
      carouselCardsMax: 10,
      carouselCardBodyMax: 160,
      carouselCardBodyLineBreaksMax: 2,
      carouselUniformButtons: true,
    },
    customerServiceWindow24h: true,
    groups: false,
    qrConnect: false,
    checkNumbers: false,
    mediaDownload: true,
    templateManagement: true,
    coexistence: true,
  },
};
