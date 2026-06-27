/**
 * Unit tests for DeduplicationManager component.
 * 
 * Tests the deduplication logic for in-flight requests including:
 * - Duplicate detection
 * - Request registration
 * - Waiter management
 * - Completion notification
 * - Failure handling and recovery
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DeduplicationManager } from '../../src/components/DeduplicationManager.js';
import { CopilotResponse } from '../../src/types/copilot.js';

describe('DeduplicationManager', () => {
  let dedup: DeduplicationManager;
  
  beforeEach(() => {
    // Create a fresh instance for each test
    dedup = new DeduplicationManager(1000); // 1 second coalesce window
  });
  
  // Helper function to create a mock Copilot response
  const createMockResponse = (text = 'console.log("test")', tokenCount = 10): CopilotResponse => ({
    completions: [
      { text, confidence: 0.95 },
    ],
    model: 'copilot-codex',
    tokenCount,
  });
  
  describe('isDuplicate', () => {
    it('should return false when no in-flight request exists', () => {
      const result = dedup.isDuplicate('hash123');
      expect(result).toBe(false);
    });
    
    it('should return true when in-flight request exists and is pending', async () => {
      const hash = 'hash123';
      await dedup.registerRequest(hash);
      
      const result = dedup.isDuplicate(hash);
      expect(result).toBe(true);
    });
    
    it('should return false when in-flight request is completed', async () => {
      const hash = 'hash123';
      await dedup.registerRequest(hash);
      dedup.completeRequest(hash, createMockResponse());
      
      // Wait a bit for cleanup
      await new Promise(resolve => setTimeout(resolve, 150));
      
      const result = dedup.isDuplicate(hash);
      expect(result).toBe(false);
    });
    
    it('should return false when in-flight request is failed', async () => {
      const hash = 'hash123';
      await dedup.registerRequest(hash);
      dedup.failRequest(hash, new Error('Test error'));
      
      // Wait a bit for cleanup
      await new Promise(resolve => setTimeout(resolve, 150));
      
      const result = dedup.isDuplicate(hash);
      expect(result).toBe(false);
    });
    
    it('should return false when in-flight request is outside coalesce window', async () => {
      // Create deduplication manager with very short window
      const shortWindowDedup = new DeduplicationManager(10); // 10ms window
      const hash = 'hash123';
      
      await shortWindowDedup.registerRequest(hash);
      
      // Wait longer than the coalesce window
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const result = shortWindowDedup.isDuplicate(hash);
      expect(result).toBe(false);
    });
  });
  
  describe('registerRequest', () => {
    it('should register a new in-flight request', async () => {
      const hash = 'hash123';
      
      await dedup.registerRequest(hash);
      
      expect(dedup.isDuplicate(hash)).toBe(true);
      expect(dedup.getInFlightCount()).toBe(1);
    });
    
    it('should handle multiple registrations for different hashes', async () => {
      await dedup.registerRequest('hash1');
      await dedup.registerRequest('hash2');
      await dedup.registerRequest('hash3');
      
      expect(dedup.getInFlightCount()).toBe(3);
      expect(dedup.isDuplicate('hash1')).toBe(true);
      expect(dedup.isDuplicate('hash2')).toBe(true);
      expect(dedup.isDuplicate('hash3')).toBe(true);
    });
    
    it('should not register duplicate request for same hash', async () => {
      const hash = 'hash123';
      
      await dedup.registerRequest(hash);
      await dedup.registerRequest(hash); // Second registration should be ignored
      
      expect(dedup.getInFlightCount()).toBe(1);
    });
  });
  
  describe('waitForCompletion', () => {
    it('should wait for request completion and receive response', async () => {
      const hash = 'hash123';
      const mockResponse = createMockResponse('test code', 15);
      
      await dedup.registerRequest(hash);
      
      // Start waiting in background
      const waiterPromise = dedup.waitForCompletion(hash);
      
      // Complete the request
      dedup.completeRequest(hash, mockResponse);
      
      // Waiter should receive the response
      const result = await waiterPromise;
      expect(result).toEqual(mockResponse);
    });
    
    it('should handle multiple waiters for same request', async () => {
      const hash = 'hash123';
      const mockResponse = createMockResponse('shared response', 20);
      
      await dedup.registerRequest(hash);
      
      // Create multiple waiters
      const waiter1 = dedup.waitForCompletion(hash);
      const waiter2 = dedup.waitForCompletion(hash);
      const waiter3 = dedup.waitForCompletion(hash);
      
      // Complete the request
      dedup.completeRequest(hash, mockResponse);
      
      // All waiters should receive the same response
      const results = await Promise.all([waiter1, waiter2, waiter3]);
      expect(results[0]).toEqual(mockResponse);
      expect(results[1]).toEqual(mockResponse);
      expect(results[2]).toEqual(mockResponse);
    });
    
    it('should throw error when waiting for non-existent request', async () => {
      const hash = 'nonexistent';
      
      await expect(dedup.waitForCompletion(hash)).rejects.toThrow(
        `No in-flight request found for context hash: ${hash}`
      );
    });
    
    it('should return cached response for already completed request', async () => {
      const hash = 'hash123';
      const mockResponse = createMockResponse('cached response', 25);
      
      await dedup.registerRequest(hash);
      dedup.completeRequest(hash, mockResponse);
      
      // Wait for completion should return the cached response
      const result = await dedup.waitForCompletion(hash);
      expect(result).toEqual(mockResponse);
    });
    
    it('should throw cached error for already failed request', async () => {
      const hash = 'hash123';
      const error = new Error('Request failed');
      
      await dedup.registerRequest(hash);
      dedup.failRequest(hash, error);
      
      // Wait for completion should throw the cached error
      await expect(dedup.waitForCompletion(hash)).rejects.toThrow('Request failed');
    });
  });
  
  describe('completeRequest', () => {
    it('should complete request and notify all waiters', async () => {
      const hash = 'hash123';
      const mockResponse = createMockResponse('completion test', 30);
      
      await dedup.registerRequest(hash);
      
      const waiter1 = dedup.waitForCompletion(hash);
      const waiter2 = dedup.waitForCompletion(hash);
      
      dedup.completeRequest(hash, mockResponse);
      
      const results = await Promise.all([waiter1, waiter2]);
      expect(results[0]).toEqual(mockResponse);
      expect(results[1]).toEqual(mockResponse);
    });
    
    it('should clean up request after completion', async () => {
      const hash = 'hash123';
      const mockResponse = createMockResponse();
      
      await dedup.registerRequest(hash);
      dedup.completeRequest(hash, mockResponse);
      
      // Wait for cleanup timeout (100ms)
      await new Promise(resolve => setTimeout(resolve, 150));
      
      expect(dedup.getInFlightCount()).toBe(0);
    });
    
    it('should handle completion of non-existent request gracefully', () => {
      const hash = 'nonexistent';
      const mockResponse = createMockResponse();
      
      // Should not throw
      expect(() => dedup.completeRequest(hash, mockResponse)).not.toThrow();
    });
  });
  
  describe('failRequest', () => {
    it('should make next waiter the primary on failure and keep request in-flight', async () => {
      const hash = 'hash123';
      const error = new Error('API error');
      
      await dedup.registerRequest(hash);
      
      dedup.waitForCompletion(hash);
      dedup.waitForCompletion(hash);
      
      dedup.failRequest(hash, error);
      
      // After failure with waiters, the request remains in-flight with next waiter as primary
      expect(dedup.isDuplicate(hash)).toBe(true);
      expect(dedup.getInFlightCount()).toBe(1);
    });
    
    it('should make next waiter the primary request on failure with waiters', async () => {
      const hash = 'hash123';
      const error = new Error('Primary failed');
      
      await dedup.registerRequest(hash);
      
      // Add a waiter
      const waiter1Promise = dedup.waitForCompletion(hash);
      
      // Fail the primary request
      dedup.failRequest(hash, error);
      
      // The request should still be in-flight (next waiter became primary)
      expect(dedup.isDuplicate(hash)).toBe(true);
      expect(dedup.getInFlightCount()).toBe(1);
    });
    
    it('should clean up request after failure with no waiters', async () => {
      const hash = 'hash123';
      const error = new Error('No waiters error');
      
      await dedup.registerRequest(hash);
      dedup.failRequest(hash, error);
      
      // Wait for cleanup timeout (100ms)
      await new Promise(resolve => setTimeout(resolve, 150));
      
      expect(dedup.getInFlightCount()).toBe(0);
    });
    
    it('should handle failure of non-existent request gracefully', () => {
      const hash = 'nonexistent';
      const error = new Error('Test error');
      
      // Should not throw
      expect(() => dedup.failRequest(hash, error)).not.toThrow();
    });
  });
  
  describe('getStatistics', () => {
    it('should return correct statistics for empty state', () => {
      const stats = dedup.getStatistics();
      
      expect(stats.inFlightCount).toBe(0);
      expect(stats.totalWaiters).toBe(0);
      expect(stats.avgWaitersPerRequest).toBe(0);
      expect(stats.oldestRequestAge).toBe(0);
    });
    
    it('should return correct statistics for in-flight requests', async () => {
      const hash1 = 'hash1';
      const hash2 = 'hash2';
      
      await dedup.registerRequest(hash1);
      await dedup.registerRequest(hash2);
      
      // Add waiters to hash1
      dedup.waitForCompletion(hash1);
      dedup.waitForCompletion(hash1);
      
      // Add waiter to hash2
      dedup.waitForCompletion(hash2);
      
      const stats = dedup.getStatistics();
      
      expect(stats.inFlightCount).toBe(2);
      expect(stats.totalWaiters).toBe(3);
      expect(stats.avgWaitersPerRequest).toBe(1.5);
      expect(stats.oldestRequestAge).toBeGreaterThanOrEqual(0);
    });
    
    it('should track oldest request age correctly', async () => {
      await dedup.registerRequest('hash1');
      
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 50));
      
      await dedup.registerRequest('hash2');
      
      const stats = dedup.getStatistics();
      
      expect(stats.oldestRequestAge).toBeGreaterThanOrEqual(40); // 40ms to allow for some timing variance in event loop
    });
  });
  
  describe('Integration: Full deduplication flow', () => {
    it('should deduplicate simultaneous requests and serve single response', async () => {
      const hash = 'hash123';
      const mockResponse = createMockResponse('deduped response', 40);
      
      // Register the primary request
      await dedup.registerRequest(hash);
      
      // Simulate multiple simultaneous requests with same hash
      const request1 = dedup.waitForCompletion(hash);
      const request2 = dedup.waitForCompletion(hash);
      const request3 = dedup.waitForCompletion(hash);
      
      // Verify all are waiting on the same request
      expect(dedup.isDuplicate(hash)).toBe(true);
      expect(dedup.getInFlightCount()).toBe(1);
      
      const stats = dedup.getStatistics();
      expect(stats.totalWaiters).toBe(3);
      
      // Complete the primary request
      dedup.completeRequest(hash, mockResponse);
      
      // All requests should receive the same response
      const results = await Promise.all([request1, request2, request3]);
      expect(results[0]).toEqual(mockResponse);
      expect(results[1]).toEqual(mockResponse);
      expect(results[2]).toEqual(mockResponse);
    });
    
    it('should handle failure and recovery with queued requests', async () => {
      const hash = 'hash123';
      const mockResponse = createMockResponse('recovered response', 50);
      const error = new Error('First attempt failed');
      
      // Register the primary request
      await dedup.registerRequest(hash);
      
      // Add waiters
      const waiter1 = dedup.waitForCompletion(hash);
      const waiter2 = dedup.waitForCompletion(hash);
      
      // Fail the primary request
      dedup.failRequest(hash, error);
      
      // The first waiter should have been rejected, but request is still in-flight
      // (second waiter became the new primary)
      expect(dedup.isDuplicate(hash)).toBe(true);
      
      // Complete the new primary request
      dedup.completeRequest(hash, mockResponse);
      
      // The second waiter should receive the response
      const result2 = await waiter2;
      expect(result2).toEqual(mockResponse);
    });
  });
  
  describe('Requirements validation', () => {
    it('should coalesce requests within 1 second window (Requirement 5.1)', async () => {
      const hash = 'hash123';
      const mockResponse = createMockResponse('coalesced', 60);
      
      await dedup.registerRequest(hash);
      
      // Requests within 1 second should be coalesced
      const waiter1 = dedup.waitForCompletion(hash);
      
      await new Promise(resolve => setTimeout(resolve, 500)); // 0.5 seconds
      
      const waiter2 = dedup.waitForCompletion(hash);
      
      // Both should still be duplicates
      expect(dedup.isDuplicate(hash)).toBe(true);
      
      dedup.completeRequest(hash, mockResponse);
      
      const results = await Promise.all([waiter1, waiter2]);
      expect(results[0]).toEqual(mockResponse);
      expect(results[1]).toEqual(mockResponse);
    });
    
    it('should queue duplicate requests until first completes (Requirement 5.2)', async () => {
      const hash = 'hash123';
      const mockResponse = createMockResponse('queued', 70);
      
      await dedup.registerRequest(hash);
      
      const waiter1 = dedup.waitForCompletion(hash);
      const waiter2 = dedup.waitForCompletion(hash);
      const waiter3 = dedup.waitForCompletion(hash);
      
      // All should be queued
      const stats = dedup.getStatistics();
      expect(stats.totalWaiters).toBe(3);
      
      // Complete the request
      dedup.completeRequest(hash, mockResponse);
      
      // All should receive the response
      const results = await Promise.all([waiter1, waiter2, waiter3]);
      expect(results.every(r => r === mockResponse)).toBe(true);
    });
    
    it('should return same response to all queued requests (Requirement 5.3)', async () => {
      const hash = 'hash123';
      const mockResponse = createMockResponse('same for all', 80);
      
      await dedup.registerRequest(hash);
      
      const waiters = [
        dedup.waitForCompletion(hash),
        dedup.waitForCompletion(hash),
        dedup.waitForCompletion(hash),
        dedup.waitForCompletion(hash),
        dedup.waitForCompletion(hash),
      ];
      
      dedup.completeRequest(hash, mockResponse);
      
      const results = await Promise.all(waiters);
      
      // All responses should be identical
      for (let i = 0; i < results.length; i++) {
        expect(results[i]).toEqual(mockResponse);
      }
    });
    
    it('should track in-flight requests by context hash (Requirement 5.4)', async () => {
      const hash1 = 'hash-abc-123';
      const hash2 = 'hash-def-456';
      const hash3 = 'hash-ghi-789';
      
      await dedup.registerRequest(hash1);
      await dedup.registerRequest(hash2);
      await dedup.registerRequest(hash3);
      
      expect(dedup.isDuplicate(hash1)).toBe(true);
      expect(dedup.isDuplicate(hash2)).toBe(true);
      expect(dedup.isDuplicate(hash3)).toBe(true);
      expect(dedup.isDuplicate('hash-unknown')).toBe(false);
      
      expect(dedup.getInFlightCount()).toBe(3);
    });
    
    it('should retry with next queued request on failure (Requirement 5.5)', async () => {
      const hash = 'hash123';
      const error = new Error('Primary failed');
      
      await dedup.registerRequest(hash);
      
      // Add multiple waiters
      const waiter1 = dedup.waitForCompletion(hash);
      const waiter2 = dedup.waitForCompletion(hash);
      const waiter3 = dedup.waitForCompletion(hash);
      
      // Fail the primary request
      dedup.failRequest(hash, error);
      
      // First waiter becomes the new primary
      // Request should still be in-flight with remaining waiters
      expect(dedup.isDuplicate(hash)).toBe(true);
      
      const stats = dedup.getStatistics();
      expect(stats.totalWaiters).toBe(2); // Two waiters remain (one became primary)
      
      // Complete the new primary request
      const mockResponse = createMockResponse('retry success', 90);
      dedup.completeRequest(hash, mockResponse);
      
      // Remaining waiters should receive the response
      const result2 = await waiter2;
      const result3 = await waiter3;
      expect(result2).toEqual(mockResponse);
      expect(result3).toEqual(mockResponse);
    });
  });

  
  describe('Streaming Deduplication', () => {
    it('should deduplicate streaming requests and yield chunks', async () => {
      const hash = 'streamHash123';
      await dedup.registerRequest(hash, true);
      
      expect(dedup.isDuplicate(hash)).toBe(true);

      const streamPromise1 = (async () => {
        const chunks: any[] = [];
        for await (const chunk of dedup.waitForStream(hash)) {
          chunks.push(chunk);
        }
        return chunks;
      })();
      
      const streamPromise2 = (async () => {
        const chunks: any[] = [];
        for await (const chunk of dedup.waitForStream(hash)) {
          chunks.push(chunk);
        }
        return chunks;
      })();

      dedup.addStreamChunk(hash, { id: 'chunk1' });
      dedup.addStreamChunk(hash, { id: 'chunk2' });
      dedup.completeStream(hash);

      const [res1, res2] = await Promise.all([streamPromise1, streamPromise2]);
      
      expect(res1).toEqual([{ id: 'chunk1' }, { id: 'chunk2' }]);
      expect(res2).toEqual([{ id: 'chunk1' }, { id: 'chunk2' }]);
    });

    it('should allow waiters joining mid-stream to catch up', async () => {
      const hash = 'streamHash456';
      await dedup.registerRequest(hash, true);
      
      dedup.addStreamChunk(hash, { id: 'chunk1' });
      
      const streamPromise = (async () => {
        const chunks: any[] = [];
        for await (const chunk of dedup.waitForStream(hash)) {
          chunks.push(chunk);
        }
        return chunks;
      })();

      dedup.addStreamChunk(hash, { id: 'chunk2' });
      dedup.completeStream(hash);

      const res = await streamPromise;
      expect(res).toEqual([{ id: 'chunk1' }, { id: 'chunk2' }]);
    });

    it('should fail all stream waiters on stream failure', async () => {
      const hash = 'streamHashError';
      await dedup.registerRequest(hash, true);
      
      const streamPromise = (async () => {
        for await (const chunk of dedup.waitForStream(hash)) {
          // just consume
        }
      })();

      dedup.failRequest(hash, new Error('Stream Error'));

      await expect(streamPromise).rejects.toThrow('Stream Error');
    });

    it('should throw error if waitForStream is used on non-stream request', async () => {
      const hash = 'mixedHash1';
      await dedup.registerRequest(hash, false);
      
      await expect(async () => {
        for await (const chunk of dedup.waitForStream(hash)) {}
      }).rejects.toThrow(/not a stream/);
    });

    it('should throw error if waitForCompletion is used on stream request', async () => {
      const hash = 'mixedHash2';
      await dedup.registerRequest(hash, true);
      
      await expect(dedup.waitForCompletion(hash)).rejects.toThrow(/is a stream/);
    });
  });
});
