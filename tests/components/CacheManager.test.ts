import { describe, it, expect, beforeEach } from 'vitest';
import { CacheManager } from '../../src/components/CacheManager.js';
import { ChatCacheEntry, InternalChatResponse, NormalizedChatRequest } from '../../src/types/chat.js';

describe('CacheManager', () => {
  let cacheManager: CacheManager;

  const mockResponse: InternalChatResponse = {
    id: 'test-1',
    model: 'gpt-4',
    choices: [{ index: 0, message: { role: 'assistant', content: 'test response' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    created: 1234567890
  };

  const createMockEntry = (hash: string): ChatCacheEntry => ({
    contextHash: hash,
    response: mockResponse,
    timestamp: Date.now(),
    accessCount: 0,
    lastAccessTime: Date.now(),
    model: 'gpt-4',
    inputTokens: 10,
    outputTokens: 10
  });

  beforeEach(() => {
    // maxEntries=10000, ttl=24
    cacheManager = new CacheManager(10000, 24);
  });

  describe('shouldBypassCache', () => {
    it('should return true if temperature > 0', () => {
      const req: NormalizedChatRequest = {
        model: 'gpt-4',
        messages: [],
        temperature: 0.5,
        top_p: 1,
        max_tokens: 100,
        presence_penalty: 0,
        frequency_penalty: 0,
        stream: false
      };
      expect(cacheManager.shouldBypassCache(req)).toBe(true);
    });

    it('should return true if tools are present', () => {
      const req: NormalizedChatRequest = {
        model: 'gpt-4',
        messages: [],
        temperature: 0,
        top_p: 1,
        max_tokens: 100,
        presence_penalty: 0,
        frequency_penalty: 0,
        stream: false,
        tools: [{ type: 'function', function: { name: 'test' } }]
      };
      expect(cacheManager.shouldBypassCache(req)).toBe(true);
    });

    it('should return false if temperature is 0 and no tools', () => {
      const req: NormalizedChatRequest = {
        model: 'gpt-4',
        messages: [],
        temperature: 0,
        top_p: 1,
        max_tokens: 100,
        presence_penalty: 0,
        frequency_penalty: 0,
        stream: false
      };
      expect(cacheManager.shouldBypassCache(req)).toBe(false);
    });
  });

  describe('store and lookupExact', () => {
    it('should store and lookup an exact match', async () => {
      const entry = createMockEntry('hash1');
      await cacheManager.store('hash1', entry);

      const found = await cacheManager.lookupExact('hash1');
      expect(found).not.toBeNull();
      expect(found?.contextHash).toBe('hash1');
      expect(found?.accessCount).toBe(1);
    });

    it('should return null for non-existent exact match', async () => {
      const found = await cacheManager.lookupExact('nonexistent');
      expect(found).toBeNull();
    });

    it('should return null for expired exact match', async () => {
      const shortTTLCache = new CacheManager(10000, 1 / (60 * 60 * 1000)); // 1ms TTL
      const entry = createMockEntry('hash1');
      await shortTTLCache.store('hash1', entry);
      
      await new Promise(resolve => setTimeout(resolve, 10));

      const found = await shortTTLCache.lookupExact('hash1');
      expect(found).toBeNull();
    });
  });

  describe('storePrefix and lookupPrefix', () => {
    it('should store and lookup a prefix match', async () => {
      const entry = createMockEntry('prefix1');
      await cacheManager.storePrefix('prefix1', entry);

      const found = await cacheManager.lookupPrefix('prefix1');
      expect(found).not.toBeNull();
      expect(found?.contextHash).toBe('prefix1');
    });

    it('should return null for non-existent prefix match', async () => {
      const found = await cacheManager.lookupPrefix('nonexistent');
      expect(found).toBeNull();
    });
  });

  describe('eviction', () => {
    it('should evict least recently used entries when reaching capacity', async () => {
      const smallCache = new CacheManager(2); // max 2 entries
      
      await smallCache.store('hash1', createMockEntry('hash1'));
      await smallCache.storePrefix('prefix1', createMockEntry('prefix1'));
      
      // Access hash1 to make prefix1 the LRU
      await smallCache.lookupExact('hash1');

      // Add a third entry to trigger eviction
      await smallCache.store('hash2', createMockEntry('hash2'));

      expect(await smallCache.lookupExact('hash1')).not.toBeNull();
      expect(await smallCache.lookupExact('hash2')).not.toBeNull();
      expect(await smallCache.lookupPrefix('prefix1')).toBeNull(); // Evicted
    });
  });

  describe('invalidate', () => {
    it('should clear all cache entries', async () => {
      await cacheManager.store('hash1', createMockEntry('hash1'));
      await cacheManager.storePrefix('prefix1', createMockEntry('prefix1'));

      const invalidated = await cacheManager.invalidate();
      expect(invalidated).toBe(2);

      expect(await cacheManager.lookupExact('hash1')).toBeNull();
      expect(await cacheManager.lookupPrefix('prefix1')).toBeNull();
    });
  });



  describe('statistics', () => {
    it('should correctly report stats', async () => {
      await cacheManager.store('hash1', createMockEntry('hash1'));
      await cacheManager.lookupExact('hash1'); // hit
      await cacheManager.lookupExact('nonexistent'); // miss

      const stats = cacheManager.getStatistics();
      expect(stats.size).toBe(1);
      expect(stats.maxSize).toBe(10000);
      expect(stats.hitRate).toBe(50);
    });
  });
});
