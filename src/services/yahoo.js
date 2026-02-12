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
   * Sanitize a user-provided ticker to prevent log injection and invalid lookups.
   * Strips anything that isn't alphanumeric, dash, or dot (e.g. BRK.B, BTC-USD).
   * Returns null if the result is empty or too long.
   */
  sanitizeTicker(ticker) {
    if (!ticker || typeof ticker !== 'string') return null;
    const cleaned = ticker.replace(/[^A-Za-z0-9.\-]/g, '').trim();
    if (!cleaned || cleaned.length > 12) return null;
    return cleaned.toUpperCase();
  }

  /**
   * Resolve a user-provided ticker to an FMP-compatible symbol.
   * Handles crypto shorthand: BTC → BTCUSD, ETH → ETHUSD, etc.
   */
  resolveTicker(ticker) {
    const cleaned = this.sanitizeTicker(ticker);
    if (cleaned == null) return null;
    const upper = cleaned;
    // Already in FMP crypto format (BTCUSD)
    if (upper.endsWith('USD') && CRYPTO_MAP[upper.replace('USD', '')]) return upper;
    // Yahoo-style crypto (BTC-USD) → FMP format
    if (upper.endsWith('-USD')) {
      const base = upper.replace('-USD', '');
      if (CRYPTO_MAP[base]) return CRYPTO_MAP[base];
    }
    // Known crypto symbol (direct lookup)
    if (CRYPTO_MAP[upper]) return CRYPTO_MAP[upper];
    // Regular stock ticker
    return upper;
  }

  isCrypto(ticker) {
    const cleaned = this.sanitizeTicker(ticker);
    if (!cleaned) return false;
    const upper = cleaned;
    if (upper.endsWith('USD') && CRYPTO_MAP[upper.replace('USD', '')]) return true;
    if (upper.endsWith('-USD') && CRYPTO_MAP[upper.replace('-USD', '')]) return true;
    return !!CRYPTO_MAP[upper];
  }

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

  async getQuote(ticker) {
    const upper = this.resolveTicker(ticker);
    if (upper == null) throw new Error('Invalid ticker');
    const data = await this._retry(
      () => this._fmpFetch('/quote', { symbol: upper }),
      `quote(${upper})`
    );

    const q = Array.isArray(data) ? data[0] : data;
    if (!q || q.price == null) throw new Error(`No quote data for ${upper}`);

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

  async getQuotes(tickers) {
    if (tickers.length === 0) return [];

    const symbols = tickers.map(t => this.resolveTicker(t)).filter(Boolean);
    if (symbols.length === 0) return [];

    const symbolsStr = symbols.join(',');
    try {
      const data = await this._retry(
        () => this._fmpFetch('/batch-quote', { symbols: symbolsStr }),
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

  async getHistory(ticker, days = 30) {
    const upper = this.resolveTicker(ticker);
    if (upper == null) {
      console.warn(`[FMP] No historical data for ${ticker}`);
      return [];
    }
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);
    const from = fromDate.toISOString().slice(0, 10); // YYYY-MM-DD

    const data = await this._retry(
      () => this._fmpFetch('/historical-price-eod/full', { symbol: upper, from }),
      `history(${upper})`
    );

    const historical = Array.isArray(data) ? data : (data?.historical || []);
    if (historical.length === 0) {
      console.warn(`[FMP] No historical data for ${upper}`);
      return [];
    }

    return historical.reverse().map(d => ({
      date: new Date(d.date),
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      volume: d.volume,
    }));
  }

  async getTickerSnapshot(ticker) {
    const upper = this.resolveTicker(ticker);
    if (upper == null) {
      throw new Error('Invalid ticker for snapshot');
    }
    const isCrypto = this.isCrypto(upper);

    const [quoteData, history, profileData, ratiosData] = await Promise.all([
      this._retry(
        () => this._fmpFetch('/quote', { symbol: upper }),
        `quote(${upper})`
      ).catch(err => { console.warn(`[FMP] Quote failed: ${err.message}`); return null; }),

      this.getHistory(upper, 200).catch(err => {
        console.warn(`[FMP] History failed for ${upper}:`, err.message);
        return [];
      }),

      isCrypto ? Promise.resolve(null) :
        this._retry(
          () => this._fmpFetch('/profile', { symbol: upper }),
          `profile(${upper})`
        ).catch(err => { console.warn(`[FMP] Profile failed: ${err.message}`); return null; }),

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

    const closes = history.map(d => d.close).filter(c => c != null);
    const sma50 = closes.length >= 50 ? this._sma(closes, 50) : (quote.priceAvg50 || null);
    const sma200 = closes.length >= 200 ? this._sma(closes, 200) : (quote.priceAvg200 || null);
    const rsi14 = closes.length >= 15 ? this._rsi(closes, 14) : null;

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

      sma50,
      sma200,
      rsi14,

      priceHistory: history.slice(-30),

      timestamp: new Date().toISOString(),
    };
  }

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