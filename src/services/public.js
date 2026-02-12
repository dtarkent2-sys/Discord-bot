/**
 * Public.com Market Data + Options API Service
 *
 * Provides real-time option chain data with greeks via Public's official API.
 * Used as the preferred options data source (Alpaca indicative feed as fallback).
 *
 * Auth: PUBLIC_API_KEY (Bearer token) + PUBLIC_ACCOUNT_ID
 * Rate limit: 10 req/sec
 * Docs: https://public.com/api/docs
 */

const config = require('../config');

const API_BASE = 'https://api.public.com';

class PublicService {
  constructor() {
    this._headers = null;
  }

  get enabled() {
    return !!(config.publicApiKey && config.publicAccountId);
  }

  _getHeaders() {
    if (!this._headers) {
      this._headers = {
        'Authorization': `Bearer ${config.publicApiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      };
    }
    return this._headers;
  }

  // ── Generic fetch helpers ───────────────────────────────────────────

  async _post(path, body, timeoutMs = 15000) {
    if (!this.enabled) throw new Error('Public.com API key or account ID not configured');

    const url = `${API_BASE}${path}`;
    console.log(`[Public] POST ${path}`);

    const res = await fetch(url, {
      method: 'POST',
      headers: this._getHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Public API ${res.status}: ${text.slice(0, 300)}`);
    }

    return res.json();
  }

  async _get(path, timeoutMs = 15000) {
    if (!this.enabled) throw new Error('Public.com API key or account ID not configured');

    const url = `${API_BASE}${path}`;
    console.log(`[Public] GET ${path}`);

    const res = await fetch(url, {
      method: 'GET',
      headers: this._getHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Public API ${res.status}: ${text.slice(0, 300)}`);
    }

    return res.json();
  }

  // ── Option Expirations ──────────────────────────────────────────────

  /**
   * Get available option expiration dates for a symbol.
   * @param {string} symbol - e.g. 'SPY'
   * @param {string} [instrumentType='EQUITY'] - 'EQUITY' or 'UNDERLYING_SECURITY_FOR_INDEX_OPTION'
   * @returns {string[]} Array of expiration date strings (YYYY-MM-DD)
   */
  async getOptionExpirations(symbol, instrumentType = 'EQUITY') {
    const accountId = config.publicAccountId;
    const data = await this._post(
      `/userapigateway/marketdata/${accountId}/option-expirations`,
      {
        instrument: { symbol: symbol.toUpperCase(), type: instrumentType },
      }
    );
    // Response expected to contain an array of expiration dates
    return data.expirations || data || [];
  }

  // ── Option Chain ────────────────────────────────────────────────────

  /**
   * Get the full option chain for a symbol + expiration.
   * Returns calls and puts with quotes (bid, ask, last, volume, OI).
   *
   * @param {string} symbol - e.g. 'SPY'
   * @param {string} expirationDate - e.g. '2026-02-12'
   * @param {string} [optionType] - 'call' or 'put' (null = both)
   * @param {string} [instrumentType='EQUITY']
   * @returns {object[]} Normalized option contracts (same shape as Alpaca)
   */
  async getOptionChain(symbol, expirationDate, optionType = null, instrumentType = 'EQUITY') {
    const accountId = config.publicAccountId;
    const data = await this._post(
      `/userapigateway/marketdata/${accountId}/option-chain`,
      {
        instrument: { symbol: symbol.toUpperCase(), type: instrumentType },
        expirationDate,
      },
      20000 // 20s timeout for large chains
    );

    const results = [];
    const calls = data.calls || [];
    const puts = data.puts || [];

    // Normalize calls
    if (!optionType || optionType === 'call') {
      for (const c of calls) {
        if (c.outcome !== 'SUCCESS') continue;
        const parsed = this._parseOsiSymbol(c.instrument?.symbol);
        results.push(this._normalizeQuote(c, parsed, 'call'));
      }
    }

    // Normalize puts
    if (!optionType || optionType === 'put') {
      for (const p of puts) {
        if (p.outcome !== 'SUCCESS') continue;
        const parsed = this._parseOsiSymbol(p.instrument?.symbol);
        results.push(this._normalizeQuote(p, parsed, 'put'));
      }
    }

    console.log(`[Public] ${symbol} ${expirationDate}: ${results.length} contracts (${calls.length} calls, ${puts.length} puts)`);
    return results;
  }

  // ── Option Greeks ───────────────────────────────────────────────────

  /**
   * Get greeks for a list of OSI option symbols (max 250 per request).
   *
   * GET /userapigateway/option-details/{accountId}/greeks?osiSymbols[]=SYM1&osiSymbols[]=SYM2
   * Response: { greeks: [{ symbol: "...", greeks: { delta, gamma, theta, vega, rho, impliedVolatility } }] }
   * All greek values are returned as strings.
   *
   * @param {string[]} osiSymbols - e.g. ['SPY260212C00600000', ...]
   * @returns {Map<string, object>} Map of symbol → { delta, gamma, theta, vega, rho, impliedVolatility }
   */
  async getOptionGreeks(osiSymbols) {
    if (osiSymbols.length === 0) return new Map();

    const accountId = config.publicAccountId;
    const greeksMap = new Map();

    // Batch into chunks of 250 (API max)
    for (let i = 0; i < osiSymbols.length; i += 250) {
      const batch = osiSymbols.slice(i, i + 250);

      // Build query string with osiSymbols[] array params
      const queryParts = batch.map(s => `osiSymbols[]=${encodeURIComponent(s)}`);
      const queryString = queryParts.join('&');

      try {
        const data = await this._get(
          `/userapigateway/option-details/${accountId}/greeks?${queryString}`,
          15000
        );

        // Response: { greeks: [{ symbol: "...", greeks: { delta, gamma, ... } }] }
        const greeksList = data.greeks || [];
        for (const entry of greeksList) {
          const sym = entry.symbol || '';
          const g = entry.greeks || {};
          if (sym) {
            greeksMap.set(sym, {
              delta: parseFloat(g.delta) || 0,
              gamma: parseFloat(g.gamma) || 0,
              theta: parseFloat(g.theta) || 0,
              vega: parseFloat(g.vega) || 0,
              rho: parseFloat(g.rho) || 0,
              impliedVolatility: parseFloat(g.impliedVolatility) || 0,
            });
          }
        }
      } catch (err) {
        console.error(`[Public] Greeks batch error: ${err.message}`);
      }
    }

    console.log(`[Public] Fetched greeks for ${greeksMap.size}/${osiSymbols.length} contracts`);
    return greeksMap;
  }

  // ── Combined: Chain + Greeks ────────────────────────────────────────

  /**
   * Get option chain with greeks enriched — the primary method for the options engine.
   * Fetches the chain first, then batch-fetches greeks for all contracts.
   *
   * @param {string} symbol
   * @param {string} expirationDate
   * @param {string} [optionType]
   * @returns {object[]} Contracts with greeks populated
   */
  async getOptionsWithGreeks(symbol, expirationDate, optionType = null) {
    // Step 1: Get the chain (quotes)
    const contracts = await this.getOptionChain(symbol, expirationDate, optionType);
    if (contracts.length === 0) return contracts;

    // Step 2: Fetch greeks for all contracts
    const osiSymbols = contracts.map(c => c.symbol).filter(Boolean);
    const greeksMap = await this.getOptionGreeks(osiSymbols);

    // Step 3: Merge greeks into contracts
    let enriched = 0;
    for (const contract of contracts) {
      const greeks = greeksMap.get(contract.symbol);
      if (greeks) {
        contract.delta = greeks.delta;
        contract.gamma = greeks.gamma;
        contract.theta = greeks.theta;
        contract.vega = greeks.vega;
        contract.rho = greeks.rho;
        contract.impliedVolatility = greeks.impliedVolatility;
        enriched++;
      }
    }

    console.log(`[Public] ${symbol}: enriched ${enriched}/${contracts.length} contracts with greeks`);
    return contracts;
  }

  // ── Parsing / Normalization ─────────────────────────────────────────

  /**
   * Parse an OSI option symbol.
   * Format: SPY260212C00600000 → SPY, 2026-02-12, Call, $600.00
   */
  _parseOsiSymbol(symbol) {
    if (!symbol) return { underlying: '', expiration: '', type: 'unknown', strike: 0 };

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

  /**
   * Normalize a Public.com chain quote into the same shape as Alpaca's
   * _parseOptionSnapshot output, so the options engine can use either.
   */
  _normalizeQuote(quote, parsed, type) {
    return {
      symbol: quote.instrument?.symbol || '',
      ticker: parsed.underlying,
      strike: parsed.strike,
      expiration: parsed.expiration,
      type: type,
      openInterest: quote.openInterest ?? 0,
      volume: quote.volume ?? 0,
      lastPrice: parseFloat(quote.last) || 0,
      bid: parseFloat(quote.bid) || 0,
      ask: parseFloat(quote.ask) || 0,
      bidSize: quote.bidSize || 0,
      askSize: quote.askSize || 0,
      // Greeks will be populated by getOptionsWithGreeks()
      delta: 0,
      gamma: 0,
      theta: 0,
      vega: 0,
      rho: 0,
      impliedVolatility: 0,
      // Source tag
      _source: 'public',
    };
  }
}

// Singleton
module.exports = new PublicService();
