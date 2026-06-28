import { InternalChatRequest, InternalChatResponse, InternalStreamChunk, ChatMessage } from '../types/chat.js';
import { getLogger } from '../utils/logger.js';

export interface ICompatibilityLayer {
  parseOpenAIChatRequest(body: unknown): InternalChatRequest;
  parseOpenAICompletionRequest(body: unknown): InternalChatRequest;
  parseAnthropicRequest(body: unknown): InternalChatRequest;
  formatOpenAIResponse(response: InternalChatResponse): unknown;
  formatOpenAIStreamChunk(chunk: InternalStreamChunk): string;
  formatAnthropicResponse(response: InternalChatResponse): unknown;
  parseGeminiRequest(body: unknown, model: string, isStream: boolean): InternalChatRequest;
  formatGeminiResponse(response: InternalChatResponse): unknown;
  formatGeminiStreamChunk(chunk: any): string;
  parseProviderStreamChunk(chunk: string, providerId: string): { content: string, finishReason: string | null };
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

  public parseGeminiRequest(body: unknown, model: string, isStream: boolean): InternalChatRequest {
    if (!body || typeof body !== 'object') {
      throw new Error('Invalid request body');
    }

    const b = body as Record<string, any>;
    const messages: ChatMessage[] = [];

    // Parse system instructions if present
    if (b.systemInstruction && typeof b.systemInstruction === 'object') {
      const parts = b.systemInstruction.parts || [];
      const systemContent = parts.map((p: any) => p.text || '').join('\n').trim();
      if (systemContent) {
        messages.push({ role: 'system', content: systemContent });
      }
    }

    // Parse contents
    if (Array.isArray(b.contents)) {
      for (const content of b.contents) {
        const role = content.role === 'model' ? 'assistant' : 'user';
        const parts = content.parts || [];
        
        let textContent = '';
        let toolCalls: any[] = [];
        let toolCallId: string | undefined;
        let toolResponseContent = '';

        for (const part of parts) {
          if (part.text) {
            textContent += (textContent ? '\n' : '') + part.text;
          } else if (part.functionCall) {
            const name = part.functionCall.name;
            const args = part.functionCall.args || {};
            toolCalls.push({
              id: `call_${Math.random().toString(36).substr(2, 9)}`,
              type: 'function',
              function: {
                name,
                arguments: JSON.stringify(args)
              }
            });
          } else if (part.functionResponse) {
            toolCallId = part.functionResponse.name;
            toolResponseContent = JSON.stringify(part.functionResponse.response || {});
          }
        }

        if (toolCallId) {
          messages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: toolResponseContent
          });
        } else {
          const msg: ChatMessage = { role, content: textContent };
          if (toolCalls.length > 0) {
            msg.tool_calls = toolCalls;
          }
          messages.push(msg);
        }
      }
    }

    const request: InternalChatRequest = {
      model,
      messages,
      stream: isStream
    };

    const droppedFields: string[] = [];

    // Extract generation config
    if (b.generationConfig && typeof b.generationConfig === 'object') {
      const gc = b.generationConfig;
      if (typeof gc.temperature === 'number') request.temperature = gc.temperature;
      if (typeof gc.topP === 'number') request.top_p = gc.topP;
      if (typeof gc.maxOutputTokens === 'number') request.max_tokens = gc.maxOutputTokens;
      if (gc.stopSequences && Array.isArray(gc.stopSequences)) request.stop = gc.stopSequences;

      // Log ignored fields
      for (const field of ['topK', 'thinkingConfig', 'safetySettings']) {
        if (gc[field] !== undefined) {
          droppedFields.push(field);
        }
      }
    }

    // Tools mapping
    if (Array.isArray(b.tools)) {
      const parsedTools: any[] = [];
      for (const t of b.tools) {
        if (Array.isArray(t.functionDeclarations)) {
          for (const fd of t.functionDeclarations) {
            parsedTools.push({
              type: 'function',
              function: {
                name: fd.name,
                description: fd.description || '',
                parameters: fd.parameters || { type: 'object', properties: {} }
              }
            });
          }
        }
      }
      if (parsedTools.length > 0) {
        request.tools = parsedTools;
      }
    }

    if (droppedFields.length > 0) {
      getLogger().debug({ droppedFields }, 'Gemini-only request configuration fields ignored');
    }

    return request;
  }

  public formatGeminiResponse(response: InternalChatResponse): unknown {
    const candidates = response.choices.map(c => {
      const parts: any[] = [];
      if (c.message.content) {
        parts.push({ text: c.message.content });
      }
      if (c.message.tool_calls) {
        for (const tc of c.message.tool_calls) {
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch (e) {}
          parts.push({
            functionCall: {
              name: tc.function.name,
              args
            }
          });
        }
      }

      let finishReason = 'STOP';
      if (c.finish_reason === 'length') finishReason = 'MAX_TOKENS';
      else if (c.finish_reason === 'content_filter') finishReason = 'SAFETY';

      return {
        content: {
          role: 'model',
          parts
        },
        finishReason,
        index: c.index
      };
    });

    return {
      candidates,
      usageMetadata: {
        promptTokenCount: response.usage?.prompt_tokens || 0,
        candidatesTokenCount: response.usage?.completion_tokens || 0,
        totalTokenCount: response.usage?.total_tokens || 0
      }
    };
  }

  public formatGeminiStreamChunk(chunk: any): string {
    const parts: any[] = [];
    let text = '';
    let finishReason = '';

    if (chunk && typeof chunk === 'object') {
      if (chunk.content !== undefined) {
        text = chunk.content;
        if (chunk.finishReason) {
          finishReason = chunk.finishReason;
        }
      } else {
        if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) {
          text = chunk.choices[0].delta.content || '';
        }
        if (chunk.choices && chunk.choices[0] && chunk.choices[0].finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }
      }
    }

    parts.push({ text });

    let geminiFinishReason = '';
    if (finishReason) {
      geminiFinishReason = 'STOP';
      if (finishReason === 'length') geminiFinishReason = 'MAX_TOKENS';
      else if (finishReason === 'content_filter') geminiFinishReason = 'SAFETY';
    }

    const payload: any = {
      candidates: [
        {
          content: {
            role: 'model',
            parts
          },
          index: 0
        }
      ]
    };

    if (geminiFinishReason) {
      payload.candidates[0].finishReason = geminiFinishReason;
    }

    return JSON.stringify(payload) + '\n';
  }

  public parseProviderStreamChunk(chunk: string, providerId: string): { content: string, finishReason: string | null } {
    let content = '';
    let finishReason: string | null = null;

    const lines = chunk.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ')) {
        const dataStr = trimmed.slice(6).trim();
        if (dataStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(dataStr);
          if (providerId === 'anthropic') {
            if (parsed.type === 'content_block_delta' && parsed.delta && parsed.delta.text) {
              content += parsed.delta.text;
            }
            if (parsed.type === 'message_delta' && parsed.delta && parsed.delta.stop_reason) {
              finishReason = parsed.delta.stop_reason;
            }
          } else {
            if (parsed.choices && parsed.choices[0]) {
              const choice = parsed.choices[0];
              if (choice.delta && choice.delta.content) {
                content += choice.delta.content;
              }
              if (choice.finish_reason) {
                finishReason = choice.finish_reason;
              }
            }
          }
        } catch (e) {
          // ignore parsing error on partial lines
        }
      }
    }

    return { content, finishReason };
  }
}
