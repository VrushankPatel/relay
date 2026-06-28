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

## Reporting a Vulnerability

If you discover a security vulnerability in Relay, please DO NOT open a public issue. Instead, send a private vulnerability report via GitHub Security Advisories or contact the maintainers directly.
