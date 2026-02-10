/**
 * Real-time price fetcher using yahoo-finance2.
 * Free, no API key needed. Handles stocks and crypto.
 *
 * Features:
 * - In-memory cache (60s TTL) to avoid redundant lookups
 * - Rate limiting (max 10 calls/minute)
 * - Graceful fallback on errors
 */

let yahooFinance;
try {
  yahooFinance = require('yahoo-finance2').default;
  console.log('[PriceFetcher] yahoo-finance2 loaded successfully');
} catch (err) {
  // yahoo-finance2 not installed or failed to load — module degrades gracefully
  console.warn(`[PriceFetcher] yahoo-finance2 NOT available: ${err.message}`);
  yahooFinance = null;
}

// ── Cache: ticker → { data, fetchedAt } ────────────────────────────────
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

// ── Rate limiter: sliding window of timestamps ─────────────────────────
const callTimestamps = [];
const MAX_CALLS_PER_MINUTE = 10;

function isRateLimited() {
  const now = Date.now();
  // Remove timestamps older than 1 minute
  while (callTimestamps.length > 0 && callTimestamps[0] < now - 60000) {
    callTimestamps.shift();
  }
  return callTimestamps.length >= MAX_CALLS_PER_MINUTE;
}

function recordCall() {
  callTimestamps.push(Date.now());
}

/**
 * Fetch current price data for a ticker.
 * @param {string} ticker — e.g. "TSLA", "AAPL", "BTC-USD", "ETH-USD"
 * @returns {{ ticker, price, changePercent, change, volume, marketCap, lastUpdated, source }} or { ticker, error, message }
 */
async function getCurrentPrice(ticker) {
  if (!yahooFinance) {
    return { ticker, error: true, message: 'yahoo-finance2 not installed' };
  }

  const upper = ticker.toUpperCase().trim();

  // Check cache first
  const cached = cache.get(upper);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return { ...cached.data, cached: true };
  }

  // Rate limit check
  if (isRateLimited()) {
    // Try returning stale cache if available
    if (cached) return { ...cached.data, cached: true, stale: true };
    return { ticker: upper, error: true, message: 'Rate limited — too many requests' };
  }

  try {
    recordCall();

    // yahoo-finance2 uses symbols like TSLA, AAPL, BTC-USD, ETH-USD
    let symbol = upper;
    // Convert FMP-style crypto (BTCUSD) to Yahoo-style (BTC-USD)
    if (/^[A-Z]{3,5}USD$/.test(symbol) && !['ARKUSD'].includes(symbol)) {
      const base = symbol.replace('USD', '');
      if (['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT', 'LINK',
           'MATIC', 'SHIB', 'LTC', 'BNB', 'UNI', 'NEAR', 'SUI', 'PEPE'].includes(base)) {
        symbol = `${base}-USD`;
      }
    }

    const result = await yahooFinance.quote(symbol);

    if (!result || result.regularMarketPrice == null) {
      return { ticker: upper, error: true, message: `No price data for ${upper}` };
    }

    const data = {
      ticker: upper,
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

    // Cache the result
    cache.set(upper, { data, fetchedAt: Date.now() });

    return data;
  } catch (err) {
    // Return stale cache on error
    if (cached) return { ...cached.data, cached: true, stale: true };
    return { ticker: upper, error: true, message: err.message };
  }
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
  return `Current market data (real-time via Yahoo Finance):\n${lines.join('\n')}`;
}

/**
 * Check if yahoo-finance2 is available.
 */
function isAvailable() {
  return !!yahooFinance;
}

module.exports = {
  getCurrentPrice,
  getMultiplePrices,
  formatForPrompt,
  isAvailable,
};
