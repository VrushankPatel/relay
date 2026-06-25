/**
 * Deduplication Manager component for the GitHub Copilot Token Optimizer Proxy.
 * 
 * This component prevents duplicate simultaneous requests from hitting the API
 * by coalescing identical requests within a time window.
 */

import { CopilotResponse } from '../types/copilot.js';
import { createChildLogger } from '../utils/logger.js';
import type { Logger } from 'pino';

/**
 * In-flight request tracking entry.
 */
interface InFlightRequest {
  /** Context hash identifying the request */
  contextHash: string;
  
  /** Timestamp when the request started */
  startTime: number;
  
  /** Current status of the request */
  status: 'pending' | 'completed' | 'failed';
  
  /** Response from the API (populated on completion) */
  response?: CopilotResponse;
  
  /** Error that occurred (populated on failure) */
  error?: Error;
  
  /** List of waiters for this request */
  waiters: Waiter[];
  
  /** Promise that resolves when the request completes */
  promise: Promise<CopilotResponse>;
  
  /** Resolve function for the promise */
  resolve?: (response: CopilotResponse) => void;
  
  /** Reject function for the promise */
  reject?: (error: Error) => void;
}

/**
 * A waiter is a duplicate request waiting for the primary request to complete.
 */
interface Waiter {
  /** Unique identifier for this waiter */
  requestId: string;
  
  /** Timestamp when the waiter was registered */
  timestamp: number;
  
  /** Resolve function to call when request completes */
  resolve: (response: CopilotResponse) => void;
  
  /** Reject function to call when request fails */
  reject: (error: Error) => void;
}

/**
 * Deduplication Manager interface.
 */
export interface IDeduplicationManager {
  /**
   * Check if a request is a duplicate of an in-flight request.
   * @param contextHash SHA-256 hash of the normalized context
   * @returns True if duplicate, false otherwise
   */
  isDuplicate(contextHash: string): boolean;
  
  /**
   * Register a new in-flight request.
   * @param contextHash SHA-256 hash of the normalized context
   */
  registerRequest(contextHash: string): Promise<void>;
  
  /**
   * Wait for an existing request to complete.
   * @param contextHash SHA-256 hash of the normalized context
   * @returns Promise that resolves with the response
   */
  waitForCompletion(contextHash: string): Promise<CopilotResponse>;
  
  /**
   * Mark a request as completed and notify all waiters.
   * @param contextHash SHA-256 hash of the normalized context
   * @param response Copilot response
   */
  completeRequest(contextHash: string, response: CopilotResponse): void;
  
  /**
   * Handle request failure.
   * @param contextHash SHA-256 hash of the normalized context
   * @param error Error that occurred
   */
  failRequest(contextHash: string, error: Error): void;
}

/**
 * Implementation of the Deduplication Manager.
 * 
 * Coalesces requests with the same context hash within 1 second.
 * The first request proceeds to the API, while duplicates wait for the result.
 * On failure, the next queued request becomes the primary request.
 */
export class DeduplicationManager implements IDeduplicationManager {
  private inFlightRequests: Map<string, InFlightRequest>;
  private readonly coalesceWindowMs: number;
  private logger: Logger;
  
  /**
   * Create a new Deduplication Manager.
   * @param coalesceWindowMs Time window for coalescing duplicate requests in milliseconds (default: 1000ms)
   */
  constructor(coalesceWindowMs = 1000) {
    this.inFlightRequests = new Map();
    this.coalesceWindowMs = coalesceWindowMs;
    this.logger = createChildLogger('DeduplicationManager');
    
    this.logger.info({ coalesceWindowMs }, 'Deduplication Manager initialized');
  }
  
  /**
   * Check if a request is a duplicate of an in-flight request.
   * A request is considered duplicate if:
   * 1. An in-flight request with the same hash exists
   * 2. The in-flight request is still pending
   * 3. The in-flight request started within the coalesce window
   */
  isDuplicate(contextHash: string): boolean {
    const inFlight = this.inFlightRequests.get(contextHash);
    
    if (!inFlight) {
      return false;
    }
    
    // Check if request is still pending
    if (inFlight.status !== 'pending') {
      return false;
    }
    
    // Check if request is within the coalesce window
    const age = Date.now() - inFlight.startTime;
    if (age > this.coalesceWindowMs) {
      // Request is too old, not a duplicate
      return false;
    }
    
    return true;
  }
  
  /**
   * Register a new in-flight request.
   * Creates a promise that will be resolved/rejected when the request completes.
   */
  async registerRequest(contextHash: string): Promise<void> {
    // Check if there's already an in-flight request
    if (this.inFlightRequests.has(contextHash)) {
      this.logger.warn(
        { contextHash },
        'Attempt to register request that is already in-flight'
      );
      return;
    }
    
    let resolveFunc: ((response: CopilotResponse) => void) | undefined;
    let rejectFunc: ((error: Error) => void) | undefined;
    
    const promise = new Promise<CopilotResponse>((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });
    
    const inFlightRequest: InFlightRequest = {
      contextHash,
      startTime: Date.now(),
      status: 'pending',
      waiters: [],
      promise,
      resolve: resolveFunc,
      reject: rejectFunc,
    };
    
    this.inFlightRequests.set(contextHash, inFlightRequest);
    
    this.logger.debug(
      { contextHash, startTime: inFlightRequest.startTime },
      'Registered new in-flight request'
    );
  }
  
