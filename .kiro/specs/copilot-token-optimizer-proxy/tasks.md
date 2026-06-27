# Implementation Tasks — Relay (Revised Scope)

## Overview

Ordered implementation plan matching `design.md`. Each task is independently testable. Tasks build incrementally — each checkpoint should produce a working (if minimal) version.

**Conventions:**
- `[ ]` = not started, `[~]` = in progress, `[x]` = done
- Tasks marked `*` are optional / stretch
- Each task references requirements (R1–R9) defined in `requirements.md`

---

## Phase 1: Auth Foundation

### 1.1 OAuth Device Flow — CLI Command `relay login`
- [ ] 1.1.1 Install `open` / `node:child_process` for opening browser (optional convenience)
- [ ] 1.1.2 Implement `POST https://github.com/login/device/code` with client_id (TO CONFIRM)
- [ ] 1.1.3 Display `user_code` and `verification_uri` to terminal
- [ ] 1.1.4 Poll `POST https://github.com/login/oauth/access_token` at `interval` seconds until `access_token` or `expires_in` elapsed
- [ ] 1.1.5 On success: write GitHub access token to encrypted file at `~/.relay/tokens.json`
- [ ] 1.1.6 On expiry: print error, exit non-zero
- [ ] 1.1.7 Unit test: mocked HTTP returns valid device code → polling succeeds
- [ ] 1.1.8 Unit test: device code expires before user authorises → error exit
- **Validates: R1**

### 1.2 Copilot Token Exchange
- [ ] 1.2.1 Exchange GitHub access token for Copilot session token via token-exchange endpoint (TO CONFIRM URL)
- [ ] 1.2.2 Parse response: extract `token` and `refresh_in` (seconds)
- [ ] 1.2.3 On failure: log error, enter degraded mode
- [ ] 1.2.4 Unit test: successful exchange returns token + refresh_in
- [ ] 1.2.5 Unit test: exchange returns 401 → degraded mode
- **Validates: R1, R2**

### 1.3 Token Persistence (Encrypted)
- [ ] 1.3.1 Implement AES-256-GCM encrypt/decrypt using existing Node.js `crypto` module
- [ ] 1.3.2 Derive key via PBKDF2 from configurable `ENCRYPTION_SECRET`
- [ ] 1.3.3 Write encrypted token to `~/.relay/tokens.json` (configurable path)
- [ ] 1.3.4 Read and decrypt on startup
- [ ] 1.3.5 Unit test: encrypt then decrypt → original value
- [ ] 1.3.6 Unit test: wrong secret → decryption fails gracefully
- **Validates: R1, R9 (security)**

### 1.4 Token Refresh Timer
- [ ] 1.4.1 On startup: read persisted token → exchange for Copilot token
- [ ] 1.4.2 Schedule `setInterval` at `(refresh_in - 60) * 1000`
- [ ] 1.4.3 On timer fire: re-exchange, update in-memory token, reset timer
- [ ] 1.4.4 After 3 consecutive refresh failures: enter degraded mode, require `relay login`
- [ ] 1.4.5 Unit test: refresh timer fires → token updated
- [ ] 1.4.6 Unit test: 3 failures → degraded mode
- **Validates: R2**

### 1.5 Degraded Mode
- [ ] 1.5.1 Implement degraded-mode flag read by other components
- [ ] 1.5.2 When degraded: CacheManager serves cached responses; RequestForwarder returns 502 for misses
- [ ] 1.5.3 HealthMonitor reports `degraded` status when in degraded mode
- [ ] 1.5.4 `relay login` while proxy is running → re-auth → exit degraded mode
- **Validates: R2, R8**

**Checkpoint 1:** `relay login` completes device flow, token persists across restart, refresh timer fires.

---

## Phase 2: Core Proxy — Forward Chat to Copilot

### 2.1 Internal Chat Request Type
- [ ] 2.1.1 Define `InternalChatRequest`, `InternalChatResponse`, `InternalStreamChunk` types
- [ ] 2.1.2 Migrate existing `CopilotResponse` type to include chat-specific fields
- **Validates: R3**

