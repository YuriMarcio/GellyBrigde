import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { InstanceProviderRegistry } from '../../application/InstanceProviderRegistry.js';
import type { CreateInstanceApiRequest } from '../../contracts/requests/index.js';
import type { Instance } from '../../core/entities/Instance.js';
import type { InstanceRepository } from '../../core/interfaces/InstanceRepository.js';
import type { Logger } from '../../core/interfaces/Logger.js';

/**
 * Orquestra o ciclo de vida de instâncias via API HTTP: cria (resolve/constrói o provider,
 * chama connect, configura o webhook automaticamente para apontar de volta pra própria API),
 * consulta status, desconecta e valida números. Fino de propósito — a lógica real vive nos
 * providers (Core).
 */
export class InstanceController {
  constructor(
    private readonly instanceRepository: InstanceRepository,
    private readonly instanceProviderRegistry: InstanceProviderRegistry,
    private readonly logger: Logger,
    private readonly publicUrl: string,
  ) {}

  create = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = request.body as CreateInstanceApiRequest;
    const id = body.instanceId ?? randomUUID();

    const provider = this.instanceProviderRegistry.create(id, body.provider, body.credentials);

    await this.instanceRepository.save({
      id,
      provider: body.provider,
      state: 'connecting',
      callbackUrl: body.callbackUrl,
      credentials: body.credentials as Record<string, string> | undefined,
      createdAt: new Date().toISOString(),
    });

    const connectResult = body.provider === 'evolution' && body.existing === true
      ? await provider.getQrCode(id)
      : await provider.connect(id);

    try {
      await provider.setWebhook(id, {
        url: `${this.publicUrl}/v1/webhooks/${body.provider}/${id}`,
        enabled: true,
      });
    } catch (err) {
      this.logger.warn('Falha ao configurar webhook automaticamente na criação da instância', {
        provider: body.provider,
        instanceId: id,
        error: String(err),
      });
    }

    const created = (await this.instanceRepository.findById(id)) as Instance;
    await this.instanceRepository.save({
      ...created,
      state: connectResult.status === 'connected' ? 'open' : 'connecting',
    });

    reply.code(201).send({ instance: await this.instanceRepository.findById(id), connect: connectResult });
  };

  list = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(await this.instanceRepository.list());
  };

  getStatus = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { id } = request.params as { id: string };
    const instance = await this.requireInstance(id, reply);
    if (!instance) return;

    const provider = await this.instanceProviderRegistry.resolve(id, instance.provider);
    reply.send(await provider.getStatus(id));
  };

  /**
   * Busca um QR code novo sem recriar a instância — o QR do Baileys (Evolution/Z-API) expira
   * em segundos, então isso existe pra poder tentar de novo sem perder a instância já criada.
   */
  getQrCode = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { id } = request.params as { id: string };
    const instance = await this.requireInstance(id, reply);
    if (!instance) return;

    const provider = await this.instanceProviderRegistry.resolve(id, instance.provider);
    reply.send(await provider.getQrCode(id));
  };

  /**
   * Código de pareamento (8 dígitos) pra vincular via número de telefone em vez de QR — não
   * recria a instância. `number` (query string) é obrigatório: o código é vinculado a um
   * telefone específico, não dá pra gerar sem saber qual.
   */
  getPairingCode = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { id } = request.params as { id: string };
    const { number } = request.query as { number?: string };
    if (!number) {
      reply.code(400).send({ error: 'Parâmetro "number" (telefone) é obrigatório.' });
      return;
    }

    const instance = await this.requireInstance(id, reply);
    if (!instance) return;

    const provider = await this.instanceProviderRegistry.resolve(id, instance.provider);
    reply.send(await provider.getPairingCode(id, number));
  };

  disconnect = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { id } = request.params as { id: string };
    const instance = await this.requireInstance(id, reply);
    if (!instance) return;

    const provider = await this.instanceProviderRegistry.resolve(id, instance.provider);
    await provider.disconnect(id);
    this.instanceProviderRegistry.delete(id);
    await this.instanceRepository.delete(id);
    reply.code(204).send();
  };

  checkNumbers = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { id } = request.params as { id: string };
    const { numbers } = request.body as { numbers: string[] };
    const instance = await this.requireInstance(id, reply);
    if (!instance) return;

    const provider = await this.instanceProviderRegistry.resolve(id, instance.provider);
    const valid = await provider.checkNumbers(id, numbers);
    reply.send({ valid });
  };

  private async requireInstance(id: string, reply: FastifyReply): Promise<Instance | undefined> {
    const instance = await this.instanceRepository.findById(id);
    if (!instance) {
      reply.code(404).send({ error: `Instância "${id}" não encontrada.` });
      return undefined;
    }
    return instance;
  }
}
