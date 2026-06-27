import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TokenAnalyzer } from '../../src/components/TokenAnalyzer.js';
import type { Completion } from '../../src/types/copilot.js';

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

  beforeEach(() => {
    analyzer = new TokenAnalyzer();
  });

  afterEach(() => {
    analyzer.destroy();
  });

  const makeCompletion = (text: string): Completion => ({ text, confidence: 0.95 });
  const completions = (texts: string[]): Completion[] => texts.map(makeCompletion);

  describe('countRequestTokens', () => {
    it('should return 0 for empty prompt', () => {
      expect(analyzer.countRequestTokens('')).toBe(0);
    });

    it('should return positive count for normal prompt', () => {
      const count = analyzer.countRequestTokens('function add(a, b) { return a + b; }');
      expect(count).toBeGreaterThan(0);
    });

    it('should return larger count for longer prompt', () => {
      const short = analyzer.countRequestTokens('short');
      const long = analyzer.countRequestTokens('a '.repeat(100));
      expect(long).toBeGreaterThan(short);
    });
  });

  describe('countResponseTokens', () => {
    it('should return 0 for empty completions array', () => {
      expect(analyzer.countResponseTokens([])).toBe(0);
    });

    it('should count tokens across all completions', () => {
      const result = analyzer.countResponseTokens(completions(['hello world', 'foo bar baz']));
      expect(result).toBeGreaterThan(0);
    });

    it('should return larger count for longer completions', () => {
      const short = analyzer.countResponseTokens(completions(['a']));
      const long = analyzer.countResponseTokens(completions(['a '.repeat(50)]));
      expect(long).toBeGreaterThan(short);
    });
  });

  describe('calculateSavings', () => {
    it('should return sum of request and response tokens', () => {
      expect(analyzer.calculateSavings(10, 20)).toBe(30);
    });

    it('should accumulate into cumulative savings', () => {
      analyzer.calculateSavings(10, 20);
      analyzer.calculateSavings(5, 5);
      expect(analyzer.getCumulativeSavings()).toBe(40);
    });
  });

  describe('getCumulativeSavings', () => {
    it('should return 0 when no savings recorded', () => {
      expect(analyzer.getCumulativeSavings()).toBe(0);
    });
  });

  describe('recordConsumption', () => {
    it('should track consumption for a user', () => {
      analyzer.recordConsumption('user1', 50, false);
      const stats = analyzer.getConsumptionStats('user1');
      expect(stats?.tokensConsumed).toBe(50);
    });

    it('should increment consumption on subsequent calls', () => {
      analyzer.recordConsumption('user1', 30, false);
      analyzer.recordConsumption('user1', 20, false);
      const stats = analyzer.getConsumptionStats('user1');
      expect(stats?.tokensConsumed).toBe(50);
    });

    it('should track cache tokens separately', () => {
      analyzer.recordConsumption('user1', 100, true);
      const stats = analyzer.getConsumptionStats('user1');
      expect(stats?.tokensConsumed).toBe(0);
      expect(stats?.tokensFromCache).toBe(100);
      expect(stats?.tokensSaved).toBe(100);
    });

    it('should track multiple users independently', () => {
      analyzer.recordConsumption('user1', 10, false);
      analyzer.recordConsumption('user2', 20, false);
      expect(analyzer.getConsumptionStats('user1')?.tokensConsumed).toBe(10);
      expect(analyzer.getConsumptionStats('user2')?.tokensConsumed).toBe(20);
    });
  });

  describe('recordConsumption with warningThresholdPercent', () => {
    it('should warn when approaching budget at configured threshold', () => {
      const warnLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
      const a = new TokenAnalyzer(100, 50, warnLogger);
      a.recordConsumption('user1', 60, false);
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
      const a = new TokenAnalyzer(100, 80, warnLogger);
      a.recordConsumption('user1', 70, false);
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
      const a = new TokenAnalyzer(100);
      a.recordConsumption('user1', 30, false);
      const budget = a.checkBudget('user1');
      expect(budget.withinBudget).toBe(true);
      expect(budget.remaining).toBe(70);
    });

    it('should return not withinBudget when consumption exceeds limit', () => {
      const a = new TokenAnalyzer(50);
      a.recordConsumption('user1', 60, false);
      const budget = a.checkBudget('user1');
      expect(budget.withinBudget).toBe(false);
      expect(budget.remaining).toBe(0);
    });

    it('should return not withinBudget when consumption exactly equals limit', () => {
      const a = new TokenAnalyzer(100);
      a.recordConsumption('user1', 100, false);
      const budget = a.checkBudget('user1');
      expect(budget.withinBudget).toBe(false);
    });

    it('should return full budget for unknown user', () => {
      const a = new TokenAnalyzer(100);
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
      analyzer.recordConsumption('user1', 10, false);
      const stats = analyzer.getConsumptionStats('user1');
      expect(stats?.tokensConsumed).toBe(10);
    });
  });

  describe('destroy', () => {
    it('should clear timers and reset state', () => {
      analyzer.recordConsumption('user1', 50, false);
      analyzer.calculateSavings(10, 10);
      analyzer.destroy();
      expect(analyzer.getConsumptionStats('user1')).toBeUndefined();
      expect(analyzer.getCumulativeSavings()).toBe(0);
    });
  });

  describe('reset', () => {
    it('should clear all consumption and savings data', () => {
      analyzer.recordConsumption('user1', 50, false);
      analyzer.calculateSavings(10, 10);
      analyzer.reset();
      expect(analyzer.getConsumptionStats('user1')).toBeUndefined();
      expect(analyzer.getCumulativeSavings()).toBe(0);
    });
  });
});
