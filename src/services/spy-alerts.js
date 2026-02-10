/**
 * SPY 0DTE Alert Handler — TradingView Webhook Integration.
 *
 * Listens for webhook messages in the configured SPY channel,
 * parses alerts (JSON or plain text), runs a fast AI analysis pipeline,
 * and replies with rich embeds in a thread.
 *
 * Flow:
 *   1. Instant ack embed (<1s) — "Alert Received! Processing..."
 *   2. Async: fetch SPY price + news (parallel, cached 60s)
 *   3. Fast Ollama analysis (lighter model, concise prompt)
 *   4. Edit ack with full enhanced embed
 *   5. Create thread, add reactions (thumbs up/down)
 *   6. Schedule 5-min follow-up in thread
 *   7. Generate QuickChart.io candlestick image
 */

let Ollama;
try {
  Ollama = require('ollama').Ollama;
} catch {
  // ollama package not available — module degrades gracefully
  Ollama = null;
}
const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const priceFetcher = require('../tools/price-fetcher');
const { webSearch, formatResultsForAI } = require('../tools/web-search');
const mood = require('./mood');
const { buildFast0DTEPrompt } = require('../trading/fast-0dte-prompt');
const { ragEnforcementBlock, todayString } = require('../date-awareness');
const log = require('../logger')('SPYAlerts');

// AInvest — fundamentals, analyst ratings, earnings (optional)
let ainvest;
try {
  ainvest = require('./ainvest');
} catch {
  ainvest = null;
}

// ── In-memory cache (SPY price + news) ──────────────────────────────────
const alertCache = new Map();

function getCached(key) {
  const entry = alertCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > config.alertCacheTtl) {
    alertCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  alertCache.set(key, { data, ts: Date.now() });
  // Prune old entries
  if (alertCache.size > 50) {
    const now = Date.now();
    for (const [k, v] of alertCache) {
      if (now - v.ts > config.alertCacheTtl) alertCache.delete(k);
    }
  }
}

// ── Alert Rate Limiter ──────────────────────────────────────────────────
const alertTimestamps = [];
const MAX_ALERTS_PER_MINUTE = 5;

function isAlertRateLimited() {
  const now = Date.now();
  while (alertTimestamps.length > 0 && alertTimestamps[0] < now - 60000) {
    alertTimestamps.shift();
  }
  return alertTimestamps.length >= MAX_ALERTS_PER_MINUTE;
}

function recordAlert() {
  alertTimestamps.push(Date.now());
}

// ── Ollama client for alerts (lighter model) ────────────────────────────
let alertOllama;
function getAlertOllama() {
  if (!Ollama) return null;
  if (!alertOllama) {
    const opts = { host: config.ollamaHost };
    if (config.ollamaApiKey) {
      opts.headers = { Authorization: `Bearer ${config.ollamaApiKey}` };
    }
    alertOllama = new Ollama(opts);
  }
  return alertOllama;
}

// ── Pre-warm Ollama on startup ──────────────────────────────────────────
async function prewarmOllama() {
  const ollama = getAlertOllama();
  if (!ollama) {
    log.warn('Ollama pre-warm skipped (ollama package not available)');
    return;
  }
  try {
    log.info(`Pre-warming Ollama model: ${config.alertOllamaModel}`);
    await ollama.chat({
      model: config.alertOllamaModel,
      messages: [{ role: 'user', content: 'Hello. Respond with OK.' }],
      stream: false,
    });
    log.info('Ollama pre-warm complete');
  } catch (err) {
    log.warn(`Ollama pre-warm failed (non-critical): ${err.message}`);
  }
}

// ── Parse Alert ─────────────────────────────────────────────────────────

/**
 * Parse a TradingView webhook alert. Extremely flexible — handles:
 *
 *   1. Structured JSON with standard keys (action, ticker, price, etc.)
 *   2. Text-wrapper JSON like {"content": "SPY PUMP INCOMING on 1m low confidence"}
 *   3. Plain text ("Buy SPY 0DTE Call @ $590.50")
 *
 * The user's TradingView alerts send:
 *   {"content": "SPY PUMP INCOMING on 1m low confidence"}
 *   {"content": "High Conviction - SPY Sell"}
 *   {"content": "Tanking 5m"}
 *
 * Signal keywords detected:
 *   BUY:  buy, long, pump, bullish
 *   SELL: sell, short, tank, tanking, bearish
 *   TP:   TP, take profit
 *
 * @param {string|object} content — Raw message content or parsed JSON object
 * @returns {{ action, ticker, type, price, interval, confidence, reason, raw, extra, ... }}
 */
