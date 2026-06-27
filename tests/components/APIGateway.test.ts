/**
 * Unit tests for API Gateway.
 * 
 * Tests request handling, validation, authentication, concurrent request limits,
 * and timeout handling.
 * 
 * Requirements: 1.1, 12.1, 13.1, 13.5
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { APIGatewayImpl, HTTPResponse } from '../../src/components/APIGateway.js';
import { HTTPRequest, AuthResult, AuthenticatedRequest } from '../../src/types/requests.js';
import http from 'http';

describe('APIGateway', () => {
  let gateway: APIGatewayImpl;
  const testHost = '127.0.0.1';
  const testPort = 9876;

  beforeEach(() => {
    gateway = new APIGatewayImpl(100, 5000);
    gateway.setAuthenticator(async (apiKey: string, copilotToken: string) => ({
      authenticated: true,
      userId: 'test-user',
      copilotToken: 'copilot-token'
    }));
  });

  afterEach(async () => {
    await gateway.stop();
  });

  describe('Request Validation', () => {
    it('should handle valid completion request', async () => {
      // Setup authenticator
      gateway.setAuthenticator(async (apiKey: string, copilotToken: string) => ({
        authenticated: true,
        userId: 'test-user',
        copilotToken: 'copilot-token'
      }));

      // Setup request handler
      gateway.setRequestHandler(async (req: AuthenticatedRequest) => ({
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completions: [] })
      }));

      const request: HTTPRequest = {
        headers: new Map([
          ['authorization', 'Bearer test-api-key'],
          ['x-github-token', 'gh_test_token'],
        ]),
        body: {
          prompt: 'test prompt',
          language: 'typescript',
          cursorPosition: 100,
          fileContext: 'const x = 1;'
        },
        clientIP: '127.0.0.1',
        timestamp: Date.now()
      };

      const response = await gateway.handleCompletionRequest(request);

      expect(response.statusCode).toBe(200);
      expect(response.headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(response.body);
      expect(body).toEqual({ completions: [] });
    });

    it('should reject request with missing prompt', async () => {
      await gateway.start(testHost, testPort);

      const response = await makeHttpRequest(testPort, {
        method: 'POST',
        path: '/v1/completions',
        headers: {
          'Authorization': 'Bearer test-api-key',
          'x-github-token': 'gh_test_token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          language: 'typescript',
          cursorPosition: 100,
          fileContext: 'const x = 1;'
        })
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('INVALID_REQUEST');
      expect(body.details).toContain('prompt');
    });

    it('should reject request with invalid JSON', async () => {
      await gateway.start(testHost, testPort);

      const response = await makeHttpRequest(testPort, {
        method: 'POST',
        path: '/v1/completions',
        headers: {
          'Authorization': 'Bearer test-api-key',
          'x-github-token': 'gh_test_token',
          'Content-Type': 'application/json'
        },
        body: 'not valid json'
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('INVALID_REQUEST');
    });

    it('should return 404 for non-existent endpoints', async () => {
      await gateway.start(testHost, testPort);

      const response = await makeHttpRequest(testPort, {
        method: 'GET',
        path: '/health',
        headers: {},
        body: ''
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('NOT_FOUND');
    });
  });

  describe('Authentication', () => {
    it('should accept valid API key', async () => {
      gateway.setAuthenticator(async (apiKey: string, copilotToken: string) => {
        if (apiKey === 'valid-api-key') {
          return {
            authenticated: true,
            userId: 'user-123',
            copilotToken: 'copilot-token-456'
          };
        }
        return {
          authenticated: false,
          userId: '',
          copilotToken: ''
        };
      });

      gateway.setRequestHandler(async (req: AuthenticatedRequest) => ({
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      }));

      const request: HTTPRequest = {
        headers: new Map([
          ['authorization', 'Bearer valid-api-key'],
          ['x-github-token', 'gh_test_token'],
        ]),
        body: {
          prompt: 'test',
          language: 'typescript',
          cursorPosition: 0,
          fileContext: ''
        },
        clientIP: '127.0.0.1',
        timestamp: Date.now()
      };

      const response = await gateway.handleCompletionRequest(request);
      expect(response.statusCode).toBe(200);
    });

    it('should reject invalid API key with 401', async () => {
      gateway.setAuthenticator(async (apiKey: string) => ({
        authenticated: false,
        userId: '',
        copilotToken: ''
      }));

      const request: HTTPRequest = {
        headers: new Map([['authorization', 'Bearer invalid-api-key']]),
        body: {
          prompt: 'test',
          language: 'typescript',
          cursorPosition: 0,
          fileContext: ''
        },
        clientIP: '127.0.0.1',
        timestamp: Date.now()
      };

      const response = await gateway.handleCompletionRequest(request);
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('AUTH_FAILED');
    });

    it('should reject request with missing API key', async () => {
      const request: HTTPRequest = {
        headers: new Map(),
        body: {
          prompt: 'test',
          language: 'typescript',
          cursorPosition: 0,
          fileContext: ''
        },
        clientIP: '127.0.0.1',
        timestamp: Date.now()
      };

      const response = await gateway.handleCompletionRequest(request);
      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('AUTH_FAILED');
      expect(body.message).toContain('Missing API key');
    });
  });

  describe('Concurrent Request Handling', () => {
    it('should handle requests up to the concurrent limit', async () => {
      // Create gateway with low limit for testing
      const limitedGateway = new APIGatewayImpl(3, 5000);
      
      limitedGateway.setAuthenticator(async (apiKey: string) => ({
        authenticated: true,
        userId: 'test-user',
        copilotToken: 'copilot-token'
      }));

      // Handler that delays to keep connections active
      limitedGateway.setRequestHandler(async (req: AuthenticatedRequest) => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true })
        };
      });

      await limitedGateway.start(testHost, testPort + 1);

      // Send 5 requests concurrently (limit is 3)
      const requests = Array.from({ length: 5 }, (_, i) => 
        makeHttpRequest(testPort + 1, {
          method: 'POST',
          path: '/v1/completions',
          headers: {
            'Authorization': 'Bearer test-api-key',
            'x-github-token': 'gh_test_token',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            prompt: `test ${i}`,
            language: 'typescript',
            cursorPosition: 0,
            fileContext: ''
          })
        })
      );

      const responses = await Promise.all(requests);
      
      // Some requests should succeed (within limit)
      const successfulResponses = responses.filter(r => r.statusCode === 200);
      expect(successfulResponses.length).toBeGreaterThan(0);
      
      // Some requests should be rejected with 503 (over limit)
      const rejectedResponses = responses.filter(r => r.statusCode === 503);
      expect(rejectedResponses.length).toBeGreaterThan(0);

      await limitedGateway.stop();
    });

    it('should return 503 when concurrent limit exceeded', async () => {
      const limitedGateway = new APIGatewayImpl(1, 5000);

      try {
        limitedGateway.setAuthenticator(async (apiKey: string, copilotToken: string) => ({
          authenticated: true,
          userId: 'test-user',
          copilotToken: 'copilot-token'
        }));

        // Handler that delays significantly
        limitedGateway.setRequestHandler(async (req: AuthenticatedRequest) => {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true })
        };
      });

      await limitedGateway.start(testHost, testPort + 2);

      // Start first request
      const request1Promise = makeHttpRequest(testPort + 2, {
        method: 'POST',
        path: '/v1/completions',
        headers: {
          'Authorization': 'Bearer test-api-key',
          'x-github-token': 'gh_test_token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: 'test 1',
          language: 'typescript',
          cursorPosition: 0,
          fileContext: ''
        })
      });

      // Give first request time to be accepted
      await new Promise(resolve => setTimeout(resolve, 50));

      // Second request should be rejected immediately
      const response2 = await makeHttpRequest(testPort + 2, {
        method: 'POST',
        path: '/v1/completions',
        headers: {
          'Authorization': 'Bearer test-api-key',
          'x-github-token': 'gh_test_token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: 'test 2',
          language: 'typescript',
          cursorPosition: 0,
          fileContext: ''
        })
      });

      expect(response2.statusCode).toBe(503);
      const body = JSON.parse(response2.body);
      expect(body.code).toBe('SERVICE_BUSY');
      expect(body.retryAfter).toBe(5);

      await request1Promise;
      } finally {
        await limitedGateway.stop();
      }
    });
  });

  describe('Request Timeout Handling', () => {
    it('should return 503 when request exceeds timeout', async () => {
      // Create gateway with very short timeout
      const timeoutGateway = new APIGatewayImpl(100, 100);
      
      timeoutGateway.setAuthenticator(async (apiKey: string, copilotToken: string) => ({
        authenticated: true,
        userId: 'test-user',
        copilotToken: 'copilot-token'
      }));

      // Handler that takes longer than timeout
      timeoutGateway.setRequestHandler(async (req: AuthenticatedRequest) => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true })
        };
      });

      await timeoutGateway.start(testHost, testPort + 3);

      const response = await makeHttpRequest(testPort + 3, {
        method: 'POST',
        path: '/v1/completions',
        headers: {
          'Authorization': 'Bearer test-api-key',
          'x-github-token': 'gh_test_token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: 'test',
          language: 'typescript',
          cursorPosition: 0,
          fileContext: ''
        })
      });

      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('REQUEST_TIMEOUT');

      await timeoutGateway.stop();
    });
  });

  describe('Server Lifecycle', () => {
    it('should start and stop server successfully', async () => {
      await gateway.start(testHost, testPort + 4);
      
      // Verify server is running by making a request
      const response = await makeHttpRequest(testPort + 4, {
        method: 'POST',
        path: '/v1/completions',
        headers: {},
        body: '{}'
      });
      
      // Should get a response (even if 401)
      expect(response.statusCode).toBeDefined();
      
      await gateway.stop();
    });
  });
});

/**
 * Helper function to make HTTP requests for testing.
 */
function makeHttpRequest(
  port: number,
  options: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
  }
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: options.method,
        path: options.path,
        headers: options.headers,
        agent: false
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: data
          });
        });
      }
    );

    req.on('error', (error) => {
      reject(error);
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}
