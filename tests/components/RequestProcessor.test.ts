import { describe, it, expect } from 'vitest';
import { RequestProcessor } from '../../src/components/RequestProcessor.js';
import { InternalChatRequest } from '../../src/types/chat.js';

describe('RequestProcessor', () => {
  const processor = new RequestProcessor();

  describe('normalizeRequest', () => {
    it('should normalize request with default values', () => {
      const request: InternalChatRequest = {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      };

      const normalized = processor.normalizeRequest(request);

      expect(normalized.model).toBe('gpt-3.5-turbo');
      expect(normalized.temperature).toBe(1.0);
      expect(normalized.top_p).toBe(1.0);
      expect(normalized.max_tokens).toBe(0);
      expect(normalized.presence_penalty).toBe(0);
      expect(normalized.frequency_penalty).toBe(0);
      expect(normalized.stream).toBe(false);
      expect(normalized.messages).toHaveLength(1);
    });

    it('should keep provided values in request', () => {
      const request: InternalChatRequest = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'test' }],
        temperature: 0.5,
        top_p: 0.9,
        max_tokens: 100,
        presence_penalty: 0.1,
        frequency_penalty: 0.2,
        stream: true,
      };

      const normalized = processor.normalizeRequest(request);

      expect(normalized.temperature).toBe(0.5);
      expect(normalized.top_p).toBe(0.9);
      expect(normalized.max_tokens).toBe(100);
      expect(normalized.presence_penalty).toBe(0.1);
      expect(normalized.frequency_penalty).toBe(0.2);
      expect(normalized.stream).toBe(true);
    });
  });

  describe('generateContextHash', () => {
    it('should generate valid SHA-256 hash', () => {
      const request: InternalChatRequest = {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      };
      const normalized = processor.normalizeRequest(request);
      const { contextHash, prefixHash } = processor.generateContextHash(normalized);

      expect(contextHash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 produces 64 hex chars
      expect(prefixHash).toBeNull(); // Only 1 message
    });

    it('should generate prefixHash when there are multiple messages', () => {
      const request: InternalChatRequest = {
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are an AI.' },
          { role: 'user', content: 'Hello' }
        ],
        stream: false,
      };
      const normalized = processor.normalizeRequest(request);
      const { contextHash, prefixHash } = processor.generateContextHash(normalized);

      expect(contextHash).toMatch(/^[a-f0-9]{64}$/);
      expect(prefixHash).toMatch(/^[a-f0-9]{64}$/);
      expect(contextHash).not.toBe(prefixHash);
    });

    it('should produce deterministic hashes', () => {
      const request: InternalChatRequest = {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      };
      const normalized = processor.normalizeRequest(request);
      
      const hash1 = processor.generateContextHash(normalized);
      const hash2 = processor.generateContextHash(normalized);

      expect(hash1.contextHash).toBe(hash2.contextHash);
      expect(hash1.prefixHash).toBe(hash2.prefixHash);
    });

    it('should produce different hashes for different contexts', () => {
      const request1: InternalChatRequest = {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      };
      
      const request2: InternalChatRequest = {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'hello world' }],
        stream: false,
      };

      const hash1 = processor.generateContextHash(processor.normalizeRequest(request1));
      const hash2 = processor.generateContextHash(processor.normalizeRequest(request2));

      expect(hash1.contextHash).not.toBe(hash2.contextHash);
    });

    it('should produce different hashes for different parameters', () => {
      const request1: InternalChatRequest = {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.5,
        stream: false,
      };
      
      const request2: InternalChatRequest = {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 1.0,
        stream: false,
      };

      const hash1 = processor.generateContextHash(processor.normalizeRequest(request1));
      const hash2 = processor.generateContextHash(processor.normalizeRequest(request2));

      expect(hash1.contextHash).not.toBe(hash2.contextHash);
    });
  });
});
