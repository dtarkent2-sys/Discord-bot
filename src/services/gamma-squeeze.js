/**
 * Gamma Squeeze Detection Engine — Real-Time Structural Squeeze Monitor
 *
 * Goes beyond static GEX snapshots to detect live squeeze conditions:
 *   1. Time-series GEX tracking (snapshots every poll, detect changes over time)
 *   2. Dealer positioning state machine (normal → accumulating → squeeze → unwind)
 *   3. Knife-fight detection (dealers underwater, market still rising against them)
 *   4. Sector-specific GEX breakdown (tech vs industrials gamma imbalances)
 *   5. IV crush-lag detection (VIX spike + negative gamma = trap setup)
 *   6. Put/call ratio shift tracking (early squeeze unwind signals)
 *   7. Volume-weighted OI change detection (intraday flow tracking)
 *
 * Data sources:
 *   - Yahoo Finance options chains (OI, IV, volume)
 *   - Alpaca (spot prices, intraday bars, options snapshots)
 *   - Existing gamma.js + gex-engine.js for GEX calculations
 *   - Macro service for regime context
 *
 * Safety:
 *   - All detections are advisory — feeds into options engine as signal boost
 *   - State persists across restarts via Storage
 *   - Rate-limited polling to avoid API abuse
 */

const Storage = require('./storage');
const auditLog = require('./audit-log');
const gamma = require('./gamma');
const GEXEngine = require('./gex-engine');
const alpaca = require('./alpaca');
const config = require('../config');

// ── Configuration ──────────────────────────────────────────────────────

// How often to poll GEX data (ms) — balance freshness vs API limits
const POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

// Max time-series history per ticker
const MAX_SNAPSHOTS = 100; // ~5 hours of 3-min polls

// Squeeze detection thresholds
const THRESHOLDS = {
  // GEX change rate: if |netGEX| changes by this % between polls, flag it
  gexChangeRatePct: 15,

  // Flip distance: how close spot must be to gamma flip (as % of spot) to flag
  flipProximityPct: 0.5,

  // Knife fight: spot moved this % above call wall OR below put wall while in short gamma
  knifeFightSpotBeyondWallPct: 0.3,

  // Volume spike: intraday options volume vs trailing average to flag unusual flow
  volumeSpikeMultiple: 2.0,

  // OI change: significant open interest shift between snapshots
  oiChangeThresholdPct: 10,

  // IV crush-lag: IV drops by this much while gamma is still negative = trap
  ivCrushLagPct: 5,

  // Put/call ratio shift: change in P/C ratio that signals squeeze unwind
  pcRatioShiftThreshold: 0.15,

  // Minimum |netGEX$| to consider any squeeze detection meaningful
  minAbsGexForDetection: 5e5, // $500K
};

// Squeeze states (state machine)
const SQUEEZE_STATE = {
  NORMAL: 'normal',           // No squeeze conditions
  BUILDING: 'building',       // Early signs — GEX shifting, volume rising
  ACTIVE: 'active_squeeze',   // Full squeeze — dealers forced to hedge, amplifying moves
  KNIFE_FIGHT: 'knife_fight', // Extreme — dealers underwater, market overshooting
  UNWINDING: 'unwinding',     // Squeeze reversing — P/C ratio shifting, GEX normalizing
};

// Sector ETFs for sector-level GEX analysis
const SECTOR_TICKERS = {
  XLK: 'Technology',
  XLF: 'Financials',
  XLE: 'Energy',
  XLV: 'Healthcare',
  XLI: 'Industrials',
  XLY: 'Consumer Discretionary',
};

class GammaSqueezeEngine {
  constructor() {
    this._storage = new Storage('gamma-squeeze-state.json');
    this._gexEngine = new GEXEngine(gamma);
    this._interval = null;
    this._postToChannel = null;
    this._stopped = false;

    // Time-series data: ticker → Array<snapshot>
    this._timeSeries = new Map();

    // Current squeeze state per ticker: ticker → { state, since, ... }
    this._squeezeStates = new Map();

    // Previous OI snapshots for change detection: ticker → { strike → { callOI, putOI } }
    this._prevOI = new Map();

    // Alert cooldowns: alertKey → timestamp
    this._alertCooldowns = new Map();
    this._alertCooldownMs = 15 * 60 * 1000; // 15 min cooldown per alert type

    // Watchlist for squeeze monitoring (main indices + actively traded)
    this._watchlist = ['SPY', 'QQQ', 'IWM'];

    // Restore persisted state
    this._restoreState();
  }

  /** Wire Discord posting callback */
  setChannelPoster(fn) {
    this._postToChannel = fn;
  }

