/**
 * 0DTE Options Decision Engine — Rule-Based Dominance Hierarchy
 *
 * Eliminates "story trading" with a strict gate system:
 *   Gate 0 — Safety: market hours, missing data, wide spreads → NO_TRADE
 *   Gate 1 — Macro: sets allowed directions {CALL, PUT, NO_TRADE}
 *   Gate 2 — Gamma: sets bias; squeeze mode gated strictly
 *   Gate 3 — Trigger: mandatory price action confirmation (no anticipatory trades)
 *   Gate 4 — AI Overlay: adjusts conviction +/-2, cannot flip direction
 *
 * Risk controls: premium stop, time stop, price invalidation, VWAP fail exit
 * Throttle controls: max trades/hr, consecutive loss cooldown, correlated exposure
 * Strike selection: delta 0.35-0.55, within 0.3-0.6% of spot, spread < 3%
 *
 * Every NO_TRADE returns a reasonCode.
 * Word "swing" is banned for 0DTE — uses "scalp" only.
 */

const log = require('../logger')('DecisionEngine');

// ── Constants ────────────────────────────────────────────────────────────

const MARKET_OPEN_HOUR = 9;
const MARKET_OPEN_MIN = 30;
const MARKET_CLOSE_HOUR = 16;

const DEFAULT_CONFIG = {
  // Risk controls
  premiumStopPct: -0.40,            // -40% premium stop
  timeStopMinutes: 12,              // 12 min no favorable move → exit
  vwapFailCount: 2,                 // 2 VWAP rejections → exit

  // Throttle controls
  maxTradesPerSymbolPerHour: 3,
  consecutiveLossCooldownMinutes: 30,
  consecutiveLossThreshold: 2,
  maxCorrelatedExposure: 2,         // max 2 of {SPY, QQQ, IWM, XLF}
  correlatedSymbols: ['SPY', 'QQQ', 'IWM', 'XLF'],

  // Strike selection
  minDelta: 0.35,
  maxDelta: 0.55,
  maxSpotDistanceScalp: 0.003,      // 0.3% for scalp
  maxSpotDistanceBreakout: 0.006,   // 0.6% for breakout
  maxSpreadPct: 0.03,               // 3% bid/ask spread

  // Gamma squeeze thresholds
  squeezeMinShortGammaPct: 60,
  squeezeMinNetGEX: -300e6,         // -$300M
  lowGammaCap: 5,                   // cap conviction at 5 when shortGammaPct < 50
  lowGammaThreshold: 50,

  // AI overlay limits
  aiMaxConvictionAdjust: 2,
  aiMinConviction: 7,               // raised — quality over quantity, stop overtrading
};

// ── Correlated symbols set ───────────────────────────────────────────────
const CORRELATED_SET = new Set(['SPY', 'QQQ', 'IWM', 'XLF']);

// ── Trade history (in-memory, resets on restart) ─────────────────────────
const _tradeHistory = [];  // { symbol, timestamp, pnl }
const _recentLosses = new Map();  // symbol → [timestamps of consecutive losses]

// ── Main Decision Function ───────────────────────────────────────────────

/**
 * Run the full 0DTE decision hierarchy.
 *
 * @param {object} input
 * @param {string} input.symbol - Underlying (SPY, QQQ, etc.)
 * @param {number} input.spot - Current spot price
 * @param {object} input.technicals - { rsi, macd, vwap, priceAboveVWAP, momentum, bars, atr, bollinger, nearestSupport, nearestResistance }
 * @param {object} input.gex - { regime: { label, confidence }, walls: { callWalls, putWalls }, gammaFlip, shortGammaPct, netGEX }
 * @param {object} input.macro - { regime, score, allowedDirections? }
 * @param {object} [input.aiOverlay] - { direction, conviction, reason }
 * @param {object} [input.activePositions] - Array of current open position symbols
 * @param {object} [input.contractData] - { delta, spreadPct, bid, ask, strike }
 * @param {object} [overrides] - Config overrides
 * @returns {DecisionResult}
 */
