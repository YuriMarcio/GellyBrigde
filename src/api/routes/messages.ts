import type { FastifyInstance } from 'fastify';
import type { MessageController } from '../controllers/MessageController.js';

export function registerMessageRoutes(app: FastifyInstance, controller: MessageController): void {
  app.post('/v1/instances/:id/messages/:type', controller.send);
  app.get('/v1/instances/:id/media/:messageId', controller.getMedia);
}
