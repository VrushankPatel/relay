import fs from 'fs';
import path from 'path';
import os from 'os';

const logger = {
  info: (msg) => console.log(`\x1b[32m[INFO]\x1b[0m ${msg}`),
  warn: (msg) => console.log(`\x1b[33m[WARN]\x1b[0m ${msg}`),
  error: (msg) => console.log(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
};

async function setup() {
  logger.info('Starting Relay and OpenCode integration setup...');

  // 1. Locate OpenCode configuration file
  const homeDir = os.homedir();
  const configDir = path.join(homeDir, '.config', 'opencode');
  const possibleFiles = ['opencode.jsonc', 'opencode.json'];
  let configPath = '';

  for (const file of possibleFiles) {
    const p = path.join(configDir, file);
    if (fs.existsSync(p)) {
      configPath = p;
      break;
    }
  }

  if (!configPath) {
    // Default to opencode.jsonc if neither exists
    fs.mkdirSync(configDir, { recursive: true });
    configPath = path.join(configDir, 'opencode.jsonc');
    logger.info(`Creating new OpenCode configuration file at: ${configPath}`);
    fs.writeFileSync(configPath, '{}', 'utf-8');
  } else {
    logger.info(`Found existing OpenCode configuration at: ${configPath}`);
  }

  // 2. Read and parse OpenCode configuration
  let rawContent = '';
  try {
    rawContent = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    logger.error(`Failed to read ${configPath}: ${err.message}`);
    process.exit(1);
  }

  // Safely parse JSONC (JSON with comments) by stripping comments
  let config = {};
  try {
    const cleanJson = rawContent
      .replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1')
      .trim();
    config = cleanJson ? JSON.parse(cleanJson) : {};
  } catch (err) {
    logger.warn(`Could not parse JSONC configuration automatically: ${err.message}`);
    logger.warn('We will back up your config and initialize a clean one.');
    fs.writeFileSync(`${configPath}.bak`, rawContent, 'utf-8');
    config = {};
  }

  // 3. Inject/Update Ollama provider routing
  if (!config.provider) {
    config.provider = {};
  }
  if (!config.provider.ollama) {
    config.provider.ollama = {};
  }
  
  // Set OpenAI-compatible provider defaults to route through Relay
  config.provider.ollama.npm = '@ai-sdk/openai-compatible';
  config.provider.ollama.name = 'Ollama (via Relay Proxy)';
  
  if (!config.provider.ollama.options) {
    config.provider.ollama.options = {};
  }
  config.provider.ollama.options.baseURL = 'http://localhost:9879/v1';

  // Ensure glm-4.7:cloud model is whitelisted under the provider
  if (!config.provider.ollama.models) {
    config.provider.ollama.models = {};
  }
  if (!config.provider.ollama.models['glm-4.7:cloud']) {
    config.provider.ollama.models['glm-4.7:cloud'] = {
      name: 'glm-4.7:cloud'
    };
  }

  // Write updated OpenCode config back to disk
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    logger.info(`Successfully updated OpenCode configuration at: ${configPath}`);
  } catch (err) {
    logger.error(`Failed to write OpenCode configuration: ${err.message}`);
    process.exit(1);
  }

  // 4. Update local Relay .env file
  const envPath = path.resolve('.env');
  logger.info(`Updating local Relay environment configuration in: ${envPath}`);

  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf-8');
  }

  // Helper to set/replace env vars
  const setEnvVar = (content, key, val) => {
    const regex = new RegExp(`^#?\\s*${key}\\s*=.*$`, 'm');
    if (regex.test(content)) {
      return content.replace(regex, `${key}=${val}`);
    }
    return content + (content.endsWith('\n') ? '' : '\n') + `${key}=${val}\n`;
  };

  envContent = setEnvVar(envContent, 'RELAY_PROVIDER', 'generic');
  envContent = setEnvVar(envContent, 'GENERIC_BASE_URL', 'http://host.docker.internal:11434');
  envContent = setEnvVar(envContent, 'GENERIC_API_KEY', 'ollama');
  envContent = setEnvVar(envContent, 'RELAY_PORT', '9879');

  try {
    fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf-8');
    logger.info('Successfully updated local .env file.');
  } catch (err) {
    logger.error(`Failed to write .env file: ${err.message}`);
    process.exit(1);
  }

  console.log('\n\x1b[36m==================================================\x1b[0m');
  console.log('\x1b[1;32m🎉 Setup completed successfully!\x1b[0m');
  console.log('\x1b[36m==================================================\x1b[0m');
  console.log('To start using Relay proxy cache with OpenCode & Ollama:');
  console.log('  1. Rebuild and launch the Relay proxy:');
  console.log('     \x1b[33mdocker compose up -d --build\x1b[0m');
  console.log('  2. Run OpenCode with your Ollama model directly:');
  console.log('     \x1b[33mollama launch opencode --model glm-4.7:cloud\x1b[0m');
  console.log('  3. Open your browser and monitor real-time traffic:');
  console.log('     \x1b[33mhttp://localhost:9879/dashboard\x1b[0m');
  console.log('\x1b[36m==================================================\x1b[0m\n');
}

setup();
