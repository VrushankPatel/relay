/**
 * HTTP request and authentication types for the GitHub Copilot Token Optimizer Proxy.
 * 
 * These types define the structure of incoming HTTP requests from IDEs,
 * authentication results, and request bodies for completion requests.
 */

/**
 * Represents an incoming HTTP request from the IDE.
 */
export interface HTTPRequest {
  /** HTTP headers as key-value pairs */
  headers: Map<string, string>;
  
  /** Parsed request body containing completion request data */
  body: CompletionRequestBody;
  
  /** IP address of the client making the request */
  clientIP: string;
  
  /** Unix timestamp (milliseconds) when the request was received */
  timestamp: number;
}

/**
 * Request body for code completion requests from the IDE.
 */
export interface CompletionRequestBody {
  /** The code prompt/context to send to GitHub Copilot */
  prompt: string;
  
  /** Programming language of the file (e.g., 'typescript', 'python', 'javascript') */
  language: string;
  
  /** Position of the cursor in the file (character offset) */
  cursorPosition: number;
  
  /** Surrounding code context from the file */
  fileContext: string;
  
  /** Optional maximum number of tokens to generate in the response */
  maxTokens?: number;
}

/**
 * An authenticated HTTP request with extracted user information.
 */
export interface AuthenticatedRequest {
  /** The original HTTP request */
  request: HTTPRequest;
  
  /** Authentication result containing user identity and tokens */
  authResult: AuthResult;
}

/**
 * Result of authentication validation.
 */
export interface AuthResult {
  /** Whether the authentication was successful */
  authenticated: boolean;
  
  /** Unique identifier for the authenticated user */
  userId: string;
  
  /** The user's GitHub Copilot authentication token to forward to the API */
  copilotToken: string;
}
