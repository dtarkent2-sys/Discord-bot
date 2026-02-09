const path = require('path');
const fs = require('fs');

// Load .env file manually (no dotenv dependency)
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  ollamaHost: process.env.OLLAMA_HOST || process.env.OLLAMA_URL || 'https://ollama.com',
  ollamaModel: process.env.OLLAMA_MODEL || 'gemma4b',
  ollamaApiKey: process.env.OLLAMA_API_KEY || '',
  githubToken: process.env.GITHUB_TOKEN || '',
  githubOwner: process.env.GITHUB_OWNER || 'dtarkent2-sys',
  githubRepo: process.env.GITHUB_REPO || 'Discord-bot',
  githubBranch: process.env.GITHUB_BRANCH || 'main',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  kimiApiKey: process.env.KIMI_API_KEY || '',
  kimiBaseUrl: process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1',
  kimiModel: process.env.KIMI_MODEL || 'kimi-k2.5-preview',
  fmpApiKey: process.env.FMP_API_KEY || '',
  searxngUrl: process.env.SEARXNG_URL || '',
  botOwnerId: process.env.BOT_OWNER_ID || '',
  botPrefix: process.env.BOT_PREFIX || '!',
  port: parseInt(process.env.PORT, 10) || 3000,
  dataDir: path.join(__dirname, '..', 'data'),
  tradingChannelName: process.env.TRADING_CHANNEL || 'trading-floor',
  generalChannelName: process.env.GENERAL_CHANNEL || 'general',
};
