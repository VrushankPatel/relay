/**
 * Authentication types for the Relay proxy.
 * Used by AuthManager for GitHub OAuth device flow and Copilot token management.
 */

/** Status of the authentication system */
export interface AuthStatus {
  authenticated: boolean;
  expiresAt: number | null;
  degraded: boolean;
  username?: string;
  sku?: string;
}

/** GitHub device code response */
export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/** GitHub access token response */
export interface AccessTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

/** Access token polling error response */
export interface AccessTokenErrorResponse {
  error: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied';
  error_description?: string;
  interval?: number;
}

/** Copilot token exchange response */
export interface CopilotTokenResponse {
  token: string;
  expires_at: number;
  refresh_in: number;
  endpoints?: {
    api?: string;
    proxy?: string;
    telemetry?: string;
    'origin-tracker'?: string;
  };
  chat_enabled?: boolean;
  sku?: string;
  individual?: boolean;
}

/** Persisted token data (encrypted at rest) */
export interface PersistedTokenData {
  githubAccessToken: string;
  username?: string;
  createdAt: number;
}

/** Encrypted data envelope */
export interface EncryptedEnvelope {
  iv: string;      // hex-encoded IV
  tag: string;     // hex-encoded auth tag
  data: string;    // hex-encoded ciphertext
  salt: string;    // hex-encoded salt
}
