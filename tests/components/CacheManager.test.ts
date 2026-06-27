/**
 * Unit tests for CacheManager component.
 * 
 * Tests cache storage, retrieval, LRU eviction, TTL expiration, and similarity matching.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CacheManager } from '../../src/components/CacheManager.js';
import { CopilotResponse } from '../../src/types/copilot.js';
import { CacheEntry } from '../../src/types/cache.js';

describe('CacheManager', () => {
  let cacheManager: CacheManager;

  beforeEach(() => {
    cacheManager = new CacheManager(10000, 24);
    vi.clearAllMocks();
  });

  describe('store and lookupExact', () => {
    it('should store and retrieve a cache entry', async () => {
      const contextHash = 'abc123hash';
      const response: CopilotResponse = {
        completions: [{ text: 'console.log("test");', confidence: 0.9 }],
        model: 'copilot-v1',
        tokenCount: 10,
      };

      await cacheManager.store(contextHash, response, 'user1');

      const entry = await cacheManager.lookupExact(contextHash);

      expect(entry).not.toBeNull();
      expect(entry?.contextHash).toBe(contextHash);
      expect(entry?.userId).toBe('user1');
      expect(entry?.tokenCount).toBe(10);
    });

    it('should return null for non-existent cache entry', async () => {
      const entry = await cacheManager.lookupExact('nonexistent');

      expect(entry).toBeNull();
    });

    it('should update access count and last access time on cache hit', async () => {
      const contextHash = 'test-hash';
      const response: CopilotResponse = {
        completions: [{ text: 'test', confidence: 0.8 }],
        model: 'copilot-v1',
        tokenCount: 5,
      };

      await cacheManager.store(contextHash, response, 'user1');

      const entry1 = await cacheManager.lookupExact(contextHash);
      expect(entry1?.accessCount).toBe(1);
      const firstAccessTime = entry1?.lastAccessTime;

      // Wait a bit to ensure time difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      const entry2 = await cacheManager.lookupExact(contextHash);
      expect(entry2?.accessCount).toBe(2);
      expect(entry2?.lastAccessTime).toBeGreaterThan(firstAccessTime!);
    });

    it('should store multiple entries with different hashes', async () => {
      const response: CopilotResponse = {
        completions: [{ text: 'test', confidence: 0.8 }],
        model: 'copilot-v1',
        tokenCount: 5,
      };

      await cacheManager.store('hash1', response, 'user1');
      await cacheManager.store('hash2', response, 'user2');
      await cacheManager.store('hash3', response, 'user3');

      const entry1 = await cacheManager.lookupExact('hash1');
      const entry2 = await cacheManager.lookupExact('hash2');
      const entry3 = await cacheManager.lookupExact('hash3');

      expect(entry1?.userId).toBe('user1');
      expect(entry2?.userId).toBe('user2');
      expect(entry3?.userId).toBe('user3');
    });

    it('should handle storing entry with same hash (update)', async () => {
      const response1: CopilotResponse = {
        completions: [{ text: 'old', confidence: 0.7 }],
        model: 'copilot-v1',
        tokenCount: 5,
      };
      const response2: CopilotResponse = {
        completions: [{ text: 'new', confidence: 0.9 }],
        model: 'copilot-v2',
        tokenCount: 8,
      };

      await cacheManager.store('same-hash', response1, 'user1');
      await cacheManager.store('same-hash', response2, 'user1');

      const entry = await cacheManager.lookupExact('same-hash');
      expect(entry?.tokenCount).toBe(8); // Should have updated value
    });
  });

  describe('isExpired', () => {
    it('should return false for entries less than 24 hours old', () => {
      const entry: CacheEntry = {
        contextHash: 'test',
        response: { data: Buffer.from(''), originalSize: 0, compressedSize: 0 },
        timestamp: Date.now() - 1000 * 60 * 60 * 20, // 20 hours ago
        userId: 'user1',
        accessCount: 1,
        lastAccessTime: Date.now(),
        tokenCount: 10,
      };

      expect(cacheManager.isExpired(entry)).toBe(false);
    });

    it('should return true for entries exactly 24 hours old', () => {
      const entry: CacheEntry = {
        contextHash: 'test',
        response: { data: Buffer.from(''), originalSize: 0, compressedSize: 0 },
        timestamp: Date.now() - 1000 * 60 * 60 * 24, // Exactly 24 hours ago
        userId: 'user1',
        accessCount: 1,
        lastAccessTime: Date.now(),
        tokenCount: 10,
      };

      expect(cacheManager.isExpired(entry)).toBe(true);
    });

    it('should return true for entries older than 24 hours', () => {
      const entry: CacheEntry = {
        contextHash: 'test',
        response: { data: Buffer.from(''), originalSize: 0, compressedSize: 0 },
        timestamp: Date.now() - 1000 * 60 * 60 * 25, // 25 hours ago
        userId: 'user1',
        accessCount: 1,
        lastAccessTime: Date.now(),
        tokenCount: 10,
      };

      expect(cacheManager.isExpired(entry)).toBe(true);
    });

    it('should return false for very recent entries', () => {
      const entry: CacheEntry = {
        contextHash: 'test',
        response: { data: Buffer.from(''), originalSize: 0, compressedSize: 0 },
        timestamp: Date.now() - 1000, // 1 second ago
        userId: 'user1',
        accessCount: 1,
        lastAccessTime: Date.now(),
        tokenCount: 10,
      };

      expect(cacheManager.isExpired(entry)).toBe(false);
    });
  });

  describe('lookupExact with TTL', () => {
    it('should return null and remove expired entries', async () => {
      const contextHash = 'expired-hash';
      const response: CopilotResponse = {
        completions: [{ text: 'test', confidence: 0.8 }],
        model: 'copilot-v1',
        tokenCount: 5,
      };

      // Create cache manager with 1ms TTL for testing
      const shortTTLCache = new CacheManager(10000, 1 / (60 * 60 * 1000)); // 1ms TTL

      await shortTTLCache.store(contextHash, response, 'user1');

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 10));

      const entry = await shortTTLCache.lookupExact(contextHash);
      expect(entry).toBeNull();
    });

    it('should return valid entries that are not expired', async () => {
      const contextHash = 'valid-hash';
      const response: CopilotResponse = {
        completions: [{ text: 'test', confidence: 0.8 }],
        model: 'copilot-v1',
        tokenCount: 5,
      };

      await cacheManager.store(contextHash, response, 'user1');

      const entry = await cacheManager.lookupExact(contextHash);
      expect(entry).not.toBeNull();
      expect(entry?.contextHash).toBe(contextHash);
    });
  });

  describe('evictLRU', () => {
    it('should evict least recently used entries', async () => {
      const response: CopilotResponse = {
        completions: [{ text: 'test', confidence: 0.8 }],
        model: 'copilot-v1',
        tokenCount: 5,
      };

      // Store entries in sequence
      await cacheManager.store('hash1', response, 'user1');
      await new Promise((resolve) => setTimeout(resolve, 5));
      await cacheManager.store('hash2', response, 'user1');
      await new Promise((resolve) => setTimeout(resolve, 5));
      await cacheManager.store('hash3', response, 'user1');

      // Evict 1 entry (should evict hash1 - least recently added)
      const evicted = await cacheManager.evictLRU(1);

      expect(evicted).toBe(1);
      expect(await cacheManager.lookupExact('hash1')).toBeNull();
      expect(await cacheManager.lookupExact('hash2')).not.toBeNull();
      expect(await cacheManager.lookupExact('hash3')).not.toBeNull();
    });

    it('should evict multiple entries', async () => {
      const response: CopilotResponse = {
        completions: [{ text: 'test', confidence: 0.8 }],
        model: 'copilot-v1',
        tokenCount: 5,
      };

      await cacheManager.store('hash1', response, 'user1');
      await cacheManager.store('hash2', response, 'user1');
      await cacheManager.store('hash3', response, 'user1');

      const evicted = await cacheManager.evictLRU(2);

      expect(evicted).toBe(2);
    });

    it('should evict oldest accessed entries first', async () => {
      const response: CopilotResponse = {
        completions: [{ text: 'test', confidence: 0.8 }],
        model: 'copilot-v1',
        tokenCount: 5,
      };

      // Store three entries
      await cacheManager.store('hash1', response, 'user1');
      await cacheManager.store('hash2', response, 'user1');
      await cacheManager.store('hash3', response, 'user1');

      // Access hash1 to make it more recently used
      await cacheManager.lookupExact('hash1');

      // Evict 1 entry (should evict hash2 - oldest access)
      const evicted = await cacheManager.evictLRU(1);

      expect(evicted).toBe(1);
      expect(await cacheManager.lookupExact('hash1')).not.toBeNull();
      expect(await cacheManager.lookupExact('hash2')).toBeNull();
      expect(await cacheManager.lookupExact('hash3')).not.toBeNull();
    });

    it('should handle evicting more entries than exist', async () => {
      const response: CopilotResponse = {
        completions: [{ text: 'test', confidence: 0.8 }],
        model: 'copilot-v1',
        tokenCount: 5,
      };

      await cacheManager.store('hash1', response, 'user1');
      await cacheManager.store('hash2', response, 'user1');

      const evicted = await cacheManager.evictLRU(10);

      expect(evicted).toBe(2); // Only 2 entries existed
    });

    it('should handle evicting from empty cache', async () => {
      const evicted = await cacheManager.evictLRU(5);

      expect(evicted).toBe(0);
    });
  });

  describe('automatic eviction on capacity', () => {
    it('should automatically evict when cache reaches max capacity', async () => {
      const smallCache = new CacheManager(3, 24); // Max 3 entries
      const response: CopilotResponse = {
        completions: [{ text: 'test', confidence: 0.8 }],
        model: 'copilot-v1',
        tokenCount: 5,
      };

      // Fill cache to capacity
      await smallCache.store('hash1', response, 'user1');
      await smallCache.store('hash2', response, 'user1');
      await smallCache.store('hash3', response, 'user1');

      // Add one more - should trigger eviction
      await smallCache.store('hash4', response, 'user1');

      // hash1 should be evicted (oldest)
      expect(await smallCache.lookupExact('hash1')).toBeNull();
      expect(await smallCache.lookupExact('hash2')).not.toBeNull();
      expect(await smallCache.lookupExact('hash3')).not.toBeNull();
      expect(await smallCache.lookupExact('hash4')).not.toBeNull();
    });
  });

  describe('invalidate', () => {
    it('should invalidate all entries for a specific user', async () => {
      const response: CopilotResponse = {
        completions: [{ text: 'test', confidence: 0.8 }],
        model: 'copilot-v1',
        tokenCount: 5,
      };

      await cacheManager.store('hash1', response, 'user1');
      await cacheManager.store('hash2', response, 'user1');
      await cacheManager.store('hash3', response, 'user2');

      const invalidated = await cacheManager.invalidate('user1');

      expect(invalidated).toBe(2);
      expect(await cacheManager.lookupExact('hash1')).toBeNull();
      expect(await cacheManager.lookupExact('hash2')).toBeNull();
      expect(await cacheManager.lookupExact('hash3')).not.toBeNull(); // user2 entry remains
    });

    it('should invalidate all entries when no user specified', async () => {
      const response: CopilotResponse = {
        completions: [{ text: 'test', confidence: 0.8 }],
        model: 'copilot-v1',
        tokenCount: 5,
      };

      await cacheManager.store('hash1', response, 'user1');
      await cacheManager.store('hash2', response, 'user2');
      await cacheManager.store('hash3', response, 'user3');

      const invalidated = await cacheManager.invalidate();

      expect(invalidated).toBe(3);
      expect(await cacheManager.lookupExact('hash1')).toBeNull();
      expect(await cacheManager.lookupExact('hash2')).toBeNull();
      expect(await cacheManager.lookupExact('hash3')).toBeNull();
    });

    it('should return 0 when invalidating non-existent user', async () => {
      const response: CopilotResponse = {
        completions: [{ text: 'test', confidence: 0.8 }],
        model: 'copilot-v1',
        tokenCount: 5,
      };

      await cacheManager.store('hash1', response, 'user1');

      const invalidated = await cacheManager.invalidate('user2');

      expect(invalidated).toBe(0);
      expect(await cacheManager.lookupExact('hash1')).not.toBeNull(); // user1 entry remains
    });

    it('should handle invalidating empty cache', async () => {
      const invalidated = await cacheManager.invalidate();

      expect(invalidated).toBe(0);
    });
  });

  describe('calculateSimilarity', () => {
    it('should return 1.0 for identical strings', () => {
      const similarity = cacheManager.calculateSimilarity('abc123', 'abc123');

      expect(similarity).toBe(1.0);
    });

    it('should return 0.0 for completely different strings of same length', () => {
      const similarity = cacheManager.calculateSimilarity('aaaa', 'bbbb');

      expect(similarity).toBe(0.0);
    });

    it('should calculate similarity between similar strings', () => {
      const similarity = cacheManager.calculateSimilarity('kitten', 'sitting');

      // Levenshtein distance is 3, max length is 7
      // Similarity = 1 - 3/7 ≈ 0.571
      expect(similarity).toBeCloseTo(0.571, 2);
    });

    it('should calculate similarity for strings with one character difference', () => {
      const similarity = cacheManager.calculateSimilarity('test1', 'test2');

      // Levenshtein distance is 1, max length is 5
      // Similarity = 1 - 1/5 = 0.8
      expect(similarity).toBe(0.8);
    });

    it('should handle empty strings', () => {
      const similarity = cacheManager.calculateSimilarity('', '');

      expect(similarity).toBe(1.0);
    });

    it('should calculate similarity for strings of different lengths', () => {
      const similarity = cacheManager.calculateSimilarity('abc', 'abcdef');

      // Levenshtein distance is 3 (insert d, e, f), max length is 6
      // Similarity = 1 - 3/6 = 0.5
      expect(similarity).toBe(0.5);
    });
  });

  describe('lookupSimilar', () => {
    it('should find similar entry above threshold', async () => {
      const response: CopilotResponse = {
        completions: [{ text: 'test', confidence: 0.8 }],
        model: 'copilot-v1',
        tokenCount: 5,
      };

      // Store entry with hash 'abcdef123456'
      await cacheManager.store('abcdef123456', response, 'user1');

      // Search with similar hash (one character different)
      // Similarity should be 11/12 = 91.67% (above 85% threshold)
      const entry = await cacheManager.lookupSimilar('abcdef123457', 85);

      expect(entry).not.toBeNull();
      expect(entry?.contextHash).toBe('abcdef123456');
    });

    it('should return null when no entry meets threshold', async () => {
      const response: CopilotResponse = {
        completions: [{ text: 'test', confidence: 0.8 }],
        model: 'copilot-v1',
        tokenCount: 5,
      };

      await cacheManager.store('aaaaaaaa', response, 'user1');

      // Search with very different hash
      const entry = await cacheManager.lookupSimilar('bbbbbbbb', 85);

      expect(entry).toBeNull();
    });

    it('should skip expired entries in similarity search', async () => {
      const response: CopilotResponse = {
        completions: [{ text: 'test', confidence: 0.8 }],
        model: 'copilot-v1',
        tokenCount: 5,
      };

      const shortTTLCache = new CacheManager(10000, 1 / (60 * 60 * 1000)); // 1ms TTL

      await shortTTLCache.store('similar123', response, 'user1');

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 10));

      const entry = await shortTTLCache.lookupSimilar('similar124', 85);

      expect(entry).toBeNull();
    });

    it('should return best match when multiple entries meet threshold', async () => {
      const response: CopilotResponse = {
        completions: [{ text: 'test', confidence: 0.8 }],
        model: 'copilot-v1',
        tokenCount: 5,
      };

      await cacheManager.store('abcd1234', response, 'user1');
      await cacheManager.store('abcd1255', response, 'user1');
      await cacheManager.store('abcd9999', response, 'user1');

      // Search for 'abcd1256' - closest is 'abcd1255' (distance 1, 87.5%) vs 'abcd1234' (distance 2, 75%)
      const entry = await cacheManager.lookupSimilar('abcd1256', 85);

      expect(entry).not.toBeNull();
      expect(entry?.contextHash).toBe('abcd1255');
    });
  });

  describe('getStatistics', () => {
    it('should return statistics for empty cache', () => {
      const stats = cacheManager.getStatistics();

      expect(stats.size).toBe(0);
      expect(stats.maxSize).toBe(10000);
      expect(stats.hitRate).toBe(0);
      expect(stats.averageEntrySize).toBe(0);
    });

    it('should return statistics with cache entries', async () => {
      const response: CopilotResponse = {
        completions: [{ text: 'test', confidence: 0.8 }],
        model: 'copilot-v1',
        tokenCount: 5,
      };

      await cacheManager.store('hash1', response, 'user1');
      await cacheManager.store('hash2', response, 'user1');

      const stats = cacheManager.getStatistics();

      expect(stats.size).toBe(2);
      expect(stats.maxSize).toBe(10000);
      expect(stats.averageEntrySize).toBeGreaterThan(0);
    });

    it('should calculate hit rate correctly', async () => {
      const response: CopilotResponse = {
        completions: [{ text: 'test', confidence: 0.8 }],
        model: 'copilot-v1',
        tokenCount: 5,
      };

      await cacheManager.store('hash1', response, 'user1');

      // 2 hits
      await cacheManager.lookupExact('hash1');
      await cacheManager.lookupExact('hash1');

      // 3 misses
      await cacheManager.lookupExact('nonexistent1');
      await cacheManager.lookupExact('nonexistent2');
      await cacheManager.lookupExact('nonexistent3');

      const stats = cacheManager.getStatistics();

      // Hit rate = 2 / (2 + 3) = 40%
      expect(stats.hitRate).toBeCloseTo(40, 1);
    });
  });

  describe('encryption at rest', () => {
    it('should encrypt and decrypt cache entries', async () => {
      const encryptedCache = new CacheManager(100, 24, 'test-secret-key');
      const response: CopilotResponse = { completions: [{ text: 'encrypted data', confidence: 0.9 }], model: 'test', tokenCount: 10 };
      await encryptedCache.store('hash1', response, 'user1');
      const entry = await encryptedCache.lookupExact('hash1');
      expect(entry).not.toBeNull();
      const responseData = JSON.parse(entry!.response.data.toString('utf8')) as CopilotResponse;
      expect(responseData.completions[0].text).toBe('encrypted data');
    });
  });

  describe('compression disabled', () => {
    it('should store without compression', async () => {
      const noCompressCache = new CacheManager(100, 24, undefined, false);
      const response: CopilotResponse = { completions: [{ text: 'no compression', confidence: 0.9 }], model: 'test', tokenCount: 10 };
      await noCompressCache.store('hash1', response, 'user1');
      const entry = await noCompressCache.lookupExact('hash1');
      expect(entry).not.toBeNull();
      const responseData = JSON.parse(entry!.response.data.toString('utf8')) as CopilotResponse;
      expect(responseData.completions[0].text).toBe('no compression');
    });
  });
});
