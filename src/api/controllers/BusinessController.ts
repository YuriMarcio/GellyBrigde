import type { FastifyReply, FastifyRequest } from 'fastify';
import type { InstanceProviderRegistry } from '../../application/InstanceProviderRegistry.js';
import { UnsupportedProviderOperationException } from '../../core/exceptions/UnsupportedProviderOperationException.js';
import {
  isCoexistenceManager,
  isTemplateManager,
  PROVIDER_CAPABILITIES,
  type TemplateDefinition,
  type TemplateListQuery,
} from '../../core/interfaces/BusinessCapabilities.js';
import type { CommunicationProvider } from '../../core/interfaces/CommunicationProvider.js';
import type { Instance } from '../../core/entities/Instance.js';
import type { InstanceRepository } from '../../core/interfaces/InstanceRepository.js';

/**
 * Operações que só alguns providers têm — capacidades, gerenciamento de templates e
 * Coexistence. Cada uma checa o type guard e responde 501 (via UnsupportedProviderOperation)
 * quando o provider da instância não oferece, igual ao resto da API.
 */
export class BusinessController {
  constructor(
    private readonly instanceRepository: InstanceRepository,
    private readonly instanceProviderRegistry: InstanceProviderRegistry,
  ) {}

  getCapabilities = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const resolved = await this.resolve(request, reply);
    if (!resolved) return;
    reply.send(PROVIDER_CAPABILITIES[resolved.instance.provider]);
  };

  listTemplates = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const resolved = await this.resolve(request, reply);
    if (!resolved) return;
    const manager = this.requireTemplateManager(resolved.provider, 'listTemplates');

    const query = request.query as { name?: string; status?: string; limit?: string; after?: string };
    const filters: TemplateListQuery = {
      name: query.name,
      status: query.status,
      after: query.after,
      limit: query.limit ? Number(query.limit) : undefined,
    };
    reply.send(await manager.listTemplates(resolved.instance.id, filters));
  };

  createTemplate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const resolved = await this.resolve(request, reply);
    if (!resolved) return;
    const manager = this.requireTemplateManager(resolved.provider, 'createTemplate');

    reply.code(201).send(await manager.createTemplate(resolved.instance.id, request.body as TemplateDefinition));
  };

  deleteTemplate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const resolved = await this.resolve(request, reply);
    if (!resolved) return;
    const manager = this.requireTemplateManager(resolved.provider, 'deleteTemplate');

    const { name } = request.params as { name: string };
    await manager.deleteTemplate(resolved.instance.id, name);
    reply.code(204).send();
  };

  getCoexistence = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const resolved = await this.resolve(request, reply);
    if (!resolved) return;
    reply.send(await this.requireCoexistence(resolved.provider).getPhoneNumberInfo());
  };

  syncCoexistence = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const resolved = await this.resolve(request, reply);
    if (!resolved) return;
    const coexistence = this.requireCoexistence(resolved.provider);

    const { type } = (request.body ?? {}) as { type?: 'contacts' | 'history' };
    if (type === 'contacts') await coexistence.syncContacts();
    else if (type === 'history') await coexistence.syncHistory();
    else {
      reply.code(400).send({ error: 'Campo "type" deve ser "contacts" ou "history".' });
      return;
    }
    reply.code(202).send({ requested: type });
  };

  private requireTemplateManager(provider: CommunicationProvider, operation: string) {
    if (!isTemplateManager(provider)) {
      throw new UnsupportedProviderOperationException(provider.name, operation, 'Templates de mensagem são da Meta Cloud API.');
    }
    return provider;
  }

  private requireCoexistence(provider: CommunicationProvider) {
    if (!isCoexistenceManager(provider)) {
      throw new UnsupportedProviderOperationException(provider.name, 'coexistence', 'Coexistence é exclusivo da Meta Cloud API.');
    }
    return provider;
  }

  private async resolve(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ instance: Instance; provider: CommunicationProvider } | undefined> {
    const { id } = request.params as { id: string };
    const instance = await this.instanceRepository.findById(id);
    if (!instance) {
      reply.code(404).send({ error: `Instância "${id}" não encontrada.` });
      return undefined;
    }
    return { instance, provider: await this.instanceProviderRegistry.resolve(id, instance.provider) };
  }
}
