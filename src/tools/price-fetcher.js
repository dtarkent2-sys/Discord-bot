import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

let yahooFinance;
let yahooFinanceLoaded = false;
async function loadYahooFinance() {
  if (yahooFinanceLoaded) return yahooFinance;
  yahooFinanceLoaded = true;
  try {
    const mod = await import('yahoo-finance2');
    const candidate = mod.default || mod;
    yahooFinance = (typeof candidate.quote === 'function') ? candidate
                 : (candidate.default && typeof candidate.default.quote === 'function') ? candidate.default
                 : candidate;
    console.log('[PriceFetcher] yahoo-finance2 loaded OK');
  } catch (err) {
    yahooFinance = null;
    console.warn(`[PriceFetcher] yahoo-finance2 failed to load: ${err.message}`);
  }
  return yahooFinance;
}

// FMP client (uses FMP_API_KEY)
let fmpClient;
try {
  fmpClient = require('../services/yahoo');
  console.log(`[PriceFetcher] FMP client loaded OK (enabled=${fmpClient.enabled})`);
} catch (err) {
  fmpClient = null;
  console.warn(`[PriceFetcher] FMP client failed to load: ${err.message}`);
}

// Alpaca client (uses ALPACA_API_KEY + ALPACA_API_SECRET, stocks only)
let alpacaClient;
try {
  alpacaClient = require('../services/alpaca');
  console.log(`[PriceFetcher] Alpaca client loaded OK (enabled=${alpacaClient.enabled})`);
} catch (err) {
  alpacaClient = null;
  console.warn(`[PriceFetcher] Alpaca client failed to load: ${err.message}`);
}

// AInvest client (uses AINVEST_API_KEY, candles-based quotes)
let ainvestClient;
try {
  ainvestClient = require('../services/ainvest');
  console.log(`[PriceFetcher] AInvest client loaded OK (enabled=${ainvestClient.enabled})`);
} catch (err) {
  ainvestClient = null;
  console.warn(`[PriceFetcher] AInvest client failed to load: ${err.message}`);
}

// ── Cache: ticker → { data, fetchedAt } ────────────────────────────────
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

// ── Rate limiter: sliding window of timestamps ─────────────────────────
let callTimestamps = [];
const MAX_CALLS_PER_MINUTE = 10;

function isRateLimited() {
  const now = Date.now();
  while (callTimestamps.length > 0 && callTimestamps[0] < now - 60000) {
    callTimestamps.shift();
  }
  return callTimestamps.length >= MAX_CALLS_PER_MINUTE;
}

function recordCall() {
  const now = Date.now();
  callTimestamps.push(now);
  // Remove timestamps older than 60 seconds
  callTimestamps.filter(t => t > now - 60000);
}

async function getCurrentPrice(ticker) {
  const upper = ticker.toUpperCase().trim();

  // Check cache first
  const cached = cache.get(upper);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return { ...cached.data, cached: true };
  }

  // Rate limit check
  if (isRateLimited()) {
    if (cached) return { ...cached.data, cached: true, stale: true };
    return { ticker: upper, error: true, message: 'Rate limited — too many requests' };
  }

  recordCall();

  // PRIORITY: AInvest (paid API, most reliable, best data)
  let data = await _tryAInvest(upper);

  // Fallback to FMP (API key, reliable from servers)
  if (!data) {
    data = await _tryFMP(upper);
  }

  // Fallback to Alpaca (API key, stocks only, proven from Railway)
  if (!data) {
    data = await _tryAlpaca(upper);
  }

  // Fallback to yahoo-finance2 (free, no key, unreliable from datacenter)
  if (!data) {
    data = await _tryYahoo(upper);
  }

  if (data) {
    cache.set(upper, { data, fetchedAt: Date.now() });
    console.log(`[PriceFetcher] ${upper}: $${data.price} via ${data.source}`);
    return data;
  }

  // All sources failed — return stale cache if available
  if (cached) {
    console.warn(`[PriceFetcher] All sources failed for ${upper}, returning stale cache`);
    return { ...cached.data, cached: true, stale: true };
  }

  console.error(`[PriceFetcher] All sources failed for ${upper}, no cache available`);
  return { ticker: upper, error: true, message: `No price data for ${upper} (all sources failed)` };
}

async function getMultiplePrices(tickers) {
  return Promise.all(tickers.map(t => getCurrentPrice(t)));
}

function formatForPrompt(prices) {
  if (!prices || prices.length === 0) return '';

  let hasStale = false;
  const lines = prices
    .filter(p => !p.error && p.price != null)
    .map(p => {
      const dir = (p.changePercent ?? 0) >= 0 ? '+' : '';
      const pct = p.changePercent != null ? `${dir}${p.changePercent.toFixed(2)}%` : 'N/A';
      const vol = p.volume ? `Vol: ${(p.volume / 1e6).toFixed(1)}M` : '';
      let ageLabel = '';
      if (p.lastUpdated) {
        const ageMs = Date.now() - new Date(p.lastUpdated).getTime();
        const ageSec = Math.floor(ageMs / 1000);
        if (ageSec > 300) {
          ageLabel = ` [STALE: ${Math.floor(ageSec / 60)}m old]`;
          hasStale = true;
        } else if (ageSec > 60) {
          ageLabel = ` [${Math.floor(ageSec / 60)}m ago]`;
        }
      }
      if (p.stale) {
        ageLabel = ageLabel || ' [STALE: cached fallback]';
        hasStale = true;
      }
      const src = p.source ? ` via ${p.source}` : '';
      return `${p.ticker}: $${p.price.toFixed(2)} (${pct}) ${vol}${src}${ageLabel}`.trim();
    });

  if (lines.length === 0) return 'Price data unavailable — proceeding with caution.';

  const header = hasStale
    ? 'Market data (WARNING: some prices are stale/cached — do NOT treat as real-time):'
    : `Current market data (fetched ${new Date().toISOString()}):`;
  return `${header}\n${lines.join('\n')}`;
}

function isAvailable() {
  return !!yahooFinance || !!(fmpClient && fmpClient.enabled) || !!(alpacaClient && alpacaClient.enabled) || !!(ainvestClient && ainvestClient.enabled);
}

try {
  ainvestClient = require('../services/ainvest');
  console.log(`[PriceFetcher] AInvest client loaded OK (enabled=${ainvestClient.enabled})`);
} catch (err) {
  ainvestClient = null;
  console.warn(`[PriceFetcher] AInvest client failed to load: ${err.message}`);
}

try {
  alpacaClient = require('../services/alpaca');
  console.log(`[PriceFetcher] Alpaca client loaded OK (enabled=${alpacaClient.enabled})`);
} catch (err) {
  alpacaClient = null;
  console.warn(`[PriceFetcher] Alpaca client failed to load: ${err.message}`);
}

try {
  fmpClient = require('../services/yahoo');
  console.log(`[PriceFetcher] FMP client loaded OK (enabled=${fmpClient.enabled})`);
} catch (err) {
  fmpClient = null;
  console.warn(`[PriceFetcher] FMP client failed to load: ${err.message}`);
}

module.exports = {
  getCurrentPrice,
  getMultiplePrices,
  formatForPrompt,
  isAvailable,
};