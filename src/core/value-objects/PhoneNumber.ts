const NON_DIGITS = /\D/g;
const WHATSAPP_SUFFIXES = /@(s\.whatsapp\.net|c\.us|g\.us)$/;

/**
 * Normaliza números de WhatsApp para um formato único (apenas dígitos, sem sufixo de JID),
 * evitando que cada provider reimplemente essa limpeza (hoje duplicada como
 * `.replace('@s.whatsapp.net', '')` dentro do client da Evolution).
 */
export class PhoneNumber {
  private constructor(public readonly digits: string) {}

  static create(raw: string): PhoneNumber {
    // Um LID ("...@lid") não é telefone — é um identificador opaco que o WhatsApp usa no
    // lugar do número real quando "addressingMode: lid" está ativo (privacidade de grupo).
    // Sem esta checagem, o replace de dígitos abaixo "limpava" o "@lid" junto com os dígitos
    // reais e devolvia um PhoneNumber válido só na aparência — um número que não existe.
    // Resolver o telefone de verdade é responsabilidade de quem chama (ver
    // EvolutionProvider.parseWebhookPayload, que usa `participantAlt` nesse caso).
    if (raw.endsWith('@lid')) {
      throw new Error(`PhoneNumber inválido: "${raw}" é um LID, não um número de telefone.`);
    }

    const stripped = raw.replace(WHATSAPP_SUFFIXES, '');
    const digits = stripped.replace(NON_DIGITS, '');

    if (digits.length < 8) {
      throw new Error(`PhoneNumber inválido: "${raw}"`);
    }

    return new PhoneNumber(digits);
  }

  toJid(): string {
    return `${this.digits}@s.whatsapp.net`;
  }

  toString(): string {
    return this.digits;
  }
}
