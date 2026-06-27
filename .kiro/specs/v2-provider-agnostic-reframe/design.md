# Relay v2: Provider-Agnostic Caching Proxy — Revised Design

> **Date:** 2026-06-27
> **Status:** Proposed — awaiting review
> **Supersedes:** `.kiro/specs/copilot-token-optimizer-proxy/design.md`

## Problem Statement

A technical review of the Relay proxy surfaced five categories of issue:

1. **Misframed value proposition.** GitHub Copilot's inline code completions are unlimited on every paid plan — they do not consume AI Credits. Caching/deduplicating that endpoint saves zero dollars. The proxy must be repositioned as a **provider-agnostic caching gateway** that sits in front of any pay-per-token API (OpenAI, Anthropic, Azure OpenAI, etc.), with GitHub Copilot as one optional backend — not the headline use case.

2. **Broken interception layer.** USAGE.md told users to set `github.copilot.advanced.debug.overrideProxyUrl`, but per the VS Code Copilot extension schema, that key overrides the *authentication proxy*, not the completions API. The correct key is `debug.overrideCapiUrl`. Neither is guaranteed to work across extension versions. The documentation must be corrected and tested.

3. **Unsafe fuzzy caching.** The current `CacheManager.calculateSimilarity()` runs Levenshtein distance on SHA-256 hex hashes — which is meaningless due to the avalanche property. A 1-token diff (flipped operator, changed literal) can stay above the 85% threshold while producing a semantically wrong cached result. Fuzzy matching must be rebuilt with structural guards or removed.

4. **Individual ToS risk.** GitHub's Acceptable Use Policy lists proxy usage as grounds for permanent Copilot suspension. Relay must not be framed as a personal workaround. Copilot mode must require explicit organizational sign-off and display a consent gate on first run.

5. **Misleading documentation.** README, USAGE.md, and comparison tables imply per-token Copilot savings that don't exist. All docs must clearly state which backends are genuinely metered per-token and which are not.

### Audit Findings (Critical Bugs in Current Code)

The architecture audit also uncovered three implementation bugs that must be fixed as part of this work:

| Bug | Location | Impact |
|-----|----------|--------|
| **Half-migrated request pipeline** | `index.ts` L255-264 | Sends old `CompletionRequestBody` (prompt/language/cursorPosition) to `RequestForwarder.forward()` instead of the `InternalChatRequest` from `CompatibilityLayer.transformRequest()`. The chat transform is computed but **never used for the upstream call**. |
| **CompatibilityLayer doesn't parse OpenAI format** | `CompatibilityLayer.ts` | `transformRequest()` expects old `CompletionRequestBody` with `prompt`, `language`, `cursorPosition`, `fileContext` fields. It does NOT parse standard OpenAI chat requests (`{model, messages}`). A real OpenAI client's request would fail validation. |
| **Fuzzy matching on SHA-256 hashes** | `CacheManager.ts` | `calculateSimilarity()` runs Levenshtein distance on 64-char hex hash strings. SHA-256's avalanche property makes this comparison meaningless — two nearly-identical inputs produce completely different hashes. The feature is disabled by default but fundamentally broken. |

---

## Architecture: Provider-Agnostic Design

### Core Principle

Every component below `APIGateway` operates on **`InternalChatRequest` / `InternalChatResponse`** — provider-neutral chat structures. Provider-specific logic (auth, headers, endpoint URLs, model lists) lives exclusively inside `Provider` implementations.

### Provider Interface

