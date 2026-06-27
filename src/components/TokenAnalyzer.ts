/**
 * TokenAnalyzer - Token counting and budget tracking component.
 * 
 * This component is responsible for:
 * - Counting tokens in request prompts and response completions
 * - Tracking token consumption per user per day
 * - Enforcing token budget limits
 * - Calculating token savings from cache hits
 * 
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 8.1, 8.2, 8.3, 8.4, 8.5
 */

import type { InternalChatRequest, InternalChatResponse } from '../types/chat.js';
import type { ModelsConfig } from '../types/config.js';
import { Tiktoken } from 'tiktoken';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const cl100k_base: any = _require('tiktoken/encoders/cl100k_base.json');
import { createChildLogger } from '../utils/logger.js';

const PERFORMANCE_TARGET_MS = 5;
const TOKEN_APPROXIMATION_RATIO = 4;

let _tokenizer: Tiktoken | null = null;

try {
  _tokenizer = new Tiktoken(cl100k_base.bpe_ranks, cl100k_base.special_tokens, cl100k_base.pat_str);
} catch {
  // Fallback to length/4 approximation if tiktoken initialization fails
}

/**
 * Status of a user's credit budget for the current day.
 */
export interface BudgetStatus {
  /** Number of credits consumed by the user today */
  consumed: number;
  
  /** Daily credit limit for the user (undefined if no limit) */
  limit: number | undefined;
  
  /** Number of credits remaining in the budget */
  remaining: number;
  
  /** Percentage of budget consumed (0-100) */
  percentUsed: number;
  
  /** Whether the user is within their credit budget */
  withinBudget: boolean;
}

/**
 * Daily credit consumption tracking for a user.
 */
interface DailyConsumption {
  /** ISO date string (YYYY-MM-DD) */
  date: string;
  
  /** Credits consumed from API calls */
  creditsConsumed: number;
  
  /** Credits served from cache */
  creditsFromCache: number;
  
  /** Total credits saved by caching */
  creditsSaved: number;
  
  /** Timestamp of first request today */
  firstRequest: number;
  
  /** Timestamp of most recent request */
  lastRequest: number;
}

/**
 * TokenAnalyzer component for token counting and budget tracking.
 * 
 * Note: This implementation uses a simple approximation for token counting.
 * For production use, integrate the tiktoken library with cl100k_base encoding
 * to match GitHub Copilot's exact tokenization.
 */
export class TokenAnalyzer {
  /** Map of userId to daily consumption data */
  private consumptionMap: Map<string, DailyConsumption> = new Map();
  
  /** Cumulative credit savings since service start */
  private cumulativeSavings: number = 0;
  
  /** Optional credit budget per user per day */
  private budgetPerUserPerDay: number | undefined;
  
  /** Warning threshold percentage (0-100) */
  private warningThresholdPercent: number;
  
  /** Models configuration */
  private modelsConfig: ModelsConfig;
  
  /** Logger instance for this component */
  private logger: ReturnType<typeof createChildLogger> | undefined;
  private midnightTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  
  /**
   * Creates a new TokenAnalyzer instance.
   * 
   * @param modelsConfig - Models configuration for credit multipliers
   * @param budgetPerUserPerDay - Optional daily credit limit per user
   * @param warningThresholdPercent - Percentage at which to warn (default 90)
   * @param logger - Logger instance for logging events
   */
  constructor(modelsConfig: ModelsConfig, budgetPerUserPerDay?: number, warningThresholdPercent = 90, logger?: ReturnType<typeof createChildLogger>) {
    this.modelsConfig = modelsConfig;
    this.budgetPerUserPerDay = budgetPerUserPerDay;
    this.warningThresholdPercent = warningThresholdPercent;
    this.logger = logger;
    
    // Schedule midnight UTC cleanup
    this.scheduleMidnightCleanup();
  }
  
  /**
   * Calculate credits based on input and output tokens for a specific model.
   * 
   * @param model - The model name
   * @param inputTokens - Number of input tokens
   * @param outputTokens - Number of output tokens
   * @returns Number of credits
   */
  calculateCredits(model: string, inputTokens: number, outputTokens: number): number {
    const multipliers = this.modelsConfig.creditMultipliers[model] || { input: 1, output: 1 };
    return (inputTokens * multipliers.input / 1_000_000) + (outputTokens * multipliers.output / 1_000_000);
  }

