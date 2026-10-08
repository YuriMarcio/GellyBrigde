import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { CustomerServiceWindowClosedException } from '../../core/exceptions/CustomerServiceWindowClosedException.js';
import { ProviderApiException } from '../../core/exceptions/ProviderApiException.js';
import { ProviderConnectionException } from '../../core/exceptions/ProviderConnectionException.js';
import { UnsupportedProviderOperationException } from '../../core/exceptions/UnsupportedProviderOperationException.js';
import type { Logger } from '../../core/interfaces/Logger.js';

/**
 * Mapeia as exceções de core/exceptions para status HTTP — nenhum controller precisa de
 * try/catch próprio para esses casos.
 */
export function createErrorHandler(logger: Logger) {
  return function errorHandler(error: FastifyError | Error, _request: FastifyRequest, reply: FastifyReply): void {
    if (error instanceof UnsupportedProviderOperationException) {
      reply.code(501).send({ error: error.message, provider: error.provider, operation: error.operation });
      return;
    }

    if (error instanceof CustomerServiceWindowClosedException) {
      // 422 com `code` estável: o cliente trata isto (reenviar como template), não é falha do provider.
      reply
        .code(422)
        .send({ error: error.message, code: 'CUSTOMER_SERVICE_WINDOW_CLOSED', provider: error.provider, to: error.to });
      return;
    }

    if (error instanceof ProviderApiException) {
      reply.code(502).send({ error: error.message, provider: error.provider, statusCode: error.statusCode });
      return;
    }

    if (error instanceof ProviderConnectionException) {
      reply.code(502).send({ error: error.message, provider: error.provider });
      return;
    }

    const fastifyStatusCode = (error as FastifyError).statusCode;
    const statusCode = fastifyStatusCode && fastifyStatusCode >= 400 && fastifyStatusCode < 600 ? fastifyStatusCode : 400;

    logger.error('Erro não tratado na API', { error: error.message, statusCode });
    reply.code(statusCode).send({ error: error.message });
  };
}
