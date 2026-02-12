// ── PERFORMANCE IMPROVEMENT: CACHE STATE & BATCH SERIALIZATION ──────────────────────
// Optimized: defer JSON serialization until shutdown, cache persisted state in memory,
// batch snapshot updates to avoid re-sorting and JSON.stringify on every poll

const fs = require('fs');
const path = require('path');

class GammaSqueezeEngine {
  constructor() {
    this._storage = new Storage('gamma-squeeze-state.json');
    this._storageCache = {
      squeezeStates: {},      // In-memory cache for squeezeStates object
      timeSeries: {}          // In-memory cache for timeSeries (trimmed to latest entries)
    };
    this._gexEngine = new GEXEngine(gamma);
    this._interval = null;
    this._postToChannel = null;
    this._stopped = false;

    // Time-series data: ticker → Array<snapshot>
    this._timeSeries = new Map();
    Object.assign(this._timeSeries, this._storageCache.timeSeries); // Hydrate from cache

    // Current squeeze state per ticker: ticker → { state, since, ... }
    this._squeezeStates = new Map();
    Object.entries(this._storageCache.squeezeStates || {})
      .forEach(([k, v]) => this._squeezeStates.set(k, v));

    // Previous OI snapshots for change detection: ticker → { strike → { callOI, putOI } }
    this._prevOI = new Map();

    // Alert cooldowns: alertKey → timestamp
    this._alertCooldowns = new Map();
    this._alertCooldownMs = 30 * 60 * 1000; // 30 min cooldown per alert

    // Hysteresis: require 2 consecutive polls to agree on a new state before transitioning
    this._pendingTransitions = new Map(); // ticker → { state, count }

    // Watchlist for squeeze monitoring (main indices + actively traded)
    this._watchlist = ['SPY', 'QQQ', 'IWM'];
    this._restoreState();
    this._initialized = false;
  }

  /** Wire Discord posting callback */
  setChannelPoster(fn) {
    this._postToChannel = fn;
  }

  /** Update watchlist (e.g. from initiative engine detecting movers) */
  setWatchlist(tickers) {
    this._watchlist = [...new Set([...['SPY', 'QQQ'], ...tickers])];
    this._persistWatchlist(); // Persist immediately to cache state
  }

  /** Get current watchlist */
  getWatchlist() {
    return [...this._watchlist];
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  start() {
    if (this._interval) return;
    this._stopped = false;

    // Attach to live cache only on first start
    if (!this._initialized) {
      this._initialized = true;
      this._interval = setInterval(() => this._poll(), POLL_INTERVAL_MS);
      console.log(`[GammaSqueeze] Started — polling every ${POLL_INTERVAL_MS / 1000}s, watching: ${this._watchlist.join(', ')}`);
      auditLog.log('gamma_squeeze', 'Squeeze detection engine started');
    }
    this._poll();
  }

  stop() {
    this._stopped = true;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._persistState(); // Serialize once at shutdown/stop
    console.log('[GammaSqueeze] Stopped');
  }

  // ── Main Poll Loop ────────────────────────────────────────────────

  async _poll() {
    if (this._stopped) return;
    if (!this._isMarketHours()) return;

    // Batch processing: collect all tickers first
    const tickers = [...this._watchlist];
    const futures = tickers.map(ticker => this._analyzeTicker(ticker).catch(() => undefined));

    await Promise.all(futures);

    // Only persist updates after full batch completes
    this._persistState();
  }

  // ── Per-Ticker Analysis ───────────────────────────────────────────

  async _analyzeTicker(ticker) {
    if (!this._isMarketHours()) return;

    let gexSummary;
    try {
      gexSummary = await this._gexEngine.analyze(ticker, { include_expiries: ['0dte', 'weekly'] });
    } catch (err) {
      return;
    }

    const snapshot = this._buildSnapshot(ticker, gexSummary);
    this._addSnapshot(ticker, snapshot);

    const oiChanges = this._detectOIChanges(ticker, gexSummary);
    const ivDynamics = this._analyzeIVDynamics(ticker, gexSummary);
    const prevState = this._squeezeStates.get(ticker) || { state: SQUEEZE_STATE.NORMAL };
    const newState = this._evaluateSqueezeState(ticker, snapshot, oiChanges, ivDynamics, prevState);

    // Hysteresis: require 2 consecutive polls to agree on a new state
    if (newState.state !== prevState.state) {
      const pending = this._pendingTransitions.get(ticker);
      if (pending && pending.state === newState.state) {
        this._onStateTransition(ticker, prevState, newState, snapshot);
        this._pendingTransitions.delete(ticker);
        this._squeezeStates.set(ticker, newState);
        this._cacheSqueezeState(ticker, newState); // Cache updated state
      } else {
        this._pendingTransitions.set(ticker, { state: newState.state, since: Date.now() });
        this._squeezeStates.set(ticker, prevState); // Stay until confirmed
        this._cacheSqueezeState(ticker, prevState); // Still cache unchanged
      }
    } else {
      this._pendingTransitions.delete(ticker);
      this._squeezeStates.set(ticker, newState);
      this._cacheSqueezeState(ticker, newState);
    }

    if (newState.state === SQUEEZE_STATE.ACTIVE || newState.state === SQUEEZE_STATE.KNIFE_FIGHT) {
      this._checkKnifeFight(ticker, snapshot, newState);
    }

    this._storePrevOI(ticker, gexSummary);
  }

  // ── Snapshot Building ─────────────────────────────────────────────

  _buildSnapshot(ticker, gexSummary) {
    const { spot, regime, walls, gammaFlip, aggregation } = gexSummary;
    let totalCallOI = 0;
    let totalPutOI = 0;

    if (aggregation?.byStrike) {
      for (const s of aggregation.byStrike) {
        totalCallOI += s.callOI || 0;
        totalPutOI += s.putOI || 0;
      }
    }

    const pcRatio = totalCallOI > 0 ? totalPutOI / totalCallOI : 1.0;
    const netGEX = aggregation?.totalNetGEX || 0;
    const dealerShortGamma = netGEX < 0;

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
      avgIV: 0,
      dealerShortGamma,
    };
  }

