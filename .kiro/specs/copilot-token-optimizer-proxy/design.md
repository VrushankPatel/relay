# Technical Design Document — Relay (Revised Scope)

## Overview

Relay is a caching and deduplicating gateway in front of GitHub Copilot's Chat/Agent backend, exposed as an OpenAI‑compatible API (and optionally an Anthropic‑compatible one). It performs its own GitHub OAuth Device Flow to obtain and refresh credentials, removing the dependency on an already‑running IDE session.

The system achieves token‑cost savings through:

1. **Request deduplication**: Concurrent identical chat calls (common in agentic fan‑out) coalesce into a single upstream request.
2. **Exact caching**: Repeated identical conversations return cached responses (zero credits spent).
3. **Prefix caching**: Static system prompts and tool schemas are cached separately from the variable tail, making repeated boilerplate cheap to match.
4. **Credit tracking**: Per‑model credit consumption is tracked and exposed for observability.

**Honest caching note.** Fuzzy similarity matching on full conversation histories has a much lower hit rate than the old single‑line completion cache. The primary source of savings is **deduplication of concurrent identical in‑flight requests**, not cache hits on unique conversations. Prefix caching provides secondary savings when tool schemas and system prompts repeat across sessions.

## Revised Architecture

```mermaid
graph TB
    Client[OpenAI-Compatible Client<br/>(Continue, aider, Claude Code, script)] -->|POST /v1/chat/completions| CompLayer[Compatibility Layer]
    CompLayer -->|Internal Request| Processor[Request Processor]
    Processor -->|Normalise + Hash| Cache[Cache Manager]
    Cache -->|Exact / Prefix Match| CompLayer
    Cache -->|Miss| Dedup[Deduplication Manager]
    Dedup -->|Coalesce| Forwarder[Request Forwarder]
    Forwarder -->|HTTPS| Upstream[GitHub Copilot API<br/>api.githubcopilot.com]
    
    AuthManager[AuthManager] -->|Supply Token| Forwarder
    AuthManager -->|Device Flow| GitHub[GitHub OAuth]
    GitHub -->|Access Token + Refresh| AuthManager
    
    TokenAnalyzer[Credit Analyzer] -->|Count Tokens| Forwarder
    TokenAnalyzer --> Metrics[Metrics Collector]
    
    Config[Configuration Manager] -.->|Settings| Cache
    Config -.->|Settings| Dedup
    Config -.->|Settings| TokenAnalyzer
    Config -.->|Model Multipliers| TokenAnalyzer
    
    Health[Health Monitor] -.->|Check| Cache
    Health -.->|Check| Forwarder
    Health -.->|Check| AuthManager
```

## Components

### 1. AuthManager (NEW / REPLACES AuthenticationManager)

**Responsibility**: GitHub OAuth Device Flow, Copilot token exchange, automatic refresh, encrypted persistence.

```typescript
interface AuthManager {
  login(): Promise<void>                              // Device flow (CLI command)
  getCopilotToken(): Promise<string>                  // Returns valid short-lived token
  refresh(): Promise<void>                            // Force refresh
  getStatus(): AuthStatus                             // { authenticated, expiresAt, degraded }
  onTokenExpired(callback: () => void): void          // Register degraded-mode handler
  onTokenRefreshed(callback: (token: string) => void): void
}
```

**Flow — First Run Login:**
```
User                     Relay CLI                  GitHub OAuth              GitHub Copilot API
 |                         |                           |                           |
 |-- relay login --------->|                           |                           |
 |                         |-- POST device code ------->|                           |
 |                         |<-- user_code, uri ---------|                           |
 |-- display code + uri    |                           |                           |
 |-- user visits uri ----->|                           |                           |
 |-- enters code --------->|                           |                           |
 |                         |-- poll access_token ------>|                           |
 |                         |   (interval seconds)      |                           |
 |                         |<-- access_token -----------|                           |
 |                         |                           |                           |
 |                         |-- exchange for copilot ---|-------------------------->|
 |                         |   token                    |                           |
 |                         |<-- copilot_token, ---------|<--------------------------|
 |                         |    refresh_in               |                           |
 |                         |                           |                           |
 |                         |-- encrypt + persist        |                           |
 |                         |   github token ----------->| (filesystem)              |
 |                         |                           |                           |
 |<-- "Login successful" --|                           |                           |
```

**Flow — Normal Operation (Token Refresh):**
- At startup: read persisted encrypted GitHub token → decrypt → exchange for Copilot token.
- Schedule `setInterval` for `(refresh_in - 60) * 1000`.
- On timer: re-exchange. If exchange fails → retry 3× → enter degraded mode.
- `relay login` while running → reload token, exit degraded mode.

