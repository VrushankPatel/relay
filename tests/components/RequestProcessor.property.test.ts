import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { RequestProcessor } from '../../src/components/RequestProcessor.js';
import { InternalChatRequest } from '../../src/types/chat.js';

describe('RequestProcessor - Property-Based Tests', () => {
  const processor = new RequestProcessor();

  describe('Property 2: Request normalization and hashing completeness', () => {
    // Arbitrary generator for role
    const roleArb = fc.constantFrom('system', 'user', 'assistant', 'tool');

    // Arbitrary generator for message content
    const messageContentArb = fc.string({ minLength: 1, maxLength: 500 });

    // Arbitrary generator for messages array
    const messagesArb = fc.array(
      fc.record({
        role: roleArb,
        content: messageContentArb,
      }),
      { minLength: 1, maxLength: 10 }
    );

    // Arbitrary generator for chat request
    const chatRequestArb = fc.record({
      model: fc.constantFrom('gpt-3.5-turbo', 'gpt-4'),
      messages: messagesArb,
      temperature: fc.option(fc.float({ min: 0, max: 2 }), { nil: undefined }),
      top_p: fc.option(fc.float({ min: 0, max: 1 }), { nil: undefined }),
      max_tokens: fc.option(fc.integer({ min: 1, max: 2048 }), { nil: undefined }),
      presence_penalty: fc.option(fc.float({ min: -2, max: 2 }), { nil: undefined }),
      frequency_penalty: fc.option(fc.float({ min: -2, max: 2 }), { nil: undefined }),
      stream: fc.option(fc.boolean(), { nil: undefined }),
    });

    it('should normalize request consistently', () => {
      fc.assert(
        fc.property(chatRequestArb, (request: any) => { // Type as any for fast-check gen
          const normalized = processor.normalizeRequest(request);

          expect(normalized.model).toBe(request.model);
          expect(normalized.messages).toBe(request.messages);
          expect(normalized.temperature).toBeDefined();
          expect(normalized.top_p).toBeDefined();
          expect(normalized.max_tokens).toBeDefined();
          expect(normalized.presence_penalty).toBeDefined();
          expect(normalized.frequency_penalty).toBeDefined();
          expect(normalized.stream).toBeDefined();
        }),
        { numRuns: 100 }
      );
    });

    it('should generate valid hashes for any request', () => {
      fc.assert(
        fc.property(chatRequestArb, (request: any) => {
          const normalized = processor.normalizeRequest(request);
          const { contextHash, prefixHash } = processor.generateContextHash(normalized);

          expect(contextHash).toMatch(/^[a-f0-9]{64}$/);
          
          if (normalized.messages.length > 1) {
            expect(prefixHash).toMatch(/^[a-f0-9]{64}$/);
          } else {
            expect(prefixHash).toBeNull();
          }
        }),
        { numRuns: 100 }
      );
    });

    it('should produce different hashes when messages change', () => {
      fc.assert(
        fc.property(chatRequestArb, (request: any) => {
          const normalized1 = processor.normalizeRequest(request);
          const hash1 = processor.generateContextHash(normalized1);

          // Create a modified request by adding a character to the last message
          const modifiedRequest = {
            ...request,
            messages: [
              ...request.messages.slice(0, -1),
              {
                ...request.messages[request.messages.length - 1],
                content: request.messages[request.messages.length - 1].content + 'X',
              }
            ],
          };

          const normalized2 = processor.normalizeRequest(modifiedRequest);
          const hash2 = processor.generateContextHash(normalized2);

          expect(hash1.contextHash).not.toBe(hash2.contextHash);
          
          // Prefix hash shouldn't change if only last message is modified
          if (request.messages.length > 1) {
            expect(hash1.prefixHash).toBe(hash2.prefixHash);
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