function parseAlert(content) {
  let json = null;
  let rawStr = '';

  // If already an object (from Express JSON body), use directly
  if (typeof content === 'object' && content !== null) {
    json = content;
    rawStr = JSON.stringify(content);
  } else {
    rawStr = String(content).trim();
    try {
      json = JSON.parse(rawStr);
    } catch {
      // Not JSON — will use text parsing below
    }
  }

  if (json) {
    // Normalize keys (TradingView uses various naming conventions)
    const flat = _flattenObject(json);

    // Check if JSON has standard structured trading fields
    // Also handles SMRT Algo JSON keys (signal_condition, take_profit, stop_loss, etc.)
    const action = _firstOf(flat,
      'action', 'signal', 'signal_condition', 'direction', 'order_action', 'side',
      'strategy.order.action', 'strategy.order_action'
    );
    const ticker = _firstOf(flat,
      'ticker', 'symbol', 'stock', 'underlying'
    );

    // If JSON has structured trading keys → use the structured path
    if (action || ticker) {
      const type = _firstOf(flat,
        'type', 'instrument', 'contract', 'order_type',
        'strategy.order.type'
      );
      const price = _firstNum(flat,
        'price', 'close', 'last', 'entry', 'entry_price',
        'strategy.order.price', 'order_price'
      );
      const reason = _firstOf(flat,
        'reason', 'message', 'note', 'comment', 'description', 'alert_message', 'content'
      );
      const confidence = _firstOf(flat, 'confidence', 'conviction', 'strength') || null;

      // Extract SMRT Algo specific fields
      const stopLoss = _firstNum(flat, 'stop_loss', 'stoploss', 'sl', 'stop') ?? null;
      const takeProfit = _firstNum(flat, 'take_profit', 'takeprofit', 'tp', 'tp1', 'target') ?? null;

      // Map signal words to standard actions (PUMP→BUY, TANK→SELL, etc.)
      let normalizedAction = action ? action.toUpperCase() : 'ALERT';
      if (/pump|bullish/i.test(normalizedAction)) normalizedAction = 'BUY';
      else if (/tank|bearish/i.test(normalizedAction)) normalizedAction = 'SELL';
      else if (/take.?profit|tp/i.test(normalizedAction)) normalizedAction = 'TAKE_PROFIT';

      return {
        action: normalizedAction,
        ticker: ticker ? ticker.toUpperCase() : 'SPY',
        type: type || 'SPY 0DTE',
        price,
        close: _firstNum(flat, 'close') ?? null,
        open: _firstNum(flat, 'open') ?? null,
        high: _firstNum(flat, 'high') ?? null,
        low: _firstNum(flat, 'low') ?? null,
        volume: _firstNum(flat, 'volume') ?? null,
        interval: _normalizeInterval(_firstOf(flat, 'interval', 'timeframe', 'resolution')),
        confidence: confidence ? confidence.toUpperCase() : null,
        stopLoss,
        takeProfit,
        time: _firstOf(flat, 'time', 'timestamp', 'timenow') || null,
        reason: _stripBranding(reason || action || ''),
        raw: rawStr,
        extra: json, // keep full original for the AI prompt
      };
    }

    // Text-wrapper JSON: {"content": "SPY PUMP INCOMING on 1m low confidence", "price": 590.50}
    const textContent = _firstOf(flat,
      'content', 'text', 'message', 'alert_message', 'msg',
      'alert', 'description', 'body', 'note'
    );
    if (textContent) {
      const result = _parseAlertText(textContent, rawStr, json);
      // Merge any structured fields from the JSON (e.g. price, time from TradingView vars)
      const jsonPrice = _firstNum(flat, 'price', 'close', 'last', 'entry');
      if (jsonPrice && !result.price) result.price = jsonPrice;
      const jsonTime = _firstOf(flat, 'time', 'timestamp', 'timenow');
      if (jsonTime && !result.time) result.time = jsonTime;
      const jsonTicker = _firstOf(flat, 'ticker', 'symbol');
      if (jsonTicker) result.ticker = jsonTicker.toUpperCase();
      const jsonInterval = _firstOf(flat, 'interval', 'timeframe', 'resolution');
      if (jsonInterval && !result.interval) result.interval = jsonInterval;
      return result;
    }

    // Unknown JSON structure — stringify the whole thing and text-parse
    return _parseAlertText(rawStr, rawStr, json);
  }

  // Plain text fallback
  return _parseAlertText(rawStr, rawStr, null);
}

