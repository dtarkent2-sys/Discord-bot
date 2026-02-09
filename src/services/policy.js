/**
 * Trading Policy / Risk Engine
 *
 * Pre-trade validation and risk management.
 * Ported from MAHORAGA's policy engine concept.
 *
 * Rules:
 *   - Kill switch: instant halt of all trading
 *   - Max positions: cap number of concurrent positions
 *   - Max notional per trade: cap dollar value per order
 *   - Daily loss limit: halt trading if daily P/L exceeds threshold
 *   - Cooldown: min time between trades for same symbol
 *   - Allow/deny lists: restrict tradable symbols
 *   - No shorting (by default): long only
 */

const config = require('../config');
const Storage = require('./storage');

// Default configuration — tunable via /agent set or runtime
const DEFAULT_CONFIG = {
  max_positions: 5,
  max_notional_per_trade: 5000,    // $5,000
  max_daily_loss_pct: 0.02,         // 2%
  stop_loss_pct: 0.05,              // 5%
  take_profit_pct: 0.10,            // 10%
  cooldown_minutes: 30,
  min_sentiment_score: 0.3,         // -1 to +1 scale
  min_analyst_confidence: 0.6,      // 0 to 1 scale
  allow_shorting: false,
  crypto_enabled: false,             // enable 24/7 crypto trading
  options_enabled: false,            // enable options trading
  scan_interval_minutes: 5,          // how often the agent scans for signals
  position_size_pct: 0.25,           // max % of cash per trade (25%)
  symbol_allowlist: [],              // empty = allow all
  symbol_denylist: [],               // ticker blacklist
};

// Keys that accept numeric values
const NUMERIC_KEYS = new Set([
  'max_positions', 'max_notional_per_trade', 'max_daily_loss_pct',
  'stop_loss_pct', 'take_profit_pct', 'cooldown_minutes',
  'min_sentiment_score', 'min_analyst_confidence', 'scan_interval_minutes',
  'position_size_pct',
]);

// Keys that accept boolean values
const BOOLEAN_KEYS = new Set([
  'allow_shorting', 'crypto_enabled', 'options_enabled',
]);

// Keys that accept comma-separated list values
const LIST_KEYS = new Set([
  'symbol_allowlist', 'symbol_denylist',
]);

class PolicyEngine {
  constructor() {
    this._storage = new Storage('policy-config.json');
    const saved = this._storage.get('config', {});
    this.config = { ...DEFAULT_CONFIG, ...saved };
    this.killSwitch = false;
    this.dailyPnL = 0;
    this.dailyStartEquity = 0;
    this.lastResetDate = '';
    this.tradeCooldowns = new Map(); // symbol → timestamp of last trade
  }

  // ── Configuration ─────────────────────────────────────────────────

  getConfig() {
    return { ...this.config, killSwitch: this.killSwitch };
  }

  getDefaultConfig() {
    return { ...DEFAULT_CONFIG };
  }

  getConfigKeyInfo() {
    return { NUMERIC_KEYS, BOOLEAN_KEYS, LIST_KEYS };
  }

