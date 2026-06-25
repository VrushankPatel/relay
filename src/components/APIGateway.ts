/**
 * API Gateway for the GitHub Copilot Token Optimizer Proxy.
 * 
 * Handles all incoming HTTP connections from IDEs and outgoing responses.
 * Implements request validation, authentication, routing, and error handling.
 * 
 * Requirements: 1.1, 1.2, 13.1, 13.4, 13.5
 */

import http from 'http';
import { HTTPRequest, CompletionRequestBody, AuthResult, AuthenticatedRequest } from '../types/requests.js';
import { logger } from '../utils/logger.js';

/**
 * HTTP response sent back to the client.
 */
export interface HTTPResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Request handler function type for processing authenticated requests.
 */
export type RequestHandler = (req: AuthenticatedRequest) => Promise<HTTPResponse>;

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
   * @param copilotToken - The GitHub Copilot authentication token
   * @returns Promise resolving to authentication result
   */
  authenticate(apiKey: string, copilotToken: string): Promise<AuthResult>;

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
  private authenticator: ((apiKey: string, copilotToken: string) => Promise<AuthResult>) | null = null;

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
   * Set the authenticator function.
   * @param authenticator - Function to verify API keys and Copilot tokens
   */
  setAuthenticator(authenticator: (apiKey: string, copilotToken: string) => Promise<AuthResult>): void {
    this.authenticator = authenticator;
  }

  /**
   * Start the HTTP server.
   */
  async start(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res).catch((error) => {
          logger.error({ error, url: req.url }, 'Unhandled error in request handler');
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
        logger.error({ error }, 'Server error');
        reject(error);
      });

      this.server.listen(port, host, () => {
        logger.info({ host, port }, 'API Gateway started');
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

      this.server.close((error) => {
        if (error) {
          logger.error({ error }, 'Error stopping server');
          reject(error);
        } else {
          logger.info('API Gateway stopped');
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
      this.sendResponse(res, {
        statusCode: 503,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
        body: JSON.stringify({
          error: 'Service temporarily unavailable',
          code: 'SERVICE_BUSY',
          retryAfter: 5
        })
      });
      return;
    }

    this.activeConnections++;
    const requestStartTime = Date.now();

    try {
      // Set timeout for the request
      const timeoutId = setTimeout(() => {
        if (!res.headersSent) {
          this.sendResponse(res, {
            statusCode: 503,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
            body: JSON.stringify({
              error: 'Request timeout',
              code: 'REQUEST_TIMEOUT',
              retryAfter: 5
            })
          });
        }
      }, this.requestTimeoutMs);

      try {
        // Only handle POST /v1/completions
        if (req.method !== 'POST' || req.url !== '/v1/completions') {
          clearTimeout(timeoutId);
          this.sendResponse(res, {
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
          timestamp: Date.now()
        };

        clearTimeout(timeoutId);

        // Process the request
        const response = await this.handleCompletionRequest(httpRequest);
        this.sendResponse(res, response);
        
        const duration = Date.now() - requestStartTime;
        logger.debug({ duration, statusCode: response.statusCode }, 'Request completed');
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    } finally {
      this.activeConnections--;
    }
  }

  /**
   * Parse and validate the request body.
   */
  private async parseRequestBody(req: http.IncomingMessage): Promise<CompletionRequestBody> {
    return new Promise((resolve, reject) => {
      let data = '';
      
      req.on('data', (chunk) => {
        data += chunk.toString();
      });

      req.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          
          // Validate required fields
          if (!parsed.prompt || typeof parsed.prompt !== 'string') {
            reject(new ValidationError('Missing or invalid field: prompt'));
            return;
          }
          if (!parsed.language || typeof parsed.language !== 'string') {
            reject(new ValidationError('Missing or invalid field: language'));
            return;
          }
          if (parsed.cursorPosition === undefined || typeof parsed.cursorPosition !== 'number') {
            reject(new ValidationError('Missing or invalid field: cursorPosition'));
            return;
          }
          if (!parsed.fileContext || typeof parsed.fileContext !== 'string') {
            reject(new ValidationError('Missing or invalid field: fileContext'));
            return;
          }

          const body: CompletionRequestBody = {
            prompt: parsed.prompt,
            language: parsed.language,
            cursorPosition: parsed.cursorPosition,
            fileContext: parsed.fileContext,
            maxTokens: parsed.maxTokens
          };

          resolve(body);
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
  private sendResponse(res: http.ServerResponse, response: HTTPResponse): void {
    res.writeHead(response.statusCode, response.headers);
    res.end(response.body);
  }

  /**
   * Handle incoming completion request.
   */
  async handleCompletionRequest(req: HTTPRequest): Promise<HTTPResponse> {
    try {
      // Extract API key from Authorization header
      const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
      
      // Extract GitHub Copilot token from X-GitHub-Token header
      const copilotToken = req.headers.get('x-github-token') || '';
      
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

      if (!copilotToken) {
        return {
          statusCode: 401,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Authentication failed',
            code: 'AUTH_FAILED',
            message: 'Missing GitHub Copilot token'
          })
        };
      }

      // Authenticate the request
      const authResult = await this.authenticate(apiKey, copilotToken);
      
      if (!authResult.authenticated) {
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
        request: req,
        authResult
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

      logger.error({ error }, 'Error handling completion request');
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
  async authenticate(apiKey: string, copilotToken: string): Promise<AuthResult> {
    if (!this.authenticator) {
      throw new Error('Authenticator not configured');
    }
    
    return await this.authenticator(apiKey, copilotToken);
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