/**
 * Parse a text-based alert for trading signals, timeframe, and confidence.
 *
 * Handles the user's 17 TradingView alert types:
 *   PUMP INCOMING, 5m PUMP, 15M PUMP       → BUY
 *   TANKING, Tanking 5m, SPY TANK 15M      → SELL
 *   Buy, SPY Buy, 15 m buy                 → BUY
 *   Sell, Spy Sell, 15 m sell               → SELL
 *   Trend bullish, Bearish Trend            → BUY / SELL
 *   High Conviction - SPY Sell/BUY          → SELL / BUY (HIGH confidence)
 *   TP                                      → TAKE_PROFIT
 *
 * @param {string} text — The alert text to parse
 * @param {string} rawStr — Full raw string for the raw field
 * @param {object|null} originalJson — Original JSON if it was a wrapper
 */
function _parseAlertText(text, rawStr, originalJson) {
  // ── Direction / Action ──
  // Order matters: check specific compound patterns first, then single keywords
  const ACTION_PATTERNS = [
    [/\btake\s*profit\b/i, 'TAKE_PROFIT'],
    [/\bTP\b/, 'TAKE_PROFIT'],
    [/\bbuy\b/i, 'BUY'],
    [/\blong\b/i, 'BUY'],
    [/\bpump\b/i, 'BUY'],
    [/\bbullish\b/i, 'BUY'],
    [/\bsell\b/i, 'SELL'],
    [/\bshort\b/i, 'SELL'],
    [/\btank(?:ing)?\b/i, 'SELL'],
    [/\bbearish\b/i, 'SELL'],
  ];

  let action = 'ALERT';
  for (const [pattern, act] of ACTION_PATTERNS) {
    if (pattern.test(text)) {
      action = act;
      break;
    }
  }

  // ── Ticker ──
  // Use known tickers to avoid matching signal words like "PUMP", "TANK"
  const KNOWN_TICKERS = /\b(SPY|QQQ|IWM|DIA|AAPL|TSLA|NVDA|AMD|AMZN|GOOG|GOOGL|META|MSFT|NFLX|TQQQ|SQQQ|SPXL|SPXS|VIX|UVXY)\b/i;
  const tickerMatch = text.match(KNOWN_TICKERS);
  const ticker = tickerMatch ? tickerMatch[1].toUpperCase() : 'SPY';

  // ── Price ──
  // Only match $ prefixed or @ prefixed prices to avoid false positives (e.g. "1m" → $1)
  let price = null;
  const dollarMatch = text.match(/\$\s*([\d,]+\.?\d+)/);
  const atMatch = text.match(/@\s*\$?([\d,]+\.?\d+)/);
  if (dollarMatch) price = parseFloat(dollarMatch[1].replace(',', ''));
  else if (atMatch) price = parseFloat(atMatch[1].replace(',', ''));

  // ── Timeframe ──
  // Match: "1m", "5m", "15m", "15M", "15 m", "5 min", etc.
  const tfMatch = text.match(/\b(\d+)\s*m(?:in(?:ute)?s?)?\b/i);
  const interval = tfMatch ? `${tfMatch[1]}m` : null;

  // ── Confidence ──
  let confidence = null;
  if (/high\s*conviction/i.test(text)) confidence = 'HIGH';
  else if (/high\s*confidence/i.test(text)) confidence = 'HIGH';
  else if (/low\s*confidence/i.test(text)) confidence = 'LOW';
  else if (/medium\s*confidence/i.test(text)) confidence = 'MEDIUM';

  // ── Type ──
  const typeMatch = text.match(/((?:SPY|QQQ|IWM)\s*0DTE\s*(?:Call|Put|Straddle|Strangle)?)/i);
  const type = typeMatch ? typeMatch[1].trim() : `${ticker} 0DTE`;

  return {
    action,
    ticker,
    type,
    price,
    close: null, open: null, high: null, low: null, volume: null,
    interval,
    confidence,
    time: null,
    reason: _stripBranding(text), // full text, branding stripped
    raw: rawStr,
    extra: originalJson,
  };
}

/** Flatten nested object keys: { strategy: { order: { action: "buy" } } } → { "strategy.order.action": "buy", "action": "buy" } */
function _flattenObject(obj, prefix = '', result = {}) {
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      _flattenObject(val, fullKey, result);
    } else {
      result[fullKey] = val;
      // Also store the leaf key for easy lookup
      if (!result[key]) result[key] = val;
    }
  }
  return result;
}

