# Requirements Document — Relay (Revised Scope)

## Introduction

Relay is a caching and deduplicating gateway in front of GitHub Copilot's Chat and Agent backend. It presents an OpenAI‑compatible API (and optionally an Anthropic‑compatible one) so that any tool‑calling agent, CLI, or custom script can use a Copilot subscription without consuming redundant tokens. Relay performs its own GitHub OAuth Device Flow to obtain credentials rather than depending on an already‑running IDE session.

**Why this scope exists.** As of GitHub's June 2026 billing change, code completions and Next‑Edit suggestions are unlimited and unmetered. The only surfaces billed by GitHub AI Credits are **Chat, Agent mode, Copilot CLI, code review, and cloud agent sessions**. At the same time, the `debug.overrideProxyUrl` setting historically used to intercept inline completions was never a supported production feature and is being removed. A proxy that only intercepts completions has no token‑cost value and an increasingly unreliable interception path.

Relay therefore targets the billed surfaces directly, with credential management built in.

## Glossary

- **Device Flow** — GitHub OAuth device authorization grant; user visits a URL and enters a code to authorize the application.
- **Copilot Token** — Short‑lived session token issued by GitHub's token‑exchange endpoint that authenticates requests to `api.githubcopilot.com`.
- **GitHub Token** — Long‑lived OAuth access token (or, for headless use, a fine‑grained personal access token) used to refresh the Copilot session token.
- **Compatibility Layer** — Component that translates between Relay's internal chat‑request format and OpenAI‑ or Anthropic‑shaped request/response schemas.
- **Context Hash** — Deterministic hash of a normalised message array plus model plus sampling parameters, used as the cache key.
- **Prefix Cache** — Cache for the static portion of a conversation (system prompt, tool schemas) that is identical across many requests.
- **Exact Cache** — Cache that returns a hit only when the full context hash matches.
- **Deduplication** — Coalescing of concurrent identical in‑flight requests so only one upstream call is made.
- **In‑Flight Request** — A request that has been sent upstream and is awaiting a response.
- **AI Credits** — GitHub's usage‑billing unit; 1 credit = $0.01 USD as of June 2026.
- **Token Refresh** — Periodic re‑authentication to obtain a new Copilot session token before the current one expires.

## Requirements

### R1: GitHub OAuth Device Flow Login

**User Story:** As an operator, I want to authenticate Relay with my GitHub account using a simple terminal command, so that I do not need to manually provision or rotate credentials.

**Acceptance Criteria (EARS):**

1. WHEN the operator runs `relay login`, THE Relay CLI SHALL request a device code from GitHub's OAuth device‑authorisation endpoint.
2. WHEN a device code is received, THE Relay CLI SHALL display `user_code` and `verification_uri` to the terminal.
3. WHEN the operator enters the code at the displayed URI, THE Relay CLI SHALL poll GitHub's token endpoint until the access token is granted or the device code expires.
4. IF the device code expires before the operator authorises the application, THEN THE Relay CLI SHALL print an error message and exit with a non‑zero code.
5. WHEN an access token is received, THE Relay CLI SHALL exchange it for a Copilot session token via the GitHub Copilot token‑exchange endpoint.
6. WHEN the Copilot session token is received, THE Relay CLI SHALL persist the long‑lived GitHub access token (encrypted at rest using AES‑256‑GCM) to a configurable token storage path.
7. THE Relay CLI SHALL complete the full login flow without requiring an already‑running IDE or browser extension.

### R2: Token Refresh and Expiry Handling

**User Story:** As an operator, I want Relay to automatically refresh the Copilot session token before it expires, so that the proxy stays online without manual intervention.

**Acceptance Criteria (EARS):**

1. WHEN Relay starts, THE AuthManager SHALL check whether a persisted GitHub access token exists.
2. IF a persisted token exists, THE AuthManager SHALL exchange it for a fresh Copilot session token.
3. WHEN the Copilot session token is obtained, THE AuthManager SHALL schedule a refresh timer for `(refresh_in - 60) seconds` before the token's reported expiry.
4. WHEN the refresh timer fires, THE AuthManager SHALL re‑exchange the GitHub token for a new Copilot session token and reset the timer.
5. IF the token‑exchange endpoint returns an error (e.g. the GitHub token has been revoked), THEN THE AuthManager SHALL log a warning and fall back to serving cached responses only (degraded mode).
6. IF the token‑exchange endpoint still fails after 3 consecutive refresh attempts, THEN THE AuthManager SHALL require the operator to re‑run `relay login`.
7. WHEN the operator runs `relay login` while the proxy is running, THE AuthManager SHALL reload the new token without restarting the server.

