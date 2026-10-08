<div align="center">

# 🌉 FlowBridge

**Communication Platform para WhatsApp.**
Uma interface única para Evolution API, Z-API e a API oficial da Meta.

*Build once. Connect everywhere.*

</div>

<br>

> [!NOTE]
> Este pacote é o SDK oficial **e** a API HTTP do FlowBridge. Trocar de provider é **mudar
> configuração** — nenhum código consumidor precisa mudar. Sem regra de negócio, sem UI: só
> infraestrutura de comunicação (conexão, instância, webhook, mensagens, botões, listas,
> carrossel). Projetos TS/JS podem embutir o SDK diretamente no processo; **qualquer outra
> linguagem (PHP incluso)** fala com o [`api/`](#-api-http-api) por HTTP simples. Arquitetura
> completa em [`ARCHITECTURE.md`](./ARCHITECTURE.md) e [`VISION.md`](./VISION.md).

<br>

## 📑 Índice

- [Por que existe](#-por-que-existe)
- [Como funciona](#-como-funciona)
- [Instalação](#-instalação)
- [Início rápido](#-início-rápido)
- [Providers suportados](#-providers-suportados)
- [Matriz de capacidades](#-matriz-de-capacidades)
- [API HTTP (`api/`)](#-api-http-api)
- [Coexistence (Meta Cloud API)](#-coexistence-meta-cloud-api)
- [Logger & Eventos de domínio](#-logger--eventos-de-domínio)
- [ThrottledSender](#-throttledsender--disparos-seguros-em-prospecção)
- [Arquitetura de pastas](#-arquitetura-de-pastas)
- [Testes](#-testes)
- [Uso legado (`@sinal/evolution-client`)](#-uso-legado-sinalevolution-client)

<br>

## 🎯 Por que existe

Sem o FlowBridge, cada provider de WhatsApp traz sua própria API, autenticação, payloads e
webhooks — trocar de provider (ou usar mais de um) significa reescrever integração.

```mermaid
flowchart LR
    subgraph antes["❌ Sem FlowBridge"]
        direction TB
        A1[App] -.-> E1[Evolution API]
        A2[App] -.-> Z1[Z-API]
        A3[App] -.-> M1[Meta Cloud API]
    end
```

Cada seta pontilhada acima é um código de integração diferente, mantido separadamente. Com o
FlowBridge, a aplicação conhece só uma interface — o provider vira detalhe de configuração:

```mermaid
flowchart LR
    App[Sua Aplicação] --> SDK["FlowBridge SDK<br/>createFlowBridgeClient()"]
    SDK --> Registry[["ProviderRegistry"]]
    Registry --> Evolution[EvolutionProvider]
    Registry --> ZApi[ZApiProvider]
    Registry --> Meta[MetaCloudApiProvider]
    Evolution -.-> EvoAPI[(Evolution API)]
    ZApi -.-> ZApiAPI[(Z-API)]
    Meta -.-> MetaAPI[(Meta Cloud API)]
```

<br>

## ⚙️ Como funciona

Todos os providers implementam o mesmo contrato (`CommunicationProvider`). O
`ProviderRegistry` é o **único** lugar do sistema que sabe resolver um provider pelo nome —
nenhuma outra camada tem `if (provider === 'evolution')`.

```mermaid
flowchart TB
    sdk["🧩 SDK embutido (TS/JS)<br/>createFlowBridgeClient()"]
    api["🌐 api/<br/>Fastify — REST, qualquer linguagem"]
    application["🧩 application/<br/>use-cases + InstanceProviderRegistry"]
    contracts["📦 contracts/<br/>dto · requests · responses · schemas (zod)"]
    core["🧠 core/<br/>CommunicationProvider · entities · events · exceptions"]
    registry["🗂️ registry/<br/>ProviderRegistry"]
    providers["🔌 providers/<br/>evolution · zapi · meta"]

    sdk --> application
    api --> application
    application --> contracts --> core
    application --> registry --> providers --> core
```

Dois pontos de entrada, mesmo Core por baixo: o **SDK embutido** roda dentro do processo da
aplicação TS/JS (sem servidor, sem rede — é o que o SINAL já usa hoje); a **API HTTP**
(`api/`) é o mesmo Core exposto como serviço, para qualquer linguagem que não seja TS/Node
(ex.: PHP) ou para quem prefere gestão centralizada de instâncias. Nenhuma camada de negócio
sabe qual dos dois está sendo usado — ambos terminam no mesmo `ProviderRegistry`.

> [!TIP]
> Uma operação que um provider genuinamente não suporta (ex.: `checkNumbers` na Meta Cloud
> API) lança `UnsupportedProviderOperationException` em vez de simular um comportamento que
> não existe. Veja a [matriz de capacidades](#-matriz-de-capacidades).

<br>

## 📥 Instalação

```json
// package.json
{
  "dependencies": {
    "@sinal/evolution-client": "github:sinal-app/evolution-client"
  }
}
```

```bash
npm install
```

<br>

## 🚀 Início rápido

**1. Configure as variáveis de ambiente** do(s) provider(s) que for usar:

<table>
<tr><th>Provider</th><th>Variáveis de ambiente</th></tr>
<tr>
<td><code>evolution</code></td>
<td>

`EVOLUTION_API_URL` · `EVOLUTION_API_KEY` · `EVOLUTION_THROW_ON_ERROR` · `EVOLUTION_TIMEOUT_MS`

</td>
</tr>
<tr>
<td><code>zapi</code></td>
<td>

`ZAPI_INSTANCE_ID` · `ZAPI_TOKEN` · `ZAPI_CLIENT_TOKEN` · `ZAPI_THROW_ON_ERROR` · `ZAPI_TIMEOUT_MS`

</td>
</tr>
<tr>
<td><code>meta</code></td>
<td>

`WHATSAPP_CLOUD_PHONE_NUMBER_ID` · `WHATSAPP_CLOUD_ACCESS_TOKEN` · `WHATSAPP_CLOUD_WABA_ID` · `WHATSAPP_CLOUD_API_VERSION` · `WHATSAPP_THROW_ON_ERROR` · `WHATSAPP_TIMEOUT_MS`

</td>
</tr>
</table>

**2. Crie o client** — `createFlowBridgeClient()` sem argumentos já registra todo provider
cujas variáveis obrigatórias estiverem presentes:

```ts
import { createFlowBridgeClient } from '@sinal/evolution-client';

const flowBridge = createFlowBridgeClient();
```

Ou, com configuração explícita — dá para registrar **mais de um provider ao mesmo tempo**:

```ts
const flowBridge = createFlowBridgeClient({
  providers: [
    { name: 'evolution', baseUrl: 'https://evolution.seudominio.com', apiKey: '...' },
    { name: 'meta', phoneNumberId: '...', accessToken: '...', wabaId: '...' },
  ],
});
```

**3. Envie mensagens.** Todo método recebe um único objeto `{ provider, instanceId, ... }`:

```ts
await flowBridge.sendText({
  provider: 'evolution',
  instanceId: 'prospeccao-01',
  to: '5598999990000',
  text: 'Olá!',
});

await flowBridge.sendButtons({
  provider: 'meta',
  instanceId: 'PHONE_NUMBER_ID',
  to: '5598999990000',
  content: {
    body: 'Confirma o agendamento?',
    buttons: [
      { id: 'SIM', displayText: 'Sim' },
      { id: 'NAO', displayText: 'Não' },
    ],
  },
});

await flowBridge.sendCarousel({
  provider: 'evolution',
  instanceId: 'prospeccao-01',
  to: '5598999990000',
  content: {
    body: 'Confira nossos planos:',
    cards: [{
      title: 'Plano Pro',
      body: 'R$ 350/mês',
      imageUrl: 'https://img/pro.jpg',
      buttons: [{ id: 'PRO', displayText: 'Quero esse' }],
    }],
  },
});
```

<br>

## 🔌 Providers suportados

| | Evolution API | Z-API | Meta Cloud API |
|---|---|---|---|
| **Tipo** | Self-hosted (Baileys) | SaaS (Baileys) | API oficial do WhatsApp Business Platform |
| **Conexão** | QR code | QR code | Provisionado no Meta Business Manager |
| **Custo** | Infra própria | Assinatura | Por conversa (Meta) |
| **Ideal para** | Controle total, custo previsível | Rapidez pra subir, sem manter infra | Conta oficial verificada, escala, Coexistence |

<br>

## 📋 Matriz de capacidades

✅ suportado nativamente · ⚠️ suportado com ressalvas (leia a observação) · ❌ lança `UnsupportedProviderOperationException`

| Operação | Evolution | Z-API | Meta Cloud API |
|---|:---:|:---:|:---:|
| `connect` (instância + QR) | ✅ | ✅ | ⚠️ sem QR — número já vem provisionado; só confirma que está ativo |
| `disconnect` | ✅ | ✅ | ❌ não existe via API |
| `getStatus` | ✅ | ✅ | ✅ lê o `status` do número na Graph API (`CONNECTED`→open, `PENDING`→connecting, demais→close) |
| `setWebhook` | ✅ | ✅ | ✅ inscreve o app na WABA e grava o override de callback do número *(precisa de `wabaId`; sem `verifyToken` o callback fica manual)* |
| `getMediaBase64` | ✅ | ❌ | ✅ pelo `media_id` (`normalized.mediaId`), não pelo id da mensagem |
| `sendSticker` | ✅ | ✅ | ✅ |
| `getQrCode` / `getPairingCode` | ✅ | ✅ | ❌ sem conceito na Cloud API |
| Grupos (`createGroup`, `addGroupParticipants`, `promoteGroupAdmins`, `getGroupInviteCode`) | ✅ | ❌ | ❌ |
| `checkNumbers` | ✅ | ✅ | ❌ sem endpoint equivalente |
| `sendText` / `sendImage` / `sendAudio` / `sendVideo` / `sendDocument` / `sendLocation` | ✅ | ✅ | ✅ |
| `sendButtons` | ✅ | ✅ | ✅ máx. 3 botões de resposta, título ≤20 chars *(validado)*. **Um** botão `url` vira CTA (`cta_url`); `url`/`call`/`copy` misturados com outros são recusados |
| `sendList` | ✅ com seções | ✅ seções achatadas em lista única | ✅ máx. 10 seções / 10 linhas *(validado)* |
| `sendCarousel` | ✅ freeform | ✅ freeform | ✅ **carrossel interativo** (mensagem de serviço: sem template, sem aprovação, só na janela de 24h). Regras validadas antes de chamar: 2–10 cards, corpo principal obrigatório (≤1024), cada card com imagem **JPEG/PNG** por link (WebP não renderiza), texto do card ≤160 caracteres e ≤2 quebras de linha, e **mesmo tipo e quantidade de botões em todos os cards** (UM botão `url` OU botões de resposta, título ≤20, `id` ≤256). `providerOptions` é ignorado |
| `sendReaction` | ✅ | ✅ | ✅ |
| `sendTemplate` | ❌ | ❌ | ✅ único jeito de iniciar conversa / responder fora das 24h (inclusive carrossel de **template** de Marketing, via `components`) |
| Gerenciar templates (listar, criar, apagar) | ❌ | ❌ | ✅ exige `wabaId` |
| `markAsRead` + "digitando…" | ❌ | ❌ | ✅ |
| Receber mensagem **normalizada** (`payload.normalized`) | ❌ cru (Baileys) | ❌ | ✅ tipo, texto, `buttonReplyId`, `listReplyId`, `mediaId`, localização... |

> [!NOTE]
> **Toque em botão na Meta chega em três formatos** e os três viram o mesmo `normalized.buttonReplyId` /
> `listReplyId` (o id que você enviou): `interactive.button_reply.id` (botões comuns), `interactive.list_reply.id`
> (lista) e `type: "button"` com `button.payload` (quick reply de template — e, segundo fontes de terceiros, o do
> carrossel interativo; a referência oficial do webhook só documenta o caso do template). O webhook **não diz qual
> card foi tocado**: o `id` do botão tem de carregar o que o backend precisa (`flow_add1_loja_12`). Um toque `button`
> deixa o payload bruto no log (`Meta: toque em botão (type "button") — payload bruto`, nível `info`) para confirmar o
> formato com o primeiro clique real; `interactive.type` ou `message.type` desconhecidos geram `warn` com o payload
> bruto em vez de sumir.

> [!TIP]
> Esta tabela existe em código: `PROVIDER_CAPABILITIES` (`core/interfaces/BusinessCapabilities.ts`),
> exposta em `GET /v1/instances/:id/capabilities` com os limites de cada provider. Quem monta
> mensagens deve consultá-la para adaptar o conteúdo em vez de descobrir pelo erro 501/422. Os
> testes (`tests/providers/CrossProviderContract.test.ts`) travam a tabela contra o comportamento real.

<br>

## 🌐 API HTTP (`api/`)

> [!IMPORTANT]
> Existe porque **PHP (e qualquer linguagem que não seja TS/Node) não consegue importar o
> SDK** — as alternativas seriam portar a lógica pra PHP (duplica manutenção) ou chamar Node
> via shell/FFI (frágil). A API HTTP resolve isso: mesmo Core, exposto como serviço, com uma
> chave de API simples.

**1. Configure e suba o servidor:**

```env
# .env
FLOWBRIDGE_API_KEY=uma-chave-forte-aqui       # sem isso, a API fica sem autenticação (só dev local)
FLOWBRIDGE_PUBLIC_URL=https://flowbridge.seudominio.com   # usada para registrar o webhook de volta nos providers
PORT=3000

# + as env vars de provider já vistas em "Início rápido" (a Evolution é lida do ambiente
# automaticamente; Z-API e Meta são configurados por instância via POST /v1/instances)
```

```bash
npm run dev     # desenvolvimento (tsx watch)
npm run build && npm start   # produção
```

**2. Crie uma instância** — a API resolve/constrói o provider certo, chama `connect()` e já
registra o próprio `api/` como webhook do provider automaticamente:

```bash
curl -X POST https://flowbridge.seudominio.com/v1/instances \
  -H "x-api-key: uma-chave-forte-aqui" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "zapi",
    "credentials": { "instanceId": "SEU_INSTANCE_ID", "token": "SEU_TOKEN" },
    "callbackUrl": "https://seuapp.com/webhooks/whatsapp"
  }'
# → 201 { "instance": { "id": "...", "provider": "zapi", "state": "connecting", ... }, "connect": { ... } }
```

`callbackUrl` é para onde a API **repassa** os eventos normalizados (`MessageReceived`,
`MessageDelivered`, `MessageRead`, `InstanceConnected`, ...) via `POST` — não precisa
implementar nada específico de Evolution/Z-API/Meta do outro lado, só receber JSON.

**3. Envie mensagens e gerencie a instância:**

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/v1/instances` | Cria instância (resolve provider, conecta, configura webhook) |
| `GET` | `/v1/instances` | Lista instâncias |
| `GET` | `/v1/instances/:id` | Status da instância |
| `GET` | `/v1/instances/:id/qrcode` | Busca um QR **novo** sem recriar a instância — o QR do Baileys (Evolution/Z-API) expira em segundos; chame de novo se expirar (❌ 501 na Meta — não existe QR na Cloud API) |
| `DELETE` | `/v1/instances/:id` | Desconecta (❌ 501 na Meta — sem suporte) |
| `POST` | `/v1/instances/:id/check-numbers` | Valida números em lote (❌ 501 na Meta) |
| `POST` | `/v1/instances/:id/messages/:type` | Envia mensagem — `:type` = `text\|image\|audio\|video\|document\|location\|buttons\|list\|carousel\|reaction` |
| `POST` | `/v1/instances/:id/messages/template` | Envia template aprovado (só Meta; 501 nos outros) — body `{ to, template: { name, languageCode, header?, bodyParameters?, buttons?, components? } }` |
| `POST` | `/v1/instances/:id/messages/read` | Marca como lida; `typingIndicator: true` mostra "digitando…" (só Meta) — body `{ messageId, typingIndicator? }` |
| `GET` | `/v1/instances/:id/media/:messageId` | Mídia recebida em base64. **Na Meta o parâmetro é o `media_id`** (`normalized.mediaId`) |
| `GET` | `/v1/instances/:id/capabilities` | O que o provider da instância suporta e quais os limites (botões, linhas de lista...) |
| `GET` `POST` `DELETE` | `/v1/instances/:id/templates[/:name]` | Lista / cria / apaga templates (só Meta, exige `wabaId`) |
| `GET` | `/v1/instances/:id/coexistence` | Estado do número (`isOnBizApp`, `platformType`) — só Meta |
| `POST` | `/v1/instances/:id/coexistence/sync` | Body `{ type: "contacts" \| "history" }` — sincronização pós-onboarding (**janela de 24h**) |
| `GET` | `/v1/webhooks/:provider/:instanceId` | Handshake da Meta (`hub.challenge`) — público |
| `POST` | `/v1/webhooks/:provider/:instanceId` | Recebida **do** provider — pública, sem `x-api-key`. O provider da URL precisa ser o da instância (senão 404) |

**Erro 422 `CUSTOMER_SERVICE_WINDOW_CLOSED`:** mensagem livre para quem não falou com o número nas
últimas 24h (Meta, erro 131047). Não é falha do provider: reenvie como template
(`messages/template`).

```bash
curl -X POST https://flowbridge.seudominio.com/v1/instances/SEU_ID/messages/text \
  -H "x-api-key: uma-chave-forte-aqui" \
  -H "Content-Type: application/json" \
  -d '{ "to": "5598999990000", "text": "Olá do PHP!" }'
```

Todas as rotas (exceto `/v1/webhooks/*`) exigem o header `x-api-key` quando
`FLOWBRIDGE_API_KEY` está configurada — requisição sem a chave certa recebe `401`.

> [!NOTE]
> `InstanceRepository` persiste em **Postgres** (`PostgresInstanceRepository`) — funciona com
> Supabase ou qualquer Postgres gerenciado, só usa a connection string padrão (nenhuma API
> específica do Supabase). Instâncias sobrevivem a restart/redeploy do container, credenciais
> incluídas: `InstanceProviderRegistry` reconstrói o `CommunicationProvider` de cada instância
> zapi/meta a partir do que está salvo no banco assim que ele é usado de novo depois de um
> restart. O repasse de eventos continua HTTP direto pra `callbackUrl` (sem fila/retry) —
> documentado como o próximo passo.

### 🐳 Rodando com Docker (recomendado para produção)

O banco fica hospedado no Supabase (ou outro Postgres gerenciado) — o `docker-compose.yml` só
sobe o container da API, sem serviço de banco local.

```bash
cp .env.example .env
# preencha FLOWBRIDGE_API_KEY, FLOWBRIDGE_PUBLIC_URL, e DATABASE_URL
# (DATABASE_URL vem do seu projeto Supabase: Project Settings → Database → Connection string)

docker compose up -d --build
docker compose logs -f flowbridge   # acompanhar
docker compose down                 # parar
```

- **API**: `http://localhost:3000` (`PORT` no `.env`)
- **Banco**: gerenciado pelo dashboard do Supabase (Table Editor / SQL Editor) — não precisa de
  Adminer nem de nenhuma UI local, o Supabase já tem a própria.

> [!CAUTION]
> A coluna `instances.credentials` guarda os segredos de cada instância (token da Z-API,
> access token da Meta) como **JSON em texto plano** — é o preço de reconstruir o provider
> automaticamente depois de um restart. Trate a tabela `instances` como dado sensível: restrinja
> quem tem acesso ao projeto Supabase, nunca commite `DATABASE_URL` (já coberto pelo
> `.gitignore`), e trate dump/backup do banco como material sensível.

Sem `docker compose`, basta apontar `DATABASE_URL` pro Postgres/Supabase no `.env` e rodar só o
container da API:

```bash
docker build -t flowbridge .
docker run -d --name flowbridge -p 3000:3000 --env-file .env --restart unless-stopped flowbridge
```

A imagem é multi-stage (build compila TS, runtime só leva `dist/` + deps de produção, roda
como usuário não-root) e expõe `GET /health` sem autenticação — usado pelo `HEALTHCHECK` da
própria imagem e serve pra load balancer/orquestrador (k8s liveness probe, etc.) apontar pra lá.

<br>

## 🔄 Coexistence (Meta Cloud API)

> [!IMPORTANT]
> Exclusivo da Cloud API: o mesmo número continua ativo no **app WhatsApp Business** (celular)
> **e** na Cloud API ao mesmo tempo, com mensagens espelhadas entre os dois lados.

Pela API HTTP: `GET /v1/instances/:id/coexistence` (o número está no app?) e
`POST /v1/instances/:id/coexistence/sync` (`{"type":"contacts"}` e depois `{"type":"history"}`).
Pelo SDK, `MetaCloudApiProvider` expõe os mesmos métodos:

```ts
import { MetaCloudApiProvider } from '@sinal/evolution-client';

const meta = new MetaCloudApiProvider({ name: 'meta', phoneNumberId, accessToken, wabaId }, logger);

await meta.getPhoneNumberInfo();  // { isOnBizApp, platformType }
await meta.syncContacts();        // sincronização pós-onboarding — janela de 24h
await meta.syncHistory();
```

> [!WARNING]
> O onboarding que **ativa** o Coexistence (Embedded Signup em modo "conectar app WhatsApp
> Business existente") acontece na Meta, não aqui — o FlowBridge só cuida do que vem depois. Depois
> do onboarding você tem **24h** para chamar as duas sincronizações; passou disso, o número
> precisa sair e refazer o fluxo.

As três chaves de webhook exclusivas de Coexistence — `history`, `smb_app_state_sync`,
`smb_message_echoes` — precisam ser inscritas **manualmente no App Dashboard da Meta**; não há
chamada de API para isso. Uma vez inscritas, a [API HTTP](#-api-http-api) já reconhece e
normaliza os três (`MetaCloudApiProvider.parseWebhookPayload`), publicando como eventos de
domínio igual aos demais. Os payloads brutos ficam tipados em `contracts/dto`:

| Tipo | Descrição |
|---|---|
| `HistorySyncWebhookPayload` | Mensagens antigas, particionadas em `phase` / `chunkOrder` / `progress` |
| `SmbAppStateSyncWebhookPayload` | Contatos adicionados/removidos no app (`action: 'add' \| 'remove'`) |
| `SmbMessageEchoWebhookPayload` | Mensagens enviadas pelo app WhatsApp Business após o onboarding |

<br>

## 🧩 Logger & Eventos de domínio

```ts
import { createFlowBridgeClient, type Logger } from '@sinal/evolution-client';

const meuLogger: Logger = {
  debug: (msg, ctx) => minhaLib.debug(msg, ctx),
  info: (msg, ctx) => minhaLib.info(msg, ctx),
  warn: (msg, ctx) => minhaLib.warn(msg, ctx),
  error: (msg, ctx) => minhaLib.error(msg, ctx),
};

const flowBridge = createFlowBridgeClient({
  logger: meuLogger,
  eventPublisher: { publish: (event) => meuBarramento.emit(event.type, event) },
});
```

| Evento | Quando dispara |
|---|---|
| `InstanceConnected` | Instância fica com `state: 'open'` |
| `InstanceDisconnected` | `disconnect()` é chamado com sucesso |
| `QRCodeGenerated` | Um novo QR code é retornado por `connect()` |
| `MessageSent` | Qualquer `send*` é concluído |

`MessageReceived` / `MessageDelivered` / `MessageRead` têm o formato definido em
`core/events` e são emitidos pela [API HTTP](#-api-http-api) — o SDK embutido sozinho não roda
servidor, então não recebe webhooks inbound diretamente; quem processa webhook é sempre o
`api/`, que repassa o evento já normalizado para o `callbackUrl` da instância.

<br>

## 🛡️ ThrottledSender — disparos seguros em prospecção

```ts
import { ThrottledSender, createFlowBridgeClient } from '@sinal/evolution-client';

const flowBridge = createFlowBridgeClient();
const sender = new ThrottledSender({ minMs: 8_000, maxMs: 15_000 });

const valid = await flowBridge.checkNumbers({
  provider: 'evolution',
  instanceId: 'prospeccao-01',
  numbers: rawNumbers,
});

await sender.batch(
  valid,
  (number) => flowBridge.sendText({ provider: 'evolution', instanceId: 'prospeccao-01', to: number, text: mensagem }),
  {
    onSent:  (n, _, i, total) => console.log(`[${i}/${total}] ✓ ${n}`),
    onError: (n, err, i)      => console.error(`[${i}] ✗ ${n}: ${err.message}`),
  },
);
```

> [!WARNING]
> Nunca use delay < 8s em instâncias Baileys (Evolution/Z-API) em produção — rajadas
> aumentam o score de ban da instância.

<br>

## 📁 Arquitetura de pastas

<details>
<summary><strong>Ver árvore completa de <code>src/</code></strong></summary>

```
src/
  core/            → CommunicationProvider, entidades, value objects, eventos, exceptions
                     (não conhece HTTP, providers nem frameworks)
  contracts/       → dto · requests · responses · events · schemas (zod)
                     linguagem pública estável do SDK e da API
  providers/       → EvolutionProvider · ZApiProvider · MetaCloudApiProvider
                     cada um implementa CommunicationProvider (+ parseWebhookPayload), isolados entre si
  registry/        → ProviderRegistry — único lugar que resolve provider por *tipo*
  application/     → use-cases (SDK embutido) + InstanceProviderRegistry (multi-tenant da API) + factory
  infrastructure/  → ConsoleLogger · wrapper HTTP compartilhado · PostgresInstanceRepository
                     (produção, Supabase ou outro Postgres) / InMemoryInstanceRepository (testes)
                     · HttpForwardingEventPublisher
  api/             → Fastify — routes/controllers/middlewares + buildServer() (testável via
                     app.inject()) + server.ts (entrypoint real, usado por `npm run dev`/`start`)
  config/          → leitura de variáveis de ambiente por provider + da API + Postgres
  compat/          → EvolutionClient / createEvolutionClient legados (ver seção abaixo)
```

Filas (RabbitMQ/Kafka) e o Dashboard Administrativo continuam **fora de escopo** — o repasse de
eventos (`HttpForwardingEventPublisher`) é o próximo a virar fila real; troca por outra
implementação de `EventPublisher`/`InstanceRepository` sem tocar em Core/Providers/`api/` (só a
peça de `infrastructure/` muda — foi exatamente assim que `InstanceRepository` saiu de
em-memória pra Postgres).

</details>

<br>

## 🧪 Testes

```bash
npm test
```

<br>

---

## 📦 Uso legado (`@sinal/evolution-client`)

<details>
<summary><strong>O SINAL e o módulo de prospecção já consomem este pacote hoje via
<code>EvolutionClient</code> — clique para ver a API legada, mantida 100% compatível</strong></summary>

<br>

> [!NOTE]
> `EvolutionClient` e `createEvolutionClient` continuam funcionando exatamente como antes.
> São uma fachada independente em `src/compat/`, congelada de propósito para não arriscar
> mudar comportamento em produção durante a evolução para o FlowBridge.

### Criando o client

```ts
import { createEvolutionClient } from '@sinal/evolution-client';

const client = createEvolutionClient(); // lê EVOLUTION_API_URL / EVOLUTION_API_KEY do .env
```

```ts
import { EvolutionClient } from '@sinal/evolution-client';

const client = new EvolutionClient({
  baseUrl: 'https://evolution.seudominio.com',
  apiKey: process.env.EVOLUTION_API_KEY!,
  throwOnError: true, // lança EvolutionApiError em 4xx/5xx
});
```

### Referência

```ts
await client.createInstance({ instanceName: 'prospeccao-01' });
await client.setWebhook('prospeccao-01', { enabled: true, url: 'https://seuapp.com/webhook/whatsapp', events: ['MESSAGES_UPSERT'] });
await client.getQrCode('prospeccao-01');
await client.getInstanceStatus('prospeccao-01');
await client.deleteInstance('prospeccao-01');

const valid = await client.checkNumbers('prospeccao-01', ['5598999990000', '5511000000000']);
// → ['5598999990000']

await client.sendText('instancia', '5598999990000', 'Olá!');
await client.sendImage('instancia', '5598999990000', 'https://img.url/foto.jpg', 'Legenda');
await client.sendAudio('instancia', '5598999990000', 'https://audio.url/voz.ogg');
await client.sendDocument('instancia', '5598999990000', 'https://url/proposta.pdf', 'proposta.pdf');

await client.sendButtons('instancia', '5598999990000', 'Título', 'Corpo', 'Rodapé', [
  { type: 'reply', displayText: 'Sim', id: 'BTN_SIM' },
  { type: 'reply', displayText: 'Não', id: 'BTN_NAO' },
]);

await client.sendCarousel('instancia', '5598999990000', 'Confira nossos planos:', [
  { title: 'Plano Pro', body: 'R$ 350/mês', footer: 'Mais popular', imageUrl: 'https://img.url/pro.jpg', buttons: [{ type: 'reply', displayText: 'Quero esse', id: 'PLANO_PRO' }] },
]);

await client.sendReaction('instancia', '5598999990000', 'MSG_ID_AQUI', '👍');
```

### Tratamento de erros

```ts
import { EvolutionApiError, createEvolutionClient } from '@sinal/evolution-client';

const client = createEvolutionClient({ throwOnError: true });

try {
  await client.sendText('inst', '5598999990000', 'Olá');
} catch (err) {
  if (err instanceof EvolutionApiError) {
    console.error(err.statusCode);  // 422, 500, etc.
    console.error(err.endpoint);    // '/message/sendText/inst'
    console.error(err.responseBody);
  }
}
```

Com `throwOnError: false` (padrão), erros são logados silenciosamente — mesmo comportamento
do `EvolutionService.php` original do SINAL.

### Como atualizar nos projetos consumidores

```bash
npm install github:sinal-app/evolution-client
```

Ou fixe uma tag de release:

```json
"@sinal/evolution-client": "github:sinal-app/evolution-client#v2.0.0"
```

</details>
