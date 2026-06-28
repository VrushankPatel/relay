import http from 'http';
import { parseArgs } from 'util';
import { OpenAIProvider } from '../src/providers/OpenAIProvider.js';

const args = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '3000' },
    model: { type: 'string', default: 'gpt-4o' },
    auth: { type: 'string', default: process.env.RELAY_API_KEY || 'test-key' }
  }
});

const PROXY_HOST = args.values.host;
const PROXY_PORT = parseInt(args.values.port as string);
const MODEL = args.values.model;
const AUTH = args.values.auth;

const PROMPT = `Write a comprehensive, production-ready implementation of a concurrent unbounded queue in Python using asyncio, including comprehensive docstrings and unit tests with pytest.`;

import { loadPricing, PricingMap } from '../src/utils/pricing.js';

let PRICING: PricingMap = {};

async function initializePricing() {
  const provider = new OpenAIProvider({ type: 'openai', apiKey: process.env.OPENAI_API_KEY || 'dummy' });
  PRICING = await loadPricing([provider]);
}

async function sendRequest(isWarm: boolean): Promise<{ latency: number, promptTokens: number, completionTokens: number, cacheHit: boolean }> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const req = http.request({
      hostname: PROXY_HOST,
      port: PROXY_PORT,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AUTH}`
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk.toString());
      res.on('end', () => {
        const latency = Date.now() - startTime;
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          return;
        }
        
        try {
          const parsed = JSON.parse(body);
          const cacheHit = res.headers['x-cache'] === 'HIT';
          resolve({
            latency,
            promptTokens: parsed.usage?.prompt_tokens || 0,
            completionTokens: parsed.usage?.completion_tokens || 0,
            cacheHit
          });
        } catch (e) {
          reject(new Error(`Failed to parse response: ${body.substring(0, 100)}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: PROMPT + (isWarm ? '' : ' ') }] // Tiny diff to avoid dedup if we wanted to bypass, but we WANT exact cache hit
    }));
    req.end();
  });
}

function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const rates = PRICING[model];
  if (!rates) return 0;
  return ((inputTokens / 1_000_000) * rates.input) + ((outputTokens / 1_000_000) * rates.output);
}

async function main() {
  console.log(`🚀 Relay Benchmark Script`);
  await initializePricing();
  console.log(`Target: http://${PROXY_HOST}:${PROXY_PORT} | Model: ${MODEL}`);
  console.log(`Pricing known: ${!!PRICING[MODEL as string]}`);
  console.log(`-----------------------------------------------------`);
  
  try {
    console.log(`[1] Sending COLD request...`);
    const cold = await sendRequest(false);
    console.log(`    ↳ Latency: ${cold.latency}ms`);
    console.log(`    ↳ Tokens: ${cold.promptTokens} input, ${cold.completionTokens} output`);
    console.log(`    ↳ Cache: ${cold.cacheHit ? 'HIT (Wait, this was supposed to be cold!)' : 'MISS'}`);
    
    console.log(`\n[2] Sending WARM request (exact match)...`);
    const warm = await sendRequest(true);
    console.log(`    ↳ Latency: ${warm.latency}ms`);
    console.log(`    ↳ Tokens: ${warm.promptTokens} input, ${warm.completionTokens} output`);
    console.log(`    ↳ Cache: ${warm.cacheHit ? 'HIT' : 'MISS'}`);
    
    console.log(`\n📊 SUMMARY`);
    console.log(`-----------------------------------------------------`);
    
    if (cold.cacheHit === false && warm.cacheHit === true) {
      const latencySaved = cold.latency - warm.latency;
      const costSaved = calculateCost(MODEL as string, cold.promptTokens, cold.completionTokens);
      
      console.log(`✅ Cache successfully served identical request.`);
      console.log(`⏱️  Latency Saved: ${latencySaved}ms (${Math.round((latencySaved / cold.latency) * 100)}% faster)`);
      if (PRICING[MODEL as string]) {
        console.log(`💰 Cost Saved: $${costSaved.toFixed(6)}`);
      } else {
        console.log(`💰 Cost Saved: (Model pricing unknown for ${MODEL})`);
      }
    } else {
      console.log(`❌ Benchmark failed to produce expected cache behavior.`);
      console.log(`Cold cache hit: ${cold.cacheHit}, Warm cache hit: ${warm.cacheHit}`);
    }
  } catch (error) {
    console.error(`\n❌ Error during benchmark:`, error);
  }
}

main();
