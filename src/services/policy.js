"use strict";
class PolicyEngine {
  constructor() {
    this._storage = new Storage("policy-config.json");
    const saved = this._storage.get("config", {});
    this.config = { ...DEFAULT_CONFIG, ...saved };

    const savedVersion = this._storage.get("configVersion", 0);
    if (savedVersion < CONFIG_VERSION) {
      this._migrateConfig(savedVersion);
      this._storage.set("configVersion", CONFIG_VERSION);
    }

    this.killSwitch = false;
    this.dangerousMode = false;
    this._savedConfig = null;
    this.dailyPnL = 0;
    this.dailyStartEquity = 0;
    this.lastResetDate = "";
    this.tradeCooldowns = new Map();
    this._approvalTokens = new Map();
    this.optionsDailyLoss = 0;
    this.optionsCooldowns = new Map();
  }

  getConfig() {
    return { ...this.config, killSwitch: this.killSwitch, dangerousMode: this.dangerousMode };
  }

  getDefaultConfig() {
    return { ...DEFAULT_CONFIG };
  }

  getConfigKeyInfo() {
    return { NUMERIC_KEYS, BOOLEAN_KEYS, LIST_KEYS };
  }

  setConfigKey(key, rawValue) {
    if (!(key in DEFAULT_CONFIG)) {
      const validKeys = Object.keys(DEFAULT_CONFIG).join(", ");
      return { success: false, error: `Unknown key \`${key}\`. Valid keys: ${validKeys}` };
    }

    let value;

    if (NUMERIC_KEYS.has(key)) {
      const num = Number(rawValue);
      if (isNaN(num)) {
        return { success: false, error: `\`${key}\` requires a number. Got: \`${rawValue}\`` };
      }
      if (key.includes("pct") && (num < 0 || num > 1)) {
        return { success: false, error: `\`${key}\` must be between 0 and 1. Got: \`${num}\`` };
      }
      if (key === "max_positions" && (num < 1 || num > 50)) {
        return { success: false, error: `\`max_positions\` must be between 1 and 50. Got: \`${num}\`` };
      }
      if (key === "max_notional_per_trade" && num < 10) {
        return { success: false, error: `\`max_notional_per_trade\` must be at least 10. Got: \`${num}\`` };
      }
      if (key === "cooldown_minutes" && (num < 0 || num > 1440)) {
        return { success: false, error: `\`cooldown_minutes\` must be between 0 and 1440. Got: \`${num}\`` };
      }
      if (key === "scan_interval_minutes" && (num < 1 || num > 60)) {
        return { success: false, error: `\`scan_interval_minutes\` must be between 1 and 60. Got: \`${num}\`` };
      }
      value = num;
    } else if (BOOLEAN_KEYS.has(key)) {
      const lower = String(rawValue).toLowerCase();
      if (["true", "1", "yes", "on"].includes(lower)) value = true;
      else if (["false", "0", "no", "off"].includes(lower)) value = false;
      else return { success: false, error: `\`${key}\` requires true/false. Got: \`${rawValue}\`` };
    } else if (LIST_KEYS.has(key)) {
      value = String(rawValue).split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
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
    console.log("[Policy] Config updated:", JSON.stringify(updates));
  }

  resetConfig() {
    this.config = { ...DEFAULT_CONFIG };
    this.dangerousMode = false;
    this._savedConfig = null;
    this._persist();
    console.log("[Policy] Config reset to defaults");
  }

  enableDangerousMode() {
    if (this.dangerousMode) return { changed: false, message: "Dangerous mode is already active." };
    this._savedConfig = { ...this.config };
    for (const [k, v] of Object.entries(DANGEROUS_CONFIG)) {
      if (k in this.config) this.config[k] = v;
    }
    this.dangerousMode = true;
    this._persist();
    console.log("[Policy] DANGEROUS MODE ENABLED — aggressive trading parameters active");
    return { changed: true };
  }

  disableDangerousMode() {
    if (!this.dangerousMode) return { changed: false, message: "Dangerous mode is not active." };
    if (this._savedConfig) {
      this.config = { ...this._savedConfig };
      this._savedConfig = null;
    } else {
      this.config = { ...DEFAULT_CONFIG };
    }
    this.dangerousMode = false;
    this._persist();
    console.log("[Policy] Dangerous mode DISABLED — restored previous config");
    return { changed: true };
  }

  _persist() {
    this._storage.set("config", { ...this.config });
  }

  _migrateConfig(fromVersion) {
    console.log(`[Policy] Migrating config from v${fromVersion} to v${CONFIG_VERSION}`);
    if (fromVersion < 2) {
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
    this._persist();
  }

  activateKillSwitch() {
    this.killSwitch = true;
    console.log("[Policy] KILL SWITCH ACTIVATED");
  }

  deactivateKillSwitch() {
    this.killSwitch = false;
    console.log("[Policy] Kill switch deactivated");
  }

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

  evaluate(ctx) {
    const violations = [];
    const warnings = [];
    if (this.killSwitch) {
      violations.push("Kill switch is active — all trading halted");
      return { allowed: false, violations, warnings };
    }
    if (this.dailyStartEquity > 0) {
      const dailyLossPct = -this.dailyPnL / this.dailyStartEquity;
      if (dailyLossPct >= this.config.max_daily_loss_pct) {
        violations.push(`Daily loss limit reached: ${(dailyLossPct * 100).toFixed(1)}% (max ${(this.config.max_daily_loss_pct * 100).toFixed(1)}%)`);
      }
    }
    if (ctx.side === "buy" && ctx.currentPositions >= this.config.max_positions) {
      violations.push(`Max positions reached: ${ctx.currentPositions}/${this.config.max_positions}`);
    }
    if (ctx.notional > this.config.max_notional_per_trade) {
      violations.push(`Order exceeds max notional: $${ctx.notional.toFixed(0)} > $${this.config.max_notional_per_trade}`);
    }
    if (ctx.side === "buy" && ctx.notional > (ctx.buyingPower || Infinity)) {
      violations.push(`Insufficient buying power: need $${ctx.notional.toFixed(0)}, have $${(ctx.buyingPower || 0).toFixed(0)}`);
    }
    if (ctx.side === "sell" && !this.config.allow_shorting && !ctx.isClosing) {
      violations.push("Shorting is not allowed (set allow_shorting: true to enable)");
    }
    if (this.config.symbol_denylist.length > 0 && this.config.symbol_denylist.includes(ctx.symbol)) {
      violations.push(`${ctx.symbol} is on the deny list`);
    }
    if (this.config.symbol_allowlist.length > 0 && !this.config.symbol_allowlist.includes(ctx.symbol)) {
      violations.push(`${ctx.symbol} is not on the allow list`);
    }
    const lastTrade = this.tradeCooldowns.get(ctx.symbol);
    if (lastTrade) {
      const minutesSince = (Date.now() - lastTrade) / 60000;
      if (minutesSince < this.config.cooldown_minutes) {
        violations.push(`Cooldown active for ${ctx.symbol}: ${Math.ceil(this.config.cooldown_minutes - minutesSince)} min remaining`);
      }
    }
    if (ctx.sentimentScore !== undefined && Math.abs(ctx.sentimentScore) < this.config.min_sentiment_score) {
      warnings.push(`Weak sentiment signal: ${(ctx.sentimentScore * 100).toFixed(0)}% (threshold: ${(this.config.min_sentiment_score * 100).toFixed(0)}%)`);
    }
    if (ctx.confidence !== undefined && ctx.confidence < this.config.min_analyst_confidence) {
      warnings.push(`Low AI confidence: ${(ctx.confidence * 100).toFixed(0)}% (threshold: ${(this.config.min_analyst_confidence * 100).toFixed(0)}%)`);
    }
    return { allowed: violations.length === 0, violations, warnings };
  }

  recordTrade(symbol) {
    this.tradeCooldowns.set(symbol, Date.now());
  }

  checkExits(positions) {
    const exits = [];
    for (const pos of positions) {
      const pnlPct = Number(pos.unrealized_plpc || 0);
      if (pnlPct <= -this.config.stop_loss_pct) {
        exits.push({
          symbol: pos.symbol,
          reason: "stop_loss",
          pnlPct,
          message: `Stop loss triggered: ${(pnlPct * 100).toFixed(1)}% (limit: -${(this.config.stop_loss_pct * 100).toFixed(0)}%)`,
        });
      } else if (pnlPct >= this.config.take_profit_pct) {
        exits.push({
          symbol: pos.symbol,
          reason: "take_profit",
          pnlPct,
          message: `Take profit triggered: +${(pnlPct * 100).toFixed(1)}% (target: +${(this.config.take_profit_pct * 100).toFixed(0)}%)`,
        });
      }
    }
    return exits;
  }

  evaluateOptionsOrder(ctx) {
    const violations = [];
    const warnings = [];
    const cfg = this.config;
    if (this.killSwitch) {
      violations.push("Kill switch is active — all trading halted");
      return { allowed: false, violations, warnings };
    }
    if (!cfg.options_enabled) {
      violations.push("Options trading is disabled (set options_enabled: true to enable)");
      return { allowed: false, violations, warnings };
    }
    if (ctx.premium > cfg.options_max_premium_per_trade) {
      violations.push(`Premium $${ctx.premium.toFixed(0)} exceeds max $${cfg.options_max_premium_per_trade}`);
    }
    if (this.optionsDailyLoss >= cfg.options_max_daily_loss) {
      violations.push(`Daily options loss limit reached: $${this.optionsDailyLoss.toFixed(0)} (max $${cfg.options_max_daily_loss})`);
    }
    if (ctx.currentOptionsPositions >= cfg.options_max_positions) {
      violations.push(`Max options positions reached: ${ctx.currentOptionsPositions}/${cfg.options_max_positions}`);
    }
    if (ctx.conviction < cfg.options_min_conviction) {
      violations.push(`Conviction ${ctx.conviction}/10 below minimum ${cfg.options_min_conviction}`);
    }
    if (ctx.delta != null) {
      const absDelta = Math.abs(ctx.delta);
      if (absDelta < cfg.options_min_delta) {
        violations.push(`Delta ${absDelta.toFixed(2)} too low (min ${cfg.options_min_delta}) — too far OTM`);
      }
      if (absDelta > cfg.options_max_delta) {
        warnings.push(`Delta ${absDelta.toFixed(2)} above preferred max ${cfg.options_max_delta} — consider lower strike`);
      }
    }
    if (ctx.spreadPct != null && ctx.spreadPct > cfg.options_max_spread_pct) {
      violations.push(`Bid-ask spread ${(ctx.spreadPct * 100).toFixed(1)}% exceeds max ${(cfg.options_max_spread_pct * 100).toFixed(0)}%`);
    }
    if (ctx.minutesToClose != null && ctx.minutesToClose < cfg.options_close_before_minutes) {
      violations.push(`Only ${ctx.minutesToClose} min to close — too late for new 0DTE entry (need ${cfg.options_close_before_minutes}+ min)`);
    }
    const lastTrade = this.optionsCooldowns.get(ctx.underlying);
    if (lastTrade) {
      const minutesSince = (Date.now() - lastTrade) / 60000;
      if (minutesSince < cfg.options_cooldown_minutes) {
        violations.push(`Options cooldown active for ${ctx.underlying}: ${Math.ceil(cfg.options_cooldown_minutes - minutesSince)} min remaining`);
      }
    }
    if (this.optionsDailyLoss >= cfg.options_max_daily_loss * 0.75) {
      warnings.push(`Options daily loss at ${((this.optionsDailyLoss / cfg.options_max_daily_loss) * 100).toFixed(0)}% of limit`);
    }
    return { allowed: violations.length === 0, violations, warnings };
  }

  recordOptionsTrade(underlying) {
    this.optionsCooldowns.set(underlying, Date.now());
  }

  recordOptionsTradeResult(pnl) {
    if (pnl < 0) {
      this.optionsDailyLoss += Math.abs(pnl);
    }
  }

  checkOptionsExits(positions, strategy = "scalp", minutesToClose = Infinity) {
    const exits = [];
    const cfg = this.config;
    const stopPct = strategy === "scalp" ? cfg.options_scalp_stop_loss_pct : cfg.options_swing_stop_loss_pct;
    const tpPct = strategy === "scalp" ? cfg.options_scalp_take_profit_pct : cfg.options_swing_take_profit_pct;
    for (const pos of positions) {
      const pnlPct = Number(pos.unrealized_plpc || 0);
      if (pnlPct <= -stopPct) {
        exits.push({
          symbol: pos.symbol,
          reason: "options_stop_loss",
          pnlPct,
          message: `Options stop loss: ${(pnlPct * 100).toFixed(1)}% (limit: -${(stopPct * 100).toFixed(0)}%)`,
        });
        continue;
      }
      if (pnlPct >= tpPct) {
        exits.push({
          symbol: pos.symbol,
          reason: "options_take_profit",
          pnlPct,
          message: `Options take profit: +${(pnlPct * 100).toFixed(1)}% (target: +${(tpPct * 100).toFixed(0)}%)`,
        });
        continue;
      }
      if (minutesToClose <= cfg.options_close_before_minutes) {
        exits.push({
          symbol: pos.symbol,
          reason: "time_exit",
          pnlPct,
          message: `Time exit: ${minutesToClose} min to close, P/L: ${(pnlPct * 100).toFixed(1)}%`,
        });
        continue;
      }
      if (pnlPct > 0.05 && pnlPct < stopPct * 0.5) {
        const costBasis = Number(pos.cost_basis || 0);
        const marketValue = Number(pos.market_value || 0);
        if (costBasis > 0 && marketValue > 0) {
          exits.push({
            symbol: pos.symbol,
            reason: "trailing_stop",
            pnlPct,
            message: `Trailing stop: profit fading, locking +${(pnlPct * 100).toFixed(1)}%`,
          });
        }
      }
    }
    return exits;
  }

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
    const tokenId = crypto.randomBytes(16).toString("hex");
    const expiresAt = Date.now() + 5 * 60 * 1000;
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
    this._approvalTokens.set(tokenId, tokenData);
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

  validateToken(tokenId, orderParams = {}) {
    const tokenData = this._approvalTokens.get(tokenId);
    if (!tokenData) {
      return { valid: false, error: "Unknown or expired approval token" };
    }
    if (Date.now() > tokenData.expiresAt) {
      this._approvalTokens.delete(tokenId);
      return { valid: false, error: "Approval token expired (5 min limit)" };
    }
    if (orderParams.symbol && orderParams.symbol !== tokenData.order.symbol) {
      return { valid: false, error: `Token was issued for ${tokenData.order.symbol}, not ${orderParams.symbol}` };
    }
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