# GitHub Copilot Token Optimizer Proxy

A transparent proxy service that sits between developers' IDEs and the GitHub Copilot API to reduce token consumption through intelligent caching, deduplication, and optimization strategies.

## Features

- **Intelligent Caching**: Exact and fuzzy matching of code contexts to serve cached responses
- **Request Deduplication**: Coalesces simultaneous identical requests to reduce API calls
- **Token Tracking**: Comprehensive token consumption analysis and budget management
- **Response Optimization**: Compression and deduplication to minimize bandwidth and storage
- **Metrics & Monitoring**: Prometheus-compatible metrics for observability
- **Hot Configuration**: Reload configuration without service restart
- **Graceful Degradation**: Continues operation even when components fail
- **Security**: API key authentication and AES-256 cache encryption

## Performance Targets

- Cache lookup: < 5ms (p95)
- Request forwarding overhead: < 50ms (p95)
- Total proxy overhead: < 70ms (p95)
- Token analysis: < 5ms (p95)

## Architecture

The proxy implements a layered architecture with these core components:

- **API Gateway**: Handles HTTP connections and routing
- **Request Processor**: Context extraction and hashing
- **Cache Manager**: LRU cache with exact and fuzzy matching
- **Deduplication Manager**: Prevents duplicate simultaneous requests
- **Token Analyzer**: Token counting and budget tracking (using tiktoken)
- **Request Forwarder**: Connection pooling to GitHub Copilot API
- **Metrics Collector**: Prometheus metrics exposition
- **Configuration Manager**: Hot-reloadable YAML configuration
- **Health Monitor**: Health checks and diagnostics

## Installation

```bash
npm install
```

## Building

```bash
npm run build
```

## Running

```bash
npm start
```

## Configuration

Create a `config.yaml` file (see `config.example.yaml` for template):

```yaml
server:
  port: 8080
  host: '0.0.0.0'
  maxConcurrentRequests: 100
  requestTimeoutMs: 5000

cache:
  ttlHours: 24
  maxEntries: 10000
  compressionEnabled: true
  redisUrl: null  # Optional Redis backing store

tokens:
  budgetPerUserPerDay: 100000  # Optional token budget per user
  trackingEnabled: true
  warningThresholdPercent: 90

similarity:
  enabled: true
  threshold: 85  # Similarity percentage for fuzzy matching
  maxSearchEntries: 100

security:
  apiKeyRequired: true
  encryptCache: true
  httpsOnly: true
```

## Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage
```

## Development

```bash
# Build in watch mode
npm run dev

# Lint code
npm run lint

# Format code
npm run format

# Type check
npm run typecheck
```

## API Endpoints

### Completion Requests
- `POST /v1/completions` - Submit code completion request

### Health & Monitoring
- `GET /health` - Service health check
- `GET /diagnostics` - Detailed diagnostic information
- `GET /metrics` - Prometheus metrics

### Cache Management
- `POST /cache/invalidate` - Invalidate cache entries

## Metrics

The proxy exposes Prometheus-compatible metrics:

- `proxy_requests_total{status, cached}` - Total requests processed
- `proxy_cache_hit_rate` - Cache hit percentage
- `proxy_latency_milliseconds{endpoint}` - Request latency distribution
- `proxy_tokens_consumed_total{user}` - API tokens consumed per user
- `proxy_tokens_saved_total{user}` - Tokens saved through caching per user
- `proxy_active_connections` - Current active connections
- `proxy_cache_size` - Current cache entry count
- `proxy_errors_total{type}` - Errors by type

## Project Structure

```
.
├── src/
│   ├── components/        # Core component implementations
│   ├── types/            # TypeScript type definitions
│   ├── utils/            # Utility functions
│   └── index.ts          # Application entry point
├── tests/                # Test files
├── config.yaml           # Configuration file (not in git)
├── tsconfig.json         # TypeScript configuration
├── tsup.config.ts        # Build configuration
└── package.json          # Dependencies and scripts
```

## License

MIT
