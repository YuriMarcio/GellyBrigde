import type { EvolutionProviderConfig, MetaProviderConfig, ZApiProviderConfig } from '../contracts/dto/index.js';
import type { PostgresConfig } from '../infrastructure/persistence/PostgresInstanceRepository.js';

/**
 * Centraliza a leitura de variáveis de ambiente por provider (antes espalhada dentro de
 * factory.ts). Cada função retorna `undefined` quando as variáveis obrigatórias daquele
 * provider não estão configuradas — quem chama decide se isso é um erro ou só "provider não
 * habilitado".
 */

export function readEvolutionEnv(): EvolutionProviderConfig | undefined {
  const baseUrl = process.env['EVOLUTION_API_URL'];
  const apiKey = process.env['EVOLUTION_API_KEY'];
  if (!baseUrl || !apiKey) return undefined;

  return {
    name: 'evolution',
    baseUrl,
    apiKey,
    // Opt-out: erro de provider vira ProviderApiException (mapeado pra 502 no errorHandler).
    // Setar 'false' restaura o modo silencioso antigo (loga e retorna {} — mascara falhas
    // como sucesso HTTP 200, ex.: sendList com 400 da Evolution virando {"raw":{}}).
    throwOnError: process.env['EVOLUTION_THROW_ON_ERROR'] !== 'false',
    timeout: Number(process.env['EVOLUTION_TIMEOUT_MS'] ?? 15_000),
  };
}

export function readZApiEnv(): ZApiProviderConfig | undefined {
  const instanceId = process.env['ZAPI_INSTANCE_ID'];
  const token = process.env['ZAPI_TOKEN'];
  if (!instanceId || !token) return undefined;

  return {
    name: 'zapi',
    instanceId,
    token,
    clientToken: process.env['ZAPI_CLIENT_TOKEN'],
    throwOnError: process.env['ZAPI_THROW_ON_ERROR'] !== 'false',
    timeout: Number(process.env['ZAPI_TIMEOUT_MS'] ?? 15_000),
  };
}

export function readMetaEnv(): MetaProviderConfig | undefined {
  const phoneNumberId = process.env['WHATSAPP_CLOUD_PHONE_NUMBER_ID'];
  const accessToken = process.env['WHATSAPP_CLOUD_ACCESS_TOKEN'];
  if (!phoneNumberId || !accessToken) return undefined;

  return {
    name: 'meta',
    phoneNumberId,
    accessToken,
    wabaId: process.env['WHATSAPP_CLOUD_WABA_ID'],
    apiVersion: process.env['WHATSAPP_CLOUD_API_VERSION'] ?? 'v23.0',
    appSecret: process.env['WHATSAPP_CLOUD_APP_SECRET'],
    verifyToken: process.env['WHATSAPP_CLOUD_VERIFY_TOKEN'],
    throwOnError: process.env['WHATSAPP_THROW_ON_ERROR'] !== 'false',
    timeout: Number(process.env['WHATSAPP_TIMEOUT_MS'] ?? 15_000),
  };
}

export interface ApiEnvConfig {
  apiKey: string | undefined;
  publicUrl: string;
  port: number;
}

/**
 * Env vars específicas da camada api/ (servidor HTTP). `apiKey` undefined desabilita a
 * checagem de `x-api-key` (útil em desenvolvimento local) — documentado no README como algo
 * a nunca fazer em produção.
 */
export function readApiEnv(): ApiEnvConfig {
  return {
    apiKey: process.env['FLOWBRIDGE_API_KEY'],
    publicUrl: (process.env['FLOWBRIDGE_PUBLIC_URL'] ?? 'http://localhost:3000').replace(/\/$/, ''),
    port: Number(process.env['PORT'] ?? 3000),
  };
}

/**
 * Configuração do Postgres usado para persistir instâncias (`PostgresInstanceRepository`) —
 * funciona com Supabase ou qualquer Postgres gerenciado, só precisa da connection string. A
 * API HTTP real (`api/server.ts`) exige essa variável; sem ela, falha explicitamente no boot em
 * vez de cair silenciosamente em memória (que reintroduziria instâncias sendo perdidas a cada
 * restart).
 */
export function readPostgresEnv(): PostgresConfig {
  const connectionString = process.env['DATABASE_URL'];

  if (!connectionString) {
    throw new Error(
      '[FlowBridge API] DATABASE_URL é obrigatória (persistência de instâncias) — connection string ' +
        'do Postgres/Supabase. Ver .env.example.',
    );
  }

  return { connectionString, ssl: process.env['DATABASE_SSL'] !== 'false' };
}