function evaluate(input, overrides = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...overrides };
  const result = {
    action: 'NO_TRADE',
    direction: null,
    conviction: 0,
    strategy: 'scalp', // ALWAYS scalp for 0DTE
    reasonCode: null,
    reasons: [],
    riskControls: null,
    gateResults: {},
    decisionRegime: null,
    contextRegime: null,
  };

  // ── Gate 0: Safety ─────────────────────────────────────────────────
  const safetyResult = _gate0Safety(input, cfg);
  result.gateResults.gate0 = safetyResult;
  if (!safetyResult.pass) {
    result.reasonCode = safetyResult.reasonCode;
    result.reasons.push(safetyResult.reason);
    return result;
  }

  // ── Gate 1: Macro ──────────────────────────────────────────────────
  const macroResult = _gate1Macro(input, cfg);
  result.gateResults.gate1 = macroResult;
  if (macroResult.action === 'NO_TRADE') {
    result.reasonCode = macroResult.reasonCode;
    result.reasons.push(macroResult.reason);
    return result;
  }
  const allowedDirections = macroResult.allowedDirections;

  // ── Gate 2: Gamma ──────────────────────────────────────────────────
  const gammaResult = _gate2Gamma(input, cfg);
  result.gateResults.gate2 = gammaResult;
  result.decisionRegime = gammaResult.decisionRegime;
  result.contextRegime = gammaResult.contextRegime;
  let conviction = gammaResult.conviction;
  let direction = gammaResult.bias;

  // Check direction is allowed by macro
  if (direction && !allowedDirections.includes(direction)) {
    result.reasonCode = 'MACRO_DIRECTION_CONFLICT';
    result.reasons.push(`Gamma bias ${direction} conflicts with macro-allowed [${allowedDirections.join(',')}]`);
    result.conviction = Math.min(conviction, 3);
    // Don't abort — let trigger gate decide if there's a valid signal in allowed direction
    direction = allowedDirections.length === 1 ? allowedDirections[0] : null;
  }

  // ── Gate 3: Trigger (MANDATORY) ────────────────────────────────────
  const triggerResult = _gate3Trigger(input, direction, allowedDirections, cfg);
  result.gateResults.gate3 = triggerResult;
  if (!triggerResult.triggered) {
    result.reasonCode = triggerResult.reasonCode;
    result.reasons.push(triggerResult.reason);
    return result;
  }
  direction = triggerResult.direction;
  conviction = Math.max(conviction, triggerResult.conviction);
  result.reasons.push(...triggerResult.reasons);

  // ── Gate 4: AI Overlay ─────────────────────────────────────────────
  if (input.aiOverlay) {
    const aiResult = _gate4AIOverlay(input.aiOverlay, direction, conviction, cfg);
    result.gateResults.gate4 = aiResult;
    conviction = aiResult.conviction;
    result.reasons.push(...aiResult.reasons);

    if (conviction < cfg.aiMinConviction) {
      result.reasonCode = 'AI_LOW_CONVICTION';
      result.reasons.push(`AI reduced conviction to ${conviction} (below ${cfg.aiMinConviction} threshold)`);
      return result;
    }
  }

  // ── Throttle Checks ────────────────────────────────────────────────
  const throttleResult = _checkThrottles(input.symbol, input.activePositions || [], cfg);
  if (!throttleResult.pass) {
    result.reasonCode = throttleResult.reasonCode;
    result.reasons.push(throttleResult.reason);
    return result;
  }

  // ── Strike Validation (if contract data provided) ──────────────────
  if (input.contractData) {
    const strikeResult = _validateStrike(input.contractData, input.spot, cfg);
    if (!strikeResult.pass) {
      result.reasonCode = strikeResult.reasonCode;
      result.reasons.push(strikeResult.reason);
      return result;
    }
  }

  // ── Build final result ─────────────────────────────────────────────
  result.action = direction === 'CALL' ? 'BUY_CALL' : 'BUY_PUT';
  result.direction = direction;
  result.conviction = conviction;
  result.strategy = 'scalp'; // NEVER "swing" for 0DTE
  result.reasonCode = null;
  result.riskControls = _buildRiskControls(input, direction, cfg);

  return result;
}

// ── Gate 0: Safety ───────────────────────────────────────────────────────

