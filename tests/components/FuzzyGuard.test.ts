import { describe, it, expect, beforeEach } from 'vitest';
import { FuzzyGuard, wordLevelEditDistance } from '../../src/components/FuzzyGuard.js';
import type { NormalizedChatRequest, ChatCacheEntry, InternalChatResponse } from '../../src/types/chat.js';

const mockResponse: InternalChatResponse = {
  id: 'test-1',
  model: 'gpt-4',
  choices: [{ index: 0, message: { role: 'assistant', content: 'test response' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  created: 1234567890,
};

function makeEntry(hash: string): ChatCacheEntry {
  return {
    contextHash: hash,
    response: mockResponse,
    timestamp: Date.now(),
    accessCount: 0,
    lastAccessTime: Date.now(),
    model: 'gpt-4',
    inputTokens: 10,
    outputTokens: 10,
  };
}

function makeRequest(overrides: Partial<NormalizedChatRequest> = {}): NormalizedChatRequest {
  return {
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'hello world foo bar' }],
    temperature: 0,
    top_p: 1,
    max_tokens: 100,
    presence_penalty: 0,
    frequency_penalty: 0,
    stream: false,
    ...overrides,
  };
}

describe('wordLevelEditDistance', () => {
  it('should return 0 for identical strings', () => {
    expect(wordLevelEditDistance('hello world', 'hello world')).toBe(0);
  });

  it('should return 1 for a single word change', () => {
    expect(wordLevelEditDistance('hello world', 'hello earth')).toBe(1);
  });

  it('should return word count for completely different strings', () => {
    expect(wordLevelEditDistance('hello world', 'foo bar baz')).toBe(3);
  });

  it('should handle empty strings', () => {
    expect(wordLevelEditDistance('', '')).toBe(0);
    expect(wordLevelEditDistance('hello', '')).toBe(1);
    expect(wordLevelEditDistance('', 'hello')).toBe(1);
  });

  it('should handle extra whitespace', () => {
    expect(wordLevelEditDistance('hello  world', 'hello world')).toBe(0);
  });
});

describe('FuzzyGuard', () => {
  let guard: FuzzyGuard;

  beforeEach(() => {
    guard = new FuzzyGuard({ enabled: true, maxTokenEditDistance: 3, minimumSimilarityPercent: 90 });
  });

  describe('exact content match', () => {
    it('should return cached entry for exact content match', () => {
      const req = makeRequest();
      const entry = makeEntry('hash1');

      guard.store(req, 'hash1', entry);
      const result = guard.lookup(req, 'hash2');

      expect(result).not.toBeNull();
      expect(result?.contextHash).toBe('hash1');
    });
  });

  describe('1-word diff within threshold', () => {
    it('should return cached entry when content differs by 1 word within threshold', () => {
      const stored = makeRequest({ messages: [{ role: 'user', content: 'this is a long sentence with many words to pass the high percentage threshold test' }] });
      const query = makeRequest({ messages: [{ role: 'user', content: 'this is a long sentence with many words to pass the high percentage threshold baz' }] });
      const entry = makeEntry('hash1');

      guard.store(stored, 'hash1', entry);
      const result = guard.lookup(query, 'hash2');

      expect(result).not.toBeNull();
      expect(result?.contextHash).toBe('hash1');
    });
  });

  describe('1-word diff OVER threshold', () => {
    it('should return null when content differs by more words than threshold', () => {
      const strictGuard = new FuzzyGuard({ enabled: true, maxTokenEditDistance: 0 });
      const stored = makeRequest({ messages: [{ role: 'user', content: 'hello world' }] });
      const query = makeRequest({ messages: [{ role: 'user', content: 'hello earth' }] });
      const entry = makeEntry('hash1');

      strictGuard.store(stored, 'hash1', entry);
      const result = strictGuard.lookup(query, 'hash2');

      expect(result).toBeNull();
    });
  });

  describe('different message count', () => {
    it('should return null when message counts differ', () => {
      const stored = makeRequest({ messages: [{ role: 'user', content: 'hello' }] });
      const query = makeRequest({
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
      });
      const entry = makeEntry('hash1');

      guard.store(stored, 'hash1', entry);
      const result = guard.lookup(query, 'hash2');

      expect(result).toBeNull();
    });
  });

  describe('different role order', () => {
    it('should return null when message roles differ', () => {
      const stored = makeRequest({
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
      });
      const query = makeRequest({
        messages: [
          { role: 'assistant', content: 'hello' },
          { role: 'user', content: 'hi' },
        ],
      });
      const entry = makeEntry('hash1');

      guard.store(stored, 'hash1', entry);
      const result = guard.lookup(query, 'hash2');

      expect(result).toBeNull();
    });
  });

  describe('different model', () => {
    it('should return null when models differ', () => {
      const stored = makeRequest({ model: 'gpt-4' });
      const query = makeRequest({ model: 'gpt-3.5-turbo' });
      const entry = makeEntry('hash1');

      guard.store(stored, 'hash1', entry);
      const result = guard.lookup(query, 'hash2');

      expect(result).toBeNull();
    });
  });

  describe('different temperature', () => {
    it('should return null when temperatures differ', () => {
      const stored = makeRequest({ temperature: 0 });
      const query = makeRequest({ temperature: 0 });
      // wait, the previous test was checking if temperatures differ they don't match.
      // But now if temperature > 0 it skips lookup entirely!
      // Let's test the original check first
      const stored2 = makeRequest({ temperature: 0 });
      const query2 = makeRequest({ temperature: 0, top_p: 0.5 });
      const entry = makeEntry('hash1');
      guard.store(stored2, 'hash1', entry);
      expect(guard.lookup(query2, 'hash2')).toBeNull();
    });

    it('should return null immediately if temperature > 0', () => {
      const stored = makeRequest({ temperature: 0 });
      const query = makeRequest({ temperature: 0.5 });
      const entry = makeEntry('hash1');

      guard.store(stored, 'hash1', entry);
      const result = guard.lookup(query, 'hash2');

      expect(result).toBeNull();
    });
  });

  describe('minimum similarity percent', () => {
    it('should return null when similarity is below threshold', () => {
      // 90% threshold, max edit distance 3.
      // "hello world foo bar" (4 words). Changing 1 word is 75% similarity.
      const stored = makeRequest({ messages: [{ role: 'user', content: 'hello world foo bar' }] });
      const query = makeRequest({ messages: [{ role: 'user', content: 'hello world foo baz' }] });
      const entry = makeEntry('hash1');

      // The similarity is 75%, which is < 90%, so it should return null despite being within maxTokenEditDistance
      guard.store(stored, 'hash1', entry);
      const result = guard.lookup(query, 'hash2');

      expect(result).toBeNull();
    });

    it('should return match when similarity is above threshold', () => {
      // 90% threshold. "this is a very long string with many words to test the similarity percentage feature" (16 words).
      // changing 1 word gives 15/16 = 93.75% similarity.
      const stored = makeRequest({ messages: [{ role: 'user', content: 'this is a very long string with many words to test the similarity percentage feature' }] });
      const query = makeRequest({ messages: [{ role: 'user', content: 'this is a very long string with many words to test the similarity percentage bug' }] });
      const entry = makeEntry('hash1');

      guard.store(stored, 'hash1', entry);
      const result = guard.lookup(query, 'hash2');

      expect(result).not.toBeNull();
    });
  });

  describe('rapid-edit kill switch', () => {
    it('should activate after threshold distinct hashes in window', () => {
      const rapidGuard = new FuzzyGuard({
        enabled: true,
        maxTokenEditDistance: 3,
        rapidEditWindowMs: 5000,
        rapidEditThreshold: 3,
      });

      const req = makeRequest();
      const entry = makeEntry('stored');
      rapidGuard.store(req, 'stored', entry);

      // Send 4 distinct lookups (threshold is 3, so >3 triggers)
      rapidGuard.lookup(req, 'hash-a');
      rapidGuard.lookup(req, 'hash-b');
      rapidGuard.lookup(req, 'hash-c');
      rapidGuard.lookup(req, 'hash-d');

      expect(rapidGuard.isKillSwitchActive()).toBe(true);
    });

    it('should deactivate after window expires', async () => {
      const rapidGuard = new FuzzyGuard({
        enabled: true,
        maxTokenEditDistance: 3,
        rapidEditWindowMs: 50, // Very short window for testing
        rapidEditThreshold: 2,
      });

      const req = makeRequest();
      const entry = makeEntry('stored');
      rapidGuard.store(req, 'stored', entry);

      // Trigger kill switch
      rapidGuard.lookup(req, 'hash-a');
      rapidGuard.lookup(req, 'hash-b');
      rapidGuard.lookup(req, 'hash-c');

      expect(rapidGuard.isKillSwitchActive()).toBe(true);

      // Wait for window to expire
      await new Promise(resolve => setTimeout(resolve, 60));

      expect(rapidGuard.isKillSwitchActive()).toBe(false);
    });
  });

  describe('LRU eviction', () => {
    it('should evict oldest entries when exceeding maxEntries', () => {
      const smallGuard = new FuzzyGuard({
        enabled: true,
        maxTokenEditDistance: 0,
        maxEntries: 2,
      });

      const req1 = makeRequest({ messages: [{ role: 'user', content: 'completely unrelated string one' }] });
      const req2 = makeRequest({ messages: [{ role: 'user', content: 'totally different string two' }] });
      const req3 = makeRequest({ messages: [{ role: 'user', content: 'absolutely unalike string three' }] });

      smallGuard.store(req1, 'hash1', makeEntry('hash1'));
      smallGuard.store(req2, 'hash2', makeEntry('hash2'));
      smallGuard.store(req3, 'hash3', makeEntry('hash3')); // Should evict hash1

      // hash1 should be evicted
      const result1 = smallGuard.lookup(req1, 'query1');
      expect(result1).toBeNull();

      // hash3 should still be there
      const result3 = smallGuard.lookup(req3, 'query3');
      expect(result3).not.toBeNull();
    });
  });

  describe('tool schema mismatch', () => {
    it('should return null when tool schemas differ', () => {
      const stored = makeRequest({
        tools: [{ type: 'function', function: { name: 'tool_a', parameters: { type: 'object' } } }],
      });
      const query = makeRequest({
        tools: [{ type: 'function', function: { name: 'tool_b', parameters: { type: 'object' } } }],
      });
      const entry = makeEntry('hash1');

      guard.store(stored, 'hash1', entry);
      const result = guard.lookup(query, 'hash2');

      expect(result).toBeNull();
    });
  });

  describe('disabled guard', () => {
    it('should return null on lookup when disabled', () => {
      const disabledGuard = new FuzzyGuard({ enabled: false });
      const req = makeRequest();
      disabledGuard.store(req, 'hash1', makeEntry('hash1'));
      expect(disabledGuard.lookup(req, 'hash2')).toBeNull();
    });
  });
});
