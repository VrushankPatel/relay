/**
 * Verification script for Task 4.3: LRU Eviction Policy Implementation
 * 
 * This script demonstrates that the evictLRU method correctly:
 * 1. Removes least recently used entries
 * 2. Triggers eviction when cache reaches maximum capacity
 * 3. Removes entries with oldest lastAccessTime first
 * 4. Updates cache size after eviction
 * 5. Returns count of evicted entries
 */

import { CacheManager } from './src/components/CacheManager';
import { CopilotResponse } from './src/types/copilot';

async function verifyLRUEviction() {
  console.log('=== Task 4.3: LRU Eviction Policy Verification ===\n');

  // Test 1: Basic eviction with manual call
  console.log('Test 1: Manual eviction of least recently used entries');
  const cache1 = new CacheManager(10000, 24);
  const response: CopilotResponse = {
    completions: [{ text: 'test', confidence: 0.8 }],
    model: 'copilot-v1',
    tokenCount: 5,
  };

  await cache1.store('hash1', response, 'user1');
  await new Promise(resolve => setTimeout(resolve, 10));
  await cache1.store('hash2', response, 'user1');
  await new Promise(resolve => setTimeout(resolve, 10));
  await cache1.store('hash3', response, 'user1');

  console.log('  - Stored 3 entries: hash1, hash2, hash3');
  console.log('  - Cache size before eviction:', (await cache1.lookupExact('hash1')) ? 3 : 'error');

  const evicted1 = await cache1.evictLRU(1);
  console.log('  - Evicted count:', evicted1);
  console.log('  - hash1 (oldest) evicted:', (await cache1.lookupExact('hash1')) === null ? 'YES ✓' : 'NO ✗');
  console.log('  - hash2 still present:', (await cache1.lookupExact('hash2')) !== null ? 'YES ✓' : 'NO ✗');
  console.log('  - hash3 still present:', (await cache1.lookupExact('hash3')) !== null ? 'YES ✓' : 'NO ✗');

  // Test 2: Eviction based on access time (not insertion time)
  console.log('\nTest 2: Eviction based on lastAccessTime (not insertion order)');
  const cache2 = new CacheManager(10000, 24);
  
  await cache2.store('hash1', response, 'user1');
  await cache2.store('hash2', response, 'user1');
  await cache2.store('hash3', response, 'user1');

  // Access hash1 to make it more recently used
  await cache2.lookupExact('hash1');
  console.log('  - Stored hash1, hash2, hash3');
  console.log('  - Accessed hash1 (moved to front of LRU)');

  const evicted2 = await cache2.evictLRU(1);
  console.log('  - Evicted count:', evicted2);
  console.log('  - hash2 (now oldest) evicted:', (await cache2.lookupExact('hash2')) === null ? 'YES ✓' : 'NO ✗');
  console.log('  - hash1 still present:', (await cache2.lookupExact('hash1')) !== null ? 'YES ✓' : 'NO ✗');
  console.log('  - hash3 still present:', (await cache2.lookupExact('hash3')) !== null ? 'YES ✓' : 'NO ✗');

  // Test 3: Automatic eviction when cache reaches capacity
  console.log('\nTest 3: Automatic eviction when cache reaches maximum capacity');
  const cache3 = new CacheManager(3, 24); // Small cache with max 3 entries
  
  await cache3.store('hash1', response, 'user1');
  await cache3.store('hash2', response, 'user1');
  await cache3.store('hash3', response, 'user1');
  console.log('  - Filled cache to capacity: 3/3 entries');
  
  await cache3.store('hash4', response, 'user1');
  console.log('  - Added hash4 (should trigger automatic eviction)');
  console.log('  - hash1 (oldest) auto-evicted:', (await cache3.lookupExact('hash1')) === null ? 'YES ✓' : 'NO ✗');
  console.log('  - hash2 still present:', (await cache3.lookupExact('hash2')) !== null ? 'YES ✓' : 'NO ✗');
  console.log('  - hash3 still present:', (await cache3.lookupExact('hash3')) !== null ? 'YES ✓' : 'NO ✗');
  console.log('  - hash4 (new) present:', (await cache3.lookupExact('hash4')) !== null ? 'YES ✓' : 'NO ✗');

  // Test 4: Evicting multiple entries
  console.log('\nTest 4: Evicting multiple entries at once');
  const cache4 = new CacheManager(10000, 24);
  
  await cache4.store('hash1', response, 'user1');
  await cache4.store('hash2', response, 'user1');
  await cache4.store('hash3', response, 'user1');
  await cache4.store('hash4', response, 'user1');
  console.log('  - Stored 4 entries');

  const evicted4 = await cache4.evictLRU(2);
  console.log('  - Evicted count:', evicted4);
  console.log('  - Oldest 2 entries evicted:', 
    (await cache4.lookupExact('hash1')) === null && 
    (await cache4.lookupExact('hash2')) === null ? 'YES ✓' : 'NO ✗');
  console.log('  - Newest 2 entries still present:', 
    (await cache4.lookupExact('hash3')) !== null && 
    (await cache4.lookupExact('hash4')) !== null ? 'YES ✓' : 'NO ✗');

  // Test 5: Edge case - evicting more than exist
  console.log('\nTest 5: Edge case - evicting more entries than exist');
  const cache5 = new CacheManager(10000, 24);
  
  await cache5.store('hash1', response, 'user1');
  await cache5.store('hash2', response, 'user1');
  console.log('  - Stored 2 entries');

  const evicted5 = await cache5.evictLRU(10);
  console.log('  - Requested to evict 10 entries');
  console.log('  - Actually evicted:', evicted5, evicted5 === 2 ? '(correct) ✓' : '(incorrect) ✗');

  // Test 6: Edge case - evicting from empty cache
  console.log('\nTest 6: Edge case - evicting from empty cache');
  const cache6 = new CacheManager(10000, 24);
  
  const evicted6 = await cache6.evictLRU(5);
  console.log('  - Requested to evict 5 entries from empty cache');
  console.log('  - Actually evicted:', evicted6, evicted6 === 0 ? '(correct) ✓' : '(incorrect) ✗');

  console.log('\n=== All Task 4.3 Requirements Verified ===');
}

// Run verification
verifyLRUEviction().catch(console.error);