function _gate0Safety(input, cfg) {
  const { spot, technicals } = input;

  // Market hours check
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hour = et.getHours();
  const min = et.getMinutes();
  const day = et.getDay();

  if (day === 0 || day === 6) {
    return { pass: false, reasonCode: 'MARKET_CLOSED_WEEKEND', reason: 'Market closed (weekend)' };
  }

  const minuteOfDay = hour * 60 + min;
  const openMinute = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MIN;
  const closeMinute = MARKET_CLOSE_HOUR * 60;

  if (minuteOfDay < openMinute || minuteOfDay >= closeMinute) {
    return { pass: false, reasonCode: 'MARKET_CLOSED', reason: `Market closed (${hour}:${String(min).padStart(2, '0')} ET)` };
  }

  // First 15 min — too noisy
  if (minuteOfDay - openMinute < 15) {
    return { pass: false, reasonCode: 'OPENING_VOLATILITY', reason: 'First 15 min after open — too volatile for entries' };
  }

  // Missing data
  if (!spot || spot <= 0) {
    return { pass: false, reasonCode: 'MISSING_SPOT', reason: 'Missing spot price' };
  }
  if (!technicals) {
    return { pass: false, reasonCode: 'MISSING_TECHNICALS', reason: 'Missing intraday technicals' };
  }
  if (!technicals.rsi && technicals.rsi !== 0) {
    return { pass: false, reasonCode: 'MISSING_RSI', reason: 'Missing RSI data' };
  }

  // Spread check (if contract data available)
  if (input.contractData) {
    const { bid, ask } = input.contractData;
    if (bid && ask && ask > 0) {
      const spread = (ask - bid) / ((ask + bid) / 2);
      if (spread > cfg.maxSpreadPct) {
        return { pass: false, reasonCode: 'SPREAD_TOO_WIDE', reason: `Bid/ask spread ${(spread * 100).toFixed(1)}% exceeds ${(cfg.maxSpreadPct * 100).toFixed(0)}% limit` };
      }
    }
  }

  return { pass: true };
}

// ── Gate 1: Macro ────────────────────────────────────────────────────────

function _gate1Macro(input, cfg) {
  const macro = input.macro || {};
  const regime = (macro.regime || '').toUpperCase();

  if (regime === 'RISK_OFF') {
    return {
      action: 'NO_TRADE',
      reasonCode: 'MACRO_RISK_OFF',
      reason: 'Macro regime is RISK_OFF — no 0DTE entries',
      allowedDirections: [],
    };
  }

  if (regime === 'RISK_ON') {
    return {
      action: 'TRADE',
      allowedDirections: ['CALL', 'PUT'],
      reason: 'Macro RISK_ON — both directions allowed',
    };
  }

  // CAUTIOUS or unknown — allow both but reduce conviction later
  return {
    action: 'TRADE',
    allowedDirections: ['CALL', 'PUT'],
    reason: `Macro ${regime || 'UNKNOWN'} — both directions allowed with caution`,
  };
}

// ── Gate 2: Gamma ────────────────────────────────────────────────────────

function _gate2Gamma(input, cfg) {
  const gex = input.gex || {};
  const regime = gex.regime || { label: 'Unknown', confidence: 0 };
  const shortGammaPct = gex.shortGammaPct || 0;
  const netGEX = gex.netGEX || 0;
  const walls = gex.walls || { callWalls: [], putWalls: [] };
  const spot = input.spot;

  const result = {
    bias: null,
    conviction: 5,
    isSqueeze: false,
    decisionRegime: regime.label,
    contextRegime: regime.label,
    reasons: [],
  };

  // Squeeze mode: ONLY if shortGammaPct >= 60 AND netGEX <= -$300M
  if (shortGammaPct >= cfg.squeezeMinShortGammaPct && netGEX <= cfg.squeezeMinNetGEX) {
    result.isSqueeze = true;
    result.conviction = 7;
    result.reasons.push(`Gamma squeeze conditions met: shortGamma=${shortGammaPct}%, netGEX=$${(netGEX / 1e6).toFixed(0)}M`);
  } else if (shortGammaPct < cfg.lowGammaThreshold) {
    // Low short gamma — cap conviction and ban "squeeze" language
    result.conviction = Math.min(result.conviction, cfg.lowGammaCap);
    result.reasons.push(`Short gamma ${shortGammaPct}% < ${cfg.lowGammaThreshold}% — conviction capped at ${cfg.lowGammaCap}, no squeeze language`);
  }

  // Determine gamma bias from walls and flip
  const callWall = walls.callWalls?.[0];
  const putWall = walls.putWalls?.[0];
  const gammaFlip = gex.gammaFlip;

  if (regime.label === 'Short Gamma') {
    // Trend regime — bias toward momentum direction
    if (input.technicals?.momentum > 0.1) {
      result.bias = 'CALL';
      result.reasons.push('Short gamma + bullish momentum → CALL bias');
    } else if (input.technicals?.momentum < -0.1) {
      result.bias = 'PUT';
      result.reasons.push('Short gamma + bearish momentum → PUT bias');
    }
  } else if (regime.label === 'Long Gamma') {
    // Mean-reversion regime
    if (callWall && spot >= callWall.strike * 0.998) {
      result.bias = 'PUT';
      result.reasons.push(`Long gamma + at call wall $${callWall.strike} → fade with PUT`);
    } else if (putWall && spot <= putWall.strike * 1.002) {
      result.bias = 'CALL';
      result.reasons.push(`Long gamma + at put wall $${putWall.strike} → bounce with CALL`);
    }
  }

  return result;
}

