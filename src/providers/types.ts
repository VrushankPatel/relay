/**
 * Provider abstraction types for Relay.
 *
 * Every upstream LLM backend implements IProvider. Provider-specific
 * concerns (auth, headers, endpoint URLs, request/response shape) live
 * exclusively inside the provider implementation — the rest of the
 * pipeline operates on InternalChatRequest / InternalChatResponse.
 */

import type { InternalChatRequest, InternalChatResponse } from '../types/chat.js';

// ── Model metadata ──────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  owned_by: string;
  /** Credits per 1 M input tokens.  null → unmetered / unknown. */
  input_cost_per_million: number | null;
  /** Credits per 1 M output tokens. null → unmetered / unknown. */
  output_cost_per_million: number | null;
  /** ISO date string of when pricing was last verified. */
  pricingLastVerified?: string;
}

// ── Provider interface ──────────────────────────────────────────────

export interface IProvider {
  /** Stable identifier, e.g. 'openai', 'anthropic', 'copilot', 'generic' */
  readonly id: string;

  /** Human-readable display name */
  readonly name: string;

  /**
   * true  → every request costs tokens / credits (caching saves money)
   * false → usage is flat-rate or free (caching only saves latency)
   */
  readonly isMeteredPerToken: boolean;

  /** One-time setup: load keys, exchange tokens, etc. */
  initialize(): Promise<void>;

  /** Upstream URL for chat completions */
  getEndpointUrl(): string;

  /** Headers to attach to the upstream request */
  getHeaders(): Promise<Record<string, string>>;

  /** Models available from this provider */
  getModelList(): Promise<ModelInfo[]>;

  /** Re-authenticate on 401 or credential expiry */
  refreshCredentials(): Promise<void>;

  /**
   * Convert the internal canonical request into the shape the
   * provider's API expects (JSON-serialisable object).
   */
  transformRequestBody(req: InternalChatRequest): Record<string, unknown>;

  /**
   * Parse the provider's raw JSON response into our internal type.
   */
  parseResponse(raw: unknown): InternalChatResponse;

  /**
   * Assemble a full internal response from a provider's stream chunks.
   * Useful for caching a streamed response after completion.
   */
  assembleStream?(chunks: string[]): InternalChatResponse;

  /** Liveness probe */
  checkHealth(): Promise<boolean>;

  /** Tear down timers, connections, etc. */
  destroy(): void;
}

// ── Per-provider config shapes ──────────────────────────────────────

export interface OpenAIProviderConfig {
  type: 'openai';
  apiKey?: string;            // defaults to OPENAI_API_KEY env
  baseUrl?: string;           // defaults to https://api.openai.com
  organization?: string;
  models?: ModelInfo[];
}

export interface AnthropicProviderConfig {
  type: 'anthropic';
  apiKey?: string;            // defaults to ANTHROPIC_API_KEY env
  baseUrl?: string;           // defaults to https://api.anthropic.com
  anthropicVersion?: string;  // defaults to '2023-06-01'
  models?: ModelInfo[];
}

export interface CopilotProviderConfig {
  type: 'copilot';
  tokenStoragePath?: string;  // defaults to ~/.relay/tokens.json
  /** Require explicit ToS acceptance before first use */
  requireConsent?: boolean;   // defaults to true
}

export interface GenericProviderConfig {
  type: 'generic';
  baseUrl: string;            // required
  apiKey?: string;
  customHeaders?: Record<string, string>;
  models?: ModelInfo[];
  isMeteredPerToken?: boolean; // defaults to true
}

export type ProviderConfig =
  | OpenAIProviderConfig
  | AnthropicProviderConfig
  | CopilotProviderConfig
  | GenericProviderConfig;
