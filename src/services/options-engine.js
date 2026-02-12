/**
 * 0DTE Options Trading Engine
 *
 * Autonomous options trading focused on 0DTE (and short-dated) contracts
 * on SPY, QQQ, and opportunistic A+ setups on individual names.
 *
 * Strategy types:
 *   - SCALP: Quick in/out, +20-30% target, tight stops, 5-30 min hold
 *   - SWING: Larger move, +50-75% target, wider stops, hold hours
 *
 * Decision pipeline:
 *   1. Market regime check (macro + GEX)
 *   2. Intraday price action scan (5-min bars, technicals)
 *   3. GEX-informed levels (call walls, put walls, gamma flip)
 *   4. Contract selection (delta-based, spread-filtered)
 *   5. AI conviction scoring (must meet threshold)
 *   6. Risk validation (policy engine)
 *   7. Order execution + position monitoring
 *
 * Data sources:
 *   - GEX Engine (gamma regime, walls, flip levels)
 *   - Technicals (RSI, MACD, Bollinger, ATR on intraday bars)
 *   - Macro (risk regime, sector rotation)
 *   - Public.com (preferred: real-time options chain + greeks)
 *   - Alpaca (fallback: indicative options chain, quotes, execution)
 *   - AI (Ollama decision engine)
 */

const alpaca = require('./alpaca');
const publicApi = require('./public');
const gamma = require('./gamma');
const GEXEngine = require('./gex-engine');
const gammaSqueeze = require('./gamma-squeeze');
const { analyzeMTFEMA, formatMTFForPrompt } = require('./mtf-ema');
const technicals = require('./technicals');
const macro = require('./macro');
const policy = require('./policy');
// NOTE: ai.js is NOT required here to avoid circular dependency:
//   options-engine → ai → self-awareness → mahoraga → options-engine
// Instead, ai is lazy-required inside _askOptionsAI().
const auditLog = require('./audit-log');
const circuitBreaker = require('./circuit-breaker');
const signalCache = require('./signal-cache');
const config = require('../config');
const Storage = require('./storage');

// Max contracts to evaluate per scan
const MAX_CONTRACTS_PER_SCAN = 20;

// Time constants (ET)
const MARKET_OPEN_HOUR = 9;
const MARKET_OPEN_MIN = 30;
const MARKET_CLOSE_HOUR = 16;
const MARKET_CLOSE_MIN = 0;

class OptionsEngine {
  constructor() {
    this._storage = new Storage('options-engine-state.json');
    this._gexEngine = new GEXEngine(gamma);
    this._logs = [];
    this._postToChannel = null;
    this._activeTrades = new Map(); // occSymbol → { entry, strategy, underlying, ... }

    // Restore state
    const savedTrades = this._storage.get('activeTrades', []);
    for (const t of savedTrades) {
      this._activeTrades.set(t.symbol, t);
    }
  }

  /** Wire up Discord posting callback */
  setChannelPoster(fn) {
    this._postToChannel = fn;
  }

  // ── Logging ───────────────────────────────────────────────────────

  _log(type, message) {
    const entry = { type, message, timestamp: new Date().toISOString() };
    this._logs.push(entry);
    if (this._logs.length > 300) this._logs.shift();
    auditLog.log(type, `[0DTE] ${message}`);
    return entry;
  }

  getLogs() { return [...this._logs]; }

  // ── Time Helpers ──────────────────────────────────────────────────

  _getETTime() {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return {
      hour: et.getHours(),
      minute: et.getMinutes(),
      day: et.getDay(), // 0=Sun, 6=Sat
      date: et,
      minutesToClose: (MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MIN) - (et.getHours() * 60 + et.getMinutes()),
      todayString: `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`,
    };
  }

  _isMarketHours() {
    const t = this._getETTime();
    if (t.day === 0 || t.day === 6) return false;
    const minuteOfDay = t.hour * 60 + t.minute;
    const openMinute = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MIN;
    const closeMinute = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MIN;
    return minuteOfDay >= openMinute && minuteOfDay < closeMinute;
  }

  // ── Main Cycle ────────────────────────────────────────────────────

  /**
   * Run the full 0DTE options trading cycle.
   * Called on schedule by the SHARK engine during market hours.
   */
  async runCycle() {
    // Prevent overlapping cycles (SHARK + independent interval can both call this)
    if (this._cycleRunning) return;
    this._cycleRunning = true;
    try {
      await this._runCycleInner();
    } finally {
      this._cycleRunning = false;
    }
  }

  async _runCycleInner() {
    const cfg = policy.getConfig();
    if (!cfg.options_enabled) {
      this._log('cycle', 'Options engine disabled (options_enabled=false)');
      return;
    }
    if (!alpaca.enabled) {
      this._log('cycle', 'Alpaca not configured — skipping options cycle');
      return;
    }

    if (circuitBreaker.isPaused()) {
      this._log('circuit_breaker', 'Options trading paused by circuit breaker');
      return;
    }

    const et = this._getETTime();
    if (!this._isMarketHours()) {
      this._log('cycle', `Outside market hours (${et.hour}:${String(et.minute).padStart(2, '0')} ET, day=${et.day}) — skipping`);
      return;
    }

    // Skip first 15 min after open (too volatile/noisy for entries)
    const minutesSinceOpen = et.minutesToClose > 0
      ? (MARKET_CLOSE_HOUR * 60) - et.minutesToClose - (MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MIN)
      : 0;
    if (minutesSinceOpen < 15) {
      this._log('cycle', `Skipping — ${minutesSinceOpen} min since open (waiting for 15 min price discovery)`);
      return;
    }

    try {
      this._log('cycle', `Options cycle started — ${et.minutesToClose} min to close`);

      // 1. Check account
      const account = await alpaca.getAccount();
      const equity = Number(account.equity || 0);
      policy.resetDaily(equity);

      // 2. Fetch options positions once (used by both monitor + entry scan)
      const optionsPositions = await alpaca.getOptionsPositions();

      // 3. Monitor existing options positions FIRST (always run)
      await this._monitorPositions(et.minutesToClose, optionsPositions);

      // 4. If we have room and time, scan for new entries
      if (optionsPositions.length < cfg.options_max_positions && et.minutesToClose > cfg.options_close_before_minutes) {
        this._log('cycle', `Scanning for entries — ${optionsPositions.length}/${cfg.options_max_positions} positions, ${et.minutesToClose} min left`);
        await this._scanForEntries(account, optionsPositions.length, et);
      } else if (et.minutesToClose <= cfg.options_close_before_minutes) {
        this._log('cycle', `Too close to market close (${et.minutesToClose} min) — exit-only mode`);
      } else {
        this._log('cycle', `Max positions reached (${optionsPositions.length}/${cfg.options_max_positions}) — monitoring only`);
      }

    } catch (err) {
      this._log('error', `Options cycle error: ${err.message}`);
      console.error('[0DTE] Cycle error:', err.message);
      circuitBreaker.recordError(err.message);
    }
  }

  // ── Position Monitoring ───────────────────────────────────────────