  /**
   * Set a single config key to a new value.
   * Validates the key exists and coerces the value to the correct type.
   * @returns {{ success: boolean, key?: string, value?: any, error?: string }}
   */
  setConfigKey(key, rawValue) {
    if (!(key in DEFAULT_CONFIG)) {
      const validKeys = Object.keys(DEFAULT_CONFIG).join(', ');
      return { success: false, error: `Unknown key \`${key}\`. Valid keys: ${validKeys}` };
    }

    let value;

    if (NUMERIC_KEYS.has(key)) {
      value = Number(rawValue);
      if (isNaN(value)) {
        return { success: false, error: `\`${key}\` requires a number. Got: \`${rawValue}\`` };
      }
      // Validate ranges
      if (key.includes('pct') && (value < 0 || value > 1)) {
        return { success: false, error: `\`${key}\` must be between 0 and 1 (e.g. 0.05 for 5%). Got: \`${value}\`` };
      }
      if (key === 'max_positions' && (value < 1 || value > 50)) {
        return { success: false, error: `\`max_positions\` must be between 1 and 50. Got: \`${value}\`` };
      }
      if (key === 'max_notional_per_trade' && value < 10) {
        return { success: false, error: `\`max_notional_per_trade\` must be at least $10. Got: \`${value}\`` };
      }
      if (key === 'cooldown_minutes' && (value < 0 || value > 1440)) {
        return { success: false, error: `\`cooldown_minutes\` must be 0–1440. Got: \`${value}\`` };
      }
      if (key === 'scan_interval_minutes' && (value < 1 || value > 60)) {
        return { success: false, error: `\`scan_interval_minutes\` must be 1–60. Got: \`${value}\`` };
      }
    } else if (BOOLEAN_KEYS.has(key)) {
      const lower = String(rawValue).toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(lower)) value = true;
      else if (['false', '0', 'no', 'off'].includes(lower)) value = false;
      else return { success: false, error: `\`${key}\` requires true/false. Got: \`${rawValue}\`` };
    } else if (LIST_KEYS.has(key)) {
      value = String(rawValue).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    } else {
      value = rawValue;
    }

    this.config[key] = value;
    this._persist();
    console.log(`[Policy] Config set: ${key} = ${JSON.stringify(value)}`);
    return { success: true, key, value };
  }

  updateConfig(updates) {
    for (const [key, value] of Object.entries(updates)) {
      if (key in this.config) {
        this.config[key] = value;
      }
    }
    this._persist();
    console.log('[Policy] Config updated:', JSON.stringify(updates));
  }

  resetConfig() {
    this.config = { ...DEFAULT_CONFIG };
    this._persist();
    console.log('[Policy] Config reset to defaults');
  }

  _persist() {
    this._storage.set('config', { ...this.config });
  }

  // ── Kill Switch ───────────────────────────────────────────────────

  activateKillSwitch() {
    this.killSwitch = true;
    console.log('[Policy] KILL SWITCH ACTIVATED');
  }

  deactivateKillSwitch() {
    this.killSwitch = false;
    console.log('[Policy] Kill switch deactivated');
  }

  // ── Daily Reset ───────────────────────────────────────────────────

  resetDaily(currentEquity) {
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastResetDate !== today) {
      this.dailyPnL = 0;
      this.dailyStartEquity = currentEquity;
      this.lastResetDate = today;
      console.log(`[Policy] Daily reset — start equity: $${currentEquity.toFixed(2)}`);
    }
  }

  updateDailyPnL(currentEquity) {
    if (this.dailyStartEquity > 0) {
      this.dailyPnL = currentEquity - this.dailyStartEquity;
    }
  }

  // ── Pre-Trade Validation ──────────────────────────────────────────

  /**
   * Evaluate whether a trade should be allowed.
   * @param {object} ctx
   * @param {string} ctx.symbol
   * @param {string} ctx.side - 'buy' or 'sell'
   * @param {number} ctx.notional - dollar amount
   * @param {number} ctx.currentPositions - number of open positions
   * @param {number} ctx.currentEquity - account equity
   * @param {number} [ctx.sentimentScore] - from StockTwits (-1 to +1)
   * @param {number} [ctx.confidence] - AI confidence (0 to 1)
   * @returns {{ allowed: boolean, violations: string[], warnings: string[] }}
   */
  evaluate(ctx) {
    const violations = [];
    const warnings = [];

    // Kill switch
    if (this.killSwitch) {
      violations.push('Kill switch is active — all trading halted');
      return { allowed: false, violations, warnings };
    }

    // Daily loss limit
    if (this.dailyStartEquity > 0) {
      const dailyLossPct = -this.dailyPnL / this.dailyStartEquity;
      if (dailyLossPct >= this.config.max_daily_loss_pct) {
        violations.push(`Daily loss limit reached: ${(dailyLossPct * 100).toFixed(1)}% (max ${(this.config.max_daily_loss_pct * 100).toFixed(1)}%)`);
      }
    }

    // Position count
    if (ctx.side === 'buy' && ctx.currentPositions >= this.config.max_positions) {
      violations.push(`Max positions reached: ${ctx.currentPositions}/${this.config.max_positions}`);
    }

    // Notional size
    if (ctx.notional > this.config.max_notional_per_trade) {
      violations.push(`Order exceeds max notional: $${ctx.notional.toFixed(0)} > $${this.config.max_notional_per_trade}`);
    }

    // Buying power check
    if (ctx.side === 'buy' && ctx.notional > (ctx.buyingPower || Infinity)) {
      violations.push(`Insufficient buying power: need $${ctx.notional.toFixed(0)}, have $${(ctx.buyingPower || 0).toFixed(0)}`);
    }

    // No shorting
    if (ctx.side === 'sell' && !this.config.allow_shorting) {
      // Only block if it's an opening short, not closing a long
      if (!ctx.isClosing) {
        violations.push('Shorting is not allowed (set allow_shorting: true to enable)');
      }
    }

    // Symbol deny list
    if (this.config.symbol_denylist.length > 0 && this.config.symbol_denylist.includes(ctx.symbol)) {
      violations.push(`${ctx.symbol} is on the deny list`);
    }

    // Symbol allow list
    if (this.config.symbol_allowlist.length > 0 && !this.config.symbol_allowlist.includes(ctx.symbol)) {
      violations.push(`${ctx.symbol} is not on the allow list`);
    }

    // Cooldown
    const lastTrade = this.tradeCooldowns.get(ctx.symbol);
    if (lastTrade) {
      const minutesSince = (Date.now() - lastTrade) / 60000;
      if (minutesSince < this.config.cooldown_minutes) {
        violations.push(`Cooldown active for ${ctx.symbol}: ${Math.ceil(this.config.cooldown_minutes - minutesSince)} min remaining`);
      }
    }

    // Sentiment check (warning only, not blocking)
    if (ctx.sentimentScore !== undefined && Math.abs(ctx.sentimentScore) < this.config.min_sentiment_score) {
      warnings.push(`Weak sentiment signal: ${(ctx.sentimentScore * 100).toFixed(0)}% (threshold: ${(this.config.min_sentiment_score * 100).toFixed(0)}%)`);
    }

    // Confidence check (warning only)
    if (ctx.confidence !== undefined && ctx.confidence < this.config.min_analyst_confidence) {
      warnings.push(`Low AI confidence: ${(ctx.confidence * 100).toFixed(0)}% (threshold: ${(this.config.min_analyst_confidence * 100).toFixed(0)}%)`);
    }

    return {
      allowed: violations.length === 0,
      violations,
      warnings,
    };
  }

  // ── Post-Trade ────────────────────────────────────────────────────

  recordTrade(symbol) {
    this.tradeCooldowns.set(symbol, Date.now());
  }

  /**
   * Check positions against stop-loss and take-profit levels.
   * Returns list of positions that should be closed.
   */
  checkExits(positions) {
    const exits = [];

    for (const pos of positions) {
      const pnlPct = Number(pos.unrealized_plpc || 0);

      if (pnlPct <= -this.config.stop_loss_pct) {
        exits.push({
          symbol: pos.symbol,
          reason: 'stop_loss',
          pnlPct,
          message: `Stop loss triggered: ${(pnlPct * 100).toFixed(1)}% (limit: -${(this.config.stop_loss_pct * 100).toFixed(0)}%)`,
        });
      } else if (pnlPct >= this.config.take_profit_pct) {
        exits.push({
          symbol: pos.symbol,
          reason: 'take_profit',
          pnlPct,
          message: `Take profit triggered: +${(pnlPct * 100).toFixed(1)}% (target: +${(this.config.take_profit_pct * 100).toFixed(0)}%)`,
        });
      }
    }

    return exits;
  }
}

module.exports = new PolicyEngine();
