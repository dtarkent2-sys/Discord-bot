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
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes (single or double)
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
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
  alpacaApiKey: process.env.ALPACA_API_KEY || '',
  alpacaApiSecret: process.env.ALPACA_API_SECRET || '',
  alpacaDataUrl: process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets',
  alpacaPaper: process.env.ALPACA_PAPER || 'true', // 'true' = paper trading (default safe)
  alpacaFeed: process.env.ALPACA_FEED || 'iex',
  searxngUrl: process.env.SEARXNG_URL || '',
  botOwnerId: process.env.BOT_OWNER_ID || '',
  botPrefix: process.env.BOT_PREFIX || '!',
  port: parseInt(process.env.PORT, 10) || 3000,
  dataDir: path.join(__dirname, '..', 'data'),
  tradingChannelName: process.env.TRADING_CHANNEL || 'trading-floor',
  generalChannelName: process.env.GENERAL_CHANNEL || 'general',
  sharkAutoEnable: (process.env.SHARK_AUTO_ENABLE || '').toLowerCase() === 'true',

  // SPY 0DTE Alert Integration
  spyChannelId: process.env.SPY_CHANNEL_ID || '',
  alertOllamaModel: process.env.ALERT_OLLAMA_MODEL || 'qwen3:4b',
  alertCacheTtl: parseInt(process.env.ALERT_CACHE_TTL, 10) || 60000, // 60s default
  alertFollowUpMs: parseInt(process.env.ALERT_FOLLOWUP_MS, 10) || 5 * 60 * 1000, // 5min default
  alertMinConviction: parseInt(process.env.ALERT_MIN_CONVICTION, 10) || 4, // Only post alerts with conviction >= this (1-10, default 4 = show most signals)
  webhookSecret: process.env.WEBHOOK_SECRET || '', // Optional auth for TradingView webhook

  // Public.com API (real-time options chain + greeks)
  publicApiKey: process.env.PUBLIC_API_KEY || '',
  publicAccountId: process.env.PUBLIC_ACCOUNT_ID || '',

  // AInvest API (news, candles, fundamentals, analyst ratings, earnings)
  ainvestApiKey: process.env.AINVEST_API_KEY || '',
  ainvestBaseUrl: process.env.AINVEST_BASE_URL || 'https://openapi.ainvest.com/open',

  // Validea (guru analysis — paid subscription)
  valideaEmail: process.env.VALIDEA_EMAIL || '',
  valideaPassword: process.env.VALIDEA_PASSWORD || '',
  valideaCookie: process.env.VALIDEA_COOKIE || '', // Manual override: paste session cookie if auto-login blocked

  // GEX Engine — multi-expiry gamma exposure analysis
  gexIncludeExpiries: (process.env.GEX_INCLUDE_EXPIRIES || '0dte,weekly,monthly').split(',').map(s => s.trim()),
  gexHoldCandles: parseInt(process.env.GEX_HOLD_CANDLES, 10) || 3,
  gexCandleInterval: process.env.GEX_CANDLE_INTERVAL || '5Min',
  gexMinRegimeConfidence: parseFloat(process.env.GEX_MIN_REGIME_CONFIDENCE) || 0.4,
  gexMinAbsGex: parseFloat(process.env.GEX_MIN_ABS_GEX) || 1e6, // $1M minimum to consider dominant

  // Alpha Vantage API (market data, technicals, fundamentals, news sentiment)
  alphaApiKey: process.env.ALPHA_API_KEY || '',
};
