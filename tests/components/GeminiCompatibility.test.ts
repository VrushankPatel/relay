import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompatibilityLayer } from '../../src/components/CompatibilityLayer.js';
import { getLogger } from '../../src/utils/logger.js';

vi.mock('../../src/utils/logger.js', () => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
  return {
    getLogger: () => mockLogger,
    createChildLogger: () => mockLogger
  };
});

describe('Gemini Compatibility Layer', () => {
  let compatibilityLayer: CompatibilityLayer;
  let loggerMock: any;

  beforeEach(() => {
    compatibilityLayer = new CompatibilityLayer();
    loggerMock = getLogger();
    vi.clearAllMocks();
  });

  describe('parseGeminiRequest', () => {
    it('should parse a simple Gemini request into InternalChatRequest', () => {
      const body = {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Hello Gemini!' }]
          }
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 150,
          stopSequences: ['DONE']
        }
      };

      const result = compatibilityLayer.parseOpenAIChatRequest === undefined ? null : (compatibilityLayer as any).parseGeminiRequest(body, 'gemini-model', false);

      expect(result).toEqual({
        model: 'gemini-model',
        messages: [
          { role: 'user', content: 'Hello Gemini!' }
        ],
        stream: false,
        temperature: 0.7,
        max_tokens: 150,
        stop: ['DONE']
      });
    });

    it('should parse Gemini request with systemInstructions and ignored fields', () => {
      const body = {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Hello!' }]
          }
        ],
        systemInstruction: {
          parts: [{ text: 'Be a coder.' }]
        },
        generationConfig: {
          topK: 50,
          thinkingConfig: { thinkingBudget: 100 },
          safetySettings: { threshold: 'BLOCK' }
        }
      };

      const result = (compatibilityLayer as any).parseGeminiRequest(body, 'gemini-model', true);

      expect(result.messages).toEqual([
        { role: 'system', content: 'Be a coder.' },
        { role: 'user', content: 'Hello!' }
      ]);
      expect(result.stream).toBe(true);

      // Verify ignored fields are logged at debug level
      expect(loggerMock.debug).toHaveBeenCalled();
      const calls = loggerMock.debug.mock.calls;
      const loggedFields = calls.map((c: any) => c[0]?.droppedFields || []);
      const flattened = loggedFields.reduce((acc: any, val: any) => acc.concat(val), []);
      expect(flattened).toContain('topK');
      expect(flattened).toContain('thinkingConfig');
      expect(flattened).toContain('safetySettings');
    });

    it('should parse Gemini tools and function calls', () => {
      const body = {
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'get_weather',
                  args: { city: 'Seattle' }
                }
              }
            ]
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'get_weather',
                  response: { temp: '72F' }
                }
              }
            ]
          }
        ],
        tools: [
          {
            functionDeclarations: [
              {
                name: 'get_weather',
                description: 'Get weather description',
                parameters: {
                  type: 'OBJECT',
                  properties: { city: { type: 'STRING' } }
                }
              }
            ]
          }
        ]
      };

      const result = (compatibilityLayer as any).parseGeminiRequest(body, 'gemini-model', false);

      expect(result.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather description',
            parameters: {
              type: 'OBJECT',
              properties: { city: { type: 'STRING' } }
            }
          }
        }
      ]);

      expect(result.messages[0].role).toBe('assistant');
      expect(result.messages[0].tool_calls).toBeDefined();
      expect(result.messages[0].tool_calls[0].function.name).toBe('get_weather');
      expect(JSON.parse(result.messages[0].tool_calls[0].function.arguments)).toEqual({ city: 'Seattle' });

      expect(result.messages[1].role).toBe('tool');
      expect(result.messages[1].tool_call_id).toBe('get_weather');
      expect(JSON.parse(result.messages[1].content)).toEqual({ temp: '72F' });
    });
  });

  describe('formatGeminiResponse', () => {
    it('should format InternalChatResponse into Gemini format', () => {
      const response = {
        id: 'res-123',
        model: 'gemini-model',
        created: 123456,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hi there!'
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30
        }
      };

      const result = (compatibilityLayer as any).formatGeminiResponse(response);

      expect(result).toEqual({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'Hi there!' }]
            },
            finishReason: 'STOP',
            index: 0
          }
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
          totalTokenCount: 30
        }
      });
    });

    it('should format function calls into Gemini response', () => {
      const response = {
        id: 'res-123',
        model: 'gemini-model',
        created: 123456,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"city":"Seattle"}'
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30
        }
      };

      const result = (compatibilityLayer as any).formatGeminiResponse(response);

      expect(result.candidates[0].content.parts[0]).toEqual({
        functionCall: {
          name: 'get_weather',
          args: { city: 'Seattle' }
        }
      });
      expect(result.candidates[0].finishReason).toBe('STOP');
    });
  });

  describe('formatGeminiStreamChunk', () => {
    it('should format stream chunk to Gemini text format', () => {
      const chunk = {
        id: 'res-123',
        model: 'gemini-model',
        created: 123456,
        choices: [
          {
            index: 0,
            delta: {
              content: 'hello'
            },
            finish_reason: null
          }
        ]
      };

      const result = (compatibilityLayer as any).formatGeminiStreamChunk(chunk);
      const parsed = JSON.parse(result);

      expect(parsed.candidates[0].content.parts[0].text).toBe('hello');
    });
  });

  describe('parseProviderStreamChunk', () => {
    it('should parse OpenAI stream chunks', () => {
      const chunk = 'data: {"choices": [{"delta": {"content": "world"}, "finish_reason": "length"}]}\n';
      const parsed = compatibilityLayer.parseProviderStreamChunk(chunk, 'openai');
      expect(parsed).toEqual({
        content: 'world',
        finishReason: 'length'
      });
    });

    it('should parse Anthropic stream chunks', () => {
      const chunk = 'data: {"type": "content_block_delta", "delta": {"text": "hello"}}\ndata: {"type": "message_delta", "delta": {"stop_reason": "end_turn"}}\n';
      const parsed = compatibilityLayer.parseProviderStreamChunk(chunk, 'anthropic');
      expect(parsed).toEqual({
        content: 'hello',
        finishReason: 'end_turn'
      });
    });
  });
});
