/**
 * Real-time price fetcher with multi-source fallback.
 *
 * Source priority:
 *   1. yahoo-finance2 (free, no API key)
 *   2. FMP — Financial Modeling Prep (needs FMP_API_KEY, very reliable)
 *   3. Stale cache (better than nothing)
 *
 * Features:
 * - In-memory cache (60s TTL) to avoid redundant lookups
 * - Rate limiting (max 10 calls/minute)
 * - Automatic fallback through multiple data sources
 */

let yahooFinance;
try {
  yahooFinance = require('yahoo-finance2').default;
} catch {
  yahooFinance = null;
}

// FMP client (already exists in the codebase — uses API key)
let fmpClient;
try {
  fmpClient = require('../services/yahoo');
} catch {
  fmpClient = null;
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

/**
 * Try fetching a quote via yahoo-finance2.
 * @returns {object|null} Normalized price data or null on failure.
 */
async function _tryYahoo(ticker) {
  if (!yahooFinance) return null;

  let symbol = ticker;
  // Convert FMP-style crypto (BTCUSD) to Yahoo-style (BTC-USD)
  if (/^[A-Z]{3,5}USD$/.test(symbol) && !['ARKUSD'].includes(symbol)) {
    const base = symbol.replace('USD', '');
    if (['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT', 'LINK',
         'MATIC', 'SHIB', 'LTC', 'BNB', 'UNI', 'NEAR', 'SUI', 'PEPE'].includes(base)) {
      symbol = `${base}-USD`;
    }
  }

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

/**
 * Try fetching a quote via FMP (Financial Modeling Prep).
 * @returns {object|null} Normalized price data or null on failure.
 */
async function _tryFMP(ticker) {
  if (!fmpClient || !fmpClient.enabled) return null;

  try {
    // FMP uses its own ticker format — let the client resolve it
    const fmpSymbol = fmpClient.resolveTicker(ticker);
    const q = await fmpClient.getQuote(fmpSymbol);
    if (!q || q.regularMarketPrice == null) return null;

    return {
      ticker,
      symbol: q.symbol,
      price: q.regularMarketPrice,
      change: q.regularMarketChange ?? null,
      changePercent: q.regularMarketChangePercent ?? null,
      volume: q.regularMarketVolume ?? null,
      marketCap: q.marketCap ?? null,
      dayHigh: q.regularMarketDayHigh ?? null,
      dayLow: q.regularMarketDayLow ?? null,
      previousClose: q.regularMarketPreviousClose ?? null,
      fiftyTwoWeekHigh: q.fiftyTwoWeekHigh ?? null,
      fiftyTwoWeekLow: q.fiftyTwoWeekLow ?? null,
      lastUpdated: new Date().toISOString(),
      source: 'fmp',
    };
  } catch (err) {
    console.warn(`[PriceFetcher] FMP failed for ${ticker}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch current price data for a ticker.
 * Tries yahoo-finance2 first, then FMP, then stale cache.
 * @param {string} ticker — e.g. "TSLA", "AAPL", "BTC-USD", "ETH-USD"
 * @returns {{ ticker, price, changePercent, change, volume, marketCap, lastUpdated, source }} or { ticker, error, message }
 */
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

  // Try yahoo-finance2 first (free, no key)
  let data = await _tryYahoo(upper);

  // Fallback to FMP (API key, more reliable from servers)
  if (!data) {
    data = await _tryFMP(upper);
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
  return { ticker: upper, error: true, message: `No price data for ${upper} (yahoo-finance2 and FMP both failed)` };
}

/**
 * Fetch prices for multiple tickers in parallel.
 * @param {string[]} tickers
 * @returns {Array<{ ticker, price, changePercent, ... }>}
 */
async function getMultiplePrices(tickers) {
  return Promise.all(tickers.map(t => getCurrentPrice(t)));
}

/**
 * Format price data as a string for LLM prompt injection.
 * @param {Array<{ ticker, price, changePercent, volume }>} prices
 * @returns {string}
 */
function formatForPrompt(prices) {
  if (!prices || prices.length === 0) return '';

  const lines = prices
    .filter(p => !p.error && p.price != null)
    .map(p => {
      const dir = (p.changePercent ?? 0) >= 0 ? '+' : '';
      const pct = p.changePercent != null ? `${dir}${p.changePercent.toFixed(2)}%` : 'N/A';
      const vol = p.volume ? `Vol: ${(p.volume / 1e6).toFixed(1)}M` : '';
      return `${p.ticker}: $${p.price.toFixed(2)} (${pct}) ${vol}`.trim();
    });

  if (lines.length === 0) return 'Price data unavailable — proceeding with caution.';
  return `Current market data (real-time):\n${lines.join('\n')}`;
}

/**
 * Check if any price source is available (yahoo-finance2 OR FMP).
 */
function isAvailable() {
  return !!yahooFinance || !!(fmpClient && fmpClient.enabled);
}

module.exports = {
  getCurrentPrice,
  getMultiplePrices,
  formatForPrompt,
  isAvailable,
};
