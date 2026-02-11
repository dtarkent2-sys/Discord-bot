/**
 * Market context provider — fetches data from Alpaca (preferred) or FMP.
 */

const { assertFresh, FreshnessError } = require('./freshness');
const yahoo = require('../services/yahoo');
const alpaca = require('../services/alpaca');
const technicals = require('../services/technicals');
const stocktwits = require('../services/stocktwits');

// Default freshness limits (in seconds)
const FRESHNESS = {
  quote: 300,        // 5 minutes
  candles_1d: 86400, // 24 hours
};

/**
 * Fetch market context for a ticker via Alpaca (preferred) or FMP.
 * Returns structured data for the AI, or { error: true, missing: [...] }.
 * @param {string} ticker
 * @param {{ skipAlpaca?: boolean }} [opts] — pass { skipAlpaca: true } to bypass Alpaca
 *   (useful when the caller enriches with AInvest, which provides richer fundamentals)
 */
async function getMarketContext(ticker, opts = {}) {
  // Resolve crypto shorthand: BTC → BTC-USD, ETH → ETH-USD, etc.
  const resolvedTicker = yahoo.resolveTicker(ticker);
  const missing = [];
  const context = { ticker: resolvedTicker, fetchedAt: new Date().toISOString() };
  const useAlpaca = !opts.skipAlpaca && alpaca.enabled && !yahoo.isCrypto(resolvedTicker);
  context.source = useAlpaca ? 'Alpaca' : 'FMP';

  // ── Ticker Snapshot (fundamentals + technicals) ──
  if (useAlpaca) {
    try {
      const [snapshot, history] = await Promise.all([
        alpaca.getSnapshot(resolvedTicker),
        alpaca.getHistory(resolvedTicker, 260).catch(() => []),
      ]);

      if (snapshot && snapshot.price != null) {
        const closes = history.map(d => d.close).filter(c => c != null);
        const highs = history.map(d => d.high).filter(c => c != null);
        const lows = history.map(d => d.low).filter(c => c != null);

        const sma50 = closes.length >= 50 ? sma(closes, 50) : null;
        const sma200 = closes.length >= 200 ? sma(closes, 200) : null;
        const rsi14 = closes.length >= 15 ? rsi(closes, 14) : null;
        const high52 = highs.length > 0 ? Math.max(...highs) : null;
        const low52 = lows.length > 0 ? Math.min(...lows) : null;

        const priceHistory = history.slice(-30);

        context.snapshot = {
          ticker: resolvedTicker,
          name: resolvedTicker,
          price: snapshot.price,
          previousClose: snapshot.prevClose,
          open: snapshot.open,
          dayHigh: snapshot.high,
          dayLow: snapshot.low,
          volume: snapshot.volume,
          marketCap: null,
          change: snapshot.change,
          changePercent: snapshot.changePercent,
          pe: null,
          forwardPE: null,
          pb: null,
          eps: null,
          divYield: null,
          roe: null,
          profitMargin: null,
          revenueGrowth: null,
          beta: null,
          fiftyTwoWeekHigh: high52,
          fiftyTwoWeekLow: low52,
          sma50,
          sma200,
          rsi14,
          priceHistory,
          timestamp: snapshot.timestamp || new Date().toISOString(),
        };

        context.quote = {
          price: snapshot.price,
          volume: snapshot.volume,
          mktCap: null,
          pe: null,
          rsi14,
          sma50,
          sma200,
          changePercent: snapshot.changePercent,
          timestamp: snapshot.timestamp || new Date().toISOString(),
        };
        context.priceHistory = priceHistory;
      } else {
        missing.push({ field: 'snapshot', reason: `No data returned for ${resolvedTicker}` });
      }
    } catch (err) {
      console.error(`[Market] Alpaca snapshot error for ${resolvedTicker}:`, err.message);
      missing.push({ field: 'snapshot', reason: err.message });
    }
  } else {
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
        missing.push({ field: 'snapshot', reason: `FMP returned no data for ${resolvedTicker}` });
      }
    } catch (err) {
      console.error(`[Market] FMP snapshot error for ${resolvedTicker}:`, err.message);
      missing.push({ field: 'snapshot', reason: err.message });
    }

    // ── Fallback: If FMP failed and skipAlpaca was requested, try Alpaca anyway ──
    // skipAlpaca is a preference (to allow AInvest enrichment), not a hard ban.
    // A partial snapshot from Alpaca is better than total failure.
    if (!context.quote && alpaca.enabled && !yahoo.isCrypto(resolvedTicker)) {
      console.log(`[Market] FMP failed for ${resolvedTicker} — falling back to Alpaca despite skipAlpaca preference`);
      try {
        const [snapshot, history] = await Promise.all([
          alpaca.getSnapshot(resolvedTicker),
          alpaca.getHistory(resolvedTicker, 260).catch(() => []),
        ]);

        if (snapshot && snapshot.price != null) {
          const closes = history.map(d => d.close).filter(c => c != null);
          const highs = history.map(d => d.high).filter(c => c != null);
          const lows = history.map(d => d.low).filter(c => c != null);
          const priceHistory = history.slice(-30);

          context.source = 'Alpaca (fallback)';
          context.snapshot = {
            ticker: resolvedTicker,
            name: resolvedTicker,
            price: snapshot.price,
            previousClose: snapshot.prevClose,
            open: snapshot.open,
            dayHigh: snapshot.high,
            dayLow: snapshot.low,
            volume: snapshot.volume,
            marketCap: null,
            change: snapshot.change,
            changePercent: snapshot.changePercent,
            pe: null, forwardPE: null, pb: null, eps: null, divYield: null,
            roe: null, profitMargin: null, revenueGrowth: null, beta: null,
            fiftyTwoWeekHigh: highs.length > 0 ? Math.max(...highs) : null,
            fiftyTwoWeekLow: lows.length > 0 ? Math.min(...lows) : null,
            sma50: closes.length >= 50 ? sma(closes, 50) : null,
            sma200: closes.length >= 200 ? sma(closes, 200) : null,
            rsi14: closes.length >= 15 ? rsi(closes, 14) : null,
            priceHistory,
            timestamp: snapshot.timestamp || new Date().toISOString(),
          };

          context.quote = {
            price: snapshot.price,
            volume: snapshot.volume,
            mktCap: null,
            pe: null,
            rsi14: closes.length >= 15 ? rsi(closes, 14) : null,
            sma50: closes.length >= 50 ? sma(closes, 50) : null,
            sma200: closes.length >= 200 ? sma(closes, 200) : null,
            changePercent: snapshot.changePercent,
            timestamp: snapshot.timestamp || new Date().toISOString(),
          };
          context.priceHistory = priceHistory;

          // Clear the FMP failure from missing since we recovered
          const fmpIdx = missing.findIndex(m => m.field === 'snapshot');
          if (fmpIdx !== -1) missing.splice(fmpIdx, 1);
          console.log(`[Market] Alpaca fallback succeeded for ${resolvedTicker}: $${snapshot.price}`);
        }
      } catch (alpErr) {
        console.error(`[Market] Alpaca fallback also failed for ${resolvedTicker}:`, alpErr.message);
      }
    }
  }

  // Apply freshness gate to quote data
  if (context.quote) {
    try {
      const quoteAge = assertFresh(context.quote.timestamp, FRESHNESS.quote, 'quote');
      context.quoteAgeSec = quoteAge;
    } catch (err) {
      if (err instanceof FreshnessError) {
        context.quoteStale = true;
        context.quoteAgeSec = err.ageSeconds;
        missing.push({ field: 'quote', reason: `Quote data is stale (${err.ageSeconds}s old, max ${err.maxAgeSeconds}s). DO NOT trust this price as current.` });
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

  // ── Enrich with technical indicators (non-blocking) ──
  try {
    const techResult = await technicals.analyze(resolvedTicker);
    context.technicals = techResult.technicals;
    context.signals = techResult.signals;
  } catch (err) {
    // Technical analysis is supplementary — don't fail the whole request
    missing.push({ field: 'technicals', reason: err.message });
  }

  // ── Enrich with social sentiment (non-blocking) ──
  try {
    const social = await stocktwits.analyzeSymbol(resolvedTicker);
    if (social.messages > 0) {
      context.socialSentiment = social;
    }
  } catch {
    // StockTwits is supplementary — silently skip
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

  // Calculate data age and flag staleness
  const fetchedMs = new Date(context.fetchedAt).getTime();
  const ageSec = Math.floor((Date.now() - fetchedMs) / 1000);
  const ageLabel = ageSec > 300 ? ` [WARNING: data is ${Math.floor(ageSec / 60)}m old — may be stale]`
                 : ageSec > 60  ? ` [${Math.floor(ageSec / 60)}m ago]`
                 : ' [fresh]';

  const lines = [
    `Ticker: ${context.ticker} (fetched: ${context.fetchedAt}${ageLabel})`,
    `Source: ${context.source || 'FMP'}`,
  ];

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

  // Technical indicators (from SHARK engine)
  if (context.technicals) {
    const t = context.technicals;
    lines.push('  Technical Indicators:');
    if (t.rsi_14 !== null) lines.push(`    RSI(14): ${t.rsi_14.toFixed(1)}`);
    if (t.macd) lines.push(`    MACD: ${t.macd.macd.toFixed(3)} | Signal: ${t.macd.signal.toFixed(3)} | Hist: ${t.macd.histogram.toFixed(3)}`);
    if (t.bollinger) lines.push(`    Bollinger: $${t.bollinger.lower.toFixed(2)} — $${t.bollinger.middle.toFixed(2)} — $${t.bollinger.upper.toFixed(2)} (width: ${(t.bollinger.width * 100).toFixed(1)}%)`);
    if (t.sma_20 !== null) lines.push(`    SMA(20): $${t.sma_20.toFixed(2)}`);
    if (t.sma_50 !== null) lines.push(`    SMA(50): $${t.sma_50.toFixed(2)}`);
    if (t.sma_200 !== null) lines.push(`    SMA(200): $${t.sma_200.toFixed(2)}`);
    if (t.ema_12 !== null) lines.push(`    EMA(12): $${t.ema_12.toFixed(2)} | EMA(26): $${t.ema_26?.toFixed(2) ?? '—'}`);
    if (t.atr_14 !== null) lines.push(`    ATR(14): $${t.atr_14.toFixed(2)}`);
    if (t.relative_volume !== null) lines.push(`    Relative Volume: ${t.relative_volume.toFixed(1)}x average`);
  }

  // Signal detection
  if (context.signals && context.signals.length > 0) {
    lines.push('  Detected Signals:');
    for (const sig of context.signals) {
      lines.push(`    [${sig.direction.toUpperCase()}] ${sig.description} (strength: ${(sig.strength * 100).toFixed(0)}%)`);
    }
  }

  // Social sentiment
  if (context.socialSentiment) {
    const s = context.socialSentiment;
    lines.push(`  Social Sentiment (StockTwits): ${s.label} (score: ${(s.score * 100).toFixed(0)}%) — ${s.bullish} bullish / ${s.bearish} bearish / ${s.neutral} neutral (${s.messages} posts)`);
  }

  if (context.quoteStale) {
    lines.push(`  ⚠️ STALE DATA WARNING: Quote is ${context.quoteAgeSec}s old. DO NOT present this price as the current live price.`);
  }

  if (context.missingFields) {
    lines.push(`  Note: Some data unavailable: ${context.missingFields.map(m => `${m.field} (${m.reason})`).join('; ')}`);
  }

  return lines.join('\n');
}

function sma(prices, period) {
  const recent = prices.slice(-period);
  return Math.round((recent.reduce((a, b) => a + b, 0) / recent.length) * 100) / 100;
}

function rsi(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - (100 / (1 + rs))) * 100) / 100;
}

module.exports = { getMarketContext, formatContextForAI, FRESHNESS };
