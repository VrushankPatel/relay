import https from 'https';
import { createChildLogger } from '../utils/logger.js';
import type { CopilotResponse } from '../types/copilot.js';
import type { PoolStatistics } from '../types/health.js';

const COPILOT_API_URL = 'https://api.githubcopilot.com/v1/completions';
const MAX_RETRIES = 3;
const BASE_RETRY_MS = 100;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_MS = 30000;
const REQUEST_TIMEOUT_MS = 30000;

type CircuitState = 'closed' | 'open' | 'half-open';

export interface IRequestForwarder {
  forward(body: Record<string, unknown>, copilotToken: string): Promise<CopilotResponse>;
  checkHealth(): Promise<boolean>;
  getPoolStats(): PoolStatistics;
}

export class RequestForwarder implements IRequestForwarder {
  private failureCount = 0;
  private circuitState: CircuitState = 'closed';
  private lastFailureTime = 0;
  private totalRequests = 0;
  private successfulRequests = 0;
  private totalLatency = 0;
  private logger: ReturnType<typeof createChildLogger>;

  private agent: https.Agent;

  constructor() {
    this.logger = createChildLogger('RequestForwarder');
    this.agent = new https.Agent({
      keepAlive: true,
      maxSockets: 20,
      keepAliveMsecs: 120000,
    });
    this.logger.info({ maxSockets: 20 }, 'Request Forwarder initialized');
  }

  async forward(body: Record<string, unknown>, copilotToken: string): Promise<CopilotResponse> {
    this.checkCircuitBreaker();

    if (this.circuitState === 'open') {
      throw new Error('Circuit breaker is open - API temporarily unavailable');
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const delay = BASE_RETRY_MS * Math.pow(2, attempt - 1);
          this.logger.debug({ attempt, delay }, 'Retrying request');
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        const startTime = Date.now();
        const response = await this.sendRequest(body, copilotToken);
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
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.totalRequests++;

        const isTransient = this.isTransientError(lastError);
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
    try {
      await this.sendRequest(
        { prompt: 'test', language: 'plaintext', cursorPosition: 0, fileContext: '' },
        '',
      );
      return true;
    } catch {
      return false;
    }
  }

  getPoolStats(): PoolStatistics {
    const averageLatency = this.totalRequests > 0
      ? Math.round(this.totalLatency / this.totalRequests)
      : 0;

    return {
      totalConnections: 20,
      activeConnections: this.agent.requests,
      queuedRequests: 0,
      averageLatency,
    };
  }

  private async sendRequest(
    body: Record<string, unknown>,
    copilotToken: string,
  ): Promise<CopilotResponse> {
    const url = new URL(COPILOT_API_URL);

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        req.destroy(new Error('Request timeout'));
        reject(new Error('Copilot API request timed out'));
      }, REQUEST_TIMEOUT_MS);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (copilotToken) {
        headers['Authorization'] = `Bearer ${copilotToken}`;
      }

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        agent: this.agent,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          clearTimeout(timeoutId);
          try {
            const parsed = JSON.parse(data);
            resolve(parsed as CopilotResponse);
          } catch {
            reject(new Error(`Copilot API returned non-JSON: ${data.substring(0, 200)}`));
          }
        });
      });

      req.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(error);
      });

      req.write(JSON.stringify(body));
      req.end();
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
}
