import type { FastifyReply, FastifyRequest } from 'fastify';
import type { InstanceProviderRegistry } from '../../application/InstanceProviderRegistry.js';
import type { EventPublisher } from '../../core/interfaces/EventPublisher.js';
import type { WhatsAppProviderName } from '../../core/interfaces/CommunicationProvider.js';
import type { InstanceRepository } from '../../core/interfaces/InstanceRepository.js';
import type { Logger } from '../../core/interfaces/Logger.js';

/**
 * Recebe webhooks DOS providers (chamada pública, sem x-api-key — quem chama é a
 * Evolution/Z-API/Meta, não o consumidor do FlowBridge), normaliza via
 * `provider.parseWebhookPayload` e repassa os eventos resultantes ao EventPublisher, que se
 * encarrega de entregá-los ao `callbackUrl` da instância.
 */
export class WebhookController {
  constructor(
    private readonly instanceRepository: InstanceRepository,
    private readonly instanceProviderRegistry: InstanceProviderRegistry,
    private readonly eventPublisher: EventPublisher,
    private readonly logger: Logger,
  ) {}

  /**
   * Handshake de inscrição (Meta): GET com `hub.mode=subscribe`, `hub.verify_token` e
   * `hub.challenge`. Responde o challenge em texto puro quando o token confere com o da
   * instância; qualquer outra coisa é 403. Sem isso a Meta não aceita a URL de callback.
   */
  verify = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { provider, instanceId } = request.params as { provider: WhatsAppProviderName; instanceId: string };

    const instance = await this.instanceRepository.findById(instanceId);
    if (!instance || instance.provider !== provider) {
      reply.code(404).send({ error: `Instância "${instanceId}" não encontrada para o provider "${provider}".` });
      return;
    }

    const providerImpl = await this.instanceProviderRegistry.resolve(instanceId, instance.provider);
    if (!providerImpl.verifyWebhookSubscription) {
      reply.code(404).send({ error: `O provider "${provider}" não usa handshake GET de webhook.` });
      return;
    }

    const challenge = providerImpl.verifyWebhookSubscription(request.query as Record<string, string | undefined>);
    if (challenge === null) {
      this.logger.warn('Handshake de webhook recusado (token inválido)', { provider, instanceId });
      reply.code(403).send({ error: 'Verificação do webhook recusada.' });
      return;
    }

    reply.code(200).type('text/plain').send(challenge);
  };

  receive = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { provider, instanceId } = request.params as { provider: WhatsAppProviderName; instanceId: string };

    const instance = await this.instanceRepository.findById(instanceId);
    // O provider vem da URL só como parte da rota; quem manda é o provider gravado na instância —
    // uma URL /webhooks/zapi/{id-de-uma-instância-meta} não pode ser tratada pelo parser errado.
    if (!instance || instance.provider !== provider) {
      reply.code(404).send({ error: `Instância "${instanceId}" não encontrada para o provider "${provider}".` });
      return;
    }

    const providerImpl = await this.instanceProviderRegistry.resolve(instanceId, instance.provider);
    const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(request.body ?? {}));
    const headers = this.flattenHeaders(request.headers);

    let events;
    try {
      events = providerImpl.parseWebhookPayload(rawBody, headers);
      if (events.length === 0) {
        this.logger.info('Webhook recebido sem eventos mapeados (payload ignorado pelo parser)', {
          provider,
          instanceId,
          rawBody: rawBody.toString('utf8').slice(0, 2000),
        });
      }
    } catch (err) {
      this.logger.warn('Falha ao processar webhook recebido', { provider, instanceId, error: String(err) });
      reply.code(401).send({ error: 'Webhook inválido.' });
      return;
    }

    if (events.length > 0) {
      this.logger.info('Webhook recebido, publicando eventos', {
        provider,
        instanceId,
        eventTypes: events.map((event) => event.type),
      });
    }

    for (const event of events) {
      this.eventPublisher.publish(event);
    }

    reply.code(200).send({ received: events.length });
  };

  private flattenHeaders(headers: FastifyRequest['headers']): Record<string, string> {
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      flat[key] = Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
    }
    return flat;
  }
}
