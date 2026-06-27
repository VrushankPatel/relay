import { describe, it, expect } from 'vitest';
import { AnthropicProvider } from '../../src/providers/AnthropicProvider.js';
import type { InternalChatRequest } from '../../src/types/chat.js';

describe('AnthropicProvider', () => {
  it('transformRequestBody extracts system messages and sets default max_tokens', () => {
    const provider = new AnthropicProvider({ type: 'anthropic', apiKey: 'test' });
    const req: InternalChatRequest = {
      model: 'claude-3',
      stream: false,
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'hello' }
      ],
      stop: 'end'
    };
    const transformed = provider.transformRequestBody(req);
    expect(transformed.system).toBe('You are helpful');
    expect(transformed.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(transformed.max_tokens).toBe(4096);
    expect(transformed.stop_sequences).toEqual(['end']);
  });

  it('parseResponse maps stop_reason correctly', () => {
    const provider = new AnthropicProvider({ type: 'anthropic', apiKey: 'test' });
    const raw = {
      id: 'msg_123',
      model: 'claude-3',
      content: [{ text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 }
    };
    const parsed = provider.parseResponse(raw);
    expect(parsed.id).toBe('msg_123');
    expect(parsed.choices[0].message.content).toBe('hi');
    expect(parsed.choices[0].finish_reason).toBe('stop');
    expect(parsed.usage.prompt_tokens).toBe(10);
    expect(parsed.usage.completion_tokens).toBe(20);
  });

  it('getHeaders includes required headers', async () => {
    const provider = new AnthropicProvider({ type: 'anthropic', apiKey: 'test-key', anthropicVersion: '2023-06-01' });
    const headers = await provider.getHeaders();
    expect(headers['x-api-key']).toBe('test-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('getEndpointUrl returns correct URLs', () => {
    const provider = new AnthropicProvider({ type: 'anthropic', baseUrl: 'https://custom.api' });
    expect(provider.getEndpointUrl()).toBe('https://custom.api/v1/messages');
  });
});
