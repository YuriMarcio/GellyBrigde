import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/api/buildServer.js';
import { InMemoryInstanceRepository } from '../../src/infrastructure/persistence/InMemoryInstanceRepository.js';
import { ConsoleLogger } from '../../src/infrastructure/logging/ConsoleLogger.js';

vi.mock('axios', async () => {
  const actual = await vi.importActual<typeof axios>('axios');
  return {
    default: {
      ...actual.default,
      create: vi.fn(() => ({
        post: vi.fn().mockResolvedValue({ data: {} }),
        get: vi.fn().mockResolvedValue({ data: {} }),
        put: vi.fn().mockResolvedValue({ data: {} }),
        delete: vi.fn().mockResolvedValue({ data: {} }),
      })),
      isAxiosError: actual.default.isAxiosError,
    },
  };
});

describe('api/groups', () => {
  function makeApp() {
    const logger = new ConsoleLogger();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    return buildServer({ logger, instanceRepository: new InMemoryInstanceRepository(), apiKey: undefined });
  }

  async function createZapiInstance(app: ReturnType<typeof makeApp>['app']): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      payload: { provider: 'zapi', credentials: { instanceId: 'zapi-1', token: 'tok' } },
    });
    return response.json().instance.id;
  }

  it('POST /v1/instances/:id/groups retorna 400 sem subject/participants', async () => {
    const { app } = makeApp();
    const id = await createZapiInstance(app);

    const response = await app.inject({ method: 'POST', url: `/v1/instances/${id}/groups`, payload: {} });

    expect(response.statusCode).toBe(400);
  });

  it('POST /v1/instances/:id/groups retorna 404 pra instância inexistente', async () => {
    const { app } = makeApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/instances/nao-existe/groups',
      payload: { subject: 'Entregadores', participants: ['5598999990000'] },
    });

    expect(response.statusCode).toBe(404);
  });

  it('POST /v1/instances/:id/groups retorna 501 num provider sem suporte a grupos (Z-API ainda não implementado)', async () => {
    const { app } = makeApp();
    const id = await createZapiInstance(app);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/instances/${id}/groups`,
      payload: { subject: 'Entregadores', participants: ['5598999990000'] },
    });

    expect(response.statusCode).toBe(501);
  });
});
