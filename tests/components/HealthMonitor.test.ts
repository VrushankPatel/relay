import { describe, it, expect, beforeEach } from 'vitest';
import { HealthMonitor } from '../../src/components/HealthMonitor.js';
import type { CacheStatistics } from '../../src/types/cache.js';
import type { PoolStatistics } from '../../src/types/health.js';
import type { MetricsSummary } from '../../src/types/metrics.js';
import type { Configuration } from '../../src/types/config.js';

describe('HealthMonitor', () => {
  let monitor: HealthMonitor;

  const sampleConfig: Configuration = {
    server: { port: 8080, host: '0.0.0.0', maxConcurrentRequests: 100, requestTimeoutMs: 5000 },
    cache: { ttlHours: 24, maxEntries: 10000, compressionEnabled: true },
    tokens: { budgetPerUserPerDay: undefined, warningThresholdPercent: 90 },
    similarity: { enabled: true, threshold: 85, maxSearchEntries: 100 },
    security: { encryptCache: true },
    logging: { level: 'INFO', prettyPrint: true },
  };

  const sampleCacheStats: CacheStatistics = {
    size: 100,
    maxSize: 10000,
    hitRate: 75,
    averageEntrySize: 1024,
    compressionRatio: 0.5,
  };

  const samplePoolStats: PoolStatistics = {
    totalConnections: 20,
    activeConnections: 5,
    queuedRequests: 0,
    averageLatency: 150,
  };

  const sampleMetrics: MetricsSummary = {
    totalRequests: 1000,
    cacheHitRate: 75,
    averageLatency: 150,
    tokensConsumed: 50000,
    tokensSaved: 150000,
    savingsPercentage: 75,
    requestsPerSecond: 10,
  };

  beforeEach(() => {
    monitor = new HealthMonitor();
  });

  describe('checkHealth', () => {
    it('should return healthy when no components registered', async () => {
      const health = await monitor.checkHealth();
      expect(health.healthy).toBe(true);
      expect(health.components.size).toBe(0);
    });

    it('should return healthy when all components are healthy', async () => {
      monitor.registerComponent('CacheManager', async () => true);
      monitor.registerComponent('Forwarder', async () => true);
      const health = await monitor.checkHealth();
      expect(health.healthy).toBe(true);
    });

    it('should return degraded when a component fails check', async () => {
      monitor.registerComponent('CacheManager', async () => true);
      monitor.registerComponent('Broken', async () => false);
      const health = await monitor.checkHealth();
      expect(health.healthy).toBe(false);
    });

    it('should return failed when a component throws', async () => {
      monitor.registerComponent('CacheManager', async () => true);
      monitor.registerComponent('Crashy', async () => { throw new Error('down'); });
      const health = await monitor.checkHealth();
      expect(health.healthy).toBe(false);
      const crashy = health.components.get('Crashy');
      expect(crashy?.status).toBe('failed');
      expect(crashy?.lastError).toBe('down');
    });

    it('should update component status on repeated checks', async () => {
      let healthy = true;
      monitor.registerComponent('Toggle', async () => healthy);
      let health = await monitor.checkHealth();
      expect(health.healthy).toBe(true);

      healthy = false;
      health = await monitor.checkHealth();
      expect(health.healthy).toBe(false);
      expect(health.components.get('Toggle')?.status).toBe('degraded');
    });
  });

  describe('getUptime', () => {
    it('should return a positive number', () => {
      const uptime = monitor.getUptime();
      expect(uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getDiagnostics', () => {
    it('should include version and uptime', () => {
      const diag = monitor.getDiagnostics(sampleConfig, sampleCacheStats, samplePoolStats, sampleMetrics);
      expect(diag.version).toBe('2.2.0');
      expect(diag.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should include configuration, cache stats, pool stats, and metrics', () => {
      const diag = monitor.getDiagnostics(sampleConfig, sampleCacheStats, samplePoolStats, sampleMetrics);
      expect(diag.configuration.server.port).toBe(8080);
      expect(diag.cacheStats.size).toBe(100);
      expect(diag.poolStats.activeConnections).toBe(5);
      expect(diag.metrics.totalRequests).toBe(1000);
    });
  });

  describe('registerComponent', () => {
    it('should add component with healthy initial status', async () => {
      monitor.registerComponent('NewComp', async () => true);
      const health = await monitor.checkHealth();
      expect(health.components.has('NewComp')).toBe(true);
      expect(health.components.get('NewComp')?.status).toBe('healthy');
    });
  });
});
