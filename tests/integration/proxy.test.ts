import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { APIGatewayImpl } from '../../src/components/APIGateway.js';
import { ConfigurationManager } from '../../src/components/ConfigurationManager.js';
import { CacheManager } from '../../src/components/CacheManager.js';
import { FuzzyGuard } from '../../src/components/FuzzyGuard.js';
import { DeduplicationManager } from '../../src/components/DeduplicationManager.js';
import { RequestForwarder } from '../../src/components/RequestForwarder.js';
import { CompatibilityLayer } from '../../src/components/CompatibilityLayer.js';
import { RequestProcessor } from '../../src/components/RequestProcessor.js';
import { GenericProvider } from '../../src/providers/GenericProvider.js';
import { MetricsCollector } from '../../src/components/MetricsCollector.js';
import { TokenAnalyzer } from '../../src/components/TokenAnalyzer.js';
import { createChildLogger } from '../../src/utils/logger.js';
import type { InternalChatRequest, InternalChatResponse } from '../../src/types/chat.js';

describe('Relay Proxy Integration Tests', () => {
  let mockServer: http.Server;
  let mockPort = 0;
  let mockRequestCount = 0;
  let mockRequests: any[] = [];
  let mockResponseDelay = 0;

  let gateway: APIGatewayImpl;
  const PROXY_PORT = 39881;

  beforeAll(async () => {
    // Setup Mock Upstream Server
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        mockRequestCount++;
        const parsed = body ? JSON.parse(body) : {};
        mockRequests.push(parsed);

        const sendResponse = () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'mock-resp-1',
            model: parsed.model || 'mock-model',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'Mock response' }, finish_reason: 'stop' }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            created: Date.now()
          }));
        };

        if (mockResponseDelay > 0) {
          setTimeout(sendResponse, mockResponseDelay);
        } else {
          sendResponse();
        }
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        mockPort = (mockServer.address() as any).port;
        resolve();
      });
    });

    // Setup Relay Proxy components
    const provider = new GenericProvider({
      type: 'generic',
      baseUrl: `http://127.0.0.1:${mockPort}`,
      isMeteredPerToken: true
    });
    await provider.initialize();

    const requestProcessor = new RequestProcessor();
    const compatibilityLayer = new CompatibilityLayer();
    const cacheManager = new CacheManager(1000, 1);
    
    const fuzzyGuard = new FuzzyGuard({
      enabled: true,
      maxTokenEditDistance: 5,
      minimumSimilarityPercent: 80,
      maxEntries: 100,
      rapidEditWindowMs: 5000,
      rapidEditThreshold: 3, // over 3 distinct requests in 5s kills it
    });
    
    const dedupManager = new DeduplicationManager();
    const metricsCollector = new MetricsCollector();
    const tokenAnalyzer = new TokenAnalyzer({ creditMultipliers: {} }, undefined, 90, createChildLogger('test'));
    const requestForwarder = new RequestForwarder();
    
    gateway = new APIGatewayImpl(100, 5000);
    gateway.setAuthenticator(async () => true);

    gateway.registerRoute('GET', '/diagnostics', async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version: '1.0.0',
        cache: cacheManager.getStatistics()
      }));
    });

    gateway.registerRoute('POST', '/cache/invalidate', async (_req, res) => {
      const count = await cacheManager.invalidate();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', invalidatedCount: count }));
    });

    gateway.setPassthroughHandler(async (req, res) => {
      const url = req.url || '';
      try {
        await requestForwarder.passthrough(req, res, provider, url);
      } catch (err: any) {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }));
        }
      }
    });
    
    gateway.setRequestHandler(async (req) => {
      const startTime = Date.now();
      const pathUrl = req.request.url || '/v1/chat/completions';
      
      const sendResponse = (status: number, data: unknown, cached: boolean) => {
        return {
          statusCode: status,
          headers: { 'Content-Type': 'application/json', ...(cached ? { 'X-Cache': 'HIT' } : { 'X-Cache': 'MISS' }) },
          body: JSON.stringify(data),
        };
      };

      try {
        let pathname = '';
        try {
          const parsedUrl = new URL(pathUrl, 'http://localhost');
          pathname = parsedUrl.pathname;
        } catch (e) {
          pathname = pathUrl;
        }
        const geminiMatch = pathname.match(/^\/v1(beta)?\/models\/([^/:]+):(streamG|g)enerateContent$/);
        const isGemini = Boolean(geminiMatch);

        let chatReq: InternalChatRequest;
        if (isGemini) {
          const model = geminiMatch![2];
          const isStream = geminiMatch![3] === 'streamG';
          chatReq = compatibilityLayer.parseGeminiRequest(req.request.body, model, isStream);
        } else {
          chatReq = compatibilityLayer.parseOpenAIChatRequest(req.request.body);
        }

        const normalized = requestProcessor.normalizeRequest(chatReq);
        const { contextHash } = requestProcessor.generateContextHash(normalized);
        
        const formatResponse = (internalRes: InternalChatResponse): unknown => {
          if (isGemini) {
            return compatibilityLayer.formatGeminiResponse(internalRes);
          }
          return compatibilityLayer.formatOpenAIResponse(internalRes);
        };

        // Cache exact lookup
        const exactMatch = await cacheManager.lookupExact(contextHash);
        if (exactMatch) {
          return sendResponse(200, formatResponse(exactMatch.response), true);
        }

        // Cache fuzzy lookup
        const similarMatch = fuzzyGuard.lookup(normalized, contextHash);
        if (similarMatch) {
          return sendResponse(200, formatResponse(similarMatch.response), true);
        }

        // Deduplication
        if (dedupManager.isDuplicate(contextHash)) {
          const dedupResponse = await dedupManager.waitForCompletion(contextHash);
          return sendResponse(200, formatResponse(dedupResponse as InternalChatResponse), true);
        }

        await dedupManager.registerRequest(contextHash);

        // Forward
        try {
          const internalResponse = await requestForwarder.forward(chatReq, provider);

          // Store cache
          const entry = {
            contextHash,
            response: internalResponse,
            timestamp: Date.now(),
            accessCount: 1,
            lastAccessTime: Date.now(),
            model: internalResponse.model,
            inputTokens: 0,
            outputTokens: 0,
          };
          await cacheManager.store(contextHash, entry);
          fuzzyGuard.store(normalized, contextHash, entry);

          dedupManager.completeRequest(contextHash, internalResponse as any);
          return sendResponse(200, formatResponse(internalResponse), false);
        } catch (forwardError) {
          dedupManager.failRequest(contextHash, forwardError as Error);
          throw forwardError;
        }

      } catch (error: any) {
        return {
          statusCode: error.statusCode || 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: error.message || 'Error', code: 'ERROR' }),
        };
      }
    });

    await gateway.start('127.0.0.1', PROXY_PORT);
  });

  afterAll(async () => {
    await gateway.stop();
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  const sendPostPath = (path: string, data: any, customHeaders: Record<string, string> = {}): Promise<{ statusCode: number; headers: any; body: any }> => {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: PROXY_PORT,
        path,
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-key',
          ...customHeaders
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk.toString());
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: body ? JSON.parse(body) : null
          });
        });
      });
      req.on('error', reject);
      req.write(JSON.stringify(data));
      req.end();
    });
  };

  const sendPost = (data: any): Promise<{ statusCode: number; headers: any; body: any }> => {
    return sendPostPath('/v1/chat/completions', data);
  };

  it('1. Exact Caching: serves identical requests from cache', async () => {
    mockRequestCount = 0;
    const reqData = { model: 'gpt-4o', messages: [{ role: 'user', content: 'this is a completely unique string for exact caching that shares no words' }], temperature: 0 };

    const res1 = await sendPost(reqData);
    expect(res1.statusCode).toBe(200);
    expect(res1.headers['x-cache']).toBe('MISS');
    expect(mockRequestCount).toBe(1);

    const res2 = await sendPost(reqData);
    expect(res2.statusCode).toBe(200);
    expect(res2.headers['x-cache']).toBe('HIT');
    expect(mockRequestCount).toBe(1); // Did not increase
  });

  it('2. Fuzzy Caching: serves slightly different requests from cache', async () => {
    mockRequestCount = 0;
    const reqData1 = { model: 'gpt-4o', messages: [{ role: 'user', content: 'a completely different sentence for testing fuzzy logic exclusively' }], temperature: 0 };
    const reqData2 = { model: 'gpt-4o', messages: [{ role: 'user', content: 'a completely different sentence for testing fuzzy logic exclusively!!' }], temperature: 0 }; // small diff

    const res1 = await sendPost(reqData1);
    expect(res1.statusCode).toBe(200);
    expect(res1.headers['x-cache']).toBe('MISS');
    expect(mockRequestCount).toBe(1);

    const res2 = await sendPost(reqData2);
    expect(res2.statusCode).toBe(200);
    expect(res2.headers['x-cache']).toBe('HIT');
    expect(mockRequestCount).toBe(1); // Served by FuzzyGuard
  });

  it('3. Fuzzy Kill Switch: rapid near-identical requests trigger kill switch', async () => {
    mockRequestCount = 0;
    // We already have some distinct hashes in the cache from previous tests.
    // The fuzzy kill switch triggers if we have > 3 distinct requests in the rapidEditWindowMs (5000).
    // Let's send 4 distinct requests rapidly.
    const req1 = { model: 'gpt-4o', messages: [{ role: 'user', content: 'kill switch unique test 1' }], temperature: 0 };
    const req2 = { model: 'gpt-4o', messages: [{ role: 'user', content: 'kill switch unique test 2' }], temperature: 0 };
    const req3 = { model: 'gpt-4o', messages: [{ role: 'user', content: 'kill switch unique test 3' }], temperature: 0 };
    const req4 = { model: 'gpt-4o', messages: [{ role: 'user', content: 'kill switch unique test 4' }], temperature: 0 };
    const req5 = { model: 'gpt-4o', messages: [{ role: 'user', content: 'kill switch unique test 5' }], temperature: 0 }; // This one should be exact match only

    await sendPost(req1); // miss
    await sendPost(req2); // miss
    await sendPost(req3); // miss
    await sendPost(req4); // miss
    
    // Kill switch should now be engaged (we've sent 4 requests in rapid succession).
    // Now if we send a 5th request that is a fuzzy match to req4 (e.g., test 4!), it should MISS because fuzzy is disabled.
    const req4Fuzzy = { model: 'gpt-4o', messages: [{ role: 'user', content: 'kill switch unique test 4!' }], temperature: 0 };
    
    const countBefore = mockRequestCount;
    const res5 = await sendPost(req4Fuzzy);
    
    expect(res5.statusCode).toBe(200);
    expect(res5.headers['x-cache']).toBe('MISS'); 
    expect(mockRequestCount).toBe(countBefore + 1); // Mock server was hit because fuzzy guard was disabled
  });

  it('4. Concurrent Deduplication: collapses simultaneous identical requests', async () => {
    mockRequestCount = 0;
    mockResponseDelay = 100; // Slow down upstream to allow concurrency

    const reqData = { model: 'gpt-4o', messages: [{ role: 'user', content: 'completely distinct dedup test string' }], temperature: 0 };

    const [res1, res2, res3] = await Promise.all([
      sendPost(reqData),
      sendPost(reqData),
      sendPost(reqData)
    ]);

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(res3.statusCode).toBe(200);

    // Only one should be a miss, the others should be hits (served by DedupManager)
    const hits = [res1, res2, res3].filter(r => r.headers['x-cache'] === 'HIT').length;
    const misses = [res1, res2, res3].filter(r => r.headers['x-cache'] === 'MISS').length;

    expect(hits).toBe(2);
    expect(misses).toBe(1);
    expect(mockRequestCount).toBe(1); // Upstream received exactly 1 request

    mockResponseDelay = 0;
  });

  it('5. Gemini Support: routes and translates Gemini format', async () => {
    mockRequestCount = 0;
    const geminiReq = {
      contents: [{ role: 'user', parts: [{ text: 'Explain gravity' }] }],
      generationConfig: { temperature: 0 }
    };

    // First request - MISS
    const res1 = await sendPostPath('/v1/models/gemini-2.0-flash:generateContent?key=test-key', geminiReq);
    expect(res1.statusCode).toBe(200);
    expect(res1.headers['x-cache']).toBe('MISS');
    expect(res1.body.candidates[0].content.parts[0].text).toBe('Mock response');

    // Second request - HIT
    const res2 = await sendPostPath('/v1/models/gemini-2.0-flash:generateContent?key=test-key', geminiReq);
    expect(res2.statusCode).toBe(200);
    expect(res2.headers['x-cache']).toBe('HIT');
    expect(res2.body.candidates[0].content.parts[0].text).toBe('Mock response');
  });

  it('6. Admin Endpoints: diagnostics and cache invalidation', async () => {
    // 1. Diagnostics endpoint
    const diagRes = await new Promise<any>((resolve) => {
      http.get(`http://127.0.0.1:${PROXY_PORT}/diagnostics`, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk.toString());
        res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
      });
    });
    expect(diagRes.statusCode).toBe(200);
    expect(diagRes.body.version).toBe('1.0.0');
    expect(diagRes.body.cache.size).toBeGreaterThanOrEqual(1);

    // 2. Invalidate cache endpoint
    const invalidateRes = await new Promise<any>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: PROXY_PORT,
        path: '/cache/invalidate',
        method: 'POST'
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk.toString());
        res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
      });
      req.end();
    });
    expect(invalidateRes.statusCode).toBe(200);
    expect(invalidateRes.body.status).toBe('success');
    expect(invalidateRes.body.invalidatedCount).toBeGreaterThanOrEqual(1);

    // 3. Diagnostics after invalidation
    const postDiagRes = await new Promise<any>((resolve) => {
      http.get(`http://127.0.0.1:${PROXY_PORT}/diagnostics`, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk.toString());
        res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
      });
    });
    expect(postDiagRes.body.cache.size).toBe(0);
  });

  it('7. Passthrough: proxies non-completion requests without caching', async () => {
    mockRequestCount = 0;
    const reqData = { input: 'hello' };
    const res = await sendPostPath('/v1/embeddings', reqData);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBeUndefined(); // Should not have cache headers
    expect(res.body.model).toBe('mock-model');
    expect(mockRequestCount).toBe(1);
  });
});
