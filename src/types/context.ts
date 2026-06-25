/**
 * Code context types for the GitHub Copilot Token Optimizer Proxy.
 * 
 * These types define the structure of extracted and normalized code context
 * used for generating context hashes and identifying similar requests.
 */

/**
 * Extracted code context from a completion request.
 * 
 * The context includes the file type, language, cursor position, and surrounding code.
 * This is extracted before normalization for hash generation.
 */
export interface CodeContext {
  /** File type/extension (e.g., '.ts', '.py', '.js') */
  fileType: string;
  
  /** Content appearing before the cursor (up to 500 characters) */
  precedingContent: string;
  
  /** Content appearing after the cursor (up to 100 characters) */
  followingContent: string;
  
  /** Position of the cursor in the file (character offset) */
  cursorPosition: number;
  
  /** Programming language (e.g., 'typescript', 'python', 'javascript') */
  language: string;
}

/**
 * Normalized code context with standardized whitespace and formatting.
 * 
 * Normalization ensures that contexts differing only in whitespace/formatting
 * produce identical hashes for cache matching.
 */
export interface NormalizedContext {
  /** File type/extension (e.g., '.ts', '.py', '.js') */
  fileType: string;
  
  /** Normalized preceding content with standardized whitespace */
  precedingContent: string;
  
  /** Normalized following content with standardized whitespace */
  followingContent: string;
  
  /** Programming language (e.g., 'typescript', 'python', 'javascript') */
  language: string;
}
