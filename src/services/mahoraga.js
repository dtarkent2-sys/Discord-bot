/**
 * MAHORAGA — Autonomous Trading Engine
 *
 * Runs directly inside the Discord bot on Railway.
 * Core loop: Signal Ingestion → Technical Analysis → LLM Decision → Trade Execution
 *
 * Data sources:
 *   - StockTwits (social sentiment / trending)
 *   - Alpaca (market data + trade execution)
 *   - Technicals engine (RSI, MACD, Bollinger, etc.)
 *
 * Risk management via policy.js (kill switch, position limits, stop losses, etc.)
 *
 * Based on https://github.com/ygwyg/MAHORAGA (MIT license)
 */

const alpaca = require('./alpaca');
const stocktwits = require('./stocktwits');
const technicals = require('./technicals');
const policy = require('./policy');
const ai = require('./ai');
const config = require('../config');

class MahoragaEngine {
  constructor() {
    this._enabled = false;
    this._logs = [];       // recent activity log (ring buffer, max 100)
    this._postToChannel = null; // set by autonomous.js to post Discord alerts
  }

  get enabled() {
    return this._enabled && alpaca.enabled;
  }

  /** Called by autonomous.js to wire up the Discord posting callback */
  setChannelPoster(fn) {
    this._postToChannel = fn;
  }

  // ── Enable / Disable / Kill ───────────────────────────────────────

  enable() {
    if (!alpaca.enabled) throw new Error('Cannot enable: ALPACA_API_KEY not configured');
    this._enabled = true;
    this._log('agent', 'MAHORAGA agent ENABLED');
    console.log('[MAHORAGA] Agent enabled');
  }

  disable() {
    this._enabled = false;
    this._log('agent', 'MAHORAGA agent DISABLED');
    console.log('[MAHORAGA] Agent disabled');
  }

  async kill() {
    this._enabled = false;
    policy.activateKillSwitch();
    this._log('kill', 'EMERGENCY KILL SWITCH — closing all positions');
    console.log('[MAHORAGA] KILL SWITCH ACTIVATED');

    try {
      await alpaca.cancelAllOrders();
      await alpaca.closeAllPositions();
      this._log('kill', 'All orders cancelled and positions closed');
    } catch (err) {
      this._log('error', `Kill switch error: ${err.message}`);
    }
  }

  // ── Status / Config / Logs ────────────────────────────────────────

  async getStatus() {
    const status = { agent_enabled: this._enabled, paper: alpaca.isPaper };

    try {
      status.account = await alpaca.getAccount();
    } catch (err) {
      status.account_error = err.message;
    }

    try {
      status.positions = await alpaca.getPositions();
    } catch (err) {
      status.positions = [];
    }

    try {
      status.clock = await alpaca.getClock();
    } catch { /* ignore */ }

    status.risk = {
      kill_switch: policy.killSwitch,
      daily_pnl: policy.dailyPnL,
      daily_start_equity: policy.dailyStartEquity,
    };

    status.config = policy.getConfig();
    return status;
  }

  getConfig() { return policy.getConfig(); }
  updateConfig(updates) { policy.updateConfig(updates); }
  getLogs() { return [...this._logs]; }

  // ── Logging ───────────────────────────────────────────────────────

  _log(type, message) {
    const entry = { type, message, timestamp: new Date().toISOString() };
    this._logs.push(entry);
    if (this._logs.length > 100) this._logs.shift();
    return entry;
  }

  // ── Core Trading Loop (called on schedule) ────────────────────────

  /**
   * Main autonomous cycle. Called every 5 min during market hours.
   *
   * 1. Check account + reset daily P/L
   * 2. Monitor existing positions (stop loss / take profit)
   * 3. Scan for new signals (StockTwits trending → technicals → LLM)
   * 4. Execute approved trades
   */
  async runCycle() {
    if (!this.enabled) return;

    try {
      // ── 1. Account check + daily reset ──
      const account = await alpaca.getAccount();
      const equity = Number(account.equity || 0);
      policy.resetDaily(equity);
      policy.updateDailyPnL(equity);

      // Check clock
      const clock = await alpaca.getClock();
      if (!clock.is_open) {
        return; // market closed
      }

      // ── 2. Monitor existing positions ──
      await this._checkPositions();

      // ── 3. Scan for new signals ──
      await this._scanSignals(account);

    } catch (err) {
      console.error('[MAHORAGA] Cycle error:', err.message);
      this._log('error', `Cycle error: ${err.message}`);
    }
  }

