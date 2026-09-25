import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const ENV_KEYS = ['EVOLUTION_API_URL', 'EVOLUTION_API_KEY'];

describe('api/instances', () => {
  beforeEach(() => {
    process.env['EVOLUTION_API_URL'] = 'https://evolution.test';
    process.env['EVOLUTION_API_KEY'] = 'key';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  function makeApp(overrides: Parameters<typeof buildServer>[0] = {}) {
    const logger = new ConsoleLogger();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    const instanceRepository = overrides.instanceRepository ?? new InMemoryInstanceRepository();
    return buildServer({ logger, instanceRepository, publicUrl: 'https://flowbridge.test', ...overrides });
  }

  it('POST /v1/instances cria uma instância zapi e retorna 201', async () => {
    const { app } = makeApp({ apiKey: undefined });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      payload: { provider: 'zapi', credentials: { instanceId: 'zapi-1', token: 'tok' } },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.instance.provider).toBe('zapi');
    expect(typeof body.instance.id).toBe('string');
  });

  it('GET /health responde 200 sem exigir x-api-key, mesmo com FLOWBRIDGE_API_KEY configurada', async () => {
    const { app } = makeApp({ apiKey: 'secret' });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('POST /v1/instances sem x-api-key retorna 401 quando FLOWBRIDGE_API_KEY está configurada', async () => {
    const { app } = makeApp({ apiKey: 'secret' });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      payload: { provider: 'evolution' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('POST /v1/instances com x-api-key correta passa pela autenticação', async () => {
    const { app } = makeApp({ apiKey: 'secret' });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: { 'x-api-key': 'secret' },
      payload: { provider: 'evolution' },
    });

    expect(response.statusCode).toBe(201);
  });

  it('GET /v1/instances/:id de instância inexistente retorna 404', async () => {
    const { app } = makeApp({ apiKey: undefined });

    const response = await app.inject({ method: 'GET', url: '/v1/instances/nao-existe' });

    expect(response.statusCode).toBe(404);
  });

  it('DELETE /v1/instances/:id em provider Meta (sem suporte) retorna 501', async () => {
    const { app } = makeApp({ apiKey: undefined });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      payload: { provider: 'meta', credentials: { phoneNumberId: 'PHONE_ID', accessToken: 'tok' } },
    });
    const { instance } = create.json();

    const response = await app.inject({ method: 'DELETE', url: `/v1/instances/${instance.id}` });

    expect(response.statusCode).toBe(501);
    expect(response.json().provider).toBe('meta');
  });

  it('POST /v1/instances/:id/check-numbers em provider Meta (sem suporte) retorna 501', async () => {
    const { app } = makeApp({ apiKey: undefined });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      payload: { provider: 'meta', credentials: { phoneNumberId: 'PHONE_ID', accessToken: 'tok' } },
    });
    const { instance } = create.json();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/instances/${instance.id}/check-numbers`,
      payload: { numbers: ['5598999990000'] },
    });

    expect(response.statusCode).toBe(501);
  });

  it('GET /v1/instances/:id/qrcode busca um QR novo sem recriar a instância zapi', async () => {
    const { app } = makeApp({ apiKey: undefined });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      payload: { provider: 'zapi', credentials: { instanceId: 'zapi-1', token: 'tok' } },
    });
    const { instance } = create.json();

    const response = await app.inject({ method: 'GET', url: `/v1/instances/${instance.id}/qrcode` });

    expect(response.statusCode).toBe(200);
  });

  it('GET /v1/instances/:id/qrcode em provider Meta (sem suporte) retorna 501', async () => {
    const { app } = makeApp({ apiKey: undefined });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      payload: { provider: 'meta', credentials: { phoneNumberId: 'PHONE_ID', accessToken: 'tok' } },
    });
    const { instance } = create.json();

    const response = await app.inject({ method: 'GET', url: `/v1/instances/${instance.id}/qrcode` });

    expect(response.statusCode).toBe(501);
  });

  it('GET /v1/instances/:id/pairing-code busca um código de pareamento pra uma instância evolution', async () => {
    const { app } = makeApp({ apiKey: undefined });

    const create = await app.inject({ method: 'POST', url: '/v1/instances', payload: { provider: 'evolution' } });
    const { instance } = create.json();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/instances/${instance.id}/pairing-code?number=5511999998888`,
    });

    expect(response.statusCode).toBe(200);
  });

  it('GET /v1/instances/:id/pairing-code sem o parâmetro number retorna 400', async () => {
    const { app } = makeApp({ apiKey: undefined });

    const create = await app.inject({ method: 'POST', url: '/v1/instances', payload: { provider: 'evolution' } });
    const { instance } = create.json();

    const response = await app.inject({ method: 'GET', url: `/v1/instances/${instance.id}/pairing-code` });

    expect(response.statusCode).toBe(400);
  });

  it('GET /v1/instances/:id/pairing-code em provider Meta (sem suporte) retorna 501', async () => {
    const { app } = makeApp({ apiKey: undefined });

    const create = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      payload: { provider: 'meta', credentials: { phoneNumberId: 'PHONE_ID', accessToken: 'tok' } },
    });
    const { instance } = create.json();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/instances/${instance.id}/pairing-code?number=5511999998888`,
    });

    expect(response.statusCode).toBe(501);
  });

  it('GET /v1/instances lista as instâncias criadas', async () => {
    const { app } = makeApp({ apiKey: undefined });

    await app.inject({ method: 'POST', url: '/v1/instances', payload: { provider: 'evolution' } });
    const response = await app.inject({ method: 'GET', url: '/v1/instances' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
  });
});
