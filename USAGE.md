# Relay: GitHub Copilot Token Optimizer Proxy — Usage Guide

A transparent proxy that sits between your IDE and GitHub Copilot's API to reduce token consumption through intelligent caching, request deduplication, and token budget management.

---

## Quick Start

### 1. Download

Download the binary for your platform from [GitHub Releases](https://github.com/VrushankPatel/relay/releases):

| Platform | Binary |
|---|---|
| macOS (Apple Silicon) | `relay-macos-arm64` |
| macOS (Intel) | `relay-macos-x64` |
| Linux (x64) | `relay-linux-x64` |
| Linux (arm64) | `relay-linux-arm64` |
| Windows (x64) | `relay-windows-x64.exe` |

Or if you have Node.js installed:

```bash
npx copilot-token-optimizer-proxy
```

### 2. Run

```bash
chmod +x relay-macos-arm64    # macOS/Linux only
export API_KEY="your-secret-key"
./relay-macos-arm64
```

You'll see:
```
INFO: GitHub Copilot Token Optimizer Proxy starting (version: 1.0.0)
INFO: Configuration loaded
INFO: API Gateway started on 0.0.0.0:8080
```

### 3. Point Your IDE at the Proxy

Set your IDE to use `http://localhost:8080` as the Copilot API endpoint instead of `https://api.githubcopilot.com`.

**VS Code:**
```json
// settings.json
{
  "github.copilot.advanced": {
    "authProvider": "github",
    "debug.useNodeFetcher": true,
    "debug.overrideProxyUrl": "http://localhost:8080"
  }
}
```

**JetBrains (IntelliJ, WebStorm, etc.):**
- File → Settings → Tools → **GitHub Copilot**
- Set **"Copilot API URL"** to `http://localhost:8080`

**Neovim (copilot.lua):**
```lua
require("copilot").setup({
  proxy = "http://localhost:8080",
})
```

**Zed:**
```json
// ~/.config/zed/settings.json
{
  "copilot": {
    "server": "http://localhost:8080"
  }
}
```

---

## Configuration

Create `config.yaml` in the same directory as the binary:

```yaml
server:
  port: 8080
  host: '0.0.0.0'
  maxConcurrentRequests: 100
  requestTimeoutMs: 5000

cache:
  ttlHours: 24            # How long to keep cached responses
  maxEntries: 10000       # Maximum cache entries before LRU eviction
  compressionEnabled: true # Gzip compress cached responses

tokens:
  budgetPerUserPerDay: null  # Optional: daily token cap per user
  warningThresholdPercent: 90 # Warn when user reaches this % of budget

similarity:
  enabled: true           # Enable fuzzy cache matching
  threshold: 85           # Minimum similarity % for a fuzzy hit
  maxSearchEntries: 100   # Recent entries to search for similarity

security:
  encryptCache: true      # AES-256-GCM encrypt cached data

logging:
  level: 'INFO'           # DEBUG, INFO, WARN, ERROR
  prettyPrint: true       # Human-readable logs (disable in production)
```

If no `config.yaml` is found, sane defaults are used.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `API_KEY` | `dev-key` | API key clients must send as `Authorization: Bearer <key>` |
| `ENCRYPTION_SECRET` | — | Secret for AES-256-GCM cache encryption (32+ chars recommended) |
| `CONFIG_PATH` | `config.yaml` | Path to configuration file |
| `PORT` | from config | Override server port |
| `HOST` | from config | Override server host |

---

## IDE Authentication

Clients authenticate with an HTTP header:

```
Authorization: Bearer your-api-key
x-github-token: your-copilot-token
```

- `Authorization` — your proxy API key (set via `API_KEY` env var)
- `x-github-token` — the user's GitHub Copilot token (forwarded to the Copilot API as-is)

The proxy validates the `Authorization` header locally, then forwards the `x-github-token` to GitHub Copilot for API access.

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/completions` | Submit a code completion request (main endpoint) |
| `GET` | `/health` | Health check (200 = healthy, 503 = degraded) |
| `GET` | `/diagnostics` | Detailed diagnostic information |
| `GET` | `/metrics` | Prometheus-compatible metrics |
| `POST` | `/cache/invalidate` | Invalidate cache entries |

### Example: Health Check

```bash
curl http://localhost:8080/health
```

```json
{
  "status": "healthy",
  "uptime": 3600,
  "components": {
    "CacheManager": {"status": "healthy"},
    "RequestForwarder": {"status": "healthy"},
    "DeduplicationManager": {"status": "healthy"},
    "TokenAnalyzer": {"status": "healthy"}
  }
}
```

### Example: Prometheus Metrics

```bash
curl http://localhost:8080/metrics
```

```
# HELP proxy_requests_total Total requests processed
# TYPE proxy_requests_total counter
proxy_requests_total{status="200",cached="true"} 42
proxy_requests_total{status="200",cached="false"} 158

# HELP proxy_cache_hit_rate Cache hit percentage
# TYPE proxy_cache_hit_rate gauge
proxy_cache_hit_rate 21.0
```

---

## How Caching Works

1. **Request arrives** → IDE sends a completion request
2. **Context extraction** → the proxy extracts the code around your cursor
3. **Normalization** → whitespace/tabs are normalized for consistent hashing
4. **Hash generation** → a SHA-256 hash of the normalized context
5. **Exact cache lookup** → if the exact context was seen before, the cached response is returned immediately (zero tokens spent)
6. **Fuzzy cache lookup** → if no exact match, the last 100 entries are searched for similar contexts (≥85% similarity)
7. **Deduplication check** → if another request with the same context is already in-flight, this request waits for that response instead of making a new API call
8. **API forward** → if nothing was cached, the request goes to the Copilot API
9. **Cache store** → the response is compressed (gzip), optionally encrypted (AES-256-GCM), and stored with LRU tracking

---

## Token Budget Management

If you set `tokens.budgetPerUserPerDay` in the config, the proxy will:

- Track token consumption per user per day (resets at midnight UTC)
- Warn at the configured threshold (e.g., 90%)
- Return **429 Budget Exceeded** when the user hits their limit
- Count tokens using the same `cl100k_base` tokenizer that GitHub Copilot uses

---

## Running as a Service

### macOS (launchd)

Create `~/Library/LaunchAgents/com.relay.proxy.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.relay.proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/relay-macos-arm64</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>API_KEY</key>
    <string>your-secret-key</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.relay.proxy.plist
```

### Linux (systemd)

```ini
# /etc/systemd/system/relay.service
[Unit]
Description=Relay Copilot Token Optimizer Proxy
After=network.target

[Service]
ExecStart=/usr/local/bin/relay-linux-x64
Environment=API_KEY=your-secret-key
Restart=always
User=nobody

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable relay --now
```

---

## Performance

| Operation | Target (p95) |
|---|---|
| Cache lookup | <5ms |
| Fuzzy similarity search (100 entries) | <10ms |
| Request forwarding overhead | <50ms |
| Total proxy overhead | <70ms |
| Token analysis | <5ms |

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| `ECONNREFUSED` on proxy address | Proxy not running | Check `./relay-macos-arm64` is running |
| `401 Unauthorized` | Wrong or missing API key | Set `API_KEY` env var and send it as `Authorization` header |
| `429 Budget Exceeded` | Token budget hit | Increase `budgetPerUserPerDay` in config, or wait for midnight UTC reset |
| Zero cache hits | Contexts are too unique | Make sure similarity matching is enabled |
| High memory usage | Cache is full | Reduce `maxEntries` or `ttlHours` in config |
| `403 Forbidden` from Copilot | Invalid or expired GitHub token | Refresh the user's GitHub Copilot session |
| Proxy feels slow | DNS or network latency | Check `requestTimeoutMs` and network connectivity to `api.githubcopilot.com` |

---

## Building from Source

```bash
git clone https://github.com/VrushankPatel/relay.git
cd relay
npm install
npm run build
node dist/index.js
```

To build a standalone binary:

```bash
npm run bin:build
# Output in bin/
```

---

## License

MIT