### 2.2 Request Forwarder — Chat Path
- [ ] 2.2.1 Add chat-forwarding method to RequestForwarder (separate from legacy completions forwarder)
- [ ] 2.2.2 Forward to `POST /chat/completions` on `api.githubcopilot.com` (TO CONFIRM URL)
- [ ] 2.2.3 Attach Copilot token from AuthManager as `Authorization: Bearer <token>`
- [ ] 2.2.4 Attach required headers (Editor-Version, etc. — TO CONFIRM)
- [ ] 2.2.5 Parse upstream response into `InternalChatResponse`
- [ ] 2.2.6 Connection pool: 5–20 connections, keep-alive 120s, timeout 60s
- [ ] 2.2.7 Circuit breaker: 5 consecutive failures → open 30s
- [ ] 2.2.8 Unit test: forward request → return parsed response
- [ ] 2.2.9 Unit test: upstream 401 → trigger AuthManager refresh
- [ ] 2.2.10 Unit test: upstream timeout → circuit breaker opens
- **Validates: R3, R8**

### 2.3 Streaming Forwarder
- [ ] 2.3.1 Implement streaming forward: pipe upstream SSE chunks through Relay
- [ ] 2.3.2 Handle upstream chunk format (TO CONFIRM — may be OpenAI-compatible natively)
- [ ] 2.3.3 Handle upstream stream errors → close client connection with error chunk
- [ ] 2.3.4 Handle client disconnect → abort upstream request
- **Validates: R7**

**Checkpoint 2:** RequestForwarder sends a chat request to Copilot API with valid token and returns the response. Streaming works.

---

## Phase 3: Compatibility Layer (OpenAI Shape)

### 3.1 OpenAI Request Parser
- [ ] 3.1.1 Parse `POST /v1/chat/completions` body into `InternalChatRequest`
- [ ] 3.1.2 Support `model`, `messages`, `temperature`, `top_p`, `max_tokens`, `stream`, `stop`, `presence_penalty`, `frequency_penalty`, `user`
- [ ] 3.1.3 Validate required fields; return 400 with clear message on invalid input
- [ ] 3.1.4 Map unsupported model names → 400 with supported list
- [ ] 3.1.5 Unit test: valid OpenAI request → correct InternalChatRequest
- [ ] 3.1.6 Unit test: missing `messages` → 400
- [ ] 3.1.7 Unit test: unsupported model → 400
- **Validates: R3**

### 3.2 OpenAI Response Formatter
- [ ] 3.2.1 Translate `InternalChatResponse` → OpenAI `chat.completions` JSON schema
- [ ] 3.2.2 Set `id` to `chatcmpl-<uuid>`, `model` from request, `usage` from CreditAnalyzer
- [ ] 3.2.3 Return correct HTTP headers (`Content-Type: application/json`)
- [ ] 3.2.4 Unit test: InternalChatResponse → correct OpenAI JSON
- **Validates: R3**

### 3.3 OpenAI Streaming Formatter
- [ ] 3.3.1 Translate each `InternalStreamChunk` → SSE `data: {...}\n\n`
- [ ] 3.3.2 Send `data: [DONE]` on stream end
- [ ] 3.3.3 Set `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`
- [ ] 3.3.4 Handle back-pressure (client reads slower than upstream produces)
- [ ] 3.3.5 Unit test: stream of chunks → correct SSE output
- **Validates: R3, R7**

### 3.4 Chat Endpoint Registration
- [ ] 3.4.1 Register `POST /v1/chat/completions` route in API Gateway
- [ ] 3.4.2 Wire: parse → normalize → cache check → dedup check → forward → format → respond
- [ ] 3.4.3 Remove `POST /v1/completions` as primary endpoint (keep as optional redirect or remove)
- **Validates: R3**

**Checkpoint 3:** Client can `curl POST http://localhost:8080/v1/chat/completions` with an OpenAI-shaped body and get a valid OpenAI-shaped response (non-streaming and streaming).

---

## Phase 4: Caching

### 4.1 Request Normalisation and Hashing
- [ ] 4.1.1 Implement `normalizeRequest()`: collapse whitespace in message content, round temperature/top_p to 2 decimals, sort fields
- [ ] 4.1.2 Implement `generateContextHash()`: SHA-256 of `model || messages || temperature || top_p || max_tokens || penalties`
- [ ] 4.1.3 Unit test: same messages → same hash
- [ ] 4.1.4 Unit test: different messages → different hash
- [ ] 4.1.5 Unit test: whitespace-only differences → identical hash
- **Validates: R5**

