/**
 * Multi-Timeframe EMA Confluence Filter
 *
 * Fetches bars across multiple timeframes (2m, 5m, 15m, 30m, 1h, 4h, daily)
 * and computes 9 EMA and 20 EMA on each. Determines:
 *   - Per-timeframe bias: price above both EMAs = bullish, below = bearish, between = neutral
 *   - Overall confluence score: how many timeframes agree on direction
 *   - EMA alignment: 9 EMA above 20 EMA = uptrend, below = downtrend
 *
 * Used by the options engine to filter out noise and only post/trade
 * high-conviction plays where multiple timeframes align.
 *
 * Alpaca timeframe format: '2Min', '5Min', '15Min', '30Min', '1Hour', '4Hour', '1Day'
 */

const alpaca = require('./alpaca');
const { calculateEMA } = require('./technicals');

// Timeframes to analyze (label → Alpaca timeframe string)
const TIMEFRAMES = [
  { label: '2m',  alpaca: '2Min',   barsNeeded: 30 },
  { label: '5m',  alpaca: '5Min',   barsNeeded: 30 },
  { label: '15m', alpaca: '15Min',  barsNeeded: 30 },
  { label: '30m', alpaca: '30Min',  barsNeeded: 30 },
  { label: '1h',  alpaca: '1Hour',  barsNeeded: 30 },
  { label: '4h',  alpaca: '4Hour',  barsNeeded: 30 },
  { label: '1D',  alpaca: '1Day',   barsNeeded: 30 },
];

const EMA_FAST = 9;
const EMA_SLOW = 20;

/**
 * Analyze multi-timeframe EMA confluence for a ticker.
 *
 * @param {string} ticker - Stock symbol (e.g. SPY, QQQ, AAPL)
 * @returns {Promise<MTFResult>}
 *
 * @typedef {object} MTFResult
 * @property {string} ticker
 * @property {Array<TFBias>} timeframes - Per-timeframe bias
 * @property {number} bullishCount - # of timeframes bullish
 * @property {number} bearishCount - # of timeframes bearish
 * @property {number} neutralCount - # of timeframes neutral
 * @property {string} consensus - 'strong_bullish' | 'bullish' | 'neutral' | 'bearish' | 'strong_bearish'
 * @property {number} confluenceScore - -1.0 to +1.0 (negative = bearish, positive = bullish)
 * @property {number} convictionBoost - -2 to +2 conviction adjustment for options engine
 */
async function analyzeMTFEMA(ticker) {
  const upper = ticker.toUpperCase();
  const results = [];

  // Fetch all timeframes in parallel for speed
  const fetchPromises = TIMEFRAMES.map(async (tf) => {
    try {
      const bars = await alpaca.getIntradayBars(upper, {
        timeframe: tf.alpaca,
        limit: tf.barsNeeded,
      });

      if (!bars || bars.length < EMA_SLOW + 2) {
        return { label: tf.label, bias: 'no_data', ema9: null, ema20: null, price: null, emaAlignment: null };
      }

      const closes = bars.map(b => b.close);
      const price = closes[closes.length - 1];

      // Calculate EMAs
      const ema9 = calculateEMA(closes, EMA_FAST);
      const ema20 = calculateEMA(closes, EMA_SLOW);

      if (ema9 === null || ema20 === null) {
        return { label: tf.label, bias: 'no_data', ema9: null, ema20: null, price, emaAlignment: null };
      }

      // Determine bias
      const aboveBothEMA = price > ema9 && price > ema20;
      const belowBothEMA = price < ema9 && price < ema20;
      const emaAlignment = ema9 > ema20 ? 'bullish' : ema9 < ema20 ? 'bearish' : 'flat';

      let bias;
      if (aboveBothEMA && emaAlignment === 'bullish') {
        bias = 'bullish';
      } else if (belowBothEMA && emaAlignment === 'bearish') {
        bias = 'bearish';
      } else if (aboveBothEMA) {
        bias = 'lean_bullish';
      } else if (belowBothEMA) {
        bias = 'lean_bearish';
      } else {
        bias = 'neutral';
      }

      return { label: tf.label, bias, ema9, ema20, price, emaAlignment };
    } catch (err) {
      return { label: tf.label, bias: 'error', ema9: null, ema20: null, price: null, emaAlignment: null, error: err.message };
    }
  });

  const settled = await Promise.all(fetchPromises);
  for (const r of settled) {
    results.push(r);
  }

  // Score the confluence
  let bullish = 0;
  let bearish = 0;
  let neutral = 0;
  let total = 0;

  for (const r of results) {
    if (r.bias === 'no_data' || r.bias === 'error') continue;
    total++;
    if (r.bias === 'bullish') bullish += 1;
    else if (r.bias === 'lean_bullish') bullish += 0.5;
    else if (r.bias === 'bearish') bearish += 1;
    else if (r.bias === 'lean_bearish') bearish += 0.5;
    else neutral++;
  }

  // Confluence score: -1.0 (all bearish) to +1.0 (all bullish)
  const confluenceScore = total > 0 ? (bullish - bearish) / total : 0;

  // Consensus label
  let consensus;
  if (confluenceScore >= 0.7) consensus = 'strong_bullish';
  else if (confluenceScore >= 0.3) consensus = 'bullish';
  else if (confluenceScore <= -0.7) consensus = 'strong_bearish';
  else if (confluenceScore <= -0.3) consensus = 'bearish';
  else consensus = 'neutral';

  // Conviction boost: strong agreement = boost, mixed = penalty
  let convictionBoost = 0;
  if (Math.abs(confluenceScore) >= 0.7) convictionBoost = 2;
  else if (Math.abs(confluenceScore) >= 0.5) convictionBoost = 1;
  else if (Math.abs(confluenceScore) < 0.2 && total >= 4) convictionBoost = -1; // Conflicting signals = reduce conviction

  return {
    ticker: upper,
    timeframes: results,
    bullishCount: bullish,
    bearishCount: bearish,
    neutralCount: neutral,
    total,
    consensus,
    confluenceScore: Math.round(confluenceScore * 100) / 100,
    convictionBoost,
  };
}

