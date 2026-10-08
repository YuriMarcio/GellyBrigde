import type { FastifyInstance } from 'fastify';
import type { WebhookController } from '../controllers/WebhookController.js';

export function registerWebhookRoutes(app: FastifyInstance, controller: WebhookController): void {
  // Handshake de inscrição da Meta (hub.challenge) — sem ele a URL de callback não é aceita.
  app.get('/v1/webhooks/:provider/:instanceId', controller.verify);
  app.post('/v1/webhooks/:provider/:instanceId', controller.receive);
  // A Evolution API, quando "Webhook by Events" está ativo, anexa o nome do evento ao final
  // da URL (ex.: .../webhooks/evolution/{id}/messages-upsert) em vez de mandar tudo pra rota
  // base — sem isso, toda chamada dela batia 404 aqui. O nome do evento na URL é ignorado; o
  // controller já lê o tipo de evento de dentro do body.
  app.post('/v1/webhooks/:provider/:instanceId/:eventName', controller.receive);
}
