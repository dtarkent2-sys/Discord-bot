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
 * Parse a TradingView webhook alert. Handles JSON or plain text.
 *
 * @param {string} content — Raw message content
 * @returns {{ action, type, price, reason, raw }}
 *
 * JSON example: {"action":"Buy","type":"SPY 0DTE Call","price":"590.50","reason":"RSI oversold"}
 * Text example: "Buy SPY 0DTE Call @ $590.50"
 */
function parseAlert(content) {
  const raw = content.trim();

  // Try JSON first
  try {
    const json = JSON.parse(raw);
    return {
      action: (json.action || json.signal || json.direction || 'UNKNOWN').toUpperCase(),
      type: json.type || json.instrument || 'SPY 0DTE',
      price: parseFloat(json.price) || null,
      reason: json.reason || json.message || json.note || '',
      raw,
    };
  } catch {
    // Not JSON — parse as text
  }

  // Text fallback: "Buy SPY 0DTE Call @ $590.50" or similar
  const actionMatch = raw.match(/\b(buy|sell|long|short)\b/i);
  const priceMatch = raw.match(/\$?([\d,]+\.?\d*)/);
  const typeMatch = raw.match(/(SPY\s*0DTE\s*(?:Call|Put|Straddle|Strangle)?)/i);
  const reasonMatch = raw.match(/(?:reason|note|because|signal)[:=]\s*(.+)/i);

  return {
    action: actionMatch ? actionMatch[1].toUpperCase() : 'UNKNOWN',
    type: typeMatch ? typeMatch[1].trim() : 'SPY 0DTE',
    price: priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : null,
    reason: reasonMatch ? reasonMatch[1].trim() : '',
    raw,
  };
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
  return new EmbedBuilder()
    .setTitle('⏳ Alert Received! Processing...')
    .setDescription(`**${alert.action}** ${alert.type}${alert.price ? ` @ $${alert.price}` : ''}`)
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

  const embed = new EmbedBuilder()
    .setTitle(`${actionEmoji[analysis.action] || '⚪'} Enhanced 0DTE Alert: ${alert.action} ${alert.type}${alert.price ? ` @ $${alert.price}` : ''}${titleFlair}`)
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
      value: `**${analysis.stopLoss || 'N/A'}**`,
      inline: true,
    },
    {
      name: '🎯 Target',
      value: `**${analysis.target || 'N/A'}**`,
      inline: true,
    },
  );

  // Timeframe and mood
  embed.addFields(
    {
      name: '⏰ Timeframe',
      value: `**${analysis.timeframe || 'EOD'}**`,
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

  // Alert reason
  if (alert.reason) {
    embed.addFields({
      name: '📝 Alert Reason',
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
 * Generate a QuickChart.io candlestick chart URL from yahoo-finance2 data.
 * Uses the QuickChart API (free, no key needed) with Chart.js config.
 *
 * @returns {string|null} — Chart image URL or null
 */
async function generateChartUrl() {
  try {
    // Try to get SPY history from yahoo-finance2
    let yahooFinance;
    try {
      yahooFinance = require('yahoo-finance2').default;
    } catch {
      return null;
    }

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 5); // Last 5 days for intraday view

    const history = await yahooFinance.chart('SPY', {
      period1: startDate,
      period2: endDate,
      interval: '15m',
    });

    if (!history || !history.quotes || history.quotes.length < 5) return null;

    // Take last 20 candles
    const candles = history.quotes.slice(-20);
    const labels = candles.map(c => {
      const d = new Date(c.date);
      return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    });
    const opens = candles.map(c => c.open);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const closes = candles.map(c => c.close);

    // QuickChart OHLC/candlestick via financial chart
    const chartConfig = {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'SPY Price',
            data: closes.map((c, i) => ({
              x: labels[i],
              o: opens[i],
              h: highs[i],
              l: lows[i],
              c: closes[i],
            })),
            backgroundColor: closes.map((c, i) => c >= opens[i] ? 'rgba(0, 200, 83, 0.8)' : 'rgba(255, 68, 68, 0.8)'),
            borderColor: closes.map((c, i) => c >= opens[i] ? '#00c853' : '#ff4444'),
            borderWidth: 1,
          },
        ],
      },
      options: {
        plugins: {
          title: { display: true, text: `SPY Intraday — ${todayString()}`, color: '#fff' },
          legend: { display: false },
        },
        scales: {
          y: {
            ticks: { color: '#ccc' },
            grid: { color: 'rgba(255,255,255,0.1)' },
          },
          x: {
            ticks: { color: '#ccc', maxRotation: 45 },
            grid: { color: 'rgba(255,255,255,0.1)' },
          },
        },
      },
    };

    // Simple line chart fallback (more reliable with QuickChart)
    const simpleChart = {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'SPY',
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
          title: { display: true, text: `SPY Intraday — ${todayString()}`, color: '#fff', font: { size: 14 } },
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
    // Fetch price + news in parallel (both cached 60s)
    const [priceData, newsData] = await Promise.all([
      fetchSPYPrice(),
      fetchSPYNews(),
    ]);

    // Run fast Ollama analysis
    const analysis = await runFastAnalysis(alert, priceData, newsData);

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

module.exports = {
  handleWebhookAlert,
  parseAlert,
  buildEnhancedEmbed,
  buildAckEmbed,
  buildErrorEmbed,
  prewarmOllama,
  generateChartUrl,
};
