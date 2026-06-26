import fs from 'fs';
import { Configuration } from '../types/config.js';
import { createChildLogger } from '../utils/logger.js';

const DEFAULT_CONFIG: Configuration = {
  server: {
    port: 8080,
    host: '0.0.0.0',
    maxConcurrentRequests: 100,
    requestTimeoutMs: 5000,
  },
  cache: {
    ttlHours: 24,
    maxEntries: 10000,
    compressionEnabled: true,
    redisUrl: undefined,
  },
  tokens: {
    budgetPerUserPerDay: undefined,
    trackingEnabled: true,
    warningThresholdPercent: 90,
  },
  similarity: {
    enabled: true,
    threshold: 85,
    maxSearchEntries: 100,
  },
  security: {
    apiKeyRequired: true,
    encryptCache: true,
    httpsOnly: true,
  },
  logging: {
    level: 'INFO',
    prettyPrint: true,
  },
};

export interface IConfigurationManager {
  loadConfig(filePath?: string): Promise<Configuration>;
  getCurrentConfig(): Configuration;
  validateConfig(config: Configuration): string[];
  watchConfig(callback: (config: Configuration) => void): void;
}

export class ConfigurationManager implements IConfigurationManager {
  private currentConfig: Configuration;
  private logger: ReturnType<typeof createChildLogger>;
  private configPath: string = 'config.yaml';
  private watchTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(config?: Partial<Configuration>) {
    this.logger = createChildLogger('ConfigurationManager');
    this.currentConfig = { ...DEFAULT_CONFIG, ...config };
  }

  async loadConfig(filePath?: string): Promise<Configuration> {
    const path = filePath || process.env.CONFIG_PATH || 'config.yaml';
    this.configPath = path;

    try {
      let yamlContent: string;
      if (fs.existsSync(path)) {
        yamlContent = fs.readFileSync(path, 'utf8');
      } else {
        this.logger.warn({ path }, 'Config file not found, using defaults');
        return this.currentConfig;
      }

      const jsYaml = await import('js-yaml');
      const parsed = jsYaml.load(yamlContent) as Record<string, any>;

      if (!parsed || typeof parsed !== 'object') {
        this.logger.warn({ path }, 'Config file is empty or invalid, using defaults');
        return this.currentConfig;
      }

      const config = this.mergeConfig(parsed);
      const errors = this.validateConfig(config);

      if (errors.length > 0) {
        this.logger.warn({ errors }, 'Config validation errors, using partial merge');
      }

      this.currentConfig = config;
      this.logger.info({ path, server: config.server }, 'Configuration loaded');
      return this.currentConfig;
    } catch (error) {
      this.logger.error({ error, path }, 'Failed to load config file, using defaults');
      return this.currentConfig;
    }
  }

  getCurrentConfig(): Configuration {
    return this.currentConfig;
  }

  watchConfig(callback: (config: Configuration) => void): void {
    if (!fs.existsSync(this.configPath)) {
      this.logger.warn({ path: this.configPath }, 'Config file not found, not watching');
      return;
    }

    fs.watchFile(this.configPath, { interval: 1000 }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs) return;

      if (this.watchTimeout) clearTimeout(this.watchTimeout);
      this.watchTimeout = setTimeout(async () => {
        this.logger.info({ path: this.configPath }, 'Config file changed, reloading');
        const newConfig = await this._reloadConfig();
        const errors = this.validateConfig(newConfig);
        if (errors.length > 0) {
          this.logger.error({ errors }, 'Config validation failed, keeping previous config');
          return;
        }
        this.currentConfig = newConfig;
        this.logger.info({ path: this.configPath }, 'Config hot-reload applied');
        callback(this.currentConfig);
      }, 1000);
    });
    this.logger.info({ path: this.configPath }, 'Watching config file for changes');
  }

  private async _reloadConfig(): Promise<Configuration> {
    try {
      const yamlContent = fs.readFileSync(this.configPath, 'utf8');
      const jsYaml = await import('js-yaml');
      const parsed = jsYaml.load(yamlContent) as Record<string, any>;
      if (!parsed || typeof parsed !== 'object') {
        return this.currentConfig;
      }
      return this.mergeConfig(parsed);
    } catch (error) {
      this.logger.error({ error }, 'Error reloading config');
      return this.currentConfig;
    }
  }

  validateConfig(config: Configuration): string[] {
    const errors: string[] = [];

    if (config.server.port < 1 || config.server.port > 65535) {
      errors.push('server.port must be between 1 and 65535');
    }
    if (config.server.maxConcurrentRequests < 1) {
      errors.push('server.maxConcurrentRequests must be >= 1');
    }
    if (config.server.requestTimeoutMs < 100) {
      errors.push('server.requestTimeoutMs must be >= 100');
    }
    if (config.cache.ttlHours < 1) {
      errors.push('cache.ttlHours must be >= 1');
    }
    if (config.cache.maxEntries < 1) {
      errors.push('cache.maxEntries must be >= 1');
    }
    if (config.tokens.warningThresholdPercent < 0 || config.tokens.warningThresholdPercent > 100) {
      errors.push('tokens.warningThresholdPercent must be between 0 and 100');
    }
    if (config.similarity.threshold < 0 || config.similarity.threshold > 100) {
      errors.push('similarity.threshold must be between 0 and 100');
    }
    if (config.similarity.maxSearchEntries < 1) {
      errors.push('similarity.maxSearchEntries must be >= 1');
    }

    return errors;
  }

  private mergeConfig(parsed: Record<string, any>): Configuration {
    const config = { ...DEFAULT_CONFIG };

    if (parsed.server) {
      config.server = { ...config.server, ...parsed.server };
    }
    if (parsed.cache) {
      config.cache = { ...config.cache, ...parsed.cache };
    }
    if (parsed.tokens) {
      config.tokens = { ...config.tokens, ...parsed.tokens };
    }
    if (parsed.similarity) {
      config.similarity = { ...config.similarity, ...parsed.similarity };
    }
    if (parsed.security) {
      config.security = { ...config.security, ...parsed.security };
    }
    if (parsed.logging) {
      config.logging = { ...config.logging, ...parsed.logging };
    }

    return config;
  }
}
