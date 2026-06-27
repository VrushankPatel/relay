/**
 * Centralized type exports for the GitHub Copilot Token Optimizer Proxy.
 * 
 * This file re-exports all types from individual modules for convenient importing.
 */

// Request and authentication types
export type {
  HTTPRequest,
  AuthenticatedRequest,
} from './requests.js';

// Cache types
export type {
  CacheEntry,
  CompressedResponse,
  CacheStatistics,
} from './cache.js';



// Configuration types
export type {
  Configuration,
  ServerConfig,
  CacheConfig,
  TokenConfig,
  SimilarityConfig,
  SecurityConfig,
  LoggingConfig,
  AuthConfig,
  ModelsConfig,
  ModelMultiplier,
  DeduplicationConfig,
  PrefixCacheConfig,
  CacheBypassConfig,
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

// Chat types
export type {
  ChatMessage,
  ToolCall,
  ToolDefinition,
  InternalChatRequest,
  NormalizedChatRequest,
  InternalChatResponse,
  ChatChoice,
  TokenUsage,
  InternalStreamChunk,
  StreamChoice,
  ChatCacheEntry,
} from './chat.js';

// Auth types
export type {
  AuthStatus,
  DeviceCodeResponse,
  AccessTokenResponse,
  AccessTokenErrorResponse,
  CopilotTokenResponse,
  PersistedTokenData,
  EncryptedEnvelope,
} from './auth.js';