### 4.2 Exact Cache for Chat Responses
- [ ] 4.2.1 Adapt CacheManager to store/retrieve by chat context hash
- [ ] 4.2.2 On cache hit: return cached `InternalChatResponse` directly
- [ ] 4.2.3 On cache hit (streaming): synthesise fake SSE stream from cached response
- [ ] 4.2.4 LRU eviction, configurable max entries, configurable TTL
- [ ] 4.2.5 Unit test: store then retrieve exact match → cached response
- [ ] 4.2.6 Unit test: TTL expired → cache miss
- [ ] 4.2.7 Unit test: LRU eviction removes oldest entry
- **Validates: R5**

### 4.3 Prefix Caching
- [ ] 4.3.1 Implement `splitPrefix()`: extract system message + tool schema messages as prefix
- [ ] 4.3.2 Hash the prefix separately → `prefixHash`
- [ ] 4.3.3 On cache lookup: check prefix cache first; on hit, combine prefix response with fresh tail
- [ ] 4.3.4 Separate LRU for prefix cache (smaller, since fewer unique prefixes than full conversations)
- [ ] 4.3.5 Unit test: identical prefixes → prefix cache hit
- [ ] 4.3.6 Unit test: prefix cache hit + different tail → combined response
- **Validates: R5**

**Checkpoint 4:** Two identical chat requests → second served from cache (zero credits). Two requests with same system prompt but different user messages → prefix cache hit, only tail matters.

---

## Phase 5: Credit Tracking

### 5.1 Token Counting (tiktoken)
- [ ] 5.1.1 Count input tokens from `InternalChatRequest.messages`
- [ ] 5.1.2 Count output tokens from `InternalChatResponse.choices[].message.content`
- [ ] 5.1.3 Use `cl100k_base` encoding (tiktoken) for GPT models; character‑count fallback for others
- [ ] 5.1.4 Unit test: known prompt → known token count
- **Validates: R6**

### 5.2 Credit Calculation
- [ ] 5.2.1 Load per-model credit multipliers from config
- [ ] 5.2.2 Calculate: `credits = (inputTokens * inputMultiplier + outputTokens * outputMultiplier) / 1_000_000`
- [ ] 5.2.3 Record per-model cumulative credits in memory
- [ ] 5.2.4 Expose per-model credits via `/metrics` (`relay_credits_consumed_total{model}`)
- [ ] 5.2.5 Unit test: known token counts + known multiplier → correct credits
- [ ] 5.2.6 Unit test: model not in multiplier table → fallback to default multiplier
- **Validates: R6**

### 5.3 Credit Logging
- [ ] 5.3.1 After each request: log `{ model, inputTokens, outputTokens, creditsConsumed }`
- [ ] 5.3.2 Log at INFO level (low volume — one line per request)
- **Validates: R6**

**Checkpoint 5:** After a chat request, `/metrics` shows `relay_credits_consumed_total{model="gpt-4o"} 0.25`.

---

## Phase 6: Deduplication

### 6.1 Chat Deduplication (Non‑Streaming)
- [ ] 6.1.1 Adapt DedupManager to key by chat `contextHash`
- [ ] 6.1.2 On `isDuplicate`: return cached response or wait for primary
- [ ] 6.1.3 On primary completion: notify all waiters with same response
- [ ] 6.1.4 On primary failure: promote next waiter, re-forward
- [ ] 6.1.5 Unit test: 5 identical requests → 1 upstream call, same response
- [ ] 6.1.6 Unit test: primary fails → waiter becomes primary, retries
- **Validates: R4**

### 6.2 Chat Deduplication (Streaming)
- [ ] 6.2.1 Buffer primary's stream chunks in memory (up to configurable limit)
- [ ] 6.2.2 On primary stream end: replay buffered chunks as synthetic SSE to each waiter
- [ ] 6.2.3 On primary stream error: propagate error to all waiters
- [ ] 6.2.4 Unit test: 3 identical streaming requests → 1 upstream stream, all receive same chunks
- **Validates: R4, R7**

**Checkpoint 6:** Agentic fan‑out with identical prompts → single upstream call.

---

## Phase 7: Health, Metrics, Diagnostics

### 7.1 AuthManager Health Check
- [ ] 7.1.1 Add AuthManager health: `{ status, expiresAt, degraded }`
- [ ] 7.1.2 HealthMonitor checks AuthManager in health poll
- **Validates: R9**