```typescript
/**
 * A backend LLM provider that Relay can proxy requests to.
 * Each provider implementation encapsulates all provider-specific
 * auth, endpoint, and header logic.
 */
export interface IProvider {
  /** Unique identifier for this provider (e.g. 'openai', 'anthropic', 'copilot') */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** Whether this provider's usage is metered per-token (i.e. caching saves money) */
  readonly isMeteredPerToken: boolean;

  /** Initialize the provider (load credentials, etc.) */
  initialize(): Promise<void>;

  /** Get the upstream endpoint URL for chat completions */
  getEndpointUrl(): string;

  /** Get the required headers for an upstream request */
  getHeaders(): Promise<Record<string, string>>;

  /** Get the list of models available from this provider */
  getModelList(): Promise<ModelInfo[]>;

  /** Refresh credentials if needed (e.g. on 401) */
  refreshCredentials(): Promise<void>;

  /** Transform an InternalChatRequest into the provider's expected body format */
  transformRequestBody(req: InternalChatRequest): Record<string, unknown>;

  /** Parse the provider's response into InternalChatResponse */
  parseResponse(raw: unknown): InternalChatResponse;

  /** Health check */
  checkHealth(): Promise<boolean>;

  /** Cleanup */
  destroy(): void;
}

export interface ModelInfo {
  id: string;
  name: string;
  owned_by: string;
  /** Credits per 1M input tokens (null if unmetered) */
  input_cost_per_million: number | null;
  /** Credits per 1M output tokens (null if unmetered) */
  output_cost_per_million: number | null;
}
```

### Provider Implementations (Phase 1)

| Provider | Class | Auth | Metered? |
|----------|-------|------|----------|
| **OpenAI** | `OpenAIProvider` | `OPENAI_API_KEY` env var or config | ✅ Yes |
| **Anthropic** | `AnthropicProvider` | `ANTHROPIC_API_KEY` env var or config | ✅ Yes |
| **GitHub Copilot** | `CopilotProvider` | GitHub OAuth device flow (existing `AuthManager` logic) | ⚠️ Chat/Agent API uses credits; inline completions are free |
| **Generic OpenAI-Compatible** | `GenericProvider` | Config-driven (API key, base URL, headers) | Configurable |

### Updated Component Responsibilities

```
┌─────────────────────────────────────────────────────────┐
│  APIGateway (HTTP server)                               │
│  Routes: POST /v1/chat/completions                      │
│          POST /v1/completions                           │
│          POST /v1/messages (Anthropic)                  │
│          GET  /v1/models                                │
│          GET  /health, /metrics                         │
│  Auth: validates API_KEY from request header            │
│  Parses request body into InternalChatRequest           │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│  RequestProcessor                                       │
│  normalizeRequest() → NormalizedChatRequest              │
│  generateContextHash() → { contextHash, prefixHash }    │
│  (unchanged — already provider-agnostic)                │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│  CacheManager                                           │
│  lookupExact(hash) → ChatCacheEntry | null              │
│  lookupPrefix(prefixHash) → ChatCacheEntry | null       │
│  shouldBypassCache(req) → boolean                       │
│  store(hash, entry) → void                              │
│  [REMOVED] lookupSimilar — replaced by FuzzyGuard       │
│  (unchanged core — already provider-agnostic)           │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│  FuzzyGuard (NEW — opt-in, off by default)              │
│  Stores normalized request text alongside hash          │
│  On miss: computes structural edit distance on the      │
│    parsed message array, NOT on hex hashes              │
│  Bounds: reject if any single message differs by more   │
│    than N tokens of edit distance                       │
│  Logs every fuzzy serve with score + diff               │
│  Kill switch: disables if >3 rapid edits in 5s window   │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│  DeduplicationManager<InternalChatResponse, StreamChunk>│
│  (unchanged — already generic)                          │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│  RequestForwarder                                       │
│  forward(req, provider) → InternalChatResponse          │
│  Gets endpoint URL, headers, body transform from        │
│  the Provider instance — no hardcoded URLs/headers      │
│  Circuit breaker, retry, 401-refresh all remain         │
└───────────────────────┬─────────────────────────────────┘
                        │
            ┌───────────▼───────────┐
            │  IProvider impl       │
            │  (OpenAI / Anthropic  │
            │   / Copilot / Generic)│
            └───────────────────────┘
```

---

## Item 1: Provider-Agnostic Refactor — Detailed Changes

### 1.1 New files

