/**
 * Yahoo Finance client using yahoo-finance2 v3 (Node.js).
 * No API key required — uses Yahoo's public APIs.
 * Supports stocks AND crypto (BTC, ETH, SOL, etc.)
 */

// Common crypto symbols → Yahoo Finance format
const CRYPTO_MAP = {
  BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD',
  DOGE: 'DOGE-USD', ADA: 'ADA-USD', AVAX: 'AVAX-USD', DOT: 'DOT-USD',
  LINK: 'LINK-USD', MATIC: 'MATIC-USD', SHIB: 'SHIB-USD', LTC: 'LTC-USD',
  BNB: 'BNB-USD', ATOM: 'ATOM-USD', UNI: 'UNI-USD', FIL: 'FIL-USD',
  APT: 'APT-USD', ARB: 'ARB-USD', OP: 'OP-USD', NEAR: 'NEAR-USD',
  SUI: 'SUI-USD', SEI: 'SEI-USD', TIA: 'TIA-USD', INJ: 'INJ-USD',
  PEPE: 'PEPE-USD', WIF: 'WIF-USD', BONK: 'BONK-USD', FLOKI: 'FLOKI-USD',
  RENDER: 'RENDER-USD', FET: 'FET-USD', TAO: 'TAO-USD', HBAR: 'HBAR-USD',
  ALGO: 'ALGO-USD', XLM: 'XLM-USD', VET: 'VET-USD', ICP: 'ICP-USD',
  AAVE: 'AAVE-USD', MKR: 'MKR-USD', CRV: 'CRV-USD', SAND: 'SAND-USD',
  MANA: 'MANA-USD', AXS: 'AXS-USD', GALA: 'GALA-USD', IMX: 'IMX-USD',
};

class YahooFinanceClient {
  constructor() {
    this._yf = null;
    this._initFailed = false;
  }

