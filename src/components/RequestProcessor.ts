import crypto from 'crypto';
import { InternalChatRequest, NormalizedChatRequest } from '../types/chat.js';

/**
 * Request Processor interface defining chat request normalization and hashing operations.
 */
export interface IRequestProcessor {
  /**
   * Normalize an internal chat request.
   * @param req The chat request to normalize
   * @returns Normalized chat request with defaults filled
   */
  normalizeRequest(req: InternalChatRequest): NormalizedChatRequest;
  
  /**
   * Generate SHA-256 hash from normalized context.
   * @param normalized The normalized chat request to hash
   * @returns Object containing contextHash and prefixHash
   */
  generateContextHash(normalized: NormalizedChatRequest): { contextHash: string; prefixHash: string | null };
}

/**
 * Implementation of the Request Processor for Chat API.
 */
export class RequestProcessor implements IRequestProcessor {
  /**
   * Normalize an internal chat request by ensuring all fields have defined values.
   */
  normalizeRequest(req: InternalChatRequest): NormalizedChatRequest {
    return {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 1.0,
      top_p: req.top_p ?? 1.0,
      max_tokens: req.max_tokens ?? 0,
      presence_penalty: req.presence_penalty ?? 0,
      frequency_penalty: req.frequency_penalty ?? 0,
      stream: req.stream ?? false,
      tools: req.tools,
    };
  }
  
  /**
   * Generate hashes for the chat request context.
   * contextHash: Hash of all messages and parameters.
   * prefixHash: Hash of all messages except the last one (useful for prefix matching), or null if only 1 message.
   */
  generateContextHash(normalized: NormalizedChatRequest): { contextHash: string; prefixHash: string | null } {
    const contextHash = this.createHashForMessages(normalized, normalized.messages);
    
    let prefixHash: string | null = null;
    if (normalized.messages.length > 1) {
      const prefixMessages = normalized.messages.slice(0, -1);
      prefixHash = this.createHashForMessages(normalized, prefixMessages);
    }
    
    return { contextHash, prefixHash };
  }
  
  /**
   * Helper method to create a hash for a specific set of messages and parameters.
   */
  private createHashForMessages(normalized: NormalizedChatRequest, messages: { role: string; content: string }[]): string {
    const messagesString = messages.map(m => `${m.role}:${m.content}`).join('\n');
    
    const components = [
      normalized.model,
      messagesString,
      normalized.temperature.toString(),
      normalized.top_p.toString(),
      normalized.max_tokens.toString(),
      normalized.presence_penalty.toString(),
      normalized.frequency_penalty.toString()
    ];
    
    const concatenated = components.join('||');
    const hash = crypto.createHash('sha256');
    hash.update(concatenated, 'utf8');
    return hash.digest('hex');
  }
}
