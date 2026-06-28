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
  },
  tokens: {
    budgetPerUserPerDay: undefined,
    warningThresholdPercent: 90,
  },
  similarity: {
    enabled: true,
    threshold: 85,
    maxSearchEntries: 100,
  },
  security: {
    encryptCache: true,
  },
  logging: {
    level: 'INFO',
    prettyPrint: true,
  },
  auth: {
    tokenStoragePath: '~/.relay/tokens.json',
    deviceFlowPollInterval: 5,
    refreshMargin: 60,
  },
  models: {
    creditMultipliers: {
      'gpt-4o': { input: 1.5, output: 5 },
      'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
      'claude-3-5-sonnet': { input: 3, output: 15 },
    },
  },
  deduplication: {
    windowMs: 1000,
    maxStreamBufferBytes: 1024 * 1024,
  },
  prefixCache: {
    maxEntries: 5000,
  },
  cacheBypass: {
    bypassOnNonZeroTemperature: true,
    bypassOnToolsWithSideEffects: true,
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
  private watching = false;

  constructor(config?: Partial<Configuration>) {
    this.logger = createChildLogger('ConfigurationManager');
    this.currentConfig = { ...DEFAULT_CONFIG, ...config };
  }

  async loadConfig(filePath?: string): Promise<Configuration> {
    const path = filePath || process.env.CONFIG_PATH || 'config.yaml';
    this.configPath = path;

    try {
      let parsed: Record<string, any> = {};
      if (fs.existsSync(path)) {
        const yamlContent = fs.readFileSync(path, 'utf8');
        const jsYaml = await import('js-yaml');
        parsed = jsYaml.load(yamlContent) as Record<string, any> || {};
      } else {
        if (!process.env.RELAY_PROVIDER) {
          this.logger.warn({ path }, 'Config file not found and RELAY_PROVIDER not set, using defaults');
        } else {
          this.logger.info('Config file not found, initializing from environment variables');
        }
      }

      let config = this.mergeConfig(parsed);
      config = this.applyEnvironmentOverrides(config);
      
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

    this.watching = true;

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
      let config = this.mergeConfig(parsed);
      config = this.applyEnvironmentOverrides(config);
      return config;
    } catch (error) {
      this.logger.error({ error }, 'Error reloading config');
      return this.currentConfig;
    }
  }

  unwatchConfig(): void {
    if (this.watching && fs.existsSync(this.configPath)) {
      fs.unwatchFile(this.configPath);
      this.watching = false;
      this.logger.info({ path: this.configPath }, 'Stopped watching config file');
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
    if (config.logging.level && !['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(config.logging.level.toUpperCase())) {
      errors.push('logging.level must be one of: DEBUG, INFO, WARN, ERROR');
    }

    return errors;
  }

  private mergeConfig(parsed: Record<string, any>): Configuration {
    const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Configuration;

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
    if (parsed.auth) {
      config.auth = { ...config.auth, ...parsed.auth };
    }
    if (parsed.models) {
      config.models = { ...config.models, ...parsed.models };
    }
    if (parsed.deduplication) {
      config.deduplication = { ...config.deduplication, ...parsed.deduplication };
    }
    if (parsed.prefixCache) {
      config.prefixCache = { ...config.prefixCache, ...parsed.prefixCache };
    }
    if (parsed.cacheBypass) {
      config.cacheBypass = { ...config.cacheBypass, ...parsed.cacheBypass };
    }
    if (parsed.provider) {
      config.provider = parsed.provider;
    }

    return config;
  }

  private applyEnvironmentOverrides(config: Configuration): Configuration {
    if (process.env.RELAY_PORT) {
      config.server.port = parseInt(process.env.RELAY_PORT, 10);
    }
    if (process.env.RELAY_HOST) {
      config.server.host = process.env.RELAY_HOST;
    }
    
    if (process.env.RELAY_PROVIDER) {
      const pType = process.env.RELAY_PROVIDER.toLowerCase();
      config.provider = { type: pType };
      
      if (pType === 'openai') {
        if (process.env.OPENAI_API_KEY) config.provider.apiKey = process.env.OPENAI_API_KEY;
      } else if (pType === 'anthropic') {
        if (process.env.ANTHROPIC_API_KEY) config.provider.apiKey = process.env.ANTHROPIC_API_KEY;
      } else if (pType === 'generic') {
        if (process.env.GENERIC_API_KEY) config.provider.apiKey = process.env.GENERIC_API_KEY;
        if (process.env.GENERIC_BASE_URL) config.provider.baseUrl = process.env.GENERIC_BASE_URL;
      } else if (pType === 'copilot') {
        config.provider.requireConsent = process.env.COPILOT_REQUIRE_CONSENT !== 'false';
      }
    }
    
    return config;
  }
}