### R3: OpenAI‑Compatible Chat Endpoint

**User Story:** As a user, I want to point an OpenAI‑compatible client at Relay's `/v1/chat/completions` endpoint, so that I can use any tool‑calling agent or library that speaks the OpenAI Chat API.

**Acceptance Criteria (EARS):**

1. WHEN a client sends a `POST /v1/chat/completions` request, THE CompatibilityLayer SHALL accept the request and parse it into Relay's internal chat‑request format.
2. WHEN the request is parsed, THE CompatibilityLayer SHALL forward it to the request processor for normalisation, caching, and deduplication checks.
3. WHEN the upstream Copilot API responds, THE CompatibilityLayer SHALL translate the response back into the OpenAI `chat.completions` schema and return it to the client.
4. The endpoint SHALL support the following OpenAI request fields: `model`, `messages`, `temperature`, `top_p`, `max_tokens`, `stream`, `stop`, `presence_penalty`, `frequency_penalty`, `user`.
5. WHEN the client requests streaming (`stream: true`), THE Relay SHALL stream response tokens back in Server‑Sent Events (SSE) format conforming to the OpenAI streaming schema.
6. WHEN the client connects with an unsupported model name, THE Relay SHALL reject the request with HTTP 400 and a clear error message listing supported models.
7. THE Relay SHALL NOT require the client to send any proprietary headers beyond standard OpenAI Chat API fields.

### R4: Request Deduplication for Concurrent Chat Calls

**User Story:** As a user running an agentic workflow that fans out several sub‑agent calls with the same prompt, I want Relay to coalesce those calls into a single upstream request, so that AI Credits are not multiplied.

**Acceptance Criteria (EARS):**

1. WHEN two or more requests with an identical context hash arrive within the deduplication window, THE DedupManager SHALL forward only the first to the upstream API.
2. WHEN a duplicate request is detected, THE DedupManager SHALL suspend the duplicate's response until the primary request completes.
3. WHEN the primary request completes, THE DedupManager SHALL deliver the same response (or error stream) to all suspended duplicates.
4. IF the primary request fails, THE DedupManager SHALL promote the next waiter to primary and re‑attempt the upstream call.
5. THE DedupManager SHALL track in‑flight requests by context hash and clean up entries after the request completes or all waiters are served.
6. THE DedupManager SHALL support deduplication for both streaming and non‑streaming requests, closing duplicate streams when the primary stream ends.

### R5: Exact and Prefix‑Based Caching

**User Story:** As an operator, I want repeated identical chat requests and repeated static prefixes (system prompt, tool schemas) to be served from cache, so that AI Credits are not consumed for boilerplate.

**Acceptance Criteria (EARS):**

1. WHEN an upstream response is received, THE CacheManager SHALL store it keyed by the full context hash.
2. WHEN a subsequent request arrives with a matching full context hash, THE CacheManager SHALL return the cached response without calling the upstream API.
3. WHEN the system prompt and tool‑schema portion of the messages array is identical to a previously cached prefix, THE CacheManager SHALL return the cached prefix response, appending only the variable tail (the conversation history after the prefix).
4. THE CacheManager SHALL support configurable TTL for cache entries (default 24 hours).
5. THE CacheManager SHALL complete cache lookup within 5 ms (p95).
6. THE CacheManager SHALL support optional AES‑256‑GCM encryption of cached data at rest and PBKDF2 key derivation.
7. THE CacheManager SHALL be in‑memory with LRU eviction; Redis SHOULD be supported as an optional distributed backend.

### R6: Per‑Model Credit Tracking

**User Story:** As an operator, I want to see how many AI Credits are being consumed per model, so that I can understand which models drive cost.

**Acceptance Criteria (EARS):**

