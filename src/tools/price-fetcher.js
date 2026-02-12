'use strict';
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
let fmpClient;
try {
  fmpClient = require('../services/yahoo');
  console.log(`[PriceFetcher] FMP client loaded OK (enabled=${fmpClient.enabled})`);
} catch (err) {
  fmpClient = null;
  console.warn(`[PriceFetcher] FMP client failed to load: ${err.message}`);
}
let alpacaClient;
try {
  alpacaClient = require('../services/alpaca');
  console.log(`[PriceFetcher] Alpaca client loaded OK (enabled=${alpacaClient.enabled})`);
} catch (err) {
  alpacaClient = null;
  console.warn(`[PriceFetcher] Alpaca client failed to load: ${err.message}`);
}
let ainvestClient;
try {
  ainvestClient = require('../services/ainvest');
  console.log(`[PriceFetcher] AInvest client loaded OK (enabled=${ainvestClient.enabled})`);
} catch (err) {
  ainvestClient = null;
  console.warn(`[PriceFetcher] AInvest client failed to load: ${err.message}`);
}
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000;
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
async function _tryYahoo(ticker) {
  await loadYahooFinance();
  if (!yahooFinance) return null;
  let symbol = ticker;
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
async function _tryFMP(ticker) {
  if (!fmpClient || !fmpClient.enabled) return null;
  try {
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
async function _tryAlpaca(ticker) {
  if (!alpacaClient || !alpacaClient.enabled) return null;
  if (ticker.includes('-') || /^[A-Z]{3,5}USD$/.test(ticker)) return null;
  try {
    const snap = await alpacaClient.getSnapshot(ticker);
    if (!snap || snap.price == null) return null;
    return {
      ticker,
      symbol: snap.ticker,
      price: snap.price,
      change: snap.change ?? null,
      changePercent: snap.changePercent ?? null,
      volume: snap.volume ?? null,
      marketCap: null,
      dayHigh: snap.high ?? null,
      dayLow: snap.low ?? null,
      previousClose: snap.prevClose ?? null,
      fiftyTwoWeekHigh: null,
      fiftyTwoWeekLow: null,
      lastUpdated: new Date().toISOString(),
      source: 'alpaca',
    };
  } catch (err) {
    console.warn(`[PriceFetcher] Alpaca failed for ${ticker}: ${err.message}`);
    return null;
  }
}
async function _tryAInvest(ticker) {
  if (!ainvestClient || !ainvestClient.enabled) return null;
  if (ticker.includes('-') || /^[A-Z]{3,5}USD$/.test(ticker)) return null;
  try {
    const quote = await ainvestClient.getQuote(ticker);
    if (!quote || quote.price == null) {
      console.warn(`[PriceFetcher] AInvest returned no price for ${ticker} (quote=${JSON.stringify(quote)})`);
      return null;
    }
    return quote;
  } catch (err) {
    console.warn(`[PriceFetcher] AInvest failed for ${ticker}: ${err.message}`);
    return null;
  }
}
async function getCurrentPrice(ticker) {
  const upper = ticker.toUpperCase().trim();
  const cached = cache.get(upper);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return { ...cached.data, cached: true };
  }
  if (isRateLimited()) {
    if (cached) return { ...cached.data, cached: true, stale: true };
    return { ticker: upper, error: true, message: 'Rate limited — too many requests' };
  }
  recordCall();
  let data = await _tryAInvest(upper);
  if (!data) {
    data = await _tryFMP(upper);
  }
  if (!data) {
    data = await _tryAlpaca(upper);
  }
  if (!data) {
    data = await _tryYahoo(upper);
  }
  if (data) {
    cache.set(upper, { data, fetchedAt: Date.now() });
    console.log(`[PriceFetcher] ${upper}: $${data.price} via ${data.source}`);
    return data;
  }
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
module.exports = {
  getCurrentPrice,
  getMultiplePrices,
  formatForPrompt,
  isAvailable,
};