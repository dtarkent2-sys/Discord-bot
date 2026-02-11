/**
 * GEX Break-and-Hold Alert System
 *
 * Monitors key GEX levels (call walls, put walls, gamma flip) and
 * classifies break-and-hold conditions using recent candle data.
 *
 * "Hold" definition:
 *   N consecutive candle closes above (or below) a level.
 *   Configurable via hold_candles (default: 3) and candle_interval (default: 5Min).
 *
 * Optional volume confirmation:
 *   If volume data exists and volume_confirm is true, requires average volume
 *   during the hold period to exceed the prior-period average.
 *
 * Alerts are emitted as Discord message strings — the caller decides where to send them.
 */

const log = require('../logger')('GEXAlerts');

class GEXAlertService {
  /**
   * @param {object} config - { hold_candles, candle_interval, volume_confirm, min_regime_confidence_to_alert }
   */
  constructor(config = {}) {
    this.holdCandles = config.hold_candles || 3;
    this.candleInterval = config.candle_interval || '5Min';
    this.volumeConfirm = config.volume_confirm || false;
    this.minConfidence = config.min_regime_confidence_to_alert || 0.4;

    // Track which alerts have been emitted recently to avoid spam
    // Key: `${ticker}:${level}:${direction}`, Value: timestamp
    this._emitted = new Map();
    this._cooldownMs = 60 * 60 * 1000; // 1h cooldown per alert
  }

  /**
   * Evaluate break-and-hold conditions for a set of GEX levels.
   *
   * @param {string} ticker
   * @param {Array<{close: number, volume?: number}>} candles - Recent candles (oldest first)
   * @param {object} summary - GEX engine summary (from GEXEngine.analyze)
   * @returns {Array<{type: string, level: number, direction: string, message: string}>} alerts to emit
   */
  evaluate(ticker, candles, summary) {
    if (!candles || candles.length < this.holdCandles) {
      log.debug(`${ticker}: Not enough candles (${candles?.length || 0} < ${this.holdCandles})`);
      return [];
    }

    if (summary.regime.confidence < this.minConfidence) {
      log.debug(`${ticker}: Regime confidence too low (${summary.regime.confidence} < ${this.minConfidence})`);
      return [];
    }

    const alerts = [];
    const recentCandles = candles.slice(-this.holdCandles);

    // Levels to monitor
    const levels = this._extractLevels(summary);

    for (const level of levels) {
      const breakHold = this._checkBreakAndHold(recentCandles, level.price, level.direction, candles);

      if (breakHold.triggered) {
        const alertKey = `${ticker}:${level.price}:${level.direction}`;

        if (this._isCoolingDown(alertKey)) {
          log.debug(`${ticker}: Alert for $${level.price} ${level.direction} still in cooldown`);
          continue;
        }

        const msg = this._formatAlert(ticker, level, breakHold, summary);
        alerts.push({
          type: level.type,
          level: level.price,
          direction: level.direction,
          message: msg,
        });

        this._emitted.set(alertKey, Date.now());
      }
    }

    return alerts;
  }

  /**
   * Extract monitorable levels from a GEX summary.
   */
  _extractLevels(summary) {
    const levels = [];

    // Call walls — watch for break above
    for (const wall of summary.walls.callWalls) {
      levels.push({
        type: 'call_wall',
        price: wall.strike,
        direction: 'above',
        label: `Call Wall $${wall.strike}`,
        stacked: wall.stacked,
      });
    }

    // Put walls — watch for break below
    for (const wall of summary.walls.putWalls) {
      levels.push({
        type: 'put_wall',
        price: wall.strike,
        direction: 'below',
        label: `Put Wall $${wall.strike}`,
        stacked: wall.stacked,
      });
    }

    // Gamma flip — watch for cross in either direction
    if (summary.gammaFlip) {
      levels.push({
        type: 'gamma_flip',
        price: summary.gammaFlip,
        direction: 'above',
        label: `Gamma Flip $${summary.gammaFlip}`,
        stacked: false,
      });
      levels.push({
        type: 'gamma_flip',
        price: summary.gammaFlip,
        direction: 'below',
        label: `Gamma Flip $${summary.gammaFlip}`,
        stacked: false,
      });
    }

    return levels;
  }

  /**
   * Check if N consecutive candle closes are above/below a level.
   *
   * @param {Array} recentCandles - Last N candles
   * @param {number} level - Price level to check
   * @param {string} direction - 'above' or 'below'
   * @param {Array} allCandles - All available candles (for volume comparison)
   * @returns {{ triggered: boolean, volumeConfirmed: boolean|null }}
   */
  _checkBreakAndHold(recentCandles, level, direction, allCandles) {
    const closes = recentCandles.map(c => c.close);
    let allMatch;

    if (direction === 'above') {
      allMatch = closes.every(c => c > level);
    } else {
      allMatch = closes.every(c => c < level);
    }

    if (!allMatch) return { triggered: false, volumeConfirmed: null };

    // Volume confirmation (if enabled and data exists)
    let volumeConfirmed = null;
    if (this.volumeConfirm) {
      const recentVols = recentCandles.map(c => c.volume).filter(v => v != null && v > 0);
      if (recentVols.length > 0 && allCandles.length > this.holdCandles) {
        const priorCandles = allCandles.slice(0, -this.holdCandles);
        const priorVols = priorCandles.map(c => c.volume).filter(v => v != null && v > 0);
        if (priorVols.length > 0) {
          const avgRecent = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
          const avgPrior = priorVols.reduce((a, b) => a + b, 0) / priorVols.length;
          volumeConfirmed = avgRecent > avgPrior;
        }
      }
    }

    return { triggered: true, volumeConfirmed };
  }

  /**
   * Format a break-and-hold alert as a Discord message.
   */
  _formatAlert(ticker, level, breakHold, summary) {
    const emoji = level.direction === 'above' ? '🟢' : '🔴';
    const action = level.direction === 'above' ? 'BREAK & HOLD ABOVE' : 'BREAK & HOLD BELOW';
    const stackedTag = level.stacked ? ' [STACKED]' : '';

    const volLine = breakHold.volumeConfirmed === true
      ? '✅ Volume confirmed'
      : breakHold.volumeConfirmed === false
        ? '⚠️ Volume not confirmed'
        : '';

    const lines = [
      `${emoji} **GEX ALERT — ${ticker}**`,
      `**${action}** \`$${level.price}\` ${level.type.replace('_', ' ')}${stackedTag}`,
      `Regime: ${summary.regime.label} (${(summary.regime.confidence * 100).toFixed(0)}%)`,
      `${this.holdCandles} consecutive ${this.candleInterval} closes ${level.direction} level`,
    ];

    if (volLine) lines.push(volLine);

    // Add context
    if (level.type === 'call_wall' && level.direction === 'above') {
      lines.push('→ Upside expansion risk — dealers forced to cover');
    } else if (level.type === 'put_wall' && level.direction === 'below') {
      lines.push('→ Downside expansion risk — dealer selling amplifies');
    } else if (level.type === 'gamma_flip' && level.direction === 'above') {
      lines.push('→ Entering long gamma territory — expect mean reversion');
    } else if (level.type === 'gamma_flip' && level.direction === 'below') {
      lines.push('→ Entering short gamma territory — expect trend/vol expansion');
    }

    lines.push(`_/gex summary ${ticker} for full breakdown_`);

    return lines.join('\n');
  }

  /**
   * Check if an alert is still in cooldown.
   */
  _isCoolingDown(key) {
    const last = this._emitted.get(key);
    if (!last) return false;
    return (Date.now() - last) < this._cooldownMs;
  }

  /**
   * Clear cooldown state (useful for testing).
   */
  clearCooldowns() {
    this._emitted.clear();
  }
}

module.exports = GEXAlertService;
