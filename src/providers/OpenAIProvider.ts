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
    const today = new Date().toISOString().split('T')[0];
    this.models = config.models || [
      { id: 'gpt-4o', name: 'GPT-4o', owned_by: 'openai', input_cost_per_million: 5, output_cost_per_million: 15, pricingLastVerified: today },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', owned_by: 'openai', input_cost_per_million: 0.15, output_cost_per_million: 0.60, pricingLastVerified: today },
      { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', owned_by: 'openai', input_cost_per_million: 0.50, output_cost_per_million: 1.50, pricingLastVerified: today }
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
