import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { APIGatewayImpl } from '../../src/components/APIGateway.js';
import http from 'http';

describe('APIGateway', () => {
  let gateway: APIGatewayImpl;
  const PORT = 39880;

  beforeEach(() => {
    gateway = new APIGatewayImpl(100, 5000);
  });

  afterEach(async () => {
    await gateway.stop();
  });

  it('rejects invalid JSON gracefully', async () => {
    await gateway.start('127.0.0.1', PORT);
    
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    req.write('invalid json');
    req.end();

    const res = await new Promise<http.IncomingMessage>((resolve) => {
      req.on('response', resolve);
    });

    expect(res.statusCode).toBe(400);
  });
});
