# Using Relay

## Installation

Using Make:
```bash
make install
make build
```

Or using npm:
```bash
npm install
npm run build
```

### Verifying Releases (Security)

When downloading a pre-built binary or Docker image from GitHub Releases, it is critical to verify that the artifact has not been tampered with. Relay provides out-of-band checksum verification to ensure the integrity of your download.

The `CHECKSUMS.sha256` file is generated at build time in our CI pipeline and is attached directly to the release asset. **It is never committed to the repository.** This security model ensures that a compromised commit cannot trivially swap both the malicious binary and its checksum together.

**To verify a binary download:**
1. Download both the binary for your platform and the `CHECKSUMS.sha256` file from the same release.
2. Run the checksum verification command:

   ```bash
   # macOS
   shasum -a 256 -c CHECKSUMS.sha256

   # Linux
   sha256sum -c CHECKSUMS.sha256
   ```

**To verify a Docker image:**
Instead of pulling the mutable `latest` or `version` tags (which could potentially be moved), pull the image by its immutable SHA-256 digest. You can find the digest on the GHCR package page or via the `gh` CLI for a specific release.

```bash
docker pull ghcr.io/vrushankpatel/relay@sha256:<digest>
```

## Provider Configuration

You can configure your chosen upstream LLM provider either in your `config.yaml` or entirely via environment variables (recommended for Docker).

### Environment Variables

When running without a config file (or to override it), the following environment variables are supported:

- `RELAY_PROVIDER`: The active provider (`openai`, `anthropic`, `copilot`, `generic`).
- `RELAY_PORT`: The port Relay will listen on (default: `9879`).
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

## Client Configuration & Tool Integration

To redirect standard client tools through Relay, you configure them to point to Relay's server address (default `http://localhost:9879`).

### 1. Claude Code CLI

Claude Code officially supports connecting via a gateway using environment variables.

To start Claude Code through Relay (configured with the Anthropic provider backend):

```bash
# Point Claude Code to Relay's API Gateway
export ANTHROPIC_BASE_URL="http://localhost:9879/v1"
# Set your Relay API key (if configured in security.apiKey), or use dummy
export ANTHROPIC_AUTH_TOKEN="your-relay-api-key"

# Run Claude Code normally
claude
```

> [!IMPORTANT]
> **Subscription Limitation:** This gateway redirection only works when Claude Code is billed via direct **Anthropic API Keys** (developer Console pay-as-you-go). It does **NOT** function when you are logged into Claude Code via a web browser session linked to a **Claude Pro/Team/Max** subscription, because those subscription models do not route requests through standard API gateway endpoints.

---

### 2. OpenCode

OpenCode accepts any custom OpenAI-compatible endpoint. It can be integrated using either the VS Code extension or the standalone CLI tool.

#### Automated Setup (Ollama & Standalone CLI)

If you are using the OpenCode Standalone CLI with local or cloud Ollama models, you can configure both Relay and OpenCode globally with one simple command:

```bash
npm run setup:opencode
```

This automated helper script locates your global OpenCode configuration (`~/.config/opencode/opencode.jsonc`), configures the `ollama` provider to point to Relay, whitelists the required models, and sets up your local `.env` configuration file pointing to Ollama. After running the script, simply:
1. Rebuild/start the Relay Docker proxy: `docker compose up -d --build`
2. Start OpenCode with your model: `ollama launch opencode --model glm-4.7:cloud`

#### Manual Configuration

**A. For the OpenCode VS Code Extension:**
Add the following keys to your global or project-level VS Code `settings.json`:
```json
{
  "opencode.openai.baseURL": "http://localhost:9879/v1",
  "opencode.openai.apiKey": "your-relay-api-key",
  "opencode.openai.model": "gpt-4o"
}
```

**B. For the Standalone CLI tool:**
Add the following keys to `/Users/vrushankpatel/.config/opencode/opencode.jsonc`:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (via Relay Proxy)",
      "options": {
        "baseURL": "http://localhost:9879/v1"
      },
      "models": {
        "glm-4.7:cloud": {
          "name": "glm-4.7:cloud"
        }
      }
    }
  }
}
```

Once configured, repeat requests in OpenCode will serve from Relay's exact or fuzzy cache, reducing API credit charges.

---

### 3. Cline (VS Code Extension)

To configure Cline to use Relay:
1. Open Cline Settings.
2. Under **Provider**, select **OpenAI Compatible**.
3. Set **Base URL** to `http://localhost:9879/v1`.
4. Enter your Relay API key (or `dummy`).
5. Choose your target model ID (e.g., `gpt-4o` or `claude-3-5-sonnet`).

---

### 4. Aider

