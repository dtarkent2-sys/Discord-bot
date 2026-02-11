/**
 * Initiative Engine — The Autonomous Brain
 *
 * Replaces rigid schedules with a fast-loop decision engine that constantly
 * evaluates "what should I do right now?" based on market conditions, recent
 * events, trading performance, and its own curiosity.
 *
 * Capabilities:
 *   1. Reactive market monitoring — detect unusual moves, volume spikes
 *   2. Self-tuning — learn from trade results, adjust own parameters
 *   3. Discord management — create channels/threads, post proactive insights
 *   4. Watchlist expansion — discover and track new opportunities
 *   5. Learning journal — persistent record of decisions and reflections
 *
 * Safety rails:
 *   - All parameter changes bounded by safe min/max ranges
 *   - Discord actions rate-limited
 *   - Emergency stop still overrides everything
 *   - Self-tuning changes are logged and reversible
 */

const Storage = require('./storage');
const auditLog = require('./audit-log');
const policy = require('./policy');
const circuitBreaker = require('./circuit-breaker');
const alpaca = require('./alpaca');
const macro = require('./macro');
const ai = require('./ai');
const gammaSqueeze = require('./gamma-squeeze');
const selfAwareness = require('./self-awareness');
const config = require('../config');

// How often the brain ticks (ms)
const TICK_INTERVAL = 30 * 1000; // 30 seconds

// Cooldowns per action type (ms)
const ACTION_COOLDOWNS = {
  market_scan:      2 * 60 * 1000,    // 2 min between unusual-move scans
  self_tune:        4 * 60 * 60 * 1000, // 4 hours between self-tune attempts
  journal_entry:    2 * 60 * 60 * 1000, // 2 hours between journal posts
  channel_topic:    30 * 60 * 1000,    // 30 min between topic updates
  insight_post:     15 * 60 * 1000,    // 15 min between proactive insights
  watchlist_scan:   60 * 60 * 1000,    // 1 hour between watchlist expansions
  trade_thread:     5 * 60 * 1000,     // 5 min between thread creations
  regime_reaction:  30 * 60 * 1000,    // 30 min between regime alerts
  squeeze_sector_scan: 60 * 60 * 1000, // 1 hour between sector squeeze scans
};

// Safe bounds for self-tuning parameters
const TUNING_BOUNDS = {
  options_scalp_take_profit_pct:  { min: 0.15, max: 0.60 },
  options_scalp_stop_loss_pct:    { min: 0.10, max: 0.40 },
  options_swing_take_profit_pct:  { min: 0.40, max: 1.50 },
  options_swing_stop_loss_pct:    { min: 0.20, max: 0.60 },
  options_min_conviction:         { min: 4, max: 8 },
  options_max_premium_per_trade:  { min: 200, max: 2000 },
  options_cooldown_minutes:       { min: 2, max: 15 },
  scan_interval_minutes:          { min: 2, max: 15 },
  cooldown_minutes:               { min: 10, max: 60 },
};

class InitiativeEngine {
  constructor() {
    this._storage = new Storage('initiative-state.json');
    this._journal = new Storage('initiative-journal.json');
    this._interval = null;
    this._client = null;          // Discord client
    this._postToChannel = null;   // Channel posting callback
    this._lastActions = new Map(); // action → last execution timestamp
    this._lastRegime = null;      // Track macro regime for change detection
    this._lastPrices = new Map(); // ticker → { price, timestamp } for move detection
    this._stopped = false;

    // Restore last action timestamps
    const saved = this._storage.get('lastActions', {});
    for (const [k, v] of Object.entries(saved)) {
      this._lastActions.set(k, v);
    }
  }

  /**
   * Wire up the Discord client and channel poster.
   * @param {import('discord.js').Client} client
   * @param {function} postToChannel
   */
  init(client, postToChannel) {
    this._client = client;
    this._postToChannel = postToChannel;
  }

  /**
   * Post to the journal channel (creates it if missing).
   * Falls back to trading channel if journal channel unavailable.
   */
  async postToJournal(content) {
    try {
      const channel = await this.ensureJournalChannel();
      if (channel) {
        await channel.send(content);
        return;
      }
    } catch {}
    // Fallback to trading channel
    if (this._postToChannel) {
      await this._postToChannel(content);
    }
  }

