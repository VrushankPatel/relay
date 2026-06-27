# Relay: GitHub Copilot Token Optimizer Proxy

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/VrushankPatel/relay/actions/workflows/release.yml/badge.svg?branch=master)](https://github.com/VrushankPatel/relay/actions/workflows/release.yml)
[![Release](https://img.shields.io/badge/release-v1.0.0-blue)](https://github.com/VrushankPatel/relay/releases)
[![Downloads](https://img.shields.io/github/downloads/VrushankPatel/relay/total)](https://github.com/VrushankPatel/relay/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](https://github.com/VrushankPatel/relay/releases)
[![Tests](https://img.shields.io/badge/tests-246%20passing-brightgreen)](https://github.com/VrushankPatel/relay/actions/workflows/release.yml)

A transparent proxy that sits between your IDE and GitHub Copilot's API to reduce token consumption through intelligent caching, request deduplication, and token budget management.

> ⭐ If you find this project useful, please consider [starring it on GitHub](https://github.com/VrushankPatel/relay)! Your support helps others discover it.

See the [full usage guide](USAGE.md) for detailed setup, IDE configuration, and troubleshooting.

---

## Quick Start

### Binary (recommended — no Node.js required)

Download the binary for your platform from [GitHub Releases](https://github.com/VrushankPatel/relay/releases):

```bash
export API_KEY="your-secret-key"
chmod +x relay-macos-arm64
./relay-macos-arm64
```

### From Source

```bash
git clone https://github.com/VrushankPatel/relay.git
cd relay
npm install
npm run build
export API_KEY="your-secret-key"
node dist/index.js
```

---

## Features

- **Exact Caching**: Return cached responses for identical code contexts — zero tokens spent
- **Fuzzy Caching**: Similar contexts (≥85% similarity) trigger cache hits without hitting the API
- **Request Deduplication**: Concurrent identical requests coalesce into a single API call
- **Token Budget Management**: Per-user daily token limits with configurable warning thresholds
- **Token Counting**: Accurate counting using `cl100k_base` (same tokenizer as GitHub Copilot)
- **AES-256-GCM Encryption**: Cache at rest encryption with PBKDF2 key derivation
- **Prometheus Metrics**: `/metrics` endpoint for observability
- **Hot Configuration**: Reload `config.yaml` without restart
- **Graceful Degradation**: Components degrade independently; the proxy stays up

---

## Comparison

| Feature | Without Proxy | With Relay |
|---|---|---|
| API calls for identical completions | 1 per request | 1 total (cached) |
| API calls for similar completions | 1 per request | 1 per unique context (fuzzy match) |
| Concurrent duplicate requests | N parallel calls | 1 call, N-1 wait |
| Token tracking | None | Per-user daily budgets |
| Observability | IDE-only | Prometheus metrics |

---

## Platform Support

| Platform | Binary | Status |
|---|---|---|
| macOS (Apple Silicon) | `relay-macos-arm64` | ✅ |
| macOS (Intel) | `relay-macos-x64` | ✅ |
| Linux (x64) | `relay-linux-x64` | ✅ |
| Linux (arm64) | `relay-linux-arm64` | ✅ |
| Windows (x64) | `relay-windows-x64.exe` | ✅ |

---

## Performance Targets

| Operation | Target (p95) |
|---|---|
| Cache lookup | <5ms |
| Request forwarding overhead | <50ms |
| Total proxy overhead | <70ms |
| Token analysis | <5ms |

---

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────────┐
│  IDE/Editor │────▶│  API Gateway │────▶│ RequestProcessor │
│  (VS Code,  │     │  :8080       │     │ (hash + normalize)│
│  JetBrains, │     └──────────────┘     └────────┬─────────┘
│  Neovim)    │                                    │
└─────────────┘                                    ▼
                                            ┌──────────────────┐
                                            │  CacheManager    │
                                            │  (exact + fuzzy) │
                                            └────────┬─────────┘
                                                     │ miss
                                                     ▼
                                            ┌──────────────────┐
                                            │ DedupManager     │
                                            │ (coalesce dupes) │
                                            └────────┬─────────┘
                                                     │
                                                     ▼
                                            ┌──────────────────┐
                                            │RequestForwarder  │
                                            │ (circuit breaker)│
                                            └────────┬─────────┘
                                                     │
                                                     ▼
                                            ┌──────────────────┐
                                            │ GitHub Copilot   │
                                            │ API              │
                                            └──────────────────┘
```

---

## Core Components

- **API Gateway** — HTTP server, routing, auth, concurrency limits
- **Request Processor** — Code context extraction, normalization, SHA-256 hashing
- **Cache Manager** — In-memory LRU cache with gzip compression and AES-256-GCM encryption
- **Deduplication Manager** — Waiter pattern for coalescing concurrent identical requests
- **Token Analyzer** — `cl100k_base` token counting, per-user budget enforcement
- **Request Forwarder** — HTTPS connection pooling with circuit breaker and retry
- **Metrics Collector** — Prometheus exposition at `/metrics`
- **Configuration Manager** — YAML loading with hot-reload via `fs.watchFile`
- **Health Monitor** — Component-level health checks and diagnostics

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/completions` | Submit code completion request |
| `GET` | `/health` | Service health check |
| `GET` | `/diagnostics` | Detailed diagnostic information |
| `GET` | `/metrics` | Prometheus metrics |
| `POST` | `/cache/invalidate` | Invalidate cache entries |

---

## Scripts

```bash
npm run build          # Build ESM + DTS
npm run bin:build      # Build binaries for all platforms (macOS/Linux/Windows)
npm test               # Run all tests
npm run test:watch     # Tests in watch mode
npm run typecheck      # TypeScript type checking
npm run lint           # ESLint
```

---

## Project Structure

```
.
├── src/
│   ├── components/        # Core component implementations
│   ├── types/             # TypeScript type definitions
│   ├── utils/             # Utility functions
│   └── index.ts           # Application entry point (shebanged)
├── tests/                 # Test files
├── USAGE.md               # Full user guide
├── config.yaml            # Configuration file (not in git)
├── config.example.yaml    # Example configuration
├── tsconfig.json          # TypeScript configuration
├── tsup.config.ts         # Build configuration
└── package.json           # Dependencies, scripts, pkg config
```

---

## Star History

If Relay helps you reduce your Copilot token consumption, consider giving it a ⭐ on [GitHub](https://github.com/VrushankPatel/relay). It helps others find the project and grow the community.

## License

MIT
