import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MetricsCollector } from '../../src/components/MetricsCollector.js';

describe('MetricsCollector', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  afterEach(() => {
    collector.destroy();
  });

  describe('recordRequest', () => {
    it('should increment totalRequests on every call', () => {
      collector.recordRequest(200, true, 50, 'user1');
      collector.recordRequest(200, false, 30, 'user2');
      const metrics = collector.getAggregatedMetrics();
      expect(metrics.totalRequests).toBe(2);
    });

    it('should track cache hits and misses', () => {
      collector.recordRequest(200, true, 10, 'user1');
      collector.recordRequest(200, true, 10, 'user1');
      collector.recordRequest(200, false, 20, 'user1');
      const metrics = collector.getAggregatedMetrics();
      expect(metrics.cacheHitRate).toBeCloseTo(66.67, 0);
    });
  });

  describe('getAggregatedMetrics', () => {
    it('should return zero values when no requests recorded', () => {
      const metrics = collector.getAggregatedMetrics();
      expect(metrics.totalRequests).toBe(0);
      expect(metrics.cacheHitRate).toBe(0);
      expect(metrics.averageLatency).toBe(0);
      expect(metrics.tokensConsumed).toBe(0);
      expect(metrics.tokensSaved).toBe(0);
    });

    it('should calculate average latency correctly', () => {
      collector.recordRequest(200, false, 100, 'user1');
      collector.recordRequest(200, false, 200, 'user1');
      const metrics = collector.getAggregatedMetrics();
      expect(metrics.averageLatency).toBe(150);
    });

    it('should report tokens consumed and saved', () => {
      collector.recordTokens(500, 200);
      const metrics = collector.getAggregatedMetrics();
      expect(metrics.tokensConsumed).toBe(500);
      expect(metrics.tokensSaved).toBe(200);
    });

    it('should calculate savings percentage', () => {
      collector.recordTokens(300, 100);
      const metrics = collector.getAggregatedMetrics();
      expect(metrics.savingsPercentage).toBeCloseTo(25, 0);
    });

    it('should return 0 savings percentage when no tokens recorded', () => {
      const metrics = collector.getAggregatedMetrics();
      expect(metrics.savingsPercentage).toBe(0);
    });

    it('should report requestsPerSecond', () => {
      collector.recordRequest(200, true, 10, 'user1');
      const metrics = collector.getAggregatedMetrics();
      expect(metrics.requestsPerSecond).toBeGreaterThan(0);
    });
  });

  describe('recordTokens', () => {
    it('should accumulate consumed and saved tokens', () => {
      collector.recordTokens(100, 50);
      collector.recordTokens(200, 100);
      const metrics = collector.getAggregatedMetrics();
      expect(metrics.tokensConsumed).toBe(300);
      expect(metrics.tokensSaved).toBe(150);
    });
  });

  describe('recordError', () => {
    it('should count errors by type', () => {
      collector.recordError('TIMEOUT');
      collector.recordError('TIMEOUT');
      collector.recordError('RATE_LIMIT');
      const prometheus = collector.exportPrometheus();
      expect(prometheus).toContain('proxy_errors_total{type="TIMEOUT"} 2');
      expect(prometheus).toContain('proxy_errors_total{type="RATE_LIMIT"} 1');
    });
  });

  describe('exportPrometheus', () => {
    it('should start with HELP and TYPE lines', () => {
      const output = collector.exportPrometheus();
      expect(output).toContain('# HELP');
      expect(output).toContain('# TYPE');
    });

    it('should include all required metrics', () => {
      collector.recordRequest(200, true, 10, 'user1');
      collector.recordTokens(100, 50);
      const output = collector.exportPrometheus();
      expect(output).toContain('proxy_requests_total');
      expect(output).toContain('proxy_cache_hits_total');
      expect(output).toContain('proxy_cache_misses_total');
      expect(output).toContain('proxy_cache_hit_rate');
      expect(output).toContain('proxy_latency_milliseconds');
      expect(output).toContain('proxy_tokens_consumed_total');
      expect(output).toContain('proxy_tokens_saved_total');
      expect(output).toContain('proxy_errors_total');
      expect(output).toContain('proxy_uptime_seconds');
    });

    it('should end with newline', () => {
      const output = collector.exportPrometheus();
      expect(output.endsWith('\n')).toBe(true);
    });
  });

  describe('destroy', () => {
    it('should clear the cleanup timer', () => {
      const c = new MetricsCollector();
      expect((c as any).cleanupTimer).toBeDefined();
      c.destroy();
      expect((c as any).cleanupTimer).toBeNull();
    });
  });
});
