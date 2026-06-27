# Relay v2: Provider-Agnostic Reframe — Tasks

> **Milestone:** Items 1–3 (code), Items 4–5 (docs/compliance) ship together

---

## Phase 1: Provider Abstraction Layer [Item 1]

### 1.1 Provider interface and types
- [ ] Create `src/providers/types.ts` with `IProvider`, `ModelInfo`, `ProviderConfig` interfaces
- [ ] Create `src/providers/index.ts` with `createProvider(config)` factory function

### 1.2 OpenAI Provider
- [ ] Create `src/providers/OpenAIProvider.ts`
- [ ] Auth via `OPENAI_API_KEY` env var or config field
- [ ] Endpoint: `https://api.openai.com/v1/chat/completions`
- [ ] Headers: `Authorization: Bearer <key>`, `Content-Type: application/json`
- [ ] `transformRequestBody()` — pass-through (OpenAI native format)
- [ ] `parseResponse()` — map to `InternalChatResponse`
- [ ] `getModelList()` — call `GET /v1/models` or return config-defined list
- [ ] Unit tests

### 1.3 Anthropic Provider
- [ ] Create `src/providers/AnthropicProvider.ts`
- [ ] Auth via `ANTHROPIC_API_KEY` env var or config field
- [ ] Endpoint: `https://api.anthropic.com/v1/messages`
- [ ] Headers: `x-api-key`, `anthropic-version: 2023-06-01`, `Content-Type: application/json`
- [ ] `transformRequestBody()` — convert `InternalChatRequest` to Anthropic `messages` format (extract system from messages, map roles)
- [ ] `parseResponse()` — map Anthropic response to `InternalChatResponse`
- [ ] Unit tests

### 1.4 GitHub Copilot Provider
- [ ] Create `src/providers/CopilotProvider.ts`
- [ ] Move AuthManager's device flow, token exchange, and credential management into this provider
- [ ] `getHeaders()` — return the Copilot-specific headers (Editor-Version, Copilot-Integration-Id, etc.)
- [ ] `getEndpointUrl()` — use the dynamically obtained API endpoint from token exchange (fix the current bug where this is ignored)
- [ ] `isMeteredPerToken` — return `false` for inline completions, `true` for chat/agent credits
- [ ] Consent gate check on `initialize()` (see Phase 4)
- [ ] Unit tests

### 1.5 Generic OpenAI-Compatible Provider
- [ ] Create `src/providers/GenericProvider.ts`
- [ ] Fully config-driven: `baseUrl`, `apiKey`, `headers`, `models` from config
- [ ] Pass-through request/response transform (assumes OpenAI-compatible API)
- [ ] Unit tests

---

## Phase 2: Fix the Broken Request Pipeline [Item 1 continued]

### 2.1 Rewrite CompatibilityLayer
- [ ] `parseOpenAIChatRequest(body)` — parse `{model, messages, temperature, ...}` into `InternalChatRequest`
- [ ] `parseOpenAICompletionRequest(body)` — parse `{model, prompt, ...}` into `InternalChatRequest`
- [ ] `parseAnthropicRequest(body)` — parse `{model, messages, system, ...}` into `InternalChatRequest`
- [ ] `formatOpenAIResponse(res: InternalChatResponse)` — format back to OpenAI shape
- [ ] `formatOpenAIStreamChunk(chunk: InternalStreamChunk)` — format SSE chunks
- [ ] `formatAnthropicResponse(res: InternalChatResponse)` — format to Anthropic shape
- [ ] Remove old `CompletionRequestBody` dependency entirely
- [ ] Unit tests with golden input/output pairs

### 2.2 Update APIGateway
- [ ] Update `POST /v1/chat/completions` validation to expect `{model, messages}` (OpenAI chat format)
- [ ] Add `POST /v1/completions` route (legacy completions)
- [ ] Add `POST /v1/messages` route (Anthropic format)
- [ ] Update `GET /v1/models` to query active provider's `getModelList()` instead of hardcoded list
- [ ] Remove old `CompletionRequestBody` validation (prompt/language/cursorPosition/fileContext)
- [ ] Unit tests

### 2.3 Update RequestForwarder
- [ ] Change signature: `forward(body: InternalChatRequest, provider: IProvider): Promise<InternalChatResponse>`
- [ ] Use `provider.getEndpointUrl()` instead of hardcoded URL
- [ ] Use `provider.getHeaders()` instead of hardcoded Copilot headers
- [ ] Use `provider.transformRequestBody(req)` to get provider-specific body
- [ ] Use `provider.parseResponse(raw)` to parse response
- [ ] On 401: call `provider.refreshCredentials()` and retry
- [ ] Return `InternalChatResponse` instead of `CopilotResponse`
- [ ] Unit tests

### 2.4 Update index.ts orchestration
- [ ] Replace `AuthManager` instantiation with provider factory: `createProvider(config)`
- [ ] Fix the critical bug: send `InternalChatRequest` (from CompatibilityLayer) to RequestForwarder, NOT the raw `CompletionRequestBody`
- [ ] Remove all `"GitHub Copilot Token Optimizer Proxy"` log strings — use `"Relay Proxy"`
- [ ] Remove `"gpt-3.5-turbo"` hardcoded fallbacks — get default model from provider
- [ ] Remove `types/copilot.ts` import — use `InternalChatResponse` everywhere
- [ ] CLI commands: keep `relay login` / `relay logout` / `relay whoami` but scope them to Copilot provider only
- [ ] Unit tests

