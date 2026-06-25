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

import type { Completion } from '../types/copilot.js';

/**
 * Status of a user's token budget for the current day.
 */
export interface BudgetStatus {
  /** Number of tokens consumed by the user today */
  consumed: number;
  
  /** Daily token limit for the user (undefined if no limit) */
  limit: number | undefined;
  
  /** Number of tokens remaining in the budget */
  remaining: number;
  
  /** Percentage of budget consumed (0-100) */
  percentUsed: number;
  
  /** Whether the user is within their token budget */
  withinBudget: boolean;
}

/**
 * Daily token consumption tracking for a user.
 */
interface DailyConsumption {
  /** ISO date string (YYYY-MM-DD) */
  date: string;
  
  /** Tokens consumed from API calls */
  tokensConsumed: number;
  
  /** Tokens served from cache */
  tokensFromCache: number;
  
  /** Total tokens saved by caching */
  tokensSaved: number;
  
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
  
  /** Cumulative token savings since service start */
  private cumulativeSavings: number = 0;
  
  /** Optional token budget per user per day */
  private budgetPerUserPerDay: number | undefined;
  
  /** Logger instance for this component */
  private logger: any;
  
  /**
   * Creates a new TokenAnalyzer instance.
   * 
   * @param budgetPerUserPerDay - Optional daily token limit per user
   * @param logger - Logger instance for logging events
   */
  constructor(budgetPerUserPerDay?: number, logger?: any) {
    this.budgetPerUserPerDay = budgetPerUserPerDay;
    this.logger = logger;
    
    // Schedule midnight UTC cleanup
    this.scheduleMidnightCleanup();
  }
  
  /**
   * Count tokens in a request prompt.
   * 
   * This method approximates token count using a simple heuristic.
   * TODO: Replace with tiktoken cl100k_base encoding for accurate counting.
   * 
   * Performance target: < 5ms
   * 
   * @param prompt - The request prompt text
   * @returns Estimated number of tokens
   */
  countRequestTokens(prompt: string): number {
    const startTime = performance.now();
    
    // Simple approximation: ~1 token per 4 characters for English text
    // This is a rough estimate and should be replaced with tiktoken
    const tokenCount = Math.ceil(prompt.length / 4);
    
    const elapsed = performance.now() - startTime;
    if (elapsed > 5) {
      this.logger?.warn({
        component: 'TokenAnalyzer',
        method: 'countRequestTokens',
        elapsed,
        message: 'Token counting exceeded 5ms target'
      });
    }
    
    return tokenCount;
  }
  
  /**
   * Count tokens in response completions.
   * 
   * This method approximates token count using a simple heuristic.
   * TODO: Replace with tiktoken cl100k_base encoding for accurate counting.
   * 
   * Performance target: < 5ms
   * 
   * @param completions - Array of completion suggestions
   * @returns Estimated number of tokens across all completions
   */
  countResponseTokens(completions: Completion[]): number {
    const startTime = performance.now();
    
    // Sum token counts across all completions
    let totalTokens = 0;
    for (const completion of completions) {
      // Simple approximation: ~1 token per 4 characters
      totalTokens += Math.ceil(completion.text.length / 4);
    }
    
    const elapsed = performance.now() - startTime;
    if (elapsed > 5) {
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
   * Calculate tokens saved by a cache hit.
   * 
   * Token savings = request tokens + response tokens that would have been consumed.
   * 
   * @param requestTokens - Number of tokens in the request
   * @param responseTokens - Number of tokens in the response
   * @returns Total tokens saved
   */
  calculateSavings(requestTokens: number, responseTokens: number): number {
    const savings = requestTokens + responseTokens;
    this.cumulativeSavings += savings;
    return savings;
  }
  
  /**
   * Get cumulative token savings since service start.
   * 
   * @returns Total tokens saved across all cache hits
   */
  getCumulativeSavings(): number {
    return this.cumulativeSavings;
  }
  
  /**
   * Record token consumption for a user.
   * 
   * This tracks consumption per day and resets at midnight UTC.
   * 
   * @param userId - User identifier
   * @param tokens - Number of tokens consumed
   * @param fromCache - Whether this was served from cache
   */
  recordConsumption(userId: string, tokens: number, fromCache: boolean = false): void {
    const today = this.getCurrentDateString();
    let consumption = this.consumptionMap.get(userId);
    
    // Create new daily record if needed or if day has changed
    if (!consumption || consumption.date !== today) {
      consumption = {
        date: today,
        tokensConsumed: 0,
        tokensFromCache: 0,
        tokensSaved: 0,
        firstRequest: Date.now(),
        lastRequest: Date.now()
      };
      this.consumptionMap.set(userId, consumption);
    }
    
    // Update consumption
    consumption.lastRequest = Date.now();
    if (fromCache) {
      consumption.tokensFromCache += tokens;
      consumption.tokensSaved += tokens;
    } else {
      consumption.tokensConsumed += tokens;
    }
    
    // Check if user has reached 90% of budget (warning threshold)
    if (this.budgetPerUserPerDay) {
      const percentUsed = (consumption.tokensConsumed / this.budgetPerUserPerDay) * 100;
      if (percentUsed >= 90 && percentUsed < 100) {
        this.logger?.warn({
          component: 'TokenAnalyzer',
          userId,
          consumed: consumption.tokensConsumed,
          limit: this.budgetPerUserPerDay,
          percentUsed: percentUsed.toFixed(2),
          message: 'User approaching token budget limit (90% threshold)'
        });
      }
    }
  }
  
  /**
   * Check if a user is within their token budget.
   * 
   * @param userId - User identifier
   * @returns Budget status including consumption, limit, and remaining tokens
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
    
    const consumed = consumption.tokensConsumed;
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
    
    setTimeout(() => {
      this.cleanupOldRecords();
      
      // Schedule next cleanup (every 24 hours)
      setInterval(() => {
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
  reset(): void {
    this.consumptionMap.clear();
    this.cumulativeSavings = 0;
  }
}
