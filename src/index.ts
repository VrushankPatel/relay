#!/usr/bin/env node

import http from 'http';
import { ConfigurationManager } from './components/ConfigurationManager.js';
import { initializeLogger, createChildLogger } from './utils/logger.js';
import { RequestProcessor } from './components/RequestProcessor.js';
import { CacheManager } from './components/CacheManager.js';
import { FuzzyGuard } from './components/FuzzyGuard.js';
import { DeduplicationManager } from './components/DeduplicationManager.js';
import { TokenAnalyzer } from './components/TokenAnalyzer.js';
import { RequestForwarder } from './components/RequestForwarder.js';
import { HealthMonitor, SERVICE_VERSION } from './components/HealthMonitor.js';
import { MetricsCollector } from './components/MetricsCollector.js';
import { APIGatewayImpl } from './components/APIGateway.js';
import type { HTTPResponse } from './components/APIGateway.js';
import { createProvider, CopilotProvider } from './providers/index.js';
import type { AuthenticatedRequest } from './types/requests.js';
import type { InternalChatRequest, InternalChatResponse } from './types/chat.js';
import { CompatibilityLayer } from './components/CompatibilityLayer.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === 'login' || command === 'logout' || command === 'whoami' || command === 'copilot-consent') {
    const configManager = new ConfigurationManager();
    const config = await configManager.loadConfig();
    initializeLogger({ level: 'info', prettyPrint: true });
    
    // Ensure we are using Copilot provider for CLI commands
    const copilotConfig = config.provider?.type === 'copilot' 
      ? config.provider 
      : { type: 'copilot' as const };
      
    const provider = new CopilotProvider(copilotConfig);

    if (command === 'login') {
      await provider.initialize();
      await provider.login();
    } else if (command === 'logout') {
      await provider.logout();
    } else if (command === 'whoami') {
      await provider.initialize();
      await provider.whoami();
    } else if (command === 'copilot-consent') {
      const isAccept = process.argv.includes('--accept');
      if (isAccept) {
        const consentPath = path.join(os.homedir(), '.relay');
        if (!fs.existsSync(consentPath)) fs.mkdirSync(consentPath, { recursive: true });
        fs.writeFileSync(path.join(consentPath, 'consent.json'), JSON.stringify({ accepted: true, timestamp: Date.now() }));
        console.log('✅ Copilot terms accepted.');
      } else {
        console.log('Run `relay copilot-consent --accept` to accept the terms.');
      }
    }
    process.exit(0);
  } else if (!command || command === 'start') {
    const configManager = new ConfigurationManager();
    const config = await configManager.loadConfig();

    initializeLogger({
      level: config.logging.level.toLowerCase() as 'debug' | 'info' | 'warn' | 'error',
      prettyPrint: config.logging.prettyPrint,
    });

    const logger = createChildLogger('Application');
    logger.info({ version: SERVICE_VERSION }, 'Relay Proxy starting');

    // 1. Initialize Provider
    if (!config.provider) {
      throw new Error('No provider configured. Check config.yaml');
    }
    const provider = createProvider(config.provider);
    logger.info({ providerId: provider.id }, 'Initializing provider');
    await provider.initialize();

    // 2. Initialize Core Components
    const requestProcessor = new RequestProcessor();
    const compatibilityLayer = new CompatibilityLayer();
    const cacheManager = new CacheManager(
      config.cache.maxEntries,
      config.cache.ttlHours,
      undefined,
      config.security?.encryptCache
    );
    await cacheManager.initialize();
    const fuzzyGuard = new FuzzyGuard({
      enabled: config.fuzzyCache?.enabled || false,
      maxTokenEditDistance: config.fuzzyCache?.maxTokenEditDistance || 3,
      maxEntries: config.fuzzyCache?.maxEntries || 100,
      rapidEditWindowMs: config.fuzzyCache?.rapidEditWindowMs || 5000,
      rapidEditThreshold: config.fuzzyCache?.rapidEditThreshold || 3,
    });
    const dedupManager = new DeduplicationManager();
    const tokenAnalyzer = new TokenAnalyzer(
      config.models || { creditMultipliers: {} },
      config.tokens.budgetPerUserPerDay,
      config.tokens.warningThresholdPercent,
      createChildLogger('TokenAnalyzer'),
    );

    const requestForwarder = new RequestForwarder();
    const healthMonitor = new HealthMonitor();
    const metricsCollector = new MetricsCollector();

    // 3. Setup Health Monitoring
    healthMonitor.registerComponent('CacheManager', async () => {
      cacheManager.getStatistics();
      return true;
    });
    healthMonitor.registerComponent('Provider', () => provider.checkHealth());
    healthMonitor.registerComponent('RequestForwarder', () => requestForwarder.checkHealth());

    // 4. Setup API Gateway
    const gateway = new APIGatewayImpl(
      config.server.maxConcurrentRequests,
      config.server.requestTimeoutMs,
    );

    gateway.registerRoute('GET', '/health', async (_req, res) => {
      const health = await healthMonitor.checkHealth();
      sendJson(res, health.healthy ? 200 : 503, {
        status: health.healthy ? 'healthy' : 'degraded',
        uptime: health.uptime,
        components: Object.fromEntries(health.components),
      });
    });

    gateway.registerRoute('GET', '/metrics', async (_req, res) => {
      const prometheus = metricsCollector.exportPrometheus();
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(prometheus);
    });

    // 5. Authentication
    gateway.setAuthenticator(async (apiKey) => {
      if (config.security?.apiKey) {
        return apiKey === config.security.apiKey;
      }
      return true; // No API key required by Relay
    });

    // 6. Request Pipeline
    gateway.setRequestHandler(async (req: AuthenticatedRequest): Promise<HTTPResponse> => {
      const log = createChildLogger('RequestHandler');
      const startTime = Date.now();
      const pathUrl = req.request.url || '/v1/chat/completions';
      
      const sendResponse = (status: number, data: unknown, cached: boolean, isStream = false): HTTPResponse => {
        metricsCollector.recordRequest(status, cached, Date.now() - startTime, 'unknown');
        return {
          statusCode: status,
          headers: { 'Content-Type': isStream ? 'text/event-stream' : 'application/json', ...(cached ? { 'X-Cache': 'HIT' } : { 'X-Cache': 'MISS' }) },
          body: (isStream || typeof data === 'string') ? data as string | AsyncIterable<string> : JSON.stringify(data),
        };
      };

      try {
        let chatReq: InternalChatRequest;
        
        let pathname = '';
        try {
          const parsedUrl = new URL(pathUrl, 'http://localhost');
          pathname = parsedUrl.pathname;
        } catch (e) {
          pathname = pathUrl;
        }

        const geminiMatch = pathname.match(/^\/v1(beta)?\/models\/([^/:]+):(streamG|g)enerateContent$/);
        const isGemini = Boolean(geminiMatch);

        // A. Parse Request
        if (isGemini) {
          const model = geminiMatch![2];
          const isStream = geminiMatch![3] === 'streamG';
          chatReq = compatibilityLayer.parseGeminiRequest(req.request.body, model, isStream);
        } else if (pathUrl === '/v1/completions') {
          chatReq = compatibilityLayer.parseOpenAICompletionRequest(req.request.body);
        } else if (pathUrl === '/v1/messages') {
          chatReq = compatibilityLayer.parseAnthropicRequest(req.request.body);
        } else {
          chatReq = compatibilityLayer.parseOpenAIChatRequest(req.request.body);
        }

        const normalized = requestProcessor.normalizeRequest(chatReq);
        const { contextHash } = requestProcessor.generateContextHash(normalized);
        log.debug({ contextHash: contextHash.substring(0, 16) }, 'Context hash generated');

        const formatResponse = (internalRes: InternalChatResponse): unknown => {
          if (isGemini) {
            return compatibilityLayer.formatGeminiResponse(internalRes);
          }
          if (pathUrl === '/v1/messages') {
            return compatibilityLayer.formatAnthropicResponse(internalRes);
          }
          return compatibilityLayer.formatOpenAIResponse(internalRes);
        };

        // B. Cache Lookup
        try {
          const exactMatch = await cacheManager.lookupExact(contextHash);
          if (exactMatch) {
            log.info('Cache hit (exact)');
            // If requested stream but cache is complete object, we could theoretically synthesize SSE.
            // For now, we return it. (If they want real stream synthesis from cache, we'd do it here).
            // But returning the JSON is often acceptable if the IDE handles both. Let's assume JSON is fine or we synthesize:
            if (chatReq.stream) {
              if (isGemini) {
                const streamData = compatibilityLayer.formatGeminiStreamChunk({
                  content: exactMatch.response.choices[0].message.content,
                  finishReason: exactMatch.response.choices[0].finish_reason
                });
                return sendResponse(200, streamData, true, true);
              } else if (pathUrl !== '/v1/messages') {
                // Synthesize OpenAI stream
                const streamData = `data: ${JSON.stringify(formatResponse(exactMatch.response))}\n\ndata: [DONE]\n\n`;
                return sendResponse(200, streamData, true, true);
              }
            }
            return sendResponse(200, formatResponse(exactMatch.response), true, false);
          }
        } catch (e) {
          log.warn({ error: e }, 'Cache exact lookup failed');
        }

        if (config.fuzzyCache?.enabled) {
          try {
            const similarMatch = fuzzyGuard.lookup(normalized, contextHash);
            if (similarMatch) {
              log.info('Cache hit (fuzzy)');
              if (chatReq.stream) {
                if (isGemini) {
                  const streamData = compatibilityLayer.formatGeminiStreamChunk({
                    content: similarMatch.response.choices[0].message.content,
                    finishReason: similarMatch.response.choices[0].finish_reason
                  });
                  return sendResponse(200, streamData, true, true);
                } else if (pathUrl !== '/v1/messages') {
                  const streamData = `data: ${JSON.stringify(formatResponse(similarMatch.response))}\n\ndata: [DONE]\n\n`;
                  return sendResponse(200, streamData, true, true);
                }
              }
              return sendResponse(200, formatResponse(similarMatch.response), true, false);
            }
          } catch (e) {
            log.warn({ error: e }, 'Cache fuzzy lookup failed');
          }
        }

        // C. Deduplication
        if (dedupManager.isDuplicate(contextHash)) {
          log.info('Deduplicated request');
          if (chatReq.stream) {
            return sendResponse(200, dedupManager.waitForStream(contextHash), true, true);
          } else {
            const dedupResponse = await dedupManager.waitForCompletion(contextHash);
            return sendResponse(200, formatResponse(dedupResponse as InternalChatResponse), true, false);
          }
        }

        await dedupManager.registerRequest(contextHash, chatReq.stream);

        // D. Forward
        try {
          if (chatReq.stream) {
            const generator = async function* () {
              const chunks: string[] = [];
              try {
                const stream = requestForwarder.forwardStream(chatReq, provider);
                for await (const chunk of stream) {
                  chunks.push(chunk);
                  let clientChunk = chunk;
                  if (isGemini) {
                    const parsedProviderChunk = compatibilityLayer.parseProviderStreamChunk(chunk, provider.id);
                    clientChunk = compatibilityLayer.formatGeminiStreamChunk(parsedProviderChunk);
                  }
                  dedupManager.addStreamChunk(contextHash, clientChunk);
                  yield clientChunk;
                }
                dedupManager.completeStream(contextHash);

                if (provider.assembleStream) {
                  try {
                    const internalResponse = provider.assembleStream(chunks);
                    const entry = {
                      contextHash,
                      response: internalResponse,
                      timestamp: Date.now(),
                      accessCount: 1,
                      lastAccessTime: Date.now(),
                      model: internalResponse.model,
                      inputTokens: internalResponse.usage?.prompt_tokens || 0,
                      outputTokens: internalResponse.usage?.completion_tokens || 0,
                    };
                    await cacheManager.store(contextHash, entry);
                    if (config.fuzzyCache?.enabled) {
                      fuzzyGuard.store(normalized, contextHash, entry);
                    }
                  } catch (e) {
                    log.warn({ error: e }, 'Cache stream assembly/store failed');
                  }
                }
              } catch (forwardError: any) {
                dedupManager.failRequest(contextHash, forwardError);
                throw forwardError;
              }
            };
            return sendResponse(200, generator(), false, true);
          } else {
            const internalResponse = await requestForwarder.forward(chatReq, provider);

          // E. Cache Store
          try {
            const entry = {
              contextHash,
              response: internalResponse,
              timestamp: Date.now(),
              accessCount: 1,
              lastAccessTime: Date.now(),
              model: internalResponse.model,
              inputTokens: internalResponse.usage?.prompt_tokens || 0,
              outputTokens: internalResponse.usage?.completion_tokens || 0,
            };
            await cacheManager.store(contextHash, entry);
            if (config.fuzzyCache?.enabled) {
              fuzzyGuard.store(normalized, contextHash, entry);
            }
          } catch (e) {
            log.warn({ error: e }, 'Cache store failed');
          }

          dedupManager.completeRequest(contextHash, internalResponse as any);
          log.info('Cache miss - forwarded to provider');
          return sendResponse(200, formatResponse(internalResponse), false, false);
          }
        } catch (forwardError) {
          dedupManager.failRequest(contextHash, forwardError instanceof Error ? forwardError : new Error(String(forwardError)));
          throw forwardError;
        }

      } catch (error: any) {
        log.error({ error }, 'Error processing request');
        return {
          statusCode: error.statusCode || 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: error.message || 'Internal server error', code: 'INTERNAL_ERROR' }),
        };
      }
    });

    configManager.watchConfig((newConfig) => {
      Object.assign(config, newConfig);
      logger.info('Configuration updated via hot-reload');
    });

    await gateway.start(config.server.host, config.server.port);
    logger.info({ host: config.server.host, port: config.server.port, provider: provider.id }, 'Relay Proxy started');

    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Received shutdown signal, stopping gracefully');
      metricsCollector.destroy();
      tokenAnalyzer.destroy();
      requestForwarder.destroy();
      configManager.unwatchConfig();
      provider.destroy();
      await gateway.stop();
      logger.info('Graceful shutdown complete');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } else {
    process.stderr.write(`Unknown command: ${command}\n`);
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write('Failed to start proxy: ' + String(error) + '\n');
  process.exit(1);
});

export { ConfigurationManager };
export type { Configuration } from './types/config.js';
