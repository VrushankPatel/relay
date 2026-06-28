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
      { id: 'claude-sonnet-4-20250514', name: 'Claude 4 Sonnet', owned_by: 'anthropic', input_cost_per_million: 3, output_cost_per_million: 15, pricingLastVerified: new Date().toISOString().split('T')[0] },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', owned_by: 'anthropic', input_cost_per_million: 0.25, output_cost_per_million: 1.25, pricingLastVerified: new Date().toISOString().split('T')[0] }
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
    
    return payload;
  }

  parseResponse(raw: unknown): InternalChatResponse {
    const data = raw as any;
    
    let finish_reason = data.stop_reason;
    if (finish_reason === 'end_turn') finish_reason = 'stop';
    if (finish_reason === 'max_tokens') finish_reason = 'length';
    
    return {
      id: data.id,
      model: data.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: data.content && data.content.length > 0 ? data.content[0].text : ''
          },
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
