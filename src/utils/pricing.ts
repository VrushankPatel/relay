import { IProvider } from '../providers/types.js';

export interface ModelPricing {
  input: number;
  output: number;
}

export type PricingMap = Record<string, ModelPricing>;

/**
 * Loads pricing metadata from one or more providers.
 * Returns a map of model id to { input, output } costs per million tokens.
 */
export async function loadPricing(providers: IProvider[]): Promise<PricingMap> {
  const pricing: PricingMap = {};

  for (const provider of providers) {
    if (!provider.isMeteredPerToken) {
      continue; // Skip free/unmetered providers
    }

    try {
      const models = await provider.getModelList();
      for (const model of models) {
        if (model.input_cost_per_million !== null && model.output_cost_per_million !== null) {
          pricing[model.id] = {
            input: model.input_cost_per_million,
            output: model.output_cost_per_million
          };
        }
      }
    } catch (e) {
      console.warn(`Could not load pricing from provider ${provider.id}`, e);
    }
  }

  return pricing;
}

/**
 * Calculates the estimated cost of a request in dollars.
 */
export function calculateCost(modelId: string, inputTokens: number, outputTokens: number, pricing: PricingMap): number {
  const modelPricing = pricing[modelId];
  if (!modelPricing) {
    return 0; // Unknown or unmetered
  }

  const inputCost = (inputTokens / 1_000_000) * modelPricing.input;
  const outputCost = (outputTokens / 1_000_000) * modelPricing.output;
  
  return inputCost + outputCost;
}
