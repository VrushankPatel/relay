/**
 * AuthManager — GitHub OAuth Device Flow, Copilot token exchange,
 * automatic refresh, and encrypted persistence.
 *
 * Replaces the old AuthenticationManager (simple API key validation)
 * with full GitHub Copilot credential management.
 *
 * Flow:
 * 1. `relay login` → device code → user authorises in browser → access token
 * 2. Access token → Copilot session token via internal API
 * 3. Session token refreshed on a timer (refresh_in − 60s margin)
 * 4. Access token persisted encrypted at rest for restarts
 *
 * Confirmed endpoint values (2026-06-27):
 * - Device code:       POST https://github.com/login/device/code
 * - Access token poll:  POST https://github.com/login/oauth/access_token
 * - Token exchange:     GET  https://api.github.com/copilot_internal/v2/token
 * - Client ID:          Iv1.b507a08c87ecfe98
 * - OAuth scope:        copilot
 *
 * See design.md § Upstream Endpoint Details for full confirmation.
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { createChildLogger } from '../utils/logger.js';

// ── Constants (CONFIRMED 2026-06-27 against ericc-ch/copilot-api and others) ──

const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const GITHUB_OAUTH_SCOPE = 'copilot';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';

// Headers required by the Copilot API (confirmed 2026-06-27)
const EDITOR_VERSION = 'vscode/1.96.0';
const EDITOR_PLUGIN_VERSION = 'copilot-chat/0.26.0';

const DEFAULT_TOKEN_STORAGE_PATH = '~/.relay/tokens.json';
const DEFAULT_POLL_INTERVAL_S = 5;
const DEFAULT_REFRESH_MARGIN_S = 60;
const MAX_REFRESH_FAILURES = 3;

// ── Encryption (AES-256-GCM) ──

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_ITERATIONS = 100000;
const KEY_LENGTH = 32;

interface EncryptedEnvelope {
  iv: string;
  tag: string;
  data: string;
  salt: string;
}

interface PersistedTokenData {
  githubAccessToken: string;
  username?: string;
  createdAt: number;
}

// ── Auth Status ──

export interface AuthStatus {
  authenticated: boolean;
  expiresAt: number | null;
  degraded: boolean;
  username?: string;
  sku?: string;
}

// ── Copilot Token Response ──

interface CopilotTokenResponse {
  token: string;
  expires_at: number;
  refresh_in: number;
  endpoints?: {
    api?: string;
    proxy?: string;
  };
  chat_enabled?: boolean;
  sku?: string;
}

// ── Device Code Response ──

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

// ── Auth Config ──

export interface AuthManagerConfig {
  tokenStoragePath?: string;
  deviceFlowPollInterval?: number;
  refreshMargin?: number;
  encryptionSecret?: string;
}

// ── AuthManager Interface ──

export interface IAuthManager {
  login(): Promise<void>;
  logout(): Promise<void>;
  whoami(): Promise<AuthStatus>;
  getCopilotToken(): Promise<string>;
  getApiEndpoint(): string;
  getStatus(): AuthStatus;
  refresh(): Promise<void>;
  onTokenExpired(callback: () => void): void;
  onTokenRefreshed(callback: (token: string) => void): void;
  initialize(): Promise<void>;
  destroy(): void;
}

// ── AuthManager Implementation ──

export class AuthManager implements IAuthManager {
  private logger = createChildLogger('AuthManager');
  private config: Required<AuthManagerConfig>;

  // Current token state
  private copilotToken: string | null = null;
  private copilotTokenExpiresAt: number | null = null;
  private apiEndpoint: string = 'https://api.githubcopilot.com';
  private githubAccessToken: string | null = null;
  private username: string | null = null;
  private sku: string | null = null;

  // State flags
  private degraded = false;
  private consecutiveRefreshFailures = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  // Callbacks
  private onExpiredCallbacks: Array<() => void> = [];
  private onRefreshedCallbacks: Array<(token: string) => void> = [];

  constructor(config: AuthManagerConfig = {}) {
    this.config = {
      tokenStoragePath: config.tokenStoragePath || DEFAULT_TOKEN_STORAGE_PATH,
      deviceFlowPollInterval: config.deviceFlowPollInterval || DEFAULT_POLL_INTERVAL_S,
      refreshMargin: config.refreshMargin || DEFAULT_REFRESH_MARGIN_S,
      encryptionSecret: config.encryptionSecret || process.env.ENCRYPTION_SECRET || 'relay-default-secret',
    };
  }

  // ── Public API ──

  /**
   * Initialize: read persisted token, exchange for Copilot token, start refresh timer.
   */
  async initialize(): Promise<void> {
    this.logger.info('Initializing AuthManager');
    try {
      const persisted = await this.readPersistedToken();
      if (persisted) {
        this.githubAccessToken = persisted.githubAccessToken;
        this.username = persisted.username || null;
        this.logger.info({ username: this.username }, 'Loaded persisted GitHub token');
        await this.exchangeForCopilotToken();
        this.scheduleRefresh();
        this.logger.info('AuthManager initialized successfully with persisted token');
      } else {
        this.logger.info('No persisted token found. Run "relay login" to authenticate.');
      }
    } catch (error) {
      this.logger.warn({ error }, 'Failed to initialize from persisted token');
    }
  }

  /**
   * GitHub OAuth Device Flow login.
   */
  async login(): Promise<void> {
    this.logger.info('Starting GitHub OAuth device flow login');

    // Step 1: Request device code
    const deviceCode = await this.requestDeviceCode();

    // Step 2: Display to user
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  🔑 GitHub Copilot Authentication');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`\n  1. Open: ${deviceCode.verification_uri}`);
    console.log(`  2. Enter code: ${deviceCode.user_code}\n`);
    console.log('  Waiting for authorization...\n');

    // Try to open browser automatically (best-effort)
    this.tryOpenBrowser(deviceCode.verification_uri);

    // Step 3: Poll for access token
    const accessToken = await this.pollForAccessToken(
      deviceCode.device_code,
      deviceCode.interval,
      deviceCode.expires_in,
    );

    this.githubAccessToken = accessToken;
    this.logger.info('GitHub OAuth access token obtained');

    // Fetch username
    try {
      this.username = await this.fetchUsername(accessToken);
    } catch {
      this.username = null;
    }

    // Step 4: Exchange for Copilot token
    await this.exchangeForCopilotToken();

    // Step 5: Persist encrypted
    await this.persistToken();

    // Step 6: Start refresh timer
    this.scheduleRefresh();

    // Exit degraded mode if we were in it
    if (this.degraded) {
      this.degraded = false;
      this.consecutiveRefreshFailures = 0;
      this.logger.info('Exited degraded mode after successful login');
    }

    console.log(`\n  ✅ Login successful!${this.username ? ` Logged in as ${this.username}` : ''}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  }

  /**
   * Logout: clear tokens, remove persisted file.
   */
  async logout(): Promise<void> {
    this.copilotToken = null;
    this.copilotTokenExpiresAt = null;
    this.githubAccessToken = null;
    this.username = null;
    this.sku = null;
    this.degraded = false;
    this.consecutiveRefreshFailures = 0;

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    // Remove persisted token file
    const tokenPath = this.resolveTokenPath();
    try {
      if (fs.existsSync(tokenPath)) {
        fs.unlinkSync(tokenPath);
        this.logger.info({ path: tokenPath }, 'Removed persisted token file');
      }
    } catch (error) {
      this.logger.warn({ error, path: tokenPath }, 'Failed to remove persisted token file');
    }

    console.log('  ✅ Logged out. Token cleared.');
  }

  /**
   * Show current auth status.
   */
  async whoami(): Promise<AuthStatus> {
    const status = this.getStatus();

    if (!status.authenticated) {
      console.log('\n  ❌ Not authenticated. Run "relay login" to sign in.\n');
    } else {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('  🔑 Authentication Status');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      if (status.username) {
        console.log(`  User:     ${status.username}`);
      }
      if (status.sku) {
        console.log(`  Plan:     ${status.sku}`);
      }
      if (status.expiresAt) {
        const expiresIn = Math.max(0, Math.round((status.expiresAt - Date.now()) / 1000));
        console.log(`  Expires:  ${expiresIn}s`);
      }
      console.log(`  Status:   ${status.degraded ? '⚠️  DEGRADED' : '✅ Active'}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    }

    return status;
  }

  /**
   * Get a valid Copilot token. Refreshes if close to expiry.
   * Throws if no token is available.
   */
  async getCopilotToken(): Promise<string> {
    if (this.degraded) {
      throw new Error('AuthManager is in degraded mode. Run "relay login" to re-authenticate.');
    }

    if (!this.copilotToken) {
      throw new Error('Not authenticated. Run "relay login" first.');
    }

    // Proactive refresh if close to expiry
    if (this.copilotTokenExpiresAt) {
      const remainingMs = this.copilotTokenExpiresAt - Date.now();
      if (remainingMs < this.config.refreshMargin * 1000) {
        this.logger.debug('Token close to expiry, refreshing proactively');
        try {
          await this.refresh();
        } catch (error) {
          this.logger.warn({ error }, 'Proactive refresh failed, using existing token');
        }
      }
    }

    return this.copilotToken;
  }

  /**
   * Get the Copilot API base endpoint (dynamically obtained from token exchange).
   */
  getApiEndpoint(): string {
    return this.apiEndpoint;
  }

  /**
   * Get current auth status.
   */
  getStatus(): AuthStatus {
    return {
      authenticated: this.copilotToken !== null && !this.degraded,
      expiresAt: this.copilotTokenExpiresAt,
      degraded: this.degraded,
      username: this.username || undefined,
      sku: this.sku || undefined,
    };
  }

  /**
   * Force-refresh the Copilot token.
   */
  async refresh(): Promise<void> {
    if (!this.githubAccessToken) {
      throw new Error('No GitHub access token available. Run "relay login" first.');
    }
    await this.exchangeForCopilotToken();
    this.consecutiveRefreshFailures = 0;
    this.logger.info('Copilot token refreshed successfully');
  }

  onTokenExpired(callback: () => void): void {
    this.onExpiredCallbacks.push(callback);
  }

  onTokenRefreshed(callback: (token: string) => void): void {
    this.onRefreshedCallbacks.push(callback);
  }

  destroy(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // ── Required headers for Copilot API requests ──

  /**
   * Get the headers required for Copilot API requests.
   * These are confirmed against multiple reference implementations (2026-06-27).
   */
  getCopilotHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.copilotToken}`,
      'Content-Type': 'application/json',
      'Editor-Version': EDITOR_VERSION,
      'Editor-Plugin-Version': EDITOR_PLUGIN_VERSION,
      'Copilot-Integration-Id': 'vscode-chat',
      'OpenAI-Organization': 'github-copilot',
      'OpenAI-Intent': 'conversation-panel',
      'X-Request-Id': crypto.randomUUID(),
    };
  }

  // ── Device Flow Implementation ──

  private async requestDeviceCode(): Promise<DeviceCodeResponse> {
    const body = JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: GITHUB_OAUTH_SCOPE,
    });

    const response = await this.httpRequest('POST', DEVICE_CODE_URL, {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    }, body);

    const parsed = JSON.parse(response);

    if (parsed.error) {
      throw new Error(`Device code request failed: ${parsed.error_description || parsed.error}`);
    }

    return parsed as DeviceCodeResponse;
  }

  private async pollForAccessToken(
    deviceCode: string,
    interval: number,
    expiresIn: number,
  ): Promise<string> {
    const body = JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });

    const deadline = Date.now() + expiresIn * 1000;
    let currentInterval = interval;

    while (Date.now() < deadline) {
      await this.sleep(currentInterval * 1000);

      const response = await this.httpRequest('POST', ACCESS_TOKEN_URL, {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      }, body);

      const parsed = JSON.parse(response);

      if (parsed.access_token) {
        return parsed.access_token;
      }

      if (parsed.error === 'authorization_pending') {
        // Keep polling
        continue;
      }

      if (parsed.error === 'slow_down') {
        // Increase interval by 5 seconds as per spec
        currentInterval += 5;
        this.logger.debug({ newInterval: currentInterval }, 'Slowing down polling');
        continue;
      }

      if (parsed.error === 'expired_token') {
        throw new Error('Device code expired. Please run "relay login" again.');
      }

      if (parsed.error === 'access_denied') {
        throw new Error('Authorization denied by user.');
      }

      throw new Error(`Unexpected polling error: ${parsed.error_description || parsed.error}`);
    }

    throw new Error('Device code expired before authorization was completed.');
  }

  // ── Token Exchange ──

  private async exchangeForCopilotToken(): Promise<void> {
    if (!this.githubAccessToken) {
      throw new Error('No GitHub access token available');
    }

    const response = await this.httpRequest('GET', COPILOT_TOKEN_URL, {
      'Authorization': `token ${this.githubAccessToken}`,
      'Accept': 'application/json',
      'Editor-Version': EDITOR_VERSION,
      'Editor-Plugin-Version': EDITOR_PLUGIN_VERSION,
    });

    const parsed = JSON.parse(response) as CopilotTokenResponse;

    if (!parsed.token) {
      throw new Error('Token exchange failed: no token in response');
    }

    this.copilotToken = parsed.token;
    this.copilotTokenExpiresAt = parsed.expires_at * 1000; // Convert to ms
    this.sku = parsed.sku || null;

    // Use the dynamically returned API endpoint
    if (parsed.endpoints?.api) {
      this.apiEndpoint = parsed.endpoints.api;
    }

    this.logger.info(
      {
        expiresAt: new Date(this.copilotTokenExpiresAt).toISOString(),
        refreshIn: parsed.refresh_in,
        apiEndpoint: this.apiEndpoint,
        chatEnabled: parsed.chat_enabled,
        sku: parsed.sku,
      },
      'Copilot token exchanged successfully',
    );

    // Notify callbacks
    for (const cb of this.onRefreshedCallbacks) {
      try {
        cb(this.copilotToken);
      } catch (e) {
        this.logger.warn({ error: e }, 'Token refresh callback failed');
      }
    }
  }

  // ── Refresh Timer ──

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (!this.copilotTokenExpiresAt) return;

    const now = Date.now();
    const expiresInMs = this.copilotTokenExpiresAt - now;
    const refreshInMs = Math.max(
      10_000, // At least 10s
      expiresInMs - this.config.refreshMargin * 1000,
    );

    this.logger.debug(
      { refreshInS: Math.round(refreshInMs / 1000) },
      'Scheduling token refresh',
    );

    this.refreshTimer = setTimeout(async () => {
      await this.performScheduledRefresh();
    }, refreshInMs);

    // Don't keep the process alive just for the timer
    if (this.refreshTimer.unref) {
      this.refreshTimer.unref();
    }
  }

  private async performScheduledRefresh(): Promise<void> {
    try {
      await this.exchangeForCopilotToken();
      this.consecutiveRefreshFailures = 0;
      this.scheduleRefresh();
      this.logger.info('Scheduled token refresh succeeded');
    } catch (error) {
      this.consecutiveRefreshFailures++;
      this.logger.error(
        { error, failures: this.consecutiveRefreshFailures },
        'Scheduled token refresh failed',
      );

      if (this.consecutiveRefreshFailures >= MAX_REFRESH_FAILURES) {
        this.degraded = true;
        this.logger.error(
          { failures: this.consecutiveRefreshFailures },
          'Entered degraded mode after consecutive refresh failures. Run "relay login" to re-authenticate.',
        );

        for (const cb of this.onExpiredCallbacks) {
          try { cb(); } catch (e) {
            this.logger.warn({ error: e }, 'Token expired callback failed');
          }
        }
      } else {
        // Retry in 30 seconds
        this.refreshTimer = setTimeout(async () => {
          await this.performScheduledRefresh();
        }, 30_000);
        if (this.refreshTimer.unref) this.refreshTimer.unref();
      }
    }
  }

  // ── Token Persistence ──

  private resolveTokenPath(): string {
    let tokenPath = this.config.tokenStoragePath;
    if (tokenPath.startsWith('~')) {
      tokenPath = path.join(os.homedir(), tokenPath.slice(1));
    }
    return tokenPath;
  }

  private async persistToken(): Promise<void> {
    if (!this.githubAccessToken) return;

    const tokenPath = this.resolveTokenPath();
    const dir = path.dirname(tokenPath);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const data: PersistedTokenData = {
      githubAccessToken: this.githubAccessToken,
      username: this.username || undefined,
      createdAt: Date.now(),
    };

    const plaintext = JSON.stringify(data);
    const envelope = this.encryptString(plaintext, this.config.encryptionSecret);

    fs.writeFileSync(tokenPath, JSON.stringify(envelope, null, 2), {
      mode: 0o600,
    });

    this.logger.info({ path: tokenPath }, 'Token persisted (encrypted)');
  }

  private async readPersistedToken(): Promise<PersistedTokenData | null> {
    const tokenPath = this.resolveTokenPath();

    if (!fs.existsSync(tokenPath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(tokenPath, 'utf-8');
      const envelope = JSON.parse(content) as EncryptedEnvelope;
      const plaintext = this.decryptString(envelope, this.config.encryptionSecret);
      return JSON.parse(plaintext) as PersistedTokenData;
    } catch (error) {
      this.logger.warn({ error, path: tokenPath }, 'Failed to read persisted token (wrong secret or corrupted)');
      return null;
    }
  }

  // ── Encryption Helpers ──

  private encryptString(plaintext: string, secret: string): EncryptedEnvelope {
    const salt = crypto.randomBytes(16).toString('hex');
    const key = crypto.pbkdf2Sync(secret, salt, KEY_ITERATIONS, KEY_LENGTH, 'sha256');
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(plaintext, 'utf-8')),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return {
      iv: iv.toString('hex'),
      tag: authTag.toString('hex'),
      data: encrypted.toString('hex'),
      salt,
    };
  }

  private decryptString(envelope: EncryptedEnvelope, secret: string): string {
    const key = crypto.pbkdf2Sync(secret, envelope.salt, KEY_ITERATIONS, KEY_LENGTH, 'sha256');
    const iv = Buffer.from(envelope.iv, 'hex');
    const authTag = Buffer.from(envelope.tag, 'hex');
    const ciphertext = Buffer.from(envelope.data, 'hex');
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString('utf-8');
  }

  // ── GitHub User Info ──

  private async fetchUsername(accessToken: string): Promise<string> {
    const response = await this.httpRequest('GET', 'https://api.github.com/user', {
      'Authorization': `token ${accessToken}`,
      'Accept': 'application/json',
      'User-Agent': 'Relay-Proxy',
    });
    const parsed = JSON.parse(response);
    return parsed.login;
  }

  // ── HTTP Utility ──

  private httpRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const transport = parsed.protocol === 'https:' ? https : http;

      const options: https.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          ...headers,
          'User-Agent': 'Relay-Proxy/1.0',
        },
      };

      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 500)}`));
          } else {
            resolve(data);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(30000, () => {
        req.destroy(new Error('Request timeout'));
      });

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  // ── Browser Opener (best-effort) ──

  private tryOpenBrowser(url: string): void {
    try {
      const { exec } = require('child_process');
      const cmd = process.platform === 'darwin'
        ? `open "${url}"`
        : process.platform === 'win32'
        ? `start "${url}"`
        : `xdg-open "${url}"`;
      exec(cmd, (error: Error | null) => {
        if (error) {
          this.logger.debug({ error }, 'Could not open browser automatically');
        }
      });
    } catch {
      // Silently fail — user has the URL in the terminal
    }
  }

  // ── Utility ──

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
