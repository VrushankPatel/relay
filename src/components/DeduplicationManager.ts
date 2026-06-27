import { createChildLogger } from '../utils/logger.js';
import type { Logger } from 'pino';

const DEFAULT_COALESCE_WINDOW_MS = 1000;
const CLEANUP_DELAY_MS = 100;

export interface StreamWaiter<C = any> {
  requestId: string;
  timestamp: number;
  onChunk: (chunk: C) => void;
  onComplete: () => void;
  onError: (error: Error) => void;
}

export interface Waiter<T = any> {
  requestId: string;
  timestamp: number;
  resolve: (response: T) => void;
  reject: (error: Error) => void;
}

export interface InFlightRequest<T = any, C = any> {
  contextHash: string;
  startTime: number;
  status: 'pending' | 'completed' | 'failed';
  isStream: boolean;
  
  response?: T;
  error?: Error;
  
  waiters: Waiter<T>[];
  promise: Promise<T>;
  resolve?: (response: T) => void;
  reject?: (error: Error) => void;

  chunks: C[];
  streamWaiters: StreamWaiter<C>[];
}

export interface IDeduplicationManager<T = any, C = any> {
  isDuplicate(contextHash: string): boolean;
  registerRequest(contextHash: string, isStream?: boolean): Promise<void>;
  
  waitForCompletion(contextHash: string): Promise<T>;
  completeRequest(contextHash: string, response: T): void;
  
  waitForStream(contextHash: string): AsyncIterable<C>;
  addStreamChunk(contextHash: string, chunk: C): void;
  completeStream(contextHash: string): void;
  
  failRequest(contextHash: string, error: Error): void;
}

export class DeduplicationManager<T = any, C = any> implements IDeduplicationManager<T, C> {
  private inFlightRequests: Map<string, InFlightRequest<T, C>>;
  private readonly coalesceWindowMs: number;
  private logger: Logger;
  
  constructor(coalesceWindowMs = DEFAULT_COALESCE_WINDOW_MS) {
    this.inFlightRequests = new Map();
    this.coalesceWindowMs = coalesceWindowMs;
    this.logger = createChildLogger('DeduplicationManager');
    
    this.logger.info({ coalesceWindowMs }, 'Deduplication Manager initialized');
  }
  
  isDuplicate(contextHash: string): boolean {
    const inFlight = this.inFlightRequests.get(contextHash);
    
    if (!inFlight) {
      return false;
    }
    
    if (inFlight.status !== 'pending') {
      return false;
    }
    
    const age = Date.now() - inFlight.startTime;
    if (age > this.coalesceWindowMs) {
      return false;
    }
    
    return true;
  }
  
  async registerRequest(contextHash: string, isStream: boolean = false): Promise<void> {
    if (this.inFlightRequests.has(contextHash)) {
      this.logger.warn(
        { contextHash },
        'Attempt to register request that is already in-flight'
      );
      return;
    }
    
    let resolveFunc: ((response: T) => void) | undefined;
    let rejectFunc: ((error: Error) => void) | undefined;
    
    const promise = new Promise<T>((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });
    promise.catch(() => {}); // suppress unhandled rejection
    
    const inFlightRequest: InFlightRequest<T, C> = {
      contextHash,
      startTime: Date.now(),
      status: 'pending',
      isStream,
      waiters: [],
      promise,
      resolve: resolveFunc,
      reject: rejectFunc,
      chunks: [],
      streamWaiters: [],
    };
    
    this.inFlightRequests.set(contextHash, inFlightRequest);
    
    this.logger.debug(
      { contextHash, startTime: inFlightRequest.startTime, isStream },
      'Registered new in-flight request'
    );
  }
  