// ── Gate 3: Trigger (MANDATORY) ──────────────────────────────────────────

function _gate3Trigger(input, gammaBias, allowedDirections, cfg) {
  const tech = input.technicals || {};
  const spot = input.spot;
  const bars = tech.bars || [];
  const result = {
    triggered: false,
    direction: null,
    conviction: 0,
    reasons: [],
    reasonCode: 'NO_TRIGGER',
    reason: 'No price action trigger confirmed',
  };

  if (bars.length < 5) {
    result.reasonCode = 'INSUFFICIENT_BARS';
    result.reason = 'Not enough bars for trigger detection';
    return result;
  }

  const lastBar = bars[bars.length - 1];
  const prevBar = bars[bars.length - 2];
  const prior5High = Math.max(...bars.slice(-6, -1).map(b => b.high));
  const prior5Low = Math.min(...bars.slice(-6, -1).map(b => b.low));
  const vwap = tech.vwap || spot;
  const rsi = tech.rsi || 50;
  const macd = tech.macd || {};

  // ── CALL triggers ──────────────────────────────────────────────────
  let callTriggered = false;
  const callReasons = [];

  // Reclaim VWAP (price crosses above VWAP after being below)
  const vwapReclaim = prevBar && prevBar.close < vwap && lastBar.close > vwap;
  // Break prior 5-bar high
  const breakHigh = lastBar.high > prior5High;

  if (vwapReclaim || breakHigh) {
    // Confirmation: RSI rising from < 20 OR bullish delta flip (MACD histogram positive)
    const rsiRising = rsi < 40 && rsi > (tech._prevRsi || rsi); // RSI recovering from low
    const rsiBounce = rsi > 20 && rsi < 50; // RSI in recovery zone
    const bullishDeltaFlip = macd.histogram > 0 && (macd._prevHistogram || 0) <= 0;
    const macdBullish = macd.histogram > 0;

    if (rsiRising || rsiBounce || bullishDeltaFlip || macdBullish) {
      callTriggered = true;
      if (vwapReclaim) callReasons.push('VWAP reclaimed');
      if (breakHigh) callReasons.push(`Break prior 5-bar high $${prior5High.toFixed(2)}`);
      if (rsiRising || rsiBounce) callReasons.push(`RSI ${rsi.toFixed(1)} recovering`);
      if (bullishDeltaFlip || macdBullish) callReasons.push('Bullish MACD');
    }
  }

  // ── PUT triggers ───────────────────────────────────────────────────
  let putTriggered = false;
  const putReasons = [];

  // Lose VWAP (price crosses below VWAP after being above)
  const vwapLose = prevBar && prevBar.close > vwap && lastBar.close < vwap;
  // Break prior 5-bar low
  const breakLow = lastBar.low < prior5Low;

  if (vwapLose || breakLow) {
    // Confirmation: RSI falling from > 80 OR bearish delta flip
    const rsiFalling = rsi > 60 && rsi < (tech._prevRsi || rsi); // RSI falling from high
    const rsiSell = rsi > 50 && rsi < 80; // RSI in selling zone
    const bearishDeltaFlip = macd.histogram < 0 && (macd._prevHistogram || 0) >= 0;
    const macdBearish = macd.histogram < 0;

    if (rsiFalling || rsiSell || bearishDeltaFlip || macdBearish) {
      putTriggered = true;
      if (vwapLose) putReasons.push('VWAP lost');
      if (breakLow) putReasons.push(`Break prior 5-bar low $${prior5Low.toFixed(2)}`);
      if (rsiFalling || rsiSell) putReasons.push(`RSI ${rsi.toFixed(1)} declining`);
      if (bearishDeltaFlip || macdBearish) putReasons.push('Bearish MACD');
    }
  }

  // ── Select direction based on triggers and allowed ──────────────────
  if (callTriggered && allowedDirections.includes('CALL')) {
    if (!putTriggered || gammaBias === 'CALL') {
      result.triggered = true;
      result.direction = 'CALL';
      result.conviction = callReasons.length >= 3 ? 7 : callReasons.length >= 2 ? 6 : 5;
      result.reasons = callReasons.map(r => `CALL trigger: ${r}`);
      return result;
    }
  }

  if (putTriggered && allowedDirections.includes('PUT')) {
    if (!callTriggered || gammaBias === 'PUT') {
      result.triggered = true;
      result.direction = 'PUT';
      result.conviction = putReasons.length >= 3 ? 7 : putReasons.length >= 2 ? 6 : 5;
      result.reasons = putReasons.map(r => `PUT trigger: ${r}`);
      return result;
    }
  }

  // Both triggered but no gamma bias → pick the one with more reasons
  if (callTriggered && putTriggered) {
    result.reasonCode = 'CONFLICTING_TRIGGERS';
    result.reason = 'Both CALL and PUT triggers fired — conflicting signals';
    return result;
  }

  return result;
}

