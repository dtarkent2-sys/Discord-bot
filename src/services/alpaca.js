/**
 * Alpaca Markets Data Service
 *
 * Provides real-time stock quotes, options snapshots (with greeks),
 * and historical bars via Alpaca's free data API.
 *
 * Auth: ALPACA_API_KEY + ALPACA_API_SECRET in .env
 * Free tier: real-time IEX data, 200 req/min
 * Docs: https://docs.alpaca.markets/reference/
 */

const config = require('../config');

const DATA_BASE = config.alpacaDataUrl || 'https://data.alpaca.markets';

class AlpacaService {
  constructor() {
    this._headers = null;
  }

  get enabled() {
    return !!(config.alpacaApiKey && config.alpacaApiSecret);
  }

  _getHeaders() {
    if (!this._headers) {
      this._headers = {
        'APCA-API-KEY-ID': config.alpacaApiKey,
        'APCA-API-SECRET-KEY': config.alpacaApiSecret,
        'Accept': 'application/json',
      };
    }
    return this._headers;
  }

  // ── Generic fetch helper ─────────────────────────────────────────────

  async _fetch(path, params = {}, timeoutMs = 15000) {
    if (!this.enabled) throw new Error('Alpaca API keys not configured');

    const url = new URL(`${DATA_BASE}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, String(v));
    }

    console.log(`[Alpaca] ${path}${params.expiration_date ? ` exp=${params.expiration_date}` : ''}`);
    const res = await fetch(url.toString(), {
      headers: this._getHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Alpaca ${res.status}: ${text.slice(0, 300)}`);
    }

