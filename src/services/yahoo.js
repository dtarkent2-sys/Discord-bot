/**
 * Market data client using Financial Modeling Prep (FMP) API.
 * Requires an API key — set FMP_API_KEY in your .env file.
 * Get your free key at https://financialmodelingprep.com/developer
 * Supports stocks AND crypto (BTC, ETH, SOL, etc.)
 */

const config = require('../config');

const FMP_BASE = 'https://financialmodelingprep.com/stable';

// Common crypto symbols → FMP format (BTCUSD, not BTC-USD)
const CRYPTO_MAP = {
  BTC: 'BTCUSD', ETH: 'ETHUSD', SOL: 'SOLUSD', XRP: 'XRPUSD',
  DOGE: 'DOGEUSD', ADA: 'ADAUSD', AVAX: 'AVAXUSD', DOT: 'DOTUSD',
  LINK: 'LINKUSD', MATIC: 'MATICUSD', SHIB: 'SHIBUSD', LTC: 'LTCUSD',
  BNB: 'BNBUSD', ATOM: 'ATOMUSD', UNI: 'UNIUSD', FIL: 'FILUSD',
  APT: 'APTUSD', ARB: 'ARBUSD', OP: 'OPUSD', NEAR: 'NEARUSD',
  SUI: 'SUIUSD', SEI: 'SEIUSD', TIA: 'TIAUSD', INJ: 'INJUSD',
  PEPE: 'PEPEUSD', WIF: 'WIFUSD', BONK: 'BONKUSD', FLOKI: 'FLOKIUSD',
  RENDER: 'RENDERUSD', FET: 'FETUSD', TAO: 'TAOUSD', HBAR: 'HBARUSD',
  ALGO: 'ALGOUSD', XLM: 'XLMUSD', VET: 'VETUSD', ICP: 'ICPUSD',
  AAVE: 'AAVEUSD', MKR: 'MKRUSD', CRV: 'CRVUSD', SAND: 'SANDUSD',
  MANA: 'MANAUSD', AXS: 'AXSUSD', GALA: 'GALAUSD', IMX: 'IMXUSD',
};

class MarketDataClient {
  constructor() {}

  get enabled() {
    return !!config.fmpApiKey;
  }

  /**
   * Resolve a user-provided ticker to an FMP-compatible symbol.
   * Handles crypto shorthand: BTC → BTCUSD, ETH → ETHUSD, etc.
   */
  resolveTicker(ticker) {
    const upper = ticker.toUpperCase().trim();
    // Already in FMP crypto format (BTCUSD)
    if (upper.endsWith('USD') && CRYPTO_MAP[upper.replace('USD', '')]) return upper;
    // Yahoo-style crypto (BTC-USD) → FMP format
    if (upper.endsWith('-USD')) {
      const base = upper.replace('-USD', '');
      if (CRYPTO_MAP[base]) return CRYPTO_MAP[base];
    }
    // Known crypto symbol
    if (CRYPTO_MAP[upper]) return CRYPTO_MAP[upper];
    // Regular stock ticker
    return upper;
  }

  isCrypto(ticker) {
    const upper = ticker.toUpperCase();
    if (upper.endsWith('USD')) return !!CRYPTO_MAP[upper.replace('USD', '')];
    if (upper.endsWith('-USD')) return !!CRYPTO_MAP[upper.replace('-USD', '')];
    return !!CRYPTO_MAP[upper];
  }

  // ── FMP API fetch helper ──────────────────────────────────────────────

  async _fmpFetch(endpoint, params = {}) {
    if (!config.fmpApiKey) throw new Error('FMP API key not configured — set FMP_API_KEY in .env');

    const url = new URL(`${FMP_BASE}${endpoint}`);
    url.searchParams.set('apikey', config.fmpApiKey);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }

    console.log(`[FMP] Fetching: ${endpoint}`);
    const res = await fetch(url.toString(), {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`FMP API ${res.status}: ${text.slice(0, 200)}`);
    }

