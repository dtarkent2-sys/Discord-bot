/**
 * GEX Aggregation Engine — Multi-Expiry, Decision-Ready Analysis
 *
 * Sits on top of gamma.js (data fetching / Black-Scholes) and provides:
 *  1. Cross-expiry aggregation (totalNetGEX$, by-expiry, by-strike clustering)
 *  2. Magnitude normalization (so weekly "$232k" isn't confused with monthly "$576M")
 *  3. Regime classification with confidence scoring
 *  4. Stacked wall detection (call/put walls across expirations)
 *  5. Actionable Discord output (under ~1100 chars)
 *
 * GEX$ Formula (dealer perspective):
 *   GEX$ = OI × gamma × 100 (contract multiplier) × spot
 *   - Calls: positive (dealers sold calls → long gamma on calls)
 *   - Puts:  negative (dealers sold puts  → short gamma on puts)
 *   - netGEX$ = callGEX$ + putGEX$
 *
 * Regime Logic:
 *   totalNetGEX$ > 0 → "Long Gamma" (dealers suppress moves)
 *   totalNetGEX$ < 0 → "Short Gamma" (dealers amplify moves)
 *   Confidence scales with |totalNetGEX$| and distance from flip.
 *   Contradiction (label vs sign) → "Mixed/Uncertain" + warning logged.
 */

const log = require('../logger')('GEXEngine');

// ── Default configuration ───────────────────────────────────────────────

const DEFAULT_CONFIG = {
  include_expiries: ['0dte', 'weekly', 'monthly'],
  hold_candles: 3,
  candle_interval: '5Min',
  min_regime_confidence_to_alert: 0.4,
  min_abs_gex_to_consider_dominant: 1e6, // $1M
};

// ── GEX Engine ──────────────────────────────────────────────────────────

class GEXEngine {
  /**
   * @param {import('./gamma')} gammaService - The gamma data service
   * @param {object} [overrides] - Config overrides (merged with DEFAULT_CONFIG)
   */
  constructor(gammaService, overrides = {}) {
    this.gamma = gammaService;
    this.config = { ...DEFAULT_CONFIG, ...overrides };
  }

  /**
   * Update config flags at runtime (e.g. from env or command options).
   */
  updateConfig(overrides) {
    Object.assign(this.config, overrides);
  }

  // ── Main entry point ─────────────────────────────────────────────────

  /**
   * Run full multi-expiry GEX analysis.
   *
   * @param {string} ticker
   * @param {object} [opts] - { include_expiries }
   * @returns {Promise<GEXSummary>}
   */
  async analyze(ticker, opts = {}) {
    const expiryPrefs = opts.include_expiries || this.config.include_expiries;

    log.info(`Analyzing ${ticker} across [${expiryPrefs.join(', ')}]`);

    // 1. Fetch multi-expiry data from gamma service
    const raw = await this.gamma.analyzeMultiExpiry(ticker, expiryPrefs);

    log.debug(`Raw data: ${raw.expirations.length} expirations, spot=$${raw.spotPrice}`);

    // 2. Build canonical structure
    const canonical = this._buildCanonical(raw);

    // 3. Aggregate across expirations
    const aggregation = this._aggregate(canonical);

    // 4. Classify regime with confidence
    const regime = this._classifyRegime(aggregation, canonical);

    // 5. Find stacked walls
    const walls = this._findStackedWalls(aggregation);

    // 6. Find gamma flip from aggregated data
    const gammaFlip = this._findAggregatedFlip(aggregation, canonical.spot);

    // 7. Generate playbook lines
    const playbook = this._generatePlaybook(regime, walls, gammaFlip, canonical.spot);

    const summary = {
      ticker: canonical.ticker,
      spot: canonical.spot,
      source: raw.source,
      expirations: canonical.expirations,
      aggregation,
      regime,
      walls,
      gammaFlip,
      playbook,
      // Carry through chart buffer from dominant expiry (for attachment)
      chartBuffer: this._getDominantChart(raw, aggregation),
    };

    log.info(`${ticker}: regime=${regime.label} conf=${regime.confidence.toFixed(2)}, totalGEX=${this._fmtDollar(aggregation.totalNetGEX)}`);
    log.debug(`Walls: callWall=${walls.callWalls[0] ? '$' + walls.callWalls[0].strike : 'none'}, putWall=${walls.putWalls[0] ? '$' + walls.putWalls[0].strike : 'none'}, flip=${gammaFlip ? '$' + gammaFlip : 'none'}`);

    return summary;
  }

  // ── Canonical data model ─────────────────────────────────────────────