  /**
   * Count tokens in a chat request using tiktoken cl100k_base encoding.
   * 
   * Performance target: < 5ms
   * 
   * @param req - The chat request
   * @returns Number of tokens
   */
  countRequestTokens(req: InternalChatRequest): number {
    const startTime = performance.now();
    
    let totalTokens = 0;
    const tokenizer = _tokenizer;
    
    for (const msg of req.messages) {
      totalTokens += 4; // overhead per message
      if (msg.content) {
        totalTokens += tokenizer ? tokenizer.encode(msg.content).length : Math.ceil(msg.content.length / TOKEN_APPROXIMATION_RATIO);
      }
      if (msg.name) {
        totalTokens += tokenizer ? tokenizer.encode(msg.name).length : Math.ceil(msg.name.length / TOKEN_APPROXIMATION_RATIO);
      }
    }
    totalTokens += 3; // general overhead
    
    const elapsed = performance.now() - startTime;
    if (elapsed > PERFORMANCE_TARGET_MS) {
      this.logger?.warn({
        component: 'TokenAnalyzer',
        method: 'countRequestTokens',
        elapsed,
        message: 'Token counting exceeded 5ms target'
      });
    }
    
    return totalTokens;
  }
  
  /**
   * Count tokens in a chat response using tiktoken cl100k_base encoding.
   * 
   * Performance target: < 5ms
   * 
   * @param res - The chat response
   * @returns Number of tokens across all completions
   */
  countResponseTokens(res: InternalChatResponse): number {
    const startTime = performance.now();
    
    let totalTokens = 0;
    
    if (res.usage && res.usage.completion_tokens !== undefined) {
      totalTokens = res.usage.completion_tokens;
    } else {
      const tokenizer = _tokenizer;
      for (const choice of res.choices) {
        const content = choice.message?.content;
        if (content) {
          totalTokens += tokenizer ? tokenizer.encode(content).length : Math.ceil(content.length / TOKEN_APPROXIMATION_RATIO);
        }
      }
    }
    
    const elapsed = performance.now() - startTime;
    if (elapsed > PERFORMANCE_TARGET_MS) {
      this.logger?.warn({
        component: 'TokenAnalyzer',
        method: 'countResponseTokens',
        elapsed,
        message: 'Token counting exceeded 5ms target'
      });
    }
    
    return totalTokens;
  }
  
  /**
   * Calculate credits saved by a cache hit.
   * 
   * Savings = input + output tokens converted to credits.
   * 
   * @param model - The model name
   * @param requestTokens - Number of input tokens
   * @param responseTokens - Number of output tokens
   * @returns Total credits saved
   */
  calculateSavings(model: string, requestTokens: number, responseTokens: number): number {
    const savings = this.calculateCredits(model, requestTokens, responseTokens);
    this.cumulativeSavings += savings;
    return savings;
  }
  
  /**
   * Get cumulative credit savings since service start.
   * 
   * @returns Total credits saved across all cache hits
   */
  getCumulativeSavings(): number {
    return this.cumulativeSavings;
  }
  
  /**
   * Record credit consumption for a user.
   * 
   * This tracks consumption per day and resets at midnight UTC.
   * 
   * @param userId - User identifier
   * @param model - The model name
   * @param inputTokens - Number of input tokens
   * @param outputTokens - Number of output tokens
   * @param fromCache - Whether this was served from cache
   */
  recordConsumption(userId: string, model: string, inputTokens: number, outputTokens: number, fromCache: boolean = false): void {
    const credits = this.calculateCredits(model, inputTokens, outputTokens);
    const today = this.getCurrentDateString();
    let consumption = this.consumptionMap.get(userId);
    
    // Create new daily record if needed or if day has changed
    if (!consumption || consumption.date !== today) {
      consumption = {
        date: today,
        creditsConsumed: 0,
        creditsFromCache: 0,
        creditsSaved: 0,
        firstRequest: Date.now(),
        lastRequest: Date.now()
      };
      this.consumptionMap.set(userId, consumption);
    }
    
    // Update consumption
    consumption.lastRequest = Date.now();
    if (fromCache) {
      consumption.creditsFromCache += credits;
      consumption.creditsSaved += credits;
    } else {
      consumption.creditsConsumed += credits;
    }
    
    // Check if user has reached the warning threshold
    if (this.budgetPerUserPerDay) {
      const percentUsed = (consumption.creditsConsumed / this.budgetPerUserPerDay) * 100;
      if (percentUsed >= this.warningThresholdPercent && percentUsed < 100) {
        this.logger?.warn({
          component: 'TokenAnalyzer',
          userId,
          consumed: consumption.creditsConsumed,
          limit: this.budgetPerUserPerDay,
          percentUsed: percentUsed.toFixed(2),
          message: `User approaching credit budget limit (${this.warningThresholdPercent}% threshold)`
        });
      }
    }
  }
  
