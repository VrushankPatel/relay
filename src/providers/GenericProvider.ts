import type { IProvider, GenericProviderConfig, ModelInfo } from './types.js';
import type { InternalChatRequest, InternalChatResponse } from '../types/chat.js';

export class GenericProvider implements IProvider {
  public readonly id = 'generic';
  public readonly name: string;
  public readonly isMeteredPerToken: boolean;

  private baseUrl: string;
  private apiKey?: string;
  private customHeaders: Record<string, string>;
  private models: ModelInfo[];

  constructor(config: GenericProviderConfig) {
    this.name = (config as any).name || 'Generic';
    this.isMeteredPerToken = config.isMeteredPerToken ?? true;
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.customHeaders = config.customHeaders || {};
    this.models = config.models || [];
  }

  async initialize(): Promise<void> {
    if (!this.baseUrl) {
      throw new Error('Generic provider requires a baseUrl');
    }
  }

  getEndpointUrl(): string {
    // If baseUrl already ends with the path, just return it. Otherwise append.
    if (this.baseUrl.endsWith('/chat/completions')) {
      return this.baseUrl;
    }
    return `${this.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
  }

  async getHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.customHeaders
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  transformRequestBody(req: InternalChatRequest): Record<string, unknown> {
    return { ...req };
  }

  parseResponse(raw: unknown): InternalChatResponse {
    const data = raw as any;
    return {
      id: data.id,
      model: data.model,
      choices: data.choices,
      usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      created: data.created,
      system_fingerprint: data.system_fingerprint
    };
  }

  async getModelList(): Promise<ModelInfo[]> {
    return this.models;
  }

  async refreshCredentials(): Promise<void> {
    // no-op
  }

  assembleStream(chunks: string[]): InternalChatResponse {
    let fullContent = '';
    let id = '';
    let model = '';
    let finish_reason = null;
    let system_fingerprint = '';
    let created = 0;

    for (const chunk of chunks) {
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();
          if (dataStr === '[DONE]') continue;
          try {
            const parsed = JSON.parse(dataStr);
            if (!id && parsed.id) id = parsed.id;
            if (!model && parsed.model) model = parsed.model;
            if (!created && parsed.created) created = parsed.created;
            if (parsed.system_fingerprint) system_fingerprint = parsed.system_fingerprint;
            
            if (parsed.choices && parsed.choices.length > 0) {
              const choice = parsed.choices[0];
              if (choice.delta?.content) {
                fullContent += choice.delta.content;
              }
              if (choice.finish_reason) {
                finish_reason = choice.finish_reason;
              }
            }
          } catch (e) {
            // Ignore parse errors on partial chunks
          }
        }
      }
    }

    return {
      id: id || `chatcmpl-${Date.now()}`,
      model: model || 'unknown',
      created: created || Math.floor(Date.now() / 1000),
      system_fingerprint,
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
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

  async checkHealth(): Promise<boolean> {
    return true;
  }

  destroy(): void {
    // no-op
  }
}
