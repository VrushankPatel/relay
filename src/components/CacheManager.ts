/**
 * Cache Manager component for the GitHub Copilot Token Optimizer Proxy.
 * 
 * This component manages an in-memory LRU cache for Copilot responses,
 * supporting exact and fuzzy matching with TTL-based expiration.
 */

import { CacheEntry, CompressedResponse, CacheStatistics } from '../types/cache';
import { CopilotResponse } from '../types/copilot';
import crypto from 'crypto';
import zlib from 'zlib';
import { promisify } from 'util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_ITERATIONS = 100000;
const KEY_LENGTH = 32;

function deriveKey(secret: string): Buffer {
  return crypto.pbkdf2Sync(secret, 'copilot-proxy-salt', KEY_ITERATIONS, KEY_LENGTH, 'sha256');
}

function encrypt(buffer: Buffer, key: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

function decrypt(buffer: Buffer, key: Buffer): Buffer {
  const iv = buffer.subarray(0, IV_LENGTH);
  const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Cache Manager interface defining cache storage and retrieval operations.
 */
export interface ICacheManager {
  /**
   * Lookup exact cache match by context hash.
   * @param contextHash SHA-256 hash of the normalized context
   * @returns Cache entry if found and not expired, null otherwise
   */
  lookupExact(contextHash: string): Promise<CacheEntry | null>;
  
  /**
   * Search for similar cache entries using fuzzy matching.
   * @param contextHash SHA-256 hash of the normalized context
   * @param threshold Similarity threshold (0-100)
   * @returns Similar cache entry if found above threshold, null otherwise
   */
  lookupSimilar(contextHash: string, threshold: number): Promise<CacheEntry | null>;
  
  /**
   * Store response in cache.
   * @param contextHash SHA-256 hash of the normalized context
   * @param response Copilot response to cache
   * @param userId User ID who made the request
   */
  store(contextHash: string, response: CopilotResponse, userId: string): Promise<void>;
  
  /**
   * Check if cache entry is expired (> 24 hours).
   * @param entry Cache entry to check
   * @returns True if expired, false otherwise
   */
  isExpired(entry: CacheEntry): boolean;
  
  /**
   * Evict least recently used entries.
   * @param count Number of entries to evict
   * @returns Number of entries actually evicted
   */
  evictLRU(count: number): Promise<number>;
  
  /**
   * Invalidate cache entries for a specific user or all entries.
   * @param userId Optional user ID to invalidate (if not provided, invalidates all)
   * @returns Number of entries invalidated
   */
  invalidate(userId?: string): Promise<number>;
  
  /**
   * Calculate similarity score between two context hashes.
   * @param hash1 First context hash
   * @param hash2 Second context hash
   * @returns Similarity score (0-1)
   */
  calculateSimilarity(hash1: string, hash2: string): number;
  
  /**
   * Get current cache statistics.
   * @returns Cache statistics
   */
  getStatistics(): CacheStatistics;
}

/**
 * Node in the doubly-linked list for LRU tracking.
 */
interface LRUNode {
  contextHash: string;
  prev: LRUNode | null;
  next: LRUNode | null;
}

/**
 * Implementation of the Cache Manager with in-memory storage and LRU eviction.
 */
export class CacheManager implements ICacheManager {
  private cache: Map<string, CacheEntry>;
  private maxEntries: number;
  private ttlMilliseconds: number;
  private encryptionKey: Buffer | null = null;
  
  // LRU tracking with doubly-linked list
  private lruHead: LRUNode | null = null;
  private lruTail: LRUNode | null = null;
  private lruMap: Map<string, LRUNode>;
  
  // Statistics tracking
  private totalHits = 0;
  private totalMisses = 0;
  
  /**
   * Create a new Cache Manager.
   * @param maxEntries Maximum number of cache entries (default: 10,000)
   * @param ttlHours Cache TTL in hours (default: 24)
   * @param encryptionSecret Optional secret for AES-256-GCM encryption at rest
   */
  constructor(maxEntries = 10000, ttlHours = 24, encryptionSecret?: string) {
    this.cache = new Map();
    this.lruMap = new Map();
    this.maxEntries = maxEntries;
    this.ttlMilliseconds = ttlHours * 60 * 60 * 1000;
    if (encryptionSecret) {
      this.encryptionKey = deriveKey(encryptionSecret);
    }
  }
  
  /**
   * Lookup exact cache match by context hash.
   * Checks TTL and updates access time/count on hit.
   */
  async lookupExact(contextHash: string): Promise<CacheEntry | null> {
    const entry = this.cache.get(contextHash);
    
    if (!entry) {
      this.totalMisses++;
      return null;
    }
    
    // Check if entry is expired
    if (this.isExpired(entry)) {
      // Remove expired entry
      this.cache.delete(contextHash);
      this.removeFromLRU(contextHash);
      this.totalMisses++;
      return null;
    }
    
    // Update access metadata
    entry.accessCount++;
    entry.lastAccessTime = Date.now();
    
    // Move to front of LRU list (most recently used)
    this.moveToFront(contextHash);
    
    this.totalHits++;
    
    // Decrypt if encrypted, then decompress
    const rawData = this.encryptionKey ? decrypt(entry.response.data, this.encryptionKey) : entry.response.data;
    const decompressedData = await gunzip(rawData);
    return {
      ...entry,
      response: {
        ...entry.response,
        data: decompressedData,
      },
    };
  }
  
  /**
   * Search for similar cache entries using fuzzy matching.
   * Searches recent entries (limited to 100) for performance.
   */
  async lookupSimilar(contextHash: string, threshold: number): Promise<CacheEntry | null> {
    // Get recent entries (limited to 100 for performance)
    const recentEntries = Array.from(this.cache.entries()).slice(0, 100);
    
    let bestMatch: CacheEntry | null = null;
    let bestScore = 0;
    
    for (const [hash, entry] of recentEntries) {
      // Skip expired entries
      if (this.isExpired(entry)) {
        continue;
      }
      
      // Calculate similarity score
      const similarity = this.calculateSimilarity(contextHash, hash);
      const similarityPercent = similarity * 100;
      
      if (similarityPercent >= threshold && similarity > bestScore) {
        bestScore = similarity;
        bestMatch = entry;
      }
    }
    
    if (bestMatch) {
      // Update access metadata
      bestMatch.accessCount++;
      bestMatch.lastAccessTime = Date.now();
      
      // Move to front of LRU list
      this.moveToFront(bestMatch.contextHash);
      
      this.totalHits++;

      // Decrypt if encrypted, then decompress
      const rawData = this.encryptionKey ? decrypt(bestMatch.response.data, this.encryptionKey) : bestMatch.response.data;
      const decompressedData = await gunzip(rawData);
      return {
        ...bestMatch,
        response: {
          ...bestMatch.response,
          data: decompressedData,
        },
      };
    }
    
    this.totalMisses++;
    
    return null;
  }
  
  /**
   * Store response in cache.
   * Evicts LRU entry if cache is at capacity.
   */
  async store(contextHash: string, response: CopilotResponse, userId: string): Promise<void> {
    // Check if we need to evict
    if (this.cache.size >= this.maxEntries && !this.cache.has(contextHash)) {
      await this.evictLRU(1);
    }
    
    // Compress response with gzip
    const responseJson = JSON.stringify(response);
    const originalSize = Buffer.byteLength(responseJson, 'utf8');
    const compressed = await gzip(responseJson, { level: 6 });
    
    // Optionally encrypt the compressed data
    const stored = this.encryptionKey ? encrypt(compressed, this.encryptionKey) : compressed;
    
    const compressedResponse: CompressedResponse = {
      data: stored,
      originalSize,
      compressedSize: stored.length,
    };
    
    // Create cache entry
    const now = Date.now();
    const entry: CacheEntry = {
      contextHash,
      response: compressedResponse,
      timestamp: now,
      userId,
      accessCount: 0,
      lastAccessTime: now,
      tokenCount: response.tokenCount,
    };
    
    // Store in cache
    this.cache.set(contextHash, entry);
    
    // Add to front of LRU list
    this.addToFront(contextHash);
  }
  
  /**
   * Check if cache entry is expired (> 24 hours).
   */
  isExpired(entry: CacheEntry): boolean {
    const age = Date.now() - entry.timestamp;
    return age >= this.ttlMilliseconds;
  }
  
  /**
   * Evict least recently used entries.
   * Removes entries from the tail of the LRU list.
   */
  async evictLRU(count: number): Promise<number> {
    let evicted = 0;
    
    while (evicted < count && this.lruTail) {
      const contextHash = this.lruTail.contextHash;
      
      // Remove from cache and LRU list
      this.cache.delete(contextHash);
      this.removeFromLRU(contextHash);
      
      evicted++;
    }
    
    return evicted;
  }
  
  /**
   * Invalidate cache entries for a specific user or all entries.
   */
  async invalidate(userId?: string): Promise<number> {
    if (!userId) {
      // Invalidate all entries
      const count = this.cache.size;
      this.cache.clear();
      this.lruMap.clear();
      this.lruHead = null;
      this.lruTail = null;
      return count;
    }
    
    // Invalidate entries for specific user
    let invalidated = 0;
    const toRemove: string[] = [];
    
    for (const [contextHash, entry] of this.cache.entries()) {
      if (entry.userId === userId) {
        toRemove.push(contextHash);
        invalidated++;
      }
    }
    
    // Remove entries
    for (const contextHash of toRemove) {
      this.cache.delete(contextHash);
      this.removeFromLRU(contextHash);
    }
    
    return invalidated;
  }
  
  /**
   * Calculate similarity score between two context hashes using Levenshtein distance.
   * Returns normalized similarity score (0-1, where 1 is identical).
   */
  calculateSimilarity(hash1: string, hash2: string): number {
    if (hash1 === hash2) return 1.0;
    
    const distance = this.levenshteinDistance(hash1, hash2);
    const maxLength = Math.max(hash1.length, hash2.length);
    
    if (maxLength === 0) return 1.0;
    
    return 1 - distance / maxLength;
  }
  
  /**
   * Get current cache statistics.
   */
  getStatistics(): CacheStatistics {
    const totalRequests = this.totalHits + this.totalMisses;
    const hitRate = totalRequests > 0 ? (this.totalHits / totalRequests) * 100 : 0;
    
    let totalSize = 0;
    let totalCompression = 0;
    
    for (const entry of this.cache.values()) {
      totalSize += entry.response.compressedSize;
      if (entry.response.originalSize > 0) {
        totalCompression += entry.response.compressedSize / entry.response.originalSize;
      }
    }
    
    const averageEntrySize = this.cache.size > 0 ? totalSize / this.cache.size : 0;
    const compressionRatio = this.cache.size > 0 ? totalCompression / this.cache.size : 1.0;
    
    return {
      size: this.cache.size,
      maxSize: this.maxEntries,
      hitRate,
      averageEntrySize,
      compressionRatio,
    };
  }
  
  // ===== LRU List Management =====
  
  /**
   * Add a node to the front of the LRU list (most recently used).
   */
  private addToFront(contextHash: string): void {
    // Remove if already exists
    this.removeFromLRU(contextHash);
    
    const node: LRUNode = {
      contextHash,
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
    
    this.lruMap.set(contextHash, node);
  }
  
  /**
   * Move an existing node to the front of the LRU list.
   */
  private moveToFront(contextHash: string): void {
    const node = this.lruMap.get(contextHash);
    if (!node) return;
    
    // Remove from current position
    this.removeFromLRU(contextHash);
    
    // Add to front
    this.addToFront(contextHash);
  }
  
  /**
   * Remove a node from the LRU list.
   */
  private removeFromLRU(contextHash: string): void {
    const node = this.lruMap.get(contextHash);
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
    
    this.lruMap.delete(contextHash);
  }
  
  // ===== Levenshtein Distance Algorithm =====
  
  /**
   * Calculate Levenshtein distance between two strings.
   * @param str1 First string
   * @param str2 Second string
   * @returns Edit distance
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const len1 = str1.length;
    const len2 = str2.length;
    
    // Create distance matrix
    const matrix: number[][] = Array(len1 + 1)
      .fill(null)
      .map(() => Array(len2 + 1).fill(0));
    
    // Initialize first row and column
    for (let i = 0; i <= len1; i++) {
      matrix[i][0] = i;
    }
    for (let j = 0; j <= len2; j++) {
      matrix[0][j] = j;
    }
    
    // Fill matrix
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j] + 1,     // deletion
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j - 1] + 1  // substitution
          );
        }
      }
    }
    
    return matrix[len1][len2];
  }
}
