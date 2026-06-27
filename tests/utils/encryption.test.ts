import { describe, it, expect } from 'vitest';
import {
  deriveKey,
  encryptBuffer,
  decryptBuffer,
  encryptString,
  decryptString,
} from '../../src/utils/encryption.js';

describe('Encryption Utility', () => {
  describe('deriveKey', () => {
    it('should derive a 32-byte key', () => {
      const key = deriveKey('test-secret');
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('should derive the same key for the same secret and salt', () => {
      const key1 = deriveKey('test-secret', 'salt1');
      const key2 = deriveKey('test-secret', 'salt1');
      expect(key1.equals(key2)).toBe(true);
    });

    it('should derive different keys for different secrets', () => {
      const key1 = deriveKey('secret-1');
      const key2 = deriveKey('secret-2');
      expect(key1.equals(key2)).toBe(false);
    });

    it('should derive different keys for different salts', () => {
      const key1 = deriveKey('same-secret', 'salt-1');
      const key2 = deriveKey('same-secret', 'salt-2');
      expect(key1.equals(key2)).toBe(false);
    });
  });

  describe('encryptBuffer / decryptBuffer', () => {
    it('should encrypt and decrypt a buffer round-trip', () => {
      const key = deriveKey('test-secret');
      const plaintext = Buffer.from('Hello, Relay!', 'utf-8');
      const encrypted = encryptBuffer(plaintext, key);
      const decrypted = decryptBuffer(encrypted, key);
      expect(decrypted.toString('utf-8')).toBe('Hello, Relay!');
    });

    it('should produce different ciphertext for the same plaintext (random IV)', () => {
      const key = deriveKey('test-secret');
      const plaintext = Buffer.from('same data', 'utf-8');
      const enc1 = encryptBuffer(plaintext, key);
      const enc2 = encryptBuffer(plaintext, key);
      expect(enc1.equals(enc2)).toBe(false);
    });

    it('should fail to decrypt with wrong key', () => {
      const key1 = deriveKey('secret-1');
      const key2 = deriveKey('secret-2');
      const plaintext = Buffer.from('sensitive data', 'utf-8');
      const encrypted = encryptBuffer(plaintext, key1);
      expect(() => decryptBuffer(encrypted, key2)).toThrow();
    });

    it('should fail on tampered data', () => {
      const key = deriveKey('test-secret');
      const plaintext = Buffer.from('important data', 'utf-8');
      const encrypted = encryptBuffer(plaintext, key);
      // Flip a byte in the ciphertext
      encrypted[encrypted.length - 1] ^= 0xff;
      expect(() => decryptBuffer(encrypted, key)).toThrow();
    });

    it('should fail on data too short', () => {
      const key = deriveKey('test-secret');
      const tooShort = Buffer.alloc(10);
      expect(() => decryptBuffer(tooShort, key)).toThrow('Encrypted data too short');
    });
  });

  describe('encryptString / decryptString', () => {
    it('should encrypt and decrypt a string round-trip', () => {
      const plaintext = 'ghu_abc123def456';
      const secret = 'my-encryption-secret';
      const envelope = encryptString(plaintext, secret);
      const decrypted = decryptString(envelope, secret);
      expect(decrypted).toBe(plaintext);
    });

    it('should produce different envelopes for same input (random salt + IV)', () => {
      const plaintext = 'same token';
      const secret = 'same secret';
      const env1 = encryptString(plaintext, secret);
      const env2 = encryptString(plaintext, secret);
      expect(env1.data).not.toBe(env2.data);
      expect(env1.salt).not.toBe(env2.salt);
    });

    it('should fail to decrypt with wrong secret', () => {
      const plaintext = 'ghu_secret_token';
      const envelope = encryptString(plaintext, 'correct-secret');
      expect(() => decryptString(envelope, 'wrong-secret')).toThrow();
    });

    it('should handle empty string', () => {
      const envelope = encryptString('', 'secret');
      const decrypted = decryptString(envelope, 'secret');
      expect(decrypted).toBe('');
    });

    it('should handle unicode content', () => {
      const plaintext = '🔐 encrypted token: αβγδ';
      const envelope = encryptString(plaintext, 'unicode-secret');
      const decrypted = decryptString(envelope, 'unicode-secret');
      expect(decrypted).toBe(plaintext);
    });

    it('envelope should be JSON serializable', () => {
      const envelope = encryptString('test', 'secret');
      const json = JSON.stringify(envelope);
      const parsed = JSON.parse(json);
      expect(decryptString(parsed, 'secret')).toBe('test');
    });
  });
});
