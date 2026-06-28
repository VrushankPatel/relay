import fs from 'fs/promises';
import path from 'path';

export interface ProviderStats {
  requestsProxied: number;
  exactCacheHits: number;
  fuzzyCacheHits: number;
  cacheMisses: number;
  dedupRequests: number;
  dollarsSaved: number;
}

export interface DailyRollup {
  date: string; // YYYY-MM-DD
  requests: number;
  cost: number;
}

export interface StatsData {
  lifetime: {
    totalRequestsProxied: number;
    totalExactCacheHits: number;
    totalFuzzyCacheHits: number;
    totalCacheMisses: number;
    totalDedupRequests: number;
    totalDollarsSaved: number;
    streamingRequests: number;
    nonStreamingRequests: number;
  };
  providers: Record<string, ProviderStats>;
  dailyRollups: Record<string, Record<string, DailyRollup>>; // providerId -> YYYY-MM-DD -> DailyRollup
}

export class StatsStore {
  private data: StatsData;
  private filePath: string;
  private isWriting = false;
  private pendingWrite = false;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.getDefaultData();
  }

  private getDefaultData(): StatsData {
    return {
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
      providers: {},
      dailyRollups: {}
    };
  }

  async initialize(): Promise<void> {
    try {
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });
      
      const fileData = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(fileData);
      // Basic merge to ensure we don't crash if fields are missing in old JSON
      this.data = { ...this.getDefaultData(), ...parsed };
      this.data.lifetime = { ...this.getDefaultData().lifetime, ...parsed.lifetime };
      this.data.providers = parsed.providers || {};
      this.data.dailyRollups = parsed.dailyRollups || {};
    } catch (e: any) {
      if (e.code !== 'ENOENT') {
        console.warn('Failed to load stats file, starting fresh', e.message);
      }
      this.data = this.getDefaultData();
    }
  }

  private getTodayString(): string {
    return new Date().toISOString().split('T')[0];
  }

  private initProvider(providerId: string) {
    if (!this.data.providers[providerId]) {
      this.data.providers[providerId] = {
        requestsProxied: 0,
        exactCacheHits: 0,
        fuzzyCacheHits: 0,
        cacheMisses: 0,
        dedupRequests: 0,
        dollarsSaved: 0
      };
    }
    if (!this.data.dailyRollups[providerId]) {
      this.data.dailyRollups[providerId] = {};
    }
  }

  private recordDaily(providerId: string, cost: number, requests: number) {
    this.initProvider(providerId);
    const today = this.getTodayString();
    
    if (!this.data.dailyRollups[providerId][today]) {
      this.data.dailyRollups[providerId][today] = { date: today, requests: 0, cost: 0 };
    }
    
    this.data.dailyRollups[providerId][today].requests += requests;
    this.data.dailyRollups[providerId][today].cost += cost;
  }

  recordCacheHit(providerId: string, isFuzzy: boolean, costSaved: number, isStreaming: boolean) {
    this.initProvider(providerId);
    
    this.data.lifetime.totalRequestsProxied++;
    if (isFuzzy) {
      this.data.lifetime.totalFuzzyCacheHits++;
      this.data.providers[providerId].fuzzyCacheHits++;
    } else {
      this.data.lifetime.totalExactCacheHits++;
      this.data.providers[providerId].exactCacheHits++;
    }
    
    this.data.lifetime.totalDollarsSaved += costSaved;
    this.data.providers[providerId].requestsProxied++;
    this.data.providers[providerId].dollarsSaved += costSaved;
    
    if (isStreaming) {
      this.data.lifetime.streamingRequests++;
    } else {
      this.data.lifetime.nonStreamingRequests++;
    }

    this.scheduleSave();
  }

  recordCacheMiss(providerId: string, cost: number, isStreaming: boolean) {
    this.initProvider(providerId);
    
    this.data.lifetime.totalRequestsProxied++;
    this.data.lifetime.totalCacheMisses++;
    this.data.providers[providerId].requestsProxied++;
    this.data.providers[providerId].cacheMisses++;
    
    this.recordDaily(providerId, cost, 1);
    
    if (isStreaming) {
      this.data.lifetime.streamingRequests++;
    } else {
      this.data.lifetime.nonStreamingRequests++;
    }

    this.scheduleSave();
  }

  recordDedup(providerId: string, costSaved: number) {
    this.initProvider(providerId);
    
    this.data.lifetime.totalDedupRequests++;
    this.data.providers[providerId].dedupRequests++;
    
    this.data.lifetime.totalDollarsSaved += costSaved;
    this.data.providers[providerId].dollarsSaved += costSaved;

    this.scheduleSave();
  }
  
  private pruneOldEntries() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cutoffStr = thirtyDaysAgo.toISOString().split('T')[0];

    for (const providerId of Object.keys(this.data.dailyRollups)) {
      const dates = Object.keys(this.data.dailyRollups[providerId]);
      for (const date of dates) {
        if (date < cutoffStr) {
          delete this.data.dailyRollups[providerId][date];
        }
      }
    }
  }

  private scheduleSave() {
    if (this.isWriting) {
      this.pendingWrite = true;
      return;
    }
    
    this.saveData().catch(e => console.error('Failed to save stats', e));
  }

  private async saveData() {
    this.isWriting = true;
    this.pendingWrite = false;
    
    try {
      this.pruneOldEntries();
      
      const tempPath = this.filePath + '.tmp';
      const jsonStr = JSON.stringify(this.data, null, 2);
      
      await fs.writeFile(tempPath, jsonStr, 'utf-8');
      await fs.rename(tempPath, this.filePath);
    } finally {
      this.isWriting = false;
      if (this.pendingWrite) {
        this.scheduleSave();
      }
    }
  }

  getStats(): StatsData {
    // Return a deep copy to prevent mutation
    return JSON.parse(JSON.stringify(this.data));
  }
}
