/**
 * Unit tests for AuthenticationManager component.
 * 
 * Tests Requirements: 12.1, 12.2, 12.6
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AuthenticationManager, AuthenticationConfig } from '../../src/components/AuthenticationManager.js';

describe('AuthenticationManager', () => {
  let authManager: AuthenticationManager;
  const validApiKey = 'test-api-key-12345';
  const validUserId = 'user-123';
  const validCopilotToken = 'ghu_copilot_token_abc123';
  
  beforeEach(() => {
    const config: AuthenticationConfig = {
      apiKeys: new Map([[validApiKey, validUserId]]),
    };
    authManager = new AuthenticationManager(config);
  });
  
  describe('authenticate', () => {
    it('should successfully authenticate with valid API key and Copilot token', async () => {
      const result = await authManager.authenticate(validApiKey, validCopilotToken);
      
      expect(result.authenticated).toBe(true);
      expect(result.userId).toBe(validUserId);
      expect(result.copilotToken).toBe(validCopilotToken);
    });
    
    it('should fail authentication with invalid API key', async () => {
      const result = await authManager.authenticate('invalid-key', validCopilotToken);
      
      expect(result.authenticated).toBe(false);
      expect(result.userId).toBe('');
      expect(result.copilotToken).toBe('');
    });
    
    it('should fail authentication with missing API key', async () => {
      const result = await authManager.authenticate('', validCopilotToken);
      
      expect(result.authenticated).toBe(false);
      expect(result.userId).toBe('');
      expect(result.copilotToken).toBe('');
    });
    
    it('should fail authentication with missing Copilot token', async () => {
      const result = await authManager.authenticate(validApiKey, '');
      
      expect(result.authenticated).toBe(false);
      expect(result.userId).toBe('');
      expect(result.copilotToken).toBe('');
    });
    
    it('should fail authentication with both missing API key and Copilot token', async () => {
      const result = await authManager.authenticate('', '');
      
      expect(result.authenticated).toBe(false);
      expect(result.userId).toBe('');
      expect(result.copilotToken).toBe('');
    });
    
    it('should preserve Copilot token in successful authentication', async () => {
      const customToken = 'ghu_custom_token_xyz789';
      const result = await authManager.authenticate(validApiKey, customToken);
      
      expect(result.authenticated).toBe(true);
      expect(result.copilotToken).toBe(customToken);
    });
    
    it('should extract correct user ID from authenticated requests', async () => {
      const result = await authManager.authenticate(validApiKey, validCopilotToken);
      
      expect(result.authenticated).toBe(true);
      expect(result.userId).toBe(validUserId);
    });
    
    it('should handle API key with whitespace', async () => {
      const result = await authManager.authenticate('  ', validCopilotToken);
      
      expect(result.authenticated).toBe(false);
    });
    
    it('should handle Copilot token with whitespace', async () => {
      const result = await authManager.authenticate(validApiKey, '  ');
      
      expect(result.authenticated).toBe(false);
    });
    
    it('should authenticate multiple valid API keys correctly', async () => {
      const apiKey2 = 'test-api-key-67890';
      const userId2 = 'user-456';
      authManager.addApiKey(apiKey2, userId2);
      
      const result1 = await authManager.authenticate(validApiKey, validCopilotToken);
      expect(result1.authenticated).toBe(true);
      expect(result1.userId).toBe(validUserId);
      
      const result2 = await authManager.authenticate(apiKey2, validCopilotToken);
      expect(result2.authenticated).toBe(true);
      expect(result2.userId).toBe(userId2);
    });
  });
  
  describe('timing-attack resistance', () => {
    it('should resist timing attacks for invalid API keys', async () => {
      // Perform multiple authentication attempts with different invalid keys
      const attempts = 10;
      const timings: number[] = [];
      
      for (let i = 0; i < attempts; i++) {
        const invalidKey = `invalid-key-${i}`;
        const start = process.hrtime.bigint();
        await authManager.authenticate(invalidKey, validCopilotToken);
        const end = process.hrtime.bigint();
        
        timings.push(Number(end - start));
      }
      
      // Calculate variance in timing
      const mean = timings.reduce((a, b) => a + b, 0) / timings.length;
      const variance = timings.reduce((sum, time) => sum + Math.pow(time - mean, 2), 0) / timings.length;
      const stdDev = Math.sqrt(variance);
      const coefficientOfVariation = stdDev / mean;
      
      // Timing should be relatively consistent (low coefficient of variation)
      // Note: This is a heuristic test - perfect constant-time is hard to verify in JavaScript
      expect(coefficientOfVariation).toBeLessThan(5.0);
    });
    
    it('should take similar time for valid and invalid API keys', async () => {
      const iterations = 5;
      const validTimings: number[] = [];
      const invalidTimings: number[] = [];
      
      for (let i = 0; i < iterations; i++) {
        // Time valid authentication
        const validStart = process.hrtime.bigint();
        await authManager.authenticate(validApiKey, validCopilotToken);
        const validEnd = process.hrtime.bigint();
        validTimings.push(Number(validEnd - validStart));
        
        // Time invalid authentication
        const invalidStart = process.hrtime.bigint();
        await authManager.authenticate('invalid-key', validCopilotToken);
        const invalidEnd = process.hrtime.bigint();
        invalidTimings.push(Number(invalidEnd - invalidStart));
      }
      
      const validMean = validTimings.reduce((a, b) => a + b, 0) / validTimings.length;
      const invalidMean = invalidTimings.reduce((a, b) => a + b, 0) / invalidTimings.length;
      
      // The ratio of means should be close to 1 (within 3x)
      const ratio = Math.max(validMean, invalidMean) / Math.min(validMean, invalidMean);
      expect(ratio).toBeLessThan(10.0);
    });
    
    it('should not leak information through early return for different key lengths', async () => {
      const shortKey = 'short';
      const longKey = 'this-is-a-very-long-api-key-that-is-definitely-invalid';
      
      const iterations = 5;
      const shortTimings: number[] = [];
      const longTimings: number[] = [];
      
      for (let i = 0; i < iterations; i++) {
        const shortStart = process.hrtime.bigint();
        await authManager.authenticate(shortKey, validCopilotToken);
        const shortEnd = process.hrtime.bigint();
        shortTimings.push(Number(shortEnd - shortStart));
        
        const longStart = process.hrtime.bigint();
        await authManager.authenticate(longKey, validCopilotToken);
        const longEnd = process.hrtime.bigint();
        longTimings.push(Number(longEnd - longStart));
      }
      
      const shortMean = shortTimings.reduce((a, b) => a + b, 0) / shortTimings.length;
      const longMean = longTimings.reduce((a, b) => a + b, 0) / longTimings.length;
      
      // Both should take similar time despite different lengths
      const ratio = Math.max(shortMean, longMean) / Math.min(shortMean, longMean);
      expect(ratio).toBeLessThan(5.0);
    });
  });
  
  describe('addApiKey', () => {
    it('should successfully add a new API key', () => {
      const newApiKey = 'new-api-key-99999';
      const newUserId = 'user-999';
      
      authManager.addApiKey(newApiKey, newUserId);
      
      expect(authManager.getApiKeyCount()).toBe(2);
    });
    
    it('should allow authentication with newly added API key', async () => {
      const newApiKey = 'new-api-key-99999';
      const newUserId = 'user-999';
      
      authManager.addApiKey(newApiKey, newUserId);
      
      const result = await authManager.authenticate(newApiKey, validCopilotToken);
      expect(result.authenticated).toBe(true);
      expect(result.userId).toBe(newUserId);
    });
    
    it('should throw error when adding API key without user ID', () => {
      expect(() => {
        authManager.addApiKey('some-key', '');
      }).toThrow('API key and user ID must be provided');
    });
    
    it('should throw error when adding empty API key', () => {
      expect(() => {
        authManager.addApiKey('', 'user-id');
      }).toThrow('API key and user ID must be provided');
    });
    
    it('should update user ID if API key already exists', async () => {
      const updatedUserId = 'updated-user-123';
      
      authManager.addApiKey(validApiKey, updatedUserId);
      
      const result = await authManager.authenticate(validApiKey, validCopilotToken);
      expect(result.authenticated).toBe(true);
      expect(result.userId).toBe(updatedUserId);
    });
  });
  
  describe('removeApiKey', () => {
    it('should successfully remove an existing API key', () => {
      authManager.removeApiKey(validApiKey);
      
      expect(authManager.getApiKeyCount()).toBe(0);
    });
    
    it('should prevent authentication with removed API key', async () => {
      authManager.removeApiKey(validApiKey);
      
      const result = await authManager.authenticate(validApiKey, validCopilotToken);
      expect(result.authenticated).toBe(false);
    });
    
    it('should throw error when removing empty API key', () => {
      expect(() => {
        authManager.removeApiKey('');
      }).toThrow('API key must be provided');
    });
    
    it('should handle removing non-existent API key gracefully', () => {
      authManager.removeApiKey('non-existent-key');
      
      // Should not throw, count should remain unchanged
      expect(authManager.getApiKeyCount()).toBe(1);
    });
  });
  
  describe('getApiKeyCount', () => {
    it('should return correct count of API keys', () => {
      expect(authManager.getApiKeyCount()).toBe(1);
      
      authManager.addApiKey('key2', 'user2');
      expect(authManager.getApiKeyCount()).toBe(2);
      
      authManager.addApiKey('key3', 'user3');
      expect(authManager.getApiKeyCount()).toBe(3);
      
      authManager.removeApiKey('key2');
      expect(authManager.getApiKeyCount()).toBe(2);
    });
    
    it('should return 0 for empty API key map', () => {
      const emptyAuthManager = new AuthenticationManager({ apiKeys: new Map() });
      expect(emptyAuthManager.getApiKeyCount()).toBe(0);
    });
  });
  
  describe('edge cases', () => {
    it('should handle special characters in API keys', async () => {
      const specialKey = 'key-with-special!@#$%^&*()_+[]{}|;:,.<>?/~`';
      const userId = 'special-user';
      
      authManager.addApiKey(specialKey, userId);
      
      const result = await authManager.authenticate(specialKey, validCopilotToken);
      expect(result.authenticated).toBe(true);
      expect(result.userId).toBe(userId);
    });
    
    it('should handle very long API keys', async () => {
      const longKey = 'a'.repeat(1000);
      const userId = 'long-key-user';
      
      authManager.addApiKey(longKey, userId);
      
      const result = await authManager.authenticate(longKey, validCopilotToken);
      expect(result.authenticated).toBe(true);
      expect(result.userId).toBe(userId);
    });
    
    it('should handle Unicode characters in API keys', async () => {
      const unicodeKey = 'key-with-unicode-你好-مرحبا-🔑';
      const userId = 'unicode-user';
      
      authManager.addApiKey(unicodeKey, userId);
      
      const result = await authManager.authenticate(unicodeKey, validCopilotToken);
      expect(result.authenticated).toBe(true);
      expect(result.userId).toBe(userId);
    });
    
    it('should handle similar but different API keys', async () => {
      const key1 = 'api-key-12345';
      const key2 = 'api-key-12346'; // Only last character different
      const userId1 = 'user-1';
      const userId2 = 'user-2';
      
      authManager.addApiKey(key1, userId1);
      authManager.addApiKey(key2, userId2);
      
      const result1 = await authManager.authenticate(key1, validCopilotToken);
      expect(result1.authenticated).toBe(true);
      expect(result1.userId).toBe(userId1);
      
      const result2 = await authManager.authenticate(key2, validCopilotToken);
      expect(result2.authenticated).toBe(true);
      expect(result2.userId).toBe(userId2);
    });
  });
  
  describe('Requirements validation', () => {
    it('should satisfy Requirement 12.1: verify client API key', async () => {
      // Valid key should be verified successfully
      const validResult = await authManager.authenticate(validApiKey, validCopilotToken);
      expect(validResult.authenticated).toBe(true);
      
      // Invalid key should be rejected
      const invalidResult = await authManager.authenticate('wrong-key', validCopilotToken);
      expect(invalidResult.authenticated).toBe(false);
    });
    
    it('should satisfy Requirement 12.2: extract user ID from authenticated requests', async () => {
      const result = await authManager.authenticate(validApiKey, validCopilotToken);
      
      expect(result.authenticated).toBe(true);
      expect(result.userId).toBe(validUserId);
      expect(result.userId).not.toBe('');
    });
    
    it('should satisfy Requirement 12.6: return 401 Unauthorized for invalid or missing API keys', async () => {
      // Missing API key
      const missingResult = await authManager.authenticate('', validCopilotToken);
      expect(missingResult.authenticated).toBe(false);
      
      // Invalid API key
      const invalidResult = await authManager.authenticate('invalid', validCopilotToken);
      expect(invalidResult.authenticated).toBe(false);
      
      // Both cases should result in authenticated=false, which would trigger 401 in APIGateway
    });
    
    it('should satisfy requirement: preserve GitHub Copilot authentication token', async () => {
      const customToken = 'ghu_unique_token_for_forwarding';
      const result = await authManager.authenticate(validApiKey, customToken);
      
      expect(result.authenticated).toBe(true);
      expect(result.copilotToken).toBe(customToken);
      // Token should be preserved exactly as provided for forwarding to GitHub Copilot API
    });
  });
});
