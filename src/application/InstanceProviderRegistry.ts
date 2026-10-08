import type { CommunicationProvider, WhatsAppProviderName } from '../core/interfaces/CommunicationProvider.js';
import type { EventPublisher } from '../core/interfaces/EventPublisher.js';
import type { InstanceRepository } from '../core/interfaces/InstanceRepository.js';
import type { Logger } from '../core/interfaces/Logger.js';
import type { ProviderRegistry } from '../registry/ProviderRegistry.js';
import { ZApiProvider } from '../providers/zapi/ZApiProvider.js';
import { MetaCloudApiProvider } from '../providers/meta/MetaCloudApiProvider.js';
import type { InstanceCredentials } from '../contracts/requests/index.js';

export type { InstanceCredentials } from '../contracts/requests/index.js';

/**
 * Resolve o CommunicationProvider concreto de cada instância criada via API HTTP.
 *
 * A Evolution já é multi-tenant nativamente (um client, N instanceId) — usa sempre o provider
 * compartilhado do ProviderRegistry (registrado uma vez a partir das env vars, igual ao SDK
 * embutido). Z-API e Meta Cloud API não têm esse conceito: cada client representa uma única
 * credencial fixa. Por isso, para essas duas, esta classe constrói (e reaproveita em memória)
 * um provider por instância a partir das credenciais informadas na criação da instância.
 *
 * Como o cache em memória (`perInstanceProviders`) não sobrevive a um restart do processo,
 * `resolve()` sabe reconstruir o provider a partir do `Instance` persistido no
 * `InstanceRepository` (que guarda `credentials`) quando o cache não tem a entrada — sem isso,
 * uma instância zapi/meta "existiria" nos metadados depois de um restart mas não conseguiria
 * mais enviar mensagem.
 */
export class InstanceProviderRegistry {
  private readonly perInstanceProviders = new Map<string, CommunicationProvider>();

  constructor(
    private readonly sharedRegistry: ProviderRegistry,
    private readonly instanceRepository: InstanceRepository,
    private readonly logger: Logger,
    private readonly eventPublisher?: EventPublisher,
  ) {}

  create(instanceId: string, providerName: WhatsAppProviderName, credentials?: InstanceCredentials): CommunicationProvider {
    if (providerName === 'evolution') {
      return this.sharedRegistry.resolve('evolution');
    }

    const provider = this.buildProvider(providerName, credentials, instanceId);
    this.perInstanceProviders.set(instanceId, provider);
    return provider;
  }

  async resolve(instanceId: string, providerName: WhatsAppProviderName): Promise<CommunicationProvider> {
    if (providerName === 'evolution') {
      return this.sharedRegistry.resolve('evolution');
    }

    const cached = this.perInstanceProviders.get(instanceId);
    if (cached) return cached;

    // Cache vazio (ex.: depois de um restart do processo) — reconstrói a partir do que foi
    // persistido na criação da instância.
    const instance = await this.instanceRepository.findById(instanceId);
    if (instance?.credentials) {
      const provider = this.buildProvider(providerName, instance.credentials as InstanceCredentials, instanceId);
      this.perInstanceProviders.set(instanceId, provider);
      return provider;
    }

    throw new Error(`Instância "${instanceId}" não encontrada (provider "${providerName}" não foi criado nesta instância da API).`);
  }

  delete(instanceId: string): void {
    this.perInstanceProviders.delete(instanceId);
  }

  private buildProvider(
    providerName: Exclude<WhatsAppProviderName, 'evolution'>,
    credentials: InstanceCredentials | undefined,
    instanceId: string,
  ): CommunicationProvider {
    if (providerName === 'zapi') {
      if (!credentials?.instanceId || !credentials.token) {
        throw new Error('Credenciais da Z-API (instanceId, token) são obrigatórias para criar esta instância.');
      }
      return new ZApiProvider(
        { name: 'zapi', instanceId: credentials.instanceId, token: credentials.token, clientToken: credentials.clientToken },
        this.logger,
        this.eventPublisher,
      );
    }

    if (providerName !== 'meta') {
      const exhaustive: never = providerName;
      throw new Error(`Provider desconhecido: "${String(exhaustive)}". Valores aceitos: evolution, zapi, meta.`);
    }

    if (!credentials?.phoneNumberId || !credentials.accessToken) {
      throw new Error('Credenciais da Meta Cloud API (phoneNumberId, accessToken) são obrigatórias para criar esta instância.');
    }
    return new MetaCloudApiProvider(
      {
        name: 'meta',
        phoneNumberId: credentials.phoneNumberId,
        accessToken: credentials.accessToken,
        wabaId: credentials.wabaId,
        apiVersion: credentials.apiVersion,
        // O App Secret é do app da Meta (igual para todos os números) — cai no global do ambiente.
        appSecret: credentials.appSecret ?? process.env['WHATSAPP_CLOUD_APP_SECRET'],
        verifyToken: credentials.verifyToken ?? process.env['WHATSAPP_CLOUD_VERIFY_TOKEN'],
        // Id lógico da API HTTP: é o que os eventos carregam (não o phoneNumberId).
        instanceId,
      },
      this.logger,
      this.eventPublisher,
    );
  }
}