  async _monitorPositions(minutesToClose, optionsPositions) {
    try {
      if (!optionsPositions || optionsPositions.length === 0) return;

      this._log('monitor', `Monitoring ${optionsPositions.length} options position(s)`);

      // Determine strategy for each position from our tracking
      for (const pos of optionsPositions) {
        const tracked = this._activeTrades.get(pos.symbol);
        const strategy = tracked?.strategy || 'scalp';

        const exits = policy.checkOptionsExits([pos], strategy, minutesToClose);
        for (const exit of exits) {
          try {
            await alpaca.closeOptionsPosition(exit.symbol);
            this._log('trade', `CLOSE OPTIONS ${exit.symbol}: ${exit.message}`);

            // Record P&L
            const pnl = Number(pos.unrealized_pl || 0);
            policy.recordOptionsTradeResult(pnl);
            circuitBreaker.recordExit(exit.symbol, exit.reason, exit.pnlPct);

            // Remove from tracking
            this._activeTrades.delete(exit.symbol);
            this._persistTrades();

            // Discord alert
            if (this._postToChannel) {
              const emoji = pnl >= 0 ? '🟢' : '🔴';
              const parsed = alpaca._parseOccSymbol(exit.symbol);
              await this._postToChannel(
                `${emoji} **0DTE Exit: ${parsed.underlying} ${parsed.strike} ${parsed.type.toUpperCase()}**\n` +
                `${exit.message}\n` +
                `P/L: \`$${pnl.toFixed(2)}\` | Strategy: \`${strategy}\`\n` +
                `_${alpaca.isPaper ? 'Paper' : 'LIVE'} | Autonomous exit_`
              );
            }
          } catch (err) {
            this._log('error', `Failed to close options ${exit.symbol}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      this._log('error', `Options monitor error: ${err.message}`);
    }
  }

  // ── Entry Scanning ────────────────────────────────────────────────

  async _scanForEntries(account, currentOptionsPositions, et) {
    const cfg = policy.getConfig();
    const underlyings = cfg.options_underlyings || ['SPY', 'QQQ'];

    // 1. Get macro regime — don't let failure block scanning
    let macroRegime = { regime: 'CAUTIOUS', score: 0 };
    try {
      macroRegime = await macro.getRegime();
    } catch (err) {
      this._log('macro', `Macro unavailable (${err.message}) — proceeding as CAUTIOUS`);
    }

    this._log('scan', `Scanning ${underlyings.join(', ')} | macro=${macroRegime.regime} | positions=${currentOptionsPositions}/${cfg.options_max_positions}`);

    // Skip scanning in RISK_OFF (only monitor exits)
    if (macroRegime.regime === 'RISK_OFF') {
      this._log('scan', 'RISK_OFF — skipping options entry scan, monitoring exits only');
      return;
    }

    for (const underlying of underlyings) {
      if (currentOptionsPositions >= cfg.options_max_positions) {
        this._log('scan', `Position cap reached — stopping scan`);
        break;
      }

      try {
        const signal = await this._analyzeUnderlying(underlying, macroRegime, et);
        if (!signal) continue;

        // Execute if we got a signal
        this._log('trade', `EXECUTING: ${signal.optionType.toUpperCase()} on ${underlying} — conviction ${signal.conviction}/10, strategy ${signal.strategy}`);
        const result = await this._executeEntry(signal, account, currentOptionsPositions, et);
        if (result.success) {
          currentOptionsPositions++;
          this._log('trade', `ORDER PLACED: ${underlying} ${signal.optionType} — ${signal.reason}`);
        } else {
          this._log('trade', `ORDER FAILED: ${underlying} — ${result.reason}`);
        }
      } catch (err) {
        this._log('error', `Scan error for ${underlying}: ${err.message}`);
      }
    }
  }

  /**
   * Analyze an underlying for a 0DTE options trade opportunity.
   * Returns a signal object or null if no setup found.
   *
   * RESILIENT: GEX failure does NOT block analysis — falls back to
   * technicals + AI. Signal cache only blocks for 5 min (not 15).
   */
  async _analyzeUnderlying(underlying, macroRegime, et) {
    const cfg = policy.getConfig();

    // Cooldown per-underlying — only applies after a TRADE was executed (not after analysis skips).
    // This lets the engine re-evaluate quickly as conditions change, while preventing
    // rapid repeat entries on the same underlying.
    const cooldownKey = `opts_${underlying}`;
    const lastTrade = this._tradeCooldowns?.get(cooldownKey) || 0;
    if (Date.now() - lastTrade < (cfg.options_cooldown_minutes || 5) * 60 * 1000) {
      return null; // Recently traded this underlying, skip
    }
    // Shorter re-scan cooldown to avoid hammering APIs every cycle (90 seconds)
    const lastScan = this._scanTimestamps?.get(cooldownKey) || 0;
    if (Date.now() - lastScan < 90 * 1000) {
      return null; // Scanned very recently, skip
    }

    this._log('scan', `${underlying}: Starting 0DTE analysis...`);

    // 1. Fetch GEX data (OPTIONAL — failure does not block)
    let gexSummary = null;
    try {
      gexSummary = await this._gexEngine.analyze(underlying, { include_expiries: ['0dte'] });
      this._log('gex', `${underlying}: spot=$${gexSummary.spot}, regime=${gexSummary.regime.label} (${(gexSummary.regime.confidence * 100).toFixed(0)}%), flip=$${gexSummary.gammaFlip || '—'}`);
    } catch (err) {
      this._log('gex', `${underlying}: GEX unavailable (${err.message}) — proceeding with technicals only`);
    }

    // 2. Fetch intraday technicals (5-min bars) — REQUIRED
    let intradayTech;
    const spot = gexSummary?.spot || null;
    try {
      const bars = await alpaca.getIntradayBars(underlying, { timeframe: '5Min', limit: 50 });
      if (bars.length < 10) {
        this._log('tech', `${underlying}: not enough intraday bars (${bars.length}) — skipping`);
        this._markScanned(cooldownKey);
        return null;
      }
      // Use spot from GEX if available, otherwise last close from bars
      const refPrice = spot || bars[bars.length - 1].close;
      intradayTech = this._computeIntradayTechnicals(bars, refPrice);
      this._log('tech', `${underlying}: RSI=${intradayTech.rsi?.toFixed(1) || 'N/A'}, MACD hist=${intradayTech.macd?.histogram?.toFixed(3) || 'N/A'}, momentum=${intradayTech.momentum?.toFixed(2) || '0.00'}%, VWAP=$${intradayTech.vwap?.toFixed(2) || 'N/A'}, vol=${intradayTech.volumeTrend?.toFixed(1) || '1.0'}x`);
    } catch (err) {
      this._log('tech', `${underlying}: intraday data error — ${err.message}`);
      this._markScanned(cooldownKey);
      return null;
    }

    // 3. Determine direction bias
    const gexRegime = gexSummary?.regime || { label: 'Unknown', confidence: 0 };
    const walls = gexSummary?.walls || { callWalls: [], putWalls: [] };
    const gammaFlip = gexSummary?.gammaFlip || null;
    const spotPrice = spot || intradayTech.price;

    const directionSignals = this._assessDirection(intradayTech, gexRegime, walls, gammaFlip, spotPrice, macroRegime);

    // 3b. Check gamma squeeze engine for conviction boost
    const squeezeSignal = gammaSqueeze.getSqueezeSignal(underlying);
    if (squeezeSignal.active) {
      directionSignals.conviction = Math.min(directionSignals.conviction + squeezeSignal.convictionBoost, 10);
      directionSignals.reasons.push(`Gamma squeeze: ${squeezeSignal.state} (${squeezeSignal.convictionBoost > 0 ? '+' : ''}${squeezeSignal.convictionBoost} conviction) — ${squeezeSignal.reason}`);
      if (squeezeSignal.direction && squeezeSignal.direction !== directionSignals.direction) {
        directionSignals.reasons.push(`Squeeze direction (${squeezeSignal.direction}) CONFLICTS with technical direction (${directionSignals.direction})`);
      }
      this._log('squeeze', `${underlying}: squeeze=${squeezeSignal.state}, boost=${squeezeSignal.convictionBoost}, dir=${squeezeSignal.direction}`);
    }

    // 3c. Multi-timeframe 9/20 EMA confluence — blocks low-confluence plays
    let mtfResult = null;
    try {
      mtfResult = await analyzeMTFEMA(underlying);
      const mtfDir = mtfResult.confluenceScore > 0 ? 'bullish' : 'bearish';
      const mtfMatchesDirection = mtfDir === directionSignals.direction;

      directionSignals.conviction = Math.max(1, Math.min(directionSignals.conviction + mtfResult.convictionBoost, 10));
      directionSignals.reasons.push(`MTF EMA: ${mtfResult.consensus} (${mtfResult.confluenceScore > 0 ? '+' : ''}${mtfResult.confluenceScore.toFixed(2)}, boost ${mtfResult.convictionBoost > 0 ? '+' : ''}${mtfResult.convictionBoost}) — ${mtfMatchesDirection ? 'CONFIRMS' : 'CONFLICTS'}`);

      this._log('mtf', `${underlying}: MTF=${mtfResult.consensus}, score=${mtfResult.confluenceScore.toFixed(2)}, boost=${mtfResult.convictionBoost}, bull=${mtfResult.bullishCount} bear=${mtfResult.bearishCount}`);
    } catch (err) {
      this._log('mtf', `${underlying}: MTF EMA unavailable (${err.message}) — proceeding without`);
    }

    this._log('scan', `${underlying}: direction=${directionSignals.direction}, bull=${directionSignals.bullPoints.toFixed(1)} vs bear=${directionSignals.bearPoints.toFixed(1)}, conviction=${directionSignals.conviction}/10, strategy=${directionSignals.strategy}`);

    if (directionSignals.conviction < 3) {
      this._log('scan', `${underlying}: weak directional signals (${directionSignals.conviction}/10) — skipping`);
      this._markScanned(cooldownKey);
      return null;
    }

    // 4. Ask AI for final decision
    this._log('scan', `${underlying}: conviction ${directionSignals.conviction}/10 — asking AI...`);
    const aiDecision = await this._askOptionsAI(underlying, spotPrice, intradayTech, gexSummary || this._buildMinimalGexContext(spotPrice), macroRegime, directionSignals, et);

    // Mark scanned after full analysis completes (90s re-scan cooldown).
    // Trade cooldown (options_cooldown_minutes) only applies after actual execution.
    this._markScanned(cooldownKey);

    if (!aiDecision || aiDecision.action === 'SKIP') {
      const reason = aiDecision?.reason || 'AI says skip';
      this._log('scan', `${underlying}: AI SKIP — ${reason}`);
      return null;
    }

    if (aiDecision.conviction < cfg.options_min_conviction) {
      this._log('scan', `${underlying}: AI conviction ${aiDecision.conviction}/10 below min ${cfg.options_min_conviction} — skipping`);
      return null;
    }

    this._log('scan', `${underlying}: AI says ${aiDecision.action} — conviction ${aiDecision.conviction}/10, strategy: ${aiDecision.strategy || directionSignals.strategy} — PROCEEDING TO EXECUTE`);

    // Map AI action to direction — bare 'BUY' falls back to the technical assessment
    const aiDirection = aiDecision.action === 'BUY_CALL' ? 'bullish'
      : aiDecision.action === 'BUY_PUT' ? 'bearish'
      : directionSignals.direction; // bare 'BUY' keeps technical direction

    return {
      underlying,
      direction: aiDirection,
      optionType: aiDirection === 'bullish' ? 'call' : 'put',
      strategy: aiDecision.strategy || directionSignals.strategy,
      conviction: aiDecision.conviction,
      reason: aiDecision.reason,
      spot: spotPrice,
      gex: gexSummary,
      technicals: intradayTech,
      target: aiDecision.target,
      stopLevel: aiDecision.stopLevel,
    };
  }

  /** Track when we last scanned an underlying (light 90s cooldown) */
  _markScanned(key) {
    if (!this._scanTimestamps) this._scanTimestamps = new Map();
    this._scanTimestamps.set(key, Date.now());
  }

  /** Track when we last TRADED an underlying (full cooldown_minutes cooldown) */
  _markTraded(underlying) {
    if (!this._tradeCooldowns) this._tradeCooldowns = new Map();
    this._tradeCooldowns.set(`opts_${underlying}`, Date.now());
  }

  /** Build minimal GEX context when real GEX is unavailable (so AI prompt doesn't break) */
  _buildMinimalGexContext(spotPrice) {
    return {
      spot: spotPrice,
      regime: { label: 'Unknown', confidence: 0 },
      walls: { callWalls: [], putWalls: [] },
      gammaFlip: null,
    };
  }

  // ── Intraday Technicals ───────────────────────────────────────────

  _computeIntradayTechnicals(bars, currentPrice) {
    const closes = bars.map(b => b.close);
    const volumes = bars.map(b => b.volume);

    // RSI on closes (returns a single number)
    const rsi = technicals.calculateRSI(closes, 14);

    // MACD (returns { macd, signal, histogram } or null)
    const macd = technicals.calculateMACD(closes);

    // Bollinger Bands (returns { upper, middle, lower, width } or null)
    const bb = technicals.calculateBollingerBands(closes, 20);

    // ATR (expects bars with h, l, c keys)
    const atrBars = bars.map(b => ({ h: b.high, l: b.low, c: b.close }));
    const atr = technicals.calculateATR(atrBars, 14);

    // VWAP approximation (cumulative typical price × volume / cumulative volume)
    let cumTPV = 0, cumVol = 0;
    for (let i = 0; i < bars.length; i++) {
      const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
      cumTPV += tp * bars[i].volume;
      cumVol += bars[i].volume;
    }
    const vwap = cumVol > 0 ? cumTPV / cumVol : (currentPrice || 0);

    // Volume trend (last 5 bars vs previous 10)
    const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const earlierVol = volumes.slice(-15, -5).reduce((a, b) => a + b, 0) / Math.max(volumes.slice(-15, -5).length, 1);
    const volumeTrend = earlierVol > 0 ? recentVol / earlierVol : 1;

    // Price momentum (last 5 bars)
    const recentCloses = closes.slice(-5);
    const momentum = recentCloses.length >= 2
      ? ((recentCloses[recentCloses.length - 1] - recentCloses[0]) / recentCloses[0]) * 100
      : 0;

    // Support/Resistance from recent bars
    const lows = bars.map(b => b.low);
    const highs = bars.map(b => b.high);
    const recentLows = lows.slice(-20);
    const recentHighs = highs.slice(-20);
    const nearestSupport = recentLows.length > 0 ? Math.min(...recentLows) : (currentPrice || 0);
    const nearestResistance = recentHighs.length > 0 ? Math.max(...recentHighs) : (currentPrice || 0);

    return {
      price: currentPrice,
      rsi,
      macd,
      bollinger: bb,
      atr,
      vwap,
      volumeTrend,
      momentum,
      nearestSupport,
      nearestResistance,
      bars,
      priceAboveVWAP: currentPrice > vwap,
    };
  }

  // ── Direction Assessment ──────────────────────────────────────────

  /**
   * Score directional signals from all sources.
   * Returns { direction, conviction, strategy, reasons }
   */
  _assessDirection(tech, gexRegime, walls, gammaFlip, spot, macroRegime) {
    let bullPoints = 0;
    let bearPoints = 0;
    const reasons = [];

    // ── MACRO (highest weight for 0DTE) ──
    if (macroRegime.regime === 'RISK_ON') {
      bullPoints += 2;
      reasons.push('Macro RISK_ON (+2 bull)');
    } else if (macroRegime.regime === 'RISK_OFF') {
      bearPoints += 2;
      reasons.push('Macro RISK_OFF (+2 bear)');
    }

    // ── GEX REGIME ──
    if (gexRegime.label === 'Long Gamma' && gexRegime.confidence > 0.4) {
      // Long gamma = mean reversion. Trade reversals at extremes.
      if (tech.rsi < 35) {
        bullPoints += 2;
        reasons.push('Long gamma + oversold RSI → bounce play (+2 bull)');
      } else if (tech.rsi > 65) {
        bearPoints += 2;
        reasons.push('Long gamma + overbought RSI → fade play (+2 bear)');
      }
    } else if (gexRegime.label === 'Short Gamma' && gexRegime.confidence > 0.4) {
      // Short gamma = trend continuation. Ride momentum.
      if (tech.momentum > 0.15) {
        bullPoints += 2;
        reasons.push('Short gamma + bullish momentum → trend continuation (+2 bull)');
      } else if (tech.momentum < -0.15) {
        bearPoints += 2;
        reasons.push('Short gamma + bearish momentum → trend continuation (+2 bear)');
      }
    }

    // ── GEX WALLS (key levels) ──
    const callWall = walls.callWalls?.[0];
    const putWall = walls.putWalls?.[0];

    if (putWall && spot <= putWall.strike * 1.005) {
      bullPoints += 1.5;
      reasons.push(`At put wall $${putWall.strike} → support bounce (+1.5 bull)`);
    }
    if (callWall && spot >= callWall.strike * 0.995) {
      bearPoints += 1.5;
      reasons.push(`At call wall $${callWall.strike} → resistance rejection (+1.5 bear)`);
    }

    // ── GAMMA FLIP ──
    if (gammaFlip) {
      if (spot > gammaFlip * 1.01) {
        bullPoints += 1;
        reasons.push(`Above gamma flip $${gammaFlip} (+1 bull)`);
      } else if (spot < gammaFlip * 0.99) {
        bearPoints += 1;
        reasons.push(`Below gamma flip $${gammaFlip} (+1 bear)`);
      }
    }

    // ── TECHNICALS ──
    // RSI
    if (tech.rsi < 30) {
      bullPoints += 1.5;
      reasons.push(`RSI oversold ${tech.rsi.toFixed(0)} (+1.5 bull)`);
    } else if (tech.rsi > 70) {
      bearPoints += 1.5;
      reasons.push(`RSI overbought ${tech.rsi.toFixed(0)} (+1.5 bear)`);
    }

    // MACD
    if (tech.macd) {
      if (tech.macd.histogram > 0 && tech.macd.macd > tech.macd.signal) {
        bullPoints += 1;
        reasons.push('MACD bullish cross (+1 bull)');
      } else if (tech.macd.histogram < 0 && tech.macd.macd < tech.macd.signal) {
        bearPoints += 1;
        reasons.push('MACD bearish cross (+1 bear)');
      }
    }

    // VWAP
    if (tech.priceAboveVWAP) {
      bullPoints += 0.5;
      reasons.push('Price above VWAP (+0.5 bull)');
    } else {
      bearPoints += 0.5;
      reasons.push('Price below VWAP (+0.5 bear)');
    }

    // Bollinger
    if (tech.bollinger) {
      if (tech.price <= tech.bollinger.lower * 1.002) {
        bullPoints += 1;
        reasons.push('At lower Bollinger band (+1 bull)');
      } else if (tech.price >= tech.bollinger.upper * 0.998) {
        bearPoints += 1;
        reasons.push('At upper Bollinger band (+1 bear)');
      }
    }

    // Volume trend (confirming direction)
    if (tech.volumeTrend > 1.5) {
      if (tech.momentum > 0) bullPoints += 0.5;
      else bearPoints += 0.5;
      reasons.push(`Volume surging ${tech.volumeTrend.toFixed(1)}x (+0.5 direction confirm)`);
    }

    // Calculate total and direction
    const total = bullPoints + bearPoints;
    const direction = bullPoints > bearPoints ? 'bullish' : 'bearish';
    const dominantPoints = Math.max(bullPoints, bearPoints);

    // Conviction: 1-10 scale based on signal strength and clarity
    const clarity = total > 0 ? dominantPoints / total : 0; // how one-sided
    const rawConviction = Math.min(dominantPoints * clarity * 2.5, 10);
    const conviction = Math.round(rawConviction);

    // Strategy: scalp if low ATR / mean-reversion setup, swing if trending
    const atrPct = tech.atr ? tech.atr / tech.price : 0;
    const strategy = (gexRegime.label === 'Short Gamma' || atrPct > 0.005) ? 'swing' : 'scalp';

    return { direction, conviction, strategy, reasons, bullPoints, bearPoints };
  }

  // ── AI Decision ───────────────────────────────────────────────────

  async _askOptionsAI(underlying, spot, tech, gexSummary, macroRegime, directionSignals, et) {
    const prompt = [
      `You are a confident 0DTE options trader who TAKES TRADES when the setup is there. Evaluate this intraday setup and decide: BUY_CALL, BUY_PUT, or SKIP.`,
      `You WANT to trade. Your job is to find the trade, not to find reasons to skip. If the directional signals agree and risk/reward is defined, TAKE THE TRADE. Only SKIP when signals genuinely conflict or there is no clear edge.`,
      ``,
      `═══ CONTEXT ═══`,
      `Ticker: ${underlying} | Spot: $${spot} | Time: ${et.hour}:${String(et.minute).padStart(2, '0')} ET (${et.minutesToClose} min to close)`,
      ``,
      `═══ MACRO ═══`,
      `Regime: ${macroRegime.regime} (score: ${macroRegime.score || 'N/A'})`,
      ``,
      `═══ GEX (GAMMA EXPOSURE) ═══`,
      gexSummary.regime?.label !== 'Unknown' ? `Regime: ${gexSummary.regime.label} (${(gexSummary.regime.confidence * 100).toFixed(0)}% confidence)` : `Regime: UNAVAILABLE (trade based on technicals)`,
      gexSummary.walls?.callWalls?.[0] ? `Call Wall: $${gexSummary.walls.callWalls[0].strike}${gexSummary.walls.callWalls[0].stacked ? ' STACKED' : ''}` : null,
      gexSummary.walls?.putWalls?.[0] ? `Put Wall: $${gexSummary.walls.putWalls[0].strike}${gexSummary.walls.putWalls[0].stacked ? ' STACKED' : ''}` : null,
      gexSummary.gammaFlip ? `Gamma Flip: $${gexSummary.gammaFlip} (spot ${spot > gexSummary.gammaFlip ? 'ABOVE' : 'BELOW'})` : null,
      ``,
      `═══ INTRADAY TECHNICALS (5-min bars) ═══`,
      `RSI(14): ${tech.rsi?.toFixed(1) || 'N/A'}`,
      tech.macd ? `MACD: ${tech.macd.macd.toFixed(3)} | Signal: ${tech.macd.signal.toFixed(3)} | Hist: ${tech.macd.histogram.toFixed(3)}` : null,
      tech.bollinger ? `Bollinger: $${tech.bollinger.lower.toFixed(2)} — $${tech.bollinger.middle.toFixed(2)} — $${tech.bollinger.upper.toFixed(2)}` : null,
      `VWAP: $${tech.vwap?.toFixed(2) || 'N/A'} (price ${tech.priceAboveVWAP ? 'ABOVE' : 'BELOW'})`,
      `ATR: $${tech.atr?.toFixed(2) || 'N/A'} | Momentum(5-bar): ${tech.momentum?.toFixed(2) || '0.00'}%`,
      `Volume: ${tech.volumeTrend?.toFixed(1) || '1.0'}x average`,
      `Support: $${tech.nearestSupport?.toFixed(2) || 'N/A'} | Resistance: $${tech.nearestResistance?.toFixed(2) || 'N/A'}`,
      ``,
      `═══ GAMMA SQUEEZE STATUS ═══`,
      (() => {
        const sq = gammaSqueeze.getSqueezeSignal(underlying);
        if (!sq.active) return 'No active squeeze conditions';
        return `STATE: ${sq.state} | Direction: ${sq.direction || 'unknown'} | Conviction boost: ${sq.convictionBoost > 0 ? '+' : ''}${sq.convictionBoost}\nReason: ${sq.reason}`;
      })(),
      ``,
      `═══ MULTI-TIMEFRAME EMA (9/20) ═══`,
      (() => {
        // MTF data is embedded in direction reasons if available, summarize here
        const mtfReason = directionSignals.reasons.find(r => r.startsWith('MTF EMA:'));
        return mtfReason || 'MTF EMA data not available for this scan';
      })(),
      ``,
      `═══ DIRECTIONAL ASSESSMENT ═══`,
      `Direction: ${directionSignals.direction} | Score: bull ${directionSignals.bullPoints.toFixed(1)} vs bear ${directionSignals.bearPoints.toFixed(1)}`,
      `Pre-conviction: ${directionSignals.conviction}/10 | Suggested strategy: ${directionSignals.strategy}`,
      `Factors:`,
      ...directionSignals.reasons.map(r => `  - ${r}`),
      ``,
      `═══ RULES ═══`,
      `1. 0DTE theta decay is real — but that's why we trade MOMENTUM. If the move is happening NOW, get in.`,
      `2. Use a real level for stop/target: GEX wall, VWAP, Bollinger band, support/resistance. Don't need perfection — just a defined risk.`,
      `3. In Long Gamma: trade mean-reversion (buy dips, sell rips). In Short Gamma: trade trends.`,
      `4. Don't fight the GEX regime. If short gamma and tanking, don't buy calls.`,
      `5. Volume confirms — but absence of volume alone is NOT a reason to skip if other signals align.`,
      `6. Last 45 min: tighter stops, quicker scalps. Last 15 min: probably skip.`,
      `7. If pre-conviction is 5+ and signals agree, you should be giving conviction 6-8. Give 9-10 for perfect setups. Only give below 5 when signals genuinely CONFLICT.`,
      `8. Multi-timeframe EMA alignment is a strong confirmation. If most timeframes agree, be MORE confident, not less.`,
      `9. During an active gamma squeeze, ride the structural edge aggressively. During unwind, exit.`,
      `10. YOU WANT TO TRADE. The system already filtered weak setups before asking you. If you're being asked, there's likely something here. Find the trade.`,
      ``,
      `Respond with ONLY valid JSON:`,
      `{"action": "BUY_CALL" | "BUY_PUT" | "SKIP", "conviction": 1-10, "strategy": "scalp" | "swing", "target": "$X.XX", "stopLevel": "$X.XX", "reason": "1-2 sentences"}`,
    ].filter(Boolean).join('\n');

    try {
      // Lazy-require to break circular dependency chain
      const ai = require('./ai');
      const startTime = Date.now();
      const response = await ai.complete(prompt);
      const durationMs = Date.now() - startTime;

      auditLog.logOllama(`0DTE_${underlying}`, prompt, response, durationMs);

      if (!response) return null;

      const jsonMatch = response.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        action: parsed.action?.toUpperCase() || 'SKIP',
        conviction: Number(parsed.conviction) || 0,
        strategy: parsed.strategy?.toLowerCase() || 'scalp',
        target: parsed.target || null,
        stopLevel: parsed.stopLevel || null,
        reason: parsed.reason || '',
      };
    } catch (err) {
      this._log('error', `AI decision error for ${underlying}: ${err.message}`);
      return null;
    }
  }

  // ── Contract Selection ────────────────────────────────────────────

  /**
   * Select the optimal contract for a given signal.
   * Picks based on delta range, spread quality, and liquidity.
   */
  async _selectContract(signal) {
    const cfg = policy.getConfig();
    const { underlying, optionType, spot } = signal;
    const et = this._getETTime();

    try {
      // Try Public.com first (real-time greeks), fall back to Alpaca
      let options = [];
      let hasRealGreeks = false;

      if (publicApi.enabled) {
        try {
          options = await publicApi.getOptionsWithGreeks(underlying, et.todayString, optionType);
          hasRealGreeks = options.some(o => o.delta && Math.abs(o.delta) > 0.01);
          if (options.length > 0) {
            this._log('contract', `${underlying}: using Public.com data (${options.length} contracts, greeks=${hasRealGreeks ? 'real' : 'missing'})`);
          }
        } catch (err) {
          console.error(`[0DTE] Public.com chain error for ${underlying}: ${err.message} — falling back to Alpaca`);
          options = [];
        }
      }

      // Fallback: Alpaca indicative feed
      if (options.length === 0) {
        options = await alpaca.getOptionsSnapshots(underlying, et.todayString, optionType);
        hasRealGreeks = options.some(o => o.delta && Math.abs(o.delta) > 0.01);
        if (options.length > 0) {
          this._log('contract', `${underlying}: using Alpaca data (${options.length} contracts, greeks=${hasRealGreeks ? 'real' : 'indicative'})`);
        }
      }

      if (options.length === 0) {
        this._log('contract', `${underlying}: no ${optionType} options for ${et.todayString}`);
        return null;
      }

      // If neither source has real greeks, estimate from moneyness
      if (!hasRealGreeks && spot) {
        this._log('contract', `${underlying}: no delta data from feed — estimating from moneyness (spot=$${spot})`);
        // Approximate delta from moneyness for 0DTE:
        //   ATM ≈ 0.50, each 1% OTM ≈ −0.10 delta, capped at [0.02, 0.95]
        for (const opt of options) {
          const pctOTM = optionType === 'call'
            ? (opt.strike - spot) / spot
            : (spot - opt.strike) / spot;
          // Negative pctOTM means ITM
          const approxDelta = Math.max(0.02, Math.min(0.95, 0.50 - pctOTM * 10));
          opt.delta = approxDelta;
          opt._estimatedDelta = true;
        }
      }

      // Time-adaptive delta range: widen near end of day for 0DTE
      // Late-day 0DTE deltas compress and can be extreme — rigid ranges miss contracts
      let minDelta = cfg.options_min_delta;
      let maxDelta = cfg.options_max_delta;
      if (et.minutesToClose < 120) {
        minDelta = Math.max(0.08, minDelta - 0.05);
        maxDelta = Math.min(0.85, maxDelta + 0.05);
      }
      if (et.minutesToClose < 60) {
        minDelta = Math.max(0.05, minDelta - 0.10);
        maxDelta = Math.min(0.90, maxDelta + 0.10);
      }

      // Filter by delta range and minimum open interest
      // Use relaxed OI threshold when greeks are estimated (feed may also have sparse OI)
      const minOI = hasRealGreeks ? (cfg.options_min_open_interest || 500) : Math.min(cfg.options_min_open_interest || 500, 100);
      let candidates = options.filter(opt => {
        const absDelta = Math.abs(opt.delta || 0);
        if (absDelta < minDelta || absDelta > maxDelta) return false;
        if ((opt.openInterest || 0) < minOI) return false;
        // Must have a valid bid/ask
        if (!opt.bid || !opt.ask || opt.ask <= 0) return false;
        return true;
      });

      // Fallback: if no candidates with OI filter, relax OI to any contract with a live quote
      if (candidates.length === 0) {
        this._log('contract', `${underlying}: no contracts with OI >= ${minOI} — relaxing OI filter`);
        candidates = options.filter(opt => {
          const absDelta = Math.abs(opt.delta || 0);
          if (absDelta < minDelta || absDelta > maxDelta) return false;
          if (!opt.bid || !opt.ask || opt.ask <= 0) return false;
          return true;
        });
      }

      if (candidates.length === 0) {
        this._log('contract', `${underlying}: no contracts matching delta [${minDelta.toFixed(2)}-${maxDelta.toFixed(2)}] (${options.length} options checked, greeks=${hasRealGreeks ? 'real' : 'estimated'})`);
        return null;
      }

      // Score each candidate
      const scored = candidates.map(opt => {
        const bid = opt.bid || 0;
        const ask = opt.ask || 0;
        const mid = (bid + ask) / 2;
        const spread = mid > 0 ? (ask - bid) / mid : 1;
        const absDelta = Math.abs(opt.delta || 0);
        const volume = opt.volume || 0;
        const oi = opt.openInterest || 0;

        // Score: favor tight spread, good delta, high OI, decent volume
        let score = 0;
        if (spread < 0.05) score += 3;
        else if (spread < 0.10) score += 2;
        else if (spread < 0.15) score += 1;

        // Prefer delta around 0.35-0.45 (sweet spot)
        if (absDelta >= 0.35 && absDelta <= 0.45) score += 2;
        else if (absDelta >= 0.30 && absDelta <= 0.50) score += 1;

        // Liquidity
        if (oi > 1000) score += 2;
        else if (oi > 500) score += 1;
        else if (oi > 100) score += 0.5;
        if (volume > 100) score += 1;
        else if (volume > 10) score += 0.5;

        return { ...opt, mid, spread, score };
      });

      // Sort by score descending, then by spread ascending
      scored.sort((a, b) => b.score - a.score || a.spread - b.spread);

      const best = scored[0];
      if (!best) return null;

      // Check spread is within limit (wider tolerance when delta was estimated)
      const maxSpread = hasRealGreeks ? cfg.options_max_spread_pct : Math.max(cfg.options_max_spread_pct, 0.20);
      if (best.spread > maxSpread) {
        this._log('contract', `${underlying}: best contract spread ${(best.spread * 100).toFixed(1)}% exceeds max ${(maxSpread * 100).toFixed(0)}%`);
        return null;
      }

      this._log('contract', `${underlying}: selected ${best.symbol} — strike $${best.strike}, delta ${best.delta?.toFixed(2)}${best._estimatedDelta ? ' (est)' : ''}, mid $${best.mid.toFixed(2)}, spread ${(best.spread * 100).toFixed(1)}%, OI ${best.openInterest}`);

      return best;
    } catch (err) {
      this._log('error', `Contract selection error for ${underlying}: ${err.message}`);
      return null;
    }
  }

  // ── Order Execution ───────────────────────────────────────────────

  async _executeEntry(signal, account, currentOptionsPositions, et) {
    const cfg = policy.getConfig();

    // 1. Select contract
    const contract = await this._selectContract(signal);
    if (!contract) {
      return { success: false, reason: 'No suitable contract found' };
    }

    // 2. Calculate position size
    const mid = contract.mid || ((contract.bid + contract.ask) / 2);
    const premium = mid * 100; // premium per contract
    const maxContracts = Math.floor(cfg.options_max_premium_per_trade / premium);
    const qty = Math.max(1, Math.min(maxContracts, 3)); // 1-3 contracts
    const totalPremium = premium * qty;

    // 3. Risk validation
    const riskCheck = policy.evaluateOptionsOrder({
      underlying: signal.underlying,
      premium: totalPremium,
      qty,
      currentOptionsPositions,
      delta: contract.delta,
      spreadPct: contract.spread,
      conviction: signal.conviction,
      minutesToClose: et.minutesToClose,
    });

    if (!riskCheck.allowed) {
      this._log('blocked', `${signal.underlying}: ${riskCheck.violations.join('; ')}`);
      return { success: false, reason: riskCheck.violations.join('; ') };
    }

    // 4. Execute limit order at mid price (slight edge)
    const limitPrice = Math.round(mid * 100) / 100; // round to pennies

    try {
      const order = await alpaca.createOptionsOrder({
        symbol: contract.symbol,
        qty,
        side: 'buy',
        type: 'limit',
        limit_price: limitPrice,
        time_in_force: 'day',
      });

      // Track the trade
      const trade = {
        symbol: contract.symbol,
        underlying: signal.underlying,
        strike: contract.strike,
        optionType: signal.optionType,
        strategy: signal.strategy,
        qty,
        entryPrice: limitPrice,
        entryTime: new Date().toISOString(),
        conviction: signal.conviction,
        reason: signal.reason,
        orderId: order?.id,
      };
      this._activeTrades.set(contract.symbol, trade);
      this._persistTrades();

      policy.recordOptionsTrade(signal.underlying);
      this._markTraded(signal.underlying);

      this._log('trade', `BUY ${qty}x ${contract.symbol} @ $${limitPrice} (${signal.strategy}) — conviction ${signal.conviction}/10`);

      // Discord alert
      if (this._postToChannel) {
        const warnings = riskCheck.warnings?.length > 0 ? `\n⚠️ ${riskCheck.warnings.join('\n⚠️ ')}` : '';
        await this._postToChannel(
          `🎯 **0DTE Entry: ${signal.underlying} $${contract.strike} ${signal.optionType.toUpperCase()}**\n` +
          `Contracts: \`${qty}\` | Premium: \`$${limitPrice}\` | Total: \`$${totalPremium.toFixed(0)}\`\n` +
          `Strategy: \`${signal.strategy}\` | Conviction: \`${signal.conviction}/10\`\n` +
          `Delta: \`${contract.delta?.toFixed(2)}\` | Spread: \`${(contract.spread * 100).toFixed(1)}%\`\n` +
          `Reason: ${signal.reason}` +
          warnings +
          `\n_${alpaca.isPaper ? 'Paper' : 'LIVE'} | Autonomous 0DTE trade_`
        );
      }

      return { success: true, order };
    } catch (err) {
      this._log('error', `Order failed for ${contract.symbol}: ${err.message}`);
      return { success: false, reason: err.message };
    }
  }

  // ── Alert Trigger (TradingView → Options Engine) ─────────────────

  /**
   * Trigger the 0DTE pipeline from an external alert (TradingView webhook).
   *
   * Unlike the scheduled cycle, this is event-driven: a TradingView signal
   * like "BULLISH" or "PUMP INCOMING" acts as a directional HINT, not a
   * complete trade plan. The engine runs its own full analysis (GEX,
   * technicals, AI conviction, contract selection) and decides independently.
   *
   * @param {object} alert - Parsed alert from spy-alerts.js
   * @param {string} alert.action - 'BUY', 'SELL', 'TAKE_PROFIT', 'ALERT'
   * @param {string} alert.ticker - Underlying symbol (default SPY)
   * @param {number} [alert.price] - Alert trigger price
   * @param {string} [alert.confidence] - Source confidence (LOW/MEDIUM/HIGH)
   * @param {string} [alert.reason] - Signal text
   * @param {string} [alert.interval] - Timeframe (1m, 5m, etc.)
   */
  async triggerFromAlert(alert) {
    const cfg = policy.getConfig();
    if (!cfg.options_enabled) return;
    if (!alpaca.enabled) return;

    if (circuitBreaker.isPaused()) {
      this._log('alert_trigger', 'Circuit breaker active — ignoring alert trigger');
      return;
    }

    if (!this._isMarketHours()) return;

    const underlying = (alert.ticker || 'SPY').toUpperCase();

    // Only process directional signals (BUY/SELL), skip TP and generic ALERT
    if (alert.action !== 'BUY' && alert.action !== 'SELL') {
      this._log('alert_trigger', `${underlying}: ignoring non-directional alert (${alert.action})`);
      return;
    }

    // Map alert direction to our hint format
    const directionHint = alert.action === 'BUY' ? 'bullish' : 'bearish';

    this._log('alert_trigger', `${underlying}: TradingView ${alert.action} signal received — "${alert.reason || alert.action}" [${alert.confidence || 'no conf'}] — running full analysis`);

    const et = this._getETTime();

    // Skip first 15 min after open
    const minutesSinceOpen = et.minutesToClose > 0
      ? (MARKET_CLOSE_HOUR * 60) - et.minutesToClose - (MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MIN)
      : 0;
    if (minutesSinceOpen < 15) {
      this._log('alert_trigger', `${underlying}: too early after open (${minutesSinceOpen} min) — skipping`);
      return;
    }

    // Check position capacity
    const optionsPositions = await alpaca.getOptionsPositions();
    if (optionsPositions.length >= cfg.options_max_positions) {
      this._log('alert_trigger', `${underlying}: max positions reached (${optionsPositions.length}/${cfg.options_max_positions})`);
      return;
    }

    if (et.minutesToClose <= cfg.options_close_before_minutes) {
      this._log('alert_trigger', `${underlying}: too close to market close (${et.minutesToClose} min)`);
      return;
    }

    try {
      // 1. Account info
      const account = await alpaca.getAccount();
      const equity = Number(account.equity || 0);
      policy.resetDaily(equity);

      // 2. Macro regime — don't block on CAUTIOUS for alert-triggered trades
      let macroRegime = { regime: 'CAUTIOUS', score: 0 };
      try {
        macroRegime = await macro.getRegime();
      } catch (err) {
        this._log('alert_trigger', `${underlying}: macro unavailable — proceeding with CAUTIOUS`);
      }

      // Still block on RISK_OFF
      if (macroRegime.regime === 'RISK_OFF') {
        this._log('alert_trigger', `${underlying}: RISK_OFF — blocking alert-triggered trade`);
        return;
      }

      // 3. GEX analysis (OPTIONAL — failure does NOT block alert trades)
      let gexSummary = null;
      try {
        gexSummary = await this._gexEngine.analyze(underlying, { include_expiries: ['0dte'] });
        this._log('alert_trigger', `${underlying}: GEX=${gexSummary.regime.label} (${(gexSummary.regime.confidence * 100).toFixed(0)}%), spot=$${gexSummary.spot}, flip=$${gexSummary.gammaFlip || '—'}`);
      } catch (err) {
        this._log('alert_trigger', `${underlying}: GEX unavailable (${err.message}) — proceeding with technicals`);
      }

      // 4. Intraday technicals — REQUIRED
      let intradayTech;
      const spot = gexSummary?.spot || null;
      try {
        const bars = await alpaca.getIntradayBars(underlying, { timeframe: '5Min', limit: 50 });
        if (bars.length < 10) {
          this._log('alert_trigger', `${underlying}: not enough bars (${bars.length})`);
          return;
        }
        const refPrice = spot || bars[bars.length - 1].close;
        intradayTech = this._computeIntradayTechnicals(bars, refPrice);
      } catch (err) {
        this._log('alert_trigger', `${underlying}: intraday data error — ${err.message}`);
        return;
      }

      const spotPrice = spot || intradayTech.price;

      // 5. Direction assessment — factor in the alert hint
      const gexRegime = gexSummary?.regime || { label: 'Unknown', confidence: 0 };
      const walls = gexSummary?.walls || { callWalls: [], putWalls: [] };
      const gammaFlip = gexSummary?.gammaFlip || null;
      const directionSignals = this._assessDirection(intradayTech, gexRegime, walls, gammaFlip, spotPrice, macroRegime);

      // 5b. Boost conviction from TradingView alert (+2 if confirms, 0 if conflicts)
      // External signal confirmation is worth more than internal indicators
      let adjustedConviction = directionSignals.conviction;
      const alertMatchesAnalysis = directionSignals.direction === directionHint;
      if (alertMatchesAnalysis) {
        adjustedConviction = Math.min(adjustedConviction + 2, 10);
        directionSignals.reasons.push(`TradingView ${alert.action} signal CONFIRMS direction (+2 conviction)`);
      } else {
        directionSignals.reasons.push(`TradingView ${alert.action} signal conflicts with ${directionSignals.direction} analysis`);
      }

      // 5c. Confidence boost from TradingView signal strength
      if (alert.confidence === 'HIGH') {
        adjustedConviction = Math.min(adjustedConviction + 1, 10);
        directionSignals.reasons.push('TradingView HIGH confidence (+1 conviction)');
      }

      // 5d. Gamma squeeze signal boost (same as scan path)
      const squeezeSignal = gammaSqueeze.getSqueezeSignal(underlying);
      if (squeezeSignal.active) {
        adjustedConviction = Math.min(adjustedConviction + squeezeSignal.convictionBoost, 10);
        directionSignals.reasons.push(`Gamma squeeze: ${squeezeSignal.state} (${squeezeSignal.convictionBoost > 0 ? '+' : ''}${squeezeSignal.convictionBoost})`);
      }

      // 5e. MTF EMA confluence (same as scan path)
      let mtfResult = null;
      try {
        mtfResult = await analyzeMTFEMA(underlying);
        adjustedConviction = Math.max(1, Math.min(adjustedConviction + mtfResult.convictionBoost, 10));
        directionSignals.reasons.push(`MTF EMA: ${mtfResult.consensus} (${mtfResult.convictionBoost > 0 ? '+' : ''}${mtfResult.convictionBoost})`);
      } catch (err) {
        this._log('alert_trigger', `${underlying}: MTF unavailable (${err.message})`);
      }

      directionSignals.conviction = adjustedConviction;

      this._log('alert_trigger', `${underlying}: direction=${directionSignals.direction}, conviction=${adjustedConviction}/10 (alert ${alertMatchesAnalysis ? 'CONFIRMS' : 'conflicts'}), strategy=${directionSignals.strategy}`);

      // Alert-triggered trades have an external signal — lower floor to 2
      if (adjustedConviction < 2) {
        this._log('alert_trigger', `${underlying}: very weak signals (${adjustedConviction}/10) even with TradingView alert — skipping`);
        return;
      }

      // 6. AI decision — pass the alert context for extra information
      const gexContext = gexSummary || this._buildMinimalGexContext(spotPrice);
      const aiDecision = await this._askOptionsAI(underlying, spotPrice, intradayTech, gexContext, macroRegime, { ...directionSignals, conviction: adjustedConviction }, et);

      if (!aiDecision || aiDecision.action === 'SKIP') {
        const reason = aiDecision?.reason || 'AI says skip';
        this._log('alert_trigger', `${underlying}: AI SKIP — ${reason}`);
        return;
      }

      if (aiDecision.conviction < cfg.options_min_conviction) {
        this._log('alert_trigger', `${underlying}: AI conviction ${aiDecision.conviction}/10 below min ${cfg.options_min_conviction}`);
        return;
      }

      this._log('alert_trigger', `${underlying}: AI ${aiDecision.action} — conviction ${aiDecision.conviction}/10 — EXECUTING from TradingView alert`);

      // 7. Build signal and execute
      const signal = {
        underlying,
        direction: (aiDecision.action === 'BUY_CALL' || aiDecision.action === 'BUY') ? 'bullish' : 'bearish',
        optionType: (aiDecision.action === 'BUY_CALL' || aiDecision.action === 'BUY') ? 'call' : 'put',
        strategy: aiDecision.strategy || directionSignals.strategy,
        conviction: aiDecision.conviction,
        reason: `Alert trigger: "${alert.reason || alert.action}" → ${aiDecision.reason}`,
        spot: spotPrice,
        gex: gexSummary,
        technicals: intradayTech,
        target: aiDecision.target,
        stopLevel: aiDecision.stopLevel,
      };

      const result = await this._executeEntry(signal, account, optionsPositions.length, et);
      if (result.success) {
        this._log('alert_trigger', `${underlying}: TRADE EXECUTED from alert trigger`);
      } else {
        this._log('alert_trigger', `${underlying}: execution failed — ${result.reason}`);
      }
    } catch (err) {
      this._log('error', `Alert trigger error for ${underlying}: ${err.message}`);
    }
  }

  // ── Manual Trade ──────────────────────────────────────────────────

  /**
   * Manually trigger the 0DTE pipeline for a specific underlying.
   * @param {string} underlying - SPY, QQQ, etc.
   * @param {object} [opts]
   * @param {string} [opts.direction] - 'call' or 'put' (override AI)
   * @param {string} [opts.strategy] - 'scalp' or 'swing'
   * @returns {{ success: boolean, message: string, details?: object }}
   */
  async manualTrade(underlying, { direction, strategy } = {}) {
    underlying = underlying.toUpperCase();

    if (!alpaca.enabled) {
      return { success: false, message: 'Alpaca API not configured.' };
    }

    const cfg = policy.getConfig();
    if (!cfg.options_enabled) {
      return { success: false, message: 'Options trading is disabled. Use `/agent set key:options_enabled value:true` to enable.' };
    }

    if (policy.killSwitch) {
      return { success: false, message: 'Kill switch is active — trading halted.' };
    }

    const et = this._getETTime();
    const steps = [];

    // 1. Account info
    let account;
    try {
      account = await alpaca.getAccount();
    } catch (err) {
      return { success: false, message: `Account fetch failed: ${err.message}` };
    }
    steps.push(`Account: $${Number(account.equity).toFixed(0)} equity`);

    // 2. Macro regime
    let macroRegime = { regime: 'CAUTIOUS', score: 0 };
    try {
      macroRegime = await macro.getRegime();
      steps.push(`Macro: ${macroRegime.regime}`);
    } catch (err) {
      steps.push(`Macro: unavailable`);
    }

    // 3. GEX analysis
    let gexSummary;
    try {
      gexSummary = await this._gexEngine.analyze(underlying, { include_expiries: ['0dte'] });
      steps.push(`GEX: ${gexSummary.regime?.label || 'Unknown'} (${((gexSummary.regime?.confidence || 0) * 100).toFixed(0)}%), flip $${gexSummary.gammaFlip || '—'}`);
    } catch (err) {
      steps.push(`GEX: unavailable (${err.message})`);
      return { success: false, message: `GEX analysis failed: ${err.message}`, details: { steps } };
    }

    // 4. Intraday technicals
    let tech;
    try {
      const bars = await alpaca.getIntradayBars(underlying, { timeframe: '5Min', limit: 50 });
      tech = this._computeIntradayTechnicals(bars, gexSummary.spot);
      steps.push(`Technicals: RSI ${tech.rsi?.toFixed(1) || 'N/A'}, momentum ${tech.momentum?.toFixed(2) || '0.00'}%, VWAP $${tech.vwap?.toFixed(2) || 'N/A'}`);
    } catch (err) {
      return { success: false, message: `Intraday data error: ${err.message}`, details: { steps } };
    }

    // 5. Direction
    const dirSignals = this._assessDirection(tech, gexSummary.regime, gexSummary.walls, gexSummary.gammaFlip, gexSummary.spot, macroRegime);
    let finalDirection = direction || (dirSignals.direction === 'bullish' ? 'call' : 'put');
    const finalStrategy = strategy || dirSignals.strategy;
    steps.push(`Direction: ${dirSignals.direction} (${dirSignals.conviction}/10), strategy: ${finalStrategy}`);

    // 6. AI decision (unless direction was forced)
    let conviction = dirSignals.conviction;
    let reason = dirSignals.reasons.join('; ');

    if (!direction) {
      const aiDecision = await this._askOptionsAI(underlying, gexSummary.spot, tech, gexSummary, macroRegime, dirSignals, et);
      if (aiDecision) {
        conviction = aiDecision.conviction;
        reason = aiDecision.reason;
        steps.push(`AI: ${aiDecision.action} — conviction ${aiDecision.conviction}/10`);
        if (aiDecision.action === 'SKIP') {
          return { success: false, message: `AI says SKIP: ${aiDecision.reason}`, details: { steps } };
        }
        // Let the AI override direction — it may see a put setup the technicals missed
        if (aiDecision.action === 'BUY_CALL') {
          finalDirection = 'call';
        } else if (aiDecision.action === 'BUY_PUT') {
          finalDirection = 'put';
        }
        // Note: bare 'BUY' keeps the technical direction (finalDirection unchanged)
      } else {
        steps.push(`AI: no response`);
      }
    } else {
      steps.push(`Direction forced: ${direction}`);
    }

    // 7. Build signal and execute
    const signal = {
      underlying,
      direction: finalDirection === 'call' ? 'bullish' : 'bearish',
      optionType: finalDirection,
      strategy: finalStrategy,
      conviction,
      reason,
      spot: gexSummary.spot,
      gex: gexSummary,
      technicals: tech,
    };

    const optionsPositions = await alpaca.getOptionsPositions();
    const result = await this._executeEntry(signal, account, optionsPositions.length, et);

    if (result.success) {
      steps.push(`ORDER PLACED: ${signal.optionType} on ${underlying}`);
      return { success: true, message: `0DTE ${signal.optionType.toUpperCase()} on ${underlying} — order placed.`, details: { steps } };
    } else {
      steps.push(`ORDER FAILED: ${result.reason}`);
      return { success: false, message: `Order failed: ${result.reason}`, details: { steps } };
    }
  }

  // ── Status ────────────────────────────────────────────────────────

  async getStatus() {
    const cfg = policy.getConfig();
    const optionsPositions = await alpaca.getOptionsPositions().catch(() => []);
    const et = this._getETTime();

    return {
      enabled: cfg.options_enabled,
      paper: alpaca.isPaper,
      activePositions: optionsPositions.length,
      maxPositions: cfg.options_max_positions,
      dailyLoss: policy.optionsDailyLoss,
      maxDailyLoss: cfg.options_max_daily_loss,
      minutesToClose: et.minutesToClose,
      isMarketHours: this._isMarketHours(),
      positions: optionsPositions.map(p => {
        const parsed = alpaca._parseOccSymbol(p.symbol);
        const tracked = this._activeTrades.get(p.symbol);
        return {
          symbol: p.symbol,
          underlying: parsed.underlying,
          strike: parsed.strike,
          type: parsed.type,
          qty: p.qty,
          avgEntry: Number(p.avg_entry_price || 0),
          marketValue: Number(p.market_value || 0),
          unrealizedPL: Number(p.unrealized_pl || 0),
          unrealizedPLPct: Number(p.unrealized_plpc || 0),
          strategy: tracked?.strategy || 'unknown',
          conviction: tracked?.conviction || 0,
        };
      }),
      config: {
        maxPremium: cfg.options_max_premium_per_trade,
        scalpTP: `${(cfg.options_scalp_take_profit_pct * 100).toFixed(0)}%`,
        scalpSL: `${(cfg.options_scalp_stop_loss_pct * 100).toFixed(0)}%`,
        swingTP: `${(cfg.options_swing_take_profit_pct * 100).toFixed(0)}%`,
        swingSL: `${(cfg.options_swing_stop_loss_pct * 100).toFixed(0)}%`,
        minConviction: cfg.options_min_conviction,
        underlyings: cfg.options_underlyings,
      },
      recentLogs: this._logs.slice(-10),
    };
  }

  // ── Discord Formatting ────────────────────────────────────────────

  formatStatusForDiscord(status) {
    const lines = [
      `**0DTE Options Trading Engine**`,
      `Mode: ${status.paper ? '📄 Paper' : '💵 LIVE'} | Engine: ${status.enabled ? '🟢 **ENABLED**' : '🔴 **DISABLED**'}`,
      `Market: ${status.isMarketHours ? '🟢 Open' : '🔴 Closed'} (${status.minutesToClose} min to close)`,
      ``,
    ];

    // Positions
    if (status.positions.length > 0) {
      lines.push(`**Open Positions** (${status.activePositions}/${status.maxPositions})`);
      for (const p of status.positions) {
        const pnl = p.unrealizedPL;
        const emoji = pnl >= 0 ? '🟢' : '🔴';
        lines.push(`${emoji} **${p.underlying} $${p.strike} ${p.type.toUpperCase()}** — ${p.qty}x @ $${p.avgEntry.toFixed(2)} | P/L: $${pnl.toFixed(2)} (${(p.unrealizedPLPct * 100).toFixed(1)}%) | ${p.strategy}`);
      }
      lines.push(``);
    } else {
      lines.push(`_No open options positions_`);
      lines.push(``);
    }

    // Risk
    lines.push(`**Risk**`);
    lines.push(`Daily Loss: \`$${status.dailyLoss.toFixed(0)}/$${status.maxDailyLoss}\``);
    lines.push(`Max Premium/Trade: \`$${status.config.maxPremium}\``);
    lines.push(`Scalp: TP \`${status.config.scalpTP}\` / SL \`${status.config.scalpSL}\``);
    lines.push(`Swing: TP \`${status.config.swingTP}\` / SL \`${status.config.swingSL}\``);
    lines.push(`Min Conviction: \`${status.config.minConviction}/10\``);
    lines.push(`Underlyings: \`${status.config.underlyings.join(', ')}\``);

    return lines.join('\n');
  }

  // ── Persistence ───────────────────────────────────────────────────

  _persistTrades() {
    const trades = [...this._activeTrades.values()];
    this._storage.set('activeTrades', trades);
  }
}

module.exports = new OptionsEngine();
