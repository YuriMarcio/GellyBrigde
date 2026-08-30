import Fastify, { type FastifyInstance } from 'fastify';
import { InstanceProviderRegistry } from '../application/InstanceProviderRegistry.js';
import { readApiEnv, readEvolutionEnv, readPostgresEnv } from '../config/env.js';
import type { EventPublisher } from '../core/interfaces/EventPublisher.js';
import type { InstanceRepository } from '../core/interfaces/InstanceRepository.js';
import type { Logger } from '../core/interfaces/Logger.js';
import { HttpForwardingEventPublisher } from '../infrastructure/events/HttpForwardingEventPublisher.js';
import { ConsoleLogger } from '../infrastructure/logging/ConsoleLogger.js';
import { PostgresInstanceRepository } from '../infrastructure/persistence/PostgresInstanceRepository.js';
import { EvolutionProvider } from '../providers/evolution/EvolutionProvider.js';
import { ProviderRegistry } from '../registry/ProviderRegistry.js';
import { GroupController } from './controllers/GroupController.js';
import { InstanceController } from './controllers/InstanceController.js';
import { MessageController } from './controllers/MessageController.js';
import { WebhookController } from './controllers/WebhookController.js';
import { createApiKeyAuth } from './middlewares/apiKeyAuth.js';
import { createErrorHandler } from './middlewares/errorHandler.js';
import { registerGroupRoutes } from './routes/groups.js';
import { registerInstanceRoutes } from './routes/instances.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerWebhookRoutes } from './routes/webhooks.js';

export interface BuildServerOptions {
  logger?: Logger;
  instanceRepository?: InstanceRepository;
  eventPublisher?: EventPublisher;
  apiKey?: string;
  publicUrl?: string;
}

export interface BuiltServer {
  app: FastifyInstance;
  port: number;
}

/**
 * Monta o Fastify app com todas as dependências já resolvidas, sem chamar `listen` — permite
 * testar via `app.inject()` sem precisar de uma porta real. `server.ts` é o único lugar que
 * chama `listen`.
 */
export function buildServer(options: BuildServerOptions = {}): BuiltServer {
  const apiEnv = readApiEnv();
  const logger = options.logger ?? new ConsoleLogger();
  const publicUrl = (options.publicUrl ?? apiEnv.publicUrl).replace(/\/$/, '');
  const apiKey = options.apiKey ?? apiEnv.apiKey;

  // Sem opção explícita (caso real de produção, api/server.ts), persiste em Postgres (Supabase
  // ou qualquer outro) — instâncias (e as credenciais necessárias pra reconstruir o provider)
  // sobrevivem a um restart do processo/container. Testes sempre passam
  // InMemoryInstanceRepository explicitamente.
  const instanceRepository = options.instanceRepository ?? new PostgresInstanceRepository(readPostgresEnv(), logger);
  const eventPublisher = options.eventPublisher ?? new HttpForwardingEventPublisher(instanceRepository, logger);

  // Evolution é multi-tenant nativamente — um único provider compartilhado, configurado via
  // env, cobre todas as instâncias Evolution criadas pela API (mesmo padrão do SDK embutido).
  const providerRegistry = new ProviderRegistry();
  const evolutionConfig = readEvolutionEnv();
  if (evolutionConfig) {
    providerRegistry.register(new EvolutionProvider(evolutionConfig, logger, eventPublisher));
  }

  const instanceProviderRegistry = new InstanceProviderRegistry(providerRegistry, instanceRepository, logger, eventPublisher);

  const app = Fastify({ logger: false });

  // Preserva o Buffer bruto do corpo — a Meta calcula X-Hub-Signature-256 sobre os bytes
  // originais, não sobre um JSON reserializado, então o parser padrão não serve para isso.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const buffer = body as Buffer;
    (req as unknown as { rawBody: Buffer }).rawBody = buffer;
    if (buffer.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(buffer.toString('utf8')));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.setErrorHandler(createErrorHandler(logger));

  // Sem autenticação de propósito — usado por healthcheck do Docker/orquestrador/load balancer.
  app.get('/health', async () => ({ status: 'ok' }));

  const instanceController = new InstanceController(instanceRepository, instanceProviderRegistry, logger, publicUrl);
  const messageController = new MessageController(instanceRepository, instanceProviderRegistry);
  const groupController = new GroupController(instanceRepository, instanceProviderRegistry);
  const webhookController = new WebhookController(instanceRepository, instanceProviderRegistry, eventPublisher, logger);

  // Rotas autenticadas por x-api-key (consumidor → FlowBridge).
  app.register(async (scoped) => {
    scoped.addHook('preHandler', createApiKeyAuth(apiKey));
    registerInstanceRoutes(scoped, instanceController);
    registerMessageRoutes(scoped, messageController);
    registerGroupRoutes(scoped, groupController);
  });

  // Webhooks são chamados PELO provider (Evolution/Z-API/Meta) — sem x-api-key.
  app.register(async (scoped) => {
    registerWebhookRoutes(scoped, webhookController);
  });

  return { app, port: apiEnv.port };
}
