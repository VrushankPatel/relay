import type { IProvider, AnthropicProviderConfig, ModelInfo } from './types.js';
import type { InternalChatRequest, InternalChatResponse } from '../types/chat.js';

export class AnthropicProvider implements IProvider {
  public readonly id = 'anthropic';
  public readonly name = 'Anthropic';
  public readonly isMeteredPerToken = true;

  private apiKey: string;
  private baseUrl: string;
  private anthropicVersion: string;
  private models: ModelInfo[];

  constructor(config: AnthropicProviderConfig) {
    this.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com';
    this.anthropicVersion = config.anthropicVersion || '2023-06-01';
    this.models = config.models || [
      { id: 'claude-sonnet-4-20250514', name: 'Claude 4 Sonnet', owned_by: 'anthropic', input_cost_per_million: 3, output_cost_per_million: 15, pricingLastVerified: '2026-06-28' },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', owned_by: 'anthropic', input_cost_per_million: 0.25, output_cost_per_million: 1.25, pricingLastVerified: '2026-06-28' }
    ];
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new Error('Anthropic API key is missing. Set ANTHROPIC_API_KEY environment variable or pass it in config.');
    }
  }

  getEndpointUrl(): string {
    return `${this.baseUrl}/v1/messages`;
  }

  async getHeaders(): Promise<Record<string, string>> {
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': this.anthropicVersion,
      'Content-Type': 'application/json'
    };
  }

  transformRequestBody(req: InternalChatRequest): Record<string, unknown> {
    let systemMessage = '';
    const anthropicMessages = [];

    for (const msg of req.messages) {
      if (msg.role === 'system') {
        systemMessage += (systemMessage ? '\n' : '') + msg.content;
      } else {
        anthropicMessages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content
        });
      }
    }

    const payload: Record<string, unknown> = {
      model: req.model,
      messages: anthropicMessages,
      max_tokens: req.max_tokens || 4096,
      stream: req.stream
    };

    if (systemMessage) {
      payload.system = systemMessage;
    }
    if (req.temperature !== undefined) payload.temperature = req.temperature;
    if (req.top_p !== undefined) payload.top_p = req.top_p;
    if (req.stop !== undefined) payload.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
    
    if (req.tools && req.tools.length > 0) {
      payload.tools = req.tools.map(t => ({
        name: t.function.name,
        description: t.function.description || '',
        input_schema: t.function.parameters || { type: 'object', properties: {} }
      }));
    }

    if (req.tool_choice) {
      if (typeof req.tool_choice === 'string') {
        payload.tool_choice = { type: req.tool_choice === 'none' ? 'auto' : req.tool_choice };
      } else if (typeof req.tool_choice === 'object' && req.tool_choice.type === 'function' && req.tool_choice.function?.name) {
        payload.tool_choice = { type: 'tool', name: req.tool_choice.function!.name };
      }
    }
    
    return payload;
  }

  parseResponse(raw: unknown): InternalChatResponse {
    const data = raw as any;
    
    let finish_reason = data.stop_reason;
    if (finish_reason === 'end_turn') finish_reason = 'stop';
    let textContent = '';
    const toolCalls: any[] = [];
    let hasToolUse = false;

    if (data.content && Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text' || (!block.type && block.text)) {
          textContent += block.text;
        } else if (block.type === 'tool_use') {
          hasToolUse = true;
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {})
            }
          });
        }
      }
    }
    
    if (finish_reason === 'tool_use' || hasToolUse) finish_reason = 'tool_calls';
    
    const message: any = {
      role: 'assistant',
      content: textContent
    };
    
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    return {
      id: data.id,
      model: data.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: finish_reason || null
        }
      ],
      usage: {
        prompt_tokens: data.usage?.input_tokens || 0,
        completion_tokens: data.usage?.output_tokens || 0,
        total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
      },
      created: Math.floor(Date.now() / 1000)
    };
  }

  assembleStream(chunks: string[]): InternalChatResponse {
    let fullContent = '';
    let id = '';
    let model = '';
    let finish_reason = null;
    let inputTokens = 0;
    let outputTokens = 0;

    for (const chunk of chunks) {
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.trim().slice(6).trim();
          if (!dataStr) continue;
          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.type === 'message_start' && parsed.message) {
              id = parsed.message.id || id;
              model = parsed.message.model || model;
              inputTokens += parsed.message.usage?.input_tokens || 0;
              outputTokens += parsed.message.usage?.output_tokens || 0;
            } else if (parsed.type === 'content_block_delta' && parsed.delta) {
              if (parsed.delta.type === 'text_delta' && parsed.delta.text) {
                fullContent += parsed.delta.text;
              }
            } else if (parsed.type === 'message_delta' && parsed.delta) {
              if (parsed.delta.stop_reason) {
                let reason = parsed.delta.stop_reason;
                if (reason === 'end_turn') reason = 'stop';
                if (reason === 'max_tokens') reason = 'length';
                finish_reason = reason;
              }
              outputTokens += parsed.usage?.output_tokens || 0;
            }
          } catch (e) {
            // Ignore parse errors on partial chunks
          }
        }
      }
    }

    return {
      id: id || `msg_${Date.now()}`,
      model: model || 'unknown',
      created: Math.floor(Date.now() / 1000),
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens
      },
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: fullContent
          },
          finish_reason
        }
      ]
    };
  }

  async getModelList(): Promise<ModelInfo[]> {
    return this.models;
  }

  async refreshCredentials(): Promise<void> {
    // no-op
  }

  async checkHealth(): Promise<boolean> {
    return true;
  }

  destroy(): void {
    // no-op
  }
}
