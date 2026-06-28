import https from 'https';
import http from 'http';
import { createChildLogger } from '../utils/logger.js';
import type { PoolStatistics } from '../types/health.js';
import type { InternalChatRequest, InternalChatResponse } from '../types/chat.js';
import type { IProvider } from '../providers/types.js';

const MAX_RETRIES = 3;
const BASE_RETRY_MS = 100;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_MS = 30000;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_SOCKETS = 20;

type CircuitState = 'closed' | 'open' | 'half-open';

export interface IRequestForwarder {
  forward(req: InternalChatRequest, provider: IProvider): Promise<InternalChatResponse>;
  checkHealth(): Promise<boolean>;
  getPoolStats(): PoolStatistics;
  destroy(): void;
}

export class RequestForwarder implements IRequestForwarder {
  private failureCount = 0;
  private circuitState: CircuitState = 'closed';
  private lastFailureTime = 0;
  private totalRequests = 0;
  private successfulRequests = 0;
  private totalLatency = 0;
  private logger: ReturnType<typeof createChildLogger>;

  private httpsAgent: https.Agent;
  private httpAgent: http.Agent;

  constructor() {
    this.logger = createChildLogger('RequestForwarder');
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: MAX_SOCKETS,
      keepAliveMsecs: 120000,
    });
    this.httpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: MAX_SOCKETS,
      keepAliveMsecs: 120000,
    });
    this.logger.info({ maxSockets: MAX_SOCKETS }, 'Request Forwarder initialized');
  }

  async forward(req: InternalChatRequest, provider: IProvider): Promise<InternalChatResponse> {
    this.checkCircuitBreaker();

    if (this.circuitState === 'open') {
      throw new Error('Circuit breaker is open - API temporarily unavailable');
    }

    let lastError: Error | null = null;
    let did401Retry = false;

    // Use the provider to transform the request body
    const body = provider.transformRequestBody(req);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const delay = BASE_RETRY_MS * Math.pow(2, attempt - 1);
          this.logger.debug({ attempt, delay }, 'Retrying request');
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        const headers = await provider.getHeaders();
        const endpointUrl = provider.getEndpointUrl();

        const startTime = Date.now();
        const rawResponse = await this.performRequest(endpointUrl, headers, body);
        const response = provider.parseResponse(rawResponse);
        const latency = Date.now() - startTime;

        this.totalRequests++;
        this.successfulRequests++;
        this.totalLatency += latency;
        this.failureCount = 0;

        if (this.circuitState === 'half-open') {
          this.circuitState = 'closed';
          this.logger.info('Circuit breaker closed - API recovered');
        }

        return response;
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.totalRequests++;

        if (error.statusCode === 401 && !did401Retry) {
          this.logger.warn('Received 401 Unauthorized, refreshing credentials and retrying once');
          await provider.refreshCredentials();
          did401Retry = true;
          attempt--; // Retry this attempt
          continue;
        }

        const isTransient = this.isTransientError(lastError) || (error.statusCode && error.statusCode >= 500);
        if (!isTransient || attempt === MAX_RETRIES) {
          break;
        }

        this.logger.debug({ attempt, error: lastError.message }, 'Transient error, will retry');
      }
    }

    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= CIRCUIT_BREAKER_THRESHOLD) {
      this.circuitState = 'open';
      this.logger.error(
        { failureCount: this.failureCount },
        'Circuit breaker opened - too many consecutive failures',
      );
    }

    throw lastError || new Error('Request failed');
  }

  async checkHealth(): Promise<boolean> {
    return true;
  }

  getPoolStats(): PoolStatistics {
    const averageLatency = this.totalRequests > 0
      ? Math.round(this.totalLatency / this.totalRequests)
      : 0;

    const activeSockets = (this.httpsAgent.sockets ? Object.values(this.httpsAgent.sockets).reduce((sum, arr) => sum + (arr ? arr.length : 0), 0) : 0) +
                          (this.httpAgent.sockets ? Object.values(this.httpAgent.sockets).reduce((sum, arr) => sum + (arr ? arr.length : 0), 0) : 0);

    return {
      totalConnections: MAX_SOCKETS,
      activeConnections: activeSockets,
      queuedRequests: 0,
      averageLatency,
    };
  }

  private async performRequest(
    apiUrl: string,
    headers: Record<string, string>,
    body: Record<string, unknown>
  ): Promise<unknown> {
    const url = new URL(apiUrl);

    return new Promise((resolve, reject) => {
      let upstreamReq: http.ClientRequest;
      const timeoutId = setTimeout(() => {
        if (upstreamReq) upstreamReq.destroy(new Error('Request timeout'));
        reject(new Error('API request timed out'));
      }, REQUEST_TIMEOUT_MS);

      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;

      const options: https.RequestOptions | http.RequestOptions = {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port) : (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        agent: isHttps ? this.httpsAgent : this.httpAgent,
      };

      upstreamReq = transport.request(options, (upstreamRes: any) => {
        const statusCode = upstreamRes.statusCode || 500;

        if (statusCode >= 400) {
          let data = '';
          upstreamRes.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          upstreamRes.on('end', () => {
            clearTimeout(timeoutId);
            const err: any = new Error(`HTTP ${statusCode}: ${data}`);
            err.statusCode = statusCode;
            reject(err);
          });
          upstreamRes.on('error', (err: Error) => {
            clearTimeout(timeoutId);
            reject(err);
          });
          return;
        }

        let data = '';
        upstreamRes.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        upstreamRes.on('end', () => {
          clearTimeout(timeoutId);
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (err) {
            reject(new Error(`API returned non-JSON: ${data.substring(0, 200)}`));
          }
        });
        upstreamRes.on('error', (err: Error) => {
          clearTimeout(timeoutId);
          reject(err);
        });
      });

      upstreamReq.on('error', (error: any) => {
        clearTimeout(timeoutId);
        reject(error);
      });

      upstreamReq.write(JSON.stringify(body));
      upstreamReq.end();
    });
  }

  private checkCircuitBreaker(): void {
    if (this.circuitState === 'open') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= CIRCUIT_BREAKER_RESET_MS) {
        this.circuitState = 'half-open';
        this.logger.info('Circuit breaker half-open - allowing test request');
      }
    }
  }

  private isTransientError(error: Error): boolean {
    const msg = error.message;
    return (
      msg.includes('timeout') ||
      msg.includes('ECONNRESET') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('socket hang up') ||
      msg.includes('503') ||
      msg.includes('502')
    );
  }

  destroy(): void {
    this.httpsAgent.destroy();
    this.httpAgent.destroy();
  }
}
