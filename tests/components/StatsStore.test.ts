import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StatsStore } from '../../src/components/StatsStore.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('StatsStore', () => {
  const tempDir = path.join(os.tmpdir(), `relay-test-stats-${Date.now()}`);
  const statsFile = path.join(tempDir, 'stats.json');
  let activeStores: StatsStore[] = [];

  const createStore = () => {
    const store = new StatsStore(statsFile);
    activeStores.push(store);
    return store;
  };

  beforeEach(async () => {
    activeStores = [];
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    for (const store of activeStores) {
      await store.destroy();
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('initializes gracefully when no file exists', async () => {
    const store = createStore();
    await store.initialize();
    
    const stats = store.getStats();
    expect(stats.lifetime.totalRequestsProxied).toBe(0);
    expect(stats.providers).toEqual({});
  });

  it('records stats and persists across simulated restarts', async () => {
    const store1 = createStore();
    await store1.initialize();
    
    store1.recordCacheMiss('openai', 0.05, true);
    store1.recordCacheHit('openai', false, 0.05, false);
    store1.recordDedup('anthropic', 0.10);
    
    // Give it a moment to save since it's async
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const store2 = createStore();
    await store2.initialize();
    
    const stats = store2.getStats();
    expect(stats.lifetime.totalRequestsProxied).toBe(2);
    expect(stats.lifetime.totalCacheMisses).toBe(1);
    expect(stats.lifetime.totalExactCacheHits).toBe(1);
    expect(stats.lifetime.totalDedupRequests).toBe(1);
    expect(stats.lifetime.totalDollarsSaved).toBeCloseTo(0.15);
    
    expect(stats.providers['openai'].requestsProxied).toBe(2);
    expect(stats.providers['anthropic'].dedupRequests).toBe(1);
  });

  it('prunes daily rollups older than 30 days', async () => {
    // Manually create a file with old data
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 35);
    const oldDateStr = oldDate.toISOString().split('T')[0];
    
    const initialData = {
      lifetime: {
        totalRequestsProxied: 0,
        totalExactCacheHits: 0,
        totalFuzzyCacheHits: 0,
        totalCacheMisses: 0,
        totalDedupRequests: 0,
        totalDollarsSaved: 0,
        streamingRequests: 0,
        nonStreamingRequests: 0
      },
      providers: {
        openai: {
          requestsProxied: 0,
          exactCacheHits: 0,
          fuzzyCacheHits: 0,
          cacheMisses: 0,
          dedupRequests: 0,
          dollarsSaved: 0
        }
      },
      dailyRollups: {
        openai: {
          [oldDateStr]: { date: oldDateStr, requests: 10, cost: 1.5 }
        }
      }
    };
    
    await fs.writeFile(statsFile, JSON.stringify(initialData), 'utf-8');
    
    const store = createStore();
    await store.initialize(); // Doesn't prune yet, prunes on save
    
    // Trigger save
    store.recordCacheMiss('openai', 0.1, false);
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Read back directly to verify prune
    const savedData = JSON.parse(await fs.readFile(statsFile, 'utf-8'));
    expect(savedData.dailyRollups['openai'][oldDateStr]).toBeUndefined();
    
    const today = new Date().toISOString().split('T')[0];
    expect(savedData.dailyRollups['openai'][today].requests).toBe(1);
  });

  it('recovers gracefully from a corrupted file', async () => {
    await fs.writeFile(statsFile, '{ invalid json', 'utf-8');
    
    const store = createStore();
    // Should not throw
    await store.initialize();
    
    const stats = store.getStats();
    expect(stats.lifetime.totalRequestsProxied).toBe(0);
  });

  it('records both cache hits and misses in daily rollups with correct request count and cost saved', async () => {
    const store = createStore();
    await store.initialize();
    
    // Miss: costs 0.05 actual spend (records 0 saved to rollup, but 1 request)
    store.recordCacheMiss('openai', 0.05, false);
    
    // Hit: saves 0.05 spend (records 0.05 saved to rollup, and 1 request)
    store.recordCacheHit('openai', false, 0.05, false);
    
    const stats = store.getStats();
    expect(stats.lifetime.totalRequestsProxied).toBe(2);
    expect(stats.lifetime.totalCacheMisses).toBe(1);
    expect(stats.lifetime.totalExactCacheHits).toBe(1);
    expect(stats.lifetime.totalDollarsSaved).toBeCloseTo(0.05);

    const today = new Date().toISOString().split('T')[0];
    const rollup = stats.dailyRollups['openai'][today];
    expect(rollup).toBeDefined();
    // 2 total requests in daily rollup (combined hits + misses)
    expect(rollup.requests).toBe(2);
    // 0.05 dollars saved in daily rollup (0.05 from hit, 0 from miss)
    expect(rollup.cost).toBeCloseTo(0.05);
  });
});
