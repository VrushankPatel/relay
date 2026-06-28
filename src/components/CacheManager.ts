import { CacheStatistics } from '../types/cache.js';
import { ChatCacheEntry, NormalizedChatRequest } from '../types/chat.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { encryptString, decryptString } from '../utils/encryption.js';

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

  private cacheDirectory: string;
  private encryptCache: boolean;
  private cacheSecret: string;

  constructor(
    maxEntries = 10000,
    ttlHours = 24,
    cacheDirectory = path.join(os.homedir(), '.relay', 'cache'),
    encryptCache = true
  ) {
    this.cache = new Map();
    this.prefixCacheMap = new Map();
    this.lruMap = new Map();
    this.maxEntries = maxEntries;
    this.ttlMilliseconds = ttlHours * 60 * 60 * 1000;
    this.cacheDirectory = cacheDirectory;
    this.encryptCache = encryptCache;
    this.cacheSecret = process.env.RELAY_CACHE_SECRET || '';
  }

  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.cacheDirectory, { recursive: true });
    } catch (err) {
      // Ignore if exists
    }

    if (this.encryptCache && !this.cacheSecret) {
      const crypto = await import('crypto');
      const { getLogger } = await import('../utils/logger.js');
      const secretPath = path.join(this.cacheDirectory, '..', 'cache_secret');
      
      try {
        const existingSecret = await fs.readFile(secretPath, 'utf-8');
        this.cacheSecret = existingSecret.trim();
        if (this.cacheSecret.length > 0) {
          getLogger().warn('Using auto-generated, machine-local cache secret from ' + secretPath + '. In shared or production environments, explicitly set RELAY_CACHE_SECRET and back it up.');
        }
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          this.cacheSecret = crypto.randomBytes(32).toString('hex');
          await fs.writeFile(secretPath, this.cacheSecret, { mode: 0o600 });
          getLogger().warn('Generated new machine-local cache secret at ' + secretPath + '. In shared or production environments, explicitly set RELAY_CACHE_SECRET and back it up to avoid losing access to encrypted cache.');
        } else {
          throw err;
        }
      }
    }
  }

  private getFilePath(hash: string, isPrefix: boolean): string {
    return path.join(this.cacheDirectory, `${isPrefix ? 'prefix_' : ''}${hash}.json`);
  }

  private async loadFromDisk(hash: string, isPrefix: boolean): Promise<ChatCacheEntry | null> {
    const filePath = this.getFilePath(hash, isPrefix);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      if (this.encryptCache) {
        const envelope = JSON.parse(data);
        const decrypted = decryptString(envelope, this.cacheSecret);
        return JSON.parse(decrypted);
      } else {
        return JSON.parse(data);
      }
    } catch (e) {
      return null; // File doesn't exist or is corrupted
    }
  }

  private async saveToDisk(hash: string, entry: ChatCacheEntry, isPrefix: boolean): Promise<void> {
    const filePath = this.getFilePath(hash, isPrefix);
    try {
      const serialized = JSON.stringify(entry);
      if (this.encryptCache) {
        const envelope = encryptString(serialized, this.cacheSecret);
        await fs.writeFile(filePath, JSON.stringify(envelope), 'utf-8');
      } else {
        await fs.writeFile(filePath, serialized, 'utf-8');
      }
    } catch (e) {
      // Ignore write errors (e.g. disk full)
    }
  }

  private async deleteFromDisk(hash: string, isPrefix: boolean): Promise<void> {
    const filePath = this.getFilePath(hash, isPrefix);
    try {
      await fs.unlink(filePath);
    } catch (e) {
      // Ignore if file doesn't exist
    }
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
    let entry = this.cache.get(hash);
    if (!entry) {
      entry = (await this.loadFromDisk(hash, false)) || undefined;
      if (entry) {
        this.cache.set(hash, entry);
        this.addToFront(`exact:${hash}`, false);
      }
    }

    if (!entry) {
      this.totalMisses++;
      return null;
    }

    if (this.isExpired(entry)) {
      this.cache.delete(hash);
      this.removeFromLRU(`exact:${hash}`);
      this.deleteFromDisk(hash, false).catch(() => {});
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
    let entry = this.prefixCacheMap.get(prefixHash);
    if (!entry) {
      entry = (await this.loadFromDisk(prefixHash, true)) || undefined;
      if (entry) {
        this.prefixCacheMap.set(prefixHash, entry);
        this.addToFront(`prefix:${prefixHash}`, true);
      }
    }

    if (!entry) {
      this.totalMisses++;
      return null;
    }

    if (this.isExpired(entry)) {
      this.prefixCacheMap.delete(prefixHash);
      this.removeFromLRU(`prefix:${prefixHash}`);
      this.deleteFromDisk(prefixHash, true).catch(() => {});
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
    await this.saveToDisk(hash, entry, false);
  }

  async storePrefix(prefixHash: string, entry: ChatCacheEntry): Promise<void> {
    const totalSize = this.cache.size + this.prefixCacheMap.size;
    if (totalSize >= this.maxEntries && !this.prefixCacheMap.has(prefixHash)) {
      await this.evictLRU(1);
    }

    this.prefixCacheMap.set(prefixHash, entry);
    this.addToFront(`prefix:${prefixHash}`, true);
    await this.saveToDisk(prefixHash, entry, true);
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
        this.deleteFromDisk(actualKey, true).catch(() => {});
      } else {
        this.cache.delete(actualKey);
        this.deleteFromDisk(actualKey, false).catch(() => {});
      }
      
      this.removeFromLRU(lruKey);
      evicted++;
    }
    return evicted;
  }

  async invalidate(): Promise<number> {
    const count = this.cache.size + this.prefixCacheMap.size;
    
    // Clear disk
    for (const hash of this.cache.keys()) {
      await this.deleteFromDisk(hash, false);
    }
    for (const hash of this.prefixCacheMap.keys()) {
      await this.deleteFromDisk(hash, true);
    }
    
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
