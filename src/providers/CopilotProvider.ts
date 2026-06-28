import fs from 'fs';
import path from 'path';
import os from 'os';
import type { IProvider, CopilotProviderConfig, ModelInfo } from './types.js';
import type { InternalChatRequest, InternalChatResponse } from '../types/chat.js';
import { AuthManager } from '../components/AuthManager.js';

export class CopilotProvider implements IProvider {
  public readonly id = 'copilot';
  public readonly name = 'GitHub Copilot';
  public readonly isMeteredPerToken = true;

  private authManager: AuthManager;
  private requireConsent: boolean;

  constructor(config: CopilotProviderConfig) {
    this.authManager = new AuthManager({ tokenStoragePath: config.tokenStoragePath });
    this.requireConsent = config.requireConsent !== false;
  }

  async initialize(): Promise<void> {
    if (this.requireConsent) {
      const consentPath = path.join(os.homedir(), '.relay', 'consent.json');
      if (!fs.existsSync(consentPath)) {
        throw new Error('You must accept the GitHub Copilot terms of service. Run "relay copilot-consent" or use "--accept-copilot-terms"');
      }
    }
    await this.authManager.initialize();
  }

  getEndpointUrl(): string {
    return `${this.authManager.getApiEndpoint()}/chat/completions`;
  }

  async getHeaders(): Promise<Record<string, string>> {
    await this.authManager.getCopilotToken(); // Ensures token is fresh
    return this.authManager.getCopilotHeaders();
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
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: fullContent },
          finish_reason
        }
      ]
    };
  }

  async getModelList(): Promise<ModelInfo[]> {
    return [
      { id: 'gpt-4o', name: 'GPT-4o', owned_by: 'github', input_cost_per_million: null, output_cost_per_million: null, pricingLastVerified: '2026-06-28' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', owned_by: 'github', input_cost_per_million: null, output_cost_per_million: null, pricingLastVerified: '2026-06-28' },
      { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', owned_by: 'github', input_cost_per_million: null, output_cost_per_million: null, pricingLastVerified: '2026-06-28' }
    ];
  }

  async refreshCredentials(): Promise<void> {
    await this.authManager.refresh();
  }

  async checkHealth(): Promise<boolean> {
    return this.authManager.getStatus().authenticated;
  }

  destroy(): void {
    this.authManager.destroy();
  }

  // Convenience methods
  async login(): Promise<void> {
    await this.authManager.login();
  }

  async logout(): Promise<void> {
    await this.authManager.logout();
  }

  async whoami(): Promise<any> {
    return this.authManager.whoami();
  }
}
