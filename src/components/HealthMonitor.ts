import type { HealthStatus, ComponentHealth, DiagnosticInfo, PoolStatistics } from '../types/health.js';
import type { Configuration } from '../types/config.js';
import type { CacheStatistics } from '../types/cache.js';
import type { MetricsSummary } from '../types/metrics.js';

export const SERVICE_VERSION = '1.0.0';

export interface ComponentCheck {
  name: string;
  check: () => Promise<boolean>;
}

export class HealthMonitor {
  private startTime: number;
  private components: Map<string, ComponentHealth> = new Map();
  private checks: ComponentCheck[] = [];

  constructor() {
    this.startTime = Date.now();
  }

  registerComponent(name: string, check: () => Promise<boolean>): void {
    this.checks.push({ name, check });
    this.components.set(name, {
      name,
      status: 'healthy',
      lastCheck: new Date(),
    });
  }

  async checkHealth(): Promise<HealthStatus> {
    let allHealthy = true;

    for (const { name, check } of this.checks) {
      try {
        const healthy = await check();
        const status = healthy ? 'healthy' : 'degraded';
        this.components.set(name, {
          name,
          status,
          lastCheck: new Date(),
        });
        if (!healthy) allHealthy = false;
      } catch (error) {
        this.components.set(name, {
          name,
          status: 'failed',
          lastError: error instanceof Error ? error.message : String(error),
          lastCheck: new Date(),
        });
        allHealthy = false;
      }
    }

    return {
      healthy: allHealthy,
      components: new Map(this.components),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  getDiagnostics(
    configuration: Configuration,
    cacheStats: CacheStatistics,
    poolStats: PoolStatistics,
    metrics: MetricsSummary,
  ): DiagnosticInfo {
    return {
      version: SERVICE_VERSION,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      configuration,
      cacheStats,
      poolStats,
      metrics,
    };
  }

  getUptime(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }
}