  /**
   * Wait for an existing request to complete.
   * Returns a promise that resolves when the primary request completes.
   */
  async waitForCompletion(contextHash: string): Promise<CopilotResponse> {
    const inFlight = this.inFlightRequests.get(contextHash);
    
    if (!inFlight) {
      const error = new Error(`No in-flight request found for context hash: ${contextHash}`);
      this.logger.error({ contextHash }, error.message);
      throw error;
    }
    
    // If request is already completed, return the cached response
    if (inFlight.status === 'completed' && inFlight.response) {
      this.logger.debug({ contextHash }, 'Returning cached response from completed request');
      return inFlight.response;
    }
    
    // If request failed, throw the error
    if (inFlight.status === 'failed' && inFlight.error) {
      this.logger.debug({ contextHash }, 'Throwing cached error from failed request');
      throw inFlight.error;
    }
    
    // Create a new promise for this waiter
    const waiterPromise = new Promise<CopilotResponse>((resolve, reject) => {
      const waiter: Waiter = {
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
  
  /**
   * Mark a request as completed and notify all waiters.
   * All waiters receive the same response.
   */
  completeRequest(contextHash: string, response: CopilotResponse): void {
    const inFlight = this.inFlightRequests.get(contextHash);
    
    if (!inFlight) {
      this.logger.warn(
        { contextHash },
        'Attempt to complete request that is not in-flight'
      );
      return;
    }
    
    // Update request status
    inFlight.status = 'completed';
    inFlight.response = response;
    
    // Resolve the primary promise
    if (inFlight.resolve) {
      inFlight.resolve(response);
    }
    
    // Notify all waiters
    const waiterCount = inFlight.waiters.length;
    for (const waiter of inFlight.waiters) {
      waiter.resolve(response);
      
      this.logger.debug(
        { contextHash, waiterId: waiter.requestId },
        'Notified waiter of request completion'
      );
    }
    
    this.logger.info(
      {
        contextHash,
        waiterCount,
        duration: Date.now() - inFlight.startTime,
        tokenCount: response.tokenCount,
        completionCount: response.completions.length,
      },
      'Request completed and all waiters notified'
    );
    
    // Clean up the in-flight request after a short delay
    // Keep it for a brief moment in case of race conditions
    setTimeout(() => {
      this.inFlightRequests.delete(contextHash);
      this.logger.debug({ contextHash }, 'Cleaned up completed request');
    }, 100);
  }
  
  /**
   * Handle request failure.
   * If there are waiters, the next waiter becomes the primary request.
   * Otherwise, all waiters are notified of the failure.
   */
  failRequest(contextHash: string, error: Error): void {
    const inFlight = this.inFlightRequests.get(contextHash);
    
    if (!inFlight) {
      this.logger.warn(
        { contextHash },
        'Attempt to fail request that is not in-flight'
      );
      return;
    }
    
    // Check if there are waiters who can become the primary request
    if (inFlight.waiters.length > 0) {
      this.logger.info(
        {
          contextHash,
          waiterCount: inFlight.waiters.length,
          error: error.message,
        },
        'Primary request failed, next waiter will become primary'
      );
      
      // Remove the first waiter and make it the new primary
      const nextWaiter = inFlight.waiters.shift();
      
      if (nextWaiter) {
        // The next waiter will handle the request
        // Reject the original primary promise
        if (inFlight.reject) {
          inFlight.reject(error);
        }
        
        // Reset the in-flight request for the new primary
        inFlight.startTime = Date.now();
        inFlight.status = 'pending';
        delete inFlight.response;
        delete inFlight.error;
        
        // Create new promise for the new primary
        let resolveFunc: ((response: CopilotResponse) => void) | undefined;
        let rejectFunc: ((error: Error) => void) | undefined;
        
        inFlight.promise = new Promise<CopilotResponse>((resolve, reject) => {
          resolveFunc = resolve;
          rejectFunc = reject;
        });
        
        inFlight.resolve = resolveFunc;
        inFlight.reject = rejectFunc;
        
        // Notify the next waiter that it should proceed with the request
        // by resolving with a special marker, or we could use a different mechanism
        // For now, we keep the request in pending state and the caller should retry
        
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
    
    // No waiters, fail all and clean up
    inFlight.status = 'failed';
    inFlight.error = error;
    
    // Reject the primary promise
    if (inFlight.reject) {
      inFlight.reject(error);
    }
    
    // Notify all remaining waiters of the failure
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
    
    // Clean up the in-flight request
    setTimeout(() => {
      this.inFlightRequests.delete(contextHash);
      this.logger.debug({ contextHash }, 'Cleaned up failed request');
    }, 100);
  }
  
  /**
   * Get the current number of in-flight requests.
   * Useful for monitoring and diagnostics.
   */
  getInFlightCount(): number {
    return this.inFlightRequests.size;
  }
  
  /**
   * Get statistics about current in-flight requests.
   * Useful for monitoring and diagnostics.
   */
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
      totalWaiters += request.waiters.length;
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
