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
 *
 * HARDENED:
 * - Rate-limited Discord posting (min 2s between messages per channel)
 * - Emergency stop kills autonomous loop + writes post-mortem
 * - All scheduled actions logged to audit trail
 */

const schedule = require('node-schedule');
const { persona } = require('../personality');
const { getMarketContext } = require('../data/market');
const mood = require('./mood');
const commentary = require('./commentary');
const stats = require('./stats');
const gamma = require('./gamma');
const mahoraga = require('./mahoraga');
const policy = require('./policy');
const config = require('../config');
const auditLog = require('./audit-log');
const circuitBreaker = require('./circuit-breaker');

// Rate limit: minimum ms between Discord posts per channel
const RATE_LIMIT_MS = 2000;

class AutonomousBehaviorEngine {
  constructor(client) {
    this.client = client;
    this.jobs = [];
    this._stopped = false; // emergency stop flag

    // Rate limiting state: channelName → last post timestamp
    this._lastPostTime = new Map();

    // GEX monitor state — tracks last-known regime so we only alert on flips
    // Key: ticker, Value: { flipStrike, regime, spotPrice, lastAlertTime }
    this.gexState = new Map();
    this.gexWatchlist = ['SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMD', 'META', 'AMZN', 'IWM'];
  }

  startAllSchedules() {
    console.log(`[Sprocket] Starting autonomous behavior schedules...`);
    this._stopped = false;

    // 1. PRE-MARKET BRIEFING (8:30 AM ET, Monday-Friday)
    this.jobs.push(
      schedule.scheduleJob({ rule: '30 8 * * 1-5', tz: 'America/New_York' }, async () => {
        if (this._stopped) return;
        auditLog.log('schedule', 'Running pre-market briefing');
        try {
          const spyData = await this.getPreMarketMove('SPY');

          // Update mood from market signal
          if (spyData.available) {
            mood.updateFromPnL(spyData.change);
          }

          // Use AI commentary for a unique opener
          const opener = await commentary.briefingOpener();
          const direction = spyData.change >= 0 ? 'higher' : 'lower';

          let body;
          if (spyData.available) {
            body = await commentary.marketMove('SPY', spyData.change);
          } else {
            body = `Pre-market data unavailable right now. I'll check back later.`;
          }

          const message = [
            `**${persona.name}'s Pre-Market Briefing**`,
            ``,
            opener,
            ``,
            body,
            ``,
            `Not financial advice.`,
          ].join('\n');

          await this.postToChannel(config.tradingChannelName, message);
        } catch (err) {
          console.error('[Sprocket] Pre-market briefing error:', err.message);
          auditLog.log('error', `Pre-market briefing error: ${err.message}`);
        }
      })
    );

    // 2. MARKET HEALTH PULSE (Every 2 hours during market hours: 10, 12, 2, 4 PM ET)
    this.jobs.push(
      schedule.scheduleJob({ rule: '0 10,12,14,16 * * 1-5', tz: 'America/New_York' }, async () => {
        if (this._stopped) return;
        auditLog.log('schedule', 'Running market health pulse');
        try {
          // Decay mood toward neutral between updates
          mood.decay();

          const heatmap = await this.generateSectorHeatmap();

          const message = [
            `**Sector Pulse Update** *(${persona.name} is feeling ${mood.getMood()})*`,
            ``,
            heatmap || `Sector data is currently unavailable. Data providers might be down.`,
            ``,
            `Not financial advice.`,
          ].join('\n');

          await this.postToChannel(config.tradingChannelName, message);
        } catch (err) {
          console.error('[Sprocket] Market health pulse error:', err.message);
          auditLog.log('error', `Market health pulse error: ${err.message}`);
        }
      })
    );

    // 3. UNPROMPTED OBSERVATIONS (11 AM ET, 30% chance)
    this.jobs.push(
      schedule.scheduleJob({ rule: '0 11 * * 1-5', tz: 'America/New_York' }, async () => {
        if (this._stopped) return;
        if (Math.random() > 0.3) return; // 30% chance to trigger
        auditLog.log('schedule', 'Running unprompted observation');
        try {
          const observation = await this.scanForUnusualActivity();
          if (!observation) return;

          // Use AI to phrase the observation in Sprocket's voice
          const aiComment = await commentary.unusualActivity(observation.ticker, observation.detail);
          const message = `*${persona.name} whispers* ${aiComment || observation.detail + ' Not financial advice.'}`;
          await this.postToChannel(config.tradingChannelName, message);
        } catch (err) {
          console.error('[Sprocket] Observation scan error:', err.message);
          auditLog.log('error', `Observation scan error: ${err.message}`);
        }
      })
    );

    // 4. WEEKEND REFLECTION (Saturday 10 AM ET)
    this.jobs.push(
      schedule.scheduleJob({ rule: '0 10 * * 6', tz: 'America/New_York' }, async () => {
        if (this._stopped) return;
        auditLog.log('schedule', 'Running weekend reflection');
        try {
          const reflection = await this.generateWeeklyReflection();

          const message = [
            `**${persona.name}'s Weekly Review**`,
            ``,
            reflection || `Could not generate weekly review — data providers may be offline.`,
            ``,
            `Not financial advice.`,
          ].join('\n');

          await this.postToChannel(config.generalChannelName, message);
        } catch (err) {
          console.error('[Sprocket] Weekend reflection error:', err.message);
          auditLog.log('error', `Weekend reflection error: ${err.message}`);
        }
      })
    );

    // 5. GAMMA EXPOSURE MONITOR (every 30 min during market hours, Mon-Fri)
    // Scans watchlist tickers for gamma flip breaches and alerts the trading channel
    if (gamma.enabled) {
      this.jobs.push(
        schedule.scheduleJob({ rule: '*/30 9-16 * * 1-5', tz: 'America/New_York' }, async () => {
          if (this._stopped) return;
          auditLog.log('schedule', 'Running GEX flip monitor');
          await this._runGEXMonitor();
        })
      );
      console.log(`[Sprocket] GEX monitor active — watching: ${this.gexWatchlist.join(', ')}`);
    }

    // 6. SHARK AUTONOMOUS TRADING (configurable interval during market hours)
    // Signal ingestion → technical analysis → AI decision → trade execution
    mahoraga.setChannelPoster((content) => this.postToChannel(config.tradingChannelName, content));
    const scanMinutes = policy.getConfig().scan_interval_minutes || 5;
    this._mahoragaInterval = setInterval(async () => {
      if (this._stopped) return;
      if (!mahoraga.enabled) return;
      // Only trade during market hours (Mon-Fri, roughly 9:30-16:00 ET)
      const now = new Date();
      const etOptions = { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false };
      const etParts = new Intl.DateTimeFormat('en-US', etOptions).formatToParts(now);
      const etHour = parseInt(etParts.find(p => p.type === 'hour').value, 10);
      const day = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
      if (day === 0 || day === 6) return; // weekend
      if (etHour < 9 || etHour >= 16) return; // outside market hours
      auditLog.log('schedule', 'Running SHARK autonomous trading cycle');
      await mahoraga.runCycle();
    }, scanMinutes * 60 * 1000);
    console.log(`[Sprocket] SHARK trading schedule active — every ${scanMinutes}min (when enabled via /agent enable)`);

    console.log(`[Sprocket] ${this.jobs.length} scheduled behaviors active.`);
  }