| File | Purpose |
|------|---------|
| `src/providers/types.ts` | `IProvider`, `ModelInfo`, `ProviderConfig` interfaces |
| `src/providers/OpenAIProvider.ts` | OpenAI implementation |
| `src/providers/AnthropicProvider.ts` | Anthropic `/v1/messages` implementation |
| `src/providers/CopilotProvider.ts` | Wraps existing `AuthManager` logic |
| `src/providers/GenericProvider.ts` | Config-driven OpenAI-compatible backend |
| `src/providers/index.ts` | Provider factory: `createProvider(config)` |
| `src/components/FuzzyGuard.ts` | Safe fuzzy matching layer |

### 1.2 Modified files

| File | Changes |
|------|---------|
| `src/components/RequestForwarder.ts` | Remove hardcoded URL/headers. Accept `IProvider` instead of `IAuthManager`. Use `provider.getEndpointUrl()`, `provider.getHeaders()`, `provider.transformRequestBody()`, `provider.parseResponse()`. Return `InternalChatResponse` instead of `CopilotResponse`. |
| `src/components/CompatibilityLayer.ts` | Rewrite `transformRequest()` to parse real OpenAI chat format (`{model, messages, ...}`). Add `parseAnthropicRequest()` for `/v1/messages`. Add `parseCompletionRequest()` for `/v1/completions`. Remove old `CompletionRequestBody` dependency. |
| `src/components/APIGateway.ts` | Update request validation to expect OpenAI chat format. Update `/v1/models` to query the active provider. Add routes for `/v1/completions` and `/v1/messages`. |
| `src/components/CacheManager.ts` | Remove `lookupSimilar()` and `calculateSimilarity()` (moved to `FuzzyGuard`). Remove broken Levenshtein-on-hashes logic. |
| `src/index.ts` | Replace `AuthManager` + `RequestForwarder` wiring with provider factory. Fix the broken request pipeline to actually send `InternalChatRequest` upstream. Remove all `"GitHub Copilot Token Optimizer Proxy"` strings. |
| `src/types/requests.ts` | Remove `CompletionRequestBody`. Replace with `OpenAIChatRequestBody`, `AnthropicRequestBody`. |
| `src/types/copilot.ts` | Delete file. Use `InternalChatResponse` everywhere. |
| `src/types/config.ts` | Add `ProviderConfig` section. Add `providers: ProviderConfig[]` to `Configuration`. |

### 1.3 Files unchanged (already provider-agnostic)

- `src/components/RequestProcessor.ts`
- `src/components/TokenAnalyzer.ts`
- `src/components/DeduplicationManager.ts`
- `src/types/chat.ts`
- `src/types/metrics.ts`

---

## Item 2: Interception Layer Audit

### Known facts about VS Code Copilot override settings

| Setting | What it overrides | Status |
|---------|-------------------|--------|
| `github.copilot.advanced.debug.overrideProxyUrl` | The **authentication/telemetry proxy**, not the API | ❌ Wrong for our use case |
| `github.copilot.advanced.debug.overrideCapiUrl` | The **completions API endpoint** | ⚠️ Correct key but may be ignored in newer builds |

### Required work

1. **Remove** the `overrideProxyUrl` recommendation from USAGE.md entirely.
2. **Document** `overrideCapiUrl` with a caveat that GitHub has shipped builds that ignore it.
3. **Write an integration test** that sends a request shaped exactly like what VS Code Copilot Chat extension sends (with `Editor-Version`, `Copilot-Integration-Id`, `openai-intent` headers).
4. **Add a compatibility matrix** documenting tested IDE/extension combinations and whether the override works.
5. **Recommend the standard approach**: configure Relay as an OpenAI-compatible endpoint in tools like Continue.dev, Cursor, Aider, LangChain — tools that natively support custom base URLs — rather than trying to hijack VS Code's internal Copilot plumbing.

---

## Item 3: Safe Fuzzy Caching

### Problem

The current `calculateSimilarity()` computes Levenshtein distance on SHA-256 hex strings. Due to the avalanche property, this is meaningless — a 1-character input change produces a completely different hash. The 85% threshold provides zero semantic guarantees.

### Solution: FuzzyGuard

