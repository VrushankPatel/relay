/**
 * Chat-related types for the Relay proxy.
 * These types replace the old completion-oriented types for the new chat API.
 */

/** Internal representation of a chat message */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** Tool call within a message */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** Tool/function definition */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** Internal chat request (used throughout the proxy pipeline) */
export interface InternalChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream: boolean;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  tools?: ToolDefinition[];
  tool_choice?: string | { type: string; function?: { name: string } };
  suffix?: string;
  language?: string;
  user?: string;
}

/** Normalized chat request for hashing (all fields have defined values) */
export interface NormalizedChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  top_p: number;
  max_tokens: number;
  presence_penalty: number;
  frequency_penalty: number;
  stream: boolean;
  tools?: ToolDefinition[];
  tool_choice?: string | { type: string; function?: { name: string } };
  stop?: string | string[];
  suffix?: string;
  language?: string;
}

/** Internal chat response */
export interface InternalChatResponse {
  id: string;
  model: string;
  choices: ChatChoice[];
  usage: TokenUsage;
  created: number;
  system_fingerprint?: string;
}

/** A single choice in a chat response */
export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

/** Token usage information */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** A streaming chunk */
export interface InternalStreamChunk {
  id: string;
  model: string;
  choices: StreamChoice[];
  created: number;
  system_fingerprint?: string;
}

/** A choice within a streaming chunk */
export interface StreamChoice {
  index: number;
  delta: Partial<ChatMessage>;
  finish_reason: string | null;
}

/** Chat cache entry (replaces old CacheEntry for chat) */
export interface ChatCacheEntry {
  contextHash: string;
  response: InternalChatResponse;
  timestamp: number;
  accessCount: number;
  lastAccessTime: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
}
