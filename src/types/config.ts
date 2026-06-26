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
  
  /** Optional Redis connection URL for persistent cache storage */
  redisUrl?: string;
}

/**
 * Token consumption tracking and budget configuration.
 */
export interface TokenConfig {
  /** Optional daily token budget per user (undefined means unlimited) */
  budgetPerUserPerDay?: number;
  
  /** Whether to enable token consumption tracking */
  trackingEnabled: boolean;
  
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
  /** Whether to require API key authentication for incoming requests */
  apiKeyRequired: boolean;
  
  /** Whether to encrypt cached data at rest using AES-256 */
  encryptCache: boolean;
  
  /** Whether to enforce HTTPS-only communication with GitHub Copilot API */
  httpsOnly: boolean;
}
