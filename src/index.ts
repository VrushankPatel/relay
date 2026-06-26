import { ConfigurationManager } from './components/ConfigurationManager.js';
import { initializeLogger, createChildLogger } from './utils/logger.js';
import { AuthenticationManager } from './components/AuthenticationManager.js';
import { RequestProcessor } from './components/RequestProcessor.js';
import { CacheManager } from './components/CacheManager.js';
import { DeduplicationManager } from './components/DeduplicationManager.js';
import { TokenAnalyzer } from './components/TokenAnalyzer.js';
import { RequestForwarder } from './components/RequestForwarder.js';
import { APIGatewayImpl } from './components/APIGateway.js';
import type { HTTPResponse } from './components/APIGateway.js';
import type { AuthenticatedRequest } from './types/requests.js';
import type { CopilotResponse } from './types/copilot.js';

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

  const gateway = new APIGatewayImpl(
    config.server.maxConcurrentRequests,
    config.server.requestTimeoutMs,
  );

  gateway.setAuthenticator(async (apiKey, copilotToken) => {
    return authManager.authenticate(apiKey, copilotToken);
  });

  gateway.setRequestHandler(async (req: AuthenticatedRequest): Promise<HTTPResponse> => {
    const log = createChildLogger('RequestHandler', { userId: req.authResult.userId });
    const body = req.request.body;

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
        }
        log.info('Cache hit (exact)');
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
          body: JSON.stringify(responseData),
        };
      }

      if (config.similarity.enabled) {
        const similarMatch = await cacheManager.lookupSimilar(contextHash, config.similarity.threshold);
        if (similarMatch) {
          const responseData = JSON.parse(similarMatch.response.data.toString('utf8')) as CopilotResponse;
          if (responseData.completions) {
            const tokens = tokenAnalyzer.countResponseTokens(responseData.completions);
            tokenAnalyzer.recordConsumption(req.authResult.userId, tokens, true);
          }
          log.info('Cache hit (fuzzy)');
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'X-Cache': 'SIMILAR_HIT' },
            body: JSON.stringify(responseData),
          };
        }
      }

      if (dedupManager.isDuplicate(contextHash)) {
        log.info('Deduplicated request');
        const dedupResponse = await dedupManager.waitForCompletion(contextHash);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', 'X-Cache': 'DEDUP' },
          body: JSON.stringify(dedupResponse),
        };
      }

      const requestTokens = tokenAnalyzer.countRequestTokens(body.prompt);
      const budgetStatus = tokenAnalyzer.checkBudget(req.authResult.userId);
      if (!budgetStatus.withinBudget) {
        tokenAnalyzer.recordConsumption(req.authResult.userId, requestTokens, false);
        return {
          statusCode: 429,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Token budget exceeded',
            code: 'BUDGET_EXCEEDED',
            budgetStatus,
          }),
        };
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

        await cacheManager.store(contextHash, copilotResponse, req.authResult.userId);
        dedupManager.completeRequest(contextHash, copilotResponse);

        log.info('Cache miss - forwarded to Copilot');
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
          body: JSON.stringify(copilotResponse),
        };
      } catch (forwardError) {
        dedupManager.failRequest(contextHash, forwardError instanceof Error ? forwardError : new Error(String(forwardError)));
        throw forwardError;
      }
    } catch (error) {
      log.error({ error }, 'Error processing request');
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