  /**
   * Build the canonical internal structure from raw multi-expiry data.
   *
   * Shape:
   *   { ticker, spot, expirations: [{ expiry, netGEX$, strikes: [{ strike, callOI, putOI, ... }] }] }
   */
  _buildCanonical(raw) {
    const expirations = raw.expirations.map(exp => ({
      expiry: exp.expiry,
      'netGEX$': exp.detailedGEX['totalNetGEX$'],
      strikes: exp.detailedGEX.strikes, // canonical per-strike data
      flip: exp.flip,
    }));

    return {
      ticker: raw.ticker,
      spot: raw.spotPrice,
      expirations,
    };
  }

  // ── Aggregation ──────────────────────────────────────────────────────

  /**
   * Aggregate GEX across all expirations.
   *
   * Returns:
   *   - totalNetGEX: sum of netGEX$ across all expirations
   *   - byExpiry: per-expiry breakdown with absolute share
   *   - dominantExpiry: expiry contributing most absolute GEX
   *   - byStrike: per-strike aggregation across expirations (strike clustering)
   */
  _aggregate(canonical) {
    // 1) Total net GEX across all expirations
    const totalNetGEX = canonical.expirations.reduce(
      (sum, exp) => sum + exp['netGEX$'], 0
    );

    // 2) By-expiry with share calculation
    const totalAbsGEX = canonical.expirations.reduce(
      (sum, exp) => sum + Math.abs(exp['netGEX$']), 0
    );

    const byExpiry = canonical.expirations.map(exp => ({
      expiry: exp.expiry,
      'netGEX$': exp['netGEX$'],
      absShare: totalAbsGEX > 0 ? Math.abs(exp['netGEX$']) / totalAbsGEX : 0,
    }));

    // 3) Dominant expiry = highest absolute netGEX$ share
    const dominantExpiry = byExpiry.reduce(
      (best, e) => Math.abs(e['netGEX$']) > Math.abs(best['netGEX$']) ? e : best,
      byExpiry[0]
    );

    // 4) Strike clustering: aggregate per-strike across expirations
    const strikeMap = new Map();
    for (const exp of canonical.expirations) {
      for (const s of exp.strikes) {
        const existing = strikeMap.get(s.strike);
        if (existing) {
          existing.callOI += s.callOI;
          existing.putOI += s.putOI;
          existing['callGEX$'] += s['callGEX$'];
          existing['putGEX$'] += s['putGEX$'];
          existing['netGEX$'] += s['netGEX$'];
          existing.expiryCount++;
          existing.expiries.push(exp.expiry);
        } else {
          strikeMap.set(s.strike, {
            strike: s.strike,
            callOI: s.callOI,
            putOI: s.putOI,
            'callGEX$': s['callGEX$'],
            'putGEX$': s['putGEX$'],
            'netGEX$': s['netGEX$'],
            expiryCount: 1,
            expiries: [exp.expiry],
          });
        }
      }
    }

    const byStrike = [...strikeMap.values()].sort((a, b) => a.strike - b.strike);

    return { totalNetGEX, totalAbsGEX, byExpiry, dominantExpiry, byStrike };
  }

  // ── Regime classification ────────────────────────────────────────────

