/**
 * Metrics and monitoring types for the GitHub Copilot Token Optimizer Proxy.
 * 
 * These types define the structure of aggregated metrics and time ranges
 * used for performance monitoring and reporting.
 */

/**
 * Aggregated summary of proxy metrics over a time period.
 * 
 * Used for monitoring performance, cache effectiveness, and token savings.
 */
export interface MetricsSummary {
  /** Total number of completion requests processed */
  totalRequests: number;
  
  /** Percentage of requests that were served from cache (0-100) */
  cacheHitRate: number;
  
  /** Average request latency in milliseconds */
  averageLatency: number;
  
  /** Total number of tokens consumed by API calls */
  tokensConsumed: number;
  
  /** Total number of tokens saved by cache hits */
  tokensSaved: number;
  
  /** Percentage of potential tokens saved (tokensSaved / (tokensConsumed + tokensSaved) * 100) */
  savingsPercentage: number;
  
  /** Average number of requests processed per second */
  requestsPerSecond: number;
}


