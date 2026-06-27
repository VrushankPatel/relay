import type { ProviderConfig, IProvider } from './types.js';
import { OpenAIProvider } from './OpenAIProvider.js';
import { AnthropicProvider } from './AnthropicProvider.js';
import { CopilotProvider } from './CopilotProvider.js';
import { GenericProvider } from './GenericProvider.js';

export function createProvider(config: ProviderConfig): IProvider {
  switch (config.type) {
    case 'openai': return new OpenAIProvider(config);
    case 'anthropic': return new AnthropicProvider(config);
    case 'copilot': return new CopilotProvider(config);
    case 'generic': return new GenericProvider(config);
    default: throw new Error(`Unknown provider type: ${(config as any).type}`);
  }
}

export type { IProvider, ProviderConfig, ModelInfo } from './types.js';
export { OpenAIProvider } from './OpenAIProvider.js';
export { AnthropicProvider } from './AnthropicProvider.js';
export { CopilotProvider } from './CopilotProvider.js';
export { GenericProvider } from './GenericProvider.js';
