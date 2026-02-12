// yahoo-finance2 v2.x is ESM-only; use dynamic import() instead of require()
let yahooFinance;
let yahooFinanceLoaded = false;
async function loadYahooFinance() {
  if (yahooFinanceLoaded) return yahooFinance;
  yahooFinanceLoaded = true;
  try {
    const mod = await import('yahoo-finance2');
    // ESM dynamic import can double-wrap: mod.default.default vs mod.default
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
const callTimestamps = [];
const MAX_CALLS_PER_MINUTE = 10;

function isRateLimited() {
  const now = Date.now();
  while (callTimestamps.length > 0 && callTimestamps[0] < now - 60000) {
    callTimestamps.shift();
  }
  return callTimestamps.length >= MAX_CALLS_PER_MINUTE;
}

function recordCall() {
  callTimestamps.push(Date.now());
}

// Convert symbol: convert crypto USD pairs (BTCUSD) to Yahoo format (BTC-USD)
// Natively validate symbol before conversion to skip unnecessary processing
async function _tryYahoo(ticker) {
  await loadYahooFinance();
  if (!yahooFinance) return null;

  // Convert FMP-style crypto (BTCUSD) to Yahoo-style (BTC-USD)
  // Return early if symbol isn't Yahoo-friendly
  if (!/^[A-Z]{3,5}$/.test(ticker)) return null;
  if (['ARK', 'ARKK'].includes(ticker)) return null;

  const upper = ticker.toUpperCase();
  if (/USD$/.test(upper)) {
    const base = upper.replace('USD', '');
    const yahooSymbols = [
      'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT', 'LINK',
      'MATIC', 'SHIB', 'LTC', 'BNB', 'UNI', 'NEAR', 'SUI', 'PEPE', 'AVT'
    ];
    if (yahooSymbols.includes(base)) {
      return await _tryYahooInternal(`${base}-USD`);
    }
  }
  return await _tryYahooInternal(upper);
}

// Extracted internal implementation to support early returns
async function _tryYahooInternal(symbol) {
  try {
    const result = await yahooFinance.quote(symbol);
    if (!result || result.regularMarketPrice == null) return null;

    return {
      ticker,
      symbol: result.symbol,
      price: result.regularMarketPrice,
      change: result.regularMarketChange ?? null,
      changePercent: result.regularMarketChangePercent ?? null,
      volume: result.regularMarketVolume ?? null,
      marketCap: result.marketCap ?? null,
      dayHigh: result.regularMarketDayHigh ?? null,
      dayLow: result.regularMarketDayLow ?? null,
      previousClose: result.regularMarketPreviousClose ?? null,
      fiftyTwoWeekHigh: result.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: result.fiftyTwoWeekLow ?? null,
      lastUpdated: new Date().toISOString(),
      source: 'yahoo-finance2',
    };
  } catch (err) {
    console.warn(`[PriceFetcher] yahoo-finance2 failed for ${ticker}: ${err.message}`);
    return null;
  }
}