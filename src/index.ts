#!/usr/bin/env node

import http from 'http';
import { ConfigurationManager } from './components/ConfigurationManager.js';
import { initializeLogger, createChildLogger } from './utils/logger.js';
import { RequestProcessor } from './components/RequestProcessor.js';
import { CacheManager } from './components/CacheManager.js';
import { FuzzyGuard } from './components/FuzzyGuard.js';
import { DeduplicationManager, PROMOTE_TO_PRIMARY } from './components/DeduplicationManager.js';
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
import { spawn, exec } from 'child_process';

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function isRelayProcess(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows
      ? `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object -ExpandProperty CommandLine"`
      : `ps -p ${pid} -o args=`;
    
    exec(cmd, (error, stdout) => {
      if (error || !stdout) {
        try {
          process.kill(pid, 0);
          resolve(true);
        } catch (e) {
          resolve(false);
        }
        return;
      }
      const commandLine = stdout.toLowerCase();
      resolve(commandLine.includes('relay') || commandLine.includes('index.js') || commandLine.includes('index.ts') || commandLine.includes('node'));
    });
  });
}

async function stopCommand(): Promise<void> {
  const statsDir = path.join(os.homedir(), '.relay');
  const pidFile = path.join(statsDir, 'relay.pid');
  
  if (!fs.existsSync(pidFile)) {
    console.log('No Relay daemon is running (no PID file found).');
    process.exit(0);
  }
  
  const pidStr = fs.readFileSync(pidFile, 'utf-8').trim();
  const pid = parseInt(pidStr, 10);
  
  if (isNaN(pid)) {
    console.log('Stale or invalid PID file found. Cleaning it up.');
    try { fs.unlinkSync(pidFile); } catch (e) {}
    process.exit(0);
  }
  
  const active = await isRelayProcess(pid);
  if (!active) {
    console.log('Stale PID file found (process does not exist or is not Relay). Cleaning it up.');
    try { fs.unlinkSync(pidFile); } catch (e) {}
    process.exit(0);
  }
  
  console.log(`Stopping Relay daemon (PID: ${pid})...`);
  try {
    process.kill(pid, 'SIGTERM');
    
    let exited = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200));
      const stillActive = await isRelayProcess(pid);
      if (!stillActive) {
        exited = true;
        break;
      }
    }
    
    if (!exited) {
      console.log('Process did not exit gracefully. Force stopping...');
      try { process.kill(pid, 'SIGKILL'); } catch (e) {}
    }
    
    console.log('✅ Relay daemon stopped.');
  } catch (err: any) {
    console.error(`Failed to stop process ${pid}: ${err.message}`);
  } finally {
    try { fs.unlinkSync(pidFile); } catch (e) {}
  }
  process.exit(0);
}

async function statusCommand(): Promise<void> {
  const { ConfigurationManager } = await import('./components/ConfigurationManager.js');
  
  const configManager = new ConfigurationManager();
  const config = await configManager.loadConfig();
  const port = config.server.port || 8080;
  
  const statsDir = path.join(os.homedir(), '.relay');
  const pidFile = path.join(statsDir, 'relay.pid');
  
  let daemonPid: number | null = null;
  let isDaemonActive = false;
  
  if (fs.existsSync(pidFile)) {
    const pidStr = fs.readFileSync(pidFile, 'utf-8').trim();
    daemonPid = parseInt(pidStr, 10);
    if (!isNaN(daemonPid)) {
      isDaemonActive = await isRelayProcess(daemonPid);
    }
  }
  
  const checkHealth = (): Promise<any> => {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${port}/health`, { timeout: 1000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.end();
    });
  };

  const health = await checkHealth();
  
  if (!health) {
    if (isDaemonActive) {
      console.log(`Relay daemon is running in background (PID: ${daemonPid}) but the API server is unresponsive on port ${port}.`);
      process.exit(1);
    } else {
      console.log('Relay is not running.');
      process.exit(1);
    }
  }
  
  let hitRate = 0;
  const statsPath = path.join(statsDir, 'stats.json');
  if (fs.existsSync(statsPath)) {
    try {
      const stats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
      const total = stats.lifetime?.totalRequestsProxied || 0;
      const hits = (stats.lifetime?.totalExactCacheHits || 0) + (stats.lifetime?.totalFuzzyCacheHits || 0);
      hitRate = total > 0 ? (hits / total) * 100 : 0;
    } catch (e) {}
  }
  
  const isDashboardReachable = await new Promise<boolean>((resolve) => {
    const req = http.get(`http://localhost:${port}/dashboard`, { timeout: 1000 }, (res) => {
      resolve(res.statusCode === 200 || res.statusCode === 401);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
  
  const cacheSecretVal = process.env.RELAY_CACHE_SECRET ? 'explicit' : 'auto-generated';
  const adminApiKeyVal = config.security?.apiKey ? 'explicit' : 'auto-generated';
  
  console.log('Status: \x1b[32mRUNNING\x1b[0m');
  console.log(`Uptime: ${health.uptime} seconds`);
  console.log(`PID: ${daemonPid || 'N/A (started in foreground)'}`);
  console.log(`Current Provider: ${health.relay?.provider || config.provider?.type || 'generic'}`);
  console.log(`Cache Hit Rate: ${hitRate.toFixed(1)}%`);
  console.log(`Dashboard Reachable: ${isDashboardReachable ? 'Yes' : 'No'}`);
  console.log(`RELAY_CACHE_SECRET: ${health.relay?.cacheSecretType || cacheSecretVal}`);
  console.log(`Admin API Key: ${health.relay?.adminApiKeyType || adminApiKeyVal}`);
  process.exit(0);
}

async function doctorCommand(): Promise<void> {
  const dns = await import('dns/promises');
  const { ConfigurationManager } = await import('./components/ConfigurationManager.js');
  const { createProvider } = await import('./providers/index.js');
  
  console.log('🩺 Running Relay Sanity Diagnostics...');
  let failed = false;
  
  try {
    const configManager = new ConfigurationManager();
    const config = await configManager.loadConfig();
    console.log('  [PASS] Configuration file loaded and validated successfully.');
    
    const statsDir = path.join(os.homedir(), '.relay');
    try {
      fs.mkdirSync(statsDir, { recursive: true });
      const testFile = path.join(statsDir, '.doctor_write_test');
      fs.writeFileSync(testFile, 'test', 'utf-8');
      fs.unlinkSync(testFile);
      console.log('  [PASS] State directory (~/.relay) is writable.');
    } catch (err: any) {
      console.log(`  [FAIL] State directory (~/.relay) is NOT writable: ${err.message}`);
      failed = true;
    }
    
    if (config.provider) {
      try {
        const provider = createProvider(config.provider);
        const endpoint = provider.getEndpointUrl();
        const url = new URL(endpoint);
        
        await dns.lookup(url.hostname);
        console.log(`  [PASS] Network connectivity: Resolved hostname ${url.hostname} successfully.`);
      } catch (err: any) {
        console.log(`  [FAIL] Network connectivity: Failed to resolve hostname for provider: ${err.message}`);
        failed = true;
      }
    } else {
      console.log('  [FAIL] No provider configured in config.yaml.');
      failed = true;
    }
    
    const cacheSecretType = process.env.RELAY_CACHE_SECRET ? 'explicit' : 'auto-generated';
    const adminApiKeyType = config.security?.apiKey ? 'explicit' : 'auto-generated';
    
    if (cacheSecretType === 'auto-generated') {
      console.log('  [WARN] RELAY_CACHE_SECRET is auto-generated. Review before production use.');
    } else {
      console.log('  [PASS] RELAY_CACHE_SECRET is explicitly configured.');
    }
    
    if (adminApiKeyType === 'auto-generated') {
      console.log('  [WARN] Admin API Key is auto-generated. Review before production use.');
    } else {
      console.log('  [PASS] Admin API Key is explicitly configured.');
    }
    
  } catch (err: any) {
    console.log(`  [FAIL] Configuration failed to load: ${err.message}`);
    failed = true;
  }
  
  if (failed) {
    console.log('\n❌ Doctor diagnostics failed. Check configuration and permissions.');
    process.exit(1);
  } else {
    console.log('\n✅ All diagnostics passed successfully.');
    process.exit(0);
  }
}

async function logsCommand(): Promise<void> {
  const logFile = path.join(os.homedir(), '.relay', 'relay.log');
  
  if (!fs.existsSync(logFile)) {
    console.error('No daemon log file found. Ensure Relay is running in daemon mode.');
    process.exit(1);
  }
  
  const stats = fs.statSync(logFile);
  let size = stats.size;
  const start = Math.max(0, size - 10000); // read last 10KB
  
  const stream = fs.createReadStream(logFile, { start, encoding: 'utf-8' });
  stream.on('data', (chunk) => {
    process.stdout.write(chunk);
  });
  
  stream.on('end', () => {
    let currentSize = size;
    const interval = setInterval(() => {
      if (!fs.existsSync(logFile)) {
        clearInterval(interval);
        return;
      }
      const newStats = fs.statSync(logFile);
      if (newStats.size > currentSize) {
        const newStream = fs.createReadStream(logFile, {
          start: currentSize,
          end: newStats.size - 1,
          encoding: 'utf-8'
        });
        newStream.on('data', (chunk) => {
          process.stdout.write(chunk);
        });
        currentSize = newStats.size;
      }
    }, 500);
    
    process.on('SIGINT', () => {
      clearInterval(interval);
      process.exit(0);
    });
  });
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
  } else if (command === 'stop') {
    await stopCommand();
  } else if (command === 'status') {
    await statusCommand();
  } else if (command === 'doctor') {
    await doctorCommand();
  } else if (command === 'logs') {
    await logsCommand();
  } else if (!command || command === 'start') {
    const isDaemon = process.argv.includes('--daemon') || process.argv.includes('-d');
    if (isDaemon) {
      const statsDir = path.join(os.homedir(), '.relay');
      fs.mkdirSync(statsDir, { recursive: true });
      
      const pidFile = path.join(statsDir, 'relay.pid');
      const logFile = path.join(statsDir, 'relay.log');
      
      const out = fs.openSync(logFile, 'a');
      const err = fs.openSync(logFile, 'a');
      
      // Filter out the daemon flags
      const args = process.argv.slice(2).filter(arg => arg !== '--daemon' && arg !== '-d');
      if (!args.includes('start')) {
        args.unshift('start');
      }
      
      const isPkg = (process as any).pkg !== undefined;
      const spawnCmd = process.argv[0];
      const spawnArgs = isPkg ? args : [process.argv[1], ...args];
      
      const child = spawn(spawnCmd, spawnArgs, {
        detached: true,
        stdio: ['ignore', out, err]
      });
      
      if (child.pid !== undefined) {
        fs.writeFileSync(pidFile, child.pid.toString(), 'utf-8');
      }
      child.unref();
      
      console.log(`🚀 Relay starting in background (daemon mode)...`);
      console.log(`   PID: ${child.pid !== undefined ? child.pid : 'N/A'}`);
      console.log(`   Logs: ${logFile}`);
      console.log(`   PID File: ${pidFile}`);
      process.exit(0);
    }

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
      minimumSimilarityPercent: config.fuzzyCache?.minimumSimilarityPercent || 97,
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

    // 2.5 Initialize StatsStore and Pricing
    const { loadPricing, calculateCost } = await import('./utils/pricing.js');
    const pricingMap = await loadPricing([provider]);
    const { StatsStore } = await import('./components/StatsStore.js');
    const statsStore = new StatsStore(path.join(os.homedir(), '.relay', 'stats.json'));
    await statsStore.initialize();

    // 2.6 Initialize Admin API Key for security
    let adminApiKey = config.security?.apiKey;

    if (!adminApiKey) {
      const crypto = await import('crypto');
      const fsPromise = await import('fs/promises');
      const statsDir = path.dirname(path.join(os.homedir(), '.relay', 'stats.json'));
      await fsPromise.mkdir(statsDir, { recursive: true });
      const adminKeyPath = path.join(statsDir, 'admin_api_key');
      
      try {
        if (fs.existsSync(adminKeyPath)) {
          adminApiKey = (await fsPromise.readFile(adminKeyPath, 'utf-8')).trim();
        } else {
          adminApiKey = crypto.randomBytes(16).toString('hex');
          await fsPromise.writeFile(adminKeyPath, adminApiKey, { mode: 0o600 });
        }
      } catch (err: any) {
        logger.error({ error: err.message }, 'Failed to load/generate auto-generated admin API key');
      }

      if (adminApiKey) {
        logger.warn(`No security.apiKey configured. Generated persistent admin API key for dashboard: ${adminApiKey}`);
      }
    }

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
        relay: {
          version: SERVICE_VERSION,
          provider: config.provider?.type || 'generic',
          cacheSecretType: process.env.RELAY_CACHE_SECRET ? 'explicit' : 'auto-generated',
          adminApiKeyType: config.security?.apiKey ? 'explicit' : 'auto-generated'
        }
      });
    });

    gateway.registerRoute('GET', '/metrics', async (_req, res) => {
      const prometheus = metricsCollector.exportPrometheus();
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(prometheus);
    });

    gateway.registerRoute('GET', '/dashboard', async (req, res) => {
      if (!checkAdminAuth(req, res)) return;
      const { generateDashboardHTML } = await import('./utils/dashboard.js');
      const html = generateDashboardHTML(statsStore.getStats(), config);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });

    const checkAdminAuth = (req: http.IncomingMessage, res: http.ServerResponse): boolean => {
      const targetKey = config.security?.apiKey || adminApiKey;
      if (targetKey) {
        const authHeader = req.headers['authorization'] || '';
        let token = authHeader.replace(/^Bearer\s+/i, '').trim();
        
        if (!token && req.url) {
          try {
            const parsedUrl = new URL(req.url, 'http://localhost');
            token = (parsedUrl.searchParams.get('key') || '').trim();
          } catch (e) {}
        }
        
        if (token !== targetKey) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }));
          return false;
        }
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error', message: 'No admin API key configured or generated' }));
        return false;
      }
      return true;
    };

    gateway.registerRoute('GET', '/diagnostics', async (req, res) => {
      if (!checkAdminAuth(req, res)) return;

      const obfuscate = (val?: string) => {
        if (!val) return val;
        if (val.length <= 6) return '******';
        return val.substring(0, 3) + '*'.repeat(val.length - 6) + val.substring(val.length - 3);
      };

      const rawConfig = configManager.getCurrentConfig();
      const cleanConfig = JSON.parse(JSON.stringify(rawConfig));
      if (cleanConfig.security?.apiKey) {
        cleanConfig.security.apiKey = obfuscate(cleanConfig.security.apiKey);
      }
      if (cleanConfig.provider?.apiKey) {
        cleanConfig.provider.apiKey = obfuscate(cleanConfig.provider.apiKey);
      }

      const cacheStats = cacheManager.getStatistics();
      const poolStats = requestForwarder.getPoolStats();
      const cumulativeSavings = tokenAnalyzer.getCumulativeSavings();

      sendJson(res, 200, {
        version: SERVICE_VERSION,
        config: cleanConfig,
        cache: cacheStats,
        connectionPool: poolStats,
        credits: {
          cumulativeSavings,
        }
      });
    });

    gateway.registerRoute('POST', '/cache/invalidate', async (req, res) => {
      if (!checkAdminAuth(req, res)) return;

      try {
        const count = await cacheManager.invalidate();
        if (config.fuzzyCache?.enabled || config.similarity?.enabled) {
          fuzzyGuard.clear();
        }
        sendJson(res, 200, {
          status: 'success',
          invalidatedCount: count,
        });
      } catch (error: any) {
        sendJson(res, 500, {
          error: error.message || 'Failed to invalidate cache',
          code: 'INTERNAL_ERROR',
        });
      }
    });

    gateway.setPassthroughHandler(async (req, res) => {
      const log = createChildLogger('Passthrough');
      const url = req.url || '';
      log.info({ method: req.method, url }, 'Passthrough routing request');
      try {
        await requestForwarder.passthrough(req, res, provider, url);
      } catch (err: any) {
        log.error({ error: err.message }, 'Passthrough error');
        if (!res.headersSent) {
          sendJson(res, 502, { error: 'Bad Gateway', message: err.message });
        }
      }
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
      
      const sendResponse = (statusCode: number, data: unknown, cached: boolean, isStream = false): HTTPResponse => {
        console.log('SEND RESPONSE:', { isCacheHit: cached, stream: isStream, statusCode });
        metricsCollector.recordRequest(statusCode, cached, Date.now() - startTime, 'unknown');
        return {
          statusCode: statusCode,
          headers: { 
            'Content-Type': isStream ? 'text/event-stream' : 'application/json', 
            ...(cached ? { 'X-Cache': 'HIT' } : { 'X-Cache': 'MISS' }),
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          },
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

        const replayCacheStream = async function* (response: InternalChatResponse) {
          if (isGemini) {
            yield compatibilityLayer.formatGeminiStreamChunk({
              content: response.choices[0].message.content,
              finishReason: response.choices[0].finish_reason
            });
          } else if (pathUrl !== '/v1/messages') {
            const chunks = compatibilityLayer.synthesizeOpenAIStreamChunks(response);
            for (const chunk of chunks) {
              yield chunk;
              await new Promise(r => setTimeout(r, 5)); // 5ms delay
            }
          } else {
            yield JSON.stringify(formatResponse(response));
          }
        };

        const shouldBypass = cacheManager.shouldBypassCache(normalized);
        console.log('DEBUG_BYPASS:', { temperature: normalized.temperature, shouldBypass });

        // B. Cache Lookup
        if (!shouldBypass) {
          try {
            const exactMatch = await cacheManager.lookupExact(contextHash);
          if (exactMatch) {
            log.info('Cache hit (exact)');
            const reqTokens = tokenAnalyzer.countRequestTokens(chatReq);
            const resTokens = tokenAnalyzer.countResponseTokens(exactMatch.response);
            const costSaved = calculateCost(chatReq.model, reqTokens, resTokens, pricingMap);
            if (chatReq.stream) {
              statsStore.recordCacheHit(provider.id, false, costSaved, true);
              return sendResponse(200, replayCacheStream(exactMatch.response), true, true);
            }
            statsStore.recordCacheHit(provider.id, false, costSaved, false);
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
              const reqTokens = tokenAnalyzer.countRequestTokens(chatReq);
              const resTokens = tokenAnalyzer.countResponseTokens(similarMatch.response);
              const costSaved = calculateCost(chatReq.model, reqTokens, resTokens, pricingMap);
              if (chatReq.stream) {
                statsStore.recordCacheHit(provider.id, true, costSaved, true);
                return sendResponse(200, replayCacheStream(similarMatch.response), true, true);
              }
              statsStore.recordCacheHit(provider.id, true, costSaved, false);
              return sendResponse(200, formatResponse(similarMatch.response), true, false);
            }
          } catch (e) {
            log.warn({ error: e }, 'Cache fuzzy lookup failed');
          }
          }

          // C. Deduplication
          if (dedupManager.isDuplicate(contextHash)) {
            log.info('Deduplicated request');
            const reqTokens = tokenAnalyzer.countRequestTokens(chatReq);
            if (chatReq.stream) {
              // For streams, we only know input tokens upfront
              const costSaved = calculateCost(chatReq.model, reqTokens, 0, pricingMap);
              statsStore.recordDedup(provider.id, costSaved);
              return sendResponse(200, dedupManager.waitForStream(contextHash), true, true);
            } else {
              const dedupResponse = await dedupManager.waitForCompletion(contextHash);
              if (dedupResponse !== PROMOTE_TO_PRIMARY) {
                const resTokens = tokenAnalyzer.countResponseTokens(dedupResponse as InternalChatResponse);
                const costSaved = calculateCost(chatReq.model, reqTokens, resTokens, pricingMap);
                statsStore.recordDedup(provider.id, costSaved);
                return sendResponse(200, formatResponse(dedupResponse as InternalChatResponse), true, false);
              }
              log.info('Waiter promoted to primary, executing upstream call');
            }
          } else {
            await dedupManager.registerRequest(contextHash, chatReq.stream);
          }
        } // end if (!shouldBypass)

        // D. Forward
        try {
          if (chatReq.stream) {
            const generator = async function* () {
              const chunks: string[] = [];
              let completed = false;
              try {
                const stream = requestForwarder.forwardStream(chatReq, provider);
                for await (const chunk of stream) {
                  chunks.push(chunk);
                  let clientChunk = chunk;
                  if (isGemini) {
                    const parsedProviderChunk = compatibilityLayer.parseProviderStreamChunk(chunk, provider.id);
                    clientChunk = compatibilityLayer.formatGeminiStreamChunk(parsedProviderChunk);
                  }
                  if (!shouldBypass) {
                    dedupManager.addStreamChunk(contextHash, clientChunk);
                  }
                  yield clientChunk;
                }
                completed = true;
              } catch (forwardError: any) {
                if (!shouldBypass) {
                  dedupManager.failRequest(contextHash, forwardError);
                }
                throw forwardError;
              } finally {
                if (!shouldBypass) {
                  if (completed) {
                    dedupManager.completeStream(contextHash);
                  } else {
                    dedupManager.failRequest(contextHash, new Error('Client disconnected or stream aborted'));
                  }
                }

                if (provider.assembleStream && chunks.length > 0) {
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
                    if (!shouldBypass && completed) {
                      await cacheManager.store(contextHash, entry);
                      if (config.fuzzyCache?.enabled) {
                        fuzzyGuard.store(normalized, contextHash, entry);
                      }
                    }
                    
                    const reqTokens = tokenAnalyzer.countRequestTokens(chatReq);
                    const resTokens = tokenAnalyzer.countResponseTokens(internalResponse);
                    const cost = calculateCost(chatReq.model, reqTokens, resTokens, pricingMap);
                    statsStore.recordCacheMiss(provider.id, cost, true);
                  } catch (e) {
                    log.warn({ err: e }, 'Telemetry or cache save in stream finally block failed');
                  }
                }
              }
            };
            return sendResponse(200, generator(), false, true);
          } else {
            const internalResponse = await requestForwarder.forward(chatReq, provider);

          // E. Cache Store (only when caching is not bypassed)
          if (!shouldBypass) {
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
          }
          log.info('Cache miss - forwarded to provider');
          const reqTokens = tokenAnalyzer.countRequestTokens(chatReq);
          const resTokens = tokenAnalyzer.countResponseTokens(internalResponse);
          const cost = calculateCost(chatReq.model, reqTokens, resTokens, pricingMap);
          statsStore.recordCacheMiss(provider.id, cost, false);
          return sendResponse(200, formatResponse(internalResponse), false, false);
          }
        } catch (forwardError) {
          if (!shouldBypass) {
            dedupManager.failRequest(contextHash, forwardError instanceof Error ? forwardError : new Error(String(forwardError)));
          }
          throw forwardError;
        }

      } catch (error: any) {
        log.error({ err: error }, 'Error processing request');
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

    await gateway.start(config.server.host, config.server.port, config.server.tls);
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
