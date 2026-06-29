import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'child_process';
import http from 'http';
import path from 'path';
import fs from 'fs';

describe('Relay CLI Startup Integration', () => {
  let childProcess: any;

  beforeAll(async () => {
    // Ensure we have a built version of the code
    const buildPath = path.resolve('dist/index.js');
    if (!fs.existsSync(buildPath)) {
      execSync('npm run build');
    }
  });

  afterAll(() => {
    if (childProcess) {
      try {
        childProcess.kill('SIGKILL');
      } catch (e) {}
    }
  });

  it('starts the relay proxy server in foreground when no subcommand is specified', async () => {
    const buildPath = path.resolve('dist/index.js');
    
    // Start the process with no arguments to verify default foreground start behavior
    childProcess = spawn(process.execPath, [buildPath], {
      env: {
        ...process.env,
        RELAY_PORT: '39882',
        RELAY_PROVIDER: 'generic',
        GENERIC_BASE_URL: 'https://api.openai.com', // dummy url
        RELAY_CACHE_SECRET: 'dummysecretkey123456789012345678',
        SECURITY_API_KEY: 'test-admin-key'
      }
    });

    // Wait for the server to spin up
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Send a GET request to /health to verify it started and serves requests
    const health = await new Promise<any>((resolve, reject) => {
      const req = http.get('http://127.0.0.1:39882/health', { timeout: 2000 }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error('Invalid JSON'));
          }
        });
      });
      req.on('error', (err) => reject(err));
      req.end();
    });

    expect(health).toBeDefined();
    expect(health.status).toBe('healthy');
    expect(health.relay).toBeDefined();
    expect(health.relay.provider).toBe('generic');
  });
});
