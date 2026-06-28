import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from '../../src/providers/OpenAIProvider.js';
import { AnthropicProvider } from '../../src/providers/AnthropicProvider.js';
import { CopilotProvider } from '../../src/providers/CopilotProvider.js';

describe('Model Cost Validation', () => {
  it('OpenAI models should have costs defined for statically known models', async () => {
    const provider = new OpenAIProvider({ type: 'openai', apiKey: 'test' });
    const models = await provider.getModelList();
    for (const model of models) {
      if (['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'].includes(model.id)) {
        expect(model.input_cost_per_million).not.toBeNull();
        expect(model.output_cost_per_million).not.toBeNull();
      }
    }
  });

  it('Anthropic models should have costs defined for statically known models', async () => {
    const provider = new AnthropicProvider({ type: 'anthropic', apiKey: 'test' });
    const models = await provider.getModelList();
    for (const model of models) {
      if (['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'].includes(model.id)) {
        expect(model.input_cost_per_million).not.toBeNull();
        expect(model.output_cost_per_million).not.toBeNull();
      }
    }
  });

  it('Copilot models can tolerate null costs but must have pricingLastVerified', async () => {
    const provider = new CopilotProvider({ type: 'copilot', requireConsent: false });
    const models = await provider.getModelList();
    for (const model of models) {
      expect(model.pricingLastVerified).not.toBeUndefined();
    }
  });
});
