/**
 * Configuration types for the GitHub Copilot Token Optimizer Proxy.
 * 
 * These types define the structure of the proxy's configuration,
 * including server settings, cache parameters, token budgets, and security options.
 */

/**
 * Complete proxy service configuration.
 */
export interface Configuration {
  /** Server and networking configuration */
  server: ServerConfig;
  
  /** Cache behavior and storage configuration */
  cache: CacheConfig;
  
  /** Token tracking and budget configuration */
  tokens: TokenConfig;
  
  /** Similarity matching configuration for fuzzy cache lookups */
  similarity: SimilarityConfig;
  
  /** Security and authentication configuration */
  security: SecurityConfig;

  /** Logging configuration */
  logging: LoggingConfig;

  /** Auth configuration for GitHub OAuth device flow */
  auth: AuthConfig;

  /** Models and credit multiplier configuration */
  models: ModelsConfig;

  /** Request deduplication configuration */
  deduplication: DeduplicationConfig;

  /** Prefix cache configuration */
  prefixCache: PrefixCacheConfig;

  /** Cache bypass configuration */
  cacheBypass: CacheBypassConfig;

  /** Provider configuration */
  provider?: any;

  /** Fuzzy cache configuration */
  fuzzyCache?: any;
}

/**
 * Logging configuration.
 */
export interface LoggingConfig {
  /** Log level: DEBUG, INFO, WARN, ERROR */
  level: string;

  /** Whether to pretty-print logs (disable in production) */
  prettyPrint: boolean;
}

/**
 * HTTP server and networking configuration.
 */
export interface ServerConfig {
  /** Port number to listen on (1-65535) */
  port: number;
  
  /** Host address to bind to (e.g., '0.0.0.0' for all interfaces, '127.0.0.1' for localhost) */
  host: string;
  
  /** Maximum number of concurrent requests the server will handle */
  maxConcurrentRequests: number;
  
  /** Request timeout in milliseconds before returning 503 Service Unavailable */
  requestTimeoutMs: number;
}

/**
 * Cache storage and eviction configuration.
 */
export interface CacheConfig {
  /** Time-to-live for cache entries in hours (entries older than this are expired) */
  ttlHours: number;
  
  /** Maximum number of entries to store in the cache */
  maxEntries: number;
  
  /** Whether to enable gzip compression for cached responses */
  compressionEnabled: boolean;

  /** Whether to enable encryption for cached data */
  encryptionEnabled?: boolean;

  /** Maximum number of prefix cache entries */
  prefixCacheMaxEntries?: number;
}

/**
 * Token consumption tracking and budget configuration.
 */
export interface TokenConfig {
  /** Optional daily token budget per user (undefined means unlimited) */
  budgetPerUserPerDay?: number;
  
  /** Percentage of budget at which to log a warning (0-100) */
  warningThresholdPercent: number;
}

/**
 * Similarity matching configuration for fuzzy cache lookups.
 */
export interface SimilarityConfig {
  /** Whether to enable similarity matching for near-duplicate contexts */
  enabled: boolean;
  
  /** Minimum similarity score (0-100) required to return a cached response */
  threshold: number;
  
  /** Maximum number of recent cache entries to search for similarity matches */
  maxSearchEntries: number;
}

/**
 * Security, authentication, and encryption configuration.
 */
export interface SecurityConfig {
  /** Whether to encrypt cached data at rest using AES-256 */
  encryptCache: boolean;
  
  /** API key for authenticating clients to Relay */
  apiKey?: string;
}

/**
 * Auth configuration for GitHub OAuth device flow.
 */
export interface AuthConfig {
  /** Path to store persisted token data */
  tokenStoragePath: string;

  /** Polling interval in milliseconds for device flow authorization */
  deviceFlowPollInterval: number;

  /** Margin in seconds before token expiry to trigger a refresh */
  refreshMargin: number;
}

/** Per-model credit multipliers */
export interface ModelMultiplier {
  /** Credits per 1M input tokens */
  input: number;

  /** Credits per 1M output tokens */
  output: number;
}

/**
 * Models configuration.
 */
export interface ModelsConfig {
  /** Credit multipliers keyed by model name */
  creditMultipliers: Record<string, ModelMultiplier>;
}

/**
 * Deduplication configuration.
 */
export interface DeduplicationConfig {
  /** Time window in milliseconds for deduplication */
  windowMs: number;

  /** Maximum buffer size in bytes for streaming deduplication */
  maxStreamBufferBytes: number;
}

/**
 * Prefix cache configuration.
 */
export interface PrefixCacheConfig {
  /** Maximum number of entries in the prefix cache */
  maxEntries: number;
}

/**
 * Cache bypass configuration.
 */
export interface CacheBypassConfig {
  /** Whether to bypass cache when temperature is non-zero */
  bypassOnNonZeroTemperature: boolean;

  /** Whether to bypass cache when tools with side effects are present */
  bypassOnToolsWithSideEffects: boolean;
}
