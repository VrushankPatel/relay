import type { NormalizedChatRequest, ChatCacheEntry } from '../types/chat.js';
import { createChildLogger } from '../utils/logger.js';

export interface FuzzyGuardConfig {
  enabled: boolean;
  maxTokenEditDistance: number;
  maxEntries: number;
  rapidEditWindowMs: number;
  rapidEditThreshold: number;
}

export const DEFAULT_FUZZY_GUARD_CONFIG: FuzzyGuardConfig = {
  enabled: false,
  maxTokenEditDistance: 3,
  maxEntries: 100,
  rapidEditWindowMs: 5000,
  rapidEditThreshold: 3,
};

export interface IFuzzyGuard {
  /** Check for a safe fuzzy match. Returns null if none found. */
  lookup(normalized: NormalizedChatRequest, contextHash: string): ChatCacheEntry | null;
  /** Store normalized request for future fuzzy comparisons. */
  store(normalized: NormalizedChatRequest, contextHash: string, entry: ChatCacheEntry): void;
  /** Check if rapid-edit kill switch is active. */
  isKillSwitchActive(): boolean;
  /** Clear all stored entries. */
  clear(): void;
}

interface StoredEntry {
  normalized: NormalizedChatRequest;
  contextHash: string;
  entry: ChatCacheEntry;
  storedAt: number;
}

/**
 * Compute word-level Levenshtein edit distance.
 * Splits content by whitespace into word arrays, then computes
 * standard Levenshtein distance on the word arrays.
 */