  /** Start the autonomous brain loop */
  start() {
    if (this._interval) return;
    this._stopped = false;
    this._interval = setInterval(() => this.tick(), TICK_INTERVAL);
    console.log(`[Initiative] Brain started — ticking every ${TICK_INTERVAL / 1000}s`);
    auditLog.log('initiative', 'Initiative engine started');
  }

  /** Stop the brain loop */
  stop() {
    this._stopped = true;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    console.log('[Initiative] Brain stopped');
  }

  // ── Main Tick ───────────────────────────────────────────────────

  async tick() {
    if (this._stopped) return;

    try {
      // Gather context
      const ctx = await this._gatherContext();
      if (!ctx) return;

      // Evaluate and score all possible actions
      const actions = this._scoreActions(ctx);

      // Execute the highest priority action that's off cooldown
      for (const action of actions) {
        if (action.score <= 0) break;  // No actions worth taking
        if (this._isOnCooldown(action.id)) continue;

        try {
          await action.execute(ctx);
          this._recordAction(action.id);
          auditLog.log('initiative', `Executed: ${action.id} (score: ${action.score})`);
          break; // One action per tick to avoid flooding
        } catch (err) {
          console.warn(`[Initiative] Action ${action.id} failed: ${err.message}`);
        }
      }
    } catch (err) {
      // Non-fatal — brain recovers next tick
      if (!err.message?.includes('not configured')) {
        console.warn(`[Initiative] Tick error: ${err.message}`);
      }
    }
  }

  // ── Context Gathering ──────────────────────────────────────────

  async _gatherContext() {
    const now = new Date();
    const et = this._getETTime();

    // Skip weekends
    if (et.day === 0 || et.day === 6) return null;

    // Only active around market hours (8 AM - 5 PM ET for pre/post market awareness)
    if (et.hour < 8 || et.hour > 17) return null;

    const isMarketOpen = et.hour >= 9 && (et.hour > 9 || et.minute >= 30) && et.hour < 16;

    return {
      now,
      et,
      isMarketOpen,
      cfg: policy.getConfig(),
      circuitBroken: circuitBreaker.isPaused(),
      alpacaEnabled: alpaca.enabled,
    };
  }

  // ── Action Scoring ──────────────────────────────────────────────

  /**
   * Score all possible actions. Returns sorted array (highest priority first).
   */
  _scoreActions(ctx) {
    const actions = [];

    // 1. Scan for unusual market moves (high priority during market hours)
    if (ctx.isMarketOpen && ctx.alpacaEnabled) {
      actions.push({
        id: 'market_scan',
        score: 8,
        execute: (c) => this._scanUnusualMoves(c),
      });
    }

    // 2. Self-tune parameters (after enough trades, lower priority)
    const tradeHistory = this._getTradeHistory();
    if (tradeHistory.length >= 5) {
      actions.push({
        id: 'self_tune',
        score: 5,
        execute: (c) => this._selfTuneParameters(c, tradeHistory),
      });
    }

    // 3. Post proactive market insight
    if (ctx.isMarketOpen) {
      actions.push({
        id: 'insight_post',
        score: 3,
        execute: (c) => this._postProactiveInsight(c),
      });
    }

    // 4. React to macro regime change
    actions.push({
      id: 'regime_reaction',
      score: 7,
      execute: (c) => this._reactToRegimeChange(c),
    });

    // 5. Update channel topic with current status
    if (ctx.isMarketOpen && this._client) {
      actions.push({
        id: 'channel_topic',
        score: 2,
        execute: (c) => this._updateChannelTopic(c),
      });
    }

    // 6. End-of-day journal
    if (ctx.et.hour === 16 && ctx.et.minute < 15) {
      actions.push({
        id: 'journal_entry',
        score: 6,
        execute: (c) => this._writeJournalEntry(c),
      });
    }

    // 7. Discover new tickers for watchlist
    if (ctx.isMarketOpen && ctx.alpacaEnabled) {
      actions.push({
        id: 'watchlist_scan',
        score: 2,
        execute: (c) => this._expandWatchlist(c),
      });
    }

    // 8. Gamma squeeze sector scan (medium priority, periodic)
    if (ctx.isMarketOpen && ctx.alpacaEnabled) {
      actions.push({
        id: 'squeeze_sector_scan',
        score: 4,
        execute: (c) => this._squeezeSectorScan(c),
      });
    }

    // Sort by score descending
    return actions.sort((a, b) => b.score - a.score);
  }