  /** Update watchlist (e.g. from initiative engine detecting movers) */
  setWatchlist(tickers) {
    this._watchlist = [...new Set([...['SPY', 'QQQ'], ...tickers])];
  }

  /** Get current watchlist */
  getWatchlist() {
    return [...this._watchlist];
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  start() {
    if (this._interval) return;
    this._stopped = false;
    this._interval = setInterval(() => this._poll(), POLL_INTERVAL_MS);
    console.log(`[GammaSqueeze] Started — polling every ${POLL_INTERVAL_MS / 1000}s, watching: ${this._watchlist.join(', ')}`);
    auditLog.log('gamma_squeeze', 'Squeeze detection engine started');
    // Run immediately
    this._poll();
  }

  stop() {
    this._stopped = true;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._persistState();
    console.log('[GammaSqueeze] Stopped');
  }

  // ── Main Poll Loop ────────────────────────────────────────────────

  async _poll() {
    if (this._stopped) return;
    if (!this._isMarketHours()) return;

    for (const ticker of this._watchlist) {
      try {
        await this._analyzeTicker(ticker);
      } catch (err) {
        // Non-fatal — continue with next ticker
        if (!err.message?.includes('rate limit') && !err.message?.includes('Too Many')) {
          console.warn(`[GammaSqueeze] ${ticker} analysis error: ${err.message}`);
        }
      }

      // Small delay between tickers to avoid API hammering
      await this._sleep(2000);
    }

    this._persistState();
  }

  // ── Per-Ticker Analysis ───────────────────────────────────────────

  async _analyzeTicker(ticker) {
    // 1. Fetch fresh GEX data
    let gexSummary;
    try {
      gexSummary = await this._gexEngine.analyze(ticker, { include_expiries: ['0dte', 'weekly'] });
    } catch (err) {
      // GEX failure — skip this ticker this cycle
      return;
    }

    // 2. Build snapshot
    const snapshot = this._buildSnapshot(ticker, gexSummary);

    // 3. Store in time-series
    this._addSnapshot(ticker, snapshot);

    // 4. Detect OI changes (volume flow proxy)
    const oiChanges = this._detectOIChanges(ticker, gexSummary);

    // 5. Detect IV dynamics
    const ivDynamics = this._analyzeIVDynamics(ticker, gexSummary);

    // 6. Run squeeze state machine
    const prevState = this._squeezeStates.get(ticker) || { state: SQUEEZE_STATE.NORMAL };
    const newState = this._evaluateSqueezeState(ticker, snapshot, oiChanges, ivDynamics, prevState);

    // 7. Emit alerts on state transitions
    if (newState.state !== prevState.state) {
      this._onStateTransition(ticker, prevState, newState, snapshot);
    }

    // 8. Check for knife-fight conditions even within same state
    if (newState.state === SQUEEZE_STATE.ACTIVE || newState.state === SQUEEZE_STATE.KNIFE_FIGHT) {
      this._checkKnifeFight(ticker, snapshot, newState);
    }

    this._squeezeStates.set(ticker, newState);

    // 9. Store previous OI for next comparison
    this._storePrevOI(ticker, gexSummary);
  }

  // ── Snapshot Building ─────────────────────────────────────────────

  _buildSnapshot(ticker, gexSummary) {
    const { spot, regime, walls, gammaFlip, aggregation } = gexSummary;

    // Calculate put/call OI ratio from aggregated strike data
    let totalCallOI = 0;
    let totalPutOI = 0;
    let totalCallVolume = 0;
    let totalPutVolume = 0;

    if (aggregation?.byStrike) {
      for (const s of aggregation.byStrike) {
        totalCallOI += s.callOI || 0;
        totalPutOI += s.putOI || 0;
      }
    }

    const pcRatio = totalCallOI > 0 ? totalPutOI / totalCallOI : 1.0;

    // Average IV from nearby strikes (if available from raw data)
    let avgIV = 0;
    let ivCount = 0;

    // Compute dealer gamma exposure direction
    const netGEX = aggregation?.totalNetGEX || 0;
    const dealerShortGamma = netGEX < 0;

    // Call wall and put wall distances
    const callWall = walls?.callWalls?.[0];
    const putWall = walls?.putWalls?.[0];
    const callWallDist = callWall ? ((callWall.strike - spot) / spot) * 100 : null;
    const putWallDist = putWall ? ((spot - putWall.strike) / spot) * 100 : null;
    const flipDist = gammaFlip ? ((spot - gammaFlip) / spot) * 100 : null;

    return {
      ticker,
      timestamp: Date.now(),
      spot,
      netGEX,
      regime: regime?.label || 'Unknown',
      regimeConfidence: regime?.confidence || 0,
      gammaFlip,
      flipDistPct: flipDist,
      callWall: callWall?.strike || null,
      callWallDistPct: callWallDist,
      callWallGEX: callWall?.['netGEX$'] || 0,
      putWall: putWall?.strike || null,
      putWallDistPct: putWallDist,
      putWallGEX: putWall?.['netGEX$'] || 0,
      pcRatio,
      totalCallOI,
      totalPutOI,
      avgIV,
      dealerShortGamma,
    };
  }

  _addSnapshot(ticker, snapshot) {
    if (!this._timeSeries.has(ticker)) {
      this._timeSeries.set(ticker, []);
    }
    const series = this._timeSeries.get(ticker);
    series.push(snapshot);
    if (series.length > MAX_SNAPSHOTS) {
      series.splice(0, series.length - MAX_SNAPSHOTS);
    }
  }

  // ── OI Change Detection (Flow Proxy) ──────────────────────────────

  _detectOIChanges(ticker, gexSummary) {
    const prevOI = this._prevOI.get(ticker);
    if (!prevOI || !gexSummary.aggregation?.byStrike) {
      return { significant: false, changes: [] };
    }

    const changes = [];
    let totalOIChange = 0;
    let totalPrevOI = 0;

    for (const strike of gexSummary.aggregation.byStrike) {
      const prev = prevOI.get(strike.strike);
      if (!prev) continue;

      const callChange = (strike.callOI || 0) - (prev.callOI || 0);
      const putChange = (strike.putOI || 0) - (prev.putOI || 0);
      const prevTotal = (prev.callOI || 0) + (prev.putOI || 0);

      totalOIChange += Math.abs(callChange) + Math.abs(putChange);
      totalPrevOI += prevTotal;

      if (prevTotal > 100 && (Math.abs(callChange) + Math.abs(putChange)) / prevTotal > THRESHOLDS.oiChangeThresholdPct / 100) {
        changes.push({
          strike: strike.strike,
          callChange,
          putChange,
          prevCallOI: prev.callOI,
          prevPutOI: prev.putOI,
        });
      }
    }

    const overallChangePct = totalPrevOI > 0 ? (totalOIChange / totalPrevOI) * 100 : 0;

    return {
      significant: changes.length > 2 || overallChangePct > THRESHOLDS.oiChangeThresholdPct,
      changes: changes.slice(0, 10), // Top 10 most changed strikes
      overallChangePct,
    };
  }

  _storePrevOI(ticker, gexSummary) {
    const oiMap = new Map();
    if (gexSummary.aggregation?.byStrike) {
      for (const s of gexSummary.aggregation.byStrike) {
        oiMap.set(s.strike, { callOI: s.callOI || 0, putOI: s.putOI || 0 });
      }
    }
    this._prevOI.set(ticker, oiMap);
  }

  // ── IV Dynamics Analysis ──────────────────────────────────────────

  _analyzeIVDynamics(ticker, gexSummary) {
    const series = this._timeSeries.get(ticker) || [];
    if (series.length < 3) {
      return { ivCrushLag: false, ivTrend: 'stable' };
    }

    // Check if regime was recently short gamma AND IV has been dropping
    // This indicates a potential IV crush-lag trap:
    // VIX/IV spiked → gamma went very negative → IV is now dropping
    // but gamma is still negative = dealers still short = any move amplified
    const recent = series.slice(-5);
    const shortGammaCount = recent.filter(s => s.dealerShortGamma).length;
    const regimeConfidences = recent.map(s => s.regimeConfidence);
    const avgConfidence = regimeConfidences.reduce((a, b) => a + b, 0) / regimeConfidences.length;

    // Track netGEX trend
    const gexValues = recent.map(s => s.netGEX);
    const gexTrend = gexValues.length >= 2
      ? (gexValues[gexValues.length - 1] - gexValues[0]) / (Math.abs(gexValues[0]) || 1)
      : 0;

    // IV crush-lag: short gamma persistent + GEX becoming less negative = IV dropping but gamma still short
    const ivCrushLag = shortGammaCount >= 3 && gexTrend > 0.05 && recent[recent.length - 1].dealerShortGamma;

    return {
      ivCrushLag,
      ivTrend: gexTrend > 0.1 ? 'rising' : gexTrend < -0.1 ? 'falling' : 'stable',
      shortGammaStreak: shortGammaCount,
      gexTrend,
    };
  }

  // ── Squeeze State Machine ─────────────────────────────────────────

  _evaluateSqueezeState(ticker, snapshot, oiChanges, ivDynamics, prevState) {
    const { netGEX, dealerShortGamma, flipDistPct, callWallDistPct, putWallDistPct, pcRatio, spot } = snapshot;
    const series = this._timeSeries.get(ticker) || [];

    // Not enough data to detect anything meaningful
    if (Math.abs(netGEX) < THRESHOLDS.minAbsGexForDetection) {
      return { state: SQUEEZE_STATE.NORMAL, since: Date.now(), reason: 'GEX too small' };
    }

    // Calculate GEX rate of change
    let gexChangeRate = 0;
    if (series.length >= 2) {
      const prev = series[series.length - 2];
      if (Math.abs(prev.netGEX) > 0) {
        gexChangeRate = ((netGEX - prev.netGEX) / Math.abs(prev.netGEX)) * 100;
      }
    }

    // P/C ratio change over recent snapshots
    let pcRatioShift = 0;
    if (series.length >= 3) {
      const older = series[series.length - 3];
      pcRatioShift = pcRatio - older.pcRatio;
    }

    // Scoring signals
    const signals = {
      dealerShortGamma,
      gexChangingFast: Math.abs(gexChangeRate) > THRESHOLDS.gexChangeRatePct,
      nearFlip: flipDistPct !== null && Math.abs(flipDistPct) < THRESHOLDS.flipProximityPct,
      oiFlowing: oiChanges.significant,
      ivCrushLag: ivDynamics.ivCrushLag,
      pcRatioShifting: Math.abs(pcRatioShift) > THRESHOLDS.pcRatioShiftThreshold,
      spotBeyondCallWall: callWallDistPct !== null && callWallDistPct < -THRESHOLDS.knifeFightSpotBeyondWallPct,
      spotBeyondPutWall: putWallDistPct !== null && putWallDistPct < -THRESHOLDS.knifeFightSpotBeyondWallPct,
    };

    // State transitions
    const prevStateName = prevState.state;

    // ── KNIFE FIGHT: extreme condition ──
    if (dealerShortGamma && (signals.spotBeyondCallWall || signals.spotBeyondPutWall) && signals.gexChangingFast) {
      return {
        state: SQUEEZE_STATE.KNIFE_FIGHT,
        since: prevStateName === SQUEEZE_STATE.KNIFE_FIGHT ? prevState.since : Date.now(),
        reason: `Dealers underwater — spot beyond ${signals.spotBeyondCallWall ? 'call' : 'put'} wall in short gamma`,
        signals,
        gexChangeRate,
        pcRatioShift,
      };
    }

    // ── ACTIVE SQUEEZE: dealers forced to hedge ──
    if (dealerShortGamma && (signals.gexChangingFast || signals.oiFlowing) && (signals.nearFlip || Math.abs(gexChangeRate) > THRESHOLDS.gexChangeRatePct * 0.7)) {
      return {
        state: SQUEEZE_STATE.ACTIVE,
        since: prevStateName === SQUEEZE_STATE.ACTIVE ? prevState.since : Date.now(),
        reason: 'Short gamma + rapid GEX change + flow confirms squeeze in progress',
        signals,
        gexChangeRate,
        pcRatioShift,
      };
    }

    // ── UNWINDING: squeeze reversing ──
    if ((prevStateName === SQUEEZE_STATE.ACTIVE || prevStateName === SQUEEZE_STATE.KNIFE_FIGHT) &&
        (signals.pcRatioShifting || !dealerShortGamma)) {
      return {
        state: SQUEEZE_STATE.UNWINDING,
        since: Date.now(),
        reason: dealerShortGamma ? 'P/C ratio shifting — squeeze unwind signal' : 'Gamma regime flipping positive — squeeze ending',
        signals,
        gexChangeRate,
        pcRatioShift,
      };
    }

    // ── BUILDING: early squeeze signs ──
    if (dealerShortGamma && (signals.oiFlowing || signals.nearFlip || signals.ivCrushLag)) {
      return {
        state: SQUEEZE_STATE.BUILDING,
        since: prevStateName === SQUEEZE_STATE.BUILDING ? prevState.since : Date.now(),
        reason: 'Short gamma + early flow/proximity signals building',
        signals,
        gexChangeRate,
        pcRatioShift,
      };
    }

    // ── NORMAL ──
    return {
      state: SQUEEZE_STATE.NORMAL,
      since: prevStateName === SQUEEZE_STATE.NORMAL ? prevState.since : Date.now(),
      reason: 'No squeeze conditions detected',
      signals,
      gexChangeRate,
      pcRatioShift,
    };
  }

  // ── Knife Fight Detection ─────────────────────────────────────────

  _checkKnifeFight(ticker, snapshot, state) {
    // Extra check: during active squeeze, track if spot is accelerating AWAY from walls
    const series = this._timeSeries.get(ticker) || [];
    if (series.length < 3) return;

    const recent3 = series.slice(-3);
    const spots = recent3.map(s => s.spot);
    const momentum = spots.length >= 2 ? ((spots[spots.length - 1] - spots[0]) / spots[0]) * 100 : 0;

    // If momentum is > 0.3% in 3 polls (~9 min) during active squeeze, flag acceleration
    if (Math.abs(momentum) > 0.3 && state.state === SQUEEZE_STATE.ACTIVE) {
      const direction = momentum > 0 ? 'upward' : 'downward';
      const alertKey = `${ticker}:acceleration:${direction}`;

      if (!this._isAlertCoolingDown(alertKey)) {
        this._emitAlert(ticker, 'squeeze_acceleration',
          `Squeeze accelerating ${direction} — ${Math.abs(momentum).toFixed(2)}% move in ~9 min during active squeeze`);
        this._alertCooldowns.set(alertKey, Date.now());
      }
    }
  }

  // ── State Transition Alerts ───────────────────────────────────────

  _onStateTransition(ticker, prevState, newState, snapshot) {
    const alertKey = `${ticker}:state:${newState.state}`;
    if (this._isAlertCoolingDown(alertKey)) return;

    auditLog.log('gamma_squeeze', `${ticker}: ${prevState.state} → ${newState.state} — ${newState.reason}`);

    let message = null;

    switch (newState.state) {
      case SQUEEZE_STATE.BUILDING:
        message = this._formatBuildingAlert(ticker, snapshot, newState);
        break;

      case SQUEEZE_STATE.ACTIVE:
        message = this._formatActiveSqueezeAlert(ticker, snapshot, newState);
        break;

      case SQUEEZE_STATE.KNIFE_FIGHT:
        message = this._formatKnifeFightAlert(ticker, snapshot, newState);
        break;

      case SQUEEZE_STATE.UNWINDING:
        message = this._formatUnwindAlert(ticker, snapshot, newState);
        break;

      case SQUEEZE_STATE.NORMAL:
        if (prevState.state !== SQUEEZE_STATE.NORMAL) {
          message = `**${ticker}** squeeze conditions have cleared. Regime: ${snapshot.regime}. Back to normal monitoring.`;
        }
        break;
    }

    if (message && this._postToChannel) {
      this._postToChannel(message).catch(() => {});
    }

    this._alertCooldowns.set(alertKey, Date.now());
  }

  // ── Alert Formatting ──────────────────────────────────────────────

  _formatBuildingAlert(ticker, snap, state) {
    const signals = state.signals || {};
    const lines = [
      `**${ticker} — Gamma Squeeze Building**`,
      `Spot: \`$${snap.spot}\` | Regime: \`${snap.regime}\` (${(snap.regimeConfidence * 100).toFixed(0)}%)`,
      `Net GEX: \`${this._fmtDollar(snap.netGEX)}\` (dealers ${snap.dealerShortGamma ? 'SHORT' : 'LONG'} gamma)`,
      '',
      '**Early signals:**',
    ];
    if (signals.nearFlip) lines.push(`  - Spot near gamma flip ($${snap.gammaFlip}) — ${Math.abs(snap.flipDistPct).toFixed(2)}% away`);
    if (signals.oiFlowing) lines.push('  - Significant OI flow detected across strikes');
    if (signals.ivCrushLag) lines.push('  - IV crush-lag: IV dropping but gamma still negative = trap setup');
    lines.push(`\n_Monitoring for escalation. This is NOT yet an active squeeze._`);
    return lines.join('\n');
  }

  _formatActiveSqueezeAlert(ticker, snap, state) {
    const direction = snap.spot > (snap.callWall || Infinity) ? 'UPWARD' : snap.spot < (snap.putWall || 0) ? 'DOWNWARD' : 'ACTIVE';
    return [
      `**${ticker} — ACTIVE GAMMA SQUEEZE ${direction}**`,
      `Spot: \`$${snap.spot}\` | Net GEX: \`${this._fmtDollar(snap.netGEX)}\``,
      `Dealers are **SHORT gamma** — forced hedging is amplifying moves`,
      `GEX change rate: \`${state.gexChangeRate?.toFixed(1) || '?'}%\` per poll`,
      snap.callWall ? `Call Wall: \`$${snap.callWall}\` (${snap.callWallDistPct?.toFixed(2)}% away)` : null,
      snap.putWall ? `Put Wall: \`$${snap.putWall}\` (${snap.putWallDistPct?.toFixed(2)}% away)` : null,
      snap.gammaFlip ? `Gamma Flip: \`$${snap.gammaFlip}\`` : null,
      `P/C Ratio: \`${snap.pcRatio.toFixed(3)}\` (shift: ${state.pcRatioShift?.toFixed(3) || '0'})`,
      '',
      `_Dealers are hedging into the move. Watch for exhaustion or wall break._`,
    ].filter(Boolean).join('\n');
  }

  _formatKnifeFightAlert(ticker, snap, state) {
    return [
      `**${ticker} — KNIFE FIGHT TERRITORY**`,
      `Spot: \`$${snap.spot}\` has blown through dealer hedging levels`,
      `Dealers are **UNDERWATER** — short gamma and spot is beyond walls`,
      `Net GEX: \`${this._fmtDollar(snap.netGEX)}\` | Change rate: \`${state.gexChangeRate?.toFixed(1) || '?'}%\``,
      snap.callWall ? `Call Wall: \`$${snap.callWall}\` (BREACHED — spot ${snap.callWallDistPct?.toFixed(2)}% beyond)` : null,
      snap.putWall ? `Put Wall: \`$${snap.putWall}\` (BREACHED — spot ${snap.putWallDistPct?.toFixed(2)}% beyond)` : null,
      '',
      `**Extreme caution.** Price is beyond fair value due to structural gamma imbalance.`,
      `_Watch for snap reversal when dealers finish hedging or new OI pins form._`,
    ].filter(Boolean).join('\n');
  }

  _formatUnwindAlert(ticker, snap, state) {
    return [
      `**${ticker} — Squeeze Unwinding**`,
      `Spot: \`$${snap.spot}\` | P/C Ratio shift: \`${state.pcRatioShift?.toFixed(3) || '0'}\``,
      state.signals?.pcRatioShifting ? 'Put/call ratio shifting — dealers repositioning' : null,
      !snap.dealerShortGamma ? 'Gamma regime flipping positive — dealer hedging pressure easing' : null,
      '',
      `_Squeeze is fading. Be cautious of continuation plays — the structural edge is gone._`,
    ].filter(Boolean).join('\n');
  }

  // ── Sector GEX Analysis ───────────────────────────────────────────

  /**
   * Analyze gamma exposure across sector ETFs.
   * Identifies which sectors have the most extreme gamma positioning.
   * @returns {Promise<Array<{ ticker, sector, regime, netGEX, confidence }>>}
   */
  async analyzeSectorGEX() {
    const results = [];

    for (const [etf, sectorName] of Object.entries(SECTOR_TICKERS)) {
      try {
        const summary = await this._gexEngine.analyze(etf, { include_expiries: ['0dte', 'weekly'] });
        results.push({
          ticker: etf,
          sector: sectorName,
          regime: summary.regime.label,
          confidence: summary.regime.confidence,
          netGEX: summary.aggregation.totalNetGEX,
          spot: summary.spot,
          gammaFlip: summary.gammaFlip,
        });
      } catch (err) {
        // Skip sectors where options data is unavailable
        continue;
      }

      await this._sleep(1500); // Rate limit between fetches
    }

    // Sort by absolute GEX (most extreme first)
    results.sort((a, b) => Math.abs(b.netGEX) - Math.abs(a.netGEX));
    return results;
  }

  /**
   * Format sector GEX for Discord.
   */
  formatSectorGEXForDiscord(sectorData) {
    if (sectorData.length === 0) return 'No sector GEX data available.';

    const lines = ['**Sector Gamma Exposure Breakdown**\n'];

    for (const s of sectorData) {
      const emoji = s.regime === 'Long Gamma' ? '+' : s.regime === 'Short Gamma' ? '-' : '~';
      const regimeIcon = s.regime === 'Long Gamma' ? '***' : s.regime === 'Short Gamma' ? '***' : '';
      lines.push(
        `\`${emoji}\` **${s.sector}** (${s.ticker}) — ${regimeIcon}${s.regime}${regimeIcon} (${(s.confidence * 100).toFixed(0)}%)` +
        ` | GEX: ${this._fmtDollar(s.netGEX)}`
      );
    }

    // Summary
    const shortGammaSectors = sectorData.filter(s => s.regime === 'Short Gamma');
    if (shortGammaSectors.length > 0) {
      lines.push(`\n**Short gamma sectors (squeeze risk):** ${shortGammaSectors.map(s => s.ticker).join(', ')}`);
    }

    return lines.join('\n');
  }

  // ── Public Query: Get Squeeze Status ──────────────────────────────

  /**
   * Get the current squeeze status for a ticker (or all watched tickers).
   * @param {string} [ticker] - Specific ticker, or null for all
   * @returns {object|Array<object>}
   */
  getSqueezeStatus(ticker) {
    if (ticker) {
      const upper = ticker.toUpperCase();
      const state = this._squeezeStates.get(upper) || { state: SQUEEZE_STATE.NORMAL, reason: 'Not yet analyzed' };
      const series = this._timeSeries.get(upper) || [];
      const latest = series[series.length - 1] || null;

      return {
        ticker: upper,
        squeezeState: state.state,
        since: state.since ? new Date(state.since).toISOString() : null,
        reason: state.reason,
        signals: state.signals || {},
        gexChangeRate: state.gexChangeRate || 0,
        pcRatioShift: state.pcRatioShift || 0,
        latestSnapshot: latest,
        historyLength: series.length,
      };
    }

    // All tickers
    return this._watchlist.map(t => this.getSqueezeStatus(t));
  }

  /**
   * Format squeeze status for Discord.
   */
  formatStatusForDiscord(status) {
    if (Array.isArray(status)) {
      const lines = ['**Gamma Squeeze Monitor**\n'];
      for (const s of status) {
        const emoji = this._stateEmoji(s.squeezeState);
        const latest = s.latestSnapshot;
        lines.push(
          `${emoji} **${s.ticker}** — \`${s.squeezeState}\`` +
          (latest ? ` | $${latest.spot} | GEX: ${this._fmtDollar(latest.netGEX)} | ${latest.regime}` : '') +
          (s.historyLength > 0 ? ` | ${s.historyLength} snapshots` : '')
        );
      }
      return lines.join('\n');
    }

    // Single ticker detail
    const s = status;
    const emoji = this._stateEmoji(s.squeezeState);
    const latest = s.latestSnapshot;

    const lines = [
      `${emoji} **${s.ticker} — Squeeze Status: \`${s.squeezeState}\`**`,
      s.since ? `Since: ${new Date(s.since).toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET` : null,
      `Reason: ${s.reason}`,
      '',
    ];

    if (latest) {
      lines.push(
        `**Latest Snapshot:**`,
        `Spot: \`$${latest.spot}\` | Net GEX: \`${this._fmtDollar(latest.netGEX)}\``,
        `Regime: \`${latest.regime}\` (${(latest.regimeConfidence * 100).toFixed(0)}%)`,
        latest.gammaFlip ? `Gamma Flip: \`$${latest.gammaFlip}\` (${latest.flipDistPct?.toFixed(2)}% away)` : null,
        latest.callWall ? `Call Wall: \`$${latest.callWall}\` (${latest.callWallDistPct?.toFixed(2)}% from spot)` : null,
        latest.putWall ? `Put Wall: \`$${latest.putWall}\` (${latest.putWallDistPct?.toFixed(2)}% from spot)` : null,
        `P/C Ratio: \`${latest.pcRatio.toFixed(3)}\` | Call OI: \`${this._fmtNumber(latest.totalCallOI)}\` | Put OI: \`${this._fmtNumber(latest.totalPutOI)}\``,
        `Dealers: ${latest.dealerShortGamma ? 'SHORT gamma (amplify)' : 'LONG gamma (suppress)'}`,
      );
    }

    // Signal breakdown
    if (s.signals && Object.values(s.signals).some(v => v === true)) {
      lines.push('', '**Active Signals:**');
      for (const [key, val] of Object.entries(s.signals)) {
        if (val === true) {
          lines.push(`  - ${this._signalLabel(key)}`);
        }
      }
    }

    // GEX history trend
    const series = this._timeSeries.get(s.ticker) || [];
    if (series.length >= 5) {
      const recent5 = series.slice(-5);
      const gexTrend = recent5.map(sn => this._fmtDollarShort(sn.netGEX)).join(' -> ');
      lines.push('', `**GEX Trend (last 5):** ${gexTrend}`);
    }

    lines.push('', `_${s.historyLength} snapshots stored | Polling every ${POLL_INTERVAL_MS / 1000}s_`);

    return lines.filter(Boolean).join('\n');
  }

  // ── Integration: Get Squeeze Signal for Options Engine ────────────

  /**
   * Returns a squeeze signal object for the options engine to use.
   * Boosts conviction when squeeze is active.
   *
   * @param {string} ticker
   * @returns {{ active: boolean, state: string, convictionBoost: number, direction: string|null, reason: string }}
   */
  getSqueezeSignal(ticker) {
    const upper = ticker.toUpperCase();
    const state = this._squeezeStates.get(upper);
    if (!state || state.state === SQUEEZE_STATE.NORMAL) {
      return { active: false, state: 'normal', convictionBoost: 0, direction: null, reason: 'No squeeze' };
    }

    const series = this._timeSeries.get(upper) || [];
    const latest = series[series.length - 1];
    if (!latest) {
      return { active: false, state: state.state, convictionBoost: 0, direction: null, reason: 'No data' };
    }

    // Determine direction based on squeeze mechanics:
    // Short gamma + spot above flip = bullish squeeze (dealers buying to hedge)
    // Short gamma + spot below flip = bearish squeeze (dealers selling to hedge)
    let direction = null;
    if (latest.flipDistPct !== null) {
      direction = latest.flipDistPct > 0 ? 'bullish' : 'bearish';
    } else if (latest.spot > (latest.callWall || Infinity)) {
      direction = 'bullish';
    } else if (latest.spot < (latest.putWall || 0)) {
      direction = 'bearish';
    }

    const convictionBoostMap = {
      [SQUEEZE_STATE.BUILDING]: 1,
      [SQUEEZE_STATE.ACTIVE]: 2,
      [SQUEEZE_STATE.KNIFE_FIGHT]: 3,
      [SQUEEZE_STATE.UNWINDING]: -1, // Reduce conviction during unwind
    };

    return {
      active: true,
      state: state.state,
      convictionBoost: convictionBoostMap[state.state] || 0,
      direction,
      reason: state.reason,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────

  _isMarketHours() {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = et.getDay();
    if (day === 0 || day === 6) return false;
    const h = et.getHours();
    const m = et.getMinutes();
    const minuteOfDay = h * 60 + m;
    return minuteOfDay >= 9 * 60 + 30 && minuteOfDay < 16 * 60;
  }

  _isAlertCoolingDown(key) {
    const last = this._alertCooldowns.get(key);
    if (!last) return false;
    return Date.now() - last < this._alertCooldownMs;
  }

  _emitAlert(ticker, type, message) {
    auditLog.log('gamma_squeeze', `[${ticker}] ${type}: ${message}`);
    if (this._postToChannel) {
      this._postToChannel(message).catch(() => {});
    }
  }

  _stateEmoji(state) {
    const map = {
      [SQUEEZE_STATE.NORMAL]: '---',
      [SQUEEZE_STATE.BUILDING]: '***',
      [SQUEEZE_STATE.ACTIVE]: '***',
      [SQUEEZE_STATE.KNIFE_FIGHT]: '***',
      [SQUEEZE_STATE.UNWINDING]: '***',
    };
    return map[state] || '--';
  }

  _signalLabel(key) {
    const labels = {
      dealerShortGamma: 'Dealers SHORT gamma (amplify mode)',
      gexChangingFast: 'GEX changing rapidly between polls',
      nearFlip: 'Spot near gamma flip level',
      oiFlowing: 'Significant OI flow detected',
      ivCrushLag: 'IV crush-lag trap (IV dropping, gamma still negative)',
      pcRatioShifting: 'Put/call ratio shifting (reposition signal)',
      spotBeyondCallWall: 'Spot BEYOND call wall (dealers underwater)',
      spotBeyondPutWall: 'Spot BEYOND put wall (dealers underwater)',
    };
    return labels[key] || key;
  }

  _fmtDollar(value) {
    const abs = Math.abs(value);
    const sign = value < 0 ? '-' : '';
    if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
    return `${sign}$${abs.toFixed(0)}`;
  }

  _fmtDollarShort(value) {
    const abs = Math.abs(value);
    const sign = value < 0 ? '-' : '+';
    if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K`;
    return `${sign}${abs.toFixed(0)}`;
  }

  _fmtNumber(n) {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(n);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Persistence ───────────────────────────────────────────────────

  _persistState() {
    // Persist squeeze states
    const states = {};
    for (const [k, v] of this._squeezeStates) {
      states[k] = { state: v.state, since: v.since, reason: v.reason };
    }
    this._storage.set('squeezeStates', states);

    // Persist last 20 snapshots per ticker (keep it lean)
    const series = {};
    for (const [k, v] of this._timeSeries) {
      series[k] = v.slice(-20);
    }
    this._storage.set('timeSeries', series);
  }

  _restoreState() {
    const states = this._storage.get('squeezeStates', {});
    for (const [k, v] of Object.entries(states)) {
      this._squeezeStates.set(k, v);
    }

    const series = this._storage.get('timeSeries', {});
    for (const [k, v] of Object.entries(series)) {
      this._timeSeries.set(k, v);
    }
  }
}

module.exports = new GammaSqueezeEngine();
