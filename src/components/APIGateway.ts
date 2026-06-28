/**
 * API Gateway for the GitHub Copilot Token Optimizer Proxy.
 * 
 * Handles all incoming HTTP connections from IDEs and outgoing responses.
 * Implements request validation, authentication, routing, and error handling.
 * 
 * Requirements: 1.1, 1.2, 13.1, 13.4, 13.5
 */

import http from 'http';
import { HTTPRequest, AuthenticatedRequest } from '../types/requests.js';
import { getLogger } from '../utils/logger.js';

const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
const COMPLETIONS_PATH = '/v1/completions';
const ANTHROPIC_MESSAGES_PATH = '/v1/messages';
const RETRY_AFTER_SECONDS = 5;

/**
 * HTTP response sent back to the client.
 */
export interface HTTPResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string | AsyncIterable<string>;
}

/**
 * Request handler function type for processing authenticated requests.
 */
export type RequestHandler = (req: AuthenticatedRequest) => Promise<HTTPResponse>;

/**
 * Route handler for non-completion endpoints (health, metrics, etc).
 */
export type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

/**
 * API Gateway interface defining the contract for handling HTTP requests.
 */
export interface APIGateway {
  /**
   * Handle incoming completion request.
   * @param req - The HTTP request from the IDE
   * @returns Promise resolving to HTTP response
   */
  handleCompletionRequest(req: HTTPRequest): Promise<HTTPResponse>;

  /**
   * Verify client authentication.
   * @param apiKey - The API key from request headers
   * @returns Promise resolving to authentication result
   */
  authenticate(apiKey: string): Promise<boolean>;

  /**
   * Route request to appropriate handler.
   * @param req - The authenticated request
   * @returns Promise resolving to HTTP response
   */
  routeRequest(req: AuthenticatedRequest): Promise<HTTPResponse>;

  /**
   * Start the HTTP server.
   * @param host - Host address to bind to
   * @param port - Port number to listen on
   * @returns Promise resolving when server is started
   */
  start(host: string, port: number): Promise<void>;

  /**
   * Stop the HTTP server.
   * @returns Promise resolving when server is stopped
   */
  stop(): Promise<void>;
}

/**
 * API Gateway implementation using Node.js HTTP server.
 * 
 * Handles:
 * - Request parsing and validation
 * - Client authentication
 * - Connection management (up to 100 concurrent)
 * - Request timeout handling (5 seconds)
 * - Appropriate HTTP status codes (200, 400, 401, 502, 503)
 */
export class APIGatewayImpl implements APIGateway {
  private server: http.Server | null = null;
  private requestHandler: RequestHandler | null = null;
  private activeConnections = 0;
  private readonly maxConcurrentRequests: number;
  private readonly requestTimeoutMs: number;
  private authenticator: ((apiKey: string) => Promise<boolean>) | null = null;
  private routes: Map<string, RouteHandler> = new Map();