  // yahoo-finance2 v3: import class and instantiate
  async _getYF() {
    if (this._yf) return this._yf;
    if (this._initFailed) return null;

    try {
      const YahooFinance = (await import('yahoo-finance2')).default;
      this._yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });
      console.log('[Yahoo] yahoo-finance2 v3 loaded successfully.');
      return this._yf;
    } catch (err) {
      console.error('[Yahoo] Failed to load yahoo-finance2:', err.message);
      this._initFailed = true;
      return null;
    }
  }

  get enabled() {
    return !this._initFailed;
  }

  /**
   * Resolve a user-provided ticker to a Yahoo Finance symbol.
   * Handles crypto shorthand: BTC → BTC-USD, ETH → ETH-USD, etc.
   * Already-suffixed tickers (BTC-USD) pass through unchanged.
   * Regular stock tickers (AAPL, TSLA) pass through unchanged.
   */
  resolveTicker(ticker) {
    const upper = ticker.toUpperCase().trim();
    // Already has -USD suffix (user typed BTC-USD)
    if (upper.endsWith('-USD')) return upper;
    // Known crypto symbol
    if (CRYPTO_MAP[upper]) return CRYPTO_MAP[upper];
    // Regular stock ticker
    return upper;
  }

  /**
   * Check if a resolved ticker is a cryptocurrency.
   */
  isCrypto(ticker) {
    return ticker.toUpperCase().endsWith('-USD') && CRYPTO_MAP[ticker.replace('-USD', '')];
  }

  // ── Retry helper — retries on transient network failures ────────────
  async _retry(fn, label, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const msg = err.message || '';
        const isTransient = msg.includes('fetch failed') ||
          msg.includes('ECONNREFUSED') ||
          msg.includes('ECONNRESET') ||
          msg.includes('ETIMEDOUT') ||
          msg.includes('socket hang up') ||
          msg.includes('network') ||
          msg.includes('Timeout') ||
          msg.includes('HTTP 429') ||
          msg.includes('HTTP 5');

        if (isTransient && attempt < maxRetries) {
          const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
          console.warn(`[Yahoo] ${label} attempt ${attempt + 1}/${maxRetries} failed (${msg}), retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));

          // Reset the client on repeated failures (stale session/cookies)
          if (attempt >= 1) {
            console.warn(`[Yahoo] Resetting client after ${attempt + 1} failures...`);
            this._yf = null;
            this._initFailed = false;
          }
          continue;
        }
        throw err;
      }
    }
  }

  // ── Quote — current price + key stats ───────────────────────────────
  async getQuote(ticker) {
    const yf = await this._getYF();
    if (!yf) throw new Error('Yahoo Finance not available');
    return this._retry(() => yf.quote(ticker.toUpperCase()), `quote(${ticker})`);
  }

  // ── Quotes — batch price lookup ─────────────────────────────────────
  async getQuotes(tickers) {
    const yf = await this._getYF();
    if (!yf) throw new Error('Yahoo Finance not available');

    const results = [];
    for (const ticker of tickers) {
      try {
        const quote = await this._retry(() => yf.quote(ticker.toUpperCase()), `quote(${ticker})`);
        results.push(quote);
      } catch (err) {
        console.error(`[Yahoo] Quote error for ${ticker}:`, err.message);
        results.push({ symbol: ticker.toUpperCase(), error: err.message });
      }
    }
    return results;
  }

  // ── Historical — price history via chart() API ─────────────────────
  async getHistory(ticker, days = 30) {
    const yf = await this._getYF();
    if (!yf) throw new Error('Yahoo Finance not available');

    const now = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Pass period1 and period2 as Unix timestamps (seconds) to avoid
    // Date object serialization issues across Node versions
    const period1 = Math.floor(startDate.getTime() / 1000);
    const period2 = Math.floor(now.getTime() / 1000);

    const result = await this._retry(
      () => yf.chart(ticker.toUpperCase(), { period1, period2, interval: '1d' }),
      `chart(${ticker})`
    );

    // chart() returns { quotes: [{ date, open, high, low, close, volume }] }
    return result.quotes || [];
  }

  // ── Ticker Snapshot — full fundamentals + technicals ────────────────
  async getTickerSnapshot(ticker) {
    const yf = await this._getYF();
    if (!yf) throw new Error('Yahoo Finance not available');

    const upper = ticker.toUpperCase();

    // Fetch quote summary and price history in parallel
    // Both have independent error handling so one failure doesn't kill the other
    let summary, history;
    try {
      [summary, history] = await Promise.all([
        this._retry(
          () => yf.quoteSummary(upper, {
            modules: ['price', 'summaryDetail', 'defaultKeyStatistics', 'financialData'],
          }),
          `quoteSummary(${upper})`
        ),
        this.getHistory(upper, 200).catch(err => {
          console.warn(`[Yahoo] History fetch failed for ${upper}, continuing without:`, err.message);
          return [];
        }),
      ]);
    } catch (err) {
      // quoteSummary failed — fall back to simpler quote() endpoint
      console.warn(`[Yahoo] quoteSummary failed for ${upper} (${err.message}), trying quote() fallback...`);
      const [quote, historyFallback] = await Promise.all([
        this._retry(() => yf.quote(upper), `quote-fallback(${upper})`),
        this.getHistory(upper, 200).catch(() => []),
      ]);
      // Build a minimal summary from the quote response
      summary = {
        price: {
          shortName: quote.shortName || quote.longName,
          regularMarketPrice: quote.regularMarketPrice,
          regularMarketPreviousClose: quote.regularMarketPreviousClose,
          regularMarketOpen: quote.regularMarketOpen,
          regularMarketDayHigh: quote.regularMarketDayHigh,
          regularMarketDayLow: quote.regularMarketDayLow,
          regularMarketVolume: quote.regularMarketVolume,
          marketCap: quote.marketCap,
          regularMarketChange: quote.regularMarketChange,
          regularMarketChangePercent: quote.regularMarketChangePercent,
        },
        summaryDetail: {
          trailingPE: quote.trailingPE,
          forwardPE: quote.forwardPE,
          fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,
          fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
        },
        defaultKeyStatistics: {},
        financialData: {},
      };
      history = historyFallback;
    }

    const price = summary.price || {};
    const detail = summary.summaryDetail || {};
    const keyStats = summary.defaultKeyStatistics || {};
    const financials = summary.financialData || {};

    // Compute technicals from history
    const closes = history.map(d => d.close).filter(c => c != null);
    const sma50 = closes.length >= 50 ? this._sma(closes, 50) : null;
    const sma200 = closes.length >= 200 ? this._sma(closes, 200) : null;
    const rsi14 = closes.length >= 15 ? this._rsi(closes, 14) : null;

    return {
      ticker: upper,
      name: price.shortName || price.longName,
      price: price.regularMarketPrice,
      previousClose: price.regularMarketPreviousClose,
      open: price.regularMarketOpen,
      dayHigh: price.regularMarketDayHigh,
      dayLow: price.regularMarketDayLow,
      volume: price.regularMarketVolume,
      marketCap: price.marketCap,
      change: price.regularMarketChange,
      changePercent: price.regularMarketChangePercent,

      // Fundamentals
      pe: detail.trailingPE,
      forwardPE: detail.forwardPE,
      pb: keyStats.priceToBook,
      eps: financials.earningsPerShare || keyStats.trailingEps,
      divYield: detail.dividendYield != null ? detail.dividendYield * 100 : null,
      roe: financials.returnOnEquity != null ? financials.returnOnEquity * 100 : null,
      profitMargin: financials.profitMargins != null ? financials.profitMargins * 100 : null,
      revenueGrowth: financials.revenueGrowth != null ? financials.revenueGrowth * 100 : null,
      beta: detail.beta,
      fiftyTwoWeekHigh: detail.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: detail.fiftyTwoWeekLow,

      // Technicals (computed from history)
      sma50,
      sma200,
      rsi14,

      // Recent price history for AI context
      priceHistory: history.slice(-30),

      timestamp: new Date().toISOString(),
    };
  }

  // ── Search — find tickers by name ───────────────────────────────────
  async search(query) {
    const yf = await this._getYF();
    if (!yf) throw new Error('Yahoo Finance not available');

    const result = await this._retry(() => yf.search(query), `search(${query})`);
    return (result.quotes || []).filter(q => q.quoteType === 'EQUITY' || q.quoteType === 'CRYPTOCURRENCY').slice(0, 10);
  }

  // ── Screening — v3 uses screener() API ────────────────────────────
  async screenByGainers() {
    const yf = await this._getYF();
    if (!yf) throw new Error('Yahoo Finance not available');

    try {
      const result = await this._retry(
        () => yf.screener({ scrIds: 'day_gainers', count: 20 }),
        'screener(day_gainers)'
      );
      if (result && result.quotes) {
        return result.quotes;
      }
    } catch (err) {
      console.error('[Yahoo] Screener error:', err.message);
    }
    return [];
  }

  // ── Format helpers ──────────────────────────────────────────────────

  formatQuoteForDiscord(quote) {
    if (!quote) return 'No data available.';

    const lines = [`**${quote.symbol}** — ${quote.shortName || 'Unknown'}\n`];
    if (quote.regularMarketPrice != null) lines.push(`**Price:** $${quote.regularMarketPrice.toFixed(2)}`);
    if (quote.regularMarketChangePercent != null) {
      const pct = quote.regularMarketChangePercent;
      lines.push(`**Change:** ${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`);
    }
    if (quote.regularMarketVolume) lines.push(`**Volume:** ${Number(quote.regularMarketVolume).toLocaleString()}`);
    if (quote.marketCap) lines.push(`**Market Cap:** $${(quote.marketCap / 1e9).toFixed(2)}B`);
    return lines.join('\n');
  }

  formatScreenForDiscord(quotes, maxRows = 15) {
    if (!quotes || quotes.length === 0) return 'No results found.';

    const rows = quotes.slice(0, maxRows);
    let output = `**Screen Results** (${quotes.length} stocks)\n\`\`\`\n`;
    output += 'Ticker   | Price     | Change   | Volume\n';
    output += '---------|-----------|----------|----------\n';
    for (const q of rows) {
      const sym = (q.symbol || '').padEnd(8);
      const price = q.regularMarketPrice != null ? `$${q.regularMarketPrice.toFixed(2)}`.padEnd(9) : 'N/A'.padEnd(9);
      const change = q.regularMarketChangePercent != null
        ? `${q.regularMarketChangePercent > 0 ? '+' : ''}${q.regularMarketChangePercent.toFixed(2)}%`.padEnd(8)
        : 'N/A'.padEnd(8);
      const vol = q.regularMarketVolume ? `${(q.regularMarketVolume / 1e6).toFixed(1)}M` : 'N/A';
      output += `${sym} | ${price} | ${change} | ${vol}\n`;
    }
    output += '```';

    if (output.length > 1900) {
      output = output.slice(0, 1900) + '\n...```';
    }
    return output;
  }

  // ── Technical indicator calculations ────────────────────────────────

  _sma(prices, period) {
    const recent = prices.slice(-period);
    return Math.round((recent.reduce((a, b) => a + b, 0) / recent.length) * 100) / 100;
  }

  _rsi(prices, period = 14) {
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
}

module.exports = new YahooFinanceClient();
