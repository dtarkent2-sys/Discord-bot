/**
 * Technical Analysis Engine
 *
 * Ported from SHARK (https://github.com/ygwyg/SHARK)
 * Provides RSI, MACD, Bollinger Bands, SMA/EMA, ATR calculations
 * and automated signal detection (oversold/overbought, crossovers, etc.)
 *
 * All functions are pure math — no external API calls needed.
 * Feed them price bars from Alpaca, Yahoo, or any OHLCV source.
 */

const alpaca = require('./alpaca');

// ── Core Indicators ─────────────────────────────────────────────────

/**
 * Simple Moving Average
 * @param {number[]} prices - array of prices (oldest first)
 * @param {number} period
 * @returns {number|null}
 */
function calculateSMA(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Exponential Moving Average
 * @param {number[]} prices
 * @param {number} period
 * @returns {number|null}
 */
function calculateEMA(prices, period) {
  if (prices.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }
  return ema;
}

/**
 * Relative Strength Index (Wilder's smoothing)
 * @param {number[]} prices
 * @param {number} period - default 14
 * @returns {number|null}
 */
function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }
  const gains = changes.map(c => (c > 0 ? c : 0));
  const losses = changes.map(c => (c < 0 ? -c : 0));

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * MACD (12/26/9)
 * @param {number[]} prices
 * @returns {{ macd: number, signal: number, histogram: number }|null}
 */
function calculateMACD(prices) {
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  if (ema12 === null || ema26 === null) return null;
  const macdLine = ema12 - ema26;

  // Recompute intermediate MACD values for signal line
  const macdValues = [];
  let tempEma12 = prices.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
  let tempEma26 = prices.slice(0, 26).reduce((a, b) => a + b, 0) / 26;
  for (let i = 26; i < prices.length; i++) {
    tempEma12 = (prices[i] - tempEma12) * (2 / 13) + tempEma12;
    tempEma26 = (prices[i] - tempEma26) * (2 / 27) + tempEma26;
    macdValues.push(tempEma12 - tempEma26);
  }
  if (macdValues.length < 9) return null;

  // Signal line = 9-period EMA of MACD values
  let signal = macdValues.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
  for (let i = 9; i < macdValues.length; i++) {
    signal = (macdValues[i] - signal) * (2 / 10) + signal;
  }
  return { macd: macdLine, signal, histogram: macdLine - signal };
}

/**
 * Bollinger Bands (20-period, 2 std dev)
 * @param {number[]} prices
 * @param {number} period
 * @param {number} stdDev
 * @returns {{ upper: number, middle: number, lower: number, width: number }|null}
 */
function calculateBollingerBands(prices, period = 20, stdDev = 2) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const squaredDiffs = slice.map(p => (p - middle) ** 2);
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(variance);
  const upper = middle + stdDev * std;
  const lower = middle - stdDev * std;
  const width = middle > 0 ? (upper - lower) / middle : 0;
  return { upper, middle, lower, width };
}

/**
 * Average True Range (requires OHLCV bars)
 * @param {Array<{h: number, l: number, c: number}>} bars
 * @param {number} period
 * @returns {number|null}
 */
function calculateATR(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trueRanges = [];
  for (let i = 1; i < bars.length; i++) {
    const current = bars[i];
    const prev = bars[i - 1];
    const tr = Math.max(
      current.h - current.l,
      Math.abs(current.h - prev.c),
      Math.abs(current.l - prev.c)
    );
    trueRanges.push(tr);
  }
  if (trueRanges.length < period) return null;

  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  return atr;
}

// ── Compute all indicators at once ──────────────────────────────────

/**
 * Compute full technical analysis from OHLCV bars.
 * @param {string} symbol
 * @param {Array<{t: string, o: number, h: number, l: number, c: number, v: number}>} bars
 * @returns {object} TechnicalIndicators
 */
function computeTechnicals(symbol, bars) {
  const closes = bars.map(b => b.c);
  const volumes = bars.map(b => b.v);
  const currentPrice = closes[closes.length - 1] ?? 0;
  const currentVolume = volumes[volumes.length - 1] ?? 0;
  const volumeSma = calculateSMA(volumes, 20);
  const relativeVolume = volumeSma && volumeSma > 0 ? currentVolume / volumeSma : null;

  return {
    symbol,
    timestamp: bars[bars.length - 1]?.t ?? new Date().toISOString(),
    price: currentPrice,
    sma_20: calculateSMA(closes, 20),
    sma_50: calculateSMA(closes, 50),
    sma_200: calculateSMA(closes, 200),
    ema_12: calculateEMA(closes, 12),
    ema_26: calculateEMA(closes, 26),
    rsi_14: calculateRSI(closes, 14),
    macd: calculateMACD(closes),
    bollinger: calculateBollingerBands(closes, 20, 2),
    atr_14: calculateATR(bars, 14),
    volume_sma_20: volumeSma,
    relative_volume: relativeVolume,
  };
}

