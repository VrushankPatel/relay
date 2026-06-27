import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RequestForwarder } from '../../src/components/RequestForwarder.js';

describe('RequestForwarder', () => {
  let forwarder: RequestForwarder;

  beforeEach(() => {
    forwarder = new RequestForwarder();
  });

  describe('getPoolStats', () => {
    it('should return pool statistics with default values', () => {
      const stats = forwarder.getPoolStats();
      expect(stats.totalConnections).toBe(20);
      expect(stats.activeConnections).toBe(0);
      expect(stats.queuedRequests).toBe(0);
      expect(stats.averageLatency).toBe(0);
    });
  });

  describe('checkHealth', () => {
    it('should return false when API is unreachable', async () => {
      vi.spyOn(forwarder as any, 'sendRequest').mockRejectedValue(new Error('network error'));
      const healthy = await forwarder.checkHealth();
      expect(healthy).toBe(false);
    });
  });

  describe('forward happy path', () => {
    it('should return response on successful forward', async () => {
      const mockResponse = { completions: [{ text: 'test', confidence: 0.9 }], model: 'test', tokenCount: 5 };
      vi.spyOn(forwarder as any, 'sendRequest').mockResolvedValue(mockResponse);
      const result = await forwarder.forward({ prompt: 'test', language: 'plaintext', cursorPosition: 0, fileContext: '' }, 'token');
      expect(result.completions).toHaveLength(1);
      expect(result.completions[0].text).toBe('test');
    });
  });

  describe('forward with mock', () => {
    it('should throw when circuit breaker is open initially', async () => {
      // Simulate multiple failures to trip circuit breaker
      vi.spyOn(forwarder as any, 'sendRequest').mockRejectedValue(new Error('timeout'));

      for (let i = 0; i < 5; i++) {
        try {
          await forwarder.forward({ prompt: 'test', language: 'plaintext', cursorPosition: 0, fileContext: '' }, 'token');
        } catch {
          // expected
        }
      }

      await expect(
        forwarder.forward({ prompt: 'test', language: 'plaintext', cursorPosition: 0, fileContext: '' }, 'token'),
      ).rejects.toThrow('Circuit breaker is open');
    });
  });

  describe('isTransientError', () => {
    it('should classify timeout errors as transient', () => {
      const isTransient = (forwarder as any).isTransientError(new Error('request timeout'));
      expect(isTransient).toBe(true);
    });

    it('should classify ECONNRESET as transient', () => {
      const isTransient = (forwarder as any).isTransientError(new Error('ECONNRESET'));
      expect(isTransient).toBe(true);
    });

    it('should classify ETIMEDOUT as transient', () => {
      const isTransient = (forwarder as any).isTransientError(new Error('ETIMEDOUT'));
      expect(isTransient).toBe(true);
    });

    it('should classify 503 as transient', () => {
      const isTransient = (forwarder as any).isTransientError(new Error('503 Service Unavailable'));
      expect(isTransient).toBe(true);
    });

    it('should classify 502 as transient', () => {
      const isTransient = (forwarder as any).isTransientError(new Error('502 Bad Gateway'));
      expect(isTransient).toBe(true);
    });

    it('should classify 400 as not transient', () => {
      const isTransient = (forwarder as any).isTransientError(new Error('400 Bad Request'));
      expect(isTransient).toBe(false);
    });

    it('should classify 404 as not transient', () => {
      const isTransient = (forwarder as any).isTransientError(new Error('404 Not Found'));
      expect(isTransient).toBe(false);
    });
  });

  describe('circuit breaker', () => {
    it('should open after threshold failures', async () => {
      vi.spyOn(forwarder as any, 'sendRequest').mockRejectedValue(new Error('timeout'));

      for (let i = 0; i < 5; i++) {
        try {
          await forwarder.forward({ prompt: 'test', language: 'plaintext', cursorPosition: 0, fileContext: '' }, 'token');
        } catch {
          // expected
        }
      }

      expect((forwarder as any).circuitState).toBe('open');
    });

    it('should close circuit breaker after successful request in half-open state', async () => {
      vi.spyOn(forwarder as any, 'sendRequest').mockRejectedValue(new Error('timeout'));
      for (let i = 0; i < 5; i++) {
        try { await forwarder.forward({ prompt: 'test', language: 'plaintext', cursorPosition: 0, fileContext: '' }, 'token'); } catch {}
      }
      expect((forwarder as any).circuitState).toBe('open');

      (forwarder as any).lastFailureTime = Date.now() - 31000;

      const mockResponse = { completions: [], model: 'test', tokenCount: 0 };
      vi.spyOn(forwarder as any, 'sendRequest').mockResolvedValue(mockResponse);
      await forwarder.forward({ prompt: 'test', language: 'plaintext', cursorPosition: 0, fileContext: '' }, 'token');
      expect((forwarder as any).circuitState).toBe('closed');
    });

    it('should transition to half-open after reset period', async () => {
      vi.spyOn(forwarder as any, 'sendRequest').mockRejectedValue(new Error('timeout'));

      for (let i = 0; i < 5; i++) {
        try {
          await forwarder.forward({ prompt: 'test', language: 'plaintext', cursorPosition: 0, fileContext: '' }, 'token');
        } catch {
          // expected
        }
      }

      expect((forwarder as any).circuitState).toBe('open');

      // Simulate reset period passing
      (forwarder as any).lastFailureTime = Date.now() - 31000;

      // Next call should transition to half-open then fail again
      vi.spyOn(forwarder as any, 'sendRequest').mockRejectedValue(new Error('timeout'));
      try {
        await forwarder.forward({ prompt: 'test', language: 'plaintext', cursorPosition: 0, fileContext: '' }, 'token');
      } catch {
        // expected
      }
    });
  });
});
