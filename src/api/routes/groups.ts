import type { FastifyInstance } from 'fastify';
import type { GroupController } from '../controllers/GroupController.js';

export function registerGroupRoutes(app: FastifyInstance, controller: GroupController): void {
  app.post('/v1/instances/:id/groups', controller.create);
  app.post('/v1/instances/:id/groups/:groupJid/participants', controller.addParticipants);
  app.get('/v1/instances/:id/groups/:groupJid/invite-code', controller.inviteCode);
}
