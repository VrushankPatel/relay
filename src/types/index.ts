/**
 * Centralized type exports for the GitHub Copilot Token Optimizer Proxy.
 * 
 * This file re-exports all types from individual modules for convenient importing.
 */

// Request and authentication types
export type {
  HTTPRequest,
  CompletionRequestBody,
  AuthenticatedRequest,
  AuthResult,
} from './requests.js';

// Cache types
export type {
  CacheEntry,
  CompressedResponse,
  CacheStatistics,
} from './cache.js';

// Code context types
export type {
  CodeContext,
  NormalizedContext,
} from './context.js';

// GitHub Copilot API types
export type {
  CopilotResponse,
  Completion,
} from './copilot.js';

// Configuration types
export type {
  Configuration,
  ServerConfig,
  CacheConfig,
  TokenConfig,
  SimilarityConfig,
  SecurityConfig,
  LoggingConfig,
} from './config.js';

// Metrics types
export type {
  MetricsSummary,
} from './metrics.js';

// Health monitoring types
export type {
  HealthStatus,
  ComponentHealth,
  DiagnosticInfo,
  PoolStatistics,
} from './health.js';
