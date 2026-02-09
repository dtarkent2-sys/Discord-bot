/**
 * Circuit Breaker — Automatic trading pause after consecutive bad outcomes.
 *
 * Tracks consecutive stop-loss exits (bad trades). If >= threshold (default 3)
 * consecutive bad trades occur, trading agents are paused for a cooldown period
 * (default 1 hour).
 *
 * Also tracks consecutive cycle errors to detect systemic issues.
 *
 * State persists across restarts via storage.
 */

const Storage = require('./storage');
const auditLog = require('./audit-log');

const DEFAULT_BAD_TRADE_THRESHOLD = 3;
const DEFAULT_PAUSE_DURATION_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_ERROR_THRESHOLD = 5;

class CircuitBreaker {
  constructor() {
    this._storage = new Storage('circuit-breaker.json');
    const saved = this._storage.get('state', {});

    this.state = {
      consecutiveBadTrades: saved.consecutiveBadTrades || 0,
      consecutiveErrors: saved.consecutiveErrors || 0,
      pausedUntil: saved.pausedUntil || 0,
      totalBadTrades: saved.totalBadTrades || 0,
      totalTrips: saved.totalTrips || 0,
      lastBadTrade: saved.lastBadTrade || null,
      lastTrip: saved.lastTrip || null,
      recentExits: saved.recentExits || [], // last 20 exits for analysis
    };

    // Check if we were paused before restart
    if (this.isPaused()) {
      const remaining = Math.ceil((this.state.pausedUntil - Date.now()) / 60000);
      console.log(`[CircuitBreaker] Trading paused — ${remaining} min remaining`);
    }
  }

  /**
   * Check if trading is currently paused by the circuit breaker.
   * Auto-resets if the pause period has elapsed.
   * @returns {boolean}
   */
  isPaused() {
    if (this.state.pausedUntil <= 0) return false;

    if (Date.now() >= this.state.pausedUntil) {
      // Pause expired — auto-reset
      this._reset();
      return false;
    }

    return true;
  }

  /**
   * Get remaining pause time in minutes (0 if not paused).
   * @returns {number}
   */
  remainingPauseMinutes() {
    if (!this.isPaused()) return 0;
    return Math.ceil((this.state.pausedUntil - Date.now()) / 60000);
  }

  /**
   * Record a trade exit. Tracks consecutive bad trades.
   * @param {string} symbol
   * @param {string} reason - 'stop_loss', 'take_profit', or 'manual'
   * @param {number} pnlPct - Unrealized P&L percentage at exit
   * @returns {{ tripped: boolean, message?: string }}
   */
  recordExit(symbol, reason, pnlPct) {
    const exit = {
      symbol,
      reason,
      pnlPct,
      timestamp: new Date().toISOString(),
    };

    // Track recent exits
    this.state.recentExits.push(exit);
    if (this.state.recentExits.length > 20) {
      this.state.recentExits = this.state.recentExits.slice(-20);
    }

    if (reason === 'stop_loss') {
      this.state.consecutiveBadTrades++;
      this.state.totalBadTrades++;
      this.state.lastBadTrade = exit;

      auditLog.log('circuit_breaker', `Bad trade recorded: ${symbol} stop-loss (${this.state.consecutiveBadTrades}/${DEFAULT_BAD_TRADE_THRESHOLD} consecutive)`, { symbol, pnlPct });

      if (this.state.consecutiveBadTrades >= DEFAULT_BAD_TRADE_THRESHOLD) {
        return this._trip(`${this.state.consecutiveBadTrades} consecutive stop-loss exits`);
      }
    } else if (reason === 'take_profit') {
      // Good trade resets the consecutive counter
      this.state.consecutiveBadTrades = 0;
      auditLog.log('circuit_breaker', `Good trade: ${symbol} take-profit — consecutive bad trades reset`, { symbol, pnlPct });
    }

    this._persist();
    return { tripped: false };
  }

  /**
   * Record a cycle-level error (API failure, etc).
   * @param {string} message
   * @returns {{ tripped: boolean, message?: string }}
   */
  recordError(message) {
    this.state.consecutiveErrors++;

    if (this.state.consecutiveErrors >= DEFAULT_ERROR_THRESHOLD) {
      return this._trip(`${this.state.consecutiveErrors} consecutive cycle errors: ${message}`);
    }

    this._persist();
    return { tripped: false };
  }

  /**
   * Reset error counter on successful cycle.
   */
  recordSuccessfulCycle() {
    if (this.state.consecutiveErrors > 0) {
      this.state.consecutiveErrors = 0;
      this._persist();
    }
  }

  /**
   * Manually reset the circuit breaker (e.g. after operator review).
   */
  manualReset() {
    this._reset();
    auditLog.log('circuit_breaker', 'Circuit breaker manually reset');
  }

  /**
   * Get current circuit breaker state for display.
   */
  getStatus() {
    return {
      paused: this.isPaused(),
      remainingMinutes: this.remainingPauseMinutes(),
      consecutiveBadTrades: this.state.consecutiveBadTrades,
      consecutiveErrors: this.state.consecutiveErrors,
      totalBadTrades: this.state.totalBadTrades,
      totalTrips: this.state.totalTrips,
      lastBadTrade: this.state.lastBadTrade,
      lastTrip: this.state.lastTrip,
      recentExits: this.state.recentExits.slice(-5),
      thresholds: {
        badTrades: DEFAULT_BAD_TRADE_THRESHOLD,
        errors: DEFAULT_ERROR_THRESHOLD,
        pauseDurationMinutes: DEFAULT_PAUSE_DURATION_MS / 60000,
      },
    };
  }

  // ── Internal ──────────────────────────────────────────────────────

  _trip(reason) {
    this.state.pausedUntil = Date.now() + DEFAULT_PAUSE_DURATION_MS;
    this.state.totalTrips++;
    this.state.lastTrip = {
      reason,
      timestamp: new Date().toISOString(),
      pausedUntil: new Date(this.state.pausedUntil).toISOString(),
    };

    this._persist();

    const msg = `CIRCUIT BREAKER TRIPPED: ${reason} — trading paused for ${DEFAULT_PAUSE_DURATION_MS / 60000} minutes`;
    auditLog.log('circuit_breaker', msg, { reason, pausedUntil: this.state.pausedUntil });
    console.warn(`[CircuitBreaker] ${msg}`);

    return { tripped: true, message: msg };
  }

  _reset() {
    this.state.consecutiveBadTrades = 0;
    this.state.consecutiveErrors = 0;
    this.state.pausedUntil = 0;
    this._persist();
    console.log('[CircuitBreaker] Reset — trading resumed');
  }

  _persist() {
    this._storage.set('state', { ...this.state });
  }
}

module.exports = new CircuitBreaker();
