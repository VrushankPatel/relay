/**
 * Authentication Manager for the GitHub Copilot Token Optimizer Proxy.
 * 
 * This component handles API key verification for incoming requests,
 * extracts user identity information, and preserves GitHub Copilot
 * authentication tokens for forwarding to the Copilot API.
 * 
 * Requirements: 12.1, 12.2, 12.6
 */

import crypto from 'crypto';
import { AuthResult } from '../types/requests.js';
import { logger } from '../utils/logger.js';

/**
 * Configuration for the Authentication Manager.
 */
export interface AuthenticationConfig {
  /** Map of valid API keys to user IDs */
  apiKeys: Map<string, string>;
}

/**
 * Authentication Manager interface defining authentication operations.
 */
export interface IAuthenticationManager {
  /**
   * Verify an API key and extract authentication information.
   * 
   * @param apiKey - The API key from the request headers
   * @param copilotToken - The GitHub Copilot authentication token from headers
   * @returns Promise resolving to authentication result
   */
  authenticate(apiKey: string, copilotToken: string): Promise<AuthResult>;
  
  /**
   * Add a valid API key for a user.
   * 
   * @param apiKey - The API key to add
   * @param userId - The user ID associated with this key
   */
  addApiKey(apiKey: string, userId: string): void;
  
  /**
   * Remove an API key.
   * 
   * @param apiKey - The API key to remove
   */
  removeApiKey(apiKey: string): void;
}

/**
 * Implementation of the Authentication Manager.
 * 
 * Provides:
 * - API key verification with timing-attack resistance
 * - User ID extraction from authenticated requests
 * - GitHub Copilot token preservation
 * - 401 Unauthorized responses for invalid/missing API keys
 */
export class AuthenticationManager implements IAuthenticationManager {
  private readonly apiKeys: Map<string, string>;
  
  /**
   * Creates a new Authentication Manager instance.
   * 
   * @param config - Configuration containing valid API keys
   */
  constructor(config: AuthenticationConfig) {
    this.apiKeys = new Map(config.apiKeys);
    logger.info({ keyCount: this.apiKeys.size }, 'Authentication Manager initialized');
  }
  
  /**
   * Verify an API key and extract authentication information.
   * 
   * Uses timing-attack resistant comparison to prevent information
   * leakage through timing side channels.
   * 
   * Requirements:
   * - 12.1: Verify client API key
   * - 12.2: Extract user ID from authenticated requests
   * - 12.6: Return 401 for invalid or missing API keys
   */
  async authenticate(apiKey: string, copilotToken: string): Promise<AuthResult> {
    // Check if API key is provided
    if (!apiKey || apiKey.trim() === '') {
      logger.debug('Authentication failed: missing API key');
      return {
        authenticated: false,
        userId: '',
        copilotToken: '',
      };
    }
    
    // Check if Copilot token is provided
    if (!copilotToken || copilotToken.trim() === '') {
      logger.debug('Authentication failed: missing Copilot token');
      return {
        authenticated: false,
        userId: '',
        copilotToken: '',
      };
    }
    
    // Verify API key using timing-attack resistant comparison
    const userId = await this.verifyApiKey(apiKey);
    
    if (userId === null) {
      logger.debug({ apiKeyPrefix: this.getApiKeyPrefix(apiKey) }, 'Authentication failed: invalid API key');
      return {
        authenticated: false,
        userId: '',
        copilotToken: '',
      };
    }
    
    logger.debug({ userId }, 'Authentication successful');
    
    // Return successful authentication result with preserved Copilot token
    return {
      authenticated: true,
      userId,
      copilotToken,
    };
  }
  
  /**
   * Verify an API key against the stored valid keys.
   * 
   * Uses constant-time comparison to prevent timing attacks that could
   * leak information about valid API keys through response time differences.
   * 
   * @param apiKey - The API key to verify
   * @returns The user ID if valid, null if invalid
   */
  private async verifyApiKey(apiKey: string): Promise<string | null> {
    let foundUserId: string | null = null;
    
    // Check against all stored API keys using timing-attack resistant comparison
    for (const [validKey, userId] of this.apiKeys.entries()) {
      // Use Node.js crypto.timingSafeEqual for constant-time comparison
      // Both strings must be converted to buffers of the same length
      const isMatch = this.timingSafeCompare(apiKey, validKey);
      
      if (isMatch) {
        foundUserId = userId;
        // Don't break early - continue checking all keys to maintain constant time
      }
    }
    
    return foundUserId;
  }
  
  /**
   * Perform timing-attack resistant string comparison.
   * 
   * This method ensures that the comparison takes the same amount of time
   * regardless of where the strings differ, preventing attackers from
   * using timing information to guess valid API keys.
   * 
   * @param input - The input string to compare
   * @param valid - The valid string to compare against
   * @returns True if strings match, false otherwise
   */
  private timingSafeCompare(input: string, valid: string): boolean {
    // Convert strings to buffers
    const inputBuffer = Buffer.from(input, 'utf8');
    const validBuffer = Buffer.from(valid, 'utf8');
    
    // If lengths differ, still perform comparison with a dummy buffer
    // to maintain constant time
    if (inputBuffer.length !== validBuffer.length) {
      // Create dummy buffer of same length as valid for comparison
      const dummyBuffer = Buffer.alloc(validBuffer.length);
      crypto.timingSafeEqual(validBuffer, dummyBuffer);
      return false;
    }
    
    // Perform constant-time comparison
    try {
      return crypto.timingSafeEqual(inputBuffer, validBuffer);
    } catch (error) {
      // If comparison fails for any reason, return false
      logger.error({ error }, 'Error during timing-safe comparison');
      return false;
    }
  }
  
  /**
   * Add a valid API key for a user.
   * 
   * @param apiKey - The API key to add
   * @param userId - The user ID associated with this key
   */
  addApiKey(apiKey: string, userId: string): void {
    if (!apiKey || !userId) {
      throw new Error('API key and user ID must be provided');
    }
    
    this.apiKeys.set(apiKey, userId);
    logger.info({ userId, apiKeyPrefix: this.getApiKeyPrefix(apiKey) }, 'API key added');
  }
  
  /**
   * Remove an API key.
   * 
   * @param apiKey - The API key to remove
   */
  removeApiKey(apiKey: string): void {
    if (!apiKey) {
      throw new Error('API key must be provided');
    }
    
    const removed = this.apiKeys.delete(apiKey);
    if (removed) {
      logger.info({ apiKeyPrefix: this.getApiKeyPrefix(apiKey) }, 'API key removed');
    }
  }
  
  /**
   * Get a safe prefix of an API key for logging.
   * 
   * Returns the first 8 characters to help identify keys in logs
   * without exposing the full key.
   * 
   * @param apiKey - The API key
   * @returns Safe prefix for logging
   */
  private getApiKeyPrefix(apiKey: string): string {
    if (apiKey.length <= 8) {
      return '***';
    }
    return apiKey.substring(0, 8) + '...';
  }
  
  /**
   * Get the number of registered API keys.
   * 
   * @returns The count of valid API keys
   */
  getApiKeyCount(): number {
    return this.apiKeys.size;
  }
}
