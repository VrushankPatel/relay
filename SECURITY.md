# Security

Relay handles extremely sensitive data, including proprietary source code, internal system prompts, and potentially PII within code snippets. As a caching proxy, it persists this data to disk to prevent redundant upstream API calls.

## Cache Encryption (AES-256-GCM)

By default, Relay encrypts all cached responses at rest using AES-256-GCM (`encryptCache: true` in `config.yaml`).

### Why is this the default?

Writing plain-text source code and prompts to disk introduces significant data exfiltration risks if the host machine is compromised, or if a user accidentally backs up the `.relay` directory to a public location.

The CPU overhead of AES-256-GCM encryption and decryption in Node.js is negligible (typically <1ms per request), while the security benefit is substantial. We strongly recommend leaving this enabled.

### Token Persistence

OAuth device flow credentials (such as GitHub Copilot tokens) are similarly encrypted at rest using AES-256-GCM with a securely derived key (PBKDF2 SHA-256) and random IVs and salts. This prevents plain-text credential leaks.

## Reporting a Vulnerability

If you discover a security vulnerability in Relay, please DO NOT open a public issue. Instead, send a private vulnerability report via GitHub Security Advisories or contact the maintainers directly.
