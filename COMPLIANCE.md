# Relay — Compliance & Terms of Service Notice

## GitHub Copilot Backend

If you configure Relay to use the GitHub Copilot backend (`provider.type: copilot`), you must be aware of the following:

### GitHub's Acceptable Use Policy

GitHub's [Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies) state that:

> You may not use GitHub Copilot in a way that violates these policies, including by:
> - Using Copilot to develop or train other AI models
> - Reverse engineering, decompiling, or otherwise attempting to derive the source code of GitHub Copilot
> - Using automated means to access Copilot outside of the officially supported integrations

Using Relay as a proxy in front of GitHub Copilot's API may be considered "automated means to access Copilot outside of the officially supported integrations" and could result in **permanent suspension of your Copilot access with no guaranteed reinstatement**.

### Organizational Requirements

The Copilot backend in Relay is intended **exclusively for organizations** that have:

1. ✅ Obtained written approval from their GitHub administrator
2. ✅ Had their security team review this deployment
3. ✅ Accepted full responsibility for compliance with GitHub's Terms of Service
4. ✅ Configured the `compliance` section in their Relay config

### Individual Use

**Relay should NOT be used by individual users as a personal workaround** for Copilot's official IDE integrations. The risk of permanent account suspension is real and well-documented.

### Consent Gate

When the Copilot provider is selected, Relay requires explicit acceptance of these terms on first run. This consent is recorded with a timestamp at `~/.relay/consent.json`.

To accept programmatically (e.g., in CI/CD or Docker), use:
```bash
npm run relay -- copilot-consent --accept
```

## Other Backends (OpenAI, Anthropic, Generic)

Backends other than GitHub Copilot (OpenAI, Anthropic, self-hosted, etc.) operate using standard, documented, publicly available APIs with your own API keys. There are no ToS concerns with caching and deduplicating requests to these services — this is standard infrastructure practice.
