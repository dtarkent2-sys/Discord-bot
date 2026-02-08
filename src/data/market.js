/**
 * Market context provider — fetches quote, candles, earnings, and news for a ticker.
 * Returns a structured context object or an error object with missing fields.
 *
 * NOTE: This is a pluggable provider skeleton. Replace the fetch* methods with
 * real API calls (Alpha Vantage, Polygon, Yahoo Finance, etc.) for production use.
 */

const { assertFresh, FreshnessError } = require('./freshness');

// Default freshness limits (in seconds)
const FRESHNESS = {
  quote: 300,        // 5 minutes
  candles_5m: 600,   // 10 minutes
  candles_1h: 3600,  // 1 hour
  candles_1d: 86400, // 24 hours
  earnings: 86400,   // 24 hours
  news: 3600,        // 1 hour
};

/**
 * Fetch market context for a ticker.
 * If ANY required field is missing or stale, returns { error: true, missing: [...] }
 * so the caller can refuse to analyze rather than hallucinate.
 */
async function getMarketContext(ticker) {
  const missing = [];
  const context = { ticker: ticker.toUpperCase(), fetchedAt: new Date().toISOString() };

  // ── Quote ──
  try {
    context.quote = await fetchQuote(ticker);
    assertFresh(context.quote?.timestamp, FRESHNESS.quote, 'quote');
  } catch (err) {
    missing.push({ field: 'quote', reason: err.message });
  }

  // ── Candles ──
  for (const interval of ['1d', '1h', '5m']) {
    const key = `candles_${interval}`;
    try {
      context[key] = await fetchCandles(ticker, interval);
      const latest = context[key]?.[context[key].length - 1];
      assertFresh(latest?.timestamp, FRESHNESS[key], key);
    } catch (err) {
      missing.push({ field: key, reason: err.message });
    }
  }

  // ── Earnings date ──
  try {
    context.earningsDate = await fetchEarningsDate(ticker);
    if (!context.earningsDate) {
      missing.push({ field: 'earnings_date', reason: 'No earnings date available' });
    }
  } catch (err) {
    missing.push({ field: 'earnings_date', reason: err.message });
  }

  // ── News ──
  try {
    context.news = await fetchNews(ticker);
    if (!context.news || context.news.length === 0) {
      missing.push({ field: 'news', reason: 'No news articles found' });
    } else {
      assertFresh(context.news[0].publishedAt, FRESHNESS.news, 'news');
    }
  } catch (err) {
    missing.push({ field: 'news', reason: err.message });
  }

  // ── Gate: refuse if anything is missing ──
  if (missing.length > 0) {
    return {
      error: true,
      ticker: context.ticker,
      missing,
      message: `Cannot analyze ${context.ticker}: missing or stale data for ${missing.map(m => m.field).join(', ')}`,
    };
  }

  return context;
}

// ─── Provider stubs (replace with real APIs) ─────────────────────────

async function fetchQuote(ticker) {
  // TODO: Replace with real API call (e.g. Alpha Vantage, Polygon, Yahoo Finance)
  // Expected return: { price, change, changePercent, volume, timestamp }
  return null;
}

async function fetchCandles(ticker, interval) {
  // TODO: Replace with real API call
  // Expected return: [{ open, high, low, close, volume, timestamp }, ...]
  return null;
}

async function fetchEarningsDate(ticker) {
  // TODO: Replace with real API call
  // Expected return: ISO date string or null
  return null;
}

async function fetchNews(ticker) {
  // TODO: Replace with real API call
  // Expected return: [{ headline, source, publishedAt }, ...]
  return null;
}

module.exports = { getMarketContext, assertFresh, FRESHNESS };
