import { InternalChatRequest, InternalChatResponse, InternalStreamChunk, ChatMessage } from '../types/chat.js';

export interface ICompatibilityLayer {
  parseOpenAIChatRequest(body: unknown): InternalChatRequest;
  parseOpenAICompletionRequest(body: unknown): InternalChatRequest;
  parseAnthropicRequest(body: unknown): InternalChatRequest;
  formatOpenAIResponse(response: InternalChatResponse): unknown;
  formatOpenAIStreamChunk(chunk: InternalStreamChunk): string;
  formatAnthropicResponse(response: InternalChatResponse): unknown;
}

export class CompatibilityLayer implements ICompatibilityLayer {

  public parseOpenAIChatRequest(body: unknown): InternalChatRequest {
    if (!body || typeof body !== 'object') {
      throw new Error('Invalid request body');
    }

    const b = body as Record<string, unknown>;
    if (!b.model || typeof b.model !== 'string') {
      throw new Error('Missing or invalid field: model');
    }
    if (!Array.isArray(b.messages)) {
      throw new Error('Missing or invalid field: messages');
    }

    const request: InternalChatRequest = {
      model: b.model,
      messages: b.messages as ChatMessage[],
      stream: Boolean(b.stream),
    };

    if (typeof b.temperature === 'number') request.temperature = b.temperature;
    if (typeof b.top_p === 'number') request.top_p = b.top_p;
    if (typeof b.max_tokens === 'number') request.max_tokens = b.max_tokens;
    if (typeof b.presence_penalty === 'number') request.presence_penalty = b.presence_penalty;
    if (typeof b.frequency_penalty === 'number') request.frequency_penalty = b.frequency_penalty;
    if (b.stop) request.stop = b.stop as string | string[];
    if (b.tools && Array.isArray(b.tools)) request.tools = b.tools as any[];
    if (b.tool_choice) request.tool_choice = b.tool_choice as any;
    if (typeof b.user === 'string') request.user = b.user;

    return request;
  }

  public parseOpenAICompletionRequest(body: unknown): InternalChatRequest {
    if (!body || typeof body !== 'object') {
      throw new Error('Invalid request body');
    }

    const b = body as Record<string, unknown>;
    if (!b.model || typeof b.model !== 'string') {
      throw new Error('Missing or invalid field: model');
    }
    if (typeof b.prompt !== 'string') {
      throw new Error('Missing or invalid field: prompt');
    }

    const request: InternalChatRequest = {
      model: b.model,
      messages: [
        { role: 'user', content: b.prompt }
      ],
      stream: Boolean(b.stream),
    };

    if (typeof b.temperature === 'number') request.temperature = b.temperature;
    if (typeof b.max_tokens === 'number') request.max_tokens = b.max_tokens;

    return request;
  }

  public parseAnthropicRequest(body: unknown): InternalChatRequest {
    if (!body || typeof body !== 'object') {
      throw new Error('Invalid request body');
    }

    const b = body as Record<string, unknown>;
    if (!b.model || typeof b.model !== 'string') {
      throw new Error('Missing or invalid field: model');
    }
    if (!Array.isArray(b.messages)) {
      throw new Error('Missing or invalid field: messages');
    }

    const messages: ChatMessage[] = [];

    // Anthropic puts system prompt at the top level
    if (typeof b.system === 'string' && b.system.length > 0) {
      messages.push({ role: 'system', content: b.system });
    }

    for (const msg of b.messages as any[]) {
      messages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      });
    }

    const request: InternalChatRequest = {
      model: b.model,
      messages,
      stream: Boolean(b.stream),
    };

    if (typeof b.temperature === 'number') request.temperature = b.temperature;
    if (typeof b.top_p === 'number') request.top_p = b.top_p;
    if (typeof b.max_tokens === 'number') request.max_tokens = b.max_tokens;
    if (b.stop_sequences && Array.isArray(b.stop_sequences)) request.stop = b.stop_sequences;

    return request;
  }

  public formatOpenAIResponse(response: InternalChatResponse): unknown {
    return {
      id: response.id,
      object: 'chat.completion',
      created: response.created,
      model: response.model,
      system_fingerprint: response.system_fingerprint,
      choices: response.choices.map(c => ({
        index: c.index,
        message: c.message,
        finish_reason: c.finish_reason
      })),
      usage: response.usage
    };
  }

  public formatOpenAIStreamChunk(chunk: InternalStreamChunk): string {
    const payload = {
      id: chunk.id,
      object: 'chat.completion.chunk',
      created: chunk.created,
      model: chunk.model,
      system_fingerprint: chunk.system_fingerprint,
      choices: chunk.choices.map(c => ({
        index: c.index,
        delta: c.delta,
        finish_reason: c.finish_reason
      }))
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  public formatAnthropicResponse(response: InternalChatResponse): unknown {
    return {
      id: response.id,
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: response.choices[0]?.message?.content || ''
        }
      ],
      model: response.model,
      stop_reason: response.choices[0]?.finish_reason === 'stop' ? 'end_turn' : 'max_tokens',
      stop_sequence: null,
      usage: {
        input_tokens: response.usage.prompt_tokens,
        output_tokens: response.usage.completion_tokens
      }
    };
  }
}
