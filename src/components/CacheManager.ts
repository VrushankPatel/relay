import { CacheStatistics } from '../types/cache.js';
import { ChatCacheEntry, NormalizedChatRequest } from '../types/chat.js';

export interface ICacheManager {
  lookupExact(hash: string): Promise<ChatCacheEntry | null>;
  lookupPrefix(prefixHash: string): Promise<ChatCacheEntry | null>;
  store(hash: string, entry: ChatCacheEntry): Promise<void>;
  storePrefix(prefixHash: string, entry: ChatCacheEntry): Promise<void>;
  shouldBypassCache(req: NormalizedChatRequest): boolean;
  isExpired(entry: ChatCacheEntry): boolean;
  evictLRU(count: number): Promise<number>;
  invalidate(): Promise<number>;
  getStatistics(): CacheStatistics;
}

interface LRUNode {
  key: string;
  isPrefix: boolean;
  prev: LRUNode | null;
  next: LRUNode | null;
}

export class CacheManager implements ICacheManager {
  private cache: Map<string, ChatCacheEntry>;
  private prefixCacheMap: Map<string, ChatCacheEntry>;
  private maxEntries: number;
  private ttlMilliseconds: number;

  private lruHead: LRUNode | null = null;
  private lruTail: LRUNode | null = null;
  private lruMap: Map<string, LRUNode>; // key format: "exact:hash" or "prefix:hash"

  private totalHits = 0;
  private totalMisses = 0;

  constructor(
    maxEntries = 10000,
    ttlHours = 24
  ) {
    this.cache = new Map();
    this.prefixCacheMap = new Map();
    this.lruMap = new Map();
    this.maxEntries = maxEntries;
    this.ttlMilliseconds = ttlHours * 60 * 60 * 1000;
  }

  shouldBypassCache(req: NormalizedChatRequest): boolean {
    if (req.temperature > 0) {
      return true;
    }
    if (req.tools && req.tools.length > 0) {
      return true;
    }
    return false;
  }

  async lookupExact(hash: string): Promise<ChatCacheEntry | null> {
    const entry = this.cache.get(hash);
    if (!entry) {
      this.totalMisses++;
      return null;
    }

    if (this.isExpired(entry)) {
      this.cache.delete(hash);
      this.removeFromLRU(`exact:${hash}`);
      this.totalMisses++;
      return null;
    }

    entry.accessCount++;
    entry.lastAccessTime = Date.now();
    this.moveToFront(`exact:${hash}`);
    this.totalHits++;

    return entry;
  }

  async lookupPrefix(prefixHash: string): Promise<ChatCacheEntry | null> {
    const entry = this.prefixCacheMap.get(prefixHash);
    if (!entry) {
      this.totalMisses++;
      return null;
    }

    if (this.isExpired(entry)) {
      this.prefixCacheMap.delete(prefixHash);
      this.removeFromLRU(`prefix:${prefixHash}`);
      this.totalMisses++;
      return null;
    }

    entry.accessCount++;
    entry.lastAccessTime = Date.now();
    this.moveToFront(`prefix:${prefixHash}`);
    this.totalHits++;

    return entry;
  }



  async store(hash: string, entry: ChatCacheEntry): Promise<void> {
    const totalSize = this.cache.size + this.prefixCacheMap.size;
    if (totalSize >= this.maxEntries && !this.cache.has(hash)) {
      await this.evictLRU(1);
    }

    this.cache.set(hash, entry);
    this.addToFront(`exact:${hash}`, false);
  }

  async storePrefix(prefixHash: string, entry: ChatCacheEntry): Promise<void> {
    const totalSize = this.cache.size + this.prefixCacheMap.size;
    if (totalSize >= this.maxEntries && !this.prefixCacheMap.has(prefixHash)) {
      await this.evictLRU(1);
    }

    this.prefixCacheMap.set(prefixHash, entry);
    this.addToFront(`prefix:${prefixHash}`, true);
  }

  isExpired(entry: ChatCacheEntry): boolean {
    const age = Date.now() - entry.timestamp;
    return age >= this.ttlMilliseconds;
  }

  async evictLRU(count: number): Promise<number> {
    let evicted = 0;
    while (evicted < count && this.lruTail) {
      const lruKey = this.lruTail.key;
      const isPrefix = this.lruTail.isPrefix;
      
      const actualKey = isPrefix ? lruKey.replace(/^prefix:/, '') : lruKey.replace(/^exact:/, '');

      if (isPrefix) {
        this.prefixCacheMap.delete(actualKey);
      } else {
        this.cache.delete(actualKey);
      }
      
      this.removeFromLRU(lruKey);
      evicted++;
    }
    return evicted;
  }

  async invalidate(): Promise<number> {
    const count = this.cache.size + this.prefixCacheMap.size;
    this.cache.clear();
    this.prefixCacheMap.clear();
    this.lruMap.clear();
    this.lruHead = null;
    this.lruTail = null;
    return count;
  }



  getStatistics(): CacheStatistics {
    const totalRequests = this.totalHits + this.totalMisses;
    const hitRate = totalRequests > 0 ? (this.totalHits / totalRequests) * 100 : 0;
    const size = this.cache.size + this.prefixCacheMap.size;
    
    return {
      size,
      maxSize: this.maxEntries,
      hitRate,
      averageEntrySize: 0,
      compressionRatio: 1.0,
    };
  }

  private addToFront(lruKey: string, isPrefix: boolean): void {
    this.removeFromLRU(lruKey);
    const node: LRUNode = {
      key: lruKey,
      isPrefix,
      prev: null,
      next: this.lruHead,
    };
    if (this.lruHead) {
      this.lruHead.prev = node;
    }
    this.lruHead = node;
    if (!this.lruTail) {
      this.lruTail = node;
    }
    this.lruMap.set(lruKey, node);
  }

  private moveToFront(lruKey: string): void {
    const node = this.lruMap.get(lruKey);
    if (!node) return;
    this.removeFromLRU(lruKey);
    this.addToFront(lruKey, node.isPrefix);
  }

  private removeFromLRU(lruKey: string): void {
    const node = this.lruMap.get(lruKey);
    if (!node) return;
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.lruHead = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.lruTail = node.prev;
    }
    this.lruMap.delete(lruKey);
  }


}
