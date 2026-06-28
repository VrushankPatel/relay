import { describe, it, expect } from 'vitest';
import { GenericProvider } from '../../src/providers/GenericProvider.js';
import type { InternalChatRequest } from '../../src/types/chat.js';

describe('GenericProvider', () => {
  it('transformRequestBody produces correct shapes', () => {
    const provider = new GenericProvider({ type: 'generic', baseUrl: 'http://test' });
    const req: InternalChatRequest = {
      model: 'test-model',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    };
    const transformed = provider.transformRequestBody(req);
    expect(transformed).toEqual(req);
  });

  it('parseResponse maps correctly', () => {
    const provider = new GenericProvider({ type: 'generic', baseUrl: 'http://test' });
    const raw = {
      id: '123',
      model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }]
    };
    const parsed = provider.parseResponse(raw);
    expect(parsed.id).toBe('123');
    expect(parsed.choices[0].message.content).toBe('hi');
  });

  it('getHeaders includes required headers', async () => {
    const provider = new GenericProvider({ type: 'generic', baseUrl: 'http://test', apiKey: 'test-key', customHeaders: { 'X-Custom': 'val' } });
    const headers = await provider.getHeaders();
    expect(headers['Authorization']).toBe('Bearer test-key');
    expect(headers['X-Custom']).toBe('val');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('getEndpointUrl returns correct URLs', () => {
    const p1 = new GenericProvider({ type: 'generic', baseUrl: 'http://test' });
    expect(p1.getEndpointUrl()).toBe('http://test/v1/chat/completions');

    const p2 = new GenericProvider({ type: 'generic', baseUrl: 'http://test/v1/chat/completions' });
    expect(p2.getEndpointUrl()).toBe('http://test/v1/chat/completions');
  });

  it('assembleStream processes SSE chunks correctly', () => {
    const provider = new GenericProvider({ type: 'generic', baseUrl: 'http://test' });
    const chunks = [
      'data: {"id":"chatcmpl-123","model":"generic-model","created":12345,"choices":[{"index":0,"delta":{"content":"Hello "},"finish_reason":null}]}\n',
      'data: {"id":"chatcmpl-123","model":"generic-model","created":12345,"choices":[{"index":0,"delta":{"content":"world!"},"finish_reason":"stop"}]}\n',
      'data: [DONE]\n'
    ];
    const assembled = provider.assembleStream(chunks);
    expect(assembled.id).toBe('chatcmpl-123');
    expect(assembled.model).toBe('generic-model');
    expect(assembled.choices[0].message.content).toBe('Hello world!');
    expect(assembled.choices[0].finish_reason).toBe('stop');
  });
});