  // ── Position Monitoring ───────────────────────────────────────────

  async _checkPositions() {
    try {
      const positions = await alpaca.getPositions();
      if (positions.length === 0) return;

      const exits = policy.checkExits(positions);

      for (const exit of exits) {
        try {
          await alpaca.closePosition(exit.symbol);
          this._log('trade', `CLOSE ${exit.symbol}: ${exit.message}`);
          console.log(`[MAHORAGA] ${exit.message}`);

          if (this._postToChannel) {
            const emoji = exit.reason === 'take_profit' ? '🟢' : '🔴';
            await this._postToChannel(
              `${emoji} **MAHORAGA Auto-Exit: ${exit.symbol}**\n${exit.message}\n_Position closed automatically._`
            );
          }
        } catch (err) {
          this._log('error', `Failed to close ${exit.symbol}: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn('[MAHORAGA] Position check error:', err.message);
    }
  }

  // ── Signal Scanning ───────────────────────────────────────────────

  async _scanSignals(account) {
    try {
      // Get trending tickers from StockTwits
      const trending = await stocktwits.getTrending();
      if (!trending || trending.length === 0) return;

      // Pick top 5 trending symbols to evaluate
      const candidates = trending.slice(0, 5).map(t => t.symbol);
      const positions = await alpaca.getPositions();
      const positionSymbols = new Set(positions.map(p => p.symbol));

      for (const symbol of candidates) {
        // Skip if we already hold this
        if (positionSymbols.has(symbol)) continue;

        try {
          await this._evaluateSignal(symbol, account, positions.length);
        } catch (err) {
          // Don't log every failed eval — many will fail (e.g. no data for penny stocks)
          if (!err.message?.includes('Not enough') && !err.message?.includes('No data')) {
            console.warn(`[MAHORAGA] Eval error for ${symbol}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.warn('[MAHORAGA] Signal scan error:', err.message);
    }
  }

  // ── Evaluate a Single Signal ──────────────────────────────────────

  async _evaluateSignal(symbol, account, currentPositions) {
    // 1. Get social sentiment
    const sentiment = await stocktwits.analyzeSymbol(symbol);

    // Quick filter: skip if sentiment is too weak
    if (Math.abs(sentiment.score) < policy.getConfig().min_sentiment_score) return;

    // 2. Get technical analysis
    let techResult;
    try {
      techResult = await technicals.analyze(symbol);
    } catch {
      return; // skip if we can't get technical data
    }

    const { technicals: tech, signals } = techResult;
    if (!tech || !tech.price) return;

    // 3. Score the signals
    const bullishScore = signals
      .filter(s => s.direction === 'bullish')
      .reduce((a, s) => a + s.strength, 0);
    const bearishScore = signals
      .filter(s => s.direction === 'bearish')
      .reduce((a, s) => a + s.strength, 0);
    const netSignal = bullishScore - bearishScore;

    // Skip if signals are mixed / weak
    if (netSignal < 0.5) return;

    // 4. Ask AI for a decision
    const decision = await this._askAI(symbol, sentiment, tech, signals, netSignal);
    if (!decision || decision.action !== 'buy') return;

    // 5. Pre-trade risk check
    const notional = Math.min(
      policy.getConfig().max_notional_per_trade,
      Number(account.buying_power || 0) * 0.1 // max 10% of buying power per trade
    );

    if (notional < 100) return; // don't bother with tiny orders

    const riskCheck = policy.evaluate({
      symbol,
      side: 'buy',
      notional,
      currentPositions,
      currentEquity: Number(account.equity || 0),
      buyingPower: Number(account.buying_power || 0),
      sentimentScore: sentiment.score,
      confidence: decision.confidence || 0,
    });

    if (!riskCheck.allowed) {
      this._log('blocked', `${symbol}: ${riskCheck.violations.join('; ')}`);
      return;
    }

    // 6. Execute the trade
    try {
      const order = await alpaca.createOrder({
        symbol,
        notional: notional.toFixed(2),
        side: 'buy',
        type: 'market',
        time_in_force: 'day',
      });

      policy.recordTrade(symbol);
      this._log('trade', `BUY ${symbol} — $${notional.toFixed(0)} (confidence: ${((decision.confidence || 0) * 100).toFixed(0)}%)`);
      console.log(`[MAHORAGA] BUY ${symbol} — $${notional.toFixed(0)}`);

      // Alert Discord
      if (this._postToChannel) {
        const warnings = riskCheck.warnings.length > 0
          ? `\n⚠️ ${riskCheck.warnings.join('\n⚠️ ')}`
          : '';
        await this._postToChannel(
          `💰 **MAHORAGA Trade: BUY ${symbol}**\n` +
          `Amount: \`$${notional.toFixed(0)}\` | Confidence: \`${((decision.confidence || 0) * 100).toFixed(0)}%\`\n` +
          `Sentiment: \`${sentiment.label} (${(sentiment.score * 100).toFixed(0)}%)\`\n` +
          `Signals: ${signals.filter(s => s.direction === 'bullish').map(s => s.description).join(', ') || 'none'}\n` +
          `Reason: ${decision.reason || 'AI recommendation'}` +
          warnings +
          `\n_${alpaca.isPaper ? 'Paper trade' : 'LIVE trade'} | Not financial advice_`
        );
      }
    } catch (err) {
      this._log('error', `Order failed for ${symbol}: ${err.message}`);
      console.error(`[MAHORAGA] Order failed for ${symbol}:`, err.message);
    }
  }

  // ── AI Decision ───────────────────────────────────────────────────

  async _askAI(symbol, sentiment, tech, signals, netSignal) {
    const prompt = [
      `You are an autonomous trading analyst. Evaluate this signal and decide whether to BUY or PASS.`,
      ``,
      `Symbol: ${symbol}`,
      `Price: $${tech.price?.toFixed(2)}`,
      ``,
      `Social Sentiment (StockTwits):`,
      `  Score: ${(sentiment.score * 100).toFixed(0)}% | ${sentiment.bullish} bullish / ${sentiment.bearish} bearish / ${sentiment.neutral} neutral (${sentiment.messages} posts)`,
      ``,
      `Technical Indicators:`,
      tech.rsi_14 !== null ? `  RSI(14): ${tech.rsi_14.toFixed(1)}` : null,
      tech.macd ? `  MACD: ${tech.macd.macd.toFixed(3)} | Signal: ${tech.macd.signal.toFixed(3)} | Histogram: ${tech.macd.histogram.toFixed(3)}` : null,
      tech.bollinger ? `  Bollinger: $${tech.bollinger.lower.toFixed(2)} — $${tech.bollinger.middle.toFixed(2)} — $${tech.bollinger.upper.toFixed(2)}` : null,
      tech.sma_20 !== null ? `  SMA(20): $${tech.sma_20.toFixed(2)} | SMA(50): $${tech.sma_50?.toFixed(2) ?? '—'} | SMA(200): $${tech.sma_200?.toFixed(2) ?? '—'}` : null,
      tech.atr_14 !== null ? `  ATR(14): $${tech.atr_14.toFixed(2)}` : null,
      tech.relative_volume !== null ? `  Volume: ${tech.relative_volume.toFixed(1)}x average` : null,
      ``,
      `Detected Signals:`,
      ...signals.map(s => `  [${s.direction.toUpperCase()}] ${s.description} (strength: ${(s.strength * 100).toFixed(0)}%)`),
      `  Net bullish score: ${netSignal.toFixed(2)}`,
      ``,
      `Respond with ONLY valid JSON: {"action": "buy" or "pass", "confidence": 0.0-1.0, "reason": "brief explanation"}`,
    ].filter(Boolean).join('\n');

    try {
      const response = await ai.complete(prompt);
      if (!response) return null;

      // Parse JSON from response
      const jsonMatch = response.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        action: parsed.action?.toLowerCase() || 'pass',
        confidence: Number(parsed.confidence) || 0,
        reason: parsed.reason || '',
      };
    } catch (err) {
      console.warn(`[MAHORAGA] AI decision error for ${symbol}: ${err.message}`);
      return null;
    }
  }

  // ── Discord Formatting ────────────────────────────────────────────

  formatStatusForDiscord(status) {
    if (!status) return '_Could not fetch agent status._';

    const lines = [
      `**MAHORAGA — Autonomous Trading Agent**`,
      `Mode: ${status.paper ? '📄 Paper Trading' : '💵 LIVE Trading'}`,
      `Agent: ${status.agent_enabled ? '🟢 **ENABLED**' : '🔴 **DISABLED**'}`,
      ``,
    ];

    if (status.account) {
      const a = status.account;
      lines.push(`**Account**`);
      lines.push(`Portfolio: \`$${Number(a.portfolio_value || a.equity || 0).toLocaleString()}\``);
      lines.push(`Buying Power: \`$${Number(a.buying_power || 0).toLocaleString()}\``);
      lines.push(`Cash: \`$${Number(a.cash || 0).toLocaleString()}\``);
      lines.push(`Day Trades: \`${a.daytrade_count || 0}\``);
      lines.push(``);
    }

    if (status.positions && status.positions.length > 0) {
      lines.push(`**Open Positions** (${status.positions.length})`);
      for (const p of status.positions.slice(0, 10)) {
        const pnl = Number(p.unrealized_pl || 0);
        const pnlPct = Number(p.unrealized_plpc || 0) * 100;
        const emoji = pnl >= 0 ? '🟢' : '🔴';
        lines.push(`${emoji} **${p.symbol}**: ${p.qty} shares @ $${Number(p.avg_entry_price || 0).toFixed(2)} | P/L: $${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`);
      }
      if (status.positions.length > 10) lines.push(`_...and ${status.positions.length - 10} more_`);
      lines.push(``);
    } else {
      lines.push(`_No open positions_`);
      lines.push(``);
    }

    if (status.risk) {
      lines.push(`**Risk**`);
      lines.push(`Kill Switch: ${status.risk.kill_switch ? '🛑 **ACTIVE**' : '🟢 OK'}`);
      if (status.risk.daily_start_equity > 0) {
        const dailyPct = (status.risk.daily_pnl / status.risk.daily_start_equity) * 100;
        lines.push(`Daily P/L: \`$${status.risk.daily_pnl.toFixed(2)}\` (${dailyPct.toFixed(2)}%)`);
      }
    }

    if (status.clock) {
      lines.push(``);
      lines.push(`Market: ${status.clock.is_open ? '🟢 Open' : '🔴 Closed'}`);
    }

    return lines.join('\n');
  }

  formatConfigForDiscord(cfg) {
    if (!cfg) return '_Could not fetch config._';

    const lines = [`**MAHORAGA Configuration**`, ``];
    const keys = [
      ['max_positions', 'Max Positions'],
      ['max_notional_per_trade', 'Max $ Per Trade'],
      ['max_daily_loss_pct', 'Max Daily Loss'],
      ['stop_loss_pct', 'Stop Loss'],
      ['take_profit_pct', 'Take Profit'],
      ['cooldown_minutes', 'Trade Cooldown (min)'],
      ['min_sentiment_score', 'Min Sentiment'],
      ['min_analyst_confidence', 'Min AI Confidence'],
      ['allow_shorting', 'Allow Shorting'],
    ];

    for (const [key, label] of keys) {
      if (cfg[key] !== undefined) {
        let val = cfg[key];
        if (typeof val === 'number' && key.includes('pct')) val = `${(val * 100).toFixed(1)}%`;
        else if (typeof val === 'number' && key.includes('notional')) val = `$${Number(val).toLocaleString()}`;
        lines.push(`**${label}:** \`${val}\``);
      }
    }

    lines.push(``);
    lines.push(`Kill Switch: ${cfg.killSwitch ? '🛑 **ACTIVE**' : '🟢 OK'}`);
    return lines.join('\n');
  }

  formatLogsForDiscord(logs) {
    if (!logs || logs.length === 0) return '_No recent agent activity._';

    const lines = [`**MAHORAGA Recent Activity**`, ``];
    for (const log of logs.slice(-15).reverse()) {
      const time = new Date(log.timestamp).toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
      const emoji = log.type === 'trade' ? '💰' : log.type === 'blocked' ? '🚫' : log.type === 'kill' ? '🛑' : log.type === 'error' ? '❌' : '📋';
      lines.push(`\`${time}\` ${emoji} ${log.message}`);
    }
    return lines.join('\n');
  }
}

module.exports = new MahoragaEngine();
