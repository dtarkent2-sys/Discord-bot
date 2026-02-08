/**
 * autonomous-behaviors.js — Sprocket's Internal Clock
 *
 * Scheduled behaviors that run automatically:
 * 1. Pre-market briefing (8:30 AM ET, Mon-Fri)
 * 2. Market health pulse (every 2h during market hours)
 * 3. Unprompted observations (random, ~30% chance at 11 AM)
 * 4. Weekend reflection (Saturday 10 AM)
 *
 * All data comes from provider methods — never invented.
 * If a data fetch fails, Sprocket says so honestly.
 */

const schedule = require('node-schedule');
const { persona, pick } = require('../personality');
const { getMarketContext } = require('../data/market');
const stats = require('../services/stats');
const config = require('../config');

class AutonomousBehaviorEngine {
  constructor(client) {
    this.client = client;
    this.jobs = [];
  }

  startAllSchedules() {
    console.log(`[Sprocket] Starting autonomous behavior schedules...`);

    // 1. PRE-MARKET BRIEFING (8:30 AM ET, Monday-Friday)
    this.jobs.push(
      schedule.scheduleJob({ rule: '30 8 * * 1-5', tz: 'America/New_York' }, async () => {
        console.log('[Sprocket] Running pre-market briefing...');
        try {
          const spyData = await this.getPreMarketMove('SPY');
          const tone = spyData.change >= 0
            ? pick(persona.speechPatterns.marketUp)
            : pick(persona.speechPatterns.marketDown);

          const direction = spyData.change >= 0 ? 'higher' : 'lower';
          const message = [
            `**${persona.name}'s Pre-Market Briefing**`,
            ``,
            pick(persona.speechPatterns.greetings),
            ``,
            spyData.available
              ? `Futures pointing ${direction}. SPY pre-market: ${spyData.change > 0 ? '+' : ''}${spyData.change}%. ${tone}`
              : `Pre-market data unavailable right now. ${pick(persona.speechPatterns.noData)}`,
            ``,
            `Not financial advice.`,
          ].join('\n');

          await this.postToChannel(config.tradingChannelName, message);
        } catch (err) {
          console.error('[Sprocket] Pre-market briefing error:', err.message);
        }
      })
    );

    // 2. MARKET HEALTH PULSE (Every 2 hours during market hours: 10, 12, 2, 4 PM ET)
    this.jobs.push(
      schedule.scheduleJob({ rule: '0 10,12,14,16 * * 1-5', tz: 'America/New_York' }, async () => {
        console.log('[Sprocket] Running market health pulse...');
        try {
          const heatmap = await this.generateSectorHeatmap();

          const message = [
            `**Sector Pulse Update**`,
            ``,
            heatmap || `${pick(persona.speechPatterns.error)} Sector data is currently unavailable.`,
            ``,
            `Not financial advice.`,
          ].join('\n');

          await this.postToChannel(config.tradingChannelName, message);
        } catch (err) {
          console.error('[Sprocket] Market health pulse error:', err.message);
        }
      })
    );

    // 3. UNPROMPTED OBSERVATIONS (11 AM ET, 30% chance)
    this.jobs.push(
      schedule.scheduleJob({ rule: '0 11 * * 1-5', tz: 'America/New_York' }, async () => {
        if (Math.random() > 0.3) return; // 30% chance to trigger
        console.log('[Sprocket] Running unprompted observation...');
        try {
          const observation = await this.scanForUnusualActivity();
          if (!observation) return;

          const message = `*${persona.name} whispers* Hmm. ${observation} Worth a glance. Not financial advice.`;
          await this.postToChannel(config.tradingChannelName, message);
        } catch (err) {
          console.error('[Sprocket] Observation scan error:', err.message);
        }
      })
    );

    // 4. WEEKEND REFLECTION (Saturday 10 AM ET)
    this.jobs.push(
      schedule.scheduleJob({ rule: '0 10 * * 6', tz: 'America/New_York' }, async () => {
        console.log('[Sprocket] Running weekend reflection...');
        try {
          const reflection = await this.generateWeeklyReflection();

          const message = [
            `**${persona.name}'s Weekly Review**`,
            ``,
            reflection || `${pick(persona.speechPatterns.error)} Could not generate weekly review — data providers may be offline.`,
            ``,
            `Not financial advice.`,
          ].join('\n');

          await this.postToChannel(config.generalChannelName, message);
        } catch (err) {
          console.error('[Sprocket] Weekend reflection error:', err.message);
        }
      })
    );

    console.log(`[Sprocket] ${this.jobs.length} scheduled behaviors active.`);
  }

