/**
 * Request Processor component for the GitHub Copilot Token Optimizer Proxy.
 * 
 * This component extracts code context from completion requests, normalizes
 * the context for consistent hashing, and generates context hashes for cache lookups.
 */

import crypto from 'crypto';
import { CodeContext, NormalizedContext } from '../types/context';
import { CompletionRequestBody } from '../types/requests';

/**
 * Request Processor interface defining context extraction and hashing operations.
 */
export interface IRequestProcessor {
  /**
   * Extract code context from a completion request.
   * @param req The completion request body
   * @returns Extracted code context
   */
  extractContext(req: CompletionRequestBody): CodeContext;
  
  /**
   * Normalize code context for consistent hashing.
   * @param context The code context to normalize
   * @returns Normalized context with standardized formatting
   */
  normalizeContext(context: CodeContext): NormalizedContext;
  
  /**
   * Generate SHA-256 hash from normalized context.
   * @param context The normalized context to hash
   * @returns Hex-encoded SHA-256 hash string
   */
  generateContextHash(context: NormalizedContext): string;
}

/**
 * Implementation of the Request Processor.
 */
export class RequestProcessor implements IRequestProcessor {
  /**
   * Extract code context from a completion request.
   * 
   * Extracts file type, language, cursor position, and surrounding content
   * (up to 500 chars before cursor, 100 chars after cursor).
   */
  extractContext(req: CompletionRequestBody): CodeContext {
    const { language, cursorPosition, fileContext } = req;
    
    // Extract file type from language (simple mapping for now)
    const fileType = this.languageToFileType(language);
    
    // Extract preceding content (up to 500 characters before cursor)
    const precedingContent = fileContext.slice(
      Math.max(0, cursorPosition - 500),
      cursorPosition
    );
    
    // Extract following content (up to 100 characters after cursor)
    const followingContent = fileContext.slice(
      cursorPosition,
      Math.min(fileContext.length, cursorPosition + 100)
    );
    
    return {
      fileType,
      precedingContent,
      followingContent,
      cursorPosition,
      language,
    };
  }
  
  /**
   * Normalize code context for consistent hashing.
   * 
   * Normalization rules:
   * - Collapse multiple consecutive spaces to single space
   * - Remove leading/trailing whitespace per line
   * - Normalize line endings to LF
   * - Preserve indentation structure
   * - Convert tabs to 4-space equivalent
   */
  normalizeContext(context: CodeContext): NormalizedContext {
    return {
      fileType: context.fileType,
      precedingContent: this.normalizeWhitespace(context.precedingContent),
      followingContent: this.normalizeWhitespace(context.followingContent),
      language: context.language,
    };
  }
  
  /**
   * Generate SHA-256 hash from normalized context.
   * 
   * Concatenates file type, language, preceding content, and following content
   * with '||' delimiter, then computes SHA-256 hash.
   */
  generateContextHash(context: NormalizedContext): string {
    const components = [
      context.fileType,
      context.language,
      context.precedingContent,
      context.followingContent,
    ];
    
    const concatenated = components.join('||');
    const hash = crypto.createHash('sha256');
    hash.update(concatenated, 'utf8');
    return hash.digest('hex');
  }
  
  /**
   * Normalize whitespace in a string according to requirement 2.3.
   * 
   * - Normalize line endings to LF
   * - Convert tabs to 4-space equivalent
   * - Remove leading/trailing whitespace per line
   * - Collapse multiple consecutive spaces to single space (preserving indentation)
   * 
   * @param content The content to normalize
   * @returns Normalized content
   */
  private normalizeWhitespace(content: string): string {
    // Step 1: Normalize line endings to LF
    let normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // Step 2: Convert tabs to 4-space equivalent
    normalized = normalized.replace(/\t/g, '    ');
    
    // Step 3: Process line by line to preserve structure
    const lines = normalized.split('\n');
    const normalizedLines = lines.map((line) => {
      // Remove trailing whitespace
      line = line.replace(/\s+$/g, '');
      
      // Separate leading whitespace (indentation) from content
      const leadingMatch = line.match(/^(\s*)(.*)/);
      if (!leadingMatch) return line;
      
      const [, leading, content] = leadingMatch;
      
      // Preserve indentation but collapse multiple spaces in content
      const normalizedContent = content.replace(/\s+/g, ' ');
      
      return leading + normalizedContent;
    });
    
    // Step 4: Join lines back together
    return normalizedLines.join('\n');
  }
  
  /**
   * Map language to file type extension.
   * @param language Programming language name
   * @returns File extension
   */
  private languageToFileType(language: string): string {
    const mapping: Record<string, string> = {
      'typescript': '.ts',
      'javascript': '.js',
      'python': '.py',
      'java': '.java',
      'csharp': '.cs',
      'cpp': '.cpp',
      'c': '.c',
      'go': '.go',
      'rust': '.rs',
      'ruby': '.rb',
      'php': '.php',
      'swift': '.swift',
      'kotlin': '.kt',
    };
    
    return mapping[language.toLowerCase()] || `.${language}`;
  }
}