  /**
   * Check if a user is within their credit budget.
   * 
   * @param userId - User identifier
   * @returns Budget status including consumption, limit, and remaining credits
   */
  checkBudget(userId: string): BudgetStatus {
    const today = this.getCurrentDateString();
    const consumption = this.consumptionMap.get(userId);
    
    // If no consumption record or it's from a previous day, user has full budget
    if (!consumption || consumption.date !== today) {
      return {
        consumed: 0,
        limit: this.budgetPerUserPerDay,
        remaining: this.budgetPerUserPerDay ?? Infinity,
        percentUsed: 0,
        withinBudget: true
      };
    }
    
    const consumed = consumption.creditsConsumed;
    const limit = this.budgetPerUserPerDay;
    
    // If no budget limit, always within budget
    if (!limit) {
      return {
        consumed,
        limit: undefined,
        remaining: Infinity,
        percentUsed: 0,
        withinBudget: true
      };
    }
    
    const remaining = Math.max(0, limit - consumed);
    const percentUsed = (consumed / limit) * 100;
    const withinBudget = consumed < limit;
    
    return {
      consumed,
      limit,
      remaining,
      percentUsed,
      withinBudget
    };
  }
  
  /**
   * Get the current date as an ISO string (YYYY-MM-DD) in UTC.
   * 
   * @returns ISO date string
   */
  private getCurrentDateString(): string {
    const now = new Date();
    return now.toISOString().split('T')[0];
  }
  
  /**
   * Schedule daily cleanup at midnight UTC.
   * 
   * This removes consumption records from previous days to prevent
   * unbounded memory growth.
   */
  private scheduleMidnightCleanup(): void {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    
    const msUntilMidnight = tomorrow.getTime() - now.getTime();
    
    this.midnightTimer = setTimeout(() => {
      this.cleanupOldRecords();
      
      this.cleanupInterval = setInterval(() => {
        this.cleanupOldRecords();
      }, 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
  }
  
  /**
   * Remove consumption records that are not from today.
   * 
   * This cleanup runs daily at midnight UTC to prevent memory bloat.
   */
  private cleanupOldRecords(): void {
    const today = this.getCurrentDateString();
    let removedCount = 0;
    
    for (const [userId, consumption] of this.consumptionMap.entries()) {
      if (consumption.date !== today) {
        this.consumptionMap.delete(userId);
        removedCount++;
      }
    }
    
    if (removedCount > 0) {
      this.logger?.info({
        component: 'TokenAnalyzer',
        removedCount,
        message: 'Cleaned up old consumption records at midnight UTC'
      });
    }
  }
  
  /**
   * Get consumption statistics for a user.
   * 
   * @param userId - User identifier
   * @returns Daily consumption data or undefined if no data exists
   */
  getConsumptionStats(userId: string): DailyConsumption | undefined {
    const consumption = this.consumptionMap.get(userId);
    if (!consumption) {
      return undefined;
    }
    
    const today = this.getCurrentDateString();
    if (consumption.date !== today) {
      return undefined;
    }
    
    // Return a copy to prevent external modification
    return { ...consumption };
  }
  
  /**
   * Reset all consumption tracking.
   * 
   * This is primarily for testing purposes.
   */
  destroy(): void {
    if (this.midnightTimer !== null) {
      clearTimeout(this.midnightTimer);
      this.midnightTimer = null;
    }
    if (this.cleanupInterval !== null) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.consumptionMap.clear();
    this.cumulativeSavings = 0;
  }

  reset(): void {
    this.consumptionMap.clear();
    this.cumulativeSavings = 0;
  }
}