    return res.json();
  }

  // ── Retry helper ──────────────────────────────────────────────────────

  async _retry(fn, label, maxRetries = 2) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const msg = err.message || '';
        const isTransient = msg.includes('fetch failed') ||
          msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET') ||
          msg.includes('ETIMEDOUT') || msg.includes('Timeout') ||
          msg.includes('429') || /HTTP 5\d\d/.test(msg);

        if (isTransient && attempt < maxRetries) {
          const delay = Math.pow(2, attempt + 1) * 1000;
          console.warn(`[FMP] ${label} attempt ${attempt + 1}/${maxRetries} failed (${msg}), retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }

  // ── Quote — current price + key stats ─────────────────────────────────

  async getQuote(ticker) {
    const upper = ticker.toUpperCase();
    const data = await this._retry(
      () => this._fmpFetch('/quote', { symbol: upper }),
      `quote(${upper})`
    );

    const q = Array.isArray(data) ? data[0] : data;
    if (!q || q.price == null) throw new Error(`No quote data for ${upper}`);

    // Map to backward-compatible field names
    return {
      symbol: q.symbol,
      shortName: q.name,
      longName: q.name,
      regularMarketPrice: q.price,
      regularMarketPreviousClose: q.previousClose,
      regularMarketOpen: q.open,
      regularMarketDayHigh: q.dayHigh,
      regularMarketDayLow: q.dayLow,
      regularMarketVolume: q.volume,
      regularMarketChange: q.change,
      regularMarketChangePercent: q.changesPercentage,
      marketCap: q.marketCap,
      fiftyTwoWeekHigh: q.yearHigh,
      fiftyTwoWeekLow: q.yearLow,
    };
  }

  // ── Quotes — batch price lookup ───────────────────────────────────────

  async getQuotes(tickers) {
    if (tickers.length === 0) return [];

    // FMP stable API has a dedicated batch-quote endpoint
    const symbols = tickers.map(t => t.toUpperCase()).join(',');
    try {
      const data = await this._retry(
        () => this._fmpFetch('/batch-quote', { symbols }),
        `quotes(batch)`
      );

      const results = (Array.isArray(data) ? data : [data]).filter(Boolean);
      return results.map(q => ({
        symbol: q.symbol,
        shortName: q.name,
        regularMarketPrice: q.price,
        regularMarketPreviousClose: q.previousClose,
        regularMarketVolume: q.volume,
        regularMarketChange: q.change,
        regularMarketChangePercent: q.changesPercentage,
        marketCap: q.marketCap,
      }));
    } catch (err) {
      console.error(`[FMP] Batch quote error:`, err.message);
      // Fall back to individual fetches
      const results = [];
      for (const ticker of tickers) {
        try {
          results.push(await this.getQuote(ticker));
        } catch (e) {
          results.push({ symbol: ticker.toUpperCase(), error: e.message });
        }
      }
      return results;
    }
  }

  // ── Historical — price history ────────────────────────────────────────

  async getHistory(ticker, days = 30) {
    const upper = ticker.toUpperCase();
    // Calculate the "from" date
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);
    const from = fromDate.toISOString().slice(0, 10); // YYYY-MM-DD

    const data = await this._retry(
      () => this._fmpFetch('/historical-price-eod/full', { symbol: upper, from }),
      `history(${upper})`
    );

    // Stable API may return array directly or wrapped in { historical: [...] }
    const historical = Array.isArray(data) ? data : (data?.historical || []);
    if (historical.length === 0) {
      console.warn(`[FMP] No historical data for ${upper}`);
      return [];
    }

    // FMP returns newest-first → reverse to oldest-first
    return historical.reverse().map(d => ({
      date: new Date(d.date),
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      volume: d.volume,
    }));
  }

  // ── Ticker Snapshot — full fundamentals + technicals ──────────────────

  async getTickerSnapshot(ticker) {
    const upper = ticker.toUpperCase();
    const isCrypto = this.isCrypto(upper);

    // Fetch quote + history in parallel (always needed)
    // Also fetch profile + ratios for stocks (extra fundamentals)
    const [quoteData, history, profileData, ratiosData] = await Promise.all([
      this._retry(
        () => this._fmpFetch('/quote', { symbol: upper }),
        `quote(${upper})`
      ).catch(err => { console.warn(`[FMP] Quote failed: ${err.message}`); return null; }),

      this.getHistory(upper, 200).catch(err => {
        console.warn(`[FMP] History failed for ${upper}:`, err.message);
        return [];
      }),

      // Profile gives us beta, sector, description
      isCrypto ? Promise.resolve(null) :
        this._retry(
          () => this._fmpFetch('/profile', { symbol: upper }),
          `profile(${upper})`
        ).catch(err => { console.warn(`[FMP] Profile failed: ${err.message}`); return null; }),

      // Key metrics TTM gives us ROE, P/B, profit margin, etc.
      isCrypto ? Promise.resolve(null) :
        this._retry(
          () => this._fmpFetch('/key-metrics-ttm', { symbol: upper }),
          `metrics(${upper})`
        ).catch(err => { console.warn(`[FMP] Key metrics failed: ${err.message}`); return null; }),
    ]);

    const quote = Array.isArray(quoteData) ? quoteData[0] : quoteData;
    if (!quote || quote.price == null) throw new Error(`No data returned for ${upper}`);

    const profile = Array.isArray(profileData) ? profileData?.[0] : profileData;
    const ratios = Array.isArray(ratiosData) ? ratiosData?.[0] : ratiosData;

    // Compute technicals from history
    const closes = history.map(d => d.close).filter(c => c != null);
    const sma50 = closes.length >= 50 ? this._sma(closes, 50) : (quote.priceAvg50 || null);
    const sma200 = closes.length >= 200 ? this._sma(closes, 200) : (quote.priceAvg200 || null);
    const rsi14 = closes.length >= 15 ? this._rsi(closes, 14) : null;

    // Compute dividend yield from profile if ratios unavailable
    let divYield = null;
    if (ratios?.dividendYieldTTM != null) {
      divYield = ratios.dividendYieldTTM * 100;
    } else if (profile?.lastDiv && quote.price) {
      divYield = (profile.lastDiv / quote.price) * 100;
    }

    return {
      ticker: upper,
      name: quote.name || profile?.companyName || upper,
      price: quote.price,
      previousClose: quote.previousClose,
      open: quote.open,
      dayHigh: quote.dayHigh,
      dayLow: quote.dayLow,
      volume: quote.volume,
      marketCap: quote.marketCap,
      change: quote.change,
      changePercent: quote.changesPercentage,

      // Fundamentals
      pe: quote.pe || null,
      forwardPE: ratios?.peRatioTTM || null,
      pb: ratios?.pbRatioTTM || ratios?.priceToBookRatioTTM || null,
      eps: quote.eps || null,
      divYield,
      roe: ratios?.roeTTM != null ? ratios.roeTTM * 100 : null,
      profitMargin: ratios?.netProfitMarginTTM != null ? ratios.netProfitMarginTTM * 100 : null,
      revenueGrowth: ratios?.revenueGrowthTTM != null ? ratios.revenueGrowthTTM * 100 : null,
      beta: profile?.beta || null,
      fiftyTwoWeekHigh: quote.yearHigh,
      fiftyTwoWeekLow: quote.yearLow,

      // Technicals (computed from history)
      sma50,
      sma200,
      rsi14,

      // Recent price history for AI context
      priceHistory: history.slice(-30),

      timestamp: new Date().toISOString(),
    };
  }

  // ── Search — find tickers by name ─────────────────────────────────────

  async search(query) {
    const data = await this._retry(
      () => this._fmpFetch('/search-symbol', { query }),
      `search(${query})`
    );
    return (Array.isArray(data) ? data : []).map(r => ({
      symbol: r.symbol,
      shortname: r.name,
      quoteType: r.currency === 'USD' && r.symbol?.endsWith('USD') ? 'CRYPTOCURRENCY' : 'EQUITY',
      exchange: r.exchangeShortName || r.stockExchange,
    }));
  }

  // ── Screening — top gainers ───────────────────────────────────────────

  async screenByGainers() {
    const data = await this._retry(
      () => this._fmpFetch('/biggest-gainers'),
      'gainers'
    );

    if (!Array.isArray(data) || data.length === 0) return [];

    return data.slice(0, 20).map(q => ({
      symbol: q.symbol,
      shortName: q.name,
      regularMarketPrice: q.price,
      regularMarketChangePercent: q.changesPercentage,
      regularMarketVolume: q.volume || null,
      marketCap: q.marketCap || null,
    }));
  }

  // ── Format helpers ────────────────────────────────────────────────────

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

  // ── Technical indicator calculations ──────────────────────────────────

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

module.exports = new MarketDataClient();
