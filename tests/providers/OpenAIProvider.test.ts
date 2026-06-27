import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from '../../src/providers/OpenAIProvider.js';
import type { InternalChatRequest } from '../../src/types/chat.js';

describe('OpenAIProvider', () => {
  it('transformRequestBody produces correct shapes', () => {
    const provider = new OpenAIProvider({ type: 'openai', apiKey: 'test' });
    const req: InternalChatRequest = {
      model: 'gpt-4',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    };
    const transformed = provider.transformRequestBody(req);
    expect(transformed).toEqual(req);
  });

  it('parseResponse maps correctly', () => {
    const provider = new OpenAIProvider({ type: 'openai', apiKey: 'test' });
    const raw = {
      id: 'chatcmpl-123',
      model: 'gpt-4',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      created: 123456
    };
    const parsed = provider.parseResponse(raw);
    expect(parsed.id).toBe('chatcmpl-123');
    expect(parsed.choices[0].message.content).toBe('hi');
  });

  it('getHeaders includes required headers', async () => {
    const provider = new OpenAIProvider({ type: 'openai', apiKey: 'test-key', organization: 'test-org' });
    const headers = await provider.getHeaders();
    expect(headers['Authorization']).toBe('Bearer test-key');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['OpenAI-Organization']).toBe('test-org');
  });

  it('getEndpointUrl returns correct URLs', () => {
    const provider = new OpenAIProvider({ type: 'openai', baseUrl: 'https://custom.api' });
    expect(provider.getEndpointUrl()).toBe('https://custom.api/v1/chat/completions');
  });
});