  /**
   * Creates a new API Gateway instance.
   * @param maxConcurrentRequests - Maximum number of concurrent requests (default: 100)
   * @param requestTimeoutMs - Request timeout in milliseconds (default: 5000)
   */
  constructor(maxConcurrentRequests = 100, requestTimeoutMs = 5000) {
    this.maxConcurrentRequests = maxConcurrentRequests;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  /**
   * Set the request handler for processing authenticated requests.
   * @param handler - The request handler function
   */
  setRequestHandler(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  /**
   * Register a handler for a specific HTTP method + path.
   */
  registerRoute(method: string, path: string, handler: RouteHandler): void {
    const key = `${method.toUpperCase()}:${path}`;
    this.routes.set(key, handler);
  }

  /**
   * Set the authenticator function.
   * @param authenticator - Function to verify API keys
   */
  setAuthenticator(authenticator: (apiKey: string) => Promise<boolean>): void {
    this.authenticator = authenticator;
  }

  /**
   * Start the HTTP server.
   */
  async start(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res).catch((error) => {
          getLogger().error({ error, url: req.url }, 'Unhandled error in request handler');
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              error: 'Internal server error', 
              code: 'INTERNAL_ERROR' 
            }));
          }
        });
      });

      this.server.on('error', (error) => {
        getLogger().error({ error }, 'Server error');
        reject(error);
      });

      this.server.listen(port, host, () => {
        getLogger().info({ host, port }, 'API Gateway started');
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server.
   */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.closeAllConnections?.();
      this.server.close((error) => {
        if (error) {
          getLogger().error({ error }, 'Error stopping server');
          reject(error);
        } else {
          this.server = null;
          getLogger().info('API Gateway stopped');
          resolve();
        }
      });
    });
  }

  /**
   * Handle incoming HTTP request from Node.js server.
   */
  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // Check concurrent request limit
    if (this.activeConnections >= this.maxConcurrentRequests) {
      await this.sendResponse(res, {
        statusCode: 503,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(RETRY_AFTER_SECONDS) },
        body: JSON.stringify({
          error: 'Service temporarily unavailable',
          code: 'SERVICE_BUSY',
          retryAfter: RETRY_AFTER_SECONDS
        })
      });
      return;
    }

    this.activeConnections++;
    const requestStartTime = Date.now();
    let requestTimedOut = false;

    try {
      // Set timeout for the request
      const timeoutId = setTimeout(() => {
        if (!res.headersSent) {
          requestTimedOut = true;
          this.sendResponse(res, {
            statusCode: 503,
            headers: { 'Content-Type': 'application/json', 'Retry-After': String(RETRY_AFTER_SECONDS) },
            body: JSON.stringify({
              error: 'Request timeout',
              code: 'REQUEST_TIMEOUT',
              retryAfter: 5
            })
          }).catch(() => {});
        }
      }, this.requestTimeoutMs);

      try {
        // Check custom routes first (health, metrics, etc.)
        if (req.method && req.url) {
          if (req.method === 'GET' && req.url === '/v1/models') {
            clearTimeout(timeoutId);
            await this.sendResponse(res, {
              statusCode: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                object: 'list',
                data: [
                  { id: 'gpt-3.5-turbo', object: 'model', created: 1677610602, owned_by: 'openai' },
                  { id: 'gpt-4o', object: 'model', created: 1715367049, owned_by: 'openai' }
                ]
              })
            });
            return;
          }

          const routeKey = `${req.method.toUpperCase()}:${req.url}`;
          const routeHandler = this.routes.get(routeKey);
          if (routeHandler) {
            clearTimeout(timeoutId);
            await routeHandler(req, res);
            return;
          }
        }

        // Only handle specific LLM endpoints
        let pathname = '';
        try {
          const parsedUrl = new URL(req.url || '', 'http://localhost');
          pathname = parsedUrl.pathname;
        } catch (e) {
          pathname = req.url || '';
        }

        const isStandardPath = pathname === CHAT_COMPLETIONS_PATH || 
                               pathname === COMPLETIONS_PATH || 
                               pathname === ANTHROPIC_MESSAGES_PATH;

        const isGeminiPath = /^\/v1(beta)?\/models\/([^/:]+):(streamG|g)enerateContent$/.test(pathname);

        if (req.method !== 'POST' || (!isStandardPath && !isGeminiPath)) {
          clearTimeout(timeoutId);
          await this.sendResponse(res, {
            statusCode: 404,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              error: 'Not found',
              code: 'NOT_FOUND'
            })
          });
          return;
        }

        // Parse request body
        const body = await this.parseRequestBody(req);
        
        // Create HTTPRequest object
        const httpRequest: HTTPRequest = {
          headers: this.extractHeaders(req),
          body,
          clientIP: req.socket.remoteAddress || 'unknown',
          timestamp: Date.now(),
          url: req.url || ''
        };

        // Process the request (timeout remains active during handler execution)
        const response = await this.handleCompletionRequest(httpRequest);
        clearTimeout(timeoutId);

        // Guard against double-response if the timeout already fired
        if (!requestTimedOut) {
          await this.sendResponse(res, response);
        }

        const duration = Date.now() - requestStartTime;
        getLogger().debug({ duration, statusCode: response.statusCode }, 'Request completed');
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof ValidationError) {
          if (!requestTimedOut) {
            await this.sendResponse(res, {
              statusCode: 400,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                error: 'Invalid request format',
                code: 'INVALID_REQUEST',
                details: error.message
              })
            });
          }
          return;
        }
        throw error;
      }
    } finally {
      this.activeConnections--;
    }
  }

  /**
   * Parse and validate the request body.
   */
  private async parseRequestBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let data = '';
      
      req.on('data', (chunk) => {
        data += chunk.toString();
      });

      req.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (error) {
          reject(new ValidationError('Invalid JSON in request body'));
        }
      });

      req.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Extract headers from the request.
   */
  private extractHeaders(req: http.IncomingMessage): Map<string, string> {
    const headers = new Map<string, string>();
    
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        headers.set(key.toLowerCase(), Array.isArray(value) ? value[0] : value);
      }
    }
    
    return headers;
  }

  /**
   * Send HTTP response to the client.
   */
  private async sendResponse(res: http.ServerResponse, response: HTTPResponse): Promise<void> {
    res.writeHead(response.statusCode, response.headers);
    if (typeof response.body === 'string') {
      res.end(response.body);
    } else {
      for await (const chunk of response.body) {
        res.write(chunk);
      }
      res.end();
    }
  }

  /**
   * Handle incoming completion request.
   */
  async handleCompletionRequest(req: HTTPRequest): Promise<HTTPResponse> {
    try {
      // Extract API key from Authorization header, x-goog-api-key, or query param
      let apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
      if (!apiKey) {
        apiKey = req.headers.get('x-goog-api-key') || '';
      }
      if (!apiKey && req.url) {
        try {
          const parsedUrl = new URL(req.url, 'http://localhost');
          apiKey = parsedUrl.searchParams.get('key') || '';
        } catch (e) {}
      }
      
      if (!apiKey) {
        return {
          statusCode: 401,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Authentication failed',
            code: 'AUTH_FAILED',
            message: 'Missing API key'
          })
        };
      }

      // Authenticate the request
      const isAuthenticated = await this.authenticate(apiKey);
      
      if (!isAuthenticated) {
        return {
          statusCode: 401,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Authentication failed',
            code: 'AUTH_FAILED',
            message: 'Invalid API key'
          })
        };
      }

      // Create authenticated request
      const authenticatedRequest: AuthenticatedRequest = {
        request: req
      };

      // Route the request
      return await this.routeRequest(authenticatedRequest);
    } catch (error) {
      if (error instanceof ValidationError) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Invalid request format',
            code: 'INVALID_REQUEST',
            details: error.message
          })
        };
      }

      getLogger().error({ error }, 'Error handling completion request');
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Internal server error',
          code: 'INTERNAL_ERROR'
        })
      };
    }
  }

  /**
   * Verify client authentication.
   */
  async authenticate(apiKey: string): Promise<boolean> {
    if (!this.authenticator) {
      throw new Error('Authenticator not configured');
    }
    
    return await this.authenticator(apiKey);
  }

  /**
   * Route request to appropriate handler.
   */
  async routeRequest(req: AuthenticatedRequest): Promise<HTTPResponse> {
    if (!this.requestHandler) {
      throw new Error('Request handler not configured');
    }
    
    return await this.requestHandler(req);
  }

  /**
   * Get current number of active connections.
   */
  getActiveConnections(): number {
    return this.activeConnections;
  }
}

/**
 * Custom error for request validation failures.
 */
class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