// ── Signal Detection ────────────────────────────────────────────────

/**
 * Detect actionable trading signals from technical indicators.
 * @param {object} tech - output from computeTechnicals()
 * @returns {Array<{type: string, direction: string, strength: number, description: string}>}
 */
function detectSignals(tech) {
  const signals = [];

  // RSI oversold / overbought
  if (tech.rsi_14 !== null) {
    if (tech.rsi_14 < 30) {
      signals.push({
        type: 'rsi_oversold', direction: 'bullish',
        strength: (30 - tech.rsi_14) / 30,
        description: `RSI at ${tech.rsi_14.toFixed(1)} — oversold territory`,
      });
    } else if (tech.rsi_14 > 70) {
      signals.push({
        type: 'rsi_overbought', direction: 'bearish',
        strength: (tech.rsi_14 - 70) / 30,
        description: `RSI at ${tech.rsi_14.toFixed(1)} — overbought territory`,
      });
    }
  }

  // MACD crossover
  if (tech.macd !== null) {
    if (tech.macd.histogram > 0 && tech.macd.macd > tech.macd.signal) {
      signals.push({
        type: 'macd_bullish', direction: 'bullish',
        strength: Math.min(1, Math.abs(tech.macd.histogram) * 10),
        description: 'MACD above signal line — bullish momentum',
      });
    } else if (tech.macd.histogram < 0 && tech.macd.macd < tech.macd.signal) {
      signals.push({
        type: 'macd_bearish', direction: 'bearish',
        strength: Math.min(1, Math.abs(tech.macd.histogram) * 10),
        description: 'MACD below signal line — bearish momentum',
      });
    }
  }

  // Bollinger Band position
  if (tech.bollinger !== null) {
    const bbPos = (tech.price - tech.bollinger.lower) / (tech.bollinger.upper - tech.bollinger.lower);
    if (bbPos < 0.1) {
      signals.push({
        type: 'bb_lower_touch', direction: 'bullish',
        strength: 1 - bbPos * 10,
        description: 'Price near lower Bollinger Band — potential bounce',
      });
    } else if (bbPos > 0.9) {
      signals.push({
        type: 'bb_upper_touch', direction: 'bearish',
        strength: (bbPos - 0.9) * 10,
        description: 'Price near upper Bollinger Band — potential pullback',
      });
    }
  }

  // SMA cross (20 vs 50)
  if (tech.sma_20 !== null && tech.sma_50 !== null) {
    const crossStrength = Math.abs(tech.sma_20 - tech.sma_50) / tech.price;
    if (tech.sma_20 > tech.sma_50) {
      signals.push({
        type: 'golden_cross_active', direction: 'bullish',
        strength: Math.min(1, crossStrength * 20),
        description: '20 SMA above 50 SMA — bullish trend',
      });
    } else {
      signals.push({
        type: 'death_cross_active', direction: 'bearish',
        strength: Math.min(1, crossStrength * 20),
        description: '20 SMA below 50 SMA — bearish trend',
      });
    }
  }

  // Price vs 200 SMA (trend filter)
  if (tech.sma_200 !== null) {
    if (tech.price > tech.sma_200) {
      signals.push({
        type: 'above_200sma', direction: 'bullish',
        strength: Math.min(1, ((tech.price - tech.sma_200) / tech.sma_200) * 10),
        description: `Price above 200 SMA — long-term uptrend`,
      });
    } else {
      signals.push({
        type: 'below_200sma', direction: 'bearish',
        strength: Math.min(1, ((tech.sma_200 - tech.price) / tech.sma_200) * 10),
        description: `Price below 200 SMA — long-term downtrend`,
      });
    }
  }

  // Unusual volume
  if (tech.relative_volume !== null && tech.relative_volume > 2) {
    signals.push({
      type: 'high_volume', direction: 'neutral',
      strength: Math.min(1, (tech.relative_volume - 1) / 4),
      description: `Volume ${tech.relative_volume.toFixed(1)}x average — unusual activity`,
    });
  }

  return signals;
}

// ── High-level analysis (fetches data + computes) ───────────────────

/**
 * Run full technical analysis for a ticker.
 * Fetches 200 days of bars from Alpaca (or Yahoo fallback), then computes all indicators.
 *
 * @param {string} ticker
 * @returns {{ technicals: object, signals: Array, bars: Array }}
 */
