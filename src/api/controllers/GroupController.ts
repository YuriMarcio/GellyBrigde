import type { FastifyReply, FastifyRequest } from 'fastify';
import type { InstanceProviderRegistry } from '../../application/InstanceProviderRegistry.js';
import type { InstanceRepository } from '../../core/interfaces/InstanceRepository.js';

/**
 * Cria grupo de WhatsApp e gerencia participantes. Fino de propósito, igual
 * MessageController — a lógica real vive nos providers (Core).
 */
export class GroupController {
  constructor(
    private readonly instanceRepository: InstanceRepository,
    private readonly instanceProviderRegistry: InstanceProviderRegistry,
  ) {}

  create = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { id } = request.params as { id: string };
    const instance = await this.instanceRepository.findById(id);
    if (!instance) {
      reply.code(404).send({ error: `Instância "${id}" não encontrada.` });
      return;
    }

    const body = (request.body ?? {}) as { subject?: string; participants?: string[] };
    if (!body.subject || !Array.isArray(body.participants) || body.participants.length === 0) {
      reply.code(400).send({ error: '"subject" e "participants" (array não vazio) são obrigatórios.' });
      return;
    }

    const provider = await this.instanceProviderRegistry.resolve(id, instance.provider);
    const group = await provider.createGroup(id, body.subject, body.participants);
    const invite = await provider.getGroupInviteCode(id, group.groupJid);

    reply.code(201).send({ ...group, invite });
  };

  addParticipants = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { id, groupJid } = request.params as { id: string; groupJid: string };
    const instance = await this.instanceRepository.findById(id);
    if (!instance) {
      reply.code(404).send({ error: `Instância "${id}" não encontrada.` });
      return;
    }

    const body = (request.body ?? {}) as { participants?: string[]; asAdmin?: boolean };
    if (!Array.isArray(body.participants) || body.participants.length === 0) {
      reply.code(400).send({ error: '"participants" (array não vazio) é obrigatório.' });
      return;
    }

    const provider = await this.instanceProviderRegistry.resolve(id, instance.provider);
    const result = await provider.addGroupParticipants(id, groupJid, body.participants);

    if (body.asAdmin) {
      await provider.promoteGroupAdmins(id, groupJid, body.participants);
    }

    reply.send({ participants: result });
  };

  inviteCode = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { id, groupJid } = request.params as { id: string; groupJid: string };
    const instance = await this.instanceRepository.findById(id);
    if (!instance) {
      reply.code(404).send({ error: `Instância "${id}" não encontrada.` });
      return;
    }

    const provider = await this.instanceProviderRegistry.resolve(id, instance.provider);
    reply.send(await provider.getGroupInviteCode(id, groupJid));
  };
}
