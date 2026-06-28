import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigurationManager } from '../../src/components/ConfigurationManager.js';
import type { Configuration } from '../../src/types/config.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

function writeTempYaml(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function removeFile(file: string): void {
  try {
    fs.unlinkSync(file);
    fs.rmdirSync(path.dirname(file));
  } catch {
    // ignore
  }
}

describe('ConfigurationManager', () => {
  let configManager: ConfigurationManager;

  beforeEach(() => {
    configManager = new ConfigurationManager();
    // Clean up relevant env vars
    delete process.env.RELAY_PROVIDER;
    delete process.env.RELAY_PORT;
    delete process.env.RELAY_HOST;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GENERIC_API_KEY;
    delete process.env.GENERIC_BASE_URL;
    delete process.env.COPILOT_REQUIRE_CONSENT;
  });

  afterEach(() => {
    delete process.env.RELAY_PROVIDER;
    delete process.env.RELAY_PORT;
    delete process.env.RELAY_HOST;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GENERIC_API_KEY;
    delete process.env.GENERIC_BASE_URL;
    delete process.env.COPILOT_REQUIRE_CONSENT;
  });

  describe('loadConfig', () => {
    it('should load valid YAML config', async () => {
      const yaml = `
server:
  port: 9090
  host: 127.0.0.1
  maxConcurrentRequests: 50
  requestTimeoutMs: 10000
cache:
  ttlHours: 12
  maxEntries: 5000
  compressionEnabled: false
tokens:
  budgetPerUserPerDay: 100000
  warningThresholdPercent: 80
similarity:
  enabled: false
  threshold: 90
  maxSearchEntries: 50
security:
  encryptCache: false
logging:
  level: DEBUG
  prettyPrint: false
`;
      const file = writeTempYaml(yaml);
      const config = await configManager.loadConfig(file);
      expect(config.server.port).toBe(9090);
      expect(config.server.host).toBe('127.0.0.1');
      expect(config.server.maxConcurrentRequests).toBe(50);
      expect(config.cache.ttlHours).toBe(12);
      expect(config.cache.maxEntries).toBe(5000);
      expect(config.cache.compressionEnabled).toBe(false);
      expect(config.tokens.budgetPerUserPerDay).toBe(100000);
      expect(config.tokens.warningThresholdPercent).toBe(80);
      expect(config.similarity.enabled).toBe(false);
      expect(config.security.encryptCache).toBe(false);
      expect(config.logging.level).toBe('DEBUG');
      expect(config.logging.prettyPrint).toBe(false);
      removeFile(file);
    });

    it('should use defaults when config file is missing', async () => {
      const config = await configManager.loadConfig('/nonexistent/path/config.yaml');
      expect(config.server.port).toBe(8080);
      expect(config.cache.ttlHours).toBe(24);
    });

    it('should use defaults when config file is empty', async () => {
      const file = writeTempYaml('');
      const config = await configManager.loadConfig(file);
      expect(config.server.port).toBe(8080);
      removeFile(file);
    });

    it('should merge partial config with defaults', async () => {
      const yaml = `
server:
  port: 3000
`;
      const file = writeTempYaml(yaml);
      const config = await configManager.loadConfig(file);
      expect(config.server.port).toBe(3000);
      expect(config.server.host).toBe('0.0.0.0');
      expect(config.cache.ttlHours).toBe(24);
      removeFile(file);
    });

    it('should initialize strictly from environment variables', async () => {
      process.env.RELAY_PROVIDER = 'anthropic';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      process.env.RELAY_PORT = '4000';
      process.env.RELAY_HOST = '1.1.1.1';

      const config = await configManager.loadConfig('/nonexistent/path/config.yaml');
      expect(config.server.port).toBe(4000);
      expect(config.server.host).toBe('1.1.1.1');
      expect(config.provider?.type).toBe('anthropic');
      expect(config.provider?.apiKey).toBe('sk-ant-test');
    });

    it('should initialize strictly from environment variables for generic', async () => {
      process.env.RELAY_PROVIDER = 'generic';
      process.env.GENERIC_API_KEY = 'sk-gen-test';
      process.env.GENERIC_BASE_URL = 'http://localhost:11434';

      const config = await configManager.loadConfig('/nonexistent/path/config.yaml');
      expect(config.provider?.type).toBe('generic');
      expect(config.provider?.apiKey).toBe('sk-gen-test');
      expect(config.provider?.baseUrl).toBe('http://localhost:11434');
    });
  });

  describe('validateConfig', () => {
    it('should return no errors for valid config', () => {
      const cm = new ConfigurationManager();
      const errors = cm.validateConfig({
        server: { port: 8080, host: '0.0.0.0', maxConcurrentRequests: 100, requestTimeoutMs: 5000 },
        cache: { ttlHours: 24, maxEntries: 10000, compressionEnabled: true },
        tokens: { budgetPerUserPerDay: undefined, warningThresholdPercent: 90 },
        similarity: { enabled: true, threshold: 85, maxSearchEntries: 100 },
        security: { encryptCache: true },
        logging: { level: 'INFO', prettyPrint: true },
      });
      expect(errors).toHaveLength(0);
    });

    it('should reject port out of range', () => {
      const cm = new ConfigurationManager();
      const errors = cm.validateConfig({
        server: { port: 0, host: '0.0.0.0', maxConcurrentRequests: 100, requestTimeoutMs: 5000 },
        cache: { ttlHours: 24, maxEntries: 10000, compressionEnabled: true },
        tokens: { budgetPerUserPerDay: undefined, warningThresholdPercent: 90 },
        similarity: { enabled: true, threshold: 85, maxSearchEntries: 100 },
        security: { encryptCache: true },
        logging: { level: 'INFO', prettyPrint: true },
      });
      expect(errors).toContain('server.port must be between 1 and 65535');
    });

    it('should reject maxConcurrentRequests < 1', () => {
      const cm = new ConfigurationManager();
      const errors = cm.validateConfig({
        server: { port: 8080, host: '0.0.0.0', maxConcurrentRequests: 0, requestTimeoutMs: 5000 },
        cache: { ttlHours: 24, maxEntries: 10000, compressionEnabled: true },
        tokens: { budgetPerUserPerDay: undefined, warningThresholdPercent: 90 },
        similarity: { enabled: true, threshold: 85, maxSearchEntries: 100 },
        security: { encryptCache: true },
        logging: { level: 'INFO', prettyPrint: true },
      });
      expect(errors).toContain('server.maxConcurrentRequests must be >= 1');
    });

    it('should reject requestTimeoutMs < 100', () => {
      const cm = new ConfigurationManager();
      const errors = cm.validateConfig({
        server: { port: 8080, host: '0.0.0.0', maxConcurrentRequests: 100, requestTimeoutMs: 50 },
        cache: { ttlHours: 24, maxEntries: 10000, compressionEnabled: true },
        tokens: { budgetPerUserPerDay: undefined, warningThresholdPercent: 90 },
        similarity: { enabled: true, threshold: 85, maxSearchEntries: 100 },
        security: { encryptCache: true },
        logging: { level: 'INFO', prettyPrint: true },
      });
      expect(errors).toContain('server.requestTimeoutMs must be >= 100');
    });

    it('should reject ttlHours < 1', () => {
      const cm = new ConfigurationManager();
      const errors = cm.validateConfig({
        server: { port: 8080, host: '0.0.0.0', maxConcurrentRequests: 100, requestTimeoutMs: 5000 },
        cache: { ttlHours: 0, maxEntries: 10000, compressionEnabled: true },
        tokens: { budgetPerUserPerDay: undefined, warningThresholdPercent: 90 },
        similarity: { enabled: true, threshold: 85, maxSearchEntries: 100 },
        security: { encryptCache: true },
        logging: { level: 'INFO', prettyPrint: true },
      });
      expect(errors).toContain('cache.ttlHours must be >= 1');
    });

    it('should reject maxEntries < 1', () => {
      const cm = new ConfigurationManager();
      const errors = cm.validateConfig({
        server: { port: 8080, host: '0.0.0.0', maxConcurrentRequests: 100, requestTimeoutMs: 5000 },
        cache: { ttlHours: 24, maxEntries: 0, compressionEnabled: true },
        tokens: { budgetPerUserPerDay: undefined, warningThresholdPercent: 90 },
        similarity: { enabled: true, threshold: 85, maxSearchEntries: 100 },
        security: { encryptCache: true },
        logging: { level: 'INFO', prettyPrint: true },
      });
      expect(errors).toContain('cache.maxEntries must be >= 1');
    });

    it('should reject warningThresholdPercent out of range', () => {
      const cm = new ConfigurationManager();
      const errors = cm.validateConfig({
        server: { port: 8080, host: '0.0.0.0', maxConcurrentRequests: 100, requestTimeoutMs: 5000 },
        cache: { ttlHours: 24, maxEntries: 10000, compressionEnabled: true },
        tokens: { budgetPerUserPerDay: undefined, warningThresholdPercent: 150 },
        similarity: { enabled: true, threshold: 85, maxSearchEntries: 100 },
        security: { encryptCache: true },
        logging: { level: 'INFO', prettyPrint: true },
      });
      expect(errors).toContain('tokens.warningThresholdPercent must be between 0 and 100');
    });

    it('should reject threshold out of range', () => {
      const cm = new ConfigurationManager();
      const errors = cm.validateConfig({
        server: { port: 8080, host: '0.0.0.0', maxConcurrentRequests: 100, requestTimeoutMs: 5000 },
        cache: { ttlHours: 24, maxEntries: 10000, compressionEnabled: true },
        tokens: { budgetPerUserPerDay: undefined, warningThresholdPercent: 90 },
        similarity: { enabled: true, threshold: -1, maxSearchEntries: 100 },
        security: { encryptCache: true },
        logging: { level: 'INFO', prettyPrint: true },
      });
      expect(errors).toContain('similarity.threshold must be between 0 and 100');
    });

    it('should reject maxSearchEntries < 1', () => {
      const cm = new ConfigurationManager();
      const errors = cm.validateConfig({
        server: { port: 8080, host: '0.0.0.0', maxConcurrentRequests: 100, requestTimeoutMs: 5000 },
        cache: { ttlHours: 24, maxEntries: 10000, compressionEnabled: true },
        tokens: { budgetPerUserPerDay: undefined, warningThresholdPercent: 90 },
        similarity: { enabled: true, threshold: 85, maxSearchEntries: 0 },
        security: { encryptCache: true },
        logging: { level: 'INFO', prettyPrint: true },
      });
      expect(errors).toContain('similarity.maxSearchEntries must be >= 1');
    });
  });

  describe('getCurrentConfig', () => {
    it('should return the current config', () => {
      const config = configManager.getCurrentConfig();
      expect(config.server.port).toBe(8080);
    });
  });
});