  _addSnapshot(ticker, snapshot) {
    if (!this._timeSeries.has(ticker)) {
      this._timeSeries.set(ticker, []);
    }
    const series = this._timeSeries.get(ticker);
    series.push(snapshot);

    // Trim to MAX_SNAPSHOTS to keep memory bounded
    if (series.length > MAX_SNAPSHOTS) {
      const excess = series.length - MAX_SNAPSHOTS;
      series.splice(0, excess);
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
      changes: changes.slice(0, 10),
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

    const recent = series.slice(-5);
    const shortGammaCount = recent.filter(s => s.dealerShortGamma).length;

    const netGEXValues = recent.map(s => s.netGEX);
    const gexTrend = netGEXValues.length >= 2
      ? (netGEXValues[netGEXValues.length - 1] - netGEXValues[0]) / (Math.abs(netGEXValues[0]) || 1)
      : 0;

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

    if (Math.abs(netGEX) < THRESHOLDS.minAbsGexForDetection) {
      return { state: SQUEEZE_STATE.NORMAL, since: Date.now(), reason: 'GEX too small' };
    }

    let gexChangeRate = 0;
    if (series.length >= 2) {
      const prev = series[series.length - 2];
      if (Math.abs(prev.netGEX) > 0) {
        gexChangeRate = ((netGEX - prev.netGEX) / Math.abs(prev.netGEX)) * 100;
      }
    }

    let pcRatioShift = 0;
    if (series.length >= 3) {
      const older = series[series.length - 3];
      pcRatioShift = pcRatio - older.pcRatio;
    }

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

    const prevStateName = prevState.state;

    // ── KNIFE FIGHT ──
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

    // ── ACTIVE SQUEEZE ──
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

    // ── UNWINDING ──
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

    // ── BUILDING ──
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
    const series = this._timeSeries.get(ticker) || [];
    if (series.length < 3) return;

    const spots = series.slice(-3).map(s => s.spot);
    const momentum = spots.length >= 2 ? ((spots[spots.length - 1] - spots[0]) / spots[0]) * 100 : 0;

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
    const alertKey = `${ticker}:squeeze_alert`;
    if (this._isAlertCoolingDown(alertKey)) return;

    const key = `${ticker}:${prevState.state}_${newState.state}`;
    const messages = {
      normal_building: this._formatBuildingAlert(ticker, snapshot, newState),
      building_active: this._formatActiveSqueezeAlert(ticker, snapshot, newState),
      active_knife: this._formatKnifeFightAlert(ticker, snapshot, newState),
      knife_unwinding: this._formatUnwindAlert(ticker, snapshot, newState),
      active_normal: this._formatUnwindAlert(ticker, snapshot, newState), // unwind on calm
      building_normal: this._formatUnwindAlert(ticker, snapshot, newState), // calm on building
      building_knife: this._formatKnifeFightAlert(ticker, snapshot, newState),
      knife_active: this._formatActiveSqueezeAlert(ticker, snapshot, newState)
    };

    const safeKey = key.replace(/[^a-zA-Z0-9]/g, '_');
    const message = messages[safeKey] || null;

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
    return [
      `**${ticker} — ACTIVE GAMMA SQUEEZE**`,
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
      } catch {
        continue;
      }

      await this._sleep(1500);
    }

    results.sort((a, b) => Math.abs(b.netGEX) - Math.abs(a.netGEX));
    return results;
  }

