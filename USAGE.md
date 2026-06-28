# Using Relay

## Installation

```bash
npm install
npm run build
```

## Provider Configuration

You can configure your chosen upstream LLM provider either in your `config.yaml` or entirely via environment variables (recommended for Docker).

### Environment Variables

When running without a config file (or to override it), the following environment variables are supported:

- `RELAY_PROVIDER`: The active provider (`openai`, `anthropic`, `copilot`, `generic`).
- `RELAY_PORT`: The port Relay will listen on (default: `8080`).
- `RELAY_HOST`: The interface to bind to (default: `0.0.0.0`).
- `OPENAI_API_KEY`: API key for OpenAI provider.
- `ANTHROPIC_API_KEY`: API key for Anthropic provider.
- `GENERIC_API_KEY`: Optional API key for a generic backend.
- `GENERIC_BASE_URL`: Base URL for a generic backend (e.g. Ollama).
- `COPILOT_REQUIRE_CONSENT`: Must be set to `false` when using the Copilot provider programmatically.

### YAML Configuration

#### OpenAI (Primary, Recommended)

```yaml
provider:
  type: openai
  # apiKey: sk-... # Or use OPENAI_API_KEY environment variable
```

### Anthropic

```yaml
provider:
  type: anthropic
  # apiKey: sk-ant-... # Or use ANTHROPIC_API_KEY environment variable
```

### Generic (Ollama, Azure OpenAI, etc.)

```yaml
provider:
  type: generic
  baseUrl: http://localhost:11434 # e.g., Ollama
  # apiKey: optional-key
  isMeteredPerToken: false # Set true if this backend charges per token
```

### GitHub Copilot

⚠️ **Warning:** Using the GitHub Copilot backend requires organizational approval and acceptance of compliance terms. Please see [COMPLIANCE.md](./COMPLIANCE.md).

```yaml
provider:
  type: copilot
  requireConsent: true
```

## Client Configuration

To use Relay, you point your LLM clients to the Relay proxy instead of the default provider API.

### Python (openai library)

```python
from openai import OpenAI

# Point to Relay running on localhost
client = OpenAI(
    base_url='http://localhost:3000/v1',
    api_key='your-relay-api-key' # If configured in Relay, otherwise 'dummy'
)
```

### LangChain / LlamaIndex / Aider / Continue.dev

Configure the custom base URL in the respective tool to point to `http://localhost:3000/v1`.

### cURL

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Compatibility Matrix

| Client | Compatibility | Notes |
|--------|---------------|-------|
| OpenAI SDKs | ✅ Excellent | Fully compatible |
| LangChain / LlamaIndex | ✅ Excellent | Point custom base URL to proxy |
| Custom HTTP Clients | ✅ Excellent | Standard API interface |
| VS Code Copilot Extension | ⚠️ Unreliable | Hijacking VS Code's internal extension is not recommended and highly unreliable. |

## Monitoring

Relay exposes Prometheus metrics at the `/metrics` endpoint. This allows you to monitor cache hit rates, proxy latency, and request volume.

## Troubleshooting

| Issue | Resolution |
|-------|------------|
| Connection Refused | Ensure Relay is running and `server.port` matches your client config. |
| Cache Misses | Verify that temperature > 0 is not bypassing the cache (see `cacheBypass` config). |
| High Latency | Check upstream API latency and ensure circuit breakers are not tripping. |