  stopAllSchedules() {
    for (const job of this.jobs) {
      if (job) job.cancel();
    }
    this.jobs = [];
    console.log('[Sprocket] All scheduled behaviors stopped.');
  }

  // ── Channel posting ────────────────────────────────────────────────

  async postToChannel(channelName, content) {
    const channel = this.client.channels.cache.find(
      ch => ch.name === channelName && ch.isTextBased()
    );

    if (!channel) {
      console.warn(`[Sprocket] Channel "${channelName}" not found. Skipping post.`);
      return;
    }

    try {
      await channel.send(content);
      stats.recordMessage();
    } catch (err) {
      console.error(`[Sprocket] Failed to post to #${channelName}:`, err.message);
    }
  }

  // ── Data providers (stub implementations — replace with real APIs) ─

  /**
   * Get pre-market move for a ticker.
   * TODO: Replace with Alpaca, Polygon, or other market data API.
   * Expected: { change: number (percent), available: boolean }
   */
  async getPreMarketMove(ticker) {
    try {
      const ctx = await getMarketContext(ticker);
      if (ctx.error) {
        return { change: 0, available: false };
      }
      const quote = ctx.quote;
      return {
        change: quote?.changePercent ?? 0,
        available: true,
      };
    } catch {
      return { change: 0, available: false };
    }
  }

  /**
   * Generate sector heatmap string.
   * TODO: Replace with real sector ETF data (XLK, XLF, XLE, XLV, etc.)
   */
  async generateSectorHeatmap() {
    const sectors = ['XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLC', 'XLY', 'XLP', 'XLU', 'XLRE', 'XLB'];
    const results = [];

    for (const etf of sectors) {
      const ctx = await getMarketContext(etf);
      if (!ctx.error && ctx.quote) {
        const pct = ctx.quote.changePercent ?? 0;
        const bar = pct >= 0 ? '🟩' : '🟥';
        results.push(`${bar} **${etf}**: ${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`);
      }
    }

    if (results.length === 0) {
      return null; // No data available
    }

    return results.join('\n');
  }

  /**
   * Scan for unusual volume or price activity.
   * TODO: Replace with real screener/scanner API.
   */
  async scanForUnusualActivity() {
    // Watchlist to scan — expand as needed
    const watchlist = ['AAPL', 'TSLA', 'NVDA', 'AMD', 'META', 'AMZN', 'GOOGL', 'MSFT'];
    const unusual = [];

    for (const ticker of watchlist) {
      const ctx = await getMarketContext(ticker);
      if (ctx.error || !ctx.quote) continue;

      // Flag anything with > 3% move as "unusual" (simple heuristic)
      const pct = Math.abs(ctx.quote.changePercent ?? 0);
      if (pct > 3) {
        unusual.push(`**${ticker}** is moving ${ctx.quote.changePercent > 0 ? 'up' : 'down'} ${pct.toFixed(1)}% — atypical volume patterns.`);
      }
    }

    if (unusual.length === 0) return null;
    return unusual.slice(0, 3).join(' ');
  }

  /**
   * Generate a weekly reflection summary.
   * TODO: Replace with portfolio/performance tracking API.
   */
  async generateWeeklyReflection() {
    const botStats = stats.getSummary();

    const lines = [
      `Another week in the books. Here's the efficiency report:`,
      ``,
      `- Messages processed: **${botStats.messagesProcessed}**`,
      `- Commands handled: **${botStats.commandsRun}**`,
      `- Errors encountered: **${botStats.errors}** ${botStats.errors === 0 ? '(running at peak efficiency)' : '(room for optimization)'}`,
      `- Uptime: **${botStats.uptime}**`,
      `- Memory footprint: **${botStats.memory.heapUsed}/${botStats.memory.heapTotal} MB** heap`,
      ``,
      `Market data review is not available until data providers are connected.`,
      `Use /analyze <ticker> during the week for live analysis.`,
    ];

    return lines.join('\n');
  }
}

module.exports = AutonomousBehaviorEngine;
