# Security

Relay handles extremely sensitive data, including proprietary source code, internal system prompts, and potentially PII within code snippets. As a caching proxy, it persists this data to disk to prevent redundant upstream API calls.

## Cache Encryption (AES-256-GCM)

By default, Relay encrypts all cached responses at rest using AES-256-GCM (`encryptCache: true` in `config.yaml`).

### Why is this the default?

Writing plain-text source code and prompts to disk introduces significant data exfiltration risks if the host machine is compromised, or if a user accidentally backs up the `.relay` directory to a public location.

The CPU overhead of AES-256-GCM encryption and decryption in Node.js is negligible (typically <1ms per request), while the security benefit is substantial. We strongly recommend leaving this enabled.

### Cache Encryption Key

When `RELAY_CACHE_SECRET` is explicitly set via environment variable, Relay uses it as the encryption key. 

If no secret is provided, Relay will automatically generate a cryptographically random 32-byte secret on first run. This auto-generated secret is persisted to a file named `cache_secret` in the parent directory of the cache (e.g., `~/.relay/cache_secret`) with restrictive file permissions (`0600`, owner read/write only). This ensures that without configuration, Relay still provides robust local security and prevents a hardcoded literal from compromising the cache.

**Important for Production**: Operators deploying Relay in shared, multi-tenant, or production environments should explicitly define `RELAY_CACHE_SECRET` and securely back it up. If the machine-local `cache_secret` file is lost or the container is rebuilt without a volume mount, all previously cached data becomes permanently undecryptable.

### Token Persistence

OAuth device flow credentials (such as GitHub Copilot tokens) are similarly encrypted at rest using AES-256-GCM with a securely derived key (PBKDF2 SHA-256) and random IVs and salts. This prevents plain-text credential leaks.

## Dashboard Authentication & Credential Isolation

To prevent credential leaks and unauthorized access, the operational dashboard is protected:

1. **Authentication Requirement**: Access to the `/dashboard` and `/diagnostics` endpoints is restricted. Operators must authenticate via an `Authorization: Bearer <key>` header or by passing the key in the query parameter (e.g. `?key=<key>` for browser visits).
2. **Auto-Generated Admin Key**: If no `security.apiKey` is explicitly defined in `config.yaml`, Relay will automatically generate a cryptographically random admin key on first run. This key is securely saved at `~/.relay/admin_api_key` with strict file permissions (`0600`) and logged once at startup. If no key is set or generated, the server refuses to serve the dashboard.
3. **Data Redaction (Allowlisting)**: The HTML generator only receives an allowlisted view of configuration metadata (e.g. if encryption is active or if secrets are auto-generated). Raw configuration properties, such as provider API keys or base URLs, are strictly omitted from the payload and can never leak.

### Verifying Your Deployment

To verify your deployment is secure:
1. Try accessing `http://localhost:9879/dashboard` in a browser without any credentials. It must return a `401 Unauthorized` response.
2. Verify that `~/.relay/admin_api_key` is present and has restricted file permissions (only readable by the owner).
3. If running in production, explicitly define `security.apiKey` in `config.yaml` to override the auto-generated key with your organization's managed secret.

## Reporting a Vulnerability

If you discover a security vulnerability in Relay, please DO NOT open a public issue. Instead, send a private vulnerability report via GitHub Security Advisories or contact the maintainers directly.