  async waitForCompletion(contextHash: string): Promise<T> {
    const inFlight = this.inFlightRequests.get(contextHash);
    
    if (!inFlight) {
      const error = new Error(`No in-flight request found for context hash: ${contextHash}`);
      this.logger.error({ contextHash }, error.message);
      throw error;
    }
    
    if (inFlight.isStream) {
      throw new Error(`Request for context hash ${contextHash} is a stream, use waitForStream instead`);
    }
    
    if (inFlight.status === 'completed' && inFlight.response !== undefined) {
      this.logger.debug({ contextHash }, 'Returning cached response from completed request');
      return inFlight.response;
    }
    
    if (inFlight.status === 'failed' && inFlight.error) {
      this.logger.debug({ contextHash }, 'Throwing cached error from failed request');
      throw inFlight.error;
    }
    
    const waiterPromise = new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = {
        requestId: `waiter-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        timestamp: Date.now(),
        resolve,
        reject,
      };
      
      inFlight.waiters.push(waiter);
      
      this.logger.debug(
        { contextHash, waiterId: waiter.requestId, waiterCount: inFlight.waiters.length },
        'Added waiter for in-flight request'
      );
    });
    
    return waiterPromise;
  }
  
  completeRequest(contextHash: string, response: T): void {
    const inFlight = this.inFlightRequests.get(contextHash);
    
    if (!inFlight) {
      this.logger.warn(
        { contextHash },
        'Attempt to complete request that is not in-flight'
      );
      return;
    }
    
    if (inFlight.isStream) {
      this.logger.warn(
        { contextHash },
        'Attempt to complete stream request with completeRequest, use completeStream instead'
      );
      return;
    }
    
    inFlight.status = 'completed';
    inFlight.response = response;
    
    if (inFlight.resolve) {
      inFlight.resolve(response);
    }
    
    const waiterCount = inFlight.waiters.length;
    for (const waiter of inFlight.waiters) {
      waiter.resolve(response);
      
      this.logger.debug(
        { contextHash, waiterId: waiter.requestId },
        'Notified waiter of request completion'
      );
    }
    
    const tokenCount = response && typeof response === 'object' && 'tokenCount' in response ? (response as any).tokenCount : undefined;
    const completionCount = response && typeof response === 'object' && 'completions' in response ? (response as any).completions?.length : undefined;

    this.logger.info(
      {
        contextHash,
        waiterCount,
        duration: Date.now() - inFlight.startTime,
        tokenCount,
        completionCount,
      },
      'Request completed and all waiters notified'
    );
    
    setTimeout(() => {
      this.inFlightRequests.delete(contextHash);
      this.logger.debug({ contextHash }, 'Cleaned up completed request');
    }, CLEANUP_DELAY_MS);
  }
  
  async *waitForStream(contextHash: string): AsyncIterable<C> {
    const inFlight = this.inFlightRequests.get(contextHash);
    
    if (!inFlight) {
      throw new Error(`No in-flight request found for context hash: ${contextHash}`);
    }
    
    if (!inFlight.isStream) {
      throw new Error(`Request for context hash ${contextHash} is not a stream`);
    }

    let index = 0;
    
    while (index < inFlight.chunks.length) {
      yield inFlight.chunks[index++];
    }

    let isComplete = inFlight.status === 'completed';
    let hasError = inFlight.status === 'failed';
    let err = inFlight.error;

    if (isComplete) return;
    if (hasError && err) throw err;

    let resolveNext: (() => void) | null = null;
    let rejectNext: ((err: Error) => void) | null = null;

    const waiter: StreamWaiter<C> = {
      requestId: `stream-waiter-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      timestamp: Date.now(),
      onChunk: () => {
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
          rejectNext = null;
        }
      },
      onComplete: () => {
        isComplete = true;
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
          rejectNext = null;
        }
      },
      onError: (e) => {
        hasError = true;
        err = e;
        if (rejectNext) {
          rejectNext(e);
          resolveNext = null;
          rejectNext = null;
        }
      }
    };

    inFlight.streamWaiters.push(waiter);
    this.logger.debug({ contextHash, waiterId: waiter.requestId }, 'Added stream waiter');

    try {
      while (true) {
        if (index < inFlight.chunks.length) {
          yield inFlight.chunks[index++];
        } else if (hasError) {
          throw err || new Error('Stream failed');
        } else if (isComplete) {
          return;
        } else {
          await new Promise<void>((resolve, reject) => {
            resolveNext = resolve;
            rejectNext = reject;
          });
        }
      }
    } finally {
      const wIndex = inFlight.streamWaiters.indexOf(waiter);
      if (wIndex !== -1) {
        inFlight.streamWaiters.splice(wIndex, 1);
      }
    }
  }

  addStreamChunk(contextHash: string, chunk: C): void {
    const inFlight = this.inFlightRequests.get(contextHash);
    if (!inFlight || !inFlight.isStream) {
      return;
    }
    
    inFlight.chunks.push(chunk);
    
    for (const waiter of inFlight.streamWaiters) {
      waiter.onChunk(chunk);
    }
  }

  completeStream(contextHash: string): void {
    const inFlight = this.inFlightRequests.get(contextHash);
    if (!inFlight || !inFlight.isStream) {
      return;
    }
    
    inFlight.status = 'completed';
    
    for (const waiter of inFlight.streamWaiters) {
      waiter.onComplete();
    }
    
    this.logger.info(
      { contextHash, streamWaiterCount: inFlight.streamWaiters.length, chunks: inFlight.chunks.length },
      'Stream request completed'
    );
    
    setTimeout(() => {
      this.inFlightRequests.delete(contextHash);
      this.logger.debug({ contextHash }, 'Cleaned up completed stream request');
    }, CLEANUP_DELAY_MS);
  }

  failRequest(contextHash: string, error: Error): void {
    const inFlight = this.inFlightRequests.get(contextHash);
    
    if (!inFlight) {
      this.logger.warn(
        { contextHash },
        'Attempt to fail request that is not in-flight'
      );
      return;
    }

    if (inFlight.isStream) {
      inFlight.status = 'failed';
      inFlight.error = error;
      for (const waiter of inFlight.streamWaiters) {
        waiter.onError(error);
      }
      this.logger.error(
        { contextHash, error: error.message },
        'Stream request failed'
      );
      setTimeout(() => {
        this.inFlightRequests.delete(contextHash);
      }, CLEANUP_DELAY_MS);
      return;
    }
    
    if (inFlight.waiters.length > 0) {
      this.logger.info(
        {
          contextHash,
          waiterCount: inFlight.waiters.length,
          error: error.message,
        },
        'Primary request failed, next waiter will become primary'
      );
      
      const nextWaiter = inFlight.waiters.shift();
      
      if (nextWaiter) {
        if (inFlight.reject) {
          inFlight.reject(error);
        }

        inFlight.startTime = Date.now();
        inFlight.status = 'pending';
        delete inFlight.response;
        delete inFlight.error;

        inFlight.resolve = nextWaiter.resolve;
        inFlight.reject = nextWaiter.reject;
        inFlight.promise = new Promise<T>(() => {});
        inFlight.promise.catch(() => {});

        this.logger.debug(
          {
            contextHash,
            newPrimaryWaiterId: nextWaiter.requestId,
            remainingWaiters: inFlight.waiters.length,
          },
          'New primary request established'
        );

        return;
      }
    }
    
    inFlight.status = 'failed';
    inFlight.error = error;
    
    if (inFlight.reject) {
      inFlight.reject(error);
    }
    
    for (const waiter of inFlight.waiters) {
      waiter.reject(error);
      
      this.logger.debug(
        { contextHash, waiterId: waiter.requestId },
        'Notified waiter of request failure'
      );
    }
    
    this.logger.error(
      {
        contextHash,
        waiterCount: inFlight.waiters.length,
        duration: Date.now() - inFlight.startTime,
        error: error.message,
      },
      'Request failed and all waiters notified'
    );
    
    setTimeout(() => {
      this.inFlightRequests.delete(contextHash);
      this.logger.debug({ contextHash }, 'Cleaned up failed request');
    }, 100);
  }
  
  getInFlightCount(): number {
    return this.inFlightRequests.size;
  }
  
  getStatistics(): {
    inFlightCount: number;
    totalWaiters: number;
    avgWaitersPerRequest: number;
    oldestRequestAge: number;
  } {
    const inFlightCount = this.inFlightRequests.size;
    let totalWaiters = 0;
    let oldestRequestAge = 0;
    
    for (const request of this.inFlightRequests.values()) {
      totalWaiters += request.isStream ? request.streamWaiters.length : request.waiters.length;
      const age = Date.now() - request.startTime;
      if (age > oldestRequestAge) {
        oldestRequestAge = age;
      }
    }
    
    const avgWaitersPerRequest = inFlightCount > 0 ? totalWaiters / inFlightCount : 0;
    
    return {
      inFlightCount,
      totalWaiters,
      avgWaitersPerRequest,
      oldestRequestAge,
    };
  }
}
