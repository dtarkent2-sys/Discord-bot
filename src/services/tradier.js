/**
 * Tradier Market Data — Options Chain + Real Greeks (ORATS)
 *
 * Provides option expirations, chains with real greeks (delta, gamma, theta,
 * vega, rho, IV) courtesy of ORATS, and equity quotes.
 *
 * Auth: TRADIER_API_KEY (Bearer token)
 * Rate limit: 120 req/min (sandbox), varies for production
 * Docs: https://docs.tradier.com
 *
 * Greeks are returned inline with the chain response when greeks=true,
 * so no separate batch call is needed (unlike Public.com).
 */

const config = require('../config');

class TradierService {
  constructor() {
    this._headers = null;
  }

  get enabled() {
    return !!config.tradierApiKey;
  }

  get _baseUrl() {
    return config.tradierSandbox
      ? 'https://sandbox.tradier.com'
      : 'https://api.tradier.com';
  }

  _getHeaders() {
    if (!this._headers) {
      this._headers = {
        'Authorization': `Bearer ${config.tradierApiKey}`,
        'Accept': 'application/json',
      };
    }
    return this._headers;
  }

  // ── Generic fetch ─────────────────────────────────────────────────────

  async _get(path, params = {}, timeoutMs = 15000) {
    if (!this.enabled) throw new Error('Tradier API key not configured');

    const qs = new URLSearchParams(params).toString();
    const url = `${this._baseUrl}${path}${qs ? '?' + qs : ''}`;
    console.log(`[Tradier] GET ${path}?${qs}`);

    const res = await fetch(url, {
      method: 'GET',
      headers: this._getHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Tradier API ${res.status}: ${text.slice(0, 300)}`);
    }

    return res.json();
  }

  // ── Option Expirations ────────────────────────────────────────────────

  /**
   * Get available option expiration dates for a symbol.
   * @param {string} symbol - e.g. 'SPY'
   * @returns {Promise<string[]>} Array of date strings (YYYY-MM-DD)
   */
  async getOptionExpirations(symbol) {
    const data = await this._get('/v1/markets/options/expirations', {
      symbol: symbol.toUpperCase(),
      includeAllRoots: 'true',
    });

    const dates = data?.expirations?.date;
    if (!dates) return [];
    // API returns a single string if only one expiration, array otherwise
    return Array.isArray(dates) ? dates : [dates];
  }

  // ── Option Chain with Greeks ──────────────────────────────────────────

  /**
   * Get the full option chain for a symbol + expiration, with ORATS greeks.
   *
   * @param {string} symbol - e.g. 'SPY'
   * @param {string} expirationDate - e.g. '2026-02-14'
   * @returns {Promise<object[]>} Normalized option contracts with greeks
   */
  async getOptionsWithGreeks(symbol, expirationDate) {
    const data = await this._get('/v1/markets/options/chains', {
      symbol: symbol.toUpperCase(),
      expiration: expirationDate,
      greeks: 'true',
    }, 20000);

    const options = data?.options?.option;
    if (!options) return [];

    const list = Array.isArray(options) ? options : [options];
    const contracts = [];

    for (const opt of list) {
      if (!opt.strike) continue;

      const greeks = opt.greeks || {};
      contracts.push({
        symbol: opt.symbol || '',
        ticker: opt.underlying || symbol.toUpperCase(),
        strike: opt.strike,
        expiration: opt.expiration_date || expirationDate,
        type: opt.option_type === 'call' ? 'call' : 'put',
        openInterest: opt.open_interest || 0,
        volume: opt.volume || 0,
        lastPrice: opt.last || 0,
        bid: opt.bid || 0,
        ask: opt.ask || 0,
        bidSize: opt.bidsize || 0,
        askSize: opt.asksize || 0,
        // ORATS greeks — real, not estimated
        delta: parseFloat(greeks.delta) || 0,
        gamma: parseFloat(greeks.gamma) || 0,
        theta: parseFloat(greeks.theta) || 0,
        vega: parseFloat(greeks.vega) || 0,
        rho: parseFloat(greeks.rho) || 0,
        impliedVolatility: parseFloat(greeks.mid_iv) || parseFloat(greeks.smv_vol) || 0,
        bidIV: parseFloat(greeks.bid_iv) || 0,
        askIV: parseFloat(greeks.ask_iv) || 0,
        greeksUpdatedAt: greeks.updated_at || null,
        _source: 'tradier',
      });
    }

    console.log(`[Tradier] ${symbol} ${expirationDate}: ${contracts.length} contracts with ORATS greeks`);
    return contracts;
  }

  // ── Equity Quote (spot price) ─────────────────────────────────────────

  /**
   * Get the current quote for a symbol.
   * @param {string} symbol
   * @returns {Promise<{ price: number, bid: number, ask: number, volume: number }>}
   */
  async getQuote(symbol) {
    const data = await this._get('/v1/markets/quotes', {
      symbols: symbol.toUpperCase(),
    });

    const quote = data?.quotes?.quote;
    if (!quote) throw new Error(`No quote returned for ${symbol}`);

    // Handle single vs array response
    const q = Array.isArray(quote) ? quote[0] : quote;
    return {
      price: q.last || 0,
      bid: q.bid || 0,
      ask: q.ask || 0,
      volume: q.volume || 0,
      prevClose: q.prevclose || 0,
      change: q.change || 0,
      changePct: q.change_percentage || 0,
    };
  }
}

module.exports = new TradierService();
