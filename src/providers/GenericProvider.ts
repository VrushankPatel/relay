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

  async checkHealth(): Promise<boolean> {
    return true;
  }

  destroy(): void {
    // no-op
  }
}
