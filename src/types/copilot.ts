/**
 * GitHub Copilot API types for the Token Optimizer Proxy.
 * 
 * These types define the structure of requests sent to GitHub Copilot
 * and responses received from the Copilot API.
 */

/**
 * Response from the GitHub Copilot API containing code completions.
 */
export interface CopilotResponse {
  /** Array of completion suggestions from Copilot */
  completions: Completion[];
  
  /** Name/version of the Copilot model that generated the completions */
  model: string;
  
  /** Total number of tokens consumed by this response */
  tokenCount: number;
}

/**
 * A single code completion suggestion from GitHub Copilot.
 */
export interface Completion {
  /** The suggested code completion text */
  text: string;
  
  /** Confidence score for this completion (0-1, where 1 is highest confidence) */
  confidence: number;
}