// ── Gate 4: AI Overlay ───────────────────────────────────────────────────

function _gate4AIOverlay(aiOverlay, direction, currentConviction, cfg) {
  const result = {
    conviction: currentConviction,
    reasons: [],
  };

  if (!aiOverlay || !aiOverlay.conviction) return result;

  const aiDirection = (aiOverlay.direction || '').toUpperCase();
  const aiConviction = aiOverlay.conviction;

  // AI CANNOT flip direction
  if (aiDirection && aiDirection !== direction && aiDirection !== '') {
    // Conflict — reduce conviction by 2
    result.conviction = Math.max(1, currentConviction - 2);
    result.reasons.push(`AI direction ${aiDirection} conflicts with gate direction ${direction} — conviction reduced by 2`);
    return result;
  }

  // AI can adjust conviction +/- 2
  const adjustment = Math.max(-cfg.aiMaxConvictionAdjust, Math.min(cfg.aiMaxConvictionAdjust, aiConviction - currentConviction));
  result.conviction = Math.max(1, Math.min(10, currentConviction + adjustment));
  if (adjustment !== 0) {
    result.reasons.push(`AI overlay: conviction ${adjustment > 0 ? '+' : ''}${adjustment} (${aiOverlay.reason || 'no reason'})`);
  }

  return result;
}

// ── Throttle Checks ──────────────────────────────────────────────────────

function _checkThrottles(symbol, activePositions, cfg) {
  // Max trades per symbol per hour
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentTrades = _tradeHistory.filter(t =>
    t.symbol === symbol && t.timestamp > oneHourAgo
  );
  if (recentTrades.length >= cfg.maxTradesPerSymbolPerHour) {
    return {
      pass: false,
      reasonCode: 'MAX_TRADES_PER_HOUR',
      reason: `Max ${cfg.maxTradesPerSymbolPerHour} trades/hour for ${symbol} reached (${recentTrades.length} recent)`,
    };
  }

  // Consecutive loss cooldown
  const losses = _recentLosses.get(symbol) || [];
  const recentConsecutiveLosses = losses.filter(ts => ts > Date.now() - cfg.consecutiveLossCooldownMinutes * 60 * 1000);
  if (recentConsecutiveLosses.length >= cfg.consecutiveLossThreshold) {
    return {
      pass: false,
      reasonCode: 'CONSECUTIVE_LOSS_COOLDOWN',
      reason: `${cfg.consecutiveLossThreshold} consecutive losses on ${symbol} — ${cfg.consecutiveLossCooldownMinutes}min cooldown`,
    };
  }

  // Max correlated exposure
  const correlatedOpen = (activePositions || []).filter(p => {
    const sym = typeof p === 'string' ? p : p.symbol || p.underlying || '';
    return CORRELATED_SET.has(sym.toUpperCase());
  });
  if (CORRELATED_SET.has(symbol.toUpperCase()) && correlatedOpen.length >= cfg.maxCorrelatedExposure) {
    return {
      pass: false,
      reasonCode: 'MAX_CORRELATED_EXPOSURE',
      reason: `Max ${cfg.maxCorrelatedExposure} correlated positions (${correlatedOpen.map(p => typeof p === 'string' ? p : p.symbol).join(', ')})`,
    };
  }

  return { pass: true };
}

// ── Strike Validation ────────────────────────────────────────────────────

