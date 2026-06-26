/**
 * Unit tests for RequestProcessor component.
 * 
 * Tests context extraction, normalization, and hash generation.
 */

import { describe, it, expect } from 'vitest';
import { RequestProcessor } from '../../src/components/RequestProcessor';
import { CompletionRequestBody } from '../../src/types/requests';

describe('RequestProcessor', () => {
  const processor = new RequestProcessor();

  describe('extractContext', () => {
    it('should extract context with file type, language, and cursor position', () => {
      const request: CompletionRequestBody = {
        prompt: 'test prompt',
        language: 'typescript',
        cursorPosition: 50,
        fileContext: 'const x = 10;\nconst y = 20;\n// cursor here\nconst z = 30;',
      };

      const context = processor.extractContext(request);

      expect(context.fileType).toBe('.ts');
      expect(context.language).toBe('typescript');
      expect(context.cursorPosition).toBe(50);
      expect(context.precedingContent).toBeTruthy();
      expect(context.followingContent).toBeTruthy();
    });

    it('should extract up to 500 characters before cursor', () => {
      const longContent = 'a'.repeat(1000);
      const request: CompletionRequestBody = {
        prompt: 'test',
        language: 'typescript',
        cursorPosition: 600,
        fileContext: longContent,
      };

      const context = processor.extractContext(request);

      expect(context.precedingContent.length).toBe(500);
      expect(context.precedingContent).toBe('a'.repeat(500));
    });

    it('should extract up to 100 characters after cursor', () => {
      const request: CompletionRequestBody = {
        prompt: 'test',
        language: 'typescript',
        cursorPosition: 10,
        fileContext: 'start here' + 'x'.repeat(200),
      };

      const context = processor.extractContext(request);

      expect(context.followingContent.length).toBe(100);
    });

    it('should handle cursor at start of file', () => {
      const request: CompletionRequestBody = {
        prompt: 'test',
        language: 'python',
        cursorPosition: 0,
        fileContext: 'def hello():\n    pass',
      };

      const context = processor.extractContext(request);

      expect(context.precedingContent).toBe('');
      expect(context.followingContent).toBeTruthy();
    });

    it('should handle cursor at end of file', () => {
      const request: CompletionRequestBody = {
        prompt: 'test',
        language: 'javascript',
        cursorPosition: 20,
        fileContext: 'console.log("test");',
      };

      const context = processor.extractContext(request);

      expect(context.precedingContent).toBe('console.log("test");');
      expect(context.followingContent).toBe('');
    });
  });

  describe('normalizeContext - whitespace normalization', () => {
    it('should normalize line endings to LF', () => {
      const context = {
        fileType: '.ts',
        precedingContent: 'line1\r\nline2\rline3\n',
        followingContent: 'after\r\n',
        cursorPosition: 0,
        language: 'typescript',
      };

      const normalized = processor.normalizeContext(context);

      expect(normalized.precedingContent).toBe('line1\nline2\nline3');
      expect(normalized.followingContent).toBe('after');
    });

    it('should convert tabs to 4-space equivalent', () => {
      const context = {
        fileType: '.ts',
        precedingContent: '\tindented\n\t\tdouble',
        followingContent: '\tmore',
        cursorPosition: 0,
        language: 'typescript',
      };

      const normalized = processor.normalizeContext(context);

      expect(normalized.precedingContent).toBe('    indented\n        double');
      expect(normalized.followingContent).toBe('    more');
    });

    it('should remove leading and trailing whitespace per line', () => {
      const context = {
        fileType: '.ts',
        precedingContent: '  leading\ntrailing  \n  both  ',
        followingContent: '  spaces  ',
        cursorPosition: 0,
        language: 'typescript',
      };

      const normalized = processor.normalizeContext(context);

      // Leading indentation is preserved, trailing is removed
      expect(normalized.precedingContent).toBe('  leading\ntrailing\n  both');
      expect(normalized.followingContent).toBe('  spaces');
    });

    it('should collapse multiple consecutive spaces to single space in content', () => {
      const context = {
        fileType: '.ts',
        precedingContent: 'const  x   =    10;',
        followingContent: 'let    y  =  20;',
        cursorPosition: 0,
        language: 'typescript',
      };

      const normalized = processor.normalizeContext(context);

      expect(normalized.precedingContent).toBe('const x = 10;');
      expect(normalized.followingContent).toBe('let y = 20;');
    });

    it('should preserve indentation structure', () => {
      const context = {
        fileType: '.py',
        precedingContent: '    def  hello():\n        return  "world"',
        followingContent: '    # comment',
        cursorPosition: 0,
        language: 'python',
      };

      const normalized = processor.normalizeContext(context);

      // Indentation preserved, but multiple spaces in content collapsed
      expect(normalized.precedingContent).toBe('    def hello():\n        return "world"');
      expect(normalized.followingContent).toBe('    # comment');
    });

    it('should handle mixed whitespace issues', () => {
      const context = {
        fileType: '.js',
        precedingContent: '\tfunction  test()  {\r\n\t\treturn   true;\r\n\t}  ',
        followingContent: '\tconsole.log(  "test"  );',
        cursorPosition: 0,
        language: 'javascript',
      };

      const normalized = processor.normalizeContext(context);

      // Tabs → spaces, line endings → LF, multiple spaces collapsed, trailing removed
      expect(normalized.precedingContent).toBe('    function test() {\n        return true;\n    }');
      expect(normalized.followingContent).toBe('    console.log( "test" );');
    });

    it('should produce identical output for whitespace-only differences', () => {
      const context1 = {
        fileType: '.ts',
        precedingContent: 'const x = 10;',
        followingContent: 'const y = 20;',
        cursorPosition: 0,
        language: 'typescript',
      };

      const context2 = {
        fileType: '.ts',
        precedingContent: 'const  x  =  10;',
        followingContent: 'const   y   =   20;',
        cursorPosition: 0,
        language: 'typescript',
      };

      const normalized1 = processor.normalizeContext(context1);
      const normalized2 = processor.normalizeContext(context2);

      expect(normalized1.precedingContent).toBe(normalized2.precedingContent);
      expect(normalized1.followingContent).toBe(normalized2.followingContent);
    });

    it('should handle empty strings', () => {
      const context = {
        fileType: '.ts',
        precedingContent: '',
        followingContent: '',
        cursorPosition: 0,
        language: 'typescript',
      };

      const normalized = processor.normalizeContext(context);

      expect(normalized.precedingContent).toBe('');
      expect(normalized.followingContent).toBe('');
    });

    it('should handle strings with only whitespace', () => {
      const context = {
        fileType: '.ts',
        precedingContent: '   \n\t\t\n  ',
        followingContent: '\t  \n  \t',
        cursorPosition: 0,
        language: 'typescript',
      };

      const normalized = processor.normalizeContext(context);

      expect(normalized.precedingContent).toBe('');
      expect(normalized.followingContent).toBe('');
    });
  });

  describe('generateContextHash', () => {
    it('should generate SHA-256 hash from normalized context', () => {
      const context = {
        fileType: '.ts',
        precedingContent: 'const x = 10;',
        followingContent: 'const y = 20;',
        language: 'typescript',
      };

      const hash = processor.generateContextHash(context);

      expect(hash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 produces 64 hex chars
    });

    it('should produce deterministic hashes', () => {
      const context = {
        fileType: '.ts',
        precedingContent: 'const x = 10;',
        followingContent: 'const y = 20;',
        language: 'typescript',
      };

      const hash1 = processor.generateContextHash(context);
      const hash2 = processor.generateContextHash(context);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different contexts', () => {
      const context1 = {
        fileType: '.ts',
        precedingContent: 'const x = 10;',
        followingContent: 'const y = 20;',
        language: 'typescript',
      };

      const context2 = {
        fileType: '.ts',
        precedingContent: 'const x = 11;', // Different content
        followingContent: 'const y = 20;',
        language: 'typescript',
      };

      const hash1 = processor.generateContextHash(context1);
      const hash2 = processor.generateContextHash(context2);

      expect(hash1).not.toBe(hash2);
    });

    it('should produce identical hashes for contexts differing only in whitespace', () => {
      const rawContext1 = {
        fileType: '.ts',
        precedingContent: 'const x = 10;',
        followingContent: 'const y = 20;',
        cursorPosition: 0,
        language: 'typescript',
      };

      const rawContext2 = {
        fileType: '.ts',
        precedingContent: 'const  x  =  10;',
        followingContent: 'const   y   =   20;',
        cursorPosition: 0,
        language: 'typescript',
      };

      const normalized1 = processor.normalizeContext(rawContext1);
      const normalized2 = processor.normalizeContext(rawContext2);

      const hash1 = processor.generateContextHash(normalized1);
      const hash2 = processor.generateContextHash(normalized2);

      expect(hash1).toBe(hash2);
    });

    it('should include all context components in hash', () => {
      const context1 = {
        fileType: '.ts',
        precedingContent: 'test',
        followingContent: 'test',
        language: 'typescript',
      };

      const context2 = {
        fileType: '.js', // Different file type
        precedingContent: 'test',
        followingContent: 'test',
        language: 'typescript',
      };

      const hash1 = processor.generateContextHash(context1);
      const hash2 = processor.generateContextHash(context2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('end-to-end normalization flow', () => {
    it('should produce same hash for requests differing only in whitespace', () => {
      const request1: CompletionRequestBody = {
        prompt: 'test',
        language: 'typescript',
        cursorPosition: 99999,
        fileContext: 'const x = 10;\nconst y = 20;// more code',
      };

      const request2: CompletionRequestBody = {
        prompt: 'test',
        language: 'typescript',
        cursorPosition: 99999,
        fileContext: 'const  x  =  10;\nconst   y   =   20;// more code',
      };

      const context1 = processor.extractContext(request1);
      const context2 = processor.extractContext(request2);

      const normalized1 = processor.normalizeContext(context1);
      const normalized2 = processor.normalizeContext(context2);

      const hash1 = processor.generateContextHash(normalized1);
      const hash2 = processor.generateContextHash(normalized2);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hash for semantically different code', () => {
      const request1: CompletionRequestBody = {
        prompt: 'test',
        language: 'typescript',
        cursorPosition: 20,
        fileContext: 'const x = 10;\nconst y = 20;// more code',
      };

      const request2: CompletionRequestBody = {
        prompt: 'test',
        language: 'typescript',
        cursorPosition: 20,
        fileContext: 'const x = 11;\nconst y = 20;// more code', // Different value
      };

      const context1 = processor.extractContext(request1);
      const context2 = processor.extractContext(request2);

      const normalized1 = processor.normalizeContext(context1);
      const normalized2 = processor.normalizeContext(context2);

      const hash1 = processor.generateContextHash(normalized1);
      const hash2 = processor.generateContextHash(normalized2);

      expect(hash1).not.toBe(hash2);
    });
  });
});