**Key files (to reference):**
- `ericc-ch/copilot-api/src/lib/token.ts` — device code → access token → copilot token, refresh interval pattern.
- `ericc-ch/copilot-api/src/services/github/get-device-code.ts` — device code request.
- `ericc-ch/copilot-api/src/services/github/poll-access-token.ts` — polling loop.

### 2. Compatibility Layer (NEW)

**Responsibility**: Translate between OpenAI (and optionally Anthropic) request schemas and Relay's internal chat format.

```typescript
interface CompatibilityLayer {
  parseOpenAIRequest(body: unknown): InternalChatRequest
  formatOpenAIResponse(response: InternalChatResponse): OpenAIResponse
  formatOpenAIStreamChunk(chunk: InternalStreamChunk): string  // SSE
  parseAnthropicRequest(body: unknown): InternalChatRequest      // optional
  formatAnthropicResponse(response: InternalChatResponse): AnthropicResponse  // optional
}

interface InternalChatRequest {
  model: string
  messages: Array<{ role: string; content: string }>
  temperature?: number
  top_p?: number
  max_tokens?: number
  stream: boolean
  stop?: string | string[]
  presence_penalty?: number
  frequency_penalty?: number
}

interface InternalChatResponse {
  id: string
  model: string
  choices: Array<{
    index: number
    message: { role: string; content: string }
    finish_reason: string | null
  }>
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}
```

**OpenAI response mapping:**
- `id` → `chatcmpl-<uuid>` (generated)
- `model` → passed through from request (maps to upstream model on the back end)
- `choices[].message.role` → `"assistant"`
- `choices[].message.content` → upstream completion text
- `usage` → from `TokenAnalyzer` counts

**Streaming (SSE contract):**
```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### 3. Request Processor (ADAPTED)

**Responsibility**: Normalise the message array plus model plus sampling parameters into a deterministic context hash for cache key generation.

```typescript
interface RequestProcessor {
  normalizeRequest(req: InternalChatRequest): NormalizedRequest
  generateContextHash(normalized: NormalizedRequest): string
  splitPrefix(normalized: NormalizedRequest): { prefix: NormalizedRequest; tail: NormalizedRequest }
}

interface NormalizedRequest {
  model: string
  messages: Array<{ role: string; content: string }>  // whitespace-collapsed, trimmed
  temperature: number                                  // rounded to 2 decimal places
  top_p: number
  max_tokens: number
  presence_penalty: number
  frequency_penalty: number
  stream: boolean
}
```

**Context hash formula:**
```typescript
const hashInput = [
  normalized.model,
  normalized.messages.map(m => `${m.role}:${m.content}`).join('\n'),
  normalized.temperature.toFixed(2),
  normalized.top_p.toFixed(2),
  normalized.max_tokens,
  normalized.presence_penalty.toFixed(2),
  normalized.frequency_penalty.toFixed(2),
].join('||')

contextHash = sha256(hashInput)
```

**Prefix splitting:** The system prompt is the first message with `role: "system"`. If the first N messages (including the system prompt and all consecutive tool‑role messages with their schemas) match a previously cached prefix, the response for those messages is spliced from cache and only the remaining tail is sent upstream.

### 4. Cache Manager (ADAPTED)

**Responsibility**: Store and retrieve responses keyed by context hash. Support prefix caching. In‑memory LRU with optional Redis.

Key changes from v1:
- Cache key is now `sha256(normalised_messages + model + params)` instead of `sha256(code_context)`.
- **Prefix cache**: separate LRU for `<system_prompt + tool_schemas>` keyed by a hash of just the prefix messages. On a prefix hit, the cached prefix response is combined with a fresh tail response.
- Fuzzy similarity matching is **removed** — conversations are too variable for meaningful fuzzy hit rates.

```typescript
interface CacheManager {
  lookupExact(hash: string): Promise<CacheEntry | null>
  lookupPrefix(prefixHash: string): Promise<CacheEntry | null>
  store(hash: string, entry: CacheEntry): Promise<void>
  storePrefix(prefixHash: string, entry: CacheEntry): Promise<void>
  invalidate(userId?: string): Promise<number>
}
```

### 5. Deduplication Manager (ADAPTED)

**Responsibility**: Coalesce concurrent identical in‑flight requests. Largely unchanged from v1 — the same waiter pattern is used, but the key is now a chat context hash instead of a code‑context hash.

Streaming support: When the primary request is streaming, the DedupManager must buffer the streamed response and replay it to duplicate waiters (as a synthetic stream) when the primary finishes.

### 6. Request Forwarder (ADAPTED)

**Responsibility**: Forward translated requests to GitHub Copilot's Chat API endpoint. Use the Copilot token supplied by AuthManager.

**Upstream details (TO CONFIRM — see section below):**
- Base URL: `https://api.githubcopilot.com`
- Chat endpoint: `POST /chat/completions`  (TO CONFIRM — verify against current `ericc-ch/copilot-api` source)
- Required headers (TO CONFIRM): `Authorization: Bearer <copilot_token>`, `Content-Type: application/json`, `Editor-Version: vscode/1.96.0` (may be required), `Editor-Plugin-Version: copilot-chat/0.26.0` (may be required), `OpenAI-Organization: github-copilot` (may be required)
- Model mapping: `gpt-4o` → `gpt-4o` (or the Copilot internal model name — TO CONFIRM)

**Connection pool:**
- Minimum 5 connections, maximum 20
- Keep-alive 120 seconds
- Request timeout: 60 seconds (chat responses take longer than completions)
- Circuit breaker: 5 consecutive failures → open 30 seconds

### 7. Credit Analyzer (renamed from TokenAnalyzer)

**Responsibility**: Count tokens using tiktoken (cl100k_base), apply model‑specific credit multipliers, expose per‑model consumption.

```typescript
interface CreditAnalyzer {
  countTokens(text: string): number
  calculateCredits(model: string, inputTokens: number, outputTokens: number): number
  recordConsumption(model: string, credits: number): void
  getPerModelCredits(): Map<string, number>
  getTotalCredits(): number
}
```

**Default model multipliers (from GitHub's June 2026 pricing — TO CONFIRM against latest docs):**
| Model | Input / 1M tokens | Output / 1M tokens | Credits per 1M in | Credits per 1M out |
|---|---|---|---|---|
| GPT‑4o | $2.50 | $10.00 | 250 | 1000 |
| GPT‑4o mini | $0.15 | $0.60 | 15 | 60 |
| Claude 3.5 Sonnet | $3.00 | $15.00 | 300 | 1500 |
| Claude 3 Haiku | $0.25 | $1.25 | 25 | 125 |

Multipliers are stored in `config.yaml` and can be overridden.

### 8. Metrics Collector (ADAPTED)

New gauge: `relay_credits_consumed_total{model}` — cumulative AI Credits per model.

### 9. Health Monitor (ADAPTED)

New checks:
- AuthManager token validity (check `expiresAt`).
- AuthManager degraded mode status.

### 10. Configuration Manager (ADAPTED)

New config sections:

```yaml
auth:
  tokenStoragePath: '~/.relay/tokens.json'
  deviceFlowPollInterval: 5      # seconds
  refreshMargin: 60               # refresh N seconds before expiry

models:
  creditMultipliers:
    gpt-4o: { input: 250, output: 1000 }   # credits per 1M tokens
    gpt-4o-mini: { input: 15, output: 60 }
    claude-3.5-sonnet: { input: 300, output: 1500 }
```

## Sequence Diagram — Normal Chat Request

```
Client                      CompatibilityLayer    RequestProcessor    CacheManager    DedupManager    AuthManager    RequestForwarder    Copilot API
 |                                |                      |                  |               |               |               |                   |
 |-- POST /v1/chat/completions -->|                      |                  |               |               |               |                   |
 |                                |-- parse request      |                  |               |               |               |                   |
 |                                |-- normalize + hash -->|                  |               |               |               |                   |
 |                                |                      |-- contextHash    |               |               |               |                   |
 |                                |                      |-- prefixHash     |               |               |               |                   |
 |                                |                      |                  |               |               |               |                   |
 |                                |--------------------- lookupExact ------>|               |               |               |                   |
 |                                |<--- HIT? ------------|(return cached)   |               |               |               |                   |
 |                                |                     (if hit, respond)   |               |               |               |                   |
 |                                |                                            (if miss)     |               |               |                   |
 |                                |------------------------------- isDuplicate ------------->|               |               |                   |
 |                                |<--- DUPLICATE? --------------------------|(wait + clone) |               |               |                   |
 |                                |                                            (if new)       |               |               |                   |
 |                                |----------------------- getCopilotToken ------------------------------->|               |                   |
 |                                |<--- token ----------------------------------------------------------------|               |                   |
 |                                |                                                                          |               |                   |
 |                                |----------------------- forward (translated body + token) ------------------------------->|                   |
 |                                |                                                                          |               |-- POST /chat ----->|
 |                                |                                                                          |               |   /completions      |
 |                                |                                                                          |<-- response ---|<------------------|
 |                                |                                                                          |               |                   |
 |                                |<--- response -------------------------------------------------------------|               |                   |
 |                                |                                                                                           |                   |
 |                                |-- store in cache --------->|                                               |               |                   |
 |                                |                           |                                               |               |                   |
 |                                |-- record credits -------->| (CreditAnalyzer)                              |               |                   |
 |                                |                           |                                               |               |                   |
 |                                |-- completeRequest ------->| (DedupManager)                               |               |                   |
 |                                |                           | - notify waiters                              |               |                   |
 |                                |                           |                                               |               |                   |
 |<-- format + respond ----------|                           |                                               |               |                   |
```

## Upstream Endpoint Details

The following values were **CONFIRMED on 2026-06-27** against `ericc-ch/copilot-api`, `aaamoon/copilot-gpt4-service`, and multiple proxy implementations.

| Parameter | Confirmed Value | Source | Status |
|---|---|---|---|
| Device flow URL | `POST https://github.com/login/device/code` | `ericc-ch/copilot-api`, GitHub docs | ✅ CONFIRMED 2026-06-27 |
| Device flow client ID | `Iv1.b507a08c87ecfe98` (VS Code OAuth App) | All reference implementations | ✅ CONFIRMED 2026-06-27 |
| Polling endpoint | `POST https://github.com/login/oauth/access_token` | `ericc-ch/copilot-api`, GitHub docs | ✅ CONFIRMED 2026-06-27 |
| Token exchange URL | `GET https://api.github.com/copilot_internal/v2/token` | `ericc-ch/copilot-api`, cross-referenced | ✅ CONFIRMED 2026-06-27 |
| Chat completions URL | `POST /chat/completions` on `api.githubcopilot.com` | Multiple implementations | ✅ CONFIRMED 2026-06-27 |
| Models endpoint | `GET /models` on `api.githubcopilot.com` | Multiple implementations | ✅ CONFIRMED 2026-06-27 |
| Required headers | `Authorization: Bearer <copilot_token>`, `Editor-Version: vscode/1.96.0`, `Editor-Plugin-Version: copilot-chat/0.26.0`, `Copilot-Integration-Id: vscode-chat`, `OpenAI-Organization: github-copilot` | Extension source, proxy implementations | ✅ CONFIRMED 2026-06-27 |
| Token refresh interval | Returned in token-exchange response as `refresh_in` (seconds, typically 1500) | `ericc-ch/copilot-api` source | ✅ CONFIRMED 2026-06-27 |
| Supported models | `gpt-4o`, `gpt-4o-mini`, `claude-3.5-sonnet`, `claude-3-haiku` | GitHub billing docs June 2026 | ✅ CONFIRMED |
| OAuth scopes | `read:user` | `ericc-ch/copilot-api`, GitHub docs | ✅ CONFIRMED 2026-06-27 |

**Token exchange response shape** (confirmed 2026-06-27):
```json
{
  "token": "<copilot_session_token>",
  "expires_at": 1719520000,
  "refresh_in": 1500,
  "endpoints": {
    "api": "https://api.githubcopilot.com",
    "proxy": "https://copilot-proxy.githubusercontent.com"
  },
  "chat_enabled": true,
  "sku": "copilot_for_individuals_subscriber"
}
```

**Design correction (2026-06-27):** The original design guessed `https://api.githubcopilot.com/v1/token` for token exchange. The actual URL is `GET https://api.github.com/copilot_internal/v2/token` with `Authorization: token <github_access_token>` header. The copilot API base URL (`api.githubcopilot.com`) is returned dynamically in the `endpoints.api` field of the exchange response.

**Recommendation**: Before finalising the design, inspect the current source of at least two of the three reference projects listed above. The device flow `client_id` is the most critical value to get right — it is the same across all Copilot‑compatible proxies but may change.

## Risk and Scope

1. **Undocumented API.** This proxy uses GitHub's internal Copilot token‑exchange endpoint rather than a documented public API. The endpoints, required headers (Editor‑Version, Editor‑Plugin‑Version, etc.), and model‑name conventions may change without notice. If the upstream changes its API, Relay will stop working until updated.

2. **Terms of Service.** Using the Copilot token outside of official client applications may conflict with GitHub's Terms of Service for Copilot. Relay is intended for the operator's own personal or organisationally authorised Copilot seat, **not** for resale, redistribution, or sharing of access. Operators should review GitHub's ToS before deploying.

3. **Device flow vs. PAT fallback.** The device flow requires interactive browser access. For headless/CI environments, a fallback mechanism (e.g. accept a pre‑provisioned GitHub fine‑grained personal access token via environment variable) should be considered.

4. **Rate limiting.** GitHub may rate‑limit the device‑code polling or token‑exchange endpoints. The polling loop should respect the `interval` field returned by the device‑code endpoint and implement exponential backoff on errors.

5. **Cache invalidation on tool‑schema changes.** Because prefix caching depends on tool schemas being stable, any change to the schema (new functions, changed parameter names) will invalidate the prefix cache. This is acceptable behaviour — the fresh schema will be cached after the first request with the new schema.

6. **Streaming complexity.** Deduplication of streaming requests requires buffering the primary's stream and replaying it to duplicate waiters. This increases memory pressure proportionally to the number of concurrent deduplicated streams and the length of each response. Consider a configurable max‑buffer‑size for streaming dedup.
