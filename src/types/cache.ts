/**
 * Cache-related types for the GitHub Copilot Token Optimizer Proxy.
 * 
 * These types define the structure of cached responses, compressed data,
 * and cache statistics for monitoring and optimization.
 */

/**
 * A cached Copilot response with metadata for TTL, LRU eviction, and tracking.
 */
export interface CacheEntry {
  /** SHA-256 hash of the normalized code context that identifies this cache entry */
  contextHash: string;
  
  /** Compressed response data */
  response: CompressedResponse;
  
  /** Unix timestamp (milliseconds) when this entry was created */
  timestamp: number;
  
  /** User ID who made the original request */
  userId: string;
  
  /** Number of times this cache entry has been accessed */
  accessCount: number;
  
  /** Unix timestamp (milliseconds) of the most recent access */
  lastAccessTime: number;
  
  /** Total number of tokens in the cached response (for savings calculation) */
  tokenCount: number;
}

/**
 * A compressed Copilot response with size tracking.
 */
export interface CompressedResponse {
  /** Gzip-compressed response data as a Buffer */
  data: Buffer;
  
  /** Size of the original uncompressed data in bytes */
  originalSize: number;
  
  /** Size of the compressed data in bytes */
  compressedSize: number;
}

/**
 * Statistics about cache performance and storage.
 */
export interface CacheStatistics {
  /** Current number of entries in the cache */
  size: number;
  
  /** Maximum number of entries allowed in the cache */
  maxSize: number;
  
  /** Percentage of requests that resulted in cache hits (0-100) */
  hitRate: number;
  
  /** Average size of a cache entry in bytes */
  averageEntrySize: number;
  
  /** Average compression ratio achieved (compressed size / original size) */
  compressionRatio: number;
}
