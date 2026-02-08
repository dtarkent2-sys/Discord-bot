/**
 * Market context provider — fetches data from Yahoo Finance.
 */

const { assertFresh, FreshnessError } = require('./freshness');
const yahoo = require('../services/yahoo');

// Default freshness limits (in seconds)
const FRESHNESS = {
  quote: 300,        // 5 minutes
  candles_1d: 86400, // 24 hours
};

/**
 * Fetch market context for a ticker via Yahoo Finance.
 * Returns structured data for the AI, or { error: true, missing: [...] }.
 */
async function getMarketContext(ticker) {
  // Resolve crypto shorthand: BTC → BTC-USD, ETH → ETH-USD, etc.
  const resolvedTicker = yahoo.resolveTicker(ticker);
  const missing = [];
  const context = { ticker: resolvedTicker, fetchedAt: new Date().toISOString() };

  // ── Ticker Snapshot (fundamentals + technicals) ──
  try {
    const snapshot = await yahoo.getTickerSnapshot(resolvedTicker);

    if (snapshot && snapshot.price != null) {
      context.snapshot = snapshot;
      context.quote = {
        price: snapshot.price,
        volume: snapshot.volume,
        mktCap: snapshot.marketCap,
        pe: snapshot.pe,
        rsi14: snapshot.rsi14,
        sma50: snapshot.sma50,
        sma200: snapshot.sma200,
        changePercent: snapshot.changePercent,
        timestamp: snapshot.timestamp,
      };
      context.priceHistory = snapshot.priceHistory;
    } else {
      missing.push({ field: 'snapshot', reason: `No data returned for ${resolvedTicker}` });
    }
  } catch (err) {
    console.error(`[Market] Yahoo snapshot error for ${resolvedTicker}:`, err.message);
    missing.push({ field: 'snapshot', reason: err.message });
  }

  // Apply freshness gate to quote data
  if (context.quote) {
    try {
      assertFresh(context.quote.timestamp, FRESHNESS.quote, 'quote');
    } catch (err) {
      if (err instanceof FreshnessError) {
        missing.push({ field: 'quote', reason: `Quote data is stale (${err.ageSeconds}s old, max ${err.maxAgeSeconds}s)` });
      }
    }
  }

  // If we have no data at all, return error
  if (missing.length > 0 && !context.quote) {
    return {
      error: true,
      ticker: resolvedTicker,
      missing,
      message: `Cannot analyze ${resolvedTicker}: ${missing.map(m => m.reason).join('; ')}`,
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
    if (q.changePercent != null) lines.push(`  Daily Change: ${q.changePercent > 0 ? '+' : ''}${q.changePercent.toFixed(2)}%`);
  }

  if (context.snapshot) {
    const s = context.snapshot;
    if (s.pb) lines.push(`  P/B: ${s.pb}`);
    if (s.divYield) lines.push(`  Div Yield: ${s.divYield.toFixed(2)}%`);
    if (s.roe) lines.push(`  ROE: ${s.roe.toFixed(2)}%`);
    if (s.eps) lines.push(`  EPS: $${s.eps}`);
    if (s.beta) lines.push(`  Beta: ${s.beta}`);
    if (s.profitMargin) lines.push(`  Profit Margin: ${s.profitMargin.toFixed(2)}%`);
    if (s.revenueGrowth) lines.push(`  Revenue Growth: ${s.revenueGrowth.toFixed(2)}%`);
    if (s.fiftyTwoWeekHigh) lines.push(`  52-Week High: $${s.fiftyTwoWeekHigh}`);
    if (s.fiftyTwoWeekLow) lines.push(`  52-Week Low: $${s.fiftyTwoWeekLow}`);
    if (s.forwardPE) lines.push(`  Forward P/E: ${s.forwardPE}`);
  }

  if (context.priceHistory && context.priceHistory.length > 0) {
    const recent = context.priceHistory.slice(-5);
    lines.push('  Recent Prices:');
    for (const p of recent) {
      const date = p.date ? new Date(p.date).toISOString().slice(0, 10) : 'N/A';
      const close = p.close;
      if (date && close) lines.push(`    ${date}: $${close.toFixed(2)}`);
    }
  }

  if (context.missingFields) {
    lines.push(`  Note: Some data unavailable: ${context.missingFields.map(m => m.field).join(', ')}`);
  }

  return lines.join('\n');
}

module.exports = { getMarketContext, formatContextForAI, FRESHNESS };