  // ── Action: Unusual Market Moves ──────────────────────────────

  async _scanUnusualMoves(ctx) {
    const watchlist = ['SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMD', 'META', 'AMZN', 'GOOGL', 'IWM', 'NFLX', 'COIN', 'MARA', 'SMCI'];

    let snapshots;
    try {
      snapshots = await alpaca.getSnapshots(watchlist);
    } catch {
      return;
    }

    const alerts = [];
    for (const snap of snapshots) {
      const prev = this._lastPrices.get(snap.ticker);
      const now = { price: snap.price, timestamp: Date.now() };

      if (prev && prev.price > 0) {
        const movePct = ((snap.price - prev.price) / prev.price) * 100;
        const elapsed = (now.timestamp - prev.timestamp) / 60000; // minutes

        // Flag moves > 0.5% in under 5 min, or > 1% since last check
        if (Math.abs(movePct) > 0.5 && elapsed < 5) {
          alerts.push({ ticker: snap.ticker, movePct, elapsed, price: snap.price, type: 'rapid' });
        } else if (Math.abs(movePct) > 1.0) {
          alerts.push({ ticker: snap.ticker, movePct, elapsed, price: snap.price, type: 'significant' });
        }
      }

      this._lastPrices.set(snap.ticker, now);
    }

    if (alerts.length === 0) return;

    // Pick the most significant move
    alerts.sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct));
    const top = alerts[0];

    const direction = top.movePct > 0 ? 'up' : 'down';
    const emoji = top.movePct > 0 ? '📈' : '📉';

    this._addJournalEntry('observation', `Detected ${top.ticker} ${direction} ${Math.abs(top.movePct).toFixed(2)}% to $${top.price.toFixed(2)} (${top.type} move)`);

    // If it's an options-tradeable underlying and move is big, trigger investigation
    const optionsUnderlyings = ctx.cfg.options_underlyings || ['SPY', 'QQQ'];
    if (optionsUnderlyings.includes(top.ticker) && Math.abs(top.movePct) > 0.7) {
      const optionsEngine = require('./options-engine');
      const fakeAlert = {
        action: top.movePct > 0 ? 'BUY' : 'SELL',
        ticker: top.ticker,
        reason: `Detected ${top.type} move: ${direction} ${Math.abs(top.movePct).toFixed(2)}% in ${top.elapsed.toFixed(0)} min`,
        confidence: Math.abs(top.movePct) > 1.5 ? 'HIGH' : 'MEDIUM',
      };
      optionsEngine.triggerFromAlert(fakeAlert).catch(() => {});
      this._addJournalEntry('action', `Triggered options analysis on ${top.ticker} due to ${top.type} ${direction} move`);
    }

    // Post to Discord if significant
    if (this._postToChannel && Math.abs(top.movePct) > 1.0) {
      const others = alerts.slice(1, 4).map(a => `${a.ticker} ${a.movePct > 0 ? '+' : ''}${a.movePct.toFixed(2)}%`).join(', ');
      await this._postToChannel(
        `${emoji} **Unusual Move Detected: ${top.ticker}** ${direction} **${Math.abs(top.movePct).toFixed(2)}%** → $${top.price.toFixed(2)}\n` +
        (others ? `Also moving: ${others}\n` : '') +
        `_Investigating for potential 0DTE opportunity..._`
      );
    }
  }

  // ── Action: Self-Tune Parameters ──────────────────────────────

  async _selfTuneParameters(ctx, tradeHistory) {
    const recent = tradeHistory.slice(-20);  // Last 20 trades
    if (recent.length < 5) return;

    const cfg = ctx.cfg;
    const changes = [];

    // Analyze win/loss patterns
    const wins = recent.filter(t => t.pnl > 0);
    const losses = recent.filter(t => t.pnl <= 0);
    const winRate = wins.length / recent.length;
    const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
    const avgLossPct = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length) : 0;

    // Separate by strategy
    const scalps = recent.filter(t => t.strategy === 'scalp');
    const swings = recent.filter(t => t.strategy === 'swing');

    // ── Scalp Take Profit Adjustment ──
    if (scalps.length >= 3) {
      const scalpWins = scalps.filter(t => t.pnl > 0);
      const scalpWinRate = scalpWins.length / scalps.length;
      const avgScalpGain = scalpWins.length > 0 ? scalpWins.reduce((s, t) => s + t.pnlPct, 0) / scalpWins.length : 0;

      // If scalps are hitting TP very quickly, we're leaving money on the table → widen
      if (scalpWinRate > 0.7 && avgScalpGain > cfg.options_scalp_take_profit_pct * 0.9) {
        const newTP = Math.min(cfg.options_scalp_take_profit_pct + 0.05, TUNING_BOUNDS.options_scalp_take_profit_pct.max);
        if (newTP !== cfg.options_scalp_take_profit_pct) {
          changes.push({ key: 'options_scalp_take_profit_pct', from: cfg.options_scalp_take_profit_pct, to: newTP, reason: `High scalp win rate (${(scalpWinRate * 100).toFixed(0)}%) — widening TP to capture more upside` });
        }
      }

      // If scalps are losing too much, tighten stop loss
      const scalpLosses = scalps.filter(t => t.pnl <= 0);
      if (scalpLosses.length >= 2 && scalpWinRate < 0.4) {
        const newSL = Math.max(cfg.options_scalp_stop_loss_pct - 0.05, TUNING_BOUNDS.options_scalp_stop_loss_pct.min);
        if (newSL !== cfg.options_scalp_stop_loss_pct) {
          changes.push({ key: 'options_scalp_stop_loss_pct', from: cfg.options_scalp_stop_loss_pct, to: newSL, reason: `Low scalp win rate (${(scalpWinRate * 100).toFixed(0)}%) — tightening SL to limit losses` });
        }
      }
    }

    // ── Swing TP/SL Adjustment ──
    if (swings.length >= 3) {
      const swingWins = swings.filter(t => t.pnl > 0);
      const swingWinRate = swingWins.length / swings.length;

      if (swingWinRate > 0.65) {
        const newTP = Math.min(cfg.options_swing_take_profit_pct + 0.10, TUNING_BOUNDS.options_swing_take_profit_pct.max);
        if (newTP !== cfg.options_swing_take_profit_pct) {
          changes.push({ key: 'options_swing_take_profit_pct', from: cfg.options_swing_take_profit_pct, to: newTP, reason: `Swing win rate ${(swingWinRate * 100).toFixed(0)}% — expanding target` });
        }
      }

      if (swingWinRate < 0.35) {
        const newSL = Math.max(cfg.options_swing_stop_loss_pct - 0.05, TUNING_BOUNDS.options_swing_stop_loss_pct.min);
        if (newSL !== cfg.options_swing_stop_loss_pct) {
          changes.push({ key: 'options_swing_stop_loss_pct', from: cfg.options_swing_stop_loss_pct, to: newSL, reason: `Low swing win rate (${(swingWinRate * 100).toFixed(0)}%) — tighter stops` });
        }
      }
    }

    // ── Conviction Threshold Tuning ──
    // If win rate is high, we might be too selective → lower threshold
    if (winRate > 0.65 && recent.length >= 8) {
      const newConv = Math.max(cfg.options_min_conviction - 1, TUNING_BOUNDS.options_min_conviction.min);
      if (newConv !== cfg.options_min_conviction) {
        changes.push({ key: 'options_min_conviction', from: cfg.options_min_conviction, to: newConv, reason: `Win rate ${(winRate * 100).toFixed(0)}% across ${recent.length} trades — lowering threshold to find more setups` });
      }
    }
    // If win rate is low, raise threshold
    if (winRate < 0.35 && recent.length >= 8) {
      const newConv = Math.min(cfg.options_min_conviction + 1, TUNING_BOUNDS.options_min_conviction.max);
      if (newConv !== cfg.options_min_conviction) {
        changes.push({ key: 'options_min_conviction', from: cfg.options_min_conviction, to: newConv, reason: `Win rate only ${(winRate * 100).toFixed(0)}% — raising bar to be more selective` });
      }
    }

    // ── Premium Sizing ──
    if (winRate > 0.6 && avgWinPct > avgLossPct * 1.5) {
      const newPremium = Math.min(cfg.options_max_premium_per_trade + 100, TUNING_BOUNDS.options_max_premium_per_trade.max);
      if (newPremium !== cfg.options_max_premium_per_trade) {
        changes.push({ key: 'options_max_premium_per_trade', from: cfg.options_max_premium_per_trade, to: newPremium, reason: `Positive edge detected (WR ${(winRate * 100).toFixed(0)}%, avg W:L ${avgWinPct.toFixed(1)}:${avgLossPct.toFixed(1)}) — sizing up` });
      }
    }

    if (changes.length === 0) {
      this._addJournalEntry('self_tune', `Reviewed ${recent.length} trades — no parameter changes needed (WR: ${(winRate * 100).toFixed(0)}%, W:L ${avgWinPct.toFixed(1)}%:${avgLossPct.toFixed(1)}%)`);
      return;
    }

    // Apply changes
    for (const ch of changes) {
      policy.setConfigKey(ch.key, ch.to);
      auditLog.log('self_tune', `${ch.key}: ${ch.from} → ${ch.to} — ${ch.reason}`);
    }

    // Log the tuning
    const summary = changes.map(c => `\`${c.key}\`: ${c.from} → **${c.to}** — ${c.reason}`).join('\n');
    this._addJournalEntry('self_tune', `Self-tuned ${changes.length} parameter(s) based on ${recent.length} trades (WR: ${(winRate * 100).toFixed(0)}%)\n${summary}`);

    // Post to Discord (journal channel)
    await this.postToJournal(
      `🧠 **Self-Tuning Update**\n` +
      `Analyzed ${recent.length} recent trades (Win Rate: **${(winRate * 100).toFixed(0)}%**)\n\n` +
      changes.map(c => `• \`${c.key}\`: ${c.from} → **${c.to}**\n  _${c.reason}_`).join('\n') +
      `\n\n_All changes bounded by safety limits. Use /agent set to override._`
    );
  }

  // ── Action: React to Regime Change ─────────────────────────────

  async _reactToRegimeChange(ctx) {
    let macroRegime;
    try {
      macroRegime = await macro.getRegime();
    } catch {
      return;
    }

    const currentRegime = macroRegime.regime;
    if (this._lastRegime === currentRegime) return; // No change

    const previousRegime = this._lastRegime;
    this._lastRegime = currentRegime;

    if (!previousRegime) return; // First check, just store

    this._addJournalEntry('regime_change', `Macro regime shifted: ${previousRegime} → ${currentRegime} (score: ${macroRegime.score})`);

    // Adjust behavior based on new regime
    if (currentRegime === 'RISK_OFF' && previousRegime !== 'RISK_OFF') {
      this._addJournalEntry('action', 'Switching to defensive mode — will monitor exits only');
    } else if (currentRegime === 'RISK_ON' && previousRegime !== 'RISK_ON') {
      this._addJournalEntry('action', 'Risk-on detected — will be more aggressive with entries');
    }

    if (this._postToChannel) {
      const emoji = currentRegime === 'RISK_ON' ? '🟢' : currentRegime === 'RISK_OFF' ? '🔴' : '🟡';
      await this._postToChannel(
        `${emoji} **Macro Regime Change: ${previousRegime} → ${currentRegime}**\n` +
        `Score: \`${macroRegime.score}\`\n` +
        (currentRegime === 'RISK_OFF'
          ? `_Shifting to defensive mode — exit-only for options, tighter stops._`
          : currentRegime === 'RISK_ON'
            ? `_Shifting to aggressive mode — wider scans, lower conviction threshold._`
            : `_Maintaining cautious positioning._`)
      );
    }
  }

  // ── Action: Gamma Squeeze Sector Scan ──────────────────────────

  async _squeezeSectorScan(ctx) {
    if (!this._postToChannel) return;

    try {
      const sectorData = await gammaSqueeze.analyzeSectorGEX();
      if (sectorData.length === 0) return;

      // Check for any sectors in short gamma (squeeze risk)
      const shortGamma = sectorData.filter(s => s.regime === 'Short Gamma' && s.confidence > 0.3);
      if (shortGamma.length === 0) {
        this._addJournalEntry('sector_gex', `Sector GEX scan: no sectors in short gamma — ${sectorData.length} sectors analyzed`);
        return;
      }

      // Add short-gamma sectors to squeeze watchlist
      const currentWatch = gammaSqueeze.getWatchlist();
      for (const s of shortGamma) {
        if (!currentWatch.includes(s.ticker)) {
          currentWatch.push(s.ticker);
        }
      }
      gammaSqueeze.setWatchlist(currentWatch);

      // Post to Discord
      const formatted = gammaSqueeze.formatSectorGEXForDiscord(sectorData);
      await this._postToChannel(formatted);

      this._addJournalEntry('sector_gex', `Sector GEX scan: ${shortGamma.length} sectors in short gamma — ${shortGamma.map(s => s.ticker).join(', ')}`);
    } catch (err) {
      // Non-fatal
      if (!err.message?.includes('Too Many Requests')) {
        console.warn(`[Initiative] Sector GEX scan error: ${err.message}`);
      }
    }
  }

  // ── Action: Proactive Insight ──────────────────────────────────

  async _postProactiveInsight(ctx) {
    if (!this._postToChannel || !ctx.alpacaEnabled) return;

    // Check if there's something interesting to say
    const optionsEngine = require('./options-engine');
    const logs = optionsEngine.getLogs();
    const recentScans = logs.filter(l =>
      l.type === 'scan' &&
      Date.now() - new Date(l.timestamp).getTime() < 15 * 60 * 1000
    );

    if (recentScans.length === 0) return;

    // Find interesting patterns in recent scans
    const directions = recentScans.map(l => {
      const match = l.message.match(/direction=(\w+)/);
      return match ? match[1] : null;
    }).filter(Boolean);

    if (directions.length < 2) return;

    const bullish = directions.filter(d => d === 'bullish').length;
    const bearish = directions.filter(d => d === 'bearish').length;

    if (bullish === 0 && bearish === 0) return;

    // Only post if there's strong consensus
    const total = bullish + bearish;
    const consensus = Math.max(bullish, bearish) / total;
    if (consensus < 0.7 || total < 3) return;

    const bias = bullish > bearish ? 'bullish' : 'bearish';
    const emoji = bias === 'bullish' ? '📈' : '📉';

    await this._postToChannel(
      `${emoji} **Market Insight** (unprompted)\n` +
      `My recent scans are showing **${(consensus * 100).toFixed(0)}%** ${bias} bias across options underlyings.\n` +
      `Bullish signals: ${bullish} | Bearish signals: ${bearish}\n` +
      `_This informs my 0DTE entry bias but doesn't guarantee trades._`
    );

    this._addJournalEntry('insight', `Market showing ${(consensus * 100).toFixed(0)}% ${bias} bias (bull: ${bullish}, bear: ${bearish})`);
  }

  // ── Action: Update Channel Topic ──────────────────────────────

  async _updateChannelTopic(ctx) {
    if (!this._client) return;

    const guild = this._client.guilds.cache.first();
    if (!guild) return;

    const channel = guild.channels.cache.find(
      ch => ch.name === config.tradingChannelName && ch.isTextBased()
    );
    if (!channel || !channel.manageable) return;

    // Build topic from current state
    let macroLabel = 'N/A';
    try {
      const regime = await macro.getRegime();
      macroLabel = `${regime.regime} (${regime.score})`;
    } catch {}

    const optionsEngine = require('./options-engine');
    const status = await optionsEngine.getStatus().catch(() => null);

    const parts = [
      `Macro: ${macroLabel}`,
      status ? `Options: ${status.activePositions}/${status.maxPositions} pos` : null,
      status ? `Daily P/L: $${status.dailyLoss?.toFixed(0) || '0'}` : null,
      `Mode: ${alpaca.isPaper ? 'Paper' : 'LIVE'}`,
      `Updated: ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })} ET`,
    ].filter(Boolean).join(' | ');

    try {
      await channel.setTopic(parts);
    } catch (err) {
      // Missing permissions is fine, don't spam logs
      if (!err.message?.includes('Missing Permissions')) {
        console.warn(`[Initiative] Failed to update topic: ${err.message}`);
      }
    }
  }

  // ── Action: Write Journal Entry ────────────────────────────────

  async _writeJournalEntry(ctx) {
    const optionsEngine = require('./options-engine');
    const cbStatus = circuitBreaker.getStatus();
    const logs = optionsEngine.getLogs();

    // Summarize today's activity
    const today = new Date().toISOString().slice(0, 10);
    const todayLogs = logs.filter(l => l.timestamp?.startsWith(today));
    const trades = todayLogs.filter(l => l.type === 'trade');
    const skips = todayLogs.filter(l => l.type === 'scan' && l.message.includes('SKIP'));
    const errors = todayLogs.filter(l => l.type === 'error');

    const entry = {
      date: today,
      timestamp: new Date().toISOString(),
      type: 'daily_journal',
      summary: {
        trades: trades.length,
        skips: skips.length,
        errors: errors.length,
        circuitBreakerTrips: cbStatus.totalTrips,
        config: policy.getConfig(),
      },
      reflection: null,
    };

    // Ask AI for a brief reflection
    try {
      const prompt = [
        selfAwareness.buildCompactSelfKnowledge(),
        `You are reviewing your own day as an autonomous trading bot. Write a 2-3 sentence honest self-reflection.`,
        `Today's stats: ${trades.length} trades, ${skips.length} skips, ${errors.length} errors.`,
        `Circuit breaker trips: ${cbStatus.totalTrips}. Consecutive bad trades: ${cbStatus.consecutiveBadTrades}.`,
        `Recent trade log: ${trades.slice(-5).map(t => t.message).join(' | ')}`,
        `What went well? What should you change tomorrow? Be specific and actionable.`,
      ].join('\n');

      const reflection = await ai.complete(prompt);
      if (reflection) {
        entry.reflection = reflection.slice(0, 500);
      }
    } catch {}

    this._addJournalEntry('daily_journal', JSON.stringify(entry, null, 2));

    // Post to journal channel
    await this.postToJournal(
      `📓 **Daily Journal — ${today}**\n` +
      `Trades: \`${trades.length}\` | Skipped: \`${skips.length}\` | Errors: \`${errors.length}\`\n` +
      `Circuit breaker trips: \`${cbStatus.totalTrips}\`\n` +
      (entry.reflection ? `\n> _${entry.reflection}_` : '') +
      `\n_End of day reflection. Trading resumes tomorrow._`
    );
  }

  // ── Action: Expand Watchlist ───────────────────────────────────

  async _expandWatchlist(ctx) {
    if (!ctx.alpacaEnabled) return;

    // Get current options underlyings
    const current = new Set(ctx.cfg.options_underlyings || ['SPY', 'QQQ']);

    // Candidates to consider — popular 0DTE-eligible tickers
    const candidates = ['AAPL', 'TSLA', 'NVDA', 'AMD', 'META', 'AMZN', 'MSFT', 'GOOGL', 'NFLX', 'COIN', 'IWM'];
    const newCandidates = candidates.filter(t => !current.has(t));

    if (newCandidates.length === 0) return;

    // Check each for unusual volume or momentum
    let snapshots;
    try {
      snapshots = await alpaca.getSnapshots(newCandidates);
    } catch { return; }

    for (const snap of snapshots) {
      if (!snap.price || !snap.changePercent) continue;

      // Only add if showing strong move (>2%) — indicates opportunity
      if (Math.abs(snap.changePercent) > 2.0) {
        // Add to watchlist temporarily for this session
        const underlyings = ctx.cfg.options_underlyings || ['SPY', 'QQQ'];
        if (!underlyings.includes(snap.ticker)) {
          underlyings.push(snap.ticker);
          policy.setConfigKey('options_underlyings', underlyings.join(','));

          this._addJournalEntry('watchlist', `Added ${snap.ticker} to options watchlist — ${snap.changePercent > 0 ? '+' : ''}${snap.changePercent.toFixed(1)}% move detected`);

          if (this._postToChannel) {
            await this._postToChannel(
              `🔍 **Watchlist Expanded: ${snap.ticker}**\n` +
              `Detected **${snap.changePercent > 0 ? '+' : ''}${snap.changePercent.toFixed(1)}%** move to $${snap.price.toFixed(2)}\n` +
              `_Added to 0DTE scan rotation. Will analyze on next cycle._`
            );
          }

          break; // Only add one per scan
        }
      }
    }
  }

  // ── Discord Server Management ──────────────────────────────────

  /**
   * Ensure the bot's journal channel exists. Creates it if missing.
   * @returns {import('discord.js').TextChannel|null}
   */
  async ensureJournalChannel() {
    if (!this._client) return null;

    const guild = this._client.guilds.cache.first();
    if (!guild) return null;

    const channelName = 'bot-journal';
    let channel = guild.channels.cache.find(
      ch => ch.name === channelName && ch.isTextBased()
    );

    if (!channel) {
      try {
        const { ChannelType } = require('discord.js');
        channel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          topic: 'Autonomous trading journal — decisions, reflections, and self-tuning logs',
          reason: 'Created by Initiative Engine for autonomous journaling',
        });
        console.log(`[Initiative] Created #${channelName} channel`);
        auditLog.log('initiative', `Created Discord channel: #${channelName}`);
      } catch (err) {
        // Missing permissions — that's fine
        console.warn(`[Initiative] Cannot create #${channelName}: ${err.message}`);
        return null;
      }
    }

    return channel;
  }

  /**
   * Create a discussion thread for an active trade.
   * @param {string} title
   * @param {string} content
   */
  async createTradeThread(title, content) {
    if (!this._client) return null;

    const guild = this._client.guilds.cache.first();
    if (!guild) return null;

    const channel = guild.channels.cache.find(
      ch => ch.name === config.tradingChannelName && ch.isTextBased()
    );
    if (!channel) return null;

    try {
      const msg = await channel.send(content);
      const thread = await msg.startThread({
        name: title.slice(0, 100),
        autoArchiveDuration: 60,
      });
      this._addJournalEntry('thread', `Created trade thread: ${title}`);
      return thread;
    } catch (err) {
      console.warn(`[Initiative] Thread creation failed: ${err.message}`);
      return null;
    }
  }

  // ── Journal & Learning ──────────────────────────────────────────

  _addJournalEntry(type, content) {
    const entries = this._journal.get('entries', []);
    entries.push({
      type,
      content,
      timestamp: new Date().toISOString(),
    });
    // Keep last 500 entries
    if (entries.length > 500) {
      entries.splice(0, entries.length - 500);
    }
    this._journal.set('entries', entries);
  }

  getJournal(limit = 20) {
    const entries = this._journal.get('entries', []);
    return entries.slice(-limit);
  }

  _getTradeHistory() {
    // Pull from circuit breaker's recent exits + any other trade records
    const cbStatus = circuitBreaker.getStatus();
    return (cbStatus.recentExits || []).map(exit => ({
      symbol: exit.symbol,
      reason: exit.reason,
      pnl: exit.pnlPct > 0 ? 1 : -1,  // simplified
      pnlPct: exit.pnlPct || 0,
      strategy: exit.reason === 'take_profit' ? 'scalp' : 'scalp', // approximate
      timestamp: exit.timestamp,
    }));
  }

  // ── Cooldown Management ─────────────────────────────────────────

  _isOnCooldown(actionId) {
    const last = this._lastActions.get(actionId);
    if (!last) return false;
    const cooldown = ACTION_COOLDOWNS[actionId] || 60000;
    return (Date.now() - last) < cooldown;
  }

  _recordAction(actionId) {
    this._lastActions.set(actionId, Date.now());
    // Persist
    const obj = {};
    for (const [k, v] of this._lastActions) obj[k] = v;
    this._storage.set('lastActions', obj);
  }

  // ── Time Helper ─────────────────────────────────────────────────

  _getETTime() {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return {
      hour: et.getHours(),
      minute: et.getMinutes(),
      day: et.getDay(),
    };
  }

  // ── Status ──────────────────────────────────────────────────────

  getStatus() {
    return {
      running: !!this._interval,
      lastActions: Object.fromEntries(this._lastActions),
      journalEntries: this._journal.get('entries', []).length,
      watchedPrices: this._lastPrices.size,
      lastRegime: this._lastRegime,
    };
  }
}

module.exports = new InitiativeEngine();