### 7.2 Metrics Update
- [ ] 7.2.1 Add `relay_credits_consumed_total{model}` counter
- [ ] 7.2.2 Add `relay_cache_hit_total{type="exact"|"prefix"}` counter
- [ ] 7.2.3 Add `relay_active_streams` gauge
- **Validates: R9**

### 7.3 Diagnostics Update
- [ ] 7.3.1 `/diagnostics` shows: auth status, per-model credits, cache hit rate, prefix cache hit rate, connection pool stats
- **Validates: R9**

### 7.4 Cache Invalidation
- [ ] 7.4.1 `POST /cache/invalidate` clears both exact and prefix cache
- [ ] 7.4.2 Optional `userId` filter
- **Validates: R9**

**Checkpoint 7:** `/health` shows auth status, `/metrics` shows credit counters, `/diagnostics` shows full state.

---

## Phase 8: Testing

### 8.1 Auth Tests
- [ ] 8.1.1 Integration test: full device flow (mocked HTTP) → persisted token
- [ ] 8.1.2 Integration test: token refresh → old token replaced
- [ ] 8.1.3 Integration test: degraded mode → cache-only responses, 502 for misses
- **Validates: R1, R2, R8**

### 8.2 Chat Flow Tests
- [ ] 8.2.1 Integration test: OpenAI-shaped request → valid OpenAI-shaped response
- [ ] 8.2.2 Integration test: streaming request → valid SSE stream
- [ ] 8.2.3 Integration test: cache hit → no upstream call made
- [ ] 8.2.4 Integration test: prefix cache hit → only tail sent upstream
- [ ] 8.2.5 Integration test: deduplication → 5 identical requests, 1 upstream call
- **Validates: R3, R4, R5, R7**

### 8.3 Credit Tests
- [ ] 8.3.1 Integration test: after request, `/metrics` shows credits for used model
- [ ] 8.3.2 Integration test: multiple requests → credits accumulate
- **Validates: R6**

### 8.4 Token Failure Tests
- [ ] 8.4.1 Integration test: upstream 401 → AuthManager refreshes → retry succeeds
- [ ] 8.4.2 Integration test: upstream 401 + refresh fails → degraded mode
- **Validates: R8**

---

## Phase 9: Documentation

### 9.1 README Rewrite
- [ ] Rewrite README with new scope (see `README.md` rewrite spec)
- **Validates: documentation**

### 9.2 USAGE.md Rewrite
- [ ] Rewrite USAGE.md with `relay login`, OpenAI-compatible client config, troubleshooting
- **Validates: documentation**

### 9.3 config.example.yaml Update
- [ ] Update with new sections (auth, models.creditMultipliers, etc.)
- **Validates: documentation**

---

## Phase 10: Polish (Optional / Stretch)

- [ ] 10.1* Anthropic‑compatible endpoint (`POST /v1/messages`)
- [ ] 10.2* Dockerfile for containerised deployment
- [ ] 10.3* Docker Compose with optional Redis backend
- [ ] 10.4* Headless mode: accept `GITHUB_TOKEN` env var instead of device flow
- [ ] 10.5* `relay check-usage` command (show current Copilot usage/quota)
- [ ] 10.6* Prometheus alerting rules for degraded mode

---

## Dependency Map

```
Phase 1 (Auth) ──────────────────────────────────────────────┐
                                                              │
Phase 2 (Forwarder) ─────────────────────┐                   │
                                         │                   │
Phase 3 (Compatibility) ────────────┐    │                   │
                                    │    │                   │
Phase 4 (Caching) ─────────────┐    │    │                   │
                               │    │    │                   │
Phase 5 (Credits) ────────┐    │    │    │                   │
                          │    │    │    │                   │
Phase 6 (Dedup) ──────┐    │    │    │    │                   │
                      │    │    │    │    │                   │
Phase 7 (Health/Metrics) ───────────────────────────────────────┐
                      │    │    │    │    │    │               │
Phase 8 (Tests) ◄─────┴────┴────┴────┴────┴────┴───────────────┘
                                                              │
Phase 9 (Docs) ◄────────────────────────────────────────────────┘

Phases 1-6 can run sequentially; Phase 7 and 8 are parallel.
Phase 9 is last.
```