### 2.5 Type cleanup
- [ ] Delete `src/types/copilot.ts` (legacy `CopilotResponse` / `Completion` types)
- [ ] Update `src/types/requests.ts` — remove `CompletionRequestBody`, add `OpenAIChatRequestBody`
- [ ] Update `src/types/index.ts` — remove copilot.ts re-exports, add provider type re-exports
- [ ] Verify all imports compile

---

## Phase 3: Safe Fuzzy Caching [Item 3]

### 3.1 Create FuzzyGuard component
- [ ] Create `src/components/FuzzyGuard.ts` implementing `IFuzzyGuard`
- [ ] Store normalized request text (the actual message content) alongside the cache hash
- [ ] `lookup()` — iterate stored entries, compare message arrays structurally:
  - Message count must match exactly
  - Message roles must match exactly
  - Tool schemas (if any) must match exactly
  - Per-message content: compute token-level edit distance
  - Reject if ANY message differs by more than `maxTokenEditDistance` (default: 3)
- [ ] Audit log: every fuzzy serve logs similarity score, diff summary, original hash, matched hash
- [ ] Rapid-edit kill switch: track distinct hashes in a sliding window. If >3 in 5s, disable fuzzy for that window
- [ ] Config: `fuzzyCache.enabled` (default: `false`), `fuzzyCache.maxTokenEditDistance`, `fuzzyCache.maxEntries`, `fuzzyCache.rapidEditWindowMs`, `fuzzyCache.rapidEditThreshold`
- [ ] Unit tests: safe match, unsafe rejection (flipped operator), kill switch activation, audit logging

### 3.2 Remove broken similarity from CacheManager
- [ ] Remove `lookupSimilar()` method
- [ ] Remove `calculateSimilarity()` method
- [ ] Remove `levenshteinDistance()` helper
- [ ] Remove `similarity` constructor parameters
- [ ] Update CacheManager tests
- [ ] Wire `FuzzyGuard` into `index.ts` pipeline (between cache miss and dedup/forward)

---

## Phase 4: Organizational Compliance [Item 4]

### 4.1 Consent gate for Copilot provider
- [ ] On `CopilotProvider.initialize()`, check for `~/.relay/consent.json`
- [ ] If not found, display compliance notice and require `I ACCEPT` input
- [ ] Persist consent with timestamp to `~/.relay/consent.json`
- [ ] Allow `--accept-copilot-terms` CLI flag for non-interactive environments
- [ ] Unit test: gate blocks without consent, proceeds with consent

### 4.2 Compliance documentation
- [ ] Create `COMPLIANCE.md` with relevant GitHub ToS excerpts and organizational requirements
- [ ] Add `compliance` section to config: `orgName`, `adminApproval` (required when Copilot provider active)

---

## Phase 5: Documentation Corrections [Item 5]

### 5.1 README.md
- [ ] Remove all "GitHub Copilot Token Optimizer" framing
- [ ] Rename/rebrand to "Relay: Provider-Agnostic LLM Caching Proxy"
- [ ] Add backend metering truth table (which backends are metered, which are not)
- [ ] Update architecture diagram to show provider abstraction
- [ ] Remove implied per-token Copilot savings claims

### 5.2 USAGE.md
- [ ] Remove `overrideProxyUrl` recommendation entirely
- [ ] Document correct `overrideCapiUrl` key with caveat about IDE version compatibility
- [ ] Recommend standard approach: configure as OpenAI-compatible endpoint in Continue.dev, Cursor, Aider, etc.
- [ ] Add provider configuration examples (OpenAI, Anthropic, Copilot, Generic)
- [ ] Add IDE/extension compatibility matrix (with "not tested" / "known broken" markers)

### 5.3 config.example.yaml
- [ ] Add `provider` section with examples for each backend type
- [ ] Remove Copilot-only credit multiplier framing
- [ ] Add comments explaining which backends benefit from caching

### 5.4 Comparison table
- [ ] Update to show Relay's value per-backend (strong for OpenAI/Anthropic, limited for Copilot)
- [ ] Remove any claim of savings on Copilot inline completions

---

## Phase 6: Verification

### 6.1 Type checking
- [ ] `npx tsc --noEmit` — zero errors

### 6.2 Unit tests
- [ ] `npx vitest run` — all pass

### 6.3 Integration tests
- [ ] Update integration tests to use OpenAI provider (mock OpenAI upstream instead of Copilot)
- [ ] Add integration test for Anthropic provider
- [ ] Add integration test for cache hit flow with provider abstraction

### 6.4 Manual smoke test
- [ ] Start relay with OpenAI provider, send a real chat request, confirm response
- [ ] Confirm `GET /v1/models` returns provider-specific models
- [ ] Confirm fuzzy matching is off by default
- [ ] Confirm Copilot consent gate blocks without acceptance
