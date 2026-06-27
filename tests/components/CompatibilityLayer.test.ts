import { describe, it, expect } from 'vitest';
import { CompatibilityLayer } from '../../src/components/CompatibilityLayer.js';

describe('CompatibilityLayer', () => {
  const layer = new CompatibilityLayer();

  it('parses OpenAI Chat request', () => {
    const req = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.5,
      stream: true
    };
    const parsed = layer.parseOpenAIChatRequest(req);
    expect(parsed.model).toBe('gpt-4o');
    expect(parsed.messages.length).toBe(1);
    expect(parsed.temperature).toBe(0.5);
    expect(parsed.stream).toBe(true);
  });

  it('parses OpenAI Completion request', () => {
    const req = {
      model: 'gpt-3.5',
      prompt: 'hello world'
    };
    const parsed = layer.parseOpenAICompletionRequest(req);
    expect(parsed.model).toBe('gpt-3.5');
    expect(parsed.messages[0].content).toBe('hello world');
  });

  it('parses Anthropic request', () => {
    const req = {
      model: 'claude-3-5',
      system: 'system prompt',
      messages: [{ role: 'user', content: 'hello' }]
    };
    const parsed = layer.parseAnthropicRequest(req);
    expect(parsed.model).toBe('claude-3-5');
    expect(parsed.messages[0].role).toBe('system');
    expect(parsed.messages[0].content).toBe('system prompt');
  });
});
