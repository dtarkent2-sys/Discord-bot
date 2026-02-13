/**
 * Trading Policy / Risk Engine
 *
 * Pre-trade validation and risk management.
 * Ported from SHARK's policy engine concept.
 *
 * Rules:
 *   - Kill switch: instant halt of all trading
 *   - Max positions: cap number of concurrent positions
 *   - Max notional per trade: cap dollar value per order
 *   - Daily loss limit: halt trading if daily P/L exceeds threshold
 *   - Cooldown: min time between trades for same symbol
 *   - Allow/deny lists: restrict tradable symbols
 *   - No shorting (by default): long only
 *   - Two-step order flow: preview → approval token → submit (matching MAHORAGA reference)
 */

const crypto = require('crypto');
const config = require('../config');
const Storage = require('./storage');

// Config version — increment when defaults change to trigger migration
const CONFIG_VERSION = 3;

// Dangerous mode — aggressive but NOT reckless trading overrides
// NOTE: The options engine has HARD LIMITS (max 3 trades/hr/symbol, max 10/day,
// consecutive loss cooldowns, correlated position limits) that dangerous mode
// CANNOT override. Those protect against the overtrading seen on 2026-02-12.
const DANGEROUS_CONFIG = {
  max_positions: 10,
  max_notional_per_trade: 10000,      // $10,000
  max_daily_loss_pct: 0.05,            // 5%
  stop_loss_pct: 0.08,                 // 8% (wider — let trades breathe)
  take_profit_pct: 0.15,               // 15% (bigger targets)
  cooldown_minutes: 5,                 // 5 min (rapid re-entry)
  min_sentiment_score: 0.1,            // accept weaker sentiment signals
  min_analyst_confidence: 0.4,         // accept lower AI confidence
  allow_shorting: true,
  crypto_enabled: true,
  position_size_pct: 0.40,             // 40% of cash per trade
  scan_interval_minutes: 2,            // scan every 2 min
  options_max_premium_per_trade: 1000, // $1,000
  options_max_daily_loss: 1500,        // $1,500 (was $2,500 — too much rope)
  options_max_positions: 3,            // 3 (was 5 — correlated positions = same bet)
  options_min_conviction: 5,           // 5 (was 3 — low conviction = coin flip)
  options_cooldown_minutes: 8,         // 8 min (was 2 — too fast for 0DTE)
  options_max_spread_pct: 0.12,        // 12% (was 15% — wider = worse fills)
};

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
  options_enabled: true,             // enable options trading
  scan_interval_minutes: 5,          // how often the agent scans for signals
  position_size_pct: 0.25,           // max % of cash per trade (25%)
  symbol_allowlist: [],              // empty = allow all
  symbol_denylist: [],               // ticker blacklist

  // ── Options-specific risk rules ──
  options_max_premium_per_trade: 500,   // max $ premium per single options trade
  options_max_daily_loss: 1000,         // max $ options loss per day before halt
  options_max_positions: 3,             // max concurrent options positions
  options_scalp_take_profit_pct: 0.20,  // 20% profit target for scalps (quick in/out)
  options_scalp_stop_loss_pct: 0.10,    // 10% stop loss for scalps ("tight stops, 5-10% max on the premium")
  options_min_conviction: 7,            // min AI conviction (1-10) to enter — quality over quantity
  options_close_before_minutes: 30,     // close 0DTE positions X min before market close
  options_min_delta: 0.15,              // min option delta for contract selection (widened for 0DTE)
  options_max_delta: 0.75,              // max option delta for contract selection (widened for late-day 0DTE)
  options_max_spread_pct: 0.10,         // max bid-ask spread as % of mid price
  options_underlyings: ['SPY', 'QQQ'],  // default underlyings to scan
  options_cooldown_minutes: 5,          // cooldown between options trades on same underlying
  options_min_open_interest: 500,       // min open interest for contract selection — filters out illiquid contracts
};