/** Strip indicator/algo branding from display text. */
const BRANDING_PATTERNS = [
  /Pro\s*V\d+\s*\[SMRT\s*Algo\]:?\s*/gi,
  /\[SMRT\s*Algo\]:?\s*/gi,
  /SMRT\s*Algo:?\s*/gi,
  /Any\s*alert\(\)\s*function\s*call\s*/gi,
];
function _stripBranding(text) {
  if (!text) return text;
  let s = String(text);
  for (const pattern of BRANDING_PATTERNS) {
    s = s.replace(pattern, '');
  }
  return s.trim();
}

/** Normalize interval: TradingView {{interval}} returns "1", "5", "15" — append "m" if bare number. */
function _normalizeInterval(val) {
  if (!val) return null;
  const s = String(val).trim();
  return /^\d+$/.test(s) ? `${s}m` : s;
}

/** Return the first non-empty string value found for any of the given keys. */
function _firstOf(flat, ...keys) {
  for (const k of keys) {
    const v = flat[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

/** Return the first parseable number found for any of the given keys. */
function _firstNum(flat, ...keys) {
  for (const k of keys) {
    const v = flat[k];
    if (v != null) {
      const n = parseFloat(v);
      if (!isNaN(n)) return n;
    }
  }
  return null;
}

// ── Fetch SPY data (cached) ─────────────────────────────────────────────

async function fetchSPYPrice() {
  const cached = getCached('spy_price');
  if (cached) return cached;

  if (!priceFetcher.isAvailable()) return 'SPY price data unavailable (no price sources loaded)';

  try {
    const data = await priceFetcher.getCurrentPrice('SPY');
    if (data.error) return `SPY price unavailable: ${data.message}`;
    const formatted = priceFetcher.formatForPrompt([data]);
    setCache('spy_price', formatted);
    return formatted;
  } catch (err) {
    return `SPY price fetch failed: ${err.message}`;
  }
}

async function fetchFundamentals(ticker = 'SPY') {
  const cached = getCached(`fundamentals_${ticker}`);
  if (cached) return cached;

  if (!ainvest || !ainvest.enabled) return '';

  try {
    const ctx = await ainvest.getFundamentalContext(ticker);
    if (ctx) setCache(`fundamentals_${ticker}`, ctx);
    return ctx || '';
  } catch (err) {
    log.warn(`Fundamentals fetch failed for ${ticker}: ${err.message}`);
    return '';
  }
}

async function fetchSPYNews() {
  const cached = getCached('spy_news');
  if (cached) return cached;

  // No gatekeeper — webSearch() has its own fallbacks (SearXNG + DuckDuckGo)
  try {
    const result = await webSearch('SPY S&P 500 market news today', 3);
    if (result.error) return `News unavailable: ${result.error}`;
    const formatted = formatResultsForAI(result);
    setCache('spy_news', formatted);
    return formatted;
  } catch (err) {
    return `News fetch failed: ${err.message}`;
  }
}

// ── Quick Ollama analysis ───────────────────────────────────────────────

async function runFastAnalysis(alert, priceData, newsData) {
  const currentMood = mood.getMood();
  const prompt = buildFast0DTEPrompt({
    alert,
    priceData,
    newsData,
    mood: currentMood,
  });

  const ollama = getAlertOllama();
  if (!ollama) {
    throw new Error('Ollama not available — cannot run analysis');
  }
  const systemMsg = `${ragEnforcementBlock()}\n\nYou are analyzing a LIVE 0DTE options alert as of ${todayString()}. Respond with ONLY valid JSON.`;

  try {
    const stream = await ollama.chat({
      model: config.alertOllamaModel,
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: prompt },
      ],
      stream: true,
    });

    let result = '';
    for await (const part of stream) {
      result += part.message.content;
    }

    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    // If no JSON found, return a default
    log.warn('Fast analysis returned non-JSON, using defaults');
    return {
      action: alert.action,
      conviction: 5,
      bullScore: 5,
      bearScore: 5,
      riskLevel: 'MEDIUM',
      stopLoss: 'N/A',
      target: 'N/A',
      timeframe: 'EOD',
      mood: 'Neutral',
      summary: result.slice(0, 300),
    };
  } catch (err) {
    log.error(`Fast analysis failed: ${err.message}`);
    throw err;
  }
}

// ── Build Enhanced Embed ────────────────────────────────────────────────

const MOOD_EMOJIS = {
  Euphoric: '🚀',
  'Optimistically Bullish': '📈',
  Content: '😎',
  Neutral: '😐',
  Cautious: '⚠️',
  'Measuredly Concerned': '😟',
  Distressed: '😰',
};

const CONVICTION_EMOJIS = {
  high: '🔥',
  medium: '⚡',
  low: '💤',
};

/**
 * Build the "processing" ack embed.
 */
function buildAckEmbed(alert) {
  const parts = [`**${alert.action}** ${alert.ticker}`];
  if (alert.price) parts.push(`@ $${alert.price}`);
  if (alert.interval) parts.push(`(${alert.interval})`);
  if (alert.confidence) parts.push(`[${alert.confidence}]`);
  if (alert.reason && alert.reason !== alert.action) {
    parts.push(`\n> _${alert.reason.slice(0, 120)}_`);
  }

  return new EmbedBuilder()
    .setTitle('⏳ Alert Received! Processing...')
    .setDescription(parts.join(' '))
    .setColor(0xFFAA00)
    .setFooter({ text: 'Sprocket 0DTE Pipeline • Analyzing...' })
    .setTimestamp();
}

/**
 * Build the full enhanced embed with analysis results.
 */
function buildEnhancedEmbed(alert, analysis, priceData) {
  const actionEmoji = { BUY: '🟢', SELL: '🔴', SKIP: '🟡' };
  const riskColor = { LOW: 0x00FF00, MEDIUM: 0xFFAA00, HIGH: 0xFF6600, EXTREME: 0xFF0000 };

  const conviction = analysis.conviction || 5;
  const convictionBar = '█'.repeat(conviction) + '░'.repeat(10 - conviction);
  const convictionLevel = conviction >= 7 ? 'high' : conviction >= 4 ? 'medium' : 'low';
  const convEmoji = CONVICTION_EMOJIS[convictionLevel] || '';

  const botMood = mood.getMood();
  const moodEmoji = MOOD_EMOJIS[botMood] || '😐';

  // High conviction flair
  let titleFlair = '';
  if (conviction >= 8 && botMood === 'Euphoric') {
    titleFlair = ' 🚀🚀🚀';
  } else if (conviction >= 8) {
    titleFlair = ' 🔥';
  } else if (conviction >= 6 && (botMood === 'Euphoric' || botMood === 'Optimistically Bullish')) {
    titleFlair = ' 🚀';
  }

  const titleParts = [`${actionEmoji[analysis.action] || '⚪'} Enhanced 0DTE Alert: ${alert.action} ${alert.ticker}`];
  if (alert.price) titleParts.push(`@ $${alert.price}`);
  if (alert.interval) titleParts.push(`(${alert.interval})`);
  titleParts.push(titleFlair);

  const embed = new EmbedBuilder()
    .setTitle(titleParts.join(' ').trim())
    .setColor(riskColor[analysis.riskLevel] || 0x5865F2)
    .setTimestamp();

  // Summary
  if (analysis.summary) {
    embed.setDescription(`> ${analysis.summary}`);
  }

  // Scores
  embed.addFields(
    {
      name: `${convEmoji} Conviction`,
      value: `**${conviction}/10** [${convictionBar}]`,
      inline: true,
    },
    {
      name: '🐂 Bull Score',
      value: `**${analysis.bullScore || 'N/A'}/10**`,
      inline: true,
    },
    {
      name: '🐻 Bear Score',
      value: `**${analysis.bearScore || 'N/A'}/10**`,
      inline: true,
    },
  );

  // Trade details
  embed.addFields(
    {
      name: '⚠️ Risk Level',
      value: `**${analysis.riskLevel || 'MEDIUM'}**`,
      inline: true,
    },
    {
      name: '🛑 Stop Loss',
      value: `**${alert.stopLoss ? '$' + alert.stopLoss : (analysis.stopLoss || 'N/A')}**`,
      inline: true,
    },
    {
      name: '🎯 Target',
      value: `**${alert.takeProfit ? '$' + alert.takeProfit : (analysis.target || 'N/A')}**`,
      inline: true,
    },
  );

  // Timeframe, confidence, and mood
  embed.addFields(
    {
      name: '⏰ Timeframe',
      value: `**${analysis.timeframe || alert.interval || 'EOD'}**`,
      inline: true,
    },
    {
      name: `${moodEmoji} Sprocket Mood`,
      value: `**${botMood}** (${analysis.mood || 'Neutral'})`,
      inline: true,
    },
    {
      name: '📊 Action',
      value: `**${analysis.action || alert.action}**`,
      inline: true,
    },
  );

  // Confidence (from TradingView signal text)
  if (alert.confidence) {
    const confEmoji = alert.confidence === 'HIGH' ? '🔥' : alert.confidence === 'LOW' ? '💤' : '⚡';
    embed.addFields({
      name: `${confEmoji} Signal Confidence`,
      value: `**${alert.confidence}**`,
      inline: true,
    });
  }

  // Alert signal text (from TradingView content)
  if (alert.reason) {
    embed.addFields({
      name: '📝 Signal',
      value: alert.reason.slice(0, 200),
      inline: false,
    });
  }

  embed.setFooter({
    text: `Sprocket 0DTE Pipeline • Model: ${config.alertOllamaModel} • ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET`,
  });

  return embed;
}

/**
 * Build an error embed when processing fails.
 */
function buildErrorEmbed(alert, errorMsg) {
  return new EmbedBuilder()
    .setTitle('❌ Alert Processing Failed')
    .setDescription(`Could not analyze: **${alert.action} ${alert.type}**\n\nError: ${errorMsg}`)
    .setColor(0xFF0000)
    .setFooter({ text: 'Sprocket 0DTE Pipeline' })
    .setTimestamp();
}

// ── QuickChart.io Candlestick Chart ─────────────────────────────────────

/**
 * Generate a QuickChart.io chart URL using AInvest candle data.
 * Falls back to price-fetcher sources if AInvest fails.
 *
 * @param {string} [ticker='SPY'] — Ticker to chart
 * @returns {string|null} — Chart image URL or null
 */
async function generateChartUrl(ticker = 'SPY') {
  try {
    let candles = [];

    // Try AInvest candles first (15-min bars, last ~20 candles)
    try {
      const ainvest = require('./ainvest');
      if (ainvest.enabled) {
        candles = await ainvest.getCandles(ticker, { interval: 'min', step: 15, count: 20 });
      }
    } catch (err) {
      log.warn(`Chart: AInvest candles failed: ${err.message}`);
    }

    // Fallback: Alpaca daily bars (last 5 days)
    if (candles.length < 5) {
      try {
        const alpaca = require('./alpaca');
        if (alpaca.enabled) {
          const bars = await alpaca.getHistory(ticker, 5);
          if (bars && bars.length > 0) {
            candles = bars.map(b => ({
              open: b.open,
              high: b.high,
              low: b.low,
              close: b.close,
              volume: b.volume,
              timestamp: b.date ? new Date(b.date).getTime() : Date.now(),
            }));
          }
        }
      } catch (err) {
        log.warn(`Chart: Alpaca bars failed: ${err.message}`);
      }
    }

    if (candles.length < 5) return null;

    // Take last 20 candles
    const recent = candles.slice(-20);
    const labels = recent.map(c => {
      const d = new Date(c.timestamp);
      return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    });
    const closes = recent.map(c => c.close);

    // Simple line chart (reliable with QuickChart)
    const simpleChart = {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: ticker,
          data: closes,
          borderColor: closes[closes.length - 1] >= closes[0] ? '#00c853' : '#ff4444',
          backgroundColor: closes[closes.length - 1] >= closes[0] ? 'rgba(0,200,83,0.1)' : 'rgba(255,68,68,0.1)',
          fill: true,
          tension: 0.1,
          pointRadius: 2,
        }],
      },
      options: {
        plugins: {
          title: { display: true, text: `${ticker} Intraday — ${todayString()}`, color: '#fff', font: { size: 14 } },
          legend: { display: false },
        },
        scales: {
          y: {
            ticks: { color: '#ccc', callback: (v) => '$' + v.toFixed(0) },
            grid: { color: 'rgba(255,255,255,0.1)' },
          },
          x: {
            ticks: { color: '#ccc', maxRotation: 45, maxTicksLimit: 8 },
            grid: { color: 'rgba(255,255,255,0.1)' },
          },
        },
      },
    };

    const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(simpleChart))}&backgroundColor=rgb(47,49,54)&width=600&height=300`;

    // Verify URL isn't too long (QuickChart limit ~16k)
    if (chartUrl.length > 16000) {
      log.warn('Chart URL too long, skipping chart');
      return null;
    }

    return chartUrl;
  } catch (err) {
    log.warn(`Chart generation failed: ${err.message}`);
    return null;
  }
}

// ── Proactive Follow-Up ─────────────────────────────────────────────────

/**
 * Schedule a follow-up message in the alert thread after a delay.
 * Checks current price and compares to alert price.
 */
function scheduleFollowUp(thread, alert, analysis) {
  const delayMs = config.alertFollowUpMs;

  setTimeout(async () => {
    try {
      // Fetch fresh SPY price
      const freshPrice = await priceFetcher.getCurrentPrice('SPY');
      if (freshPrice.error) {
        await thread.send('⏰ **5-Min Update:** Could not fetch current SPY price for follow-up.');
        return;
      }

      const currentPrice = freshPrice.price;
      const alertPrice = alert.price || 0;
      const priceChange = alertPrice ? ((currentPrice - alertPrice) / alertPrice * 100).toFixed(2) : 'N/A';
      const direction = priceChange > 0 ? '📈' : priceChange < 0 ? '📉' : '➡️';

      const isAlertBuy = ['BUY', 'LONG'].includes(alert.action);
      const favorable = (isAlertBuy && priceChange > 0) || (!isAlertBuy && priceChange < 0);

      const convictionStatus = analysis.conviction >= 7
        ? `✅ High conviction alert — ${favorable ? 'trade moving in favor' : 'watch closely'}`
        : `⚠️ Moderate conviction — ${favorable ? 'holding direction' : 'consider exit'}`;

      const followUpEmbed = new EmbedBuilder()
        .setTitle(`⏰ 5-Min Follow-Up: ${alert.type}`)
        .setDescription(convictionStatus)
        .addFields(
          { name: 'Alert Price', value: `$${alertPrice || 'N/A'}`, inline: true },
          { name: 'Current Price', value: `$${currentPrice.toFixed(2)}`, inline: true },
          { name: `${direction} Change`, value: `${priceChange}%`, inline: true },
        )
        .setColor(favorable ? 0x00FF00 : 0xFF6600)
        .setFooter({ text: 'Sprocket 0DTE Follow-Up' })
        .setTimestamp();

      await thread.send({ embeds: [followUpEmbed] });
    } catch (err) {
      log.error(`Follow-up failed: ${err.message}`);
    }
  }, delayMs);
}

// ── Main Handler ────────────────────────────────────────────────────────

/**
 * Handle a TradingView webhook alert message.
 * Called from index.js messageCreate when a webhook message lands in the SPY channel.
 *
 * @param {import('discord.js').Message} message
 */
async function handleWebhookAlert(message) {
  // Rate limit check
  if (isAlertRateLimited()) {
    log.warn('Alert rate limited — skipping');
    return;
  }
  recordAlert();

  const alert = parseAlert(message.content);
  log.info(`Alert received: ${alert.action} ${alert.type} @ $${alert.price || 'N/A'}`);

  // ── Step 1: Instant ack (<1s) ──
  let ackMessage;
  try {
    ackMessage = await message.reply({ embeds: [buildAckEmbed(alert)] });
  } catch (err) {
    log.error(`Failed to send ack: ${err.message}`);
    return;
  }

  // ── Step 2: Async processing ──
  try {
    // Fetch price + news + fundamentals in parallel (all cached 60s)
    const [priceData, newsData, fundamentals] = await Promise.all([
      fetchSPYPrice(),
      fetchSPYNews(),
      fetchFundamentals(alert.ticker || 'SPY'),
    ]);

    // Enrich news with fundamentals from AInvest if available
    const enrichedNews = fundamentals
      ? `${newsData}\n\n=== FUNDAMENTALS (AInvest) ===\n${fundamentals}`
      : newsData;

    // Run fast Ollama analysis
    const analysis = await runFastAnalysis(alert, priceData, enrichedNews);

    // Generate chart URL (non-blocking, don't fail if chart fails)
    const chartUrl = await generateChartUrl().catch(() => null);

    // ── Step 3: Build enhanced embed and edit ack ──
    const embed = buildEnhancedEmbed(alert, analysis, priceData);

    // Add chart as image if available
    if (chartUrl) {
      embed.setImage(chartUrl);
    }

    await ackMessage.edit({ embeds: [embed] });

    // ── Step 4: Create thread for discussion ──
    let thread;
    try {
      thread = await ackMessage.startThread({
        name: `${alert.action} ${alert.type} — ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })} ET`,
        autoArchiveDuration: 60, // Archive after 1 hour of inactivity
      });
    } catch (err) {
      log.warn(`Could not create thread: ${err.message}`);
    }

    // ── Step 5: Add reactions for learning ──
    try {
      await ackMessage.react('👍');
      await ackMessage.react('👎');
    } catch (err) {
      log.warn(`Could not add reactions: ${err.message}`);
    }

    // ── Step 6: Schedule proactive follow-up ──
    if (thread && alert.price) {
      scheduleFollowUp(thread, alert, analysis);
    }

    log.info(`Alert processed: ${alert.action} ${alert.type} — conviction ${analysis.conviction}/10`);
  } catch (err) {
    log.error(`Alert processing error: ${err.message}`);

    // Edit ack to show error
    try {
      await ackMessage.edit({ embeds: [buildErrorEmbed(alert, err.message)] });
    } catch {
      // If edit fails too, nothing we can do
    }
  }
}

// ── HTTP Webhook Handler (TradingView → Express → AI → Discord) ─────────

/**
 * Handle an alert received via HTTP POST (from TradingView directly).
 * Runs AI analysis FIRST, then posts the finished embed to Discord.
 * Nothing appears in the channel until analysis is complete.
 *
 * @param {import('discord.js').TextChannel} channel — The Discord channel to post in
 * @param {object|string} body — Raw request body (JSON object or string)
 */
async function handleHttpAlert(channel, body) {
  // Rate limit check
  if (isAlertRateLimited()) {
    log.warn('Alert rate limited — skipping HTTP alert');
    return { ok: false, reason: 'rate_limited' };
  }
  recordAlert();

  const alert = parseAlert(body);
  log.info(`HTTP alert received: ${alert.action} ${alert.ticker} @ $${alert.price || 'N/A'} [${alert.interval || 'no tf'}] [${alert.confidence || 'no conf'}]`);
  log.info(`Signal text: ${alert.reason}`);

  // ── Step 1: Fetch data + AI analysis (before posting anything) ──
  let analysis, chartUrl, priceData;
  try {
    // Fetch all data in parallel (including fundamentals from AInvest)
    const [price, news, fundamentals, chart] = await Promise.all([
      fetchSPYPrice(),
      fetchSPYNews(),
      fetchFundamentals(alert.ticker || 'SPY'),
      generateChartUrl(alert.ticker || 'SPY').catch(() => null),
    ]);
    priceData = price;
    chartUrl = chart;

    // Append fundamentals to news context if available
    const enrichedNews = fundamentals
      ? `${news}\n\n=== FUNDAMENTALS (AInvest) ===\n${fundamentals}`
      : news;

    // Run AI analysis with all the data
    analysis = await runFastAnalysis(alert, priceData, enrichedNews);
  } catch (err) {
    log.error(`HTTP alert analysis failed: ${err.message}`);
    // Post error embed so the alert isn't silently lost
    try {
      await channel.send({ embeds: [buildErrorEmbed(alert, err.message)] });
    } catch { /* nothing */ }
    return { ok: false, reason: 'analysis_failed', error: err.message };
  }

  // ── Step 2: Build finished embed ──
  const embed = buildEnhancedEmbed(alert, analysis, priceData);
  if (chartUrl) embed.setImage(chartUrl);

  // ── Step 3: Post to Discord (one clean message, no ack→edit flicker) ──
  let postedMessage;
  try {
    postedMessage = await channel.send({ embeds: [embed] });
  } catch (err) {
    log.error(`Failed to post alert to channel: ${err.message}`);
    return { ok: false, reason: 'discord_send_failed' };
  }

  // ── Step 4: Thread + reactions (non-blocking) ──
  (async () => {
    try {
      // Thread
      let thread;
      try {
        thread = await postedMessage.startThread({
          name: `${alert.action} ${alert.ticker}${alert.interval ? ' ' + alert.interval : ''} — ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })} ET`,
          autoArchiveDuration: 60,
        });
      } catch (err) {
        log.warn(`Could not create thread: ${err.message}`);
      }

      // Reactions
      try {
        await postedMessage.react('👍');
        await postedMessage.react('👎');
      } catch (err) {
        log.warn(`Could not add reactions: ${err.message}`);
      }

      // Follow-up
      if (thread && alert.price) {
        scheduleFollowUp(thread, alert, analysis);
      }
    } catch (err) {
      log.warn(`Post-alert extras failed: ${err.message}`);
    }
  })();

  log.info(`HTTP alert posted: ${alert.action} ${alert.ticker} — conviction ${analysis.conviction}/10`);
  return { ok: true, alert: { action: alert.action, ticker: alert.ticker, price: alert.price, conviction: analysis.conviction } };
}

module.exports = {
  handleWebhookAlert,
  handleHttpAlert,
  parseAlert,
  buildEnhancedEmbed,
  buildAckEmbed,
  buildErrorEmbed,
  prewarmOllama,
  generateChartUrl,
};