Aider is BYOK (Bring Your Own Key) and model-agnostic. Route Aider through Relay by running:

```bash
# Redirect Aider through the proxy
export OPENAI_API_BASE="http://localhost:9879/v1"
export OPENAI_API_KEY="your-relay-api-key"

# Start Aider
aider --model gpt-4o
```

---

### 5. Google Gemini CLI

Relay features native translation support for Google's Gemini API wire format. 

```bash
# Redirect Gemini CLI to Relay
export GEMINI_BASE_URL="http://localhost:9879"

# Execute commands using an API key
gemini --api-key="your-relay-api-key" "Explain quantum computing in three sentences"
```

> [!WARNING]
> **OAuth Caveat:** Gemini CLI redirection only functions when configured with a direct **Gemini API Key** (Google AI Studio). Redirection does **NOT** work in OAuth/free-tier user login mode, as those library calls are bound to specific Google services endpoints.

## CLI Lifecycle Management

Relay includes a native command-line interface for managing the background daemon, checking system diagnostics, and inspecting logs.

### Subcommands

#### 1. `relay start [--daemon | -d]`
Starts the Relay proxy server. By default, it runs in the foreground, logging directly to stdout.

* **Foreground (Default):**
  ```bash
  relay start
  ```
* **Background Daemon Mode:**
  ```bash
  relay start --daemon
  # or
  relay start -d
  ```
  In daemon mode, Relay runs in the background, writes its process ID to `~/.relay/relay.pid`, and redirects logs to `~/.relay/relay.log`.

#### 2. `relay stop`
Gracefully shuts down a background daemon instance. It reads the PID file, confirms the target process is actually Relay (to prevent stale PID reuse conflicts), triggers a clean exit, and cleans up the PID file.
```bash
relay stop
# Output:
# Stopping Relay daemon (PID: 12345)...
# ✅ Relay daemon stopped.
```

#### 3. `relay status`
Reports the operational status of the Relay proxy, including uptime, daemon PID, active provider, lifetime cache hit rate, dashboard accessibility, and whether secrets are running on auto-generated configurations.
```bash
relay status
# Output:
# Status: RUNNING
# Uptime: 3450 seconds
# PID: 12345
# Current Provider: generic
# Cache Hit Rate: 42.5%
# Dashboard Reachable: Yes
# RELAY_CACHE_SECRET: auto-generated
# Admin API Key: explicit
```

#### 4. `relay doctor`
Runs diagnostic checks to verify configuration loading, state directory write permissions, and network resolution connectivity to the configured provider endpoint.
```bash
relay doctor
# Output:
# 🩺 Running Relay Sanity Diagnostics...
#   [PASS] Configuration file loaded and validated successfully.
#   [PASS] State directory (~/.relay) is writable.
#   [PASS] Network connectivity: Resolved hostname api.openai.com successfully.
#   [WARN] RELAY_CACHE_SECRET is auto-generated. Review before production use.
#   [PASS] Admin API Key is explicitly configured.
# 
# ✅ All diagnostics passed successfully.
```

#### 5. `relay logs`
Tails the background log output of a running daemonized instance in real time (equivalent to `tail -f`).
```bash
relay logs
```

---

## Compatibility Matrix

| Client Tool | Support Status | Redirection Mode | Notes |
|-------------|----------------|------------------|-------|
| **Claude Code** | ✅ Supported | `ANTHROPIC_BASE_URL` | Requires API-key developer billing, not web Pro/Max subscriptions |
| **OpenCode** | ✅ Supported | `settings.json` | Fully compatible |
| **Google Gemini CLI** | ✅ Supported | `GEMINI_BASE_URL` | Requires Gemini API Key, OAuth logins bypass |
| **Cline** | ✅ Supported | UI settings (OpenAI) | Works seamlessly |
| **Aider** | ✅ Supported | `OPENAI_API_BASE` | Fully compatible |
| **VS Code Copilot** | ❌ Unsupported | N/A | Hijacking VS Code's internal extension is not recommended |

---

## Monitoring

Relay exposes Prometheus metrics at `/metrics`. This allows you to monitor cache hit rates, proxy latency, and credit usage:
- `relay_requests_total`: Request count.
- `relay_credits_saved_by_cache_total`: Saved credits.
- `relay_credits_consumed_by_model_total`: Consumed credits.

---

## Troubleshooting

| Issue | Resolution |
|-------|------------|
| Connection Refused | Ensure Relay is running and port `9879` (or `server.port`) is free. |
| Cache Misses | Verify that temperature > 0 is not bypassing the cache (see `cacheBypass` config). |
| High Latency | Check upstream API latency and ensure circuit breakers are not tripping. |