export function wordLevelEditDistance(a: string, b: string): number {
  const wordsA = a.split(/\s+/).filter(w => w.length > 0);
  const wordsB = b.split(/\s+/).filter(w => w.length > 0);

  const lenA = wordsA.length;
  const lenB = wordsB.length;

  // Use single-row optimization for memory efficiency
  let prevRow = Array.from({ length: lenB + 1 }, (_, j) => j);
  let currRow = new Array<number>(lenB + 1);

  for (let i = 1; i <= lenA; i++) {
    currRow[0] = i;
    for (let j = 1; j <= lenB; j++) {
      if (wordsA[i - 1] === wordsB[j - 1]) {
        currRow[j] = prevRow[j - 1];
      } else {
        currRow[j] = Math.min(
          prevRow[j] + 1,     // deletion
          currRow[j - 1] + 1, // insertion
          prevRow[j - 1] + 1  // substitution
        );
      }
    }
    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[lenB];
}

export class FuzzyGuard implements IFuzzyGuard {
  private readonly config: FuzzyGuardConfig;
  private readonly logger;

  // LRU ordered list: index 0 = most recently used
  private entries: StoredEntry[] = [];

  // Rapid-edit kill switch state
  private recentContextTimestamps: { hash: string; timestamp: number }[] = [];
  private killSwitchActiveUntil = 0;

  constructor(config: Partial<FuzzyGuardConfig> = {}) {
    this.config = { ...DEFAULT_FUZZY_GUARD_CONFIG, ...config };
    this.logger = createChildLogger('FuzzyGuard');
  }

  lookup(normalized: NormalizedChatRequest, contextHash: string): ChatCacheEntry | null {
    if (!this.config.enabled) {
      return null;
    }

    if (this.isKillSwitchActive()) {
      this.logger.info('Fuzzy lookup skipped: rapid-edit kill switch is active');
      return null;
    }

    // Track this context hash for rapid-edit detection
    this.trackContextHash(contextHash);

    for (let i = 0; i < this.entries.length; i++) {
      const stored = this.entries[i];
      const result = this.compareRequests(normalized, stored.normalized);

      if (result.match) {
        // Move to front (LRU)
        this.entries.splice(i, 1);
        this.entries.unshift(stored);

        this.logger.info(
          {
            matchedHash: stored.contextHash,
            queryHash: contextHash,
            similarity: result.details,
          },
          'Fuzzy cache match served'
        );

        return stored.entry;
      }
    }

    return null;
  }

  store(normalized: NormalizedChatRequest, contextHash: string, entry: ChatCacheEntry): void {
    if (!this.config.enabled) {
      return;
    }

    // Remove existing entry with same contextHash if present
    const existingIdx = this.entries.findIndex(e => e.contextHash === contextHash);
    if (existingIdx !== -1) {
      this.entries.splice(existingIdx, 1);
    }

    // Add to front (most recent)
    this.entries.unshift({
      normalized,
      contextHash,
      entry,
      storedAt: Date.now(),
    });

    // LRU eviction
    if (this.entries.length > this.config.maxEntries) {
      const evicted = this.entries.length - this.config.maxEntries;
      this.entries.splice(this.config.maxEntries);
      this.logger.debug({ evicted }, 'Evicted oldest fuzzy guard entries');
    }
  }

  isKillSwitchActive(): boolean {
    return Date.now() < this.killSwitchActiveUntil;
  }

  clear(): void {
    this.entries = [];
    this.recentContextTimestamps = [];
    this.killSwitchActiveUntil = 0;
  }

  private trackContextHash(contextHash: string): void {
    const now = Date.now();

    // Prune old timestamps outside the window
    this.recentContextTimestamps = this.recentContextTimestamps.filter(
      entry => now - entry.timestamp < this.config.rapidEditWindowMs
    );

    // Only add if this hash hasn't been seen in the current window
    const alreadySeen = this.recentContextTimestamps.some(e => e.hash === contextHash);
    if (!alreadySeen) {
      this.recentContextTimestamps.push({ hash: contextHash, timestamp: now });
    }

    // Check if we've exceeded the threshold
    const distinctCount = this.recentContextTimestamps.length;
    if (distinctCount > this.config.rapidEditThreshold && !this.isKillSwitchActive()) {
      this.killSwitchActiveUntil = now + this.config.rapidEditWindowMs;
      this.logger.info(
        {
          distinctHashes: distinctCount,
          threshold: this.config.rapidEditThreshold,
          windowMs: this.config.rapidEditWindowMs,
          activeUntil: new Date(this.killSwitchActiveUntil).toISOString(),
        },
        'Rapid-edit kill switch ACTIVATED'
      );
    }
  }

  private compareRequests(
    query: NormalizedChatRequest,
    stored: NormalizedChatRequest
  ): { match: boolean; details: Record<string, unknown> } {
    // 1. Model must match exactly
    if (query.model !== stored.model) {
      return { match: false, details: { reason: 'model_mismatch', queryModel: query.model, storedModel: stored.model } };
    }

    // 2. Sampling params must match exactly
    if (query.temperature !== stored.temperature) {
      return { match: false, details: { reason: 'temperature_mismatch' } };
    }
    if (query.top_p !== stored.top_p) {
      return { match: false, details: { reason: 'top_p_mismatch' } };
    }
    if (query.max_tokens !== stored.max_tokens) {
      return { match: false, details: { reason: 'max_tokens_mismatch' } };
    }
    if (query.presence_penalty !== stored.presence_penalty) {
      return { match: false, details: { reason: 'presence_penalty_mismatch' } };
    }
    if (query.frequency_penalty !== stored.frequency_penalty) {
      return { match: false, details: { reason: 'frequency_penalty_mismatch' } };
    }

    // 3. Message count must match
    if (query.messages.length !== stored.messages.length) {
      return {
        match: false,
        details: {
          reason: 'message_count_mismatch',
          queryCount: query.messages.length,
          storedCount: stored.messages.length,
        },
      };
    }

    // 4. Tool schemas must match exactly
    const queryTools = JSON.stringify(query.tools ?? []);
    const storedTools = JSON.stringify(stored.tools ?? []);
    if (queryTools !== storedTools) {
      return { match: false, details: { reason: 'tool_schema_mismatch' } };
    }

    // 5. Per-message comparison
    let maxDistance = 0;
    const messageDiffs: { index: number; distance: number; diff: string }[] = [];

    for (let i = 0; i < query.messages.length; i++) {
      const qMsg = query.messages[i];
      const sMsg = stored.messages[i];

      // Roles must match
      if (qMsg.role !== sMsg.role) {
        return {
          match: false,
          details: {
            reason: 'role_mismatch',
            messageIndex: i,
            queryRole: qMsg.role,
            storedRole: sMsg.role,
          },
        };
      }

      // Content edit distance
      const qContent = qMsg.content ?? '';
      const sContent = sMsg.content ?? '';
      const distance = wordLevelEditDistance(qContent, sContent);

      if (distance > this.config.maxTokenEditDistance) {
        return {
          match: false,
          details: {
            reason: 'content_distance_exceeded',
            messageIndex: i,
            distance,
            maxAllowed: this.config.maxTokenEditDistance,
          },
        };
      }

      if (distance > 0) {
        maxDistance = Math.max(maxDistance, distance);
        // Generate a short diff summary
        const qWords = qContent.split(/\s+/).filter(w => w.length > 0);
        const sWords = sContent.split(/\s+/).filter(w => w.length > 0);
        const diffWords = qWords.filter(w => !sWords.includes(w)).slice(0, 5);
        messageDiffs.push({
          index: i,
          distance,
          diff: `changed words: [${diffWords.join(', ')}]`,
        });
      }
    }

    return {
      match: true,
      details: {
        maxDistance,
        messageDiffs,
        totalMessages: query.messages.length,
      },
    };
  }
}
