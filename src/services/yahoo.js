/**
 * Yahoo Finance client using yahoo-finance2 v3 (Node.js).
 * No API key required — uses Yahoo's public APIs.
 */

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
      this._yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
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

  // ── Quote — current price + key stats ───────────────────────────────
  async getQuote(ticker) {
    const yf = await this._getYF();
    if (!yf) throw new Error('Yahoo Finance not available');
    return yf.quote(ticker.toUpperCase());
  }

  // ── Quotes — batch price lookup ─────────────────────────────────────
  async getQuotes(tickers) {
    const yf = await this._getYF();
    if (!yf) throw new Error('Yahoo Finance not available');

    const results = [];
    for (const ticker of tickers) {
      try {
        const quote = await yf.quote(ticker.toUpperCase());
        results.push(quote);
      } catch (err) {
        console.error(`[Yahoo] Quote error for ${ticker}:`, err.message);
        results.push({ symbol: ticker.toUpperCase(), error: err.message });
      }
    }
    return results;
  }

  // ── Historical — price history ──────────────────────────────────────
  async getHistory(ticker, days = 30) {
    const yf = await this._getYF();
    if (!yf) throw new Error('Yahoo Finance not available');

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return yf.historical(ticker.toUpperCase(), {
      period1: startDate,
      interval: '1d',
    });
  }

  // ── Ticker Snapshot — full fundamentals + technicals ────────────────
  async getTickerSnapshot(ticker) {
    const yf = await this._getYF();
    if (!yf) throw new Error('Yahoo Finance not available');

    const upper = ticker.toUpperCase();

    // Fetch quote summary and price history in parallel
    const [summary, history] = await Promise.all([
      yf.quoteSummary(upper, {
        modules: ['price', 'summaryDetail', 'defaultKeyStatistics', 'financialData'],
      }),
      this.getHistory(upper, 200).catch(() => []),
    ]);

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

    const result = await yf.search(query);
    return (result.quotes || []).filter(q => q.quoteType === 'EQUITY').slice(0, 10);
  }

  // ── Screening — v3 uses screener() API ────────────────────────────
  async screenByGainers() {
    const yf = await this._getYF();
    if (!yf) throw new Error('Yahoo Finance not available');

    try {
      const result = await yf.screener({ scrIds: 'day_gainers', count: 20 });
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
