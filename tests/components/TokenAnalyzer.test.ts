import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TokenAnalyzer } from '../../src/components/TokenAnalyzer.js';
import type { InternalChatRequest, InternalChatResponse } from '../../src/types/chat.js';
import type { ModelsConfig } from '../../src/types/config.js';

vi.mock('tiktoken', () => {
  return {
    Tiktoken: vi.fn().mockImplementation(() => ({
      encode: vi.fn((text: string) => {
        const words = text.split(/\s+/).filter(Boolean);
        const tokens: number[] = [];
        for (let i = 0; i < words.length; i++) {
          tokens.push(i);
        }
        return tokens;
      }),
    })),
  };
});

describe('TokenAnalyzer', () => {
  let analyzer: TokenAnalyzer;
  const mockModelsConfig: ModelsConfig = {
    creditMultipliers: {
      'test-model': { input: 1, output: 2 },
      'cheap-model': { input: 0.5, output: 1 },
    }
  };

  beforeEach(() => {
    analyzer = new TokenAnalyzer(mockModelsConfig);
  });

  afterEach(() => {
    analyzer.destroy();
  });

  const makeChatRequest = (content: string): InternalChatRequest => ({
    model: 'test-model',
    messages: [{ role: 'user', content }],
    stream: false,
  });

  const makeChatResponse = (content: string, completion_tokens?: number): InternalChatResponse => ({
    id: 'res-1',
    model: 'test-model',
    created: Date.now(),
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: completion_tokens !== undefined ? { prompt_tokens: 0, completion_tokens, total_tokens: completion_tokens } : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });

  describe('calculateCredits', () => {
    it('should calculate credits based on multipliers', () => {
      // test-model: input 1, output 2 per 1M tokens
      // 1,000,000 input tokens = 1 credit
      // 1,000,000 output tokens = 2 credits
      const credits = analyzer.calculateCredits('test-model', 1_000_000, 500_000);
      expect(credits).toBe(1 + 1); // 2 credits
    });

    it('should fallback to 1:1 ratio if model not found', () => {
      const credits = analyzer.calculateCredits('unknown-model', 500_000, 500_000);
      expect(credits).toBe(0.5 + 0.5); // 1 credit
    });
  });

  describe('countRequestTokens', () => {
    it('should return base count for empty prompt', () => {
      expect(analyzer.countRequestTokens(makeChatRequest(''))).toBeGreaterThan(0);
    });

    it('should return larger count for longer prompt', () => {
      const short = analyzer.countRequestTokens(makeChatRequest('short'));
      const long = analyzer.countRequestTokens(makeChatRequest('a '.repeat(100)));
      expect(long).toBeGreaterThan(short);
    });
  });

  describe('countResponseTokens', () => {
    it('should return count based on usage if provided', () => {
      const res = makeChatResponse('hello world', 42);
      expect(analyzer.countResponseTokens(res)).toBe(42);
    });

    it('should calculate tokens if usage not provided', () => {
      // our makeChatResponse usage defaults to 0 completion_tokens if not provided?
      // actually, let's omit usage or set to undefined (or just provide no completion_tokens)
      const res = makeChatResponse('hello world');
      delete (res.usage as any).completion_tokens;
      const result = analyzer.countResponseTokens(res);
      expect(result).toBeGreaterThan(0);
    });

    it('should return larger count for longer completions', () => {
      const resShort = makeChatResponse('a');
      delete (resShort.usage as any).completion_tokens;
      const resLong = makeChatResponse('a '.repeat(50));
      delete (resLong.usage as any).completion_tokens;
      
      const short = analyzer.countResponseTokens(resShort);
      const long = analyzer.countResponseTokens(resLong);
      expect(long).toBeGreaterThan(short);
    });
  });

  describe('calculateSavings', () => {
    it('should return calculated credits for savings', () => {
      // test-model: 1,000,000 input = 1 credit, 1,000,000 output = 2 credits
      const savings = analyzer.calculateSavings('test-model', 1_000_000, 500_000);
      expect(savings).toBe(2);
    });

    it('should accumulate into cumulative savings', () => {
      analyzer.calculateSavings('test-model', 1_000_000, 0); // 1 credit
      analyzer.calculateSavings('test-model', 0, 500_000);   // 1 credit
      expect(analyzer.getCumulativeSavings()).toBe(2);
    });
  });

  describe('getCumulativeSavings', () => {
    it('should return 0 when no savings recorded', () => {
      expect(analyzer.getCumulativeSavings()).toBe(0);
    });
  });

  describe('recordConsumption', () => {
    it('should track consumption for a user', () => {
      analyzer.recordConsumption('user1', 'test-model', 1_000_000, 500_000, false);
      const stats = analyzer.getConsumptionStats('user1');
      expect(stats?.creditsConsumed).toBe(2);
    });

    it('should increment consumption on subsequent calls', () => {
      analyzer.recordConsumption('user1', 'test-model', 1_000_000, 0, false);
      analyzer.recordConsumption('user1', 'test-model', 0, 500_000, false);
      const stats = analyzer.getConsumptionStats('user1');
      expect(stats?.creditsConsumed).toBe(2);
    });

    it('should track cache tokens separately', () => {
      analyzer.recordConsumption('user1', 'test-model', 1_000_000, 500_000, true);
      const stats = analyzer.getConsumptionStats('user1');
      expect(stats?.creditsConsumed).toBe(0);
      expect(stats?.creditsFromCache).toBe(2);
      expect(stats?.creditsSaved).toBe(2);
    });

    it('should track multiple users independently', () => {
      analyzer.recordConsumption('user1', 'test-model', 1_000_000, 0, false);
      analyzer.recordConsumption('user2', 'test-model', 2_000_000, 0, false);
      expect(analyzer.getConsumptionStats('user1')?.creditsConsumed).toBe(1);
      expect(analyzer.getConsumptionStats('user2')?.creditsConsumed).toBe(2);
    });
  });

  describe('recordConsumption with warningThresholdPercent', () => {
    it('should warn when approaching budget at configured threshold', () => {
      const warnLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
      const a = new TokenAnalyzer(mockModelsConfig, 100, 50, warnLogger as any);
      // Consume 60 credits (1_000_000 input = 1 credit, so 60_000_000 input = 60 credits)
      a.recordConsumption('user1', 'test-model', 60_000_000, 0, false);
      expect(warnLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          consumed: 60,
          limit: 100,
          message: expect.stringContaining('50% threshold'),
        }),
      );
    });

    it('should not warn before configured threshold', () => {
      const warnLogger = { warn: vi.fn() };
      const a = new TokenAnalyzer(mockModelsConfig, 100, 80, warnLogger as any);
      a.recordConsumption('user1', 'test-model', 70_000_000, 0, false);
      expect(warnLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe('checkBudget', () => {
    it('should return withinBudget when no limit is set', () => {
      const budget = analyzer.checkBudget('user1');
      expect(budget.withinBudget).toBe(true);
      expect(budget.limit).toBeUndefined();
      expect(budget.consumed).toBe(0);
    });

    it('should return withinBudget when consumption is under limit', () => {
      const a = new TokenAnalyzer(mockModelsConfig, 100);
      a.recordConsumption('user1', 'test-model', 30_000_000, 0, false);
      const budget = a.checkBudget('user1');
      expect(budget.withinBudget).toBe(true);
      expect(budget.remaining).toBe(70);
    });

    it('should return not withinBudget when consumption exceeds limit', () => {
      const a = new TokenAnalyzer(mockModelsConfig, 50);
      a.recordConsumption('user1', 'test-model', 60_000_000, 0, false);
      const budget = a.checkBudget('user1');
      expect(budget.withinBudget).toBe(false);
      expect(budget.remaining).toBe(0);
    });

    it('should return not withinBudget when consumption exactly equals limit', () => {
      const a = new TokenAnalyzer(mockModelsConfig, 100);
      a.recordConsumption('user1', 'test-model', 100_000_000, 0, false);
      const budget = a.checkBudget('user1');
      expect(budget.withinBudget).toBe(false);
    });

    it('should return full budget for unknown user', () => {
      const a = new TokenAnalyzer(mockModelsConfig, 100);
      const budget = a.checkBudget('nonexistent');
      expect(budget.withinBudget).toBe(true);
      expect(budget.consumed).toBe(0);
    });
  });

  describe('getConsumptionStats', () => {
    it('should return undefined for unknown user', () => {
      expect(analyzer.getConsumptionStats('unknown')).toBeUndefined();
    });

    it('should return a copy of the consumption data', () => {
      analyzer.recordConsumption('user1', 'test-model', 10_000_000, 0, false);
      const stats = analyzer.getConsumptionStats('user1');
      expect(stats?.creditsConsumed).toBe(10);
    });
  });

  describe('destroy', () => {
    it('should clear timers and reset state', () => {
      analyzer.recordConsumption('user1', 'test-model', 50_000_000, 0, false);
      analyzer.calculateSavings('test-model', 10_000_000, 10_000_000);
      analyzer.destroy();
      expect(analyzer.getConsumptionStats('user1')).toBeUndefined();
      expect(analyzer.getCumulativeSavings()).toBe(0);
    });
  });

  describe('reset', () => {
    it('should clear all consumption and savings data', () => {
      analyzer.recordConsumption('user1', 'test-model', 50_000_000, 0, false);
      analyzer.calculateSavings('test-model', 10_000_000, 10_000_000);
      analyzer.reset();
      expect(analyzer.getConsumptionStats('user1')).toBeUndefined();
      expect(analyzer.getCumulativeSavings()).toBe(0);
    });
  });
});
