/**
 * SHARK — Autonomous Trading Engine
 *
 * Runs directly inside the Discord bot on Railway.
 * Druckenmiller top-down framework:
 *   "50% of a stock's move is the overall market, 30% is the industry, 20% is stock picking."
 *
 * Pipeline: Macro Regime → Sector Rotation → Signal Scan → Fundamentals → Technicals → AI Decision → Trade
 *
 * Data sources:
 *   - Macro engine (SPY trend, sector breadth, risk regime)
 *   - Sector rotation (11 SPDR ETFs, multi-timeframe relative strength)
 *   - StockTwits (social sentiment / trending)
 *   - Reddit (r/wallstreetbets, r/stocks, r/investing, r/options)
 *   - Validea (guru fundamental analysis — Buffett, Lynch, Graham, etc.)
 *   - Alpaca (market data + trade execution)
 *   - Technicals engine (RSI, MACD, Bollinger, etc.)
 *
 * Signal cache: persistent cache to avoid re-evaluating same tickers
 * Order flow: two-step preview → approval token → submit (MAHORAGA reference)
 * Risk management via policy.js (kill switch, position limits, stop losses, etc.)
 *
 * Based on https://github.com/ygwyg/SHARK (MIT license)
 */

const alpaca = require('./alpaca');
const stocktwits = require('./stocktwits');
const reddit = require('./reddit');
const technicals = require('./technicals');
const validea = require('./validea');
const macro = require('./macro');
const sectors = require('./sectors');
const policy = require('./policy');
const signalCache = require('./signal-cache');
const ai = require('./ai');
const config = require('../config');
const Storage = require('./storage');
const auditLog = require('./audit-log');
const circuitBreaker = require('./circuit-breaker');
const optionsEngine = require('./options-engine');

// Max ticker evaluations per scan cycle (prevents runaway loops)
const MAX_EVALS_PER_CYCLE = 8;

class SharkEngine {
  constructor() {
    this._storage = new Storage('shark-state.json');
    this._logs = [];       // recent activity log (ring buffer, max 100)
    this._postToChannel = null; // set by autonomous.js to post Discord alerts

    // Resolve enabled state: env var wins over file persistence
    // (Railway wipes the filesystem on each deploy, so SHARK_AUTO_ENABLE env var
    //  ensures the agent stays enabled across deploys without manual /agent enable)
    const savedEnabled = this._storage.get('enabled', false);
    if (config.sharkAutoEnable) {
      this._enabled = true;
      console.log('[SHARK] Auto-enabled via SHARK_AUTO_ENABLE env var');
    } else if (savedEnabled) {
      this._enabled = true;
      console.log('[SHARK] Restored enabled state from previous session');
    } else {
      this._enabled = false;
    }
  }

  get enabled() {
    return this._enabled && alpaca.enabled;
  }

  /** Called by autonomous.js to wire up the Discord posting callback */
  setChannelPoster(fn) {
    this._postToChannel = fn;
    // Also wire the options engine
    optionsEngine.setChannelPoster(fn);
  }

  // ── Enable / Disable / Kill ───────────────────────────────────────

  enable() {
    if (!alpaca.enabled) throw new Error('Cannot enable: ALPACA_API_KEY not configured');
    this._enabled = true;
    this._storage.set('enabled', true);
    this._log('agent', 'SHARK agent ENABLED');
    console.log('[SHARK] Agent enabled');
  }

  disable() {
    this._enabled = false;
    this._storage.set('enabled', false);
    this._log('agent', 'SHARK agent DISABLED');
    console.log('[SHARK] Agent disabled');
  }

  async kill() {
    this._enabled = false;
    this._storage.set('enabled', false);
    policy.activateKillSwitch();
    this._log('kill', 'EMERGENCY KILL SWITCH — closing all positions');
    console.log('[SHARK] KILL SWITCH ACTIVATED');

    // Collect post-mortem state before closing positions
    let postMortemState = {
      killSwitch: true,
      agent_enabled: false,
      circuitBreaker: circuitBreaker.getStatus(),
    };

    try {
      postMortemState.account = await alpaca.getAccount();
    } catch (err) {
      postMortemState.account_error = err.message;
    }

    try {
      postMortemState.positions = await alpaca.getPositions();
    } catch (err) {
      postMortemState.positions_error = err.message;
    }

    try {
      await alpaca.cancelAllOrders();
      await alpaca.closeAllPositions();
      this._log('kill', 'All orders cancelled and positions closed');
    } catch (err) {
      this._log('error', `Kill switch error: ${err.message}`);
      postMortemState.closeError = err.message;
    }

    postMortemState.recentLogs = this._logs.slice(-50);
    const pmPath = auditLog.writePostMortem(postMortemState);
    this._log('kill', `Post-mortem written: ${pmPath}`);

    return pmPath;
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
    status.circuitBreaker = circuitBreaker.getStatus();

    // Include options engine status
    try {
      status.options = await optionsEngine.getStatus();
    } catch {
      status.options = { enabled: false, error: 'Options engine unavailable' };
    }

    return status;
  }

  getConfig() { return policy.getConfig(); }
  updateConfig(updates) { policy.updateConfig(updates); }
  getLogs() { return [...this._logs]; }

  // ── Logging ───────────────────────────────────────────────────────

  _log(type, message) {
    const entry = { type, message, timestamp: new Date().toISOString() };
    this._logs.push(entry);
    if (this._logs.length > 200) this._logs.shift();
    // Persist to audit log file
    auditLog.log(type, `[SHARK] ${message}`);
    return entry;
  }

  // ── Core Trading Loop (called on schedule) ────────────────────────

