import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as pino from 'pino';
import {
  initializeLogger,
  getLogger,
  createChildLogger,
  createRequestLogger,
  generateRequestId,
  logError,
  sanitize,
  setLogLevel,
  startRequestTracking,
  completeRequestTracking,
  LogLevel,
} from '../../src/utils/logger';

// Mock pino
vi.mock('pino', () => {
  const mockLogger = {
    level: 'info',
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };

  const pinoMock = vi.fn(() => mockLogger);
  (pinoMock as any).stdTimeFunctions = {
    isoTime: () => new Date().toISOString(),
  };
  (pinoMock as any).destination = vi.fn(() => ({}));

  return {
    default: pinoMock,
    ...pinoMock,
  };
});

describe('Logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Logger Initialization', () => {
    it('should initialize logger with default config', () => {
      initializeLogger();
      const logger = getLogger();
      expect(logger).toBeDefined();
    });

    it('should initialize logger with custom config', () => {
      initializeLogger({ level: 'debug', name: 'test-service' });
      const logger = getLogger();
      expect(logger).toBeDefined();
    });

    it('should auto-initialize if getLogger called before initializeLogger', () => {
      const logger = getLogger();
      expect(logger).toBeDefined();
    });

    it('should respect LOG_LEVEL environment variable', () => {
      process.env.LOG_LEVEL = 'debug';
      initializeLogger();
      const logger = getLogger();
      expect(logger).toBeDefined();
      delete process.env.LOG_LEVEL;
    });
  });

  describe('Child Loggers', () => {
    it('should create child logger with component name', () => {
      const logger = getLogger();
      const mockChild = { info: vi.fn(), error: vi.fn() };
      (logger.child as any).mockReturnValue(mockChild);

      const childLogger = createChildLogger('CacheManager');
      expect(logger.child).toHaveBeenCalledWith({ component: 'CacheManager' });
      expect(childLogger).toBe(mockChild);
    });

    it('should create child logger with component and context', () => {
      const logger = getLogger();
      const mockChild = { info: vi.fn(), error: vi.fn() };
      (logger.child as any).mockReturnValue(mockChild);

      const context = { userId: 'user123', operation: 'lookup' };
      const childLogger = createChildLogger('CacheManager', context);
      
      expect(logger.child).toHaveBeenCalledWith({
        component: 'CacheManager',
        userId: 'user123',
        operation: 'lookup',
      });
      expect(childLogger).toBe(mockChild);
    });

    it('should sanitize sensitive data in child logger context', () => {
      const logger = getLogger();
      const mockChild = { info: vi.fn(), error: vi.fn() };
      (logger.child as any).mockReturnValue(mockChild);

      const context = {
        userId: 'user123',
        apiKey: 'secret-key-123',
        token: 'bearer-token-456',
      };
      
      createChildLogger('AuthManager', context);
      
      const callArgs = (logger.child as any).mock.calls[0][0];
      expect(callArgs.apiKey).toBe('[REDACTED]');
      expect(callArgs.token).toBe('[REDACTED]');
      expect(callArgs.userId).toBe('user123');
    });
  });

  describe('Request Loggers', () => {
    it('should generate unique request IDs', () => {
      const id1 = generateRequestId();
      const id2 = generateRequestId();
      
      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('should create request logger with generated request ID', () => {
      const logger = getLogger();
      const mockChild = { info: vi.fn(), error: vi.fn() };
      (logger.child as any).mockReturnValue(mockChild);

      const requestLogger = createRequestLogger();
      
      const callArgs = (logger.child as any).mock.calls[0][0];
      expect(callArgs.requestId).toBeDefined();
      expect(callArgs.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(requestLogger).toBe(mockChild);
    });

    it('should create request logger with provided request ID', () => {
      const logger = getLogger();
      const mockChild = { info: vi.fn(), error: vi.fn() };
      (logger.child as any).mockReturnValue(mockChild);

      const requestId = 'custom-request-id';
      const requestLogger = createRequestLogger(requestId);
      
      const callArgs = (logger.child as any).mock.calls[0][0];
      expect(callArgs.requestId).toBe(requestId);
      expect(requestLogger).toBe(mockChild);
    });

    it('should create request logger with context', () => {
      const logger = getLogger();
      const mockChild = { info: vi.fn(), error: vi.fn() };
      (logger.child as any).mockReturnValue(mockChild);

      const context = { method: 'POST', path: '/v1/completions' };
      const requestLogger = createRequestLogger('req-123', context);
      
      const callArgs = (logger.child as any).mock.calls[0][0];
      expect(callArgs.requestId).toBe('req-123');
      expect(callArgs.method).toBe('POST');
      expect(callArgs.path).toBe('/v1/completions');
    });
  });

  describe('Error Logging', () => {
    it('should log error with structured format', () => {
      const logger = getLogger();
      const error = new Error('Test error');
      error.name = 'TestError';

      logError(logger, error);

      expect(logger.error).toHaveBeenCalled();
      const callArgs = (logger.error as any).mock.calls[0];
      expect(callArgs[0]).toMatchObject({
        errorType: 'TestError',
        message: 'Test error',
      });
      expect(callArgs[0].timestamp).toBeDefined();
      expect(callArgs[0].stack).toBeDefined();
      expect(callArgs[1]).toBe('Error occurred');
    });

    it('should log error with additional context', () => {
      const logger = getLogger();
      const error = new Error('Test error');
      const context = { requestId: 'req-123', operation: 'cache-lookup' };

      logError(logger, error, context);

      const callArgs = (logger.error as any).mock.calls[0];
      expect(callArgs[0]).toMatchObject({
        errorType: 'Error',
        message: 'Test error',
        requestId: 'req-123',
        operation: 'cache-lookup',
      });
    });

    it('should sanitize sensitive data in error context', () => {
      const logger = getLogger();
      const error = new Error('Auth failed');
      const context = {
        requestId: 'req-123',
        apiKey: 'secret-123',
        token: 'bearer-456',
      };

      logError(logger, error, context);

      const callArgs = (logger.error as any).mock.calls[0];
      expect(callArgs[0].apiKey).toBe('[REDACTED]');
      expect(callArgs[0].token).toBe('[REDACTED]');
      expect(callArgs[0].requestId).toBe('req-123');
    });
  });

  describe('Data Sanitization', () => {
    it('should redact API keys', () => {
      const data = {
        apiKey: 'secret-key-123',
        api_key: 'another-secret',
        userId: 'user123',
      };

      const sanitized = sanitize(data);

      expect(sanitized.apiKey).toBe('[REDACTED]');
      expect(sanitized.api_key).toBe('[REDACTED]');
      expect(sanitized.userId).toBe('user123');
    });

    it('should redact authentication tokens', () => {
      const data = {
        token: 'bearer-token-123',
        authToken: 'auth-secret',
        copilotToken: 'copilot-secret',
        userId: 'user123',
      };

      const sanitized = sanitize(data);

      expect(sanitized.token).toBe('[REDACTED]');
      expect(sanitized.authToken).toBe('[REDACTED]');
      expect(sanitized.copilotToken).toBe('[REDACTED]');
      expect(sanitized.userId).toBe('user123');
    });

    it('should redact authorization headers', () => {
      const data = {
        headers: {
          authorization: 'Bearer secret-token',
          'content-type': 'application/json',
        },
      };

      const sanitized = sanitize(data);

      expect(sanitized.headers.authorization).toBe('[REDACTED]');
      expect(sanitized.headers['content-type']).toBe('application/json');
    });

    it('should redact passwords and secrets', () => {
      const data = {
        password: 'my-password',
        secret: 'my-secret',
        username: 'john',
      };

      const sanitized = sanitize(data);

      expect(sanitized.password).toBe('[REDACTED]');
      expect(sanitized.secret).toBe('[REDACTED]');
      expect(sanitized.username).toBe('john');
    });

    it('should handle nested objects', () => {
      const data = {
        user: {
          id: 'user123',
          apiKey: 'secret-key',
          settings: {
            token: 'nested-token',
            theme: 'dark',
          },
        },
      };

      const sanitized = sanitize(data);

      expect(sanitized.user.id).toBe('user123');
      expect(sanitized.user.apiKey).toBe('[REDACTED]');
      expect(sanitized.user.settings.token).toBe('[REDACTED]');
      expect(sanitized.user.settings.theme).toBe('dark');
    });

    it('should handle arrays', () => {
      const data = {
        users: [
          { id: 'user1', apiKey: 'secret1' },
          { id: 'user2', token: 'secret2' },
        ],
      };

      const sanitized = sanitize(data);

      expect(sanitized.users[0].id).toBe('user1');
      expect(sanitized.users[0].apiKey).toBe('[REDACTED]');
      expect(sanitized.users[1].id).toBe('user2');
      expect(sanitized.users[1].token).toBe('[REDACTED]');
    });

    it('should handle null and undefined values', () => {
      const data = {
        value1: null,
        value2: undefined,
        value3: 'test',
      };

      const sanitized = sanitize(data);

      expect(sanitized.value1).toBeNull();
      expect(sanitized.value2).toBeUndefined();
      expect(sanitized.value3).toBe('test');
    });

    it('should handle primitive values', () => {
      expect(sanitize('string')).toBe('string');
      expect(sanitize(123)).toBe(123);
      expect(sanitize(true)).toBe(true);
      expect(sanitize(null)).toBeNull();
      expect(sanitize(undefined)).toBeUndefined();
    });
  });

  describe('Log Level Management', () => {
    it('should set log level dynamically', () => {
      const logger = getLogger();
      
      setLogLevel('debug');
      expect(logger.level).toBe('debug');
      expect(logger.info).toHaveBeenCalledWith({ level: 'debug' }, 'Log level changed');
    });

    it('should support all log levels', () => {
      const logger = getLogger();
      
      const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
      
      levels.forEach(level => {
        setLogLevel(level);
        expect(logger.level).toBe(level);
      });
    });
  });

  describe('Request Lifecycle Tracking', () => {
    it('should start request tracking with generated request ID', () => {
      const logger = getLogger();
      const mockChild = { info: vi.fn() };
      (logger.child as any).mockReturnValue(mockChild);

      const ctx = startRequestTracking();

      expect(ctx.requestId).toBeDefined();
      expect(ctx.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(ctx.logger).toBe(mockChild);
      expect(ctx.startTime).toBeDefined();
      expect(mockChild.info).toHaveBeenCalledWith({}, 'Request started');
    });

    it('should start request tracking with context', () => {
      const logger = getLogger();
      const mockChild = { info: vi.fn() };
      (logger.child as any).mockReturnValue(mockChild);

      const context = { method: 'POST', path: '/v1/completions' };
      const ctx = startRequestTracking(context);

      expect(mockChild.info).toHaveBeenCalledWith(context, 'Request started');
    });

    it('should complete request tracking with status', () => {
      const logger = getLogger();
      const mockChild = { info: vi.fn() };
      (logger.child as any).mockReturnValue(mockChild);

      const ctx = startRequestTracking();
      const startTime = ctx.startTime;

      // Simulate some processing time
      vi.advanceTimersByTime(100);

      completeRequestTracking(ctx, 'success');

      const callArgs = (mockChild.info as any).mock.calls[1]; // Second call (first is "started")
      expect(callArgs[0]).toMatchObject({
        status: 'success',
      });
      expect(callArgs[0].duration).toBeGreaterThanOrEqual(0);
      expect(callArgs[1]).toBe('Request completed');
    });

    it('should complete request tracking with additional context', () => {
      const logger = getLogger();
      const mockChild = { info: vi.fn() };
      (logger.child as any).mockReturnValue(mockChild);

      const ctx = startRequestTracking();
      const additionalContext = {
        cached: true,
        tokensSaved: 150,
      };

      completeRequestTracking(ctx, 'success', additionalContext);

      const callArgs = (mockChild.info as any).mock.calls[1];
      expect(callArgs[0]).toMatchObject({
        status: 'success',
        cached: true,
        tokensSaved: 150,
      });
    });

    it('should sanitize sensitive data in request lifecycle', () => {
      const logger = getLogger();
      const mockChild = { info: vi.fn() };
      (logger.child as any).mockReturnValue(mockChild);

      const context = {
        method: 'POST',
        apiKey: 'secret-key',
      };

      const ctx = startRequestTracking(context);

      const startCallArgs = (mockChild.info as any).mock.calls[0];
      expect(startCallArgs[0].apiKey).toBe('[REDACTED]');
      expect(startCallArgs[0].method).toBe('POST');

      const additionalContext = {
        token: 'bearer-token',
        statusCode: 200,
      };

      completeRequestTracking(ctx, 'success', additionalContext);

      const completeCallArgs = (mockChild.info as any).mock.calls[1];
      expect(completeCallArgs[0].token).toBe('[REDACTED]');
      expect(completeCallArgs[0].statusCode).toBe(200);
    });
  });

  describe('Pino Serializers', () => {
    it('should have custom serializers configured', () => {
      initializeLogger();
      
      // The pino mock should be called with config including serializers
      expect(pino.default).toHaveBeenCalled();
      const config = (pino.default as any).mock.calls[0][0];
      
      expect(config.serializers).toBeDefined();
      expect(config.serializers.req).toBeDefined();
      expect(config.serializers.res).toBeDefined();
      expect(config.serializers.err).toBeDefined();
    });
  });

  describe('Logger Configuration', () => {
    it('should configure timestamp format', () => {
      initializeLogger();
      
      const config = (pino.default as any).mock.calls[0][0];
      expect(config.timestamp).toBeDefined();
    });

    it('should configure base fields', () => {
      initializeLogger({ name: 'test-service' });
      
      const config = (pino.default as any).mock.calls[0][0];
      expect(config.base).toBeDefined();
      expect(config.base.service).toBeDefined();
      expect(config.base.pid).toBe(process.pid);
    });

    it('should format log level as uppercase', () => {
      initializeLogger();
      
      const config = (pino.default as any).mock.calls[0][0];
      expect(config.formatters).toBeDefined();
      expect(config.formatters.level).toBeDefined();
      
      const formatted = config.formatters.level('info');
      expect(formatted).toEqual({ level: 'INFO' });
    });
  });
});
