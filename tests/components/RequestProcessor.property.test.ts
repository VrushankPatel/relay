/**
 * Property-based tests for RequestProcessor component.
 * 
 * Uses fast-check to generate random inputs and verify properties hold across all valid executions.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { RequestProcessor } from '../../src/components/RequestProcessor';
import { CompletionRequestBody } from '../../src/types/requests';

describe('RequestProcessor - Property-Based Tests', () => {
  const processor = new RequestProcessor();

  /**
   * Property 2: Context extraction completeness
   * 
   * **Validates: Requirements 2.1, 2.2, 2.4**
   * 
   * For any valid completion request, the context extraction process SHALL produce
   * a context object containing all required fields (file type, language, cursor position,
   * preceding 500 characters, following 100 characters), and any change to these input
   * fields SHALL result in a different context hash.
   */
  describe('Property 2: Context extraction completeness', () => {
    // Arbitrary generator for programming languages
    const languageArb = fc.constantFrom(
      'typescript',
      'javascript',
      'python',
      'java',
      'csharp',
      'cpp',
      'c',
      'go',
      'rust',
      'ruby',
      'php',
      'swift',
      'kotlin'
    );

    // Arbitrary generator for file context content
    const fileContextArb = fc.string({ minLength: 0, maxLength: 2000 });

    // Arbitrary generator for completion request body
    const completionRequestArb = fc.record({
      prompt: fc.string({ minLength: 1, maxLength: 500 }),
      language: languageArb,
      cursorPosition: fc.nat({ max: 1500 }), // Will be adjusted to fit context
      fileContext: fileContextArb,
      maxTokens: fc.option(fc.integer({ min: 1, max: 2048 }), { nil: undefined }),
    }).map((req) => {
      // Ensure cursor position is within the file context bounds
      const adjustedCursorPosition = Math.min(req.cursorPosition, req.fileContext.length);
      return {
        ...req,
        cursorPosition: adjustedCursorPosition,
      };
    });

    it('should extract all required fields from any valid completion request', () => {
      fc.assert(
        fc.property(completionRequestArb, (request: CompletionRequestBody) => {
          const context = processor.extractContext(request);

          // Verify all required fields are present
          expect(context.fileType).toBeDefined();
          expect(typeof context.fileType).toBe('string');
          expect(context.fileType.length).toBeGreaterThan(0);

          expect(context.language).toBeDefined();
          expect(context.language).toBe(request.language);

          expect(context.cursorPosition).toBeDefined();
          expect(context.cursorPosition).toBe(request.cursorPosition);

          expect(context.precedingContent).toBeDefined();
          expect(typeof context.precedingContent).toBe('string');

          expect(context.followingContent).toBeDefined();
          expect(typeof context.followingContent).toBe('string');
        }),
        { numRuns: 100 }
      );
    });

    it('should extract at most 500 characters before cursor', () => {
      fc.assert(
        fc.property(completionRequestArb, (request: CompletionRequestBody) => {
          const context = processor.extractContext(request);

          // Preceding content should be at most 500 characters
          expect(context.precedingContent.length).toBeLessThanOrEqual(500);

          // If cursor position >= 500, preceding content should be exactly 500 chars
          if (request.cursorPosition >= 500) {
            expect(context.precedingContent.length).toBe(500);
          } else {
            // Otherwise, it should match the cursor position
            expect(context.precedingContent.length).toBe(request.cursorPosition);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('should extract at most 100 characters after cursor', () => {
      fc.assert(
        fc.property(completionRequestArb, (request: CompletionRequestBody) => {
          const context = processor.extractContext(request);

          // Following content should be at most 100 characters
          expect(context.followingContent.length).toBeLessThanOrEqual(100);

          const remainingAfterCursor = request.fileContext.length - request.cursorPosition;

          // If remaining content >= 100, following content should be exactly 100 chars
          if (remainingAfterCursor >= 100) {
            expect(context.followingContent.length).toBe(100);
          } else {
            // Otherwise, it should match the remaining content length
            expect(context.followingContent.length).toBe(remainingAfterCursor);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('should produce different context hashes when input fields change', () => {
      fc.assert(
        fc.property(
          completionRequestArb,
          fc.constantFrom('fileContext', 'language', 'cursorPosition'),
          (baseRequest: CompletionRequestBody, fieldToChange: string) => {
            // Skip if the field change wouldn't actually affect the hash
            // (e.g., cursor at position 0 can't go lower)
            if (fieldToChange === 'cursorPosition' && baseRequest.cursorPosition === 0) {
              return true;
            }

            // Extract and hash the base request
            const baseContext = processor.extractContext(baseRequest);
            const baseNormalized = processor.normalizeContext(baseContext);
            const baseHash = processor.generateContextHash(baseNormalized);

            // Create a modified request by changing the specified field
            let modifiedRequest: CompletionRequestBody;

            switch (fieldToChange) {
              case 'fileContext':
                // Append a character to change the file context
                modifiedRequest = {
                  ...baseRequest,
                  fileContext: baseRequest.fileContext + 'X',
                };
                break;

              case 'language':
                // Change to a different language
                const languages = ['typescript', 'javascript', 'python'];
                const currentIndex = languages.indexOf(baseRequest.language);
                const newLanguage = languages[(currentIndex + 1) % languages.length];
                modifiedRequest = {
                  ...baseRequest,
                  language: newLanguage,
                };
                break;

              case 'cursorPosition':
                // Adjust cursor position by 1 (if possible)
                const newCursorPos = Math.min(
                  baseRequest.cursorPosition + 1,
                  baseRequest.fileContext.length
                );
                // Only proceed if the position actually changed
                if (newCursorPos === baseRequest.cursorPosition) {
                  return true; // Skip this test case
                }
                modifiedRequest = {
                  ...baseRequest,
                  cursorPosition: newCursorPos,
                };
                break;

              default:
                return true; // Skip unknown fields
            }

            // Extract and hash the modified request
            const modifiedContext = processor.extractContext(modifiedRequest);
            const modifiedNormalized = processor.normalizeContext(modifiedContext);
            const modifiedHash = processor.generateContextHash(modifiedNormalized);

            // The hashes should be different when input fields change
            // Note: We need to verify that the actual extracted content changed
            const contentChanged =
              baseNormalized.precedingContent !== modifiedNormalized.precedingContent ||
              baseNormalized.followingContent !== modifiedNormalized.followingContent ||
              baseNormalized.language !== modifiedNormalized.language ||
              baseNormalized.fileType !== modifiedNormalized.fileType;

            if (contentChanged) {
              expect(baseHash).not.toBe(modifiedHash);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should handle edge cases: empty file context', () => {
      fc.assert(
        fc.property(
          fc.record({
            prompt: fc.string(),
            language: languageArb,
            cursorPosition: fc.constant(0),
            fileContext: fc.constant(''),
          }),
          (request: CompletionRequestBody) => {
            const context = processor.extractContext(request);

            expect(context.precedingContent).toBe('');
            expect(context.followingContent).toBe('');
            expect(context.cursorPosition).toBe(0);
            expect(context.fileType).toBeDefined();
            expect(context.language).toBe(request.language);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should handle edge cases: cursor at start of file', () => {
      fc.assert(
        fc.property(
          fc.record({
            prompt: fc.string(),
            language: languageArb,
            cursorPosition: fc.constant(0),
            fileContext: fc.string({ minLength: 1, maxLength: 1000 }),
          }),
          (request: CompletionRequestBody) => {
            const context = processor.extractContext(request);

            expect(context.precedingContent).toBe('');
            expect(context.followingContent.length).toBeGreaterThan(0);
            expect(context.followingContent.length).toBeLessThanOrEqual(100);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should handle edge cases: cursor at end of file', () => {
      fc.assert(
        fc.property(
          fc.record({
            prompt: fc.string(),
            language: languageArb,
            fileContext: fc.string({ minLength: 1, maxLength: 1000 }),
          }).map((req) => ({
            ...req,
            cursorPosition: req.fileContext.length,
          })),
          (request: CompletionRequestBody) => {
            const context = processor.extractContext(request);

            expect(context.followingContent).toBe('');
            expect(context.precedingContent.length).toBeGreaterThan(0);
            expect(context.precedingContent.length).toBeLessThanOrEqual(500);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should consistently extract the correct substring ranges', () => {
      fc.assert(
        fc.property(completionRequestArb, (request: CompletionRequestBody) => {
          const context = processor.extractContext(request);

          // Verify preceding content matches the expected substring
          const expectedPrecedingStart = Math.max(0, request.cursorPosition - 500);
          const expectedPreceding = request.fileContext.slice(
            expectedPrecedingStart,
            request.cursorPosition
          );
          expect(context.precedingContent).toBe(expectedPreceding);

          // Verify following content matches the expected substring
          const expectedFollowingEnd = Math.min(
            request.fileContext.length,
            request.cursorPosition + 100
          );
          const expectedFollowing = request.fileContext.slice(
            request.cursorPosition,
            expectedFollowingEnd
          );
          expect(context.followingContent).toBe(expectedFollowing);
        }),
        { numRuns: 100 }
      );
    });
  });
});