A new `FuzzyGuard` component that sits between `CacheManager` and the caller:

```typescript
export interface IFuzzyGuard {
  /** Check for a fuzzy match. Returns null if no safe match found. */
  lookup(normalized: NormalizedChatRequest, contextHash: string): ChatCacheEntry | null;

  /** Store a request's normalized text for future fuzzy comparisons. */
  store(normalized: NormalizedChatRequest, contextHash: string, entry: ChatCacheEntry): void;

  /** Check if rapid-edit kill switch is active. */
  isKillSwitchActive(): boolean;
}
```

**Safety invariants:**

1. **Structural comparison, not hash comparison.** Compare the actual `messages[]` arrays, not their SHA-256 hashes.
2. **Per-message edit distance bound.** For each message pair, compute token-level edit distance. Reject if ANY single message differs by more than `maxTokenEditDistance` tokens (default: 3).
3. **Role/structure must match exactly.** Message count, roles, tool schemas must be identical. Only `content` fields may differ.
4. **Audit logging.** Every fuzzy serve logs: similarity score, the specific diffs, the original and matched hashes.
5. **Rapid-edit kill switch.** If more than `maxRapidEdits` (default: 3) distinct context hashes arrive within `rapidEditWindowMs` (default: 5000ms), disable fuzzy matching for that window. This prevents stale fuzzy hits during active typing.
6. **Opt-in, off by default, per-workspace.** The config key `fuzzyCache.enabled` defaults to `false`.

---

## Item 4: Organizational Compliance

### Consent gate for Copilot mode

When `CopilotProvider` is selected as the active provider, on first run the CLI must display:

```
⚠️  COMPLIANCE NOTICE — GitHub Copilot Backend

Using Relay as a proxy in front of GitHub Copilot may violate GitHub's
Acceptable Use Policy and could result in permanent suspension of your
Copilot access with no guaranteed reinstatement.

This mode is intended for organizations that have obtained written
approval from their GitHub administrator and security team.

By continuing, you confirm that:
  1. You have authorization from your organization's GitHub admin
  2. Your organization's security team has reviewed this deployment
  3. You accept full responsibility for compliance with GitHub's ToS

Type 'I ACCEPT' to continue, or press Ctrl+C to cancel:
```

This consent is persisted to `~/.relay/consent.json` with a timestamp and is required once per machine.

### Documentation requirements

- Add `COMPLIANCE.md` with full text of relevant GitHub ToS sections
- Add a `compliance` section to config requiring `orgName` and `adminApproval: true` when Copilot mode is active

---

## Item 5: Documentation Corrections

### Backend metering truth table (for README)

| Backend | Metered per token? | Caching saves money? | Notes |
|---------|-------------------|---------------------|-------|
| **OpenAI API** | ✅ Yes | ✅ Yes | All models billed per input/output token |
| **Anthropic API** | ✅ Yes | ✅ Yes | All Claude models billed per token |
| **Azure OpenAI** | ✅ Yes | ✅ Yes | Pay-as-you-go or provisioned throughput |
| **GitHub Copilot (inline completions)** | ❌ No | ❌ No | Unlimited on all paid plans |
| **GitHub Copilot (Chat/Agent via AI Credits)** | ⚠️ Partially | ⚠️ Limited | Premium models consume credits; base models may be unlimited depending on plan tier |
| **Self-hosted / Ollama** | ❌ No | ❌ No | You own the GPU; no per-token charge |

---

## Verification Plan

### Automated Tests
- `npx tsc --noEmit` — zero type errors
- `npx vitest run` — all unit + integration tests pass
- New tests for: `IProvider` implementations, `FuzzyGuard`, updated `CompatibilityLayer`, updated `RequestForwarder`, consent gate

### Manual Verification
- Send a real OpenAI-formatted `POST /v1/chat/completions` request and confirm end-to-end flow
- Confirm `GET /v1/models` returns provider-specific models
- Confirm fuzzy matching is off by default and logs when enabled
- Confirm Copilot consent gate blocks until accepted
