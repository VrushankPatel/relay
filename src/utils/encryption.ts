/**
 * AES-256-GCM encryption utility for the Relay proxy.
 *
 * Used by:
 * - CacheManager: encrypting cached responses at rest
 * - AuthManager: encrypting persisted GitHub access tokens
 *
 * Key derivation uses PBKDF2 with SHA-256, 100,000 iterations.
 */

import crypto from 'crypto';

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_ITERATIONS = 100000;
const KEY_LENGTH = 32;
const DEFAULT_SALT = 'copilot-proxy-salt';

/**
 * Derive a 256-bit key from a passphrase using PBKDF2.
 * @param secret - The passphrase/secret to derive from
 * @param salt - Optional salt (defaults to 'copilot-proxy-salt' for backward compatibility)
 * @returns 32-byte key buffer
 */
export function deriveKey(secret: string, salt: string = DEFAULT_SALT): Buffer {
  return crypto.pbkdf2Sync(secret, salt, KEY_ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * Encrypt a buffer using AES-256-GCM.
 * Output format: [IV (12 bytes) | Auth Tag (16 bytes) | Ciphertext]
 *
 * @param buffer - Plaintext data to encrypt
 * @param key - 32-byte encryption key (from deriveKey)
 * @returns Encrypted buffer with IV and auth tag prepended
 */
export function encryptBuffer(buffer: Buffer, key: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt a buffer encrypted with encryptBuffer.
 * Expects input format: [IV (12 bytes) | Auth Tag (16 bytes) | Ciphertext]
 *
 * @param buffer - Encrypted data (IV + auth tag + ciphertext)
 * @param key - 32-byte encryption key (same key used for encryption)
 * @returns Decrypted plaintext buffer
 * @throws Error if authentication fails (wrong key or tampered data)
 */
export function decryptBuffer(buffer: Buffer, key: Buffer): Buffer {
  if (buffer.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Encrypted data too short: missing IV or auth tag');
  }
  const iv = buffer.subarray(0, IV_LENGTH);
  const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypt a string and return a JSON-serializable envelope.
 * This is the preferred method for AuthManager token persistence.
 *
 * @param plaintext - String to encrypt
 * @param secret - Passphrase for key derivation
 * @returns Encrypted envelope with hex-encoded fields
 */
export function encryptString(
  plaintext: string,
  secret: string,
): {
  iv: string;
  tag: string;
  data: string;
  salt: string;
} {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = deriveKey(secret, salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf-8')),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    tag: authTag.toString('hex'),
    data: encrypted.toString('hex'),
    salt,
  };
}

/**
 * Decrypt a string from an encrypted envelope.
 *
 * @param envelope - Encrypted envelope from encryptString
 * @param secret - Passphrase for key derivation (must match encryption passphrase)
 * @returns Decrypted plaintext string
 * @throws Error if authentication fails (wrong secret or tampered data)
 */
export function decryptString(
  envelope: {
    iv: string;
    tag: string;
    data: string;
    salt: string;
  },
  secret: string,
): string {
  const key = deriveKey(secret, envelope.salt);
  const iv = Buffer.from(envelope.iv, 'hex');
  const authTag = Buffer.from(envelope.tag, 'hex');
  const ciphertext = Buffer.from(envelope.data, 'hex');
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf-8');
}
