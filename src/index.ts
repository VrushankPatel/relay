#!/usr/bin/env node

import http from 'http';
import { ConfigurationManager } from './components/ConfigurationManager.js';
import { initializeLogger, createChildLogger } from './utils/logger.js';
import { AuthenticationManager } from './components/AuthenticationManager.js';
import { RequestProcessor } from './components/RequestProcessor.js';
import { CacheManager } from './components/CacheManager.js';
import { DeduplicationManager } from './components/DeduplicationManager.js';
import { TokenAnalyzer } from './components/TokenAnalyzer.js';
import { RequestForwarder } from './components/RequestForwarder.js';
import { HealthMonitor, SERVICE_VERSION } from './components/HealthMonitor.js';
import { MetricsCollector } from './components/MetricsCollector.js';
import { APIGatewayImpl } from './components/APIGateway.js';
import type { HTTPResponse } from './components/APIGateway.js';
import type { AuthenticatedRequest } from './types/requests.js';
import type { CopilotResponse, Completion } from './types/copilot.js';

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function main(): Promise<void> {
  const configManager = new ConfigurationManager();
  const config = await configManager.loadConfig();

  initializeLogger({
      level: config.logging.level.toLowerCase() as 'debug' | 'info' | 'warn' | 'error',
    prettyPrint: config.logging.prettyPrint,
  });

  const logger = createChildLogger('Application');
  logger.info({ version: SERVICE_VERSION }, 'GitHub Copilot Token Optimizer Proxy starting');

  const apiKey = process.env.API_KEY || 'dev-key';
  const authManager = new AuthenticationManager({
    apiKeys: new Map([[apiKey, 'default-user']]),
  });

  const requestProcessor = new RequestProcessor();
  const encryptionSecret = config.security.encryptCache ? (process.env.ENCRYPTION_SECRET || undefined) : undefined;
  const cacheManager = new CacheManager(
    config.cache.maxEntries,
    config.cache.ttlHours,
    encryptionSecret,
    config.cache.compressionEnabled,
    config.similarity.maxSearchEntries,
  );
  const dedupManager = new DeduplicationManager();
  const tokenAnalyzer = new TokenAnalyzer(
    config.tokens.budgetPerUserPerDay,
    config.tokens.warningThresholdPercent,
    createChildLogger('TokenAnalyzer'),
  );

  const requestForwarder = new RequestForwarder();
  const healthMonitor = new HealthMonitor();
  const metricsCollector = new MetricsCollector();

  healthMonitor.registerComponent('CacheManager', async () => {
    cacheManager.getStatistics();
    return true;
  });
  healthMonitor.registerComponent('RequestForwarder', () => requestForwarder.checkHealth());
  healthMonitor.registerComponent('DeduplicationManager', async () => true);
  healthMonitor.registerComponent('TokenAnalyzer', async () => true);

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

  gateway.registerRoute('GET', '/diagnostics', async (_req, res) => {
    const health = await healthMonitor.checkHealth();
    const diag = healthMonitor.getDiagnostics(
      config,
      cacheManager.getStatistics(),
      requestForwarder.getPoolStats(),
      metricsCollector.getAggregatedMetrics(),
    );
    sendJson(res, health.healthy ? 200 : 503, diag);
  });

  gateway.registerRoute('POST', '/cache/invalidate', async (req: http.IncomingMessage, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
    }
    try {
      const parsed = body ? JSON.parse(body) : {};
      const count = await cacheManager.invalidate(parsed.userId || undefined);
      sendJson(res, 200, { invalidated: count });
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
    }
  });

  gateway.setAuthenticator(async (apiKey, copilotToken) => {
    return authManager.authenticate(apiKey, copilotToken);
  });

  gateway.setRequestHandler(async (req: AuthenticatedRequest): Promise<HTTPResponse> => {
    const log = createChildLogger('RequestHandler', { userId: req.authResult.userId });
    const body = req.request.body;
    const startTime = Date.now();

    const sendResponse = (status: number, data: unknown, cached: boolean): HTTPResponse => {
      metricsCollector.recordRequest(status, cached, Date.now() - startTime, req.authResult.userId);
      return {
        statusCode: status,
        headers: { 'Content-Type': 'application/json', ...(cached ? { 'X-Cache': cached === true ? 'HIT' : 'MISS' } : {}) },
        body: JSON.stringify(data),
      };
    };

    const safeCacheLookup = async (hash: string) => {
      try { return await cacheManager.lookupExact(hash); }
      catch (e) { log.error({ error: e }, 'Cache lookup failed, degrading'); return null; }
    };
    const safeCacheSimilar = async (hash: string, threshold: number) => {
      try { return await cacheManager.lookupSimilar(hash, threshold); }
      catch (e) { log.error({ error: e }, 'Similarity lookup failed, degrading'); return null; }
    };
    const safeCacheStore = async (hash: string, resp: CopilotResponse, uid: string) => {
      try { await cacheManager.store(hash, resp, uid); }
      catch (e) { log.debug({ error: e }, 'Cache store failed'); }
    };
    const safeTokenCount = (completions: Completion[]) => {
      try { return tokenAnalyzer.countResponseTokens(completions); }
      catch { return 0; }
    };
    const safeTokenConsume = (uid: string, tokens: number, fromCache: boolean) => {
      try { tokenAnalyzer.recordConsumption(uid, tokens, fromCache); }
      catch (e) { log.debug({ error: e, action: 'recordConsumption' }, 'Token tracking failed, degrading'); }
    };
    const safeBudgetCheck = (uid: string) => {
      try { return tokenAnalyzer.checkBudget(uid); }
      catch (e) {
        log.debug({ error: e, action: 'checkBudget' }, 'Budget check failed, degrading');
        return { withinBudget: true, consumed: 0, limit: undefined, remaining: Infinity, percentUsed: 0 } as import('./components/TokenAnalyzer.js').BudgetStatus;
      }
    };
    const safeMetricsTokens = (consumed: number, saved: number) => {
      try { metricsCollector.recordTokens(consumed, saved); }
      catch (e) { log.debug({ error: e, action: 'recordTokens' }, 'Metrics tracking failed, degrading'); }
    };
    const safeMetricsError = (type: string) => {
      try { metricsCollector.recordError(type); }
      catch (e) { log.debug({ error: e, action: 'recordError' }, 'Metrics error failed, degrading'); }
    };

    try {
      const context = requestProcessor.extractContext(body);
      const normalized = requestProcessor.normalizeContext(context);
      const contextHash = requestProcessor.generateContextHash(normalized);
      log.debug({ contextHash: contextHash.substring(0, 16) }, 'Context hash generated');

      const exactMatch = await safeCacheLookup(contextHash);
      if (exactMatch) {
        const responseData = JSON.parse(exactMatch.response.data.toString('utf8')) as CopilotResponse;
        if (responseData.completions) {
          const tokens = safeTokenCount(responseData.completions);
          safeTokenConsume(req.authResult.userId, tokens, true);
          safeMetricsTokens(0, tokens);
        }
        log.info('Cache hit (exact)');
        return sendResponse(200, responseData, true);
      }

      if (config.similarity.enabled) {
        const similarMatch = await safeCacheSimilar(contextHash, config.similarity.threshold);
        if (similarMatch) {
          const responseData = JSON.parse(similarMatch.response.data.toString('utf8')) as CopilotResponse;
          if (responseData.completions) {
            const tokens = safeTokenCount(responseData.completions);
            safeTokenConsume(req.authResult.userId, tokens, true);
            safeMetricsTokens(0, tokens);
          }
          log.info('Cache hit (fuzzy)');
          return sendResponse(200, responseData, true);
        }
      }

      if (dedupManager.isDuplicate(contextHash)) {
        log.info('Deduplicated request');
        const dedupResponse = await dedupManager.waitForCompletion(contextHash);
        if (dedupResponse.completions) {
          const tokens = safeTokenCount(dedupResponse.completions);
          safeMetricsTokens(0, tokens);
        }
        return sendResponse(200, dedupResponse, true);
      }

      const requestTokens = tokenAnalyzer.countRequestTokens(body.prompt);
      const budgetStatus = safeBudgetCheck(req.authResult.userId);
      if (!budgetStatus.withinBudget) {
        safeMetricsError('BUDGET_EXCEEDED');
        return sendResponse(429, {
          error: 'Token budget exceeded',
          code: 'BUDGET_EXCEEDED',
          budgetStatus,
        }, false);
      }

      await dedupManager.registerRequest(contextHash);

      try {
        const copilotResponse = await requestForwarder.forward(
          {
            prompt: body.prompt,
            language: body.language,
            cursorPosition: body.cursorPosition,
            fileContext: body.fileContext,
            maxTokens: body.maxTokens,
          },
          req.authResult.copilotToken,
        );

        const responseTokens = safeTokenCount(copilotResponse.completions || []);
        safeTokenConsume(req.authResult.userId, requestTokens + responseTokens, false);
        safeMetricsTokens(requestTokens + responseTokens, 0);

        await safeCacheStore(contextHash, copilotResponse, req.authResult.userId);
        dedupManager.completeRequest(contextHash, copilotResponse);

        log.info('Cache miss - forwarded to Copilot');
        return sendResponse(200, copilotResponse, false);
      } catch (forwardError) {
        dedupManager.failRequest(contextHash, forwardError instanceof Error ? forwardError : new Error(String(forwardError)));
        safeMetricsError('FORWARD_FAILURE');
        throw forwardError;
      }
    } catch (error) {
      log.error({ error }, 'Error processing request');
      safeMetricsError('INTERNAL_ERROR');
      metricsCollector.recordRequest(500, false, Date.now() - startTime, req.authResult.userId);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Internal server error', code: 'INTERNAL_ERROR' }),
      };
    }
  });

  configManager.watchConfig((newConfig) => {
    Object.assign(config, newConfig);
    logger.info({ changes: newConfig }, 'Configuration updated via hot-reload');
    initializeLogger({
    level: config.logging.level.toLowerCase() as 'debug' | 'info' | 'warn' | 'error',
      prettyPrint: config.logging.prettyPrint,
    });
  });

  await gateway.start(config.server.host, config.server.port);
  logger.info({ host: config.server.host, port: config.server.port }, 'Proxy server started');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal, stopping gracefully');
    metricsCollector.destroy();
    tokenAnalyzer.destroy();
    requestForwarder.destroy();
    configManager.unwatchConfig();
    await gateway.stop();
    logger.info('Graceful shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  process.stderr.write('Failed to start proxy: ' + String(error) + '\n');
  process.exit(1);
});

export { ConfigurationManager };
export type { Configuration } from './types/config.js';
