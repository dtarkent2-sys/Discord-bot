/**
 * Gamma Setups Scanner — Find Stocks With Good Gamma Positioning
 *
 * Scans a universe of liquid stocks and ranks them by gamma setup quality.
 * "Good gamma setup" = stock is NOT too hedged by dealers, meaning:
 *   - Short gamma regime (dealers amplify moves — trend potential)
 *   - Near gamma flip (transition zone — breakout potential)
 *   - Weak long gamma (dealers barely suppressing — could flip)
 *
 * Filters OUT:
 *   - Strong long gamma (dealers firmly suppress moves — pinned)
 *   - Insufficient options data / illiquid chains
 *
 * Scoring dimensions:
 *   1. Regime favorability: short gamma > near-flip > weak long > strong long
 *   2. Flip proximity: closer to flip = more explosive potential
 *   3. GEX magnitude: higher absolute GEX = more dealer involvement
 *   4. Wall asymmetry: unbalanced call/put walls = directional bias
 *   5. Squeeze state: active squeeze signals boost score
 *
 * Data: Uses existing GEX engine (gamma.js + gex-engine.js) for analysis.
 */

const gamma = require('./gamma');
const GEXEngine = require('./gex-engine');
const gammaSqueeze = require('./gamma-squeeze');

// ── Default scan universe ────────────────────────────────────────────────
// Liquid names with active options chains — broad enough to find setups,
// small enough to scan without hammering APIs.

const UNIVERSES = {
  default: [
    'SPY', 'QQQ', 'IWM', 'DIA',           // Index ETFs
    'AAPL', 'MSFT', 'NVDA', 'AMZN',        // Mega-cap tech
    'TSLA', 'META', 'GOOGL', 'AMD',         // High-vol tech
    'NFLX', 'CRM', 'AVGO', 'MU',           // Growth/semis
    'JPM', 'GS', 'BAC', 'XLF',             // Financials
    'XLE', 'XOM', 'CVX',                    // Energy
    'COIN', 'MSTR', 'SQ',                   // Crypto-adjacent
    'SMCI', 'ARM', 'PLTR',                  // AI/momentum
  ],
  indices: ['SPY', 'QQQ', 'IWM', 'DIA', 'XLF', 'XLE', 'XLK', 'XLV'],
  tech: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'TSLA', 'META', 'GOOGL', 'AMD', 'AVGO', 'MU', 'CRM', 'NFLX', 'ARM', 'PLTR', 'SMCI'],
  megacap: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'V', 'UNH', 'XOM', 'LLY'],
};

// ── Scoring constants ────────────────────────────────────────────────────

const WEIGHTS = {
  regime: 35,          // Most important: regime type
  flipProximity: 25,   // How close to gamma flip
  wallAsymmetry: 15,   // Directional bias from wall imbalance
  gexMagnitude: 10,    // Dealer involvement level
  squeeze: 15,         // Squeeze engine signal boost
};

// Long gamma confidence threshold — above this = "too hedged"
const TOO_HEDGED_THRESHOLD = 0.55;

// ── Scanner ──────────────────────────────────────────────────────────────

class GammaSetupsScanner {
  constructor() {
    this._gexEngine = new GEXEngine(gamma);
  }

  /**
   * Scan a universe of stocks and return ranked gamma setups.
   *
   * @param {object} [opts]
   * @param {string} [opts.universe='default'] - Universe name or comma-separated tickers
   * @param {number} [opts.limit=10] - Max results to return
   * @returns {Promise<{ setups: Array<GammaSetup>, scanned: number, filtered: number, errors: string[] }>}
   */
  async scan(opts = {}) {
    const { universe = 'default', limit = 10 } = opts;

    // Resolve ticker list
    const tickers = this._resolveUniverse(universe);
    const setups = [];
    const errors = [];

    for (const ticker of tickers) {
      try {
        const setup = await this._analyzeSetup(ticker);
        if (setup) {
          setups.push(setup);
        }
      } catch (err) {
        // Non-fatal — skip this ticker
        const msg = err.message || 'Unknown error';
        if (!msg.includes('rate limit') && !msg.includes('Too Many')) {
          errors.push(`${ticker}: ${msg.slice(0, 80)}`);
        }
      }

      // Rate limit between tickers
      await this._sleep(1500);
    }

    // Sort by score descending (best setups first)
    setups.sort((a, b) => b.score - a.score);

    // Filter out "too hedged" stocks
    const filtered = setups.filter(s => !s.tooHedged);
    const hedgedCount = setups.length - filtered.length;

    return {
      setups: filtered.slice(0, limit),
      scanned: tickers.length,
      filtered: hedgedCount,
      errors: errors.slice(0, 5),
    };
  }

  /**
   * Analyze a single ticker for gamma setup quality.
   * Returns null if insufficient data.
   *
   * @param {string} ticker
   * @returns {Promise<GammaSetup|null>}
   */
  async _analyzeSetup(ticker) {
    // Run multi-expiry GEX analysis
    const gexSummary = await this._gexEngine.analyze(ticker);
    const { spot, regime, walls, gammaFlip, aggregation } = gexSummary;

    if (!spot || !aggregation) return null;

    const netGEX = aggregation.totalNetGEX;
    const absGEX = Math.abs(netGEX);

    // Get squeeze signal if available
    let squeezeSignal = { active: false, state: 'normal', convictionBoost: 0 };
    try {
      squeezeSignal = gammaSqueeze.getSqueezeSignal(ticker);
    } catch { /* squeeze engine may not have data for this ticker */ }

    // ── Score each dimension ──

    // 1. Regime score (0-100)
    const regimeScore = this._scoreRegime(regime);

    // 2. Flip proximity score (0-100)
    const flipScore = this._scoreFlipProximity(spot, gammaFlip);

    // 3. Wall asymmetry score (0-100)
    const { wallScore, direction: wallDirection } = this._scoreWallAsymmetry(walls, spot);

    // 4. GEX magnitude score (0-100)
    const magnitudeScore = this._scoreMagnitude(absGEX);

    // 5. Squeeze signal boost (0-100)
    const squeezeScore = this._scoreSqueezeSignal(squeezeSignal);

    // ── Weighted composite ──
    const score = Math.round(
      (regimeScore * WEIGHTS.regime +
       flipScore * WEIGHTS.flipProximity +
       wallScore * WEIGHTS.wallAsymmetry +
       magnitudeScore * WEIGHTS.gexMagnitude +
       squeezeScore * WEIGHTS.squeeze) / 100
    );

    // Determine direction bias
    const direction = this._determineDirection(regime, walls, gammaFlip, spot, wallDirection);

    // Is this stock too hedged?
    const tooHedged = regime.label === 'Long Gamma' && regime.confidence >= TOO_HEDGED_THRESHOLD;

    // Flip distance as percentage
    const flipDistPct = gammaFlip ? ((spot - gammaFlip) / spot * 100) : null;

    // Call/put wall info
    const callWall = walls.callWalls?.[0];
    const putWall = walls.putWalls?.[0];

    return {
      ticker,
      score,
      regime: regime.label,
      regimeConfidence: regime.confidence,
      tooHedged,
      spot,
      netGEX,
      gammaFlip,
      flipDistPct,
      direction,
      callWall: callWall ? { strike: callWall.strike, gex: callWall['netGEX$'], stacked: callWall.stacked } : null,
      putWall: putWall ? { strike: putWall.strike, gex: putWall['netGEX$'], stacked: putWall.stacked } : null,
      squeezeState: squeezeSignal.state,
      squeezeActive: squeezeSignal.active,
      source: gexSummary.source,
      breakdown: { regimeScore, flipScore, wallScore, magnitudeScore, squeezeScore },
    };
  }

  // ── Scoring Functions ──────────────────────────────────────────────────

  /**
   * Score the gamma regime (0-100).
   * Short gamma = best, mixed = ok, strong long gamma = worst.
   */
  _scoreRegime(regime) {
    if (regime.label === 'Short Gamma') {
      // Short gamma is the ideal setup — scale by confidence
      return 70 + Math.round(regime.confidence * 30); // 70-100
    }
    if (regime.label === 'Mixed/Uncertain') {
      // Mixed could go either way — moderate score
      return 40 + Math.round(regime.confidence * 20); // 40-60
    }
    // Long gamma — not ideal, but weak long gamma isn't terrible
    if (regime.confidence < 0.3) return 35; // Very weak long gamma — might flip
    if (regime.confidence < TOO_HEDGED_THRESHOLD) return 20; // Moderate long gamma
    return 5; // Strong long gamma — dealers firmly suppress = bad setup
  }

  /**
   * Score proximity to gamma flip (0-100).
   * Closer to flip = higher potential for regime change / explosive moves.
   */
  _scoreFlipProximity(spot, gammaFlip) {
    if (!gammaFlip || !spot) return 30; // Unknown = neutral

    const distPct = Math.abs((spot - gammaFlip) / spot) * 100;

    // Within 0.5% of flip = extremely close (high score)
    if (distPct <= 0.5) return 100;
    // Within 1% = very close
    if (distPct <= 1.0) return 85;
    // Within 2% = close
    if (distPct <= 2.0) return 65;
    // Within 3% = moderate
    if (distPct <= 3.0) return 45;
    // Within 5% = somewhat relevant
    if (distPct <= 5.0) return 25;
    // Far from flip
    return 10;
  }

  /**
   * Score wall asymmetry (0-100).
   * Imbalanced walls suggest directional bias — good for setups.
   */
  _scoreWallAsymmetry(walls, spot) {
    const callWall = walls.callWalls?.[0];
    const putWall = walls.putWalls?.[0];

    if (!callWall && !putWall) return { wallScore: 20, direction: null };

    const callGEX = Math.abs(callWall?.['netGEX$'] || 0);
    const putGEX = Math.abs(putWall?.['netGEX$'] || 0);
    const totalWallGEX = callGEX + putGEX;

    if (totalWallGEX === 0) return { wallScore: 20, direction: null };

    // Asymmetry ratio: 0 = balanced, 1 = completely one-sided
    const asymmetry = Math.abs(callGEX - putGEX) / totalWallGEX;

    // Direction: heavier call wall = bullish magnet, heavier put wall = bearish support
    let direction = null;
    if (callGEX > putGEX * 1.5) direction = 'BULLISH';
    else if (putGEX > callGEX * 1.5) direction = 'BEARISH';

    // Higher asymmetry = clearer directional bias = better setup
    const wallScore = Math.round(20 + asymmetry * 80); // 20-100

    return { wallScore, direction };
  }

  /**
   * Score GEX magnitude (0-100).
   * Higher absolute GEX = more dealer involvement = more impactful setup.
   */
  _scoreMagnitude(absGEX) {
    if (absGEX >= 1e9) return 100;  // $1B+ = massive
    if (absGEX >= 500e6) return 85; // $500M+
    if (absGEX >= 100e6) return 70; // $100M+
    if (absGEX >= 50e6) return 55;  // $50M+
    if (absGEX >= 10e6) return 40;  // $10M+
    if (absGEX >= 1e6) return 25;   // $1M+
    return 10; // Low GEX
  }

  /**
   * Score squeeze signal (0-100).
   * Active squeeze conditions boost the setup score significantly.
   */
  _scoreSqueezeSignal(squeezeSignal) {
    if (!squeezeSignal.active) return 10;
    const stateScores = {
      building: 50,
      active_squeeze: 90,
      knife_fight: 100,
      unwinding: 30,
    };
    return stateScores[squeezeSignal.state] || 10;
  }

  /**
   * Determine overall directional bias for the setup.
   */
  _determineDirection(regime, walls, gammaFlip, spot, wallDirection) {
    // 1. Spot vs gamma flip is strongest signal in short gamma
    if (regime.label === 'Short Gamma' && gammaFlip && spot) {
      if (spot > gammaFlip * 1.002) return 'BULLISH';
      if (spot < gammaFlip * 0.998) return 'BEARISH';
    }

    // 2. Wall asymmetry direction
    if (wallDirection) return wallDirection;

    // 3. In long gamma near flip, direction comes from which side of flip
    if (gammaFlip && spot) {
      if (spot > gammaFlip) return 'BULLISH';
      if (spot < gammaFlip) return 'BEARISH';
    }

    return 'NEUTRAL';
  }

  // ── Universe Resolution ────────────────────────────────────────────────

  _resolveUniverse(input) {
    if (!input) return UNIVERSES.default;

    const lower = input.toLowerCase().trim();
    if (UNIVERSES[lower]) return UNIVERSES[lower];

    // Treat as comma-separated tickers
    const tickers = input.split(',')
      .map(t => t.trim().toUpperCase())
      .filter(t => t.length > 0 && t.length <= 12);

    return tickers.length > 0 ? tickers : UNIVERSES.default;
  }

  // ── Discord Formatting ─────────────────────────────────────────────────

  /**
   * Format scan results for Discord.
   */
  formatForDiscord(result) {
    const { setups, scanned, filtered, errors } = result;

    if (setups.length === 0) {
      return [
        '**Gamma Setups Scanner**',
        `Scanned ${scanned} stocks. No good gamma setups found.`,
        filtered > 0 ? `${filtered} stocks filtered out (too hedged by dealers).` : '',
        errors.length > 0 ? `\nErrors: ${errors.join(', ')}` : '',
      ].filter(Boolean).join('\n');
    }

    const lines = [
      '**Gamma Setups — Stocks Not Too Hedged**',
      `_Scanned ${scanned} | ${filtered} too-hedged filtered out | ${setups.length} setups found_`,
      '',
    ];

    for (let i = 0; i < setups.length; i++) {
      const s = setups[i];
      const rank = i + 1;
      const dirEmoji = s.direction === 'BULLISH' ? '+' : s.direction === 'BEARISH' ? '-' : '~';
      const regimeTag = s.regime === 'Short Gamma' ? 'SHORT GAMMA'
        : s.regime === 'Mixed/Uncertain' ? 'MIXED'
        : `LONG GAMMA (${(s.regimeConfidence * 100).toFixed(0)}%)`;

      const flipInfo = s.gammaFlip
        ? `Flip: $${s.gammaFlip} (${s.flipDistPct > 0 ? '+' : ''}${s.flipDistPct.toFixed(2)}%)`
        : 'Flip: --';

      const callInfo = s.callWall
        ? `Call: $${s.callWall.strike}${s.callWall.stacked ? '*' : ''}`
        : 'Call: --';
      const putInfo = s.putWall
        ? `Put: $${s.putWall.strike}${s.putWall.stacked ? '*' : ''}`
        : 'Put: --';

      const squeezeBadge = s.squeezeActive ? ` | SQUEEZE: ${s.squeezeState}` : '';

      lines.push(
        `**${rank}. ${s.ticker}** — Score: \`${s.score}\` | \`${dirEmoji}\` **${s.direction}** | ${regimeTag}`,
        `   Spot: \`$${s.spot}\` | GEX: \`${this._fmtDollar(s.netGEX)}\` | ${flipInfo}`,
        `   ${callInfo} | ${putInfo}${squeezeBadge}`,
        '',
      );
    }

    lines.push('_Score: 0-100 (higher = better setup). * = stacked wall (multi-expiry)._');
    lines.push(`_${setups[0]?.source || 'Multi-source'} data._`);

    return lines.join('\n');
  }

  /**
   * Format a single setup detail for Discord.
   */
  formatDetailForDiscord(setup) {
    if (!setup) return 'No setup data available.';

    const s = setup;
    const dirEmoji = s.direction === 'BULLISH' ? '+' : s.direction === 'BEARISH' ? '-' : '~';

    const lines = [
      `**${s.ticker} — Gamma Setup Detail**`,
      '',
      `**Score: \`${s.score}/100\`** | \`${dirEmoji}\` **${s.direction}**`,
      `Regime: **${s.regime}** (${(s.regimeConfidence * 100).toFixed(0)}% confidence)`,
      s.tooHedged ? '**WARNING: Too hedged — dealers suppress moves**' : '',
      '',
      `Spot: \`$${s.spot}\` | Net GEX: \`${this._fmtDollar(s.netGEX)}\``,
      s.gammaFlip ? `Gamma Flip: \`$${s.gammaFlip}\` (${s.flipDistPct > 0 ? 'above' : 'below'}, ${Math.abs(s.flipDistPct).toFixed(2)}% away)` : 'Gamma Flip: not detected',
      '',
      s.callWall ? `Call Wall: \`$${s.callWall.strike}\` (${this._fmtDollar(s.callWall.gex)})${s.callWall.stacked ? ' **STACKED**' : ''}` : 'Call Wall: --',
      s.putWall ? `Put Wall: \`$${s.putWall.strike}\` (${this._fmtDollar(s.putWall.gex)})${s.putWall.stacked ? ' **STACKED**' : ''}` : 'Put Wall: --',
      '',
      s.squeezeActive ? `Squeeze: **${s.squeezeState}**` : 'Squeeze: none',
      '',
      '**Score Breakdown:**',
      `  Regime: ${s.breakdown.regimeScore}/100 (wt ${WEIGHTS.regime}%)`,
      `  Flip proximity: ${s.breakdown.flipScore}/100 (wt ${WEIGHTS.flipProximity}%)`,
      `  Wall asymmetry: ${s.breakdown.wallScore}/100 (wt ${WEIGHTS.wallAsymmetry}%)`,
      `  GEX magnitude: ${s.breakdown.magnitudeScore}/100 (wt ${WEIGHTS.gexMagnitude}%)`,
      `  Squeeze signal: ${s.breakdown.squeezeScore}/100 (wt ${WEIGHTS.squeeze}%)`,
      '',
      `_${s.source} data._`,
    ];

    return lines.filter(Boolean).join('\n');
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  _fmtDollar(value) {
    const abs = Math.abs(value);
    const sign = value < 0 ? '-' : '';
    if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
    return `${sign}$${abs.toFixed(0)}`;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new GammaSetupsScanner();