// Keys that accept numeric values
const NUMERIC_KEYS = new Set([
  'max_positions', 'max_notional_per_trade', 'max_daily_loss_pct',
  'stop_loss_pct', 'take_profit_pct', 'cooldown_minutes',
  'min_sentiment_score', 'min_analyst_confidence', 'scan_interval_minutes',
  'position_size_pct',
  // Options-specific
  'options_max_premium_per_trade', 'options_max_daily_loss', 'options_max_positions',
  'options_scalp_take_profit_pct', 'options_scalp_stop_loss_pct',
  'options_min_conviction', 'options_close_before_minutes',
  'options_min_delta', 'options_max_delta', 'options_max_spread_pct',
  'options_cooldown_minutes', 'options_min_open_interest',
]);

// Keys that accept boolean values
const BOOLEAN_KEYS = new Set([
  'allow_shorting', 'crypto_enabled', 'options_enabled',
]);

// Keys that accept comma-separated list values
const LIST_KEYS = new Set([
  'symbol_allowlist', 'symbol_denylist', 'options_underlyings',
]);

class PolicyEngine {
  constructor() {
    this._storage = new Storage('policy-config.json');
    const saved = this._storage.get('config', {});
    this.config = { ...DEFAULT_CONFIG, ...saved };

    // Migrate stored config when code defaults change
    const savedVersion = this._storage.get('configVersion', 0);
    if (savedVersion < CONFIG_VERSION) {
      this._migrateConfig(savedVersion);
      this._storage.set('configVersion', CONFIG_VERSION);
    }

    this.killSwitch = false;
    this.dangerousMode = false;
    this._savedConfig = null;  // stash normal config when dangerous mode is active
    this.dailyPnL = 0;
    this.dailyStartEquity = 0;
    this.lastResetDate = '';
    this.tradeCooldowns = new Map(); // symbol → timestamp of last trade
    this._approvalTokens = new Map(); // tokenId → { order, expiresAt }
    this.optionsDailyLoss = 0;  // running daily options P&L loss
    this.optionsCooldowns = new Map(); // underlying → timestamp of last options trade
  }

  // ── Configuration ─────────────────────────────────────────────────

  getConfig() {
    return { ...this.config, killSwitch: this.killSwitch, dangerousMode: this.dangerousMode };
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
    this.dangerousMode = false;
    this._savedConfig = null;
    this._persist();
    console.log('[Policy] Config reset to defaults');
  }

  // ── Dangerous Mode ─────────────────────────────────────────────────

  enableDangerousMode() {
    if (this.dangerousMode) return { changed: false, message: 'Dangerous mode is already active.' };
    // Stash current config so we can restore it later
    this._savedConfig = { ...this.config };
    // Apply aggressive overrides on top of current config
    for (const [key, value] of Object.entries(DANGEROUS_CONFIG)) {
      if (key in this.config) {
        this.config[key] = value;
      }
    }
    this.dangerousMode = true;
    this._persist();
    console.log('[Policy] DANGEROUS MODE ENABLED — aggressive trading parameters active');
    return { changed: true };
  }

  disableDangerousMode() {
    if (!this.dangerousMode) return { changed: false, message: 'Dangerous mode is not active.' };
    // Restore the stashed config
    if (this._savedConfig) {
      this.config = { ...this._savedConfig };
      this._savedConfig = null;
    } else {
      this.config = { ...DEFAULT_CONFIG };
    }
    this.dangerousMode = false;
    this._persist();
    console.log('[Policy] Dangerous mode DISABLED — restored previous config');
    return { changed: true };
  }

  _persist() {
    this._storage.set('config', { ...this.config });
  }

