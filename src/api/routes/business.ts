import type { FastifyInstance } from 'fastify';
import type { BusinessController } from '../controllers/BusinessController.js';

export function registerBusinessRoutes(app: FastifyInstance, controller: BusinessController): void {
  app.get('/v1/instances/:id/capabilities', controller.getCapabilities);

  // Templates de mensagem da Meta (envio é POST /messages/template).
  app.get('/v1/instances/:id/templates', controller.listTemplates);
  app.post('/v1/instances/:id/templates', controller.createTemplate);
  app.delete('/v1/instances/:id/templates/:name', controller.deleteTemplate);

  // Coexistence (Meta): estado do número e sincronização pós-onboarding (janela de 24h).
  app.get('/v1/instances/:id/coexistence', controller.getCoexistence);
  app.post('/v1/instances/:id/coexistence/sync', controller.syncCoexistence);
}