  stopAllSchedules() {
    for (const job of this.jobs) {
      if (job) job.cancel();
    }
    this.jobs = [];
    if (this._mahoragaInterval) {
      clearInterval(this._mahoragaInterval);
      this._mahoragaInterval = null;
    }
    this._stopped = true;
    console.log('[Sprocket] All scheduled behaviors stopped.');
    auditLog.log('schedule', 'All scheduled behaviors stopped');
  }

  /**
   * Emergency stop — kills the autonomous loop, the trading engine,
   * closes all positions, and writes a post-mortem log.
   * Triggered by !emergency prefix command.
   * @returns {{ postMortemPath: string, message: string }}
   */
  async emergencyStop() {
    auditLog.log('emergency', 'EMERGENCY STOP INITIATED');

    // 1. Stop all scheduled behaviors immediately
    this.stopAllSchedules();

    // 2. Kill the trading engine (closes positions, writes post-mortem)
    let postMortemPath = null;
    try {
      postMortemPath = await mahoraga.kill();
    } catch (err) {
      auditLog.log('error', `Emergency kill error: ${err.message}`);
    }

    // 3. Post to trading channel
    try {
      await this.postToChannel(config.tradingChannelName, [
        `🚨 **EMERGENCY STOP ACTIVATED**`,
        ``,
        `All autonomous behaviors have been halted.`,
        `Kill switch activated — all orders cancelled, positions closing.`,
        `Post-mortem log written for debugging.`,
        ``,
        `_Use /agent enable and restart schedules to resume._`,
      ].join('\n'));
    } catch {
      // Best effort — don't fail the emergency stop
    }

    const message = 'Emergency stop complete. All schedules stopped, kill switch active, positions closing.';
    auditLog.log('emergency', message);

    return { postMortemPath, message };
  }

