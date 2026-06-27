import { createChildLogger } from '../utils/logger.js';
import type { MetricsSummary } from '../types/metrics.js';

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const RETENTION_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

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
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private creditsSavedByCache = 0;
  private creditsSavedByDedup = 0;
  private creditsConsumedByModel: Record<string, number> = {};

  constructor() {
    this.logger = createChildLogger('MetricsCollector');

    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  destroy(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
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

  recordCreditsSavedByCache(credits: number): void {
    this.creditsSavedByCache += credits;
  }

  recordCreditsSavedByDedup(credits: number): void {
    this.creditsSavedByDedup += credits;
  }

  recordModelCredits(model: string, credits: number): void {
    if (!this.creditsConsumedByModel[model]) {
      this.creditsConsumedByModel[model] = 0;
    }
    this.creditsConsumedByModel[model] += credits;
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
      creditsSavedByCache: this.creditsSavedByCache,
      creditsSavedByDedup: this.creditsSavedByDedup,
      creditsConsumedByModel: { ...this.creditsConsumedByModel },
    };
  }

  exportPrometheus(): string {
    const metrics = this.getAggregatedMetrics();
    const lines: string[] = [];

    lines.push('# HELP relay_requests_total Total number of requests processed');
    lines.push('# TYPE relay_requests_total counter');
    lines.push(`relay_requests_total ${metrics.totalRequests}`);

    lines.push('# HELP relay_cache_hits_total Number of cache hit requests');
    lines.push('# TYPE relay_cache_hits_total counter');
    lines.push(`relay_cache_hits_total ${this.cacheHits}`);

    lines.push('# HELP relay_cache_misses_total Number of cache miss requests');
    lines.push('# TYPE relay_cache_misses_total counter');
    lines.push(`relay_cache_misses_total ${this.cacheMisses}`);

    lines.push('# HELP relay_cache_hit_rate Current cache hit rate (0-100)');
    lines.push('# TYPE relay_cache_hit_rate gauge');
    lines.push(`relay_cache_hit_rate ${metrics.cacheHitRate}`);

    lines.push('# HELP relay_latency_milliseconds Average request latency in ms');
    lines.push('# TYPE relay_latency_milliseconds gauge');
    lines.push(`relay_latency_milliseconds ${metrics.averageLatency}`);

    lines.push('# HELP relay_tokens_consumed_total Total tokens consumed by API calls');
    lines.push('# TYPE relay_tokens_consumed_total counter');
    lines.push(`relay_tokens_consumed_total ${metrics.tokensConsumed}`);

    lines.push('# HELP relay_tokens_saved_total Total tokens saved by caching');
    lines.push('# TYPE relay_tokens_saved_total counter');
    lines.push(`relay_tokens_saved_total ${metrics.tokensSaved}`);

    lines.push('# HELP relay_errors_total Total errors by type');
    lines.push('# TYPE relay_errors_total counter');
    for (const [type, count] of this.errorsByType) {
      lines.push(`relay_errors_total{type="${type}"} ${count}`);
    }

    lines.push('# HELP relay_uptime_seconds Service uptime');
    lines.push('# TYPE relay_uptime_seconds gauge');
    lines.push(`relay_uptime_seconds ${process.uptime()}`);

    lines.push('# HELP relay_credits_saved_by_cache_total Total credits saved by cache hits');
    lines.push('# TYPE relay_credits_saved_by_cache_total counter');
    lines.push(`relay_credits_saved_by_cache_total ${this.creditsSavedByCache}`);

    lines.push('# HELP relay_credits_saved_by_dedup_total Total credits saved by deduplication');
    lines.push('# TYPE relay_credits_saved_by_dedup_total counter');
    lines.push(`relay_credits_saved_by_dedup_total ${this.creditsSavedByDedup}`);

    lines.push('# HELP relay_credits_consumed_by_model_total Total credits consumed per model');
    lines.push('# TYPE relay_credits_consumed_by_model_total counter');
    for (const [model, credits] of Object.entries(this.creditsConsumedByModel)) {
      lines.push(`relay_credits_consumed_by_model_total{model="${model}"} ${credits}`);
    }

    return lines.join('\n') + '\n';
  }

  private cleanup(): void {
    const cutoff = Date.now() - RETENTION_PERIOD_MS;
    const before = this.requests.length;
    this.requests = this.requests.filter((r) => r.timestamp > cutoff);
    if (before !== this.requests.length) {
      this.logger.debug({ removed: before - this.requests.length }, 'Cleaned up old metrics records');
    }
  }
}
