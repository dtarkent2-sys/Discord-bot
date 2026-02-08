/**
 * Market context provider — fetches data from Portfolio123 API.
 * Replaces the old stub providers with real P123 data.
 */

const { assertFresh, FreshnessError } = require('./freshness');
const p123 = require('../services/p123');

// Default freshness limits (in seconds)
const FRESHNESS = {
  quote: 300,        // 5 minutes
  candles_1d: 86400, // 24 hours
};

/**
 * Fetch market context for a ticker via Portfolio123.
 * Returns structured data for the AI, or { error: true, missing: [...] }.
 */
async function getMarketContext(ticker) {
  const upperTicker = ticker.toUpperCase();

  if (!p123.enabled) {
    return {
      error: true,
      ticker: upperTicker,
      missing: [{ field: 'p123', reason: 'Portfolio123 API not configured (set P123_API_ID and P123_API_KEY)' }],
      message: `Cannot analyze ${upperTicker}: Portfolio123 API credentials not configured.`,
    };
  }

  const missing = [];
  const context = { ticker: upperTicker, fetchedAt: new Date().toISOString() };

  // ── Ticker Snapshot (fundamentals + technicals) ──
  try {
    const snapshot = await p123.getTickerSnapshot(upperTicker);
    if (snapshot && snapshot.rows && snapshot.rows.length > 0) {
      const row = snapshot.rows[0];
      const names = snapshot.names || snapshot.columnNames || [];
      const data = {};
      for (let i = 0; i < names.length; i++) {
        data[names[i]] = row[i] !== undefined ? row[i] : (Array.isArray(row) ? row[i] : null);
      }
      context.snapshot = data;
      context.quote = {
        price: data.Price,
        volume: data.Volume,
        mktCap: data.MktCap,
        pe: data.PE,
        rsi14: data.RSI14,
        sma50: data.SMA50,
        sma200: data.SMA200,
        timestamp: new Date().toISOString(),
      };
    } else {
      missing.push({ field: 'snapshot', reason: `No data returned for ${upperTicker}` });
    }
  } catch (err) {
    console.error(`[Market] P123 snapshot error for ${upperTicker}:`, err.message);
    missing.push({ field: 'snapshot', reason: err.message });
  }

  // ── Price History (last 30 days) ──
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const start = thirtyDaysAgo.toISOString().slice(0, 10);
    const prices = await p123.getPrices(upperTicker, start);
    if (prices && Array.isArray(prices) && prices.length > 0) {
      context.priceHistory = prices;
      context.candles_1d = prices;
    } else {
      missing.push({ field: 'price_history', reason: 'No price history returned' });
    }
  } catch (err) {
    console.error(`[Market] P123 price history error for ${upperTicker}:`, err.message);
    missing.push({ field: 'price_history', reason: err.message });
  }

  // If we have no data at all, return error
  if (missing.length > 0 && !context.quote) {
    return {
      error: true,
      ticker: upperTicker,
      missing,
      message: `Cannot analyze ${upperTicker}: ${missing.map(m => m.reason).join('; ')}`,
    };
  }

  // Partial data is OK — include what we have and note what's missing
  if (missing.length > 0) {
    context.missingFields = missing;
  }

  return context;
}

/**
 * Format market context into a string for the AI system prompt.
 */
function formatContextForAI(context) {
  if (!context || context.error) {
    return context?.message || 'No market data available.';
  }

  const lines = [`Ticker: ${context.ticker} (as of ${context.fetchedAt})`];

  if (context.quote) {
    const q = context.quote;
    if (q.price) lines.push(`  Price: $${q.price}`);
    if (q.volume) lines.push(`  Volume: ${Number(q.volume).toLocaleString()}`);
    if (q.mktCap) lines.push(`  Market Cap: $${Number(q.mktCap).toLocaleString()}`);
    if (q.pe) lines.push(`  P/E: ${q.pe}`);
    if (q.rsi14) lines.push(`  RSI(14): ${q.rsi14}`);
    if (q.sma50) lines.push(`  SMA(50): $${q.sma50}`);
    if (q.sma200) lines.push(`  SMA(200): $${q.sma200}`);
  }

  if (context.snapshot) {
    const s = context.snapshot;
    if (s.PB) lines.push(`  P/B: ${s.PB}`);
    if (s.DivYield) lines.push(`  Div Yield: ${s.DivYield}%`);
    if (s.ROE) lines.push(`  ROE: ${s.ROE}%`);
    if (s.EPS) lines.push(`  EPS: $${s.EPS}`);
    if (s['1wkReturn']) lines.push(`  1-Week Return: ${((s['1wkReturn'] - 1) * 100).toFixed(2)}%`);
    if (s['1moReturn']) lines.push(`  1-Month Return: ${((s['1moReturn'] - 1) * 100).toFixed(2)}%`);
  }

  if (context.priceHistory && context.priceHistory.length > 0) {
    const recent = context.priceHistory.slice(-5);
    lines.push('  Recent Prices:');
    for (const p of recent) {
      const date = p.date || p.Date || p[0];
      const close = p.close || p.Close || p[4] || p[1];
      if (date && close) lines.push(`    ${date}: $${close}`);
    }
  }

  if (context.missingFields) {
    lines.push(`  Note: Some data unavailable: ${context.missingFields.map(m => m.field).join(', ')}`);
  }

  return lines.join('\n');
}

module.exports = { getMarketContext, formatContextForAI, FRESHNESS };
