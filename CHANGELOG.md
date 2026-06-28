# Changelog

## [2.0.1] - Docker Support & Client Integrations

### Added
- **Docker Support**: Added multi-stage `Dockerfile` and `docker-compose.yml` for zero-install, containerized deployments. Persists OAuth device flow tokens across restarts.
- **Native Gemini Format**: Integrated support for Google's Gemini API request (`contents` / `generationConfig`) and response (`candidates` / `usageMetadata`) formats, translating them to and fromcanonical types.
- **In-flight Stream Translation**: Formats streaming chunks from OpenAI or Anthropic provider protocols directly into Gemini's stream format in flight.
- **CI/CD Workflow**: Added GitHub Actions workflow (`docker-publish.yml`) to automatically build, test, and publish Docker images to GHCR on tags.

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
