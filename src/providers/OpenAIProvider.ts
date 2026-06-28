import type { IProvider, OpenAIProviderConfig, ModelInfo } from './types.js';
import type { InternalChatRequest, InternalChatResponse } from '../types/chat.js';
import https from 'https';

export class OpenAIProvider implements IProvider {
  public readonly id = 'openai';
  public readonly name = 'OpenAI';
  public readonly isMeteredPerToken = true;

  private apiKey: string;
  private baseUrl: string;
  private organization?: string;
  private models: ModelInfo[];

  constructor(config: OpenAIProviderConfig) {
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY || '';
    this.baseUrl = config.baseUrl || 'https://api.openai.com';
    this.organization = config.organization;
    this.models = config.models || [
      { id: 'gpt-4o', name: 'GPT-4o', owned_by: 'openai', input_cost_per_million: 5, output_cost_per_million: 15, pricingLastVerified: '2026-06-28' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', owned_by: 'openai', input_cost_per_million: 0.15, output_cost_per_million: 0.60, pricingLastVerified: '2026-06-28' },
      { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', owned_by: 'openai', input_cost_per_million: 0.50, output_cost_per_million: 1.50, pricingLastVerified: '2026-06-28' }
    ];
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key is missing. Set OPENAI_API_KEY environment variable or pass it in config.');
    }
    
    // Fetch dynamic models
    try {
      const headers = await this.getHeaders();
      const url = new URL(`${this.baseUrl}/v1/models`);
      
      const dynamicModels = await new Promise<any[]>((resolve, reject) => {
        const req = https.get({
          hostname: url.hostname,
          port: url.port ? parseInt(url.port) : 443,
          path: url.pathname,
          headers
        }, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`Failed to fetch models: ${res.statusCode}`));
            return;
          }
          let data = '';
          res.on('data', chunk => data += chunk.toString());
          res.on('end', () => {
            try {
              resolve(JSON.parse(data).data || []);
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
      });
      
      const knownModels = new Map(this.models.map(m => [m.id, m]));
      for (const dm of dynamicModels) {
        if (!knownModels.has(dm.id)) {
          this.models.push({
            id: dm.id,
            name: dm.id,
            owned_by: dm.owned_by || 'openai',
            input_cost_per_million: null,
            output_cost_per_million: null,
          });
        }
      }
    } catch (e) {
      // If fetching fails, fallback to static models, it's fine.
      console.warn('Failed to fetch OpenAI dynamic models, falling back to static list:', e);
    }
  }

  getEndpointUrl(): string {
    return `${this.baseUrl}/v1/chat/completions`;
  }

  async getHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    };
    if (this.organization) {
      headers['OpenAI-Organization'] = this.organization;
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
      usage: data.usage,
      created: data.created,
      system_fingerprint: data.system_fingerprint
    };
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
        prompt_tokens: 0, // Streaming doesn't give usage typically in basic OpenAI without include_usage
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
