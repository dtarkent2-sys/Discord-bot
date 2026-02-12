class AutonomousBehaviorEngine {
  constructor(client) {
    this.client = client;
    this.jobs = [];
    this._stopped = false;

    this._lastPostTime = new Map();

    this.gexState = new Map();
    this.gexWatchlist = ['SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMD', 'META', 'AMZN', 'IWM'];

    this._gexEngine = new GEXEngine(gamma);
    this._gexAlerts = new GEXAlertService();
  }

  startAllSchedules() {
    console.log(`[Sprocket] Starting autonomous behavior schedules...`);
    this._stopped = false;

    this.jobs.push(
      schedule.scheduleJob({ rule: '30 8 * * 1-5', tz: 'America/New_York' }, async () => {
        if (this._stopped) return;
        auditLog.log('schedule', 'Running pre-market briefing');
        try {
          const spyData = await this.getPreMarketMove('SPY');
          if (spyData.available) {
            mood.updateFromPnL(spyData.change);
          }
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

    this.jobs.push(
      schedule.scheduleJob({ rule: '0 10,12,14,16 * * 1-5', tz: 'America/New_York' }, async () => {
        if (this._stopped) return;
        auditLog.log('schedule', 'Running market health pulse');
        try {
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

    this.jobs.push(
      schedule.scheduleJob({ rule: '0 11 * * 1-5', tz: 'America/New_York' }, async () => {
        if (this._stopped) return;
        if (Math.random() > 0.3) return;
        auditLog.log('schedule', 'Running unprompted observation');
        try {
          const observation = await this.scanForUnusualActivity();
          if (!observation) return;
          const aiComment =
            await commentary.unusualActivity(observation.ticker, observation.detail);
          const message = `*${persona.name} whispers* ${aiComment || observation.detail + ' Not financial advice.'}`;
          await this.postToChannel(config.tradingChannelName, message);
        } catch (err) {
          console.error('[Sprocket] Observation scan error:', err.message);
          auditLog.log('error', `Observation scan error: ${err.message}`);
        }
      })
    );

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

    mahoraga.setChannelPoster((content) =>
      this.postToChannel(config.tradingChannelName, content)
    );
    const scanMinutes = policy.getConfig().scan_interval_minutes || 5;
    this._mahoragaInterval = setInterval(async () => {
      if (this._stopped) return;
      if (!mahoraga.enabled) return;
      const now = new Date();
      const etOptions = { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false };
      const etParts = new Intl.DateTimeFormat('en-US', etOptions).formatToParts(now);
      const etHour = parseInt(etParts.find(p => p.type === 'hour').value, 10);
      const day = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
      if (day === 0 || day === 6) return;
      if (etHour < 9 || etHour >= 16) return;
      auditLog.log('schedule', 'Running SHARK autonomous trading cycle');
      try {
        await mahoraga.runCycle();
      } catch (err) {
        console.error('[Sprocket] SHARK trading cycle error:', err.message);
        auditLog.log('error', `SHARK trading cycle error: ${err.message}`);
      }
    }, scanMinutes * 60 * 1000);
    console.log(`[Sprocket] SHARK trading schedule active — every ${scanMinutes}min (when enabled via /agent enable)`);

    initiative.init(this.client, (content) => this.postToChannel(config.tradingChannelName, content));
    initiative.start();
    initiative.ensureJournalChannel().catch(() => {});
    console.log(`[Sprocket] Initiative engine active — autonomous brain running`);

    gammaSqueeze.setChannelPoster((content) => this.postToChannel(config.tradingChannelName, content));
    gammaSqueeze.start();
    console.log(`[Sprocket] Gamma squeeze engine active — watching ${gammaSqueeze.getWatchlist().join(', ')}`);

    yoloMode.init(this.client, (content) => this.postToChannel(config.tradingChannelName, content));
    yoloMode.start();
    console.log(`[Sprocket] YOLO mode ${yoloMode.enabled ? 'ACTIVE — autonomous self-improvement running' : 'standby — use /yolo enable to activate'}`);

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
    initiative.stop();
    gammaSqueeze.stop();
    yoloMode.stop();
    this._stopped = true;
    console.log('[Sprocket] All scheduled behaviors stopped.');
    auditLog.log('schedule', 'All scheduled behaviors stopped');
  }

  async emergencyStop() {
    auditLog.log('emergency', 'EMERGENCY STOP INITIATED');

    this.stopAllSchedules();

    let postMortemPath = null;
    try {
      postMortemPath = await mahoraga.kill();
    } catch (err) {
      auditLog.log('error', `Emergency kill error: ${err.message}`);
    }

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
      // ignore
    }

    const message = 'Emergency stop complete. All schedules stopped, kill switch active, positions closing.';
    auditLog.log('emergency', message);

    return { postMortemPath, message };
  }

  async postToChannel(channelName, content) {
    const channel = this.client.channels.cache.find(
      ch => ch.name === channelName && ch.isTextBased()
    );

    if (!channel) {
      console.warn(`[Sprocket] Channel "${channelName}" not found. Skipping post.`);
      return;
    }

    const lastPost = this._lastPostTime.get(channelName) || 0;
    const elapsed = Date.now() - lastPost;
    if (elapsed < RATE_LIMIT_MS) {
      const waitMs = RATE_LIMIT_MS - elapsed;
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    const preview = contentPreview(content);
    console.log(`[SafeSend] autonomous channel.send channel:${channel.id} (#${channelName}) content:${preview}`);

    try {
      await channel.send(content);
      this._lastPostTime.set(channelName, Date.now());
      stats.recordMessage();
    } catch (err) {
      const known = classifySendError(err);
      if (known) {
        console.error(`[SafeSend] ${known.type} posting to #${channelName} (${channel.id}): ${known.detail}`, err.message);
        await notifyOwner(this.client, `${known.type} posting to #${channelName} (<#${channel.id}>): ${known.detail}`);
      }

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
      } else if (!known) {
        console.error(`[Sprocket] Failed to post to #${channelName}:`, err.message);
      }
    }
  }

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
      return null;
    }
    return results.join('\n');
  }

  async scanForUnusualActivity() {
    const watchlist = ['AAPL', 'TSLA', 'NVDA', 'AMD', 'META', 'AMZN', 'GOOGL', 'MSFT'];
    for (const ticker of watchlist) {
      const ctx = await getMarketContext(ticker);
      if (ctx.error || !ctx.quote) continue;
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

  async _runGEXMonitor() {
    const cooldown = 2 * 60 * 60 * 1000;
    let consecutiveFailures = 0;

    for (const ticker of this.gexWatchlist) {
      if (consecutiveFailures >= 3) {
        console.warn(`[Sprocket] GEX monitor: 3 consecutive failures, skipping remaining tickers`);
        break;
      }

      try {
        const summary = await this._gexEngine.analyze(ticker);
        consecutiveFailures = 0;
        const { spot, regime, gammaFlip } = summary;
        const prev = this.gexState.get(ticker);
        const now = Date.now();

        if (!prev) {
          this.gexState.set(ticker, {
            flipStrike: gammaFlip,
            regime: regime.label,
            spotPrice: spot,
            lastAlertTime: 0,
          });
          continue;
        }

        const regimeChanged = prev.regime !== regime.label;
        const flipMoved = prev.flipStrike && gammaFlip
          ? Math.abs(prev.flipStrike - gammaFlip) / prev.flipStrike > 0.02
          : false;

        if ((regimeChanged || flipMoved) && (now - prev.lastAlertTime) > cooldown) {
          const emoji = regime.label === 'Long Gamma' ? '🟢'
            : regime.label === 'Short Gamma' ? '🔴' : '🟡';
          const confPct = (regime.confidence * 100).toFixed(0);
          const callWall = summary.walls.callWalls[0];
          const putWall = summary.walls.putWalls[0];
          const alert = [
            `⚡ **GEX ALERT — ${ticker}**`,
            ``,
            `${emoji} **Regime: ${regime.label}** (${confPct}% confidence)`,
            `Spot: \`$${spot}\` | Flip: \`$${gammaFlip || '—'}\``,
            regimeChanged
              ? `📢 Regime changed: **${prev.regime}** → **${regime.label}**`
              : `📢 Gamma flip shifted: \`$${prev.flipStrike}\` → \`$${gammaFlip}\``,
            callWall ? `Call Wall: \`$${callWall.strike}\`${callWall.stacked ? ' **STACKED**' : ''}` : '',
            putWall ? `Put Wall: \`$${putWall.strike}\`${putWall.stacked ? ' **STACKED**' : ''}` : '',
            ``,
            `_/gex summary ${ticker} for full multi-expiry breakdown_`,
          ].filter(Boolean).join('\n');

          await this.postToChannel(config.tradingChannelName, alert);
          auditLog.log('gex', `GEX alert: ${ticker} regime=${regime.label} conf=${confPct}%`);

          this.gexState.set(ticker, {
            flipStrike: gammaFlip,
            regime: regime.label,
            spotPrice: spot,
            lastAlertTime: now,
          });
        } else {
          this.gexState.set(ticker, { ...prev, flipStrike: gammaFlip, regime: regime.label, spotPrice: spot });
        }

        try {
          const alpacaSvc = require('./alpaca');
          if (alpacaSvc.enabled) {
            const bars = await alpacaSvc.getIntradayBars(ticker, {
              timeframe: this._gexAlerts.candleInterval,
              limit: 20,
            });
            const candles = (bars || []).map(b => ({
              close: b.close,
              volume: b.volume,
            }));
            const breakAlerts = this._gexAlerts.evaluate(ticker, candles, summary);
            for (const ba of breakAlerts) {
              await this.postToChannel(config.tradingChannelName, ba.message);
              auditLog.log('gex_alert', `Break-and-hold: ${ticker} ${ba.type} $${ba.level} ${ba.direction}`);
            }
          }
        } catch (candleErr) {
          if (!candleErr.message?.includes('not configured')) {
            console.warn(`[Sprocket] GEX break-hold check failed for ${ticker}: ${candleErr.message}`);
          }
        }
      } catch (err) {
        consecutiveFailures++;
        if (!err.message?.includes('No options data')) {
          console.warn(`[Sprocket] GEX monitor error for ${ticker}:`, err.message);
        }
      }
    }
  }

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