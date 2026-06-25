import pino from 'pino';
import { randomUUID } from 'crypto';

/**
 * Logging infrastructure for the GitHub Copilot Token Optimizer Proxy
 * 
 * Features:
 * - Structured JSON logging using pino
 * - Configurable log levels (DEBUG, INFO, WARN, ERROR)
 * - Child loggers for component-specific context
 * - Log sanitization to prevent logging sensitive data
 * - Request ID generation and tracking
 */

/**
 * Log level type
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Sensitive field patterns to redact from logs
 */
const SENSITIVE_PATTERNS = [
  /api[_-]?key/i,
  /auth[_-]?token/i,
  /bearer/i,
  /password/i,
  /secret/i,
  /token/i,
  /copilot[_-]?token/i,
  /authorization/i,
];

/**
 * Fields that should be redacted from logs
 */
const SENSITIVE_FIELDS = new Set([
  'apiKey',
  'api_key',
  'authToken',
  'auth_token',
  'token',
  'copilotToken',
  'copilot_token',
  'authorization',
  'password',
  'secret',
  'bearer',
]);

/**
 * Sanitize an object to remove sensitive data
 * @param obj Object to sanitize
 * @returns Sanitized copy of the object
 */
function sanitizeObject(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item));
  }

  const sanitized: any = {};
  
  for (const [key, value] of Object.entries(obj)) {
    // Check if the key matches sensitive patterns
    const isSensitive = SENSITIVE_FIELDS.has(key) || 
                       SENSITIVE_PATTERNS.some(pattern => pattern.test(key));
    
    if (isSensitive) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeObject(value);
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

/**
 * Custom pino serializers for sanitization
 */
const serializers = {
  req: (req: any) => {
    if (!req) return req;
    
    return sanitizeObject({
      id: req.id,
      method: req.method,
      url: req.url,
      headers: req.headers,
      remoteAddress: req.remoteAddress,
      remotePort: req.remotePort,
    });
  },
  res: (res: any) => {
    if (!res) return res;
    
    return {
      statusCode: res.statusCode,
      headers: sanitizeObject(res.headers),
    };
  },
  err: (err: any) => {
    if (!err) return err;
    
    return {
      type: err.name || err.constructor?.name || 'Error',
      message: err.message,
      stack: err.stack,
      code: err.code,
      ...sanitizeObject(err),
    };
  },
};

/**
 * Configuration for the logger
 */
export interface LoggerConfig {
  level?: LogLevel;
  prettyPrint?: boolean;
  name?: string;
}

/**
 * Create the base logger instance
 */
function createBaseLogger(config: LoggerConfig = {}): pino.Logger {
  const level = config.level || (process.env.LOG_LEVEL as LogLevel) || 'info';
  const prettyPrint = config.prettyPrint ?? process.env.NODE_ENV !== 'production';

  const pinoConfig: pino.LoggerOptions = {
    level,
    serializers,
    formatters: {
      level: (label) => {
        return { level: label.toUpperCase() };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      pid: process.pid,
      hostname: process.env.HOSTNAME || 'unknown',
      service: config.name || 'copilot-token-optimizer-proxy',
    },
  };

  // Add pretty printing for development
  if (prettyPrint) {
    return pino(pinoConfig, pino.destination({
      sync: false,
    }));
  }

  return pino(pinoConfig);
}

/**
 * Root logger instance
 */
let rootLogger: pino.Logger;

/**
 * Initialize the logging system
 * @param config Logger configuration
 */
export function initializeLogger(config: LoggerConfig = {}): void {
  rootLogger = createBaseLogger(config);
  rootLogger.info({ config }, 'Logger initialized');
}

/**
 * Get the root logger instance
 * @returns Root logger
 */
export function getLogger(): pino.Logger {
  if (!rootLogger) {
    // Auto-initialize with defaults if not explicitly initialized
    initializeLogger();
  }
  return rootLogger;
}

/**
 * Create a child logger with component-specific context
 * @param component Component name
 * @param context Additional context to include
 * @returns Child logger
 */
export function createChildLogger(component: string, context?: Record<string, any>): pino.Logger {
  const logger = getLogger();
  
  const childContext = {
    component,
    ...sanitizeObject(context || {}),
  };
  
  return logger.child(childContext);
}

/**
 * Generate a unique request ID
 * @returns UUID v4 request ID
 */
export function generateRequestId(): string {
  return randomUUID();
}

/**
 * Create a request-scoped logger with request ID
 * @param requestId Request ID (generated if not provided)
 * @param context Additional context
 * @returns Request-scoped logger
 */
export function createRequestLogger(requestId?: string, context?: Record<string, any>): pino.Logger {
  const logger = getLogger();
  const reqId = requestId || generateRequestId();
  
  const requestContext = {
    requestId: reqId,
    ...sanitizeObject(context || {}),
  };
  
  return logger.child(requestContext);
}

/**
 * Log an error with structured format
 * @param logger Logger instance
 * @param error Error object
 * @param context Additional context
 */
export function logError(
  logger: pino.Logger,
  error: Error,
  context?: Record<string, any>
): void {
  const errorInfo = {
    timestamp: new Date().toISOString(),
    errorType: error.name || error.constructor?.name || 'Error',
    message: error.message,
    stack: error.stack,
    ...sanitizeObject(context || {}),
  };
  
  logger.error(errorInfo, 'Error occurred');
}

/**
 * Sanitize data before logging
 * @param data Data to sanitize
 * @returns Sanitized data
 */
export function sanitize(data: any): any {
  return sanitizeObject(data);
}

/**
 * Set the log level dynamically
 * @param level New log level
 */
export function setLogLevel(level: LogLevel): void {
  const logger = getLogger();
  logger.level = level;
  logger.info({ level }, 'Log level changed');
}

/**
 * Request lifecycle tracking middleware context
 */
export interface RequestLifecycleContext {
  requestId: string;
  logger: pino.Logger;
  startTime: number;
}

/**
 * Start tracking a request lifecycle
 * @param context Initial context
 * @returns Request lifecycle context
 */
export function startRequestTracking(context?: Record<string, any>): RequestLifecycleContext {
  const requestId = generateRequestId();
  const logger = createRequestLogger(requestId, context);
  const startTime = Date.now();
  
  logger.info({ ...sanitizeObject(context || {}) }, 'Request started');
  
  return {
    requestId,
    logger,
    startTime,
  };
}

/**
 * Complete request lifecycle tracking
 * @param ctx Request lifecycle context
 * @param status Request status (success, error, timeout, etc.)
 * @param additionalContext Additional context to log
 */
export function completeRequestTracking(
  ctx: RequestLifecycleContext,
  status: string,
  additionalContext?: Record<string, any>
): void {
  const duration = Date.now() - ctx.startTime;
  
  ctx.logger.info(
    {
      status,
      duration,
      ...sanitizeObject(additionalContext || {}),
    },
    'Request completed'
  );
}

// Initialize logger on module load with defaults
initializeLogger();