  /**
   * Main autonomous cycle — Druckenmiller top-down framework.
   *
   * 1. MACRO (50%) — Check market regime before doing anything
   * 2. Account check + daily P/L reset
   * 3. Monitor existing positions (stop loss / take profit)
   * 4. SECTOR (30%) — Identify leading sectors for stock selection
   * 5. STOCK PICKING (20%) — Scan candidates with full pipeline
   * 6. Execute approved trades with regime-adjusted sizing
   */
  async runCycle() {
    if (!this.enabled) return;

    // Circuit breaker: pause trading after consecutive bad outcomes
    if (circuitBreaker.isPaused()) {
      const remaining = circuitBreaker.remainingPauseMinutes();
      this._log('circuit_breaker', `Trading paused by circuit breaker — ${remaining} min remaining`);
      return;
    }

    try {
      // ── 1. MACRO CHECK (Druckenmiller: 50% of a stock's move) ──
      let macroRegime = { regime: 'CAUTIOUS', score: 0, positionMultiplier: 1.0, topSectors: [], bottomSectors: [] };
      try {
        macroRegime = await macro.getRegime();
        this._log('macro', `Market regime: ${macroRegime.regime} (score: ${macroRegime.score}, sizing: ${macroRegime.positionMultiplier}x)`);

        // In RISK_OFF, skip scanning for new positions entirely (just monitor exits)
        if (macroRegime.regime === 'RISK_OFF') {
          this._log('macro', 'RISK_OFF — skipping new position scan, monitoring exits only');
        }
      } catch (err) {
        this._log('macro', `Macro analysis unavailable: ${err.message}`);
      }

      // ── 2. Account check + daily reset ──
      const account = await alpaca.getAccount();
      const equity = Number(account.equity || 0);
      policy.resetDaily(equity);
      policy.updateDailyPnL(equity);

      // Check clock — but for paper trading, also allow extended hours
      const clock = await alpaca.getClock();
      if (!clock.is_open) {
        this._log('cycle', 'Market closed — skipping cycle');
        return;
      }

      this._log('cycle', `Cycle started — equity: $${equity.toFixed(0)}, buying power: $${Number(account.buying_power || 0).toFixed(0)}`);

      // ── 3. Monitor existing positions (always run, even in RISK_OFF) ──
      await this._checkPositions();

      // ── 4-5. Scan for new signals (skip if RISK_OFF macro) ──
      if (macroRegime.regime !== 'RISK_OFF') {
        await this._scanSignals(account, macroRegime);
      }

      // ── 6. Run 0DTE options cycle (if enabled) ──
      try {
        await optionsEngine.runCycle();
      } catch (err) {
        this._log('options', `Options cycle error: ${err.message}`);
      }

      // Cycle completed successfully — reset error counter
      circuitBreaker.recordSuccessfulCycle();

    } catch (err) {
      console.error('[SHARK] Cycle error:', err.message);
      this._log('error', `Cycle error: ${err.message}`);
      circuitBreaker.recordError(err.message);
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
          console.log(`[SHARK] ${exit.message}`);

          // Record exit in circuit breaker (tracks consecutive stop-losses)
          const cbResult = circuitBreaker.recordExit(exit.symbol, exit.reason, exit.pnlPct);

          if (this._postToChannel) {
            const emoji = exit.reason === 'take_profit' ? '🟢' : '🔴';
            let exitMsg = `${emoji} **SHARK Auto-Exit: ${exit.symbol}**\n${exit.message}\n_Position closed automatically._`;
            if (cbResult.tripped) {
              exitMsg += `\n\n🛑 **CIRCUIT BREAKER TRIPPED** — ${cbResult.message}`;
            }
            await this._postToChannel(exitMsg);
          }
        } catch (err) {
          this._log('error', `Failed to close ${exit.symbol}: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn('[SHARK] Position check error:', err.message);
    }
  }

  // ── Signal Scanning ───────────────────────────────────────────────

  async _scanSignals(account, macroRegime = {}) {
    try {
      // Get trending tickers from StockTwits + Reddit (dual social signal sources)
      const [stTrending, redditTrending] = await Promise.allSettled([
        stocktwits.getTrending(),
        reddit.getTrendingTickers(),
      ]);

      const stSymbols = (stTrending.status === 'fulfilled' && stTrending.value || []).slice(0, 5).map(t => t.symbol);
      const rdSymbols = (redditTrending.status === 'fulfilled' && redditTrending.value || []).slice(0, 5).map(t => t.symbol);

      // Merge and deduplicate — StockTwits first, then Reddit extras
      const seen = new Set();
      const candidates = [];
      for (const sym of [...stSymbols, ...rdSymbols]) {
        if (!seen.has(sym)) {
          seen.add(sym);
          candidates.push(sym);
        }
      }

      if (candidates.length === 0) {
        this._log('scan', 'No trending tickers from StockTwits or Reddit — nothing to scan');
        return;
      }

      const positions = await alpaca.getPositions();
      const positionSymbols = new Set(positions.map(p => p.symbol));

      this._log('scan', `Scanning ${candidates.length} candidates: ${candidates.join(', ')} (ST: ${stSymbols.length}, Reddit: ${rdSymbols.length}, ${positions.length} positions open)`);

      let evalCount = 0;
      for (const symbol of candidates) {
        // Per-cycle cap: prevent runaway evaluation loops
        if (evalCount >= MAX_EVALS_PER_CYCLE) {
          this._log('scan', `Cycle eval cap reached (${MAX_EVALS_PER_CYCLE}) — deferring remaining candidates`);
          break;
        }

        // Skip if we already hold this
        if (positionSymbols.has(symbol)) continue;

        // Check denylist/allowlist early
        const cfg = policy.getConfig();
        if (cfg.symbol_denylist.length > 0 && cfg.symbol_denylist.includes(symbol)) continue;
        if (cfg.symbol_allowlist.length > 0 && !cfg.symbol_allowlist.includes(symbol)) continue;

        evalCount++;
        try {
          await this._evaluateSignal(symbol, account, positions.length, macroRegime);
        } catch (err) {
          if (!err.message?.includes('Not enough') && !err.message?.includes('No data')) {
            this._log('scan', `${symbol}: eval error — ${err.message}`);
          }
        }
      }
    } catch (err) {
      this._log('error', `Signal scan error: ${err.message}`);
      console.warn('[SHARK] Signal scan error:', err.message);
    }
  }

  // ── Evaluate a Single Signal ──────────────────────────────────────

  async _evaluateSignal(symbol, account, currentPositions, macroRegime = {}) {
    const cfg = policy.getConfig();

    // ── SIGNAL CACHE CHECK — skip if recently evaluated ──
    const cached = signalCache.get(symbol);
    if (cached.cached) {
      this._log('cache', `${symbol}: cached ${cached.signal.decision} (${Math.round((Date.now() - cached.signal.evaluatedAt) / 60000)}m ago) — skipping`);
      return;
    }

    // ── SECTOR CHECK (Druckenmiller: 30% of a stock's move) ──
    let sectorAlignment = null;
    try {
      sectorAlignment = await sectors.checkAlignment(symbol);
      if (sectorAlignment.sector) {
        const alignLabel = sectorAlignment.aligned ? 'ALIGNED' : 'MISALIGNED';
        const rankStr = sectorAlignment.sectorRank ? ` (rank ${sectorAlignment.sectorRank}/11)` : '';
        this._log('sector', `${symbol}: ${sectorAlignment.sector} — ${alignLabel}${rankStr}`);
      }

      // In CAUTIOUS macro, skip stocks in bottom 3 sectors
      if (macroRegime.regime === 'CAUTIOUS' && sectorAlignment.sectorRank && sectorAlignment.sectorRank >= 9) {
        this._log('sector', `${symbol}: skipped — sector rank ${sectorAlignment.sectorRank}/11, too weak for CAUTIOUS regime`);
        signalCache.skip(symbol, `sector rank ${sectorAlignment.sectorRank}/11 in CAUTIOUS`);
        return;
      }
    } catch (err) {
      this._log('sector', `${symbol}: sector check failed — ${err.message}`);
    }

    // 1. Get social sentiment — StockTwits + Reddit (parallel)
    const [stResult, rdResult] = await Promise.allSettled([
      stocktwits.analyzeSymbol(symbol),
      reddit.analyzeSymbol(symbol),
    ]);

    const stSentiment = stResult.status === 'fulfilled' ? stResult.value : { score: 0, label: 'unknown', bullish: 0, bearish: 0, neutral: 0, messages: 0 };
    const rdSentiment = rdResult.status === 'fulfilled' ? rdResult.value : { score: 0, sentiment: 'none', mentions: 0 };

    // Combined social score: weight StockTwits (60%) + Reddit (40%)
    const combinedSocialScore = rdSentiment.mentions > 0
      ? (stSentiment.score * 0.6) + (rdSentiment.score * 0.4)
      : stSentiment.score;

    // Quick filter: skip if combined sentiment is too weak
    if (Math.abs(combinedSocialScore) < cfg.min_sentiment_score) {
      this._log('scan', `${symbol}: skipped — social ${(combinedSocialScore * 100).toFixed(0)}% below threshold ${(cfg.min_sentiment_score * 100).toFixed(0)}% (ST: ${(stSentiment.score * 100).toFixed(0)}%, Reddit: ${(rdSentiment.score * 100).toFixed(0)}%)`);
      signalCache.skip(symbol, `weak social sentiment ${(combinedSocialScore * 100).toFixed(0)}%`);
      return;
    }

    // 2. Get technical analysis
    let techResult;
    try {
      techResult = await technicals.analyze(symbol);
    } catch (err) {
      this._log('scan', `${symbol}: skipped — technicals unavailable (${err.message})`);
      signalCache.skip(symbol, `technicals unavailable`);
      return;
    }

    const { technicals: tech, signals } = techResult;
    if (!tech || !tech.price) {
      this._log('scan', `${symbol}: skipped — no price data from technicals`);
      signalCache.skip(symbol, `no price data`);
      return;
    }

    // 3. Score the signals
    const bullishScore = signals
      .filter(s => s.direction === 'bullish')
      .reduce((a, s) => a + s.strength, 0);
    const bearishScore = signals
      .filter(s => s.direction === 'bearish')
      .reduce((a, s) => a + s.strength, 0);
    const netSignal = bullishScore - bearishScore;

    // Skip if signals are mixed / weak — but use a lower threshold (0.3 instead of 0.5)
    if (netSignal < 0.3) {
      this._log('scan', `${symbol}: skipped — net signal ${netSignal.toFixed(2)} too weak (need 0.3+, bull: ${bullishScore.toFixed(2)}, bear: ${bearishScore.toFixed(2)})`);
      signalCache.skip(symbol, `weak net signal ${netSignal.toFixed(2)}`);
      return;
    }

    this._log('scan', `${symbol}: passed filters — social ${(combinedSocialScore * 100).toFixed(0)}% (ST: ${(stSentiment.score * 100).toFixed(0)}%, Reddit: ${rdSentiment.mentions} mentions), net signal ${netSignal.toFixed(2)}, price $${tech.price.toFixed(2)}`);

    // 3b. Get fundamental analysis from Validea (non-blocking — don't fail if unavailable)
    let fundamentals = null;
    try {
      fundamentals = await validea.getScore(symbol);
      if (fundamentals.error) {
        this._log('scan', `${symbol}: Validea fundamentals unavailable (${fundamentals.error})`);
      } else {
        this._log('scan', `${symbol}: Validea fundamentals — ${fundamentals.label} (${(fundamentals.score * 100).toFixed(0)}%), top: ${fundamentals.topGuru || 'n/a'}`);
      }
    } catch (err) {
      this._log('scan', `${symbol}: Validea error — ${err.message}`);
    }

    // 4. Ask AI for a decision (full Druckenmiller context: macro + sector + fundamentals + technicals + social)
    const decision = await this._askAI(symbol, stSentiment, tech, signals, netSignal, fundamentals, macroRegime, sectorAlignment, rdSentiment);
    if (!decision) {
      this._log('scan', `${symbol}: skipped — AI returned no decision`);
      signalCache.error(symbol, 'AI returned no decision');
      return;
    }
    if (decision.action !== 'buy') {
      this._log('scan', `${symbol}: AI says PASS — confidence ${((decision.confidence || 0) * 100).toFixed(0)}%, reason: ${decision.reason || 'none'}`);
      signalCache.set(symbol, {
        decision: 'pass',
        confidence: decision.confidence,
        reason: decision.reason,
        sentimentScore: combinedSocialScore,
        netSignal,
        macroRegime,
        sectorAlignment,
      });
      return;
    }

    this._log('scan', `${symbol}: AI says BUY — confidence ${((decision.confidence || 0) * 100).toFixed(0)}%`);

    // 5. Pre-trade risk check — regime-adjusted position sizing
    const regimeMultiplier = macroRegime.positionMultiplier || 1.0;
    const baseNotional = Math.min(
      cfg.max_notional_per_trade,
      Number(account.buying_power || 0) * cfg.position_size_pct
    );
    const notional = baseNotional * regimeMultiplier;

    if (notional < 100) {
      this._log('blocked', `${symbol}: order too small ($${notional.toFixed(0)}) — need at least $100`);
      return;
    }

    // 6. Two-step order flow: Preview → Approval Token → Submit
    //    (matches MAHORAGA reference architecture)
    const preview = policy.preview({
      symbol,
      side: 'buy',
      notional,
      currentPositions,
      currentEquity: Number(account.equity || 0),
      buyingPower: Number(account.buying_power || 0),
      sentimentScore: combinedSocialScore,
      confidence: decision.confidence || 0,
    });

    if (!preview.approved) {
      this._log('blocked', `${symbol}: ${preview.violations.join('; ')}`);
      return;
    }

    // 7. Validate token and execute the trade
    try {
      const tokenCheck = policy.validateToken(preview.token, { symbol });
      if (!tokenCheck.valid) {
        this._log('blocked', `${symbol}: approval token invalid — ${tokenCheck.error}`);
        return;
      }

      const order = await alpaca.createOrder({
        symbol,
        notional: notional.toFixed(2),
        side: 'buy',
        type: 'market',
        time_in_force: 'day',
      });

      policy.recordTrade(symbol);
      signalCache.set(symbol, {
        decision: 'buy',
        confidence: decision.confidence,
        reason: decision.reason,
        sentimentScore: combinedSocialScore,
        netSignal,
        macroRegime,
        sectorAlignment,
      });

      this._log('trade', `BUY ${symbol} — $${notional.toFixed(0)} (confidence: ${((decision.confidence || 0) * 100).toFixed(0)}%)`);
      console.log(`[SHARK] BUY ${symbol} — $${notional.toFixed(0)}`);

      // Alert Discord
      if (this._postToChannel) {
        const warnings = preview.warnings?.length > 0
          ? `\n⚠️ ${preview.warnings.join('\n⚠️ ')}`
          : '';
        const regimeLabel = macroRegime.regime ? ` | Macro: ${macroRegime.regime}` : '';
        const sectorLabel = sectorAlignment?.sector ? ` | Sector: ${sectorAlignment.sector}` : '';
        const redditLabel = rdSentiment.mentions > 0 ? ` | Reddit: ${rdSentiment.mentions} mentions` : '';
        await this._postToChannel(
          `💰 **SHARK Trade: BUY ${symbol}**\n` +
          `Amount: \`$${notional.toFixed(0)}\` | Confidence: \`${((decision.confidence || 0) * 100).toFixed(0)}%\`${regimeLabel}${sectorLabel}\n` +
          `Social: \`ST ${stSentiment.label} (${(stSentiment.score * 100).toFixed(0)}%)\`${redditLabel}\n` +
          `Signals: ${signals.filter(s => s.direction === 'bullish').map(s => s.description).join(', ') || 'none'}\n` +
          `Reason: ${decision.reason || 'AI recommendation'}` +
          warnings +
          `\n_${alpaca.isPaper ? 'Paper trade' : 'LIVE trade'} | Not financial advice_`
        );
      }
    } catch (err) {
      this._log('error', `Order failed for ${symbol}: ${err.message}`);
      console.error(`[SHARK] Order failed for ${symbol}:`, err.message);
    }
  }

  // ── AI Decision ───────────────────────────────────────────────────

  async _askAI(symbol, sentiment, tech, signals, netSignal, fundamentals = null, macroRegime = {}, sectorAlignment = null, redditData = null) {
    const prompt = [
      `You are an autonomous trading analyst using Stanley Druckenmiller's top-down framework:`,
      `"50% of a stock's move is the overall market, 30% is the industry, and 20% is stock picking."`,
      ``,
      `Evaluate this opportunity top-down: MACRO → SECTOR → STOCK, then decide BUY or PASS.`,
      `Be risk-averse: prefer waiting for revenue validation over chasing hype. Look for Peter Lynch-style "fast growers" — sound financials, tangible revenue growth path, attractive valuations.`,
      ``,
      `═══ MACRO ENVIRONMENT (50% weight) ═══`,
      macroRegime.regime ? `  Regime: ${macroRegime.regime} (score: ${macroRegime.score})` : `  Regime: unknown`,
      macroRegime.regime === 'RISK_ON' ? `  → Bullish macro: broad participation, positive momentum` : null,
      macroRegime.regime === 'CAUTIOUS' ? `  → Mixed signals: be selective, favor quality` : null,
      macroRegime.regime === 'RISK_OFF' ? `  → Bearish macro: defensive, avoid new longs` : null,
      macroRegime.topSectors?.length > 0 ? `  Leading sectors: ${macroRegime.topSectors.join(', ')}` : null,
      macroRegime.bottomSectors?.length > 0 ? `  Lagging sectors: ${macroRegime.bottomSectors.join(', ')}` : null,
      ``,
      `═══ SECTOR / INDUSTRY (30% weight) ═══`,
      sectorAlignment?.sector ? `  Sector: ${sectorAlignment.sector} | Industry: ${sectorAlignment.industry || 'unknown'}` : `  Sector: unknown`,
      sectorAlignment?.sectorEtf ? `  Sector ETF: ${sectorAlignment.sectorEtf} (rank ${sectorAlignment.sectorRank || '?'}/11)` : null,
      sectorAlignment?.sectorPerf ? `  Sector returns — Day: ${sectorAlignment.sectorPerf.daily}% | Week: ${sectorAlignment.sectorPerf.weekly}% | Month: ${sectorAlignment.sectorPerf.monthly}% | Qtr: ${sectorAlignment.sectorPerf.quarterly}%` : null,
      sectorAlignment?.aligned === false ? `  ⚠ SECTOR MISALIGNED — lagging sector, higher risk` : null,
      sectorAlignment?.aligned === true && sectorAlignment?.sectorRank ? `  ✓ Sector aligned — top-half performer` : null,
      ``,
      `═══ STOCK ANALYSIS (20% weight) ═══`,
      `Symbol: ${symbol}`,
      `Price: $${tech.price?.toFixed(2)}`,
      ``,
      `Social Sentiment (StockTwits):`,
      `  Score: ${(sentiment.score * 100).toFixed(0)}% | ${sentiment.bullish} bullish / ${sentiment.bearish} bearish / ${sentiment.neutral} neutral (${sentiment.messages} posts)`,
      ``,
      // Reddit social data
      ...(redditData && redditData.mentions > 0 ? [
        `Social Sentiment (Reddit):`,
        `  ${redditData.sentiment} — ${redditData.mentions} mentions across ${redditData.subreddits?.join(', ') || 'Reddit'}`,
        `  Score: ${(redditData.score * 100).toFixed(0)}% | Upvote ratio: ${((redditData.avgUpvoteRatio || 0) * 100).toFixed(0)}%`,
        ...(redditData.posts?.slice(0, 2).map(p => `  Recent: [r/${p.subreddit}] ${p.title}`) || []),
        ``,
      ] : [
        `Social Sentiment (Reddit): no mentions found`,
        ``,
      ]),
      `Technical Indicators:`,
      tech.rsi_14 !== null ? `  RSI(14): ${tech.rsi_14.toFixed(1)}` : null,
      tech.macd ? `  MACD: ${tech.macd.macd.toFixed(3)} | Signal: ${tech.macd.signal.toFixed(3)} | Histogram: ${tech.macd.histogram.toFixed(3)}` : null,
      tech.bollinger ? `  Bollinger: $${tech.bollinger.lower.toFixed(2)} — $${tech.bollinger.middle.toFixed(2)} — $${tech.bollinger.upper.toFixed(2)}` : null,
      tech.sma_20 !== null ? `  SMA(20): $${tech.sma_20.toFixed(2)} | SMA(50): $${tech.sma_50?.toFixed(2) ?? '—'} | SMA(200): $${tech.sma_200?.toFixed(2) ?? '—'}` : null,
      tech.atr_14 !== null ? `  ATR(14): $${tech.atr_14.toFixed(2)}` : null,
      tech.relative_volume !== null ? `  Volume: ${tech.relative_volume.toFixed(1)}x average` : null,
      ``,
      `Technical Signals:`,
      ...signals.map(s => `  [${s.direction.toUpperCase()}] ${s.description} (strength: ${(s.strength * 100).toFixed(0)}%)`),
      `  Net bullish score: ${netSignal.toFixed(2)}`,
      ``,
      // Validea fundamental data
      ...(fundamentals && !fundamentals.error ? [
        `Fundamental Analysis (Validea Guru Scores):`,
        `  Overall: ${fundamentals.label} (${(fundamentals.score * 100).toFixed(0)}% avg across ${fundamentals.strategies} strategies)`,
        fundamentals.topGuru ? `  Top Guru: ${fundamentals.topGuru}` : null,
        `  (Buffett, Lynch, Graham, Greenblatt & 18+ guru models — 90%+ = Strong Interest)`,
        ``,
      ] : [
        `Fundamental Analysis: unavailable`,
        ``,
      ]),
      `═══ DECISION FRAMEWORK ═══`,
      `1. If macro is RISK_OFF, default to PASS unless exceptional setup`,
      `2. If sector is lagging (rank 8+ of 11), require very strong stock-level conviction`,
      `3. Favor stocks with both strong technicals AND strong fundamentals`,
      `4. Avoid chasing social hype without fundamental backing`,
      `5. Look for revenue validation — not just momentum or social buzz`,
      ``,
      `Respond with ONLY valid JSON: {"action": "buy" or "pass", "confidence": 0.0-1.0, "reason": "brief explanation referencing macro, sector, and stock-level factors"}`,
    ].filter(Boolean).join('\n');

    try {
      const startTime = Date.now();
      const response = await ai.complete(prompt);
      const durationMs = Date.now() - startTime;

      // Log full prompt/response to audit file for debugging
      auditLog.logOllama(symbol, prompt, response, durationMs);

      if (!response) return null;

      // Extract JSON — prefer object containing "action" key to avoid
      // matching stray curly braces in model prose/thinking remnants
      const jsonMatch = response.match(/\{[^{}]*"action"[^{}]*\}/)
        || response.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        action: parsed.action?.toLowerCase() || 'pass',
        confidence: Number(parsed.confidence) || 0,
        reason: parsed.reason || '',
      };
    } catch (err) {
      console.warn(`[SHARK] AI decision error for ${symbol}: ${err.message}`);
      return null;
    }
  }

  // ── Manual Trade Trigger ─────────────────────────────────────────

  /**
   * Manually trigger the full trade pipeline for a specific ticker.
   * Called via /agent trade key:AAPL [value:force]
   *
   * @param {string} symbol - Ticker to evaluate
   * @param {object} opts
   * @param {boolean} [opts.force] - Skip AI gate, buy directly (still runs risk checks)
   * @returns {{ success: boolean, message: string, details?: object }}
   */
  async manualTrade(symbol, { force = false } = {}) {
    symbol = symbol.toUpperCase();

    if (!alpaca.enabled) {
      return { success: false, message: 'Alpaca API not configured.' };
    }

    const cfg = policy.getConfig();
    if (policy.killSwitch) {
      return { success: false, message: 'Kill switch is active — trading halted.' };
    }

    // Check denylist
    if (cfg.symbol_denylist.length > 0 && cfg.symbol_denylist.includes(symbol)) {
      return { success: false, message: `${symbol} is on the deny list.` };
    }
    if (cfg.symbol_allowlist.length > 0 && !cfg.symbol_allowlist.includes(symbol)) {
      return { success: false, message: `${symbol} is not on the allow list.` };
    }

    const steps = [];

    // 1. Account info
    let account;
    try {
      account = await alpaca.getAccount();
    } catch (err) {
      return { success: false, message: `Account fetch failed: ${err.message}` };
    }
    const equity = Number(account.equity || 0);
    const buyingPower = Number(account.buying_power || 0);
    steps.push(`Account: $${equity.toFixed(0)} equity, $${buyingPower.toFixed(0)} buying power`);

    // 2. Current positions
    let positions;
    try {
      positions = await alpaca.getPositions();
    } catch {
      positions = [];
    }
    const alreadyHolding = positions.some(p => p.symbol === symbol);
    if (alreadyHolding) {
      steps.push(`Already holding ${symbol}`);
    }

    // 3. Social sentiment — StockTwits + Reddit in parallel
    let sentimentResult = { score: 0, label: 'unknown', bullish: 0, bearish: 0, neutral: 0, messages: 0 };
    let redditResult = { score: 0, sentiment: 'none', mentions: 0 };
    try {
      const [stResult, rdResult] = await Promise.allSettled([
        stocktwits.analyzeSymbol(symbol),
        reddit.analyzeSymbol(symbol),
      ]);
      if (stResult.status === 'fulfilled') {
        sentimentResult = stResult.value;
        steps.push(`StockTwits: ${sentimentResult.label} (${(sentimentResult.score * 100).toFixed(0)}%)`);
      } else {
        steps.push(`StockTwits: unavailable`);
      }
      if (rdResult.status === 'fulfilled') {
        redditResult = rdResult.value;
        steps.push(`Reddit: ${redditResult.sentiment} (${redditResult.mentions} mentions, ${(redditResult.score * 100).toFixed(0)}%)`);
      } else {
        steps.push(`Reddit: unavailable`);
      }
    } catch (err) {
      steps.push(`Social: unavailable (${err.message})`);
    }

    // 4. Technical analysis (optional — don't block on failure)
    let tech = null;
    let signals = [];
    let netSignal = 0;
    try {
      const techResult = await technicals.analyze(symbol);
      tech = techResult.technicals;
      signals = techResult.signals || [];
      const bullish = signals.filter(s => s.direction === 'bullish').reduce((a, s) => a + s.strength, 0);
      const bearish = signals.filter(s => s.direction === 'bearish').reduce((a, s) => a + s.strength, 0);
      netSignal = bullish - bearish;
      steps.push(`Technicals: price $${tech.price?.toFixed(2)}, RSI ${tech.rsi_14?.toFixed(1) ?? '—'}, net signal ${netSignal.toFixed(2)}`);
    } catch (err) {
      steps.push(`Technicals: unavailable (${err.message})`);
    }

    // 4b. Validea fundamental analysis (optional — don't block on failure)
    let fundamentals = null;
    try {
      fundamentals = await validea.getScore(symbol);
      if (fundamentals.error) {
        steps.push(`Fundamentals: unavailable (${fundamentals.error})`);
      } else {
        steps.push(`Fundamentals: ${fundamentals.label} (${(fundamentals.score * 100).toFixed(0)}%), top: ${fundamentals.topGuru || 'n/a'}`);
      }
    } catch (err) {
      steps.push(`Fundamentals: error (${err.message})`);
    }

    // 5. AI decision (skip if force)
    let decision = { action: 'buy', confidence: 1.0, reason: 'Manual force trade' };
    if (!force) {
      if (!tech || !tech.price) {
        return { success: false, message: 'Cannot evaluate — no price data available.', details: { steps } };
      }
      try {
        decision = await this._askAI(symbol, sentimentResult, tech, signals, netSignal, fundamentals, {}, null, redditResult);
        if (!decision) {
          steps.push('AI: no response');
          return { success: false, message: `AI returned no decision for ${symbol}.`, details: { steps } };
        }
        steps.push(`AI: ${decision.action.toUpperCase()} — confidence ${((decision.confidence || 0) * 100).toFixed(0)}%, reason: ${decision.reason}`);
        if (decision.action !== 'buy') {
          return { success: false, message: `AI says **${decision.action.toUpperCase()}** — ${decision.reason}`, details: { steps } };
        }
      } catch (err) {
        steps.push(`AI: error (${err.message})`);
        return { success: false, message: `AI evaluation failed: ${err.message}`, details: { steps } };
      }
    } else {
      steps.push('AI: SKIPPED (force mode)');
    }

    // 6. Calculate notional
    const notional = Math.min(
      cfg.max_notional_per_trade,
      buyingPower * cfg.position_size_pct
    );
    if (notional < 10) {
      return { success: false, message: `Insufficient buying power — calculated $${notional.toFixed(0)}.`, details: { steps } };
    }
    steps.push(`Order size: $${notional.toFixed(0)}`);

    // 7. Two-step order flow: Preview → Approval Token → Submit
    const preview = policy.preview({
      symbol,
      side: 'buy',
      notional,
      currentPositions: positions.length,
      currentEquity: equity,
      buyingPower,
      sentimentScore: sentimentResult.score,
      confidence: decision.confidence || 0,
    });

    if (!preview.approved) {
      steps.push(`Risk: BLOCKED — ${preview.violations.join('; ')}`);
      return { success: false, message: `Risk check failed: ${preview.violations.join('; ')}`, details: { steps } };
    }
    if (preview.warnings?.length > 0) {
      steps.push(`Risk warnings: ${preview.warnings.join('; ')}`);
    }
    steps.push(`Risk: PASSED (approval token issued, expires in 5 min)`);

    // 8. Validate token and execute
    try {
      const tokenCheck = policy.validateToken(preview.token, { symbol });
      if (!tokenCheck.valid) {
        steps.push(`Token: INVALID — ${tokenCheck.error}`);
        return { success: false, message: `Approval token failed: ${tokenCheck.error}`, details: { steps } };
      }

      const order = await alpaca.createOrder({
        symbol,
        notional: notional.toFixed(2),
        side: 'buy',
        type: 'market',
        time_in_force: 'day',
      });

      policy.recordTrade(symbol);
      signalCache.set(symbol, {
        decision: 'buy',
        confidence: decision.confidence,
        reason: decision.reason,
        sentimentScore: sentimentResult.score,
        netSignal,
      });

      this._log('trade', `MANUAL BUY ${symbol} — $${notional.toFixed(0)}${force ? ' (force)' : ''} (confidence: ${((decision.confidence || 0) * 100).toFixed(0)}%)`);
      console.log(`[SHARK] MANUAL BUY ${symbol} — $${notional.toFixed(0)}`);
      steps.push(`ORDER PLACED: market buy $${notional.toFixed(0)} of ${symbol}`);

      // Alert trading channel too
      if (this._postToChannel) {
        await this._postToChannel(
          `💰 **SHARK Manual Trade: BUY ${symbol}**\n` +
          `Amount: \`$${notional.toFixed(0)}\`${force ? ' (forced)' : ` | Confidence: \`${((decision.confidence || 0) * 100).toFixed(0)}%\``}\n` +
          `_${alpaca.isPaper ? 'Paper trade' : 'LIVE trade'} | Triggered manually_`
        );
      }

      return {
        success: true,
        message: `BUY ${symbol} — $${notional.toFixed(0)} market order placed.`,
        details: { steps, orderId: order?.id },
      };
    } catch (err) {
      this._log('error', `Manual order failed for ${symbol}: ${err.message}`);
      steps.push(`ORDER FAILED: ${err.message}`);
      return { success: false, message: `Order execution failed: ${err.message}`, details: { steps } };
    }
  }

  // ── Options Engine Access ────────────────────────────────────────

  get optionsEngine() { return optionsEngine; }

  // ── Discord Formatting ────────────────────────────────────────────

  formatStatusForDiscord(status) {
    if (!status) return '_Could not fetch agent status._';

    const dangerousLabel = status.config?.dangerousMode ? ' | **DANGEROUS MODE**' : '';
    const lines = [
      `**SHARK — Autonomous Trading Agent**`,
      `Mode: ${status.paper ? '📄 Paper Trading' : '💵 LIVE Trading'}${dangerousLabel}`,
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

    // Options engine status
    if (status.options) {
      lines.push(``);
      lines.push(`**0DTE Options**`);
      lines.push(`Engine: ${status.options.enabled ? '🟢 Enabled' : '🔴 Disabled'}`);
      if (status.options.enabled) {
        lines.push(`Positions: \`${status.options.activePositions}/${status.options.maxPositions}\``);
        lines.push(`Daily Loss: \`$${status.options.dailyLoss?.toFixed(0) || 0}/$${status.options.maxDailyLoss || 0}\``);
        lines.push(`Underlyings: \`${status.options.config?.underlyings?.join(', ') || 'SPY, QQQ'}\``);
        if (status.options.positions?.length > 0) {
          for (const p of status.options.positions) {
            const emoji = p.unrealizedPL >= 0 ? '🟢' : '🔴';
            lines.push(`${emoji} ${p.underlying} $${p.strike} ${p.type.toUpperCase()} — P/L: $${p.unrealizedPL.toFixed(2)} (${(p.unrealizedPLPct * 100).toFixed(1)}%)`);
          }
        }
      }
    }

    return lines.join('\n');
  }

  formatConfigForDiscord(cfg) {
    if (!cfg) return '_Could not fetch config._';

    const lines = [`**SHARK Configuration**`, ``];

    // Trading limits
    lines.push(`__Trading Limits__`);
    const tradingKeys = [
      ['max_positions', 'Max Positions'],
      ['max_notional_per_trade', 'Max $ Per Trade'],
      ['position_size_pct', 'Position Size (% of cash)'],
      ['max_daily_loss_pct', 'Max Daily Loss'],
      ['stop_loss_pct', 'Stop Loss'],
      ['take_profit_pct', 'Take Profit'],
      ['cooldown_minutes', 'Trade Cooldown (min)'],
    ];
    for (const [key, label] of tradingKeys) {
      if (cfg[key] !== undefined) {
        let val = cfg[key];
        if (typeof val === 'number' && key.includes('pct')) val = `${(val * 100).toFixed(1)}%`;
        else if (typeof val === 'number' && key.includes('notional')) val = `$${Number(val).toLocaleString()}`;
        lines.push(`**${label}:** \`${val}\``);
      }
    }

    // Signal thresholds
    lines.push(``);
    lines.push(`__Signal Thresholds__`);
    const signalKeys = [
      ['min_sentiment_score', 'Min Sentiment'],
      ['min_analyst_confidence', 'Min AI Confidence'],
    ];
    for (const [key, label] of signalKeys) {
      if (cfg[key] !== undefined) {
        lines.push(`**${label}:** \`${cfg[key]}\``);
      }
    }

    // Feature toggles
    lines.push(``);
    lines.push(`__Features__`);
    lines.push(`**Allow Shorting:** ${cfg.allow_shorting ? '`yes`' : '`no`'}`);
    lines.push(`**Crypto Trading:** ${cfg.crypto_enabled ? '`enabled`' : '`disabled`'}`);
    lines.push(`**Options Trading:** ${cfg.options_enabled ? '`enabled`' : '`disabled`'}`);
    lines.push(`**Scan Interval:** \`${cfg.scan_interval_minutes} min\``);

    // Symbol lists
    if (cfg.symbol_allowlist?.length > 0) {
      lines.push(`**Allowlist:** \`${cfg.symbol_allowlist.join(', ')}\``);
    }
    if (cfg.symbol_denylist?.length > 0) {
      lines.push(`**Denylist:** \`${cfg.symbol_denylist.join(', ')}\``);
    }

    // Options config
    if (cfg.options_enabled) {
      lines.push(``);
      lines.push(`__0DTE Options__`);
      lines.push(`**Max Premium/Trade:** \`$${cfg.options_max_premium_per_trade}\``);
      lines.push(`**Max Daily Loss:** \`$${cfg.options_max_daily_loss}\``);
      lines.push(`**Max Options Positions:** \`${cfg.options_max_positions}\``);
      lines.push(`**Scalp TP/SL:** \`${(cfg.options_scalp_take_profit_pct * 100).toFixed(0)}% / ${(cfg.options_scalp_stop_loss_pct * 100).toFixed(0)}%\``);
      lines.push(`**Swing TP/SL:** \`${(cfg.options_swing_take_profit_pct * 100).toFixed(0)}% / ${(cfg.options_swing_stop_loss_pct * 100).toFixed(0)}%\``);
      lines.push(`**Min Conviction:** \`${cfg.options_min_conviction}/10\``);
      lines.push(`**Delta Range:** \`${cfg.options_min_delta} — ${cfg.options_max_delta}\``);
      lines.push(`**Underlyings:** \`${cfg.options_underlyings?.join(', ') || 'SPY, QQQ'}\``);
    }

    lines.push(``);
    lines.push(`Kill Switch: ${cfg.killSwitch ? '🛑 **ACTIVE**' : '🟢 OK'}`);
    lines.push(`Dangerous Mode: ${cfg.dangerousMode ? '**ACTIVE** — aggressive parameters' : 'OFF'}`);
    lines.push(``);
    lines.push(`_Use \`/agent set key:<name> value:<val>\` to change a setting_`);
    lines.push(`_Use \`/agent dangerous\` to toggle aggressive mode_`);
    lines.push(`_Use \`/agent reset\` to restore defaults_`);
    return lines.join('\n');
  }

  formatLogsForDiscord(logs) {
    if (!logs || logs.length === 0) return '_No recent agent activity._';

    const lines = [`**SHARK Recent Activity**`, ``];
    for (const log of logs.slice(-15).reverse()) {
      const time = new Date(log.timestamp).toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
      const emoji = log.type === 'trade' ? '💰' : log.type === 'blocked' ? '🚫' : log.type === 'kill' ? '🛑' : log.type === 'error' ? '❌' : '📋';
      lines.push(`\`${time}\` ${emoji} ${log.message}`);
    }
    return lines.join('\n');
  }
}

module.exports = new SharkEngine();