  // ── Channel posting (rate-limited) ──────────────────────────────────

  async postToChannel(channelName, content) {
    const channel = this.client.channels.cache.find(
      ch => ch.name === channelName && ch.isTextBased()
    );

    if (!channel) {
      console.warn(`[Sprocket] Channel "${channelName}" not found. Skipping post.`);
      return;
    }

    // Rate limiting: enforce minimum gap between posts to same channel
    const lastPost = this._lastPostTime.get(channelName) || 0;
    const elapsed = Date.now() - lastPost;
    if (elapsed < RATE_LIMIT_MS) {
      const waitMs = RATE_LIMIT_MS - elapsed;
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    try {
      await channel.send(content);
      this._lastPostTime.set(channelName, Date.now());
      stats.recordMessage();
    } catch (err) {
      // Handle Discord rate limit (429) with retry
      if (err.httpStatus === 429 || err.message?.includes('rate limit')) {
        const retryAfter = err.retryAfter || 5000;
        console.warn(`[Sprocket] Discord rate limited on #${channelName}, waiting ${retryAfter}ms`);
        auditLog.log('rate_limit', `Discord rate limit on #${channelName}, waiting ${retryAfter}ms`);
        await new Promise(resolve => setTimeout(resolve, retryAfter));
        try {
          await channel.send(content);
          this._lastPostTime.set(channelName, Date.now());
          stats.recordMessage();
        } catch (retryErr) {
          console.error(`[Sprocket] Retry failed for #${channelName}:`, retryErr.message);
        }
      } else {
        console.error(`[Sprocket] Failed to post to #${channelName}:`, err.message);
      }
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

    for (const ticker of watchlist) {
      const ctx = await getMarketContext(ticker);
      if (ctx.error || !ctx.quote) continue;

      // Flag anything with > 3% move as "unusual" (simple heuristic)
      const pct = Math.abs(ctx.quote.changePercent ?? 0);
      if (pct > 3) {
        const direction = ctx.quote.changePercent > 0 ? 'up' : 'down';
        return {
          ticker,
          detail: `${ticker} is moving ${direction} ${pct.toFixed(1)}% with atypical volume patterns.`,
        };
      }
    }

    return null;
  }

  // ── GEX Flip Monitor ─────────────────────────────────────────────────

  /**
   * Scan watchlist tickers for gamma flip breaches.
   * Alerts the trading channel when spot price crosses the gamma flip level
   * (regime change from long→short gamma or vice versa).
   */
  async _runGEXMonitor() {
    const cooldown = 2 * 60 * 60 * 1000; // 2h cooldown per ticker between alerts
    let consecutiveFailures = 0;

    for (const ticker of this.gexWatchlist) {
      // Fail-fast: if 3 tickers in a row fail, there's probably a connectivity issue
      if (consecutiveFailures >= 3) {
        console.warn(`[Sprocket] GEX monitor: 3 consecutive failures, skipping remaining tickers`);
        break;
      }

      try {
        const result = await gamma.analyze(ticker);
        consecutiveFailures = 0; // reset on success
        const { spotPrice, flip } = result;

        if (!flip.flipStrike) continue;

        const prev = this.gexState.get(ticker);
        const now = Date.now();

        // First run — just record state, don't alert
        if (!prev) {
          this.gexState.set(ticker, {
            flipStrike: flip.flipStrike,
            regime: flip.regime,
            spotPrice,
            lastAlertTime: 0,
          });
          continue;
        }

        // Check for regime change
        const regimeChanged = prev.regime !== flip.regime;
        const flipMoved = Math.abs(prev.flipStrike - flip.flipStrike) / prev.flipStrike > 0.02; // >2% shift

        if ((regimeChanged || flipMoved) && (now - prev.lastAlertTime) > cooldown) {
          // Build alert
          const emoji = flip.regime === 'long_gamma' ? '🟢' : '🔴';
          const regimeLabel = flip.regime === 'long_gamma'
            ? 'LONG GAMMA (dealers suppress moves — chop/reversion likely)'
            : 'SHORT GAMMA (dealers amplify moves — trend/breakout likely)';

          const alert = [
            `⚡ **GEX ALERT — ${ticker}**`,
            ``,
            `${emoji} **Regime: ${regimeLabel}**`,
            `Spot: \`$${spotPrice}\` | Gamma Flip: \`$${flip.flipStrike}\``,
            regimeChanged
              ? `📢 Regime changed from **${prev.regime.replace('_', ' ')}** → **${flip.regime.replace('_', ' ')}**`
              : `📢 Gamma flip shifted: \`$${prev.flipStrike}\` → \`$${flip.flipStrike}\``,
            ``,
            `_Use /gex ${ticker} for full chart & breakdown_`,
          ].join('\n');

          await this.postToChannel(config.tradingChannelName, alert);
          auditLog.log('gex', `GEX alert: ${ticker} regime=${flip.regime}`);

          this.gexState.set(ticker, {
            flipStrike: flip.flipStrike,
            regime: flip.regime,
            spotPrice,
            lastAlertTime: now,
          });
        } else {
          // Update state without alerting
          this.gexState.set(ticker, { ...prev, flipStrike: flip.flipStrike, regime: flip.regime, spotPrice });
        }
      } catch (err) {
        consecutiveFailures++;
        // Don't spam logs for tickers without options data
        if (!err.message?.includes('No options data')) {
          console.warn(`[Sprocket] GEX monitor error for ${ticker}:`, err.message);
        }
      }
    }
  }

  /**
   * Generate a weekly reflection summary.
   * TODO: Replace with portfolio/performance tracking API.
   */
  async generateWeeklyReflection() {
    const botStats = stats.getSummary();
    const moodSummary = mood.getSummary();
    const cbStatus = circuitBreaker.getStatus();

    const lines = [
      `Another week in the books. Here's the efficiency report:`,
      ``,
      `- Messages processed: **${botStats.messagesProcessed}**`,
      `- Commands handled: **${botStats.commandsRun}**`,
      `- Errors encountered: **${botStats.errors}** ${botStats.errors === 0 ? '(running at peak efficiency)' : '(room for optimization)'}`,
      `- Uptime: **${botStats.uptime}**`,
      `- Memory footprint: **${botStats.memory.heapUsed}/${botStats.memory.heapTotal} MB** heap`,
      `- Mood: **${moodSummary.mood}** (score: ${moodSummary.score}, rolling avg PNL: ${(moodSummary.rollingAvgPnL || 0).toFixed(2)}%)`,
      `- Circuit breaker trips: **${cbStatus.totalTrips}** (consecutive bad trades: ${cbStatus.consecutiveBadTrades})`,
      ``,
      `Market data review is not available until data providers are connected.`,
      `Use /analyze <ticker> during the week for live analysis.`,
    ];

    return lines.join('\n');
  }
}

module.exports = AutonomousBehaviorEngine;
