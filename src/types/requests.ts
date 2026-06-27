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
  
  /** Parsed request body (will be parsed to InternalChatRequest downstream) */
  body: unknown;
  
  /** IP address of the client making the request */
  clientIP: string;
  
  /** Unix timestamp (milliseconds) when the request was received */
  timestamp: number;

  /** Requested URL path */
  url: string;
}


/**
 * An authenticated HTTP request with extracted user information.
 */
export interface AuthenticatedRequest {
  /** The original HTTP request */
  request: HTTPRequest;
}