    return res.json();
  }

  // ── Stock snapshot (latest quote + bar) ──────────────────────────────

  /**
   * Get the latest snapshot for a stock ticker.
   * Returns { price, open, high, low, volume, prevClose, change, changePercent, ... }
   */
  async getSnapshot(ticker) {
    const upper = ticker.toUpperCase();
    const data = await this._fetch(`/v2/stocks/${upper}/snapshot`);

    const quote = data.latestQuote || {};
    const trade = data.latestTrade || {};
    const bar = data.dailyBar || {};
    const prevBar = data.prevDailyBar || {};

    const price = trade.p || quote.ap || bar.c;
    const prevClose = prevBar.c || 0;
    const change = prevClose ? price - prevClose : 0;
    const changePercent = prevClose ? (change / prevClose) * 100 : 0;

    return {
      ticker: upper,
      price,
      open: bar.o,
      high: bar.h,
      low: bar.l,
      volume: bar.v,
      prevClose,
      change,
      changePercent,
      bid: quote.bp,
      ask: quote.ap,
      bidSize: quote.bs,
      askSize: quote.as,
      timestamp: trade.t || quote.t,
    };
  }

  // ── Multi-stock snapshots ────────────────────────────────────────────

  async getSnapshots(tickers) {
    const symbols = tickers.map(t => t.toUpperCase()).join(',');
    const data = await this._fetch('/v2/stocks/snapshots', { symbols });

    return Object.entries(data).map(([sym, snap]) => {
      const trade = snap.latestTrade || {};
      const bar = snap.dailyBar || {};
      const prevBar = snap.prevDailyBar || {};
      const price = trade.p || bar.c;
      const prevClose = prevBar.c || 0;
      return {
        ticker: sym,
        price,
        volume: bar.v,
        change: prevClose ? price - prevClose : 0,
        changePercent: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
      };
    });
  }

  // ── Options snapshots (for GEX) ──────────────────────────────────────

  /**
   * Fetch options snapshots for an underlying ticker.
   * Returns an array of options with greeks, OI, IV, etc.
   *
   * Alpaca returns greeks directly (delta, gamma, theta, vega, rho)
   * so we don't need Black-Scholes calculations.
   *
   * @param {string} ticker - underlying stock symbol
   * @param {string} [expiration] - filter to specific expiration (YYYY-MM-DD)
   * @param {string} [type] - 'call' or 'put' (omit for both)
   * @returns {Array} options snapshots
   */
  async getOptionsSnapshots(ticker, expiration, type) {
    const upper = ticker.toUpperCase();
    const params = {
      feed: 'indicative', // free tier — use 'opra' if you have paid
      limit: 1000,
    };
    if (expiration) params.expiration_date = expiration;
    if (type) params.type = type;

    let allSnapshots = [];
    let pageToken = null;
    const deadline = Date.now() + 45000; // 45s total time budget for all pages
    let pages = 0;

    // Paginate through results (with time budget)
    do {
      if (pageToken) params.page_token = pageToken;
      const data = await this._fetch(`/v1beta1/options/snapshots/${upper}`, params, 20000);

      const snapshots = data.snapshots || {};
      for (const [symbol, snap] of Object.entries(snapshots)) {
        allSnapshots.push(this._parseOptionSnapshot(symbol, snap));
      }

      pageToken = data.next_page_token || null;
      pages++;

      // Safety: stop if we've exceeded time budget or too many pages
      if (Date.now() > deadline) {
        console.warn(`[Alpaca] Options pagination time budget exceeded after ${pages} pages (${allSnapshots.length} contracts)`);
        break;
      }
      if (pages >= 20) {
        console.warn(`[Alpaca] Options pagination page limit reached (${allSnapshots.length} contracts)`);
        break;
      }
    } while (pageToken);

    console.log(`[Alpaca] ${upper}: fetched ${allSnapshots.length} options in ${pages} page(s)`);
    return allSnapshots;
  }

  _parseOptionSnapshot(symbol, snap) {
    const greeks = snap.greeks || {};
    const quote = snap.latestQuote || {};
    const trade = snap.latestTrade || {};

    // Parse the OCC symbol to extract strike, expiration, type
    // Format: AAPL260220C00610000 → AAPL, 2026-02-20, Call, $610
    const parsed = this._parseOccSymbol(symbol);

    return {
      symbol,
      ticker: parsed.underlying,
      strike: parsed.strike,
      expiration: parsed.expiration,
      type: parsed.type,
      openInterest: snap.openInterest ?? 0,
      impliedVolatility: snap.impliedVolatility ?? greeks.implied_volatility ?? 0,
      // Pre-calculated greeks from Alpaca
      delta: greeks.delta ?? 0,
      gamma: greeks.gamma ?? 0,
      theta: greeks.theta ?? 0,
      vega: greeks.vega ?? 0,
      rho: greeks.rho ?? 0,
      // Pricing
      lastPrice: trade.p ?? 0,
      bid: quote.bp ?? 0,
      ask: quote.ap ?? 0,
      volume: snap.volume ?? 0,
    };
  }

  /**
   * Parse OCC option symbol.
   * Example: AAPL260220C00610000
   *   → underlying: AAPL, expiration: 2026-02-20, type: call, strike: 610.00
   */
  _parseOccSymbol(symbol) {
    // OCC format: ROOT(1-6 chars) + YYMMDD + C/P + strike*1000 (8 digits)
    const match = symbol.match(/^(\w+?)(\d{6})([CP])(\d{8})$/);
    if (!match) {
      return { underlying: symbol, expiration: '', type: 'unknown', strike: 0 };
    }

    const [, underlying, dateStr, cp, strikeStr] = match;
    const yy = dateStr.slice(0, 2);
    const mm = dateStr.slice(2, 4);
    const dd = dateStr.slice(4, 6);
    const expiration = `20${yy}-${mm}-${dd}`;
    const type = cp === 'C' ? 'call' : 'put';
    const strike = parseInt(strikeStr, 10) / 1000;

    return { underlying, expiration, type, strike };
  }

  // ── Historical bars ──────────────────────────────────────────────────

  /**
   * Get historical daily bars for a stock.
   * @param {string} ticker
   * @param {number} days - how many days back
   */
  async getHistory(ticker, days = 30) {
    const upper = ticker.toUpperCase();
    const start = new Date();
    start.setDate(start.getDate() - days);

    const data = await this._fetch(`/v2/stocks/${upper}/bars`, {
      timeframe: '1Day',
      start: start.toISOString(),
      limit: days,
      feed: 'iex',
    });

    return (data.bars || []).map(b => ({
      date: b.t,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
      vwap: b.vw,
    }));
  }

  // ── Latest trade ─────────────────────────────────────────────────────

  async getLatestTrade(ticker) {
    const upper = ticker.toUpperCase();
    const data = await this._fetch(`/v2/stocks/${upper}/trades/latest`);
    return {
      price: data.trade?.p,
      size: data.trade?.s,
      timestamp: data.trade?.t,
    };
  }
}

module.exports = new AlpacaService();