async function analyze(ticker) {
  const upper = ticker.toUpperCase();
  let bars;

  // Try Alpaca first (better data quality)
  if (alpaca.enabled) {
    try {
      const raw = await alpaca.getHistory(upper, 250);
      bars = raw.map(b => ({
        t: b.date,
        o: b.open,
        h: b.high,
        l: b.low,
        c: b.close,
        v: b.volume,
      }));
    } catch (err) {
      console.warn(`[Technicals] Alpaca bars failed for ${upper}: ${err.message}`);
    }
  }

  // Fallback: Yahoo Finance via existing service
  if (!bars || bars.length < 30) {
    try {
      const yahoo = require('./yahoo');
      const snapshot = await yahoo.getTickerSnapshot(upper);
      if (snapshot?.history?.length > 0) {
        bars = snapshot.history.map(b => ({
          t: b.date,
          o: b.open,
          h: b.high,
          l: b.low,
          c: b.close,
          v: b.volume,
        }));
      }
    } catch (err) {
      console.warn(`[Technicals] Yahoo bars failed for ${upper}: ${err.message}`);
    }
  }

  if (!bars || bars.length < 30) {
    throw new Error(`Not enough price history for ${upper} (need 30+ bars, got ${bars?.length || 0})`);
  }

  const technicals = computeTechnicals(upper, bars);
  const signals = detectSignals(technicals);

  return { technicals, signals, bars };
}

// ── Discord formatting ──────────────────────────────────────────────

/**
 * Format technical analysis for Discord.
 * @param {object} result - from analyze()
 * @returns {string}
 */
function formatForDiscord(result) {
  const { technicals: t, signals } = result;
  const fmt = (v) => v !== null && v !== undefined ? v.toFixed(2) : '—';

  const lines = [
    `**${t.symbol} — Technical Analysis**`,
    `Price: \`$${fmt(t.price)}\` | Time: \`${new Date(t.timestamp).toLocaleDateString()}\``,
    ``,
    `**Moving Averages**`,
    `SMA 20: \`$${fmt(t.sma_20)}\` | SMA 50: \`$${fmt(t.sma_50)}\` | SMA 200: \`$${fmt(t.sma_200)}\``,
    `EMA 12: \`$${fmt(t.ema_12)}\` | EMA 26: \`$${fmt(t.ema_26)}\``,
    ``,
    `**Momentum**`,
    `RSI(14): \`${fmt(t.rsi_14)}\`${t.rsi_14 !== null ? (t.rsi_14 < 30 ? ' (oversold)' : t.rsi_14 > 70 ? ' (overbought)' : '') : ''}`,
  ];

  if (t.macd) {
    lines.push(`MACD: \`${fmt(t.macd.macd)}\` | Signal: \`${fmt(t.macd.signal)}\` | Hist: \`${fmt(t.macd.histogram)}\``);
  } else {
    lines.push(`MACD: \`—\``);
  }

  lines.push(``);
  lines.push(`**Volatility**`);
  if (t.bollinger) {
    lines.push(`Bollinger: \`$${fmt(t.bollinger.lower)}\` — \`$${fmt(t.bollinger.middle)}\` — \`$${fmt(t.bollinger.upper)}\` (width: ${(t.bollinger.width * 100).toFixed(1)}%)`);
  }
  lines.push(`ATR(14): \`$${fmt(t.atr_14)}\``);

  if (t.relative_volume !== null) {
    lines.push(`Relative Volume: \`${t.relative_volume.toFixed(1)}x\` avg`);
  }

  // Signals
  if (signals.length > 0) {
    lines.push(``);
    lines.push(`**Signals Detected**`);
    for (const sig of signals) {
      const emoji = sig.direction === 'bullish' ? '🟢' : sig.direction === 'bearish' ? '🔴' : '🟡';
      const bar = '█'.repeat(Math.round(sig.strength * 5)) + '░'.repeat(5 - Math.round(sig.strength * 5));
      lines.push(`${emoji} ${sig.description} [${bar}]`);
    }
  } else {
    lines.push(``);
    lines.push(`_No strong signals detected — consolidation zone._`);
  }

  // Net bias
  const bullish = signals.filter(s => s.direction === 'bullish').reduce((a, s) => a + s.strength, 0);
  const bearish = signals.filter(s => s.direction === 'bearish').reduce((a, s) => a + s.strength, 0);
  const net = bullish - bearish;
  const biasEmoji = net > 0.5 ? '🟢' : net < -0.5 ? '🔴' : '🟡';
  const biasLabel = net > 0.5 ? 'Bullish' : net < -0.5 ? 'Bearish' : 'Neutral';
  lines.push(``);
  lines.push(`${biasEmoji} **Net Bias: ${biasLabel}** (bull: ${bullish.toFixed(1)} / bear: ${bearish.toFixed(1)})`);

  return lines.join('\n');
}

module.exports = {
  calculateSMA,
  calculateEMA,
  calculateRSI,
  calculateMACD,
  calculateBollingerBands,
  calculateATR,
  computeTechnicals,
  detectSignals,
  analyze,
  formatForDiscord,
};
