import type { WhatsAppProviderName } from '../interfaces/CommunicationProvider.js';

/**
 * Mensagem livre recusada porque a janela de atendimento de 24h do cliente está fechada
 * (Meta Cloud API, erro 131047). A saída é reenviar como template aprovado (`sendTemplate`).
 * Diferente de ProviderApiException (502) porque quem chama pode — e deve — reagir a isso.
 */
export class CustomerServiceWindowClosedException extends Error {
  constructor(
    public readonly provider: WhatsAppProviderName,
    public readonly to: string,
    public readonly providerErrorCode: number,
  ) {
    super(`[${provider}] janela de atendimento de 24h fechada para "${to}" — use um template aprovado (sendTemplate).`);
    this.name = 'CustomerServiceWindowClosedException';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CustomerServiceWindowClosedException);
    }
  }
}