  /**
   * Classify the gamma regime based on aggregated totalNetGEX$.
   *
   * Regime labels:
   *   - "Long Gamma"      → totalNetGEX$ > 0 (dealers suppress moves)
   *   - "Short Gamma"     → totalNetGEX$ < 0 (dealers amplify moves)
   *   - "Mixed/Uncertain" → contradiction detected or near-zero GEX
   *
   * Confidence scoring (0-1):
   *   base = min(|totalNetGEX$| / normalizationFactor, 1.0)
   *   adjusted by distance from gamma flip (if known)
   *   Capped at 1.0.
   */
  _classifyRegime(aggregation, canonical) {
    const { totalNetGEX } = aggregation;

    // Normalization: $100M is "full confidence" territory for major indices
    // Smaller amounts get proportionally less confidence
    const normFactor = 1e8; // $100M
    let baseConfidence = Math.min(Math.abs(totalNetGEX) / normFactor, 1.0);

    // Determine raw label from sign
    let rawLabel;
    if (totalNetGEX > 0) {
      rawLabel = 'Long Gamma';
    } else if (totalNetGEX < 0) {
      rawLabel = 'Short Gamma';
    } else {
      rawLabel = 'Mixed/Uncertain';
    }

    // Cross-check with per-expiry flip data
    // If majority of expirations disagree with the aggregate label, reduce confidence
    const flipRegimes = canonical.expirations
      .filter(e => e.flip && e.flip.regime)
      .map(e => e.flip.regime);

    const longCount = flipRegimes.filter(r => r === 'long_gamma').length;
    const shortCount = flipRegimes.filter(r => r === 'short_gamma').length;

    let label = rawLabel;
    let warning = null;

    if (rawLabel === 'Long Gamma' && shortCount > longCount && flipRegimes.length > 0) {
      // Majority of individual expirations say short gamma, but aggregate is positive
      // This can happen when a large single expiry dominates
      baseConfidence *= 0.5;
      warning = `Aggregate GEX is positive ($${this._fmtDollar(totalNetGEX)}) but ${shortCount}/${flipRegimes.length} expirations show short gamma locally`;
      log.warn(warning);
    } else if (rawLabel === 'Short Gamma' && longCount > shortCount && flipRegimes.length > 0) {
      baseConfidence *= 0.5;
      warning = `Aggregate GEX is negative ($${this._fmtDollar(totalNetGEX)}) but ${longCount}/${flipRegimes.length} expirations show long gamma locally`;
      log.warn(warning);
    }

    // If totalNetGEX is near zero, confidence is low
    if (Math.abs(totalNetGEX) < this.config.min_abs_gex_to_consider_dominant) {
      label = 'Mixed/Uncertain';
      baseConfidence = Math.min(baseConfidence, 0.2);
    }

    // Boost confidence if spot is far from any flip point
    const flipStrikes = canonical.expirations
      .filter(e => e.flip?.flipStrike)
      .map(e => e.flip.flipStrike);
    if (flipStrikes.length > 0 && canonical.spot > 0) {
      const nearestFlip = flipStrikes.reduce(
        (best, f) => Math.abs(f - canonical.spot) < Math.abs(best - canonical.spot) ? f : best
      );
      const distancePct = Math.abs(canonical.spot - nearestFlip) / canonical.spot;
      // If > 2% away from flip, boost confidence
      if (distancePct > 0.02) {
        baseConfidence = Math.min(baseConfidence * 1.3, 1.0);
      }
      // If < 0.5% from flip, reduce confidence (regime is ambiguous near flip)
      if (distancePct < 0.005) {
        baseConfidence *= 0.6;
      }
    }

    const confidence = Math.round(baseConfidence * 100) / 100; // 2 decimal places

    return { label, confidence, warning };
  }

  // ── Stacked wall detection ───────────────────────────────────────────

  /**
   * Find top-3 call walls and top-3 put walls from aggregated strike data.
   *
   * A "stacked" wall is one that appears in ≥2 expirations at the same strike.
   * This means it has stronger market significance.
   */
  _findStackedWalls(aggregation) {
    const { byStrike } = aggregation;

    // Call walls: strikes with highest positive aggregated netGEX$
    const callSorted = [...byStrike]
      .filter(s => s['netGEX$'] > 0)
      .sort((a, b) => b['netGEX$'] - a['netGEX$']);

    const callWalls = callSorted.slice(0, 3).map(s => ({
      strike: s.strike,
      'netGEX$': s['netGEX$'],
      stacked: s.expiryCount > 1,
      expiryCount: s.expiryCount,
      expiries: s.expiries,
    }));

    // Put walls: strikes with most negative aggregated netGEX$
    const putSorted = [...byStrike]
      .filter(s => s['netGEX$'] < 0)
      .sort((a, b) => a['netGEX$'] - b['netGEX$']);

    const putWalls = putSorted.slice(0, 3).map(s => ({
      strike: s.strike,
      'netGEX$': s['netGEX$'],
      stacked: s.expiryCount > 1,
      expiryCount: s.expiryCount,
      expiries: s.expiries,
    }));

    return { callWalls, putWalls };
  }

  // ── Aggregated gamma flip ────────────────────────────────────────────

  /**
   * Find the aggregated gamma flip point by walking cumulative GEX
   * across the cross-expiry strike data.
   */
  _findAggregatedFlip(aggregation, spotPrice) {
    const { byStrike } = aggregation;
    if (byStrike.length === 0) return null;

    let cumulative = 0;
    for (let i = 0; i < byStrike.length; i++) {
      const prev = cumulative;
      cumulative += byStrike[i]['netGEX$'];

      if (i > 0 && prev !== 0 && Math.sign(prev) !== Math.sign(cumulative)) {
        const ratio = Math.abs(prev) / (Math.abs(prev) + Math.abs(byStrike[i]['netGEX$']));
        const flip = byStrike[i - 1].strike + ratio * (byStrike[i].strike - byStrike[i - 1].strike);
        return Math.round(flip * 100) / 100;
      }
    }

    return null;
  }

  // ── Playbook generation ──────────────────────────────────────────────