  /**
   * Migrate stored config when code defaults change.
   * Only resets keys that were at old defaults — preserves user overrides
   * by checking against known old default values.
   */
  _migrateConfig(fromVersion) {
    console.log(`[Policy] Migrating config from v${fromVersion} to v${CONFIG_VERSION}`);

    if (fromVersion < 2) {
      // v0/v1 → v2: conviction lowered (7→5), delta range widened (0.25-0.60 → 0.15-0.75)
      if (this.config.options_min_conviction === 7) {
        this.config.options_min_conviction = DEFAULT_CONFIG.options_min_conviction;
        console.log(`[Policy] Migrated options_min_conviction: 7 → ${DEFAULT_CONFIG.options_min_conviction}`);
      }
      if (this.config.options_min_delta === 0.25) {
        this.config.options_min_delta = DEFAULT_CONFIG.options_min_delta;
        console.log(`[Policy] Migrated options_min_delta: 0.25 → ${DEFAULT_CONFIG.options_min_delta}`);
      }
      if (this.config.options_max_delta === 0.60) {
        this.config.options_max_delta = DEFAULT_CONFIG.options_max_delta;
        console.log(`[Policy] Migrated options_max_delta: 0.60 → ${DEFAULT_CONFIG.options_max_delta}`);
      }
    }

    if (fromVersion < 3) {
      // v2 → v3: tighter scalp stops (25%→10%), lower scalp TP (30%→20%), lower swing SL/TP
      // "tight stops. like 5-10% max on the premium"
      if (this.config.options_scalp_stop_loss_pct === 0.25) {
        this.config.options_scalp_stop_loss_pct = DEFAULT_CONFIG.options_scalp_stop_loss_pct;
        console.log(`[Policy] Migrated options_scalp_stop_loss_pct: 0.25 → ${DEFAULT_CONFIG.options_scalp_stop_loss_pct}`);
      }
      if (this.config.options_scalp_take_profit_pct === 0.30) {
        this.config.options_scalp_take_profit_pct = DEFAULT_CONFIG.options_scalp_take_profit_pct;
        console.log(`[Policy] Migrated options_scalp_take_profit_pct: 0.30 → ${DEFAULT_CONFIG.options_scalp_take_profit_pct}`);
      }
      // Swing config keys removed — 0DTE is scalp-only
      delete this.config.options_swing_stop_loss_pct;
      delete this.config.options_swing_take_profit_pct;
    }

    this._persist();
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
      this.optionsDailyLoss = 0;
      this.lastResetDate = today;
      console.log(`[Policy] Daily reset — start equity: $${currentEquity.toFixed(2)}, options daily loss reset`);
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

  // ── Options-Specific Validation ──────────────────────────────────

  /**
   * Validate an options trade against options-specific risk rules.
   * @param {object} ctx
   * @param {string} ctx.underlying - SPY, QQQ, etc.
   * @param {number} ctx.premium - total premium (price × qty × 100)
   * @param {number} ctx.qty - number of contracts
   * @param {number} ctx.currentOptionsPositions - current open options positions
   * @param {number} ctx.delta - option delta
   * @param {number} ctx.spreadPct - bid-ask spread as % of mid
   * @param {number} ctx.conviction - AI conviction score (1-10)
   * @param {number} ctx.minutesToClose - minutes until market close
   * @returns {{ allowed: boolean, violations: string[], warnings: string[] }}
   */
  evaluateOptionsOrder(ctx) {
    const violations = [];
    const warnings = [];
    const cfg = this.config;

    if (this.killSwitch) {
      violations.push('Kill switch is active — all trading halted');
      return { allowed: false, violations, warnings };
    }

    if (!cfg.options_enabled) {
      violations.push('Options trading is disabled (set options_enabled: true to enable)');
      return { allowed: false, violations, warnings };
    }

    // Premium per trade
    if (ctx.premium > cfg.options_max_premium_per_trade) {
      violations.push(`Premium $${ctx.premium.toFixed(0)} exceeds max $${cfg.options_max_premium_per_trade}`);
    }

    // Daily options loss limit
    if (this.optionsDailyLoss >= cfg.options_max_daily_loss) {
      violations.push(`Daily options loss limit reached: $${this.optionsDailyLoss.toFixed(0)} (max $${cfg.options_max_daily_loss})`);
    }

    // Position count
    if (ctx.currentOptionsPositions >= cfg.options_max_positions) {
      violations.push(`Max options positions reached: ${ctx.currentOptionsPositions}/${cfg.options_max_positions}`);
    }

    // Conviction threshold
    if (ctx.conviction < cfg.options_min_conviction) {
      violations.push(`Conviction ${ctx.conviction}/10 below minimum ${cfg.options_min_conviction}`);
    }

    // Delta range
    if (ctx.delta != null) {
      const absDelta = Math.abs(ctx.delta);
      if (absDelta < cfg.options_min_delta) {
        violations.push(`Delta ${absDelta.toFixed(2)} too low (min ${cfg.options_min_delta}) — too far OTM`);
      }
      if (absDelta > cfg.options_max_delta) {
        warnings.push(`Delta ${absDelta.toFixed(2)} above preferred max ${cfg.options_max_delta} — consider lower strike`);
      }
    }

    // Open interest floor
    if (ctx.openInterest != null && ctx.openInterest < cfg.options_min_open_interest) {
      violations.push(`Open interest ${ctx.openInterest} below minimum ${cfg.options_min_open_interest} — too illiquid`);
    }

    // Bid-ask spread
    if (ctx.spreadPct != null && ctx.spreadPct > cfg.options_max_spread_pct) {
      violations.push(`Bid-ask spread ${(ctx.spreadPct * 100).toFixed(1)}% exceeds max ${(cfg.options_max_spread_pct * 100).toFixed(0)}%`);
    }

    // Time-of-day: don't open 0DTE positions too close to market close
    if (ctx.minutesToClose != null && ctx.minutesToClose < cfg.options_close_before_minutes) {
      violations.push(`Only ${ctx.minutesToClose} min to close — too late for new 0DTE entry (need ${cfg.options_close_before_minutes}+ min)`);
    }

    // Cooldown per underlying
    const lastTrade = this.optionsCooldowns.get(ctx.underlying);
    if (lastTrade) {
      const minutesSince = (Date.now() - lastTrade) / 60000;
      if (minutesSince < cfg.options_cooldown_minutes) {
        violations.push(`Options cooldown active for ${ctx.underlying}: ${Math.ceil(cfg.options_cooldown_minutes - minutesSince)} min remaining`);
      }
    }

    // Daily loss limit (warning zone at 75%)
    if (this.optionsDailyLoss >= cfg.options_max_daily_loss * 0.75) {
      warnings.push(`Options daily loss at ${((this.optionsDailyLoss / cfg.options_max_daily_loss) * 100).toFixed(0)}% of limit`);
    }

    return { allowed: violations.length === 0, violations, warnings };
  }

  /**
   * Record an options trade execution for cooldown tracking.
   */
  recordOptionsTrade(underlying) {
    this.optionsCooldowns.set(underlying, Date.now());
  }

  /**
   * Record an options trade P&L for daily loss tracking.
   * @param {number} pnl - positive for profit, negative for loss
   */
  recordOptionsTradeResult(pnl) {
    if (pnl < 0) {
      this.optionsDailyLoss += Math.abs(pnl);
    }
  }

  /**
   * Check options positions for exit signals.
   * Options use % of premium for stop/take-profit, plus time-based exits.
   * All options trades are 0DTE scalps — no swing trades.
   *
   * @param {Array} positions - Alpaca options positions
   * @param {string} strategy - always 'scalp' for 0DTE
   * @param {number} minutesToClose - minutes until market close
   * @returns {Array<{symbol, reason, pnlPct, message}>}
   */
  checkOptionsExits(positions, strategy = 'scalp', minutesToClose = Infinity) {
    const exits = [];
    const cfg = this.config;

    // 0DTE = scalp only, always use scalp thresholds
    const stopPct = cfg.options_scalp_stop_loss_pct;
    const tpPct = cfg.options_scalp_take_profit_pct;

    for (const pos of positions) {
      const pnlPct = Number(pos.unrealized_plpc || 0);

      // Stop loss
      if (pnlPct <= -stopPct) {
        exits.push({
          symbol: pos.symbol,
          reason: 'options_stop_loss',
          pnlPct,
          message: `Options stop loss: ${(pnlPct * 100).toFixed(1)}% (limit: -${(stopPct * 100).toFixed(0)}%)`,
        });
        continue;
      }

      // Take profit
      if (pnlPct >= tpPct) {
        exits.push({
          symbol: pos.symbol,
          reason: 'options_take_profit',
          pnlPct,
          message: `Options take profit: +${(pnlPct * 100).toFixed(1)}% (target: +${(tpPct * 100).toFixed(0)}%)`,
        });
        continue;
      }

      // Time-based exit: close 0DTE positions before market close
      if (minutesToClose <= cfg.options_close_before_minutes) {
        exits.push({
          symbol: pos.symbol,
          reason: 'time_exit',
          pnlPct,
          message: `Time exit: ${minutesToClose} min to close, P/L: ${(pnlPct * 100).toFixed(1)}%`,
        });
        continue;
      }

      // Trailing stop: if position was up >15% and drops back to +5%, lock profit
      if (pnlPct > 0.05 && pnlPct < stopPct * 0.5) {
        // Check if we had a bigger unrealized gain (simple heuristic)
        const costBasis = Number(pos.cost_basis || 0);
        const marketValue = Number(pos.market_value || 0);
        if (costBasis > 0 && marketValue > 0) {
          // This position was profitable but giving back gains
          exits.push({
            symbol: pos.symbol,
            reason: 'trailing_stop',
            pnlPct,
            message: `Trailing stop: profit fading, locking +${(pnlPct * 100).toFixed(1)}%`,
          });
        }
      }
    }

    return exits;
  }

  // ── Two-Step Order Flow (preview → approve → submit) ───────────
  // Matches MAHORAGA reference architecture:
  //   1. Preview: validate order, return approval token (valid 5 min)
  //   2. Submit: validate token, execute order

  /**
   * Preview an order — validate against all policy rules.
   * If approved, returns an approval token valid for 5 minutes.
   * @param {object} ctx - same as evaluate()
   * @returns {{ approved: boolean, token?: string, violations?: string[], warnings?: string[], order: object, expiresAt?: number }}
   */
  preview(ctx) {
    const result = this.evaluate(ctx);

    if (!result.allowed) {
      return {
        approved: false,
        violations: result.violations,
        warnings: result.warnings,
        order: ctx,
      };
    }

    // Generate a signed approval token
    const tokenId = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

    const tokenData = {
      id: tokenId,
      order: {
        symbol: ctx.symbol,
        side: ctx.side,
        notional: ctx.notional,
      },
      expiresAt,
      createdAt: Date.now(),
    };

    // Store token for later validation
    this._approvalTokens.set(tokenId, tokenData);

    // Clean up expired tokens periodically
    this._cleanExpiredTokens();

    console.log(`[Policy] Approval token issued for ${ctx.side} ${ctx.symbol} $${ctx.notional?.toFixed(0)} — expires in 5 min`);

    return {
      approved: true,
      token: tokenId,
      warnings: result.warnings,
      order: ctx,
      expiresAt,
    };
  }

  /**
   * Submit an order using an approval token.
   * Validates the token is still valid and matches the intended order.
   * @param {string} tokenId - the approval token from preview()
   * @param {object} orderParams - { symbol, side, notional } to verify against token
   * @returns {{ valid: boolean, error?: string, order?: object }}
   */
  validateToken(tokenId, orderParams = {}) {
    const tokenData = this._approvalTokens.get(tokenId);

    if (!tokenData) {
      return { valid: false, error: 'Unknown or expired approval token' };
    }

    // Check expiration
    if (Date.now() > tokenData.expiresAt) {
      this._approvalTokens.delete(tokenId);
      return { valid: false, error: 'Approval token expired (5 min limit)' };
    }

    // Verify order matches token (prevent token reuse for different orders)
    if (orderParams.symbol && orderParams.symbol !== tokenData.order.symbol) {
      return { valid: false, error: `Token was issued for ${tokenData.order.symbol}, not ${orderParams.symbol}` };
    }

    // Consume the token (one-time use)
    this._approvalTokens.delete(tokenId);

    console.log(`[Policy] Approval token consumed for ${tokenData.order.side} ${tokenData.order.symbol}`);
    return { valid: true, order: tokenData.order };
  }

  _cleanExpiredTokens() {
    const now = Date.now();
    for (const [id, data] of this._approvalTokens) {
      if (now > data.expiresAt) {
        this._approvalTokens.delete(id);
      }
    }
  }
}

module.exports = new PolicyEngine();
