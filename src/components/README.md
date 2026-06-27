# Components

This directory contains the core component implementations for the proxy service.

## Planned Components

- **APIGateway** - HTTP server and request routing
- **AuthenticationManager** - API key verification and user authentication
- **RequestProcessor** - Context extraction and hashing
- **CacheManager** - LRU cache with exact and fuzzy matching
- **DeduplicationManager** - Prevents duplicate simultaneous requests
- **RequestForwarder** - Connection pooling to GitHub Copilot API
- **TokenAnalyzer** - Token counting and budget tracking
- **MetricsCollector** - Prometheus metrics collection
- **ConfigurationManager** - Configuration loading and hot-reload
- **HealthMonitor** - Health checks and diagnostics

Each component will be implemented according to the interfaces defined in `src/types/`.
