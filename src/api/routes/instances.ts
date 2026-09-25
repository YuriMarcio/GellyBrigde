import type { FastifyInstance } from 'fastify';
import type { InstanceController } from '../controllers/InstanceController.js';

export function registerInstanceRoutes(app: FastifyInstance, controller: InstanceController): void {
  app.post('/v1/instances', controller.create);
  app.get('/v1/instances', controller.list);
  app.get('/v1/instances/:id', controller.getStatus);
  app.get('/v1/instances/:id/qrcode', controller.getQrCode);
  app.get('/v1/instances/:id/pairing-code', controller.getPairingCode);
  app.delete('/v1/instances/:id', controller.disconnect);
  app.post('/v1/instances/:id/check-numbers', controller.checkNumbers);
}
