/**
 * Alpaca Markets Data + Trading Service
 *
 * Provides real-time stock quotes, options snapshots (with greeks),
 * historical bars, AND trade execution via Alpaca's API.
 *
 * Auth: ALPACA_API_KEY + ALPACA_API_SECRET in .env
 * Free tier: real-time IEX data, 200 req/min
 * Docs: https://docs.alpaca.markets/reference/
 */

const config = require('../config');

const DATA_BASE = config.alpacaDataUrl || 'https://data.alpaca.markets';
// Paper vs live trading endpoint
const TRADING_BASE = config.alpacaPaper !== 'false'
  ? 'https://paper-api.alpaca.markets'
  : 'https://api.alpaca.markets';

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
    const data = await this._fetch(`/v2/stocks/${upper}/snapshot`, { feed: config.alpacaFeed });

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
    const data = await this._fetch('/v2/stocks/snapshots', { symbols, feed: config.alpacaFeed });

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
      feed: config.alpacaFeed === 'sip' ? 'opra' : 'indicative', // 'opra' if SIP (paid), else 'indicative' (free)
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

  // ── News ────────────────────────────────────────────────────────────

  /**
   * Fetch Alpaca News articles.
   * @param {Object} options
   * @param {string[]} [options.symbols] - Array of ticker symbols
   * @param {string} [options.start] - ISO timestamp or date
   * @param {string} [options.end] - ISO timestamp or date
   * @param {number} [options.limit] - Max articles (1-50)
   * @param {boolean} [options.includeContent] - Include full content when available
   * @param {string} [options.sort] - 'asc' or 'desc'
   * @returns {Array} news articles
   */
  async getNews({
    symbols = [],
    start,
    end,
    limit = 5,
    includeContent = false,
    sort = 'desc',
  } = {}) {
    const params = {
      limit: Math.min(Math.max(limit, 1), 50),
      sort,
    };
    if (symbols.length > 0) params.symbols = symbols.join(',');
    if (start) params.start = start;
    if (end) params.end = end;
    if (includeContent) params.include_content = true;

    const data = await this._fetch('/v1beta1/news', params);
    if (Array.isArray(data)) return data;
    return data.news || [];
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
    const data = await this._fetch(`/v2/stocks/${upper}/trades/latest`, { feed: config.alpacaFeed });
    return {
      price: data.trade?.p,
      size: data.trade?.s,
      timestamp: data.trade?.t,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  TRADING API (broker endpoints — paper or live)
  // ═══════════════════════════════════════════════════════════════════

  /** Generic trading API fetch (hits paper-api or api.alpaca.markets) */
  async _tradeFetch(path, method = 'GET', body = null) {
    if (!this.enabled) throw new Error('Alpaca API keys not configured');

    const url = `${TRADING_BASE}${path}`;
    const opts = {
      method,
      headers: { ...this._getHeaders(), 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
    };
    if (body) opts.body = JSON.stringify(body);

    console.log(`[Alpaca:Trade] ${method} ${path}`);
    const res = await fetch(url, opts);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Alpaca ${res.status}: ${text.slice(0, 300)}`);
    }

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) return res.json();
    return null;
  }

  // ── Account ───────────────────────────────────────────────────────

  async getAccount() { return this._tradeFetch('/v2/account'); }
  async getClock() { return this._tradeFetch('/v2/clock'); }

  // ── Positions ─────────────────────────────────────────────────────

  async getPositions() { return this._tradeFetch('/v2/positions'); }
  async getPosition(symbol) { return this._tradeFetch(`/v2/positions/${symbol.toUpperCase()}`); }

  async closePosition(symbol, qty, percentage) {
    const params = new URLSearchParams();
    if (qty) params.set('qty', String(qty));
    if (percentage) params.set('percentage', String(percentage));
    const qs = params.toString() ? `?${params}` : '';
    return this._tradeFetch(`/v2/positions/${symbol.toUpperCase()}${qs}`, 'DELETE');
  }

  async closeAllPositions() { return this._tradeFetch('/v2/positions', 'DELETE'); }

  // ── Orders ────────────────────────────────────────────────────────

  async createOrder(params) {
    console.log(`[Alpaca:Trade] ORDER ${params.side} ${params.qty || params.notional} ${params.symbol} @ ${params.type}`);
    return this._tradeFetch('/v2/orders', 'POST', params);
  }

  async listOrders(status = 'open') { return this._tradeFetch(`/v2/orders?status=${status}&limit=50`); }
  async getOrder(orderId) { return this._tradeFetch(`/v2/orders/${orderId}`); }
  async cancelOrder(orderId) { return this._tradeFetch(`/v2/orders/${orderId}`, 'DELETE'); }
  async cancelAllOrders() { return this._tradeFetch('/v2/orders', 'DELETE'); }
  async getPortfolioHistory(period = '1M', timeframe = '1D') {
    return this._tradeFetch(`/v2/account/portfolio/history?period=${period}&timeframe=${timeframe}`);
  }
  async getAsset(symbol) { return this._tradeFetch(`/v2/assets/${symbol.toUpperCase()}`); }
  get isPaper() { return TRADING_BASE.includes('paper'); }

  // ═══════════════════════════════════════════════════════════════════
  //  OPTIONS TRADING API
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Create an options order using the OCC symbol.
   *
   * Alpaca options orders use the standard /v2/orders endpoint but with
   * OCC-formatted symbols (e.g. SPY260211C00600000) and qty (not notional).
   *
   * @param {object} params
   * @param {string} params.symbol - OCC option symbol (e.g. SPY260211C00600000)
   * @param {number} params.qty - Number of contracts
   * @param {string} params.side - 'buy' (to open) or 'sell' (to close)
   * @param {string} [params.type='limit'] - 'market' or 'limit'
   * @param {number} [params.limit_price] - Required for limit orders
   * @param {string} [params.time_in_force='day'] - 'day', 'gtc', 'ioc', 'fok'
   * @returns {object} Order response
   */
  async createOptionsOrder(params) {
    const order = {
      symbol: params.symbol,
      qty: String(params.qty),
      side: params.side,
      type: params.type || 'limit',
      time_in_force: params.time_in_force || 'day',
    };
    if (params.limit_price != null) {
      order.limit_price = String(params.limit_price);
    }
    console.log(`[Alpaca:Trade] OPTIONS ORDER ${order.side} ${order.qty}x ${order.symbol} @ ${order.type}${order.limit_price ? ' $' + order.limit_price : ''}`);
    return this._tradeFetch('/v2/orders', 'POST', order);
  }

  /**
   * Close an options position by selling contracts.
   *
   * @param {string} occSymbol - OCC option symbol
   * @param {number} [qty] - Contracts to close (omit for all)
   */
  async closeOptionsPosition(occSymbol, qty) {
    const params = new URLSearchParams();
    if (qty) params.set('qty', String(qty));
    const qs = params.toString() ? `?${params}` : '';
    return this._tradeFetch(`/v2/positions/${encodeURIComponent(occSymbol)}${qs}`, 'DELETE');
  }

  /**
   * Get all open positions filtered to options only.
   * Options positions have symbols matching OCC format.
   */
  async getOptionsPositions() {
    const all = await this.getPositions();
    return all.filter(p => /^\w+\d{6}[CP]\d{8}$/.test(p.symbol));
  }

  /**
   * Fetch intraday bars for a ticker.
   *
   * @param {string} ticker
   * @param {object} [opts]
   * @param {string} [opts.timeframe='5Min'] - '1Min', '5Min', '15Min', '1Hour'
   * @param {number} [opts.limit=50] - Number of bars
   * @param {string} [opts.start] - ISO timestamp (defaults to market open today)
   * @returns {Array<{date, open, high, low, close, volume, vwap}>}
   */
  async getIntradayBars(ticker, { timeframe = '5Min', limit = 50, start } = {}) {
    const upper = ticker.toUpperCase();
    const params = {
      timeframe,
      limit,
      feed: config.alpacaFeed || 'iex',
    };
    if (start) params.start = start;

    const data = await this._fetch(`/v2/stocks/${upper}/bars`, params);
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

  /**
   * Get the latest options quote for an OCC symbol.
   * Returns bid/ask/last for an individual option contract.
   */
  async getOptionQuote(occSymbol) {
    const data = await this._fetch(`/v1beta1/options/quotes/latest`, {
      symbols: occSymbol,
      feed: 'indicative',
    });
    const quote = data?.quotes?.[occSymbol];
    if (!quote) return null;
    return {
      symbol: occSymbol,
      bid: quote.bp ?? 0,
      ask: quote.ap ?? 0,
      bidSize: quote.bs ?? 0,
      askSize: quote.as ?? 0,
      timestamp: quote.t,
    };
  }

  /**
   * Build an OCC option symbol.
   * @param {string} underlying - e.g. 'SPY'
   * @param {string} expiration - 'YYYY-MM-DD'
   * @param {string} type - 'call' or 'put'
   * @param {number} strike - e.g. 600.00
   * @returns {string} OCC symbol e.g. 'SPY260211C00600000'
   */
  buildOccSymbol(underlying, expiration, type, strike) {
    const root = underlying.toUpperCase();
    const [yyyy, mm, dd] = expiration.split('-');
    const yy = yyyy.slice(2);
    const cp = type === 'call' ? 'C' : 'P';
    const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0');
    return `${root}${yy}${mm}${dd}${cp}${strikeStr}`;
  }
}

module.exports = new AlpacaService();
