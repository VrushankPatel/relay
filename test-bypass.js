const { CacheManager } = require('./dist/components/CacheManager.js');
const { RequestProcessor } = require('./dist/components/RequestProcessor.js');

const req = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'bypass cache test' }],
  temperature: 0.9,
};

const rp = new RequestProcessor();
const normalized = rp.normalizeRequest(req);
const cm = new CacheManager();
console.log('shouldBypassCache:', cm.shouldBypassCache(normalized));
