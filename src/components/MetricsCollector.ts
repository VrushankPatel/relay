import { createChildLogger } from '../utils/logger.js';
import type { MetricsSummary, TimeRange } from '../types/metrics.js';

interface RequestRecord {
  status: number;
  cached: boolean;
  latency: number;
  userId: string;
  timestamp: number;
}

export class MetricsCollector {
  private requests: RequestRecord[] = [];
  private tokensConsumed = 0;
  private tokensSaved = 0;
  private totalRequests = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private totalLatency = 0;
  private errorsByType: Map<string, number> = new Map();
  private logger: ReturnType<typeof createChildLogger>;

  constructor() {
    this.logger = createChildLogger('MetricsCollector');

    setInterval(() => this.cleanup(), 24 * 60 * 60 * 1000);
  }

  recordRequest(status: number, cached: boolean, latency: number, userId: string): void {
    this.requests.push({ status, cached, latency, userId, timestamp: Date.now() });
    this.totalRequests++;
    if (cached) this.cacheHits++;
    else this.cacheMisses++;
    this.totalLatency += latency;
  }

  recordTokens(consumed: number, saved: number): void {
    this.tokensConsumed += consumed;
    this.tokensSaved += saved;
  }

  recordError(errorType: string): void {
    this.errorsByType.set(errorType, (this.errorsByType.get(errorType) || 0) + 1);
  }

  getAggregatedMetrics(): MetricsSummary {
    const totalTokens = this.tokensConsumed + this.tokensSaved;
    const uptime = process.uptime();

    return {
      totalRequests: this.totalRequests,
      cacheHitRate: this.totalRequests > 0 ? (this.cacheHits / this.totalRequests) * 100 : 0,
      averageLatency: this.totalRequests > 0 ? Math.round(this.totalLatency / this.totalRequests) : 0,
      tokensConsumed: this.tokensConsumed,
      tokensSaved: this.tokensSaved,
      savingsPercentage: totalTokens > 0 ? (this.tokensSaved / totalTokens) * 100 : 0,
      requestsPerSecond: uptime > 0 ? this.totalRequests / uptime : 0,
    };
  }

  exportPrometheus(): string {
    const metrics = this.getAggregatedMetrics();
    const lines: string[] = [];

    lines.push('# HELP proxy_requests_total Total number of requests processed');
    lines.push('# TYPE proxy_requests_total counter');
    lines.push(`proxy_requests_total ${metrics.totalRequests}`);

    lines.push('# HELP proxy_cache_hits_total Number of cache hit requests');
    lines.push('# TYPE proxy_cache_hits_total counter');
    lines.push(`proxy_cache_hits_total ${this.cacheHits}`);

    lines.push('# HELP proxy_cache_misses_total Number of cache miss requests');
    lines.push('# TYPE proxy_cache_misses_total counter');
    lines.push(`proxy_cache_misses_total ${this.cacheMisses}`);

    lines.push('# HELP proxy_cache_hit_rate Current cache hit rate (0-100)');
    lines.push('# TYPE proxy_cache_hit_rate gauge');
    lines.push(`proxy_cache_hit_rate ${metrics.cacheHitRate}`);

    lines.push('# HELP proxy_latency_milliseconds Average request latency in ms');
    lines.push('# TYPE proxy_latency_milliseconds gauge');
    lines.push(`proxy_latency_milliseconds ${metrics.averageLatency}`);

    lines.push('# HELP proxy_tokens_consumed_total Total tokens consumed by API calls');
    lines.push('# TYPE proxy_tokens_consumed_total counter');
    lines.push(`proxy_tokens_consumed_total ${metrics.tokensConsumed}`);

    lines.push('# HELP proxy_tokens_saved_total Total tokens saved by caching');
    lines.push('# TYPE proxy_tokens_saved_total counter');
    lines.push(`proxy_tokens_saved_total ${metrics.tokensSaved}`);

    lines.push('# HELP proxy_errors_total Total errors by type');
    lines.push('# TYPE proxy_errors_total counter');
    for (const [type, count] of this.errorsByType) {
      lines.push(`proxy_errors_total{type="${type}"} ${count}`);
    }

    lines.push('# HELP proxy_uptime_seconds Service uptime');
    lines.push('# TYPE proxy_uptime_seconds gauge');
    lines.push(`proxy_uptime_seconds ${process.uptime()}`);

    return lines.join('\n') + '\n';
  }

  private cleanup(): void {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const before = this.requests.length;
    this.requests = this.requests.filter((r) => r.timestamp > cutoff);
    if (before !== this.requests.length) {
      this.logger.debug({ removed: before - this.requests.length }, 'Cleaned up old metrics records');
    }
  }
}
