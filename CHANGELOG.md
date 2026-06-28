# Changelog

## [2.0.1] - 2026-06-28

### Added
- **Docker Support**: Added multi-stage `Dockerfile` and `docker-compose.yml` for zero-install, containerized deployments. Persists OAuth device flow tokens across restarts.
- **Environment Overrides**: Added full environment variable override support in `ConfigurationManager` (e.g., `RELAY_PROVIDER`, `RELAY_PORT`, `RELAY_HOST`).
- **Encrypted Cache Persistence**: Implemented AES-256-GCM file-based persistence for `CacheManager` to align with `SECURITY.md` compliance standards.
- **Native Gemini Format**: Integrated support for Google's Gemini API request (`contents` / `generationConfig`) and response (`candidates` / `usageMetadata`) formats, translating them to and from canonical types.
- **In-flight Stream Translation**: Formats streaming chunks from OpenAI or Anthropic provider protocols directly into Gemini's stream format in flight.
- **CI/CD Workflow**: Added GitHub Actions workflow (`docker-publish.yml`) to automatically build, test, and publish Docker images to GHCR on tags.
- **Makefile Orchestration**: Added a GNU `Makefile` wrapping common workflows (`install`, `build`, `test`, `typecheck`, `docker-build`, `docker-up`, `docker-down`, `clean`) to simplify orchestration.
- **Discoverability Assets**: Generated new architecture diagrams and performance benchmark tables for the README, and updated GitHub topics for enhanced search intent alignment.

### Fixed
- **Anthropic Tool Calling**: Fixed stream chunk translations related to Anthropic `tool_use` and `tool_result` roles, ensuring seamless agent workflow execution.
- **Dynamic Pricing Initialization**: Fixed pricing bugs where dynamic fetching caused race conditions during proxy hot paths.

### Verified
- **Claude Code**: Verified and documented integration using `ANTHROPIC_BASE_URL` with pay-as-you-go key billing.
- **OpenCode**: Verified and documented OpenAI compatible caching configuration.
- **Cline & Aider**: Verified OpenAI compatible gateway integration.

### Evaluated (Non-Targets)
- **GitHub Copilot CLI / Kiro / Antigravity CLI**: Evaluated and documented integration limitations and upstream blockers (e.g. [kirodotdev/Kiro#9367](https://github.com/kirodotdev/Kiro/issues/9367)) in `COMPLIANCE.md`.

## [2.0.0] - Provider Agnostic Release

### Major Changes (Breaking)
- **Identity Rebrand**: Renamed package from `copilot-token-optimizer-proxy` to `relay`. The project is now positioned as a provider-agnostic caching and deduplication proxy for all major LLMs (OpenAI, Anthropic, generic backends) rather than just a GitHub Copilot cost optimizer.
- **Provider Refactor**: Extracted all provider-specific logic (OpenAI, Anthropic, GitHub Copilot) into the new `IProvider` interface under `src/providers/`.
- **FuzzyGuard Integration**: Replaced the broken Levenshtein-on-SHA256 similarity logic with a robust, token-aware edit distance calculator (FuzzyGuard) that correctly caches similar prompts and falls back to exact matching under rapid-edit conditions (kill switch).

### Added
- **Security & Compliance**: Implemented `SECURITY.md` and enforced `encryptCache: true` by default in `config.example.yaml`. Added `COMPLIANCE.md` requiring explicit user consent for GitHub Copilot usage.
- **Dynamic Model Fetching**: The `OpenAIProvider` now fetches live model lists from `GET /v1/models`, ensuring accurate and up-to-date model pricing for token/credit tracking.
- **Benchmark Script**: Added `scripts/benchmark.ts` to test cold vs warm proxy interactions, calculate real latency differentials, and display total token cost savings using real dynamic provider pricing.
- **Robust Integration Testing**: Replaced the stub `proxy.test.ts` with a fully mocked, in-process proxy integration suite validating exact caching, fuzzy caching, kill switches, and concurrent deduplication.

### Removed
- Removed legacy Copilot-specific token optimization framing and keywords from `package.json`.
- Removed stale scratch files and `.patch` debugging artifacts from the repository root.