  /**
   * Generate max 3 actionable playbook bullets based on current regime,
   * wall positions, flip, and spot price.
   */
  _generatePlaybook(regime, walls, gammaFlip, spot) {
    const lines = [];
    const primaryCall = walls.callWalls[0];
    const primaryPut = walls.putWalls[0];
    const nextCall = walls.callWalls[1];
    const nextPut = walls.putWalls[1];

    if (regime.label === 'Long Gamma') {
      if (primaryCall && spot < primaryCall.strike) {
        lines.push(`Below $${primaryCall.strike} call wall in long gamma: expect pin / mean-reversion toward $${primaryCall.strike}`);
      }
      if (primaryCall && spot > primaryCall.strike) {
        const target = nextCall ? `$${nextCall.strike}` : 'next resistance';
        lines.push(`Acceptance above $${primaryCall.strike} call wall: upside expansion risk to ${target}`);
      }
      if (primaryPut && spot < primaryPut.strike) {
        const target = nextPut ? `$${nextPut.strike}` : 'next support';
        lines.push(`Breakdown below $${Math.abs(primaryPut.strike)} put cluster: downside expansion risk to ${target}`);
      }
    } else if (regime.label === 'Short Gamma') {
      if (primaryPut) {
        const target = nextPut ? `$${nextPut.strike}` : 'next support';
        lines.push(`Short gamma amplifies moves — breakdown below $${primaryPut.strike} put wall targets ${target}`);
      }
      if (primaryCall) {
        lines.push(`Short squeeze risk if $${primaryCall.strike} call wall is breached (dealer cover)`);
      }
      if (gammaFlip) {
        lines.push(`Watch gamma flip at $${gammaFlip} — reclaim = shift to long gamma regime`);
      }
    } else {
      // Mixed/Uncertain
      lines.push('Regime unclear — reduce position sizing until GEX signal strengthens');
      if (gammaFlip) {
        lines.push(`Key level: gamma flip at $${gammaFlip} — direction from here sets regime`);
      }
    }

    return lines.slice(0, 3);
  }

  // ── Discord formatting ───────────────────────────────────────────────

  /**
   * Format the multi-expiry GEX summary for Discord.
   * Kept under ~1100 chars to fit in a single Discord message.
   */
  formatSummaryForDiscord(summary) {
    const { ticker, spot, regime, walls, gammaFlip, playbook, aggregation } = summary;
    const { dominantExpiry } = aggregation;

    const regimeEmoji = regime.label === 'Long Gamma' ? '🟢'
      : regime.label === 'Short Gamma' ? '🔴' : '🟡';

    const confBar = this._confidenceBar(regime.confidence);

    // 1) Dominant expiry line
    const domShare = (dominantExpiry.absShare * 100).toFixed(0);
    const domLine = `Dominant: \`${dominantExpiry.expiry}\` (${domShare}% of GEX)`;

    // 2) Regime line
    const regimeLine = `${regimeEmoji} **${regime.label}** ${confBar} (${(regime.confidence * 100).toFixed(0)}%)`;

    // 3) Stacked levels
    const callWall = walls.callWalls[0];
    const putWall = walls.putWalls[0];

    const callLine = callWall
      ? `Call Wall: \`$${callWall.strike}\` (${this._fmtDollar(callWall['netGEX$'])})${callWall.stacked ? ' **STACKED**' : ''}`
      : 'Call Wall: —';
    const putLine = putWall
      ? `Put Wall: \`$${putWall.strike}\` (${this._fmtDollar(putWall['netGEX$'])})${putWall.stacked ? ' **STACKED**' : ''}`
      : 'Put Wall: —';
    const flipLine = gammaFlip
      ? `Flip: \`$${gammaFlip}\` ${spot > gammaFlip ? '(spot ABOVE)' : '(spot BELOW)'}`
      : 'Flip: not detected';

    // 4) Playbook
    const playbookLines = playbook.map(p => `• ${p}`).join('\n');

    const lines = [
      `**${ticker} — GEX Summary** | Spot: \`$${spot}\``,
      domLine,
      ``,
      regimeLine,
      `Net GEX: ${this._fmtDollar(aggregation.totalNetGEX)}`,
      ``,
      callLine,
      putLine,
      flipLine,
      ``,
      playbookLines,
      ``,
      `_${summary.source} | ${aggregation.byExpiry.length} expiries_`,
    ];

    return lines.join('\n');
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * Format a dollar value with appropriate scale suffix.
   * $1.23B, $456.78M, $12.34K, or $123
   */
  _fmtDollar(value) {
    const abs = Math.abs(value);
    const sign = value < 0 ? '-' : '';
    if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
    return `${sign}$${abs.toFixed(0)}`;
  }

  /**
   * Visual confidence bar for Discord.
   */
  _confidenceBar(confidence) {
    const filled = Math.round(confidence * 5);
    return '█'.repeat(filled) + '░'.repeat(5 - filled);
  }

  /**
   * Get chart buffer from the dominant expiry's raw result.
   */
  _getDominantChart(raw, aggregation) {
    const domExpiry = aggregation.dominantExpiry?.expiry;
    const match = raw.expirations.find(e => e.expiry === domExpiry);
    return match?.chartBuffer || raw.expirations[0]?.chartBuffer || null;
  }
}

module.exports = GEXEngine;
