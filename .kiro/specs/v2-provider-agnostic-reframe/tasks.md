# Relay v2: Provider-Agnostic Reframe — Tasks

> **Milestone:** Items 1–3 (code), Items 4–5 (docs/compliance) ship together

---

## Phase 1: Provider Abstraction Layer [Item 1]

### 1.1 Provider interface and types
- [x] Create `src/providers/types.ts` with `IProvider`, `ModelInfo`, `ProviderConfig` interfaces
- [x] Create `src/providers/index.ts` with `createProvider(config)` factory function

### 1.2 OpenAI Provider
- [x] Create `src/providers/OpenAIProvider.ts`
- [x] Auth via `OPENAI_API_KEY` env var or config field
- [x] Endpoint: `https://api.openai.com/v1/chat/completions`
- [x] Headers: `Authorization: Bearer <key>`, `Content-Type: application/json`
- [x] `transformRequestBody()` — pass-through (OpenAI native format)
- [x] `parseResponse()` — map to `InternalChatResponse`
- [x] `getModelList()` — call `GET /v1/models` or return config-defined list
- [x] Unit tests

### 1.3 Anthropic Provider
- [x] Create `src/providers/AnthropicProvider.ts`
- [x] Auth via `ANTHROPIC_API_KEY` env var or config field
- [x] Endpoint: `https://api.anthropic.com/v1/messages`
- [x] Headers: `x-api-key`, `anthropic-version: 2023-06-01`, `Content-Type: application/json`
- [x] `transformRequestBody()` — convert `InternalChatRequest` to Anthropic `messages` format (extract system from messages, map roles)
- [x] `parseResponse()` — map Anthropic response to `InternalChatResponse`
- [x] Unit tests

### 1.4 GitHub Copilot Provider
- [x] Create `src/providers/CopilotProvider.ts`
- [x] Move AuthManager's device flow, token exchange, and credential management into this provider
- [x] `getHeaders()` — return the Copilot-specific headers (Editor-Version, Copilot-Integration-Id, etc.)
- [x] `getEndpointUrl()` — use the dynamically obtained API endpoint from token exchange (fix the current bug where this is ignored)
- [x] `isMeteredPerToken` — return `false` for inline completions, `true` for chat/agent credits
- [x] Consent gate check on `initialize()` (see Phase 4)
- [x] Unit tests

### 1.5 Generic OpenAI-Compatible Provider
- [x] Create `src/providers/GenericProvider.ts`
- [x] Fully config-driven: `baseUrl`, `apiKey`, `headers`, `models` from config
- [x] Pass-through request/response transform (assumes OpenAI-compatible API)
- [x] Unit tests

---

## Phase 2: Fix the Broken Request Pipeline [Item 1 continued]

### 2.1 Rewrite CompatibilityLayer
- [x] `parseOpenAIChatRequest(body)` — parse `{model, messages, temperature, ...}` into `InternalChatRequest`
- [x] `parseOpenAICompletionRequest(body)` — parse `{model, prompt, ...}` into `InternalChatRequest`
- [x] `parseAnthropicRequest(body)` — parse `{model, messages, system, ...}` into `InternalChatRequest`
- [x] `formatOpenAIResponse(res: InternalChatResponse)` — format back to OpenAI shape
- [x] `formatOpenAIStreamChunk(chunk: InternalStreamChunk)` — format SSE chunks
- [x] `formatAnthropicResponse(res: InternalChatResponse)` — format to Anthropic shape
- [x] Remove old `CompletionRequestBody` dependency entirely
- [x] Unit tests with golden input/output pairs

### 2.2 Update APIGateway
- [x] Update `POST /v1/chat/completions` validation to expect `{model, messages}` (OpenAI chat format)
- [x] Add `POST /v1/completions` route (legacy completions)
- [x] Add `POST /v1/messages` route (Anthropic format)
- [x] Update `GET /v1/models` to query active provider's `getModelList()` instead of hardcoded list
- [x] Remove old `CompletionRequestBody` validation (prompt/language/cursorPosition/fileContext)
- [x] Unit tests

### 2.3 Update RequestForwarder
- [x] Change signature: `forward(body: InternalChatRequest, provider: IProvider): Promise<InternalChatResponse>`
- [x] Use `provider.getEndpointUrl()` instead of hardcoded URL
- [x] Use `provider.getHeaders()` instead of hardcoded Copilot headers
- [x] Use `provider.transformRequestBody(req)` to get provider-specific body
- [x] Use `provider.parseResponse(raw)` to parse response
- [x] On 401: call `provider.refreshCredentials()` and retry
- [x] Return `InternalChatResponse` instead of `CopilotResponse`
- [x] Unit tests

### 2.4 Update index.ts orchestration
- [x] Replace `AuthManager` instantiation with provider factory: `createProvider(config)`
- [x] Fix the critical bug: send `InternalChatRequest` (from CompatibilityLayer) to RequestForwarder, NOT the raw `CompletionRequestBody`
- [x] Remove all `"GitHub Copilot Token Optimizer Proxy"` log strings — use `"Relay Proxy"`
- [x] Remove `"gpt-3.5-turbo"` hardcoded fallbacks — get default model from provider
- [x] Remove `types/copilot.ts` import — use `InternalChatResponse` everywhere
- [x] CLI commands: keep `relay login` / `relay logout` / `relay whoami` but scope them to Copilot provider only
- [x] Unit tests

### 2.5 Type cleanup
- [x] Delete `src/types/copilot.ts` (legacy `CopilotResponse` / `Completion` types)
- [x] Update `src/types/requests.ts` — remove `CompletionRequestBody`, add `OpenAIChatRequestBody`
- [x] Update `src/types/index.ts` — remove copilot.ts re-exports, add provider type re-exports
- [x] Verify all imports compile

---

## Phase 3: Safe Fuzzy Caching [Item 3]

### 3.1 Create FuzzyGuard component
- [x] Create `src/components/FuzzyGuard.ts` implementing `IFuzzyGuard`
- [x] Store normalized request text (the actual message content) alongside the cache hash
- [x] `lookup()` — iterate stored entries, compare message arrays structurally:
  - Message count must match exactly
  - Message roles must match exactly
  - Tool schemas (if any) must match exactly
  - Per-message content: compute token-level edit distance
  - Reject if ANY message differs by more than `maxTokenEditDistance` (default: 3)
- [x] Audit log: every fuzzy serve logs similarity score, diff summary, original hash, matched hash
- [x] Rapid-edit kill switch: track distinct hashes in a sliding window. If >3 in 5s, disable fuzzy for that window
- [x] Config: `fuzzyCache.enabled` (default: `false`), `fuzzyCache.maxTokenEditDistance`, `fuzzyCache.maxEntries`, `fuzzyCache.rapidEditWindowMs`, `fuzzyCache.rapidEditThreshold`
- [x] Unit tests: safe match, unsafe rejection (flipped operator), kill switch activation, audit logging

### 3.2 Remove broken similarity from CacheManager
- [x] Remove `lookupSimilar()` method
- [x] Remove `calculateSimilarity()` method
- [x] Remove `levenshteinDistance()` helper
- [x] Remove `similarity` constructor parameters
- [x] Update CacheManager tests
- [x] Wire `FuzzyGuard` into `index.ts` pipeline (between cache miss and dedup/forward)

---

## Phase 4: Organizational Compliance [Item 4]

### 4.1 Consent gate for Copilot provider
- [x] On `CopilotProvider.initialize()`, check for `~/.relay/consent.json`
- [x] If not found, display compliance notice and require `I ACCEPT` input
- [x] Persist consent with timestamp to `~/.relay/consent.json`
- [x] Allow `--accept-copilot-terms` CLI flag for non-interactive environments
- [x] Unit test: gate blocks without consent, proceeds with consent

### 4.2 Compliance documentation
- [x] Create `COMPLIANCE.md` with relevant GitHub ToS excerpts and organizational requirements
- [x] Add `compliance` section to config: `orgName`, `adminApproval` (required when Copilot provider active)

---

## Phase 5: Documentation Corrections [Item 5]

### 5.1 README.md
- [x] Remove all "GitHub Copilot Token Optimizer" framing
- [x] Rename/rebrand to "Relay: Provider-Agnostic LLM Caching Proxy"
- [x] Add backend metering truth table (which backends are metered, which are not)
- [x] Update architecture diagram to show provider abstraction
- [x] Remove implied per-token Copilot savings claims

### 5.2 USAGE.md
- [x] Remove `overrideProxyUrl` recommendation entirely
- [x] Document correct `overrideCapiUrl` key with caveat about IDE version compatibility
- [x] Recommend standard approach: configure as OpenAI-compatible endpoint in Continue.dev, Cursor, Aider, etc.
- [x] Add provider configuration examples (OpenAI, Anthropic, Copilot, Generic)
- [x] Add IDE/extension compatibility matrix (with "not tested" / "known broken" markers)

### 5.3 config.example.yaml
- [x] Add `provider` section with examples for each backend type
- [x] Remove Copilot-only credit multiplier framing
- [x] Add comments explaining which backends benefit from caching

### 5.4 Comparison table
- [x] Update to show Relay's value per-backend (strong for OpenAI/Anthropic, limited for Copilot)
- [x] Remove any claim of savings on Copilot inline completions

---

## Phase 6: Verification

### 6.1 Type checking
- [x] `npx tsc --noEmit` — zero errors

### 6.2 Unit tests
- [x] `npx vitest run` — all pass

### 6.3 Integration tests
- [x] Update integration tests to use OpenAI provider (mock OpenAI upstream instead of Copilot)
- [x] Add integration test for Anthropic provider
- [x] Add integration test for cache hit flow with provider abstraction

### 6.4 Manual smoke test
- [x] Start relay with OpenAI provider, send a real chat request, confirm response
- [x] Confirm `GET /v1/models` returns provider-specific models
- [x] Confirm fuzzy matching is off by default
- [x] Confirm Copilot consent gate blocks without acceptance
