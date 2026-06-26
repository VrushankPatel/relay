import http from 'http';
import { ConfigurationManager } from './components/ConfigurationManager.js';
import { initializeLogger, createChildLogger } from './utils/logger.js';
import { AuthenticationManager } from './components/AuthenticationManager.js';
import { RequestProcessor } from './components/RequestProcessor.js';
import { CacheManager } from './components/CacheManager.js';
import { DeduplicationManager } from './components/DeduplicationManager.js';
import { TokenAnalyzer } from './components/TokenAnalyzer.js';
import { RequestForwarder } from './components/RequestForwarder.js';
import { HealthMonitor } from './components/HealthMonitor.js';
import { MetricsCollector } from './components/MetricsCollector.js';
import { APIGatewayImpl } from './components/APIGateway.js';
import type { HTTPResponse } from './components/APIGateway.js';
import type { AuthenticatedRequest } from './types/requests.js';
import type { CopilotResponse } from './types/copilot.js';

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function main(): Promise<void> {
  const configManager = new ConfigurationManager();
  const config = await configManager.loadConfig();

  initializeLogger({
    level: config.logging.level.toLowerCase() as any,
    prettyPrint: config.logging.prettyPrint,
  });

  const logger = createChildLogger('Application');
  logger.info({ version: '1.0.0' }, 'GitHub Copilot Token Optimizer Proxy starting');

  const apiKey = process.env.API_KEY || 'dev-key';
  const authManager = new AuthenticationManager({
    apiKeys: new Map([[apiKey, 'default-user']]),
  });

  const requestProcessor = new RequestProcessor();
  const cacheManager = new CacheManager(config.cache.maxEntries, config.cache.ttlHours);
  const dedupManager = new DeduplicationManager();
  const tokenAnalyzer = new TokenAnalyzer(
    config.tokens.budgetPerUserPerDay,
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

    try {
      const context = requestProcessor.extractContext(body);
      const normalized = requestProcessor.normalizeContext(context);
      const contextHash = requestProcessor.generateContextHash(normalized);
      log.debug({ contextHash: contextHash.substring(0, 16) }, 'Context hash generated');

      const exactMatch = await cacheManager.lookupExact(contextHash);
      if (exactMatch) {
        const responseData = JSON.parse(exactMatch.response.data.toString('utf8')) as CopilotResponse;
        if (responseData.completions) {
          const tokens = tokenAnalyzer.countResponseTokens(responseData.completions);
          tokenAnalyzer.recordConsumption(req.authResult.userId, tokens, true);
          metricsCollector.recordTokens(0, tokens);
        }
        log.info('Cache hit (exact)');
        return sendResponse(200, responseData, true);
      }

      if (config.similarity.enabled) {
        const similarMatch = await cacheManager.lookupSimilar(contextHash, config.similarity.threshold);
        if (similarMatch) {
          const responseData = JSON.parse(similarMatch.response.data.toString('utf8')) as CopilotResponse;
          if (responseData.completions) {
            const tokens = tokenAnalyzer.countResponseTokens(responseData.completions);
            tokenAnalyzer.recordConsumption(req.authResult.userId, tokens, true);
            metricsCollector.recordTokens(0, tokens);
          }
          log.info('Cache hit (fuzzy)');
          return sendResponse(200, responseData, true);
        }
      }

      if (dedupManager.isDuplicate(contextHash)) {
        log.info('Deduplicated request');
        const dedupResponse = await dedupManager.waitForCompletion(contextHash);
        if (dedupResponse.completions) {
          const tokens = tokenAnalyzer.countResponseTokens(dedupResponse.completions);
          metricsCollector.recordTokens(0, tokens);
        }
        return sendResponse(200, dedupResponse, true);
      }

      const requestTokens = tokenAnalyzer.countRequestTokens(body.prompt);
      const budgetStatus = tokenAnalyzer.checkBudget(req.authResult.userId);
      if (!budgetStatus.withinBudget) {
        metricsCollector.recordError('BUDGET_EXCEEDED');
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

        const responseTokens = tokenAnalyzer.countResponseTokens(copilotResponse.completions || []);
        tokenAnalyzer.recordConsumption(req.authResult.userId, requestTokens + responseTokens, false);
        metricsCollector.recordTokens(requestTokens + responseTokens, 0);

        await cacheManager.store(contextHash, copilotResponse, req.authResult.userId);
        dedupManager.completeRequest(contextHash, copilotResponse);

        log.info('Cache miss - forwarded to Copilot');
        return sendResponse(200, copilotResponse, false);
      } catch (forwardError) {
        dedupManager.failRequest(contextHash, forwardError instanceof Error ? forwardError : new Error(String(forwardError)));
        metricsCollector.recordError('FORWARD_FAILURE');
        throw forwardError;
      }
    } catch (error) {
      log.error({ error }, 'Error processing request');
      metricsCollector.recordError('INTERNAL_ERROR');
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Internal server error', code: 'INTERNAL_ERROR' }),
      };
    }
  });

  await gateway.start(config.server.host, config.server.port);
  logger.info({ host: config.server.host, port: config.server.port }, 'Proxy server started');
}

main().catch((error) => {
  console.error('Failed to start proxy:', error);
  process.exit(1);
});

export { ConfigurationManager };
export type { Configuration } from './types/config.js';