  formatSectorGEXForDiscord(sectorData) {
    if (sectorData.length === 0) return 'No sector GEX data available.';

    const lines = ['**Sector Gamma Exposure Breakdown**\n'];

    for (const s of sectorData) {
      const emoji = s.regime === 'Long Gamma' ? '+' : s.regime === 'Short Gamma' ? '-' : '~';
      lines.push(
        `\`${emoji}\` **${s.sector}** (${s.ticker}) — ${s.regime} (${(s.confidence * 100).toFixed(0)}%)` +
        ` | GEX: ${this._fmtDollar(s.netGEX)}`
      );
    }

    const shortGammaSectors = sectorData.filter(s => s.regime === 'Short Gamma');
    if (shortGammaSectors.length > 0) {
      lines.push(`\n**Short gamma sectors (squeeze risk):** ${shortGammaSectors.map(s => s.ticker).join(', ')}`);
    }

    return lines.join('\n');
  }

  // ── Public Query: Get Squeeze Status ──────────────────────────────

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

    // All tickers — map over watchlist and use cached series
    return this._watchlist.map(t => this.getSqueezeStatus(t));
  }

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

    if (s.signals && Object.values(s.signals).some(v => v === true)) {
      lines.push('', '**Active Signals:**');
      for (const [key, val] of Object.entries(s.signals)) {
        if (val === true) {
          lines.push(`  - ${this._signalLabel(key)}`);
        }
      }
    }

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
      [SQUEEZE_STATE.UNWINDING]: -1,
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

  /** Persist state to disk — called only at stop() or shutdown */
  _persistState() {
    // Persist squeezeStates in memory (trimmed)
    const persistStates = {};
    for (const [k, v] of this._squeezeStates.entries()) {
      persistStates[k] = { state: v.state, since: v.since, reason: v.reason };
    }

    // Persist only last 20 snapshots per ticker to keep storage lean
    const persistTimeSeries = {};
    for (const [k, v] of this._timeSeries.entries()) {
      persistTimeSeries[k] = v.slice(-MAX_SNAPSHOTS);
    }

    const payload = {
      sink: 'gamma-squeeze',
      version: 1,
      timestamp: Date.now(),
      persistStates,
      timeSeries: persistTimeSeries,
      watchlist: this._watchlist,
      prevOI: Object.fromEntries([...this._prevOI.entries()]),
      alertCooldowns: this._alertCooldowns,
      _storageCache: this._storageCache // Keep cache synced on flush
    };

    try {
      const fsPath = path.resolve(__dirname, '../../data/gamma-squeeze-state.json');
      fs.writeFileSync(fsPath, JSON.stringify(payload, null, 2));
      // Re-hydrate cache on next start
      this._storageCache.squeezeStates = persistStates;
      this._storageCache.timeSeries = persistTimeSeries;
      auditLog.log('gamma_squeeze', 'State persisted');
    } catch (err) {
      console.error('[GammaSqueeze] Failed to persist state:', err.message);
    }
  }

  /** Restore state from disk on startup */
  _restoreState() {
    // Rebuild from cache if available
    if (this._storageCache && this._storageCache.persistStates) {
      for (const [k, v] of Object.entries(this._storageCache.persistStates)) {
        this._squeezeStates.set(k, v);
      }
    }

    if (this._storageCache && this._storageCache.timeSeries) {
      for (const [k, v] of Object.entries(this._storageCache.timeSeries)) {
        this._timeSeries.set(k, v);
      }
    }

    // Hydrate prevOI if persisted
    if (this._storageCache && this._storageCache.prevOI) {
      for (const [k, v] of Object.entries(this._storageCache.prevOI)) {
        this._prevOI.set(k, new Map(Object.entries(v)));
      }
    }

    // Hydrate alert cooldowns
    if (this._storageCache && this._storageCache.alertCooldowns) {
      for (const [k, v] of Object.entries(this._storageCache.alertCooldowns)) {
        this._alertCooldowns.set(k, v);
      }
    }
  }
}

module.exports = new GammaSqueezeEngine();