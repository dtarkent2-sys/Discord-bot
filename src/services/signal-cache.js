/**
 * Persistent Signal Cache — matching MAHORAGA reference architecture
 *
 * Stores evaluated trading signals so the agent doesn't re-evaluate
 * the same tickers repeatedly within a short timeframe.
 *
 * Each signal entry tracks:
 *   - The ticker and when it was evaluated
 *   - The AI decision (buy/pass) and confidence
 *   - Source data snapshot (sentiment score, net signal, etc.)
 *   - Staleness timestamp — signals expire and get re-evaluated
 *
 * Staleness rules:
 *   - BUY signals: valid for 30 min (market moves fast)
 *   - PASS signals: valid for 60 min (re-check less frequently)
 *   - Stale signals are automatically cleared
 */

const Storage = require('./storage');

const STALENESS = {
  buy: 30 * 60 * 1000,   // 30 minutes
  pass: 60 * 60 * 1000,  // 60 minutes
  skip: 15 * 60 * 1000,  // 15 minutes (filtered out early)
  error: 10 * 60 * 1000, // 10 minutes (retry sooner)
};

class SignalCache {
  constructor() {
    this._storage = new Storage('signal-cache.json');
    this._signals = this._storage.get('signals', {});

    // Clean stale signals on boot
    this._cleanStale();
  }

  /**
   * Check if a signal is cached and still fresh.
   * @param {string} symbol
   * @returns {{ cached: boolean, signal?: object }}
   */
  get(symbol) {
    const upper = symbol.toUpperCase();
    const entry = this._signals[upper];

    if (!entry) {
      return { cached: false };
    }

    // Check staleness
    const maxAge = STALENESS[entry.decision] || STALENESS.pass;
    if (Date.now() - entry.evaluatedAt > maxAge) {
      // Signal is stale — remove it
      delete this._signals[upper];
      this._persist();
      return { cached: false };
    }

    return { cached: true, signal: entry };
  }

  /**
   * Store an evaluated signal.
   * @param {string} symbol
   * @param {object} data
   * @param {string} data.decision - 'buy', 'pass', 'skip', or 'error'
   * @param {number} [data.confidence] - AI confidence 0-1
   * @param {string} [data.reason] - AI decision reason
   * @param {number} [data.sentimentScore] - social sentiment
   * @param {number} [data.netSignal] - technical net signal
   * @param {object} [data.macroRegime] - macro snapshot
   * @param {object} [data.sectorAlignment] - sector data
   */
  set(symbol, data) {
    const upper = symbol.toUpperCase();
    this._signals[upper] = {
      symbol: upper,
      decision: data.decision || 'pass',
      confidence: data.confidence || 0,
      reason: data.reason || '',
      sentimentScore: data.sentimentScore,
      netSignal: data.netSignal,
      macroRegime: data.macroRegime?.regime,
      sectorRank: data.sectorAlignment?.sectorRank,
      evaluatedAt: Date.now(),
    };
    this._persist();
  }

  /**
   * Mark a symbol as skipped (filtered out before AI evaluation).
   * @param {string} symbol
   * @param {string} reason
   */
  skip(symbol, reason) {
    this.set(symbol, { decision: 'skip', reason });
  }

  /**
   * Mark a symbol as errored.
   * @param {string} symbol
   * @param {string} error
   */
  error(symbol, error) {
    this.set(symbol, { decision: 'error', reason: error });
  }

  /**
   * Invalidate a specific symbol's cache.
   * @param {string} symbol
   */
  invalidate(symbol) {
    delete this._signals[symbol.toUpperCase()];
    this._persist();
  }

  /**
   * Clear all cached signals.
   */
  clear() {
    this._signals = {};
    this._persist();
  }

  /**
   * Get all cached signals (for display/debugging).
   * @returns {Array<object>}
   */
  getAll() {
    this._cleanStale();
    return Object.values(this._signals).sort((a, b) => b.evaluatedAt - a.evaluatedAt);
  }

  /**
   * Get cache stats.
   */
  getStats() {
    this._cleanStale();
    const signals = Object.values(this._signals);
    return {
      total: signals.length,
      buy: signals.filter(s => s.decision === 'buy').length,
      pass: signals.filter(s => s.decision === 'pass').length,
      skip: signals.filter(s => s.decision === 'skip').length,
      error: signals.filter(s => s.decision === 'error').length,
    };
  }

  _cleanStale() {
    const now = Date.now();
    let cleaned = 0;
    for (const [symbol, entry] of Object.entries(this._signals)) {
      const maxAge = STALENESS[entry.decision] || STALENESS.pass;
      if (now - entry.evaluatedAt > maxAge) {
        delete this._signals[symbol];
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this._persist();
    }
  }

  _persist() {
    this._storage.set('signals', this._signals);
  }
}

module.exports = new SignalCache();
