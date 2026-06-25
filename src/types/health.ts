/**
 * Health monitoring and diagnostics types for the GitHub Copilot Token Optimizer Proxy.
 * 
 * These types define the structure of health check responses, component status,
 * and diagnostic information for system monitoring and troubleshooting.
 */

import type { CacheStatistics } from './cache.js';
import type { Configuration } from './config.js';
import type { MetricsSummary } from './metrics.js';

/**
 * Overall health status of the proxy service.
 */
export interface HealthStatus {
  /** Whether the overall service is healthy and operational */
  healthy: boolean;
  
  /** Health status of individual components, keyed by component name */
  components: Map<string, ComponentHealth>;
  
  /** Service uptime in seconds */
  uptime: number;
}

/**
 * Health status of an individual component.
 */
export interface ComponentHealth {
  /** Name of the component (e.g., 'CacheManager', 'TokenAnalyzer', 'RequestForwarder') */
  name: string;
  
  /** Current status of the component */
  status: 'healthy' | 'degraded' | 'failed';
  
  /** Most recent error message if the component has failed */
  lastError?: string;
  
  /** Timestamp of the last health check for this component */
  lastCheck: Date;
}

/**
 * Detailed diagnostic information about the proxy service.
 * 
 * Exposed via the /diagnostics endpoint for troubleshooting and monitoring.
 */
export interface DiagnosticInfo {
  /** Version string of the proxy service */
  version: string;
  
  /** Service uptime in seconds */
  uptime: number;
  
  /** Current configuration being used by the service */
  configuration: Configuration;
  
  /** Current cache performance statistics */
  cacheStats: CacheStatistics;
  
  /** Connection pool statistics for GitHub Copilot API connections */
  poolStats: PoolStatistics;
  
  /** Aggregated metrics summary */
  metrics: MetricsSummary;
}

/**
 * Statistics about the connection pool to GitHub Copilot API.
 */
export interface PoolStatistics {
  /** Total number of connections in the pool */
  totalConnections: number;
  
  /** Number of connections currently in use */
  activeConnections: number;
  
  /** Number of requests waiting for an available connection */
  queuedRequests: number;
  
  /** Average latency for forwarded requests in milliseconds */
  averageLatency: number;
}