function _validateStrike(contractData, spot, cfg) {
  const { delta, spreadPct, strike } = contractData;

  // Delta range
  if (delta !== undefined && delta !== null) {
    const absDelta = Math.abs(delta);
    if (absDelta < cfg.minDelta || absDelta > cfg.maxDelta) {
      return {
        pass: false,
        reasonCode: 'DELTA_OUT_OF_RANGE',
        reason: `Delta ${absDelta.toFixed(2)} outside [${cfg.minDelta}-${cfg.maxDelta}] range`,
      };
    }
  }

  // Distance from spot
  if (strike && spot) {
    const distancePct = Math.abs(strike - spot) / spot;
    if (distancePct > cfg.maxSpotDistanceBreakout) {
      return {
        pass: false,
        reasonCode: 'STRIKE_TOO_FAR',
        reason: `Strike $${strike} is ${(distancePct * 100).toFixed(2)}% from spot (max ${(cfg.maxSpotDistanceBreakout * 100).toFixed(1)}%)`,
      };
    }
  }

  // Spread
  if (spreadPct !== undefined && spreadPct > cfg.maxSpreadPct) {
    return {
      pass: false,
      reasonCode: 'SPREAD_TOO_WIDE',
      reason: `Bid/ask spread ${(spreadPct * 100).toFixed(1)}% exceeds ${(cfg.maxSpreadPct * 100).toFixed(0)}% limit`,
    };
  }

  return { pass: true };
}

// ── Risk Controls Builder ────────────────────────────────────────────────

function _buildRiskControls(input, direction, cfg) {
  const spot = input.spot;
  const tech = input.technicals || {};

  return {
    premiumStopPct: cfg.premiumStopPct,
    timeStopMinutes: cfg.timeStopMinutes,
    vwapFailExitCount: cfg.vwapFailCount,
    priceInvalidation: direction === 'CALL'
      ? tech.nearestSupport || spot * 0.995
      : tech.nearestResistance || spot * 1.005,
    strategy: 'scalp',  // ALWAYS "scalp" for 0DTE, never "swing"
  };
}

// ── Trade Recording (for throttle tracking) ──────────────────────────────

function recordTrade(symbol, pnl) {
  _tradeHistory.push({ symbol, timestamp: Date.now(), pnl });
  // Keep last 100
  if (_tradeHistory.length > 100) _tradeHistory.splice(0, _tradeHistory.length - 100);

  if (pnl < 0) {
    const losses = _recentLosses.get(symbol) || [];
    losses.push(Date.now());
    _recentLosses.set(symbol, losses.slice(-10));
  } else {
    // Win resets consecutive losses
    _recentLosses.delete(symbol);
  }
}

// ── Rationale Formatter ──────────────────────────────────────────────────

/**
 * Format the decision result for Discord / logging.
 * Shows BOTH decision regime (0DTE) and context regime (aggregate),
 * explicitly labeling which is used to trade.
 */
function formatRationale(result) {
  const lines = [];

  if (result.action === 'NO_TRADE') {
    lines.push(`**NO TRADE** — \`${result.reasonCode}\``);
  } else {
    lines.push(`**${result.action}** — Conviction: \`${result.conviction}/10\` | Strategy: \`${result.strategy}\``);
  }

  // Regime display — always show both
  if (result.decisionRegime || result.contextRegime) {
    const decLabel = result.decisionRegime || 'Unknown';
    const ctxLabel = result.contextRegime || 'Unknown';
    lines.push(`Regime: **${decLabel}** (decision, 0DTE) | ${ctxLabel} (context, aggregate)`);
  }

  // Gate results summary
  for (const reason of (result.reasons || [])) {
    lines.push(`  - ${reason}`);
  }

  // Risk controls
  if (result.riskControls) {
    const rc = result.riskControls;
    lines.push(`Risk: stop ${(rc.premiumStopPct * 100).toFixed(0)}% | time ${rc.timeStopMinutes}min | VWAP fail ${rc.vwapFailExitCount}x | invalidation $${rc.priceInvalidation?.toFixed(2) || '—'}`);
  }

  return lines.join('\n');
}

// ── Exports ──────────────────────────────────────────────────────────────

module.exports = {
  evaluate,
  recordTrade,
  formatRationale,
  DEFAULT_CONFIG,
  // Exported for testing
  _gate0Safety,
  _gate1Macro,
  _gate2Gamma,
  _gate3Trigger,
  _gate4AIOverlay,
  _checkThrottles,
  _validateStrike,
  _tradeHistory,
  _recentLosses,
};