1. WHEN a request is forwarded upstream and a response is received, THE TokenAnalyzer SHALL count input tokens, output tokens, and cached tokens using tiktoken (cl100k_base for GPT‑class models; fallback for others).
2. THE TokenAnalyzer SHALL multiply counted tokens by the model's published AI‑Credit multiplier and record the result as credits consumed.
3. THE TokenAnalyzer SHALL expose per‑model cumulative credit consumption via the `/metrics` endpoint in Prometheus format.
4. THE TokenAnalyzer SHALL emit a log line after each request with model name, input tokens, output tokens, and estimated credits consumed.
5. THE per‑model credit‑multiplier table SHALL be configurable (see `config.example.yaml`) so operators can update it when GitHub publishes new rates.

### R7: Streaming Response Support

**User Story:** As a user, I want Relay to support streaming chat responses so that I can see tokens as they are generated, matching the OpenAI streaming contract.

**Acceptance Criteria (EARS):**

1. WHEN the client sends `stream: true`, THE CompatibilityLayer SHALL pass the streaming flag to the upstream Copilot API.
2. WHEN the upstream returns a stream, THE CompatibilityLayer SHALL translate each chunk into the OpenAI SSE format (`data: {"choices":[{"delta":{"content":"..."}}]}`) and forward it to the client.
3. WHEN the stream ends, THE CompatibilityLayer SHALL send `data: [DONE]` to signal completion.
4. THE caching and deduplication subsystems SHALL correctly handle streaming responses: cache the complete response for non‑streaming re‑play, and splice the cached response into a synthetic stream for streaming replays.
5. IF the upstream stream errors mid‑response, THE CompatibilityLayer SHALL send the error as a well‑formed SSE error chunk and close the connection.

### R8: Graceful Behaviour on Invalid or Revoked Tokens

**User Story:** As an operator, I want Relay to stop sending requests to the upstream API and inform me clearly when the Copilot token is invalid or revoked, rather than returning confusing errors to clients.

**Acceptance Criteria (EARS):**

1. WHEN the upstream API returns HTTP 401 or HTTP 403 for a forwarded request, THE AuthManager SHALL check whether the Copilot session token is still valid.
2. IF the token is expired, THE AuthManager SHALL attempt an automatic refresh using the persisted GitHub token.
3. IF the refresh succeeds, THE AuthManager SHALL retry the original request.
4. IF the refresh fails, THE AuthManager SHALL enter **degraded mode**: serve cached responses only, return HTTP 502 with a clear error message for cache misses, and log the reason.
5. WHEN in degraded mode due to token failure, THE AuthManager SHALL emit a health‑check warning so monitoring can alert the operator.
6. WHEN the operator re‑runs `relay login` and provides fresh credentials while in degraded mode, THE AuthManager SHALL exit degraded mode and resume normal operation without restarting the server.
7. IN ALL CASES, THE Relay SHALL NOT forward the client's request to the upstream API with an invalid or expired token.

### R9: Client‑Facing API Compatibility

**User Story:** As a user, I want Relay to expose its health, metrics, and diagnostics endpoints so that I can monitor and troubleshoot the service.

**Acceptance Criteria (EARS):**

1. THE Relay SHALL expose `GET /health` returning HTTP 200 when all components are healthy and HTTP 503 when degraded.
2. THE Relay SHALL expose `GET /metrics` in Prometheus exposition format.
3. THE Relay SHALL expose `GET /diagnostics` returning configuration, cache statistics, connection‑pool state, and per‑model credit consumption.
4. THE Relay SHALL expose `POST /cache/invalidate` to clear cache entries by user or globally.

## Non‑Functional Requirements

**Performance:**
- Cache lookup: < 5 ms (p95)
- Request forwarding overhead: < 50 ms (p95) for non‑streaming, < 10 ms first‑token latency for streaming
- Token analysis: < 5 ms (p95)
- Total proxy overhead (non‑streaming): < 70 ms (p95)

**Scalability:**
- Support 100 concurrent users
- Support 500 chat requests per minute
- Cache capacity: 10 000 entries minimum (configurable)

**Security:**
- AES‑256‑GCM encryption for cached data at rest
- PBKDF2 key derivation from configurable secret
- Persistent GitHub tokens stored encrypted at rest
- No logging of full conversation content at INFO/WARN level
- Timing‑safe comparison for any API‑key authentication

**Reliability:**
- Graceful degradation on token expiry (cache‑only mode)
- Automatic token refresh
- Component‑level health monitoring with automatic restart
- Service uptime target: 99.9%
