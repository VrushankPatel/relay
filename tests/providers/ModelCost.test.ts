import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIProvider } from '../../src/providers/OpenAIProvider.js';
import { AnthropicProvider } from '../../src/providers/AnthropicProvider.js';
import { CopilotProvider } from '../../src/providers/CopilotProvider.js';
import https from 'https';

vi.mock('https');

describe('Model Cost Validation', () => {
  it('OpenAI models should have costs defined for statically known models', async () => {
    const provider = new OpenAIProvider({ type: 'openai', apiKey: 'test' });
    
    // Set up mock for https.get
    const mockRequest = { on: vi.fn() };
    const mockResponse = {
      statusCode: 200,
      on: vi.fn().mockImplementation((event, callback) => {
        if (event === 'data') {
          callback(Buffer.from(JSON.stringify({ data: [{ id: 'new-model-123' }, { id: 'gpt-4o' }] })));
        }
        if (event === 'end') {
          callback();
        }
      })
    };
    (https.get as any).mockImplementation((options: any, callback: any) => {
      callback(mockResponse);
      return mockRequest;
    });

    await provider.initialize();
    
    const models = await provider.getModelList();
    
    const staticModel = models.find(m => m.id === 'gpt-4o');
    expect(staticModel).toBeDefined();
    expect(staticModel!.input_cost_per_million).not.toBeNull();
    expect(staticModel!.pricingLastVerified).toBe('2026-06-28');
    
    const newModel = models.find(m => m.id === 'new-model-123');
    expect(newModel).toBeDefined();
    expect(newModel!.input_cost_per_million).toBeNull(); // dynamically fetched without price
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