/**
 * Format MTF EMA analysis for Discord display.
 * @param {MTFResult} result
 * @returns {string}
 */
function formatMTFForDiscord(result) {
  const { ticker, timeframes, consensus, confluenceScore, bullishCount, bearishCount, neutralCount } = result;

  const emoji = confluenceScore > 0.3 ? '***' : confluenceScore < -0.3 ? '***' : '***';

  const lines = [
    `${emoji} **${ticker} — Multi-Timeframe EMA Confluence**`,
    `Consensus: **${consensus.replace('_', ' ').toUpperCase()}** | Score: \`${confluenceScore > 0 ? '+' : ''}${confluenceScore.toFixed(2)}\``,
    `Bull: \`${bullishCount}\` | Bear: \`${bearishCount}\` | Neutral: \`${neutralCount}\``,
    '',
  ];

  for (const tf of timeframes) {
    if (tf.bias === 'no_data' || tf.bias === 'error') {
      lines.push(`\`${tf.label.padEnd(3)}\` — no data`);
      continue;
    }

    const biasIcon = tf.bias.includes('bullish') ? '+' : tf.bias.includes('bearish') ? '-' : '~';
    const emaInfo = tf.ema9 && tf.ema20
      ? `9EMA=$${tf.ema9.toFixed(2)} ${tf.emaAlignment === 'bullish' ? '>' : '<'} 20EMA=$${tf.ema20.toFixed(2)}`
      : '';
    const priceInfo = tf.price ? `price=$${tf.price.toFixed(2)}` : '';

    lines.push(`\`${tf.label.padEnd(3)}\` ${biasIcon} **${tf.bias.replace('_', ' ')}** | ${priceInfo} | ${emaInfo}`);
  }

  const dataCount = timeframes.filter(tf => tf.bias !== 'no_data' && tf.bias !== 'error').length;
  lines.push('', `_9/20 EMA across ${dataCount}/${timeframes.length} timeframes_`);

  return lines.join('\n');
}

/**
 * Build a brief summary string for use in AI prompts.
 * @param {MTFResult} result
 * @returns {string}
 */
function formatMTFForPrompt(result) {
  const tfSummary = result.timeframes
    .filter(tf => tf.bias !== 'no_data' && tf.bias !== 'error')
    .map(tf => `${tf.label}:${tf.bias}`)
    .join(', ');

  return `MTF EMA Confluence: ${result.consensus} (score: ${result.confluenceScore > 0 ? '+' : ''}${result.confluenceScore.toFixed(2)}) — ${tfSummary}`;
}

module.exports = { analyzeMTFEMA, formatMTFForDiscord, formatMTFForPrompt, TIMEFRAMES };
