const alpaca = require('./alpaca').alpaca;
const gamma = require('./gamma');
const GEXEngine = require('./gex-engine');
const gammaSqueeze = require('./gamma-squeeze');
const { analyzeMTFEMA, formatMTFForPrompt } = require('./mtf-ema');
const technicals = require('./technicals');
const macro = require('./macro');
const policy = require('./policy');
const ai = require('./ai');
const auditLog = require('./audit-log');
const circuitBreaker = require('./circuit-breaker');
const signalCache = require('./signal-cache');
const config = require('../config');
const Storage = require('./storage');

const MAX_CONTRACTS_PER_SCAN = 20;

const MARKET_OPEN_HOUR = 9;
const MARKET_OPEN_MIN = 30;
const MARKET_CLOSE_HOUR = 16;
const MARKET_CLOSE_MIN = 0;

class OptionsEngine {
  constructor() {
    this._storage = new Storage('options-engine-state.json');
    this._gexEngine = new GEXEngine(gamma);
    this._logs = [];
    this._postToChannel = null;
    this._activeTrades = new Map();

    const savedTrades = this._storage.get('activeTrades', []);
    for (const t of savedTrades) {
      this._activeTrades.set(t.symbol, t);
    }
  }

  setChannelPoster(fn) {
    this._postToChannel = fn;
  }

  _log(type, message) {
    const entry = { type, message, timestamp: new Date().toISOString() };
    this._logs.push(entry);
    if (this._logs.length > 300) this._logs.shift();
    auditLog.log(type, `[0DTE] ${message}`);
    return entry;
  }

  getLogs() { return [...this._logs]; }

  _getETTime() {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return {
      hour: et.getHours(),
      minute: et.getMinutes(),
      day: et.getDay(),
      date: et,
      minutesToClose: (MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MIN) - (et.getHours() * 60 + et.getMinutes()),
      todayString: `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`,
    };
  }

  _isMarketHours() {
    const t = this._getETTime();
    if (t.day === 0 || t.day === 6) return false;
    const minuteOfDay = t.hour * 60 + t.minute;
    const openMinute = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MIN;
    const closeMinute = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MIN;
    return minuteOfDay >= openMinute && minuteOfDay < closeMinute;
  }

  async runCycle() {
    const cfg = policy.getConfig();
    if (!cfg.options_enabled) {
      this._log('cycle', 'Options engine disabled (options_enabled=false)');
      return;
    }
    if (!alpaca.enabled) {
      this._log('cycle', 'Alpaca not configured — skipping options cycle');
      return;
    }

    if (circuitBreaker.isPaused()) {
      this._log('circuit_breaker', 'Options trading paused by circuit breaker');
      return;
    }

    const et = this._getETTime();
    if (!this._isMarketHours()) {
      this._log('cycle', `Outside market hours (${et.hour}:${String(et.minute).padStart(2, '0')} ET, day=${et.day}) — skipping`);
      return;
    }

    const minutesSinceOpen = et.minutesToClose > 0
      ? (MARKET_CLOSE_HOUR * 60) - et.minutesToClose - (MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MIN)
      : 0;
    if (minutesSinceOpen < 15) {
      this._log('cycle', `Skipping — ${minutesSinceOpen} min since open (waiting for 15 min price discovery)`);
      return;
    }

    try {
      this._log('cycle', `Options cycle started — ${et.minutesToClose} min to close`);

      const account = await alpaca.getAccount();
      const equity = Number(account.equity || 0);
      policy.resetDaily(equity);

      const optionsPositions = await alpaca.getOptionsPositions();
      if (optionsPositions.length < cfg.options_max_positions && et.minutesToClose > cfg.options_close_before_minutes) {
        this._log('cycle', `Scanning for entries — ${optionsPositions.length}/${cfg.options_max_positions} positions, ${et.minutesToClose} min left`);
        await this._scanForEntries(account, optionsPositions.length, et);
      } else if (et.minutesToClose <= cfg.options_close_before_minutes) {
        this._log('cycle', `Too close to market close (${et.minutesToClose} min) — exit-only mode`);
      } else {
        this._log('cycle', `Max positions reached (${optionsPositions.length}/${cfg.options_max_positions}) — monitoring only`);
      }

    } catch (err) {
      this._log('error', `Options cycle error: ${err.message}`);
      console.error('[0DTE] Cycle error:', err.message);
      circuitBreaker.recordError(err.message);
    }
  }

  async _monitorPositions(minutesToClose) {
    try {
      const optionsPositions = await alpaca.getOptionsPositions();
      if (optionsPositions.length === 0) return;

      this._log('monitor', `Monitoring ${optionsPositions.length} options position(s)`);

      for (const pos of optionsPositions) {
        const tracked = this._activeTrades.get(pos.symbol);
        const strategy = tracked?.strategy || 'scalp';

        const exits = policy.checkOptionsExits([pos], strategy, minutesToClose);
        for (const exit of exits) {
          try {
            await alpaca.closeOptionsPosition(exit.symbol);
            this._log('trade', `CLOSE OPTIONS ${exit.symbol}: ${exit.message}`);

            const pnl = Number(pos.unrealized_pl || 0);
            policy.recordOptionsTradeResult(pnl);
            circuitBreaker.recordExit(exit.symbol, exit.reason, exit.pnlPct);

            this._activeTrades.delete(exit.symbol);
            this._persistTrades();

            if (this._postToChannel) {
              const emoji = pnl >= 0 ? '🟢' : '🔴';
              const parsed = alpaca._parseOccSymbol(exit.symbol);
              await this._postToChannel(
                `${emoji} **0DTE Exit: ${parsed.underlying} ${parsed.strike} ${parsed.type.toUpperCase()}**\n` +
                `${exit.message}\n` +
                `P/L: \`$${pnl.toFixed(2)}\` | Strategy: \`${strategy}\`\n` +
                `_${alpaca.isPaper ? 'Paper' : 'LIVE'} | Autonomous exit_`
              );
            }
          } catch (err) {
            this._log('error', `Failed to close options ${exit.symbol}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      this._log('error', `Options monitor error: ${err.message}`);
    }
  }

  async _scanForEntries(account, currentOptionsPositions, et) {
    const cfg = policy.getConfig();
    const underlyings = cfg.options_underlyings || ['SPY', 'QQQ'];

    let macroRegime = { regime: 'CAUTIOUS', score: 0 };
    try {
      macroRegime = await macro.getRegime();
    } catch (err) {
      this._log('macro', `Macro unavailable (${err.message}) — proceeding as CAUTIOUS`);
    }

    this._log('scan', `Scanning ${underlyings.join(', ')} | macro=${macroRegime.regime} | positions=${currentOptionsPositions}/${cfg.options_max_positions}`);

    if (macroRegime.regime === 'RISK_OFF') {
      this._log('scan', 'RISK_OFF — skipping options entry scan, monitoring exits only');
      return;
    }

    for (const underlying of underlyings) {
      if (currentOptionsPositions >= cfg.options_max_positions) {
        this._log('scan', `Position cap reached — stopping scan`);
        break;
      }

      try {
        const signal = await this._analyzeUnderlying(underlying, macroRegime, et);
        if (!signal) continue;

        this._log('trade', `EXECUTING: ${signal.optionType.toUpperCase()} on ${underlying} — conviction ${signal.conviction}/10, strategy ${signal.strategy}`);
        const result = await this._executeEntry(signal, account, currentOptionsPositions, et);
        if (result.success) {
          currentOptionsPositions++;
          this._log('trade', `ORDER PLACED: ${underlying} ${signal.optionType} — ${signal.reason}`);
        } else {
          this._log('trade', `ORDER FAILED: ${underlying} — ${result.reason}`);
        }
      } catch (err) {
        this._log('error', `Scan error for ${underlying}: ${err.message}`);
      }
    }
  }

  async _analyzeUnderlying(underlying, macroRegime, et) {
    const cfg = policy.getConfig();

    const cooldownKey = `opts_${underlying}`;
    if (!this._scanTimestamps) this._scanTimestamps = new Map();
    const lastScan = this._scanTimestamps.get(cooldownKey) || 0;
    if (Date.now() - lastScan < (cfg.options_cooldown_minutes || 5) * 60 * 1000) {
      return null;
    }

    this._log('scan', `${underlying}: Starting 0DTE analysis...`);

    let gexSummary = null;
    try {
      gexSummary = await this._gexEngine.analyze(underlying, { include_expiries: ['0dte'] });
      this._log('gex', `${underlying}: spot=$${gexSummary.spot}, regime=${gexSummary.regime.label} (${(gexSummary.regime.confidence * 100).toFixed(0)}%), flip=$${gexSummary.gammaFlip || '—'}`);
    } catch (err) {
      this._log('gex', `${underlying}: GEX unavailable (${err.message}) — proceeding with technicals only`);
    }

    let intradayTech;
    const spot = gexSummary?.spot || null;
    try {
      const bars = await alpaca.getIntradayBars(underlying, { timeframe: '5Min', limit: 50 });
      if (bars.length < 10) {
        this._log('tech', `${underlying}: not enough intraday bars (${bars.length}) — skipping`);
        this._markScanned(cooldownKey);
        return null;
      }
      const refPrice = spot || bars[bars.length - 1].close;
      intradayTech = this._computeIntradayTechnicals(bars, refPrice);
      this._log('tech', `${underlying}: RSI=${intradayTech.rsi?.toFixed(1)}, MACD hist=${intradayTech.macd?.histogram?.toFixed(3) || 'N/A'}, momentum=${intradayTech.momentum.toFixed(2)}%, VWAP=$${intradayTech.vwap.toFixed(2)}, vol=${intradayTech.volumeTrend.toFixed(1)}x`);
    } catch (err) {
      this._log('tech', `${underlying}: intraday data error — ${err.message}`);
      this._markScanned(cooldownKey);
      return null;
    }

    const gexRegime = gexSummary?.regime || { label: 'Unknown', confidence: 0 };
    const walls = gexSummary?.walls || { callWalls: [], putWalls: [] };
    const gammaFlip = gexSummary?.gammaFlip || null;
    const spotPrice = spot || intradayTech.price;

    const directionSignals = this._assessDirection(intradayTech, gexRegime, walls, gammaFlip, spotPrice, macroRegime);

    const squeezeSignal = gammaSqueeze.getSqueezeSignal(underlying);
    if (squeezeSignal.active) {
      directionSignals.conviction = Math.min(directionSignals.conviction + squeezeSignal.convictionBoost, 10);
      directionSignals.reasons.push(`Gamma squeeze: ${squeezeSignal.state} (${squeezeSignal.convictionBoost > 0 ? '+' : ''}${squeezeSignal.convictionBoost} conviction) — ${squeezeSignal.reason}`);
      if (squeezeSignal.direction && squeezeSignal.direction !== directionSignals.direction) {
        directionSignals.reasons.push(`Squeeze direction (${squeezeSignal.direction}) CONFLICTS with technical direction (${directionSignals.direction})`);
      }
      this._log('squeeze', `${underlying}: squeeze=${squeezeSignal.state}, boost=${squeezeSignal.convictionBoost}, dir=${squeezeSignal.direction}`);
    }

    let mtfResult = null;
    try {
      mtfResult = await analyzeMTFEMA(underlying);
      const mtfDir = mtfResult.confluenceScore > 0 ? 'bullish' : 'bearish';
      const mtfMatchesDirection = mtfDir === directionSignals.direction;

      directionSignals.conviction = Math.max(1, Math.min(directionSignals.conviction + mtfResult.convictionBoost, 10));
      directionSignals.reasons.push(`MTF EMA: ${mtfResult.consensus} (${mtfResult.confluenceScore > 0 ? '+' : ''}${mtfResult.confluenceScore.toFixed(2)}, boost ${mtfResult.convictionBoost}) — ${mtfMatchesDirection ? 'CONFIRMS' : 'CONFLICTS'}`);

      this._log('mtf', `${underlying}: MTF=${mtfResult.consensus}, score=${mtfResult.confluenceScore.toFixed(2)}, boost=${mtfResult.convictionBoost}, bull=${mtfResult.bullishCount} bear=${mtfResult.bearishCount}`);
    } catch (err) {
      this._log('mtf', `${underlying}: MTF EMA unavailable (${err.message}) — proceeding without`);
    }

    this._log('scan', `${underlying}: direction=${directionSignals.direction}, conviction=${directionSignals.conviction}/10, strategy=${directionSignals.strategy}, reasons=[${directionSignals.reasons.join(', ')}]`);

    if (directionSignals.conviction < 3) {
      this._log('scan', `${underlying}: weak directional signals (${directionSignals.conviction}/10) — skipping`);
      this._markScanned(cooldownKey);
      return null;
    }

    this._log('scan', `${underlying}: conviction ${directionSignals.conviction}/10 — asking AI...`);
    const aiDecision = await this._askOptionsAI(underlying, spotPrice, intradayTech, gexSummary || this._buildMinimalGexContext(spotPrice), macroRegime, directionSignals, et);

    if (!aiDecision || aiDecision.action === 'SKIP') {
      const reason = aiDecision?.reason || 'AI says skip';
      this._log('scan', `${underlying}: AI SKIP — ${reason}`);
      this._markScanned(cooldownKey);
      return null;
    }

    if (aiDecision.conviction < cfg.options_min_conviction) {
      this._log('scan', `${underlying}: AI conviction ${aiDecision.conviction}/10 below min ${cfg.options_min_conviction} — skipping`);
      this._markScanned(cooldownKey);
      return null;
    }

    this._log('scan', `${underlying}: AI says ${aiDecision.action} — conviction ${aiDecision.conviction}/10, strategy: ${aiDecision.strategy || directionSignals.strategy} — PROCEEDING TO EXECUTE`);

    this._markScanned(cooldownKey);

    return {
      underlying,
      direction: aiDecision.action === 'BUY_CALL' || aiDecision.action === 'BUY' ? 'bullish' : 'bearish',
      optionType: (aiDecision.action === 'BUY_CALL' || aiDecision.action === 'BUY') ? 'call' : 'put',
      strategy: aiDecision.strategy || directionSignals.strategy,
      conviction: aiDecision.conviction,
      reason: aiDecision.reason,
      spot: spotPrice,
      gex: gexSummary,
      technicals: intradayTech,
      target: aiDecision.target,
      stopLevel: aiDecision.stopLevel,
    };
  }

  _markScanned(key) {
    if (!this._scanTimestamps) this._scanTimestamps = new Map();
    this._scanTimestamps.set(key, Date.now());
  }

  _buildMinimalGexContext(spotPrice) {
    return {
      spot: spotPrice,
      regime: { label: 'Unknown', confidence: 0 },
      walls: { callWalls: [], putWalls: [] },
      gammaFlip: null,
    };
  }

  _computeIntradayTechnicals(bars, currentPrice) {
    const closes = bars.map(b => b.close);
    const volumes = bars.map(b => b.volume);

    const rsi = technicals.calculateRSI(closes, 14);

    const macd = technicals.calculateMACD(closes);

    const bb = technicals.calculateBollingerBands(closes, 20);

    const atrBars = bars.map(b => ({ h: b.high, l: b.low, c: b.close }));
    const atr = technicals.calculateATR(atrBars, 14);

    let cumTPV = 0, cumVol = 0;
    for (let i = 0; i < bars.length; i++) {
      const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
      cumTPV += tp * bars[i].volume;
      cumVol += bars[i].volume;
    }
    const vwap = cumVol > 0 ? cumTPV / cumVol : currentPrice;

    const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const earlierVol = volumes.slice(-15, -5).reduce((a, b) => a + b, 0) / Math.max(volumes.slice(-15, -5).length, 1);
    const volumeTrend = earlierVol > 0 ? recentVol / earlierVol : 1;

    const recentCloses = closes.slice(-5);
    const momentum = recentCloses.length >= 2
      ? ((recentCloses[recentCloses.length - 1] - recentCloses[0]) / recentCloses[0]) * 100
      : 0;

    const lows = bars.map(b => b.low);
    const highs = bars.map(b => b.high);
    const recentLows = lows.slice(-20);
    const recentHighs = highs.slice(-20);
    const nearestSupport = Math.min(...recentLows);
    const nearestResistance = Math.max(...recentHighs);

    return {
      price: currentPrice,
      rsi,
      macd,
      bollinger: bb,
      atr,
      vwap,
      volumeTrend,
      momentum,
      nearestSupport,
      nearestResistance,
      bars,
      priceAboveVWAP: currentPrice > vwap,
    };
  }

  _assessDirection(tech, gexRegime, walls, gammaFlip, spot, macroRegime) {
    let bullPoints = 0;
    let bearPoints = 0;
    const reasons = [];

    if (macroRegime.regime === 'RISK_ON') {
      bullPoints += 2;
      reasons.push('Macro RISK_ON (+2 bull)');
    } else if (macroRegime.regime === 'RISK_OFF') {
      bearPoints += 2;
      reasons.push('Macro RISK_OFF (+2 bear)');
    }

    if (gexRegime.label === 'Long Gamma' && gexRegime.confidence > 0.4) {
      if (tech.rsi < 35) {
        bullPoints += 2;
        reasons.push('Long gamma + oversold RSI → bounce play (+2 bull)');
      } else if (tech.rsi > 65) {
        bearPoints += 2;
        reasons.push('Long gamma + overbought RSI → fade play (+2 bear)');
      }
    } else if (gexRegime.label === 'Short Gamma' && gexRegime.confidence > 0.4) {
      if (tech.momentum > 0.15) {
        bullPoints += 2;
        reasons.push('Short gamma + bullish momentum → trend continuation (+2 bull)');
      } else if (tech.momentum < -0.15) {
        bearPoints += 2;
        reasons.push('Short gamma + bearish momentum → trend continuation (+2 bear)');
      }
    }

    if (putWall && spot <= putWall.strike * 1.005) {
      bullPoints += 1.5;
      reasons.push(`At put wall $${putWall.strike} → support bounce (+1.5 bull)`);
    }
    if (callWall && spot >= callWall.strike * 0.995) {
      bearPoints += 1.5;
      reasons.push(`At call wall $${callWall.strike} → resistance rejection (+1.5 bear)`);
    }

    if (gammaFlip) {
      if (spot > gammaFlip * 1.01) {
        bullPoints += 1;
        reasons.push(`Above gamma flip $${gammaFlip} (+1 bull)`);
      } else if (spot < gammaFlip * 0.99) {
        bearPoints += 1;
        reasons.push(`Below gamma flip $${gammaFlip} (+1 bear)`);
      }
    }

    if (tech.rsi < 30) {
      bullPoints += 1.5;
      reasons.push(`RSI oversold ${tech.rsi.toFixed(0)} (+1.5 bull)`);
    } else if (tech.rsi > 70) {
      bearPoints += 1.5;
      reasons.push(`RSI overbought ${tech.rsi.toFixed(0)} (+1.5 bear)`);
    }

    if (tech.macd) {
      if (tech.macd.histogram > 0 && tech.macd.macd > tech.macd.signal) {
        bullPoints += 1;
        reasons.push('MACD bullish cross (+1 bull)');
      } else if (tech.macd.histogram < 0 && tech.macd.macd < tech.macd.signal) {
        bearPoints += 1;
        reasons.push('MACD bearish cross (+1 bear)');
      }
    }

    if (tech.priceAboveVWAP) {
      bullPoints += 0.5;
      reasons.push('Price above VWAP (+0.5 bull)');
    } else {
      bearPoints += 0.5;
      reasons.push('Price below VWAP (+0.5 bear)');
    }

    if (tech.bollinger) {
      if (tech.price <= tech.bollinger.lower * 1.002) {
        bullPoints += 1;
        reasons.push('At lower Bollinger band (+1 bull)');
      } else if (tech.price >= tech.bollinger.upper * 0.998) {
        bearPoints += 1;
        reasons.push('At upper Bollinger band (+1 bear)');
      }
    }

    if (tech.volumeTrend > 1.5) {
      if (tech.momentum > 0) bullPoints += 0.5;
      else bearPoints += 0.5;
      reasons.push(`Volume surging ${tech.volumeTrend.toFixed(1)}x (+0.5 direction confirm)`);
    }

    const total = bullPoints + bearPoints;
    const direction = bullPoints > bearPoints ? 'bullish' : 'bearish';
    const dominantPoints = Math.max(bullPoints, bearPoints);
    const clarity = total > 0 ? dominantPoints / total : 0;
    const rawConviction = Math.min(dominantPoints * clarity * 2.5, 10);
    const conviction = Math.round(rawConviction);

    const atrPct = tech.atr ? tech.atr / tech.price : 0;
    const strategy = (gexRegime.label === 'Short Gamma' || atrPct > 0.005) ? 'swing' : 'scalp';

    return { direction, conviction, strategy, reasons, bullPoints, bearPoints };
  }

  async _askOptionsAI(underlying, spot, tech, gexSummary, macroRegime, directionSignals, et) {
    const prompt = [
      `You are a confident 0DTE options trader who TAKES TRADES when the setup is there. Evaluate this intraday setup and decide: BUY_CALL, BUY_PUT, or SKIP.`,
      `You WANT to trade. Your job is to find the trade, not to find reasons to skip. If the directional signals agree and risk/reward is defined, TAKE THE TRADE. Only SKIP when signals genuinely conflict or there is no clear edge.`,
      ``,
      `═══ CONTEXT ═══`,
      `Ticker: ${underlying} | Spot: $${spot} | Time: ${et.hour}:${String(et.minute).padStart(2, '0')} ET (${et.minutesToClose} min to close)`,
      ``,
      `═══ MACRO ═══`,
      `Regime: ${macroRegime.regime} (score: ${macroRegime.score || 'N/A'})`,
      ``,
      `═══ GEX (GAMMA EXPOSURE) ═══`,
      gexSummary.regime?.label !== 'Unknown' ? `Regime: ${gexSummary.regime.label} (${(gexSummary.regime.confidence * 100).toFixed(0)}% confidence)` : `Regime: UNAVAILABLE (trade based on technicals)`,
      gexSummary.walls?.callWalls?.[0] ? `Call Wall: $${gexSummary.walls.callWalls[0].strike}${gexSummary.walls.callWalls[0].stacked ? ' STACKED' : ''}` : null,
      gexSummary.walls?.putWalls?.[0] ? `Put Wall: $${gexSummary.walls.putWalls[0].strike}${gexSummary.walls.putWalls[0].stacked ? ' STACKED' : ''}` : null,
      gexSummary.gammaFlip ? `Gamma Flip: $${gexSummary.gammaFlip} (spot ${spot > gexSummary.gammaFlip ? 'ABOVE' : 'BELOW'})` : null,
      ``,
      `═══ INTRADAY TECHNICALS (5-min bars) ═══`,
      `RSI(14): ${tech.rsi?.toFixed(1) || 'N/A'}`,
      tech.macd ? `MACD: ${tech.macd.macd.toFixed(3)} | Signal: ${tech.macd.signal.toFixed(3)} | Hist: ${tech.macd.histogram.toFixed(3)}` : null,
      tech.bollinger ? `Bollinger: $${tech.bollinger.lower.toFixed(2)} — $${tech.bollinger.middle.toFixed(2)} — $${tech.bollinger.upper.toFixed(2)}` : null,
      `VWAP: $${tech.vwap.toFixed(2)} (price ${tech.priceAboveVWAP ? 'ABOVE' : 'BELOW'})`,
      `ATR: $${tech.atr?.toFixed(2) || 'N/A'} | Momentum: ${tech.momentum.toFixed(2)}%`,
      `Volume: ${tech.volumeTrend.toFixed(1)}x average`,
      `Support: $${tech.nearestSupport.toFixed(2)} | Resistance: $${tech.nearestResistance.toFixed(2)}`,
      ``,
      `═══ GAMMA SQUEEZE STATUS ═══`,
      (() => {
        const sq = gammaSqueeze.getSqueezeSignal(underlying);
        if (!sq.active) return 'No active squeeze conditions';
        return `STATE: ${sq.state} | Direction: ${sq.direction || 'unknown'} | Conviction boost: ${sq.convictionBoost > 0 ? '+' : ''}${sq.convictionBoost}\nReason: ${sq.reason}`;
      })(),
      ``,
      `═══ MULTI-TIMEFRAME EMA (9/20) ═══`,
      (() => {
        const mtfReason = directionSignals.reasons.find(r => r.startsWith('MTF EMA:'));
        return mtfReason || 'MTF EMA data not available for this scan';
      })(),
      ``,
      `═══ DIRECTIONAL ASSESSMENT ═══`,
      `Direction: ${directionSignals.direction} | Score: bull ${directionSignals.bullPoints.toFixed(1)} vs bear ${directionSignals.bearPoints.toFixed(1)}`,
      `Pre-conviction: ${directionSignals.conviction}/10 | Suggested strategy: ${directionSignals.strategy}`,
      `Factors:`,
      ...directionSignals.reasons.map(r => `  - ${r}`),
      ``,
      `═══ RULES ═══`,
      `1. 0DTE theta decay is real — but that's why we trade MOMENTUM. If the move is happening NOW, get in.`,
      `2. Use a real level for stop/target: GEX wall, VWAP, Bollinger band, support/resistance. Don't need perfection — just a defined risk.`,
      `3. In Long Gamma: trade mean-reversion (buy dips, sell rips). In Short Gamma: trade trends.`,
      `4. Don't fight the GEX regime. If short gamma and tanking, don't buy calls.`,
      `5. Volume confirms — but absence of volume alone is NOT a reason to skip if other signals align.`,
      `6. Last 45 min: tighter stops, quicker scalps. Last 15 min: probably skip.`,
      `7. If pre-conviction is 5+ and signals agree, you should be giving conviction 6-8. Give 9-10 for perfect setups. Only give below 5 when signals genuinely CONFLICT.`,
      `8. Multi-timeframe EMA alignment is a strong confirmation. If most timeframes agree, be MORE confident, not less.`,
      `9. During an active gamma squeeze, ride the structural edge aggressively. During unwind, exit.`,
      `10. YOU WANT TO TRADE. The system already filtered weak setups before asking you. If you're being asked, there's likely something here. Find the trade.`,
      ``,
      `Respond with ONLY valid JSON:`,
      `{"action": "BUY_CALL" | "BUY_PUT" | "SKIP", "conviction": 1-10, "strategy": "scalp" | "swing", "target": "$X.XX", "stopLevel": "$X.XX", "reason": "1-2 sentences"}`,
    ].filter(Boolean).join('\n');

    try {
      const startTime = Date.now();
      const response = await ai.complete(prompt);
      const durationMs = Date.now() - startTime;

      auditLog.logOllama(`0DTE_${underlying}`, prompt, response, durationMs);

      if (!response) return null;

      const jsonMatch = response.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        action: parsed.action?.toUpperCase() || 'SKIP',
        conviction: Number(parsed.conviction) || 0,
        strategy: parsed.strategy?.toLowerCase() || 'scalp',
        target: parsed.target || null,
        stopLevel: parsed.stopLevel || null,
        reason: parsed.reason || '',
      };
    } catch (err) {
      this._log('error', `AI decision error for ${underlying}: ${err.message}`);
      return null;
    }
  }

  async _selectContract(signal) {
    const cfg = policy.getConfig();
    const { underlying, optionType, spot } = signal;
    const et = this._getETTime();

    try {
      const options = await alpaca.getOptionsSnapshots(underlying, et.todayString, optionType);

      if (options.length === 0) {
        this._log('contract', `${underlying}: no ${optionType} options for ${et.todayString}`);
        return null;
      }

      let minDelta = cfg.options_min_delta;
      let maxDelta = cfg.options_max_delta;
      if (et.minutesToClose < 120) {
        minDelta = Math.max(0.08, minDelta - 0.05);
        maxDelta = Math.min(0.85, maxDelta + 0.05);
      }
      if (et.minutesToClose < 60) {
        minDelta = Math.max(0.05, minDelta - 0.10);
        maxDelta = Math.min(0.90, maxDelta + 0.10);
      }

      const candidates = options.filter(opt => {
        const absDelta = Math.abs(opt.delta || 0);
        return absDelta >= minDelta && absDelta <= maxDelta;
      });

      if (candidates.length === 0) {
        this._log('contract', `${underlying}: no contracts in delta range [${minDelta.toFixed(2)}-${maxDelta.toFixed(2)}] (${options.length} options checked)`);
        return null;
      }

      const scored = candidates.map(opt => {
        const bid = opt.bid || 0;
        const ask = opt.ask || 0;
        const mid = (bid + ask) / 2;
        const spread = mid > 0 ? (ask - bid) / mid : 1;
        const absDelta = Math.abs(opt.delta || 0);
        const volume = opt.volume || 0;
        const oi = opt.openInterest || 0;

        let score = 0;
        if (spread < 0.05) score += 3;
        else if (spread < 0.10) score += 2;
        else if (spread < 0.15) score += 1;

        if (absDelta >= 0.35 && absDelta <= 0.45) score += 2;
        else if (absDelta >= 0.30 && absDelta <= 0.50) score += 1;

        if (oi > 1000) score += 2;
        else if (oi > 500) score += 1;
        if (volume > 100) score += 1;

        return { ...opt, mid, spread, score };
      });

      scored.sort((a, b) => b.score - a.score || a.spread - b.spread);

      const best = scored[0];
      if (!best) return null;
      if (best.spread > cfg.options_max_spread_pct) {
        this._log('contract', `${underlying}: best contract spread ${(best.spread * 100).toFixed(1)}% exceeds max ${(cfg.options_max_spread_pct * 100).toFixed(0)}%`);
        return null;
      }

      this._log('contract', `${underlying}: selected ${best.symbol} — strike $${best.strike}, delta ${best.delta?.toFixed(2)}, mid $${best.mid.toFixed(2)}, spread ${(best.spread * 100).toFixed(1)}%, OI ${best.openInterest}`);

      return best;
    } catch (err) {
      this._log('error', `Contract selection error for ${underlying}: ${err.message}`);
      return null;
    }
  }

  async _executeEntry(signal, account, currentOptionsPositions, et) {
    const cfg = policy.getConfig();

    const contract = await this._selectContract(signal);
    if (!contract) {
      return { success: false, reason: 'No suitable contract found' };
    }

    const mid = contract.mid || ((contract.bid + contract.ask) / 2);
    const premium = mid * 100;
    const maxContracts = Math.floor(cfg.options_max_premium_per_trade / premium);
    const qty = Math.max(1, Math.min(maxContracts, 3));
    const totalPremium = premium * qty;

    const riskCheck = policy.evaluateOptionsOrder({
      underlying: signal.underlying,
      premium: totalPremium,
      qty,
      currentOptionsPositions,
      delta: contract.delta,
      spreadPct: contract.spread,
      conviction: signal.conviction,
      minutesToClose: et.minutesToClose,
    });

    if (!riskCheck.allowed) {
      this._log('blocked', `${signal.underlying}: ${riskCheck.violations.join('; ')}`);
      return { success: false, reason: riskCheck.violations.join('; ') };
    }

    const limitPrice = Math.round(mid * 100) / 100;

    try {
      const order = await alpaca.createOptionsOrder({
        symbol: contract.symbol,
        qty,
        side: 'buy',
        type: 'limit',
        limit_price: limitPrice,
        time_in_force: 'day',
      });

      const trade = {
        symbol: contract.symbol,
        underlying: signal.underlying,
        strike: contract.strike,
        optionType: signal.optionType,
        strategy: signal.strategy,
        qty,
        entryPrice: limitPrice,
        entryTime: new Date().toISOString(),
        conviction: signal.conviction,
        reason: signal.reason,
        orderId: order?.id,
      };
      this._activeTrades.set(contract.symbol, trade);
      this._persistTrades();

      policy.recordOptionsTrade(signal.underlying);

      this._log('trade', `BUY ${qty}x ${contract.symbol} @ $${limitPrice} (${signal.strategy}) — conviction ${signal.conviction}/10`);

      if (this._postToChannel) {
        const warnings = riskCheck.warnings?.length > 0 ? `\n⚠️ ${riskCheck.warnings.join('\n⚠️ ')}` : '';
        await this._postToChannel(
          `🎯 **0DTE Entry: ${signal.underlying} $${contract.strike} ${signal.optionType.toUpperCase()}**\n` +
          `Contracts: \`${qty}\` | Premium: \`$${limitPrice}\` | Total: \`$${totalPremium.toFixed(0)}\`\n` +
          `Strategy: \`${signal.strategy}\` | Conviction: \`${signal.conviction}/10\`\n` +
          `Delta: \`${contract.delta?.toFixed(2)}\` | Spread: \`${(contract.spread * 100).toFixed(1)}%\`\n` +
          `Reason: ${signal.reason}` +
          warnings +
          `\n_${alpaca.isPaper ? 'Paper' : 'LIVE'} | Autonomous 0DTE trade_`
        );
      }

      return { success: true, order };
    } catch (err) {
      this._log('error', `Order failed for ${contract.symbol}: ${err.message}`);
      return { success: false, reason: err.message };
    }
  }

  async triggerFromAlert(alert) {
    const cfg = policy.getConfig();
    if (!cfg.options_enabled) return;
    if (!alpaca.enabled) return;

    if (circuitBreaker.isPaused()) {
      this._log('alert_trigger', 'Circuit breaker active — ignoring alert trigger');
      return;
    }

    if (!this._isMarketHours()) return;

    const underlying = (alert.ticker || 'SPY').toUpperCase();

    if (alert.action !== 'BUY' && alert.action !== 'SELL') {
      this._log('alert_trigger', `${underlying}: ignoring non-directional alert (${alert.action})`);
      return;
    }

    const directionHint = alert.action === 'BUY' ? 'bullish' : 'bearish';

    this._log('alert_trigger', `${underlying}: TradingView ${alert.action} signal received — "${alert.reason || alert.action}" [${alert.confidence || 'no conf'}] — running full analysis`);

    const et = this._getETTime();

    const minutesSinceOpen = et.minutesToClose > 0
      ? (MARKET_CLOSE_HOUR * 60) - et.minutesToClose - (MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MIN)
      : 0;
    if (minutesSinceOpen < 15) {
      this._log('alert_trigger', `${underlying}: too early after open (${minutesSinceOpen} min) — skipping`);
      return;
    }

    const optionsPositions = await alpaca.getOptionsPositions();
    if (optionsPositions.length >= cfg.options_max_positions) {
      this._log('alert_trigger', `${underlying}: max positions reached (${optionsPositions.length}/${cfg.options_max_positions})`);
      return;
    }

    if (et.minutesToClose <= cfg.options_close_before_minutes) {
      this._log('alert_trigger', `${underlying}: too close to market close (${et.minutesToClose} min)`);
      return;
    }

    try {
      const account = await alpaca.getAccount();
      const equity = Number(account.equity || 0);
      policy.resetDaily(equity);

      let macroRegime = { regime: 'CAUTIOUS', score: 0 };
      try {
        macroRegime = await macro.getRegime();
      } catch (err) {
        this._log('alert_trigger', `${underlying}: macro unavailable — proceeding with CAUTIOUS`);
      }

      if (macroRegime.regime === 'RISK_OFF') {
        this._log('alert_trigger', `${underlying}: RISK_OFF — blocking alert-triggered trade`);
        return;
      }

      let gexSummary = null;
      try {
        gexSummary = await this._gexEngine.analyze(underlying, { include_expiries: ['0dte'] });
        this._log('alert_trigger', `${underlying}: GEX=${gexSummary.regime.label} (${(gexSummary.regime.confidence * 100).toFixed(0)}%), spot=$${gexSummary.spot}, flip=$${gexSummary.gammaFlip || '—'}`);
      } catch (err) {
        this._log('alert_trigger', `${underlying}: GEX unavailable (${err.message}) — proceeding with technicals`);
      }

      let intradayTech;
      const spot = gexSummary?.spot || null;
      try {
        const bars = await alpaca.getIntradayBars(underlying, { timeframe: '5Min', limit: 50 });
        if (bars.length < 10) {
          this._log('alert_trigger', `${underlying}: not enough bars (${bars.length})`);
          return;
        }
        const refPrice = spot || bars[bars.length - 1].close;
        intradayTech = this._computeIntradayTechnicals(bars, refPrice);
      } catch (err) {
        this._log('alert_trigger', `${underlying}: intraday data error — ${err.message}`);
        return;
      }

      const spotPrice = spot || intradayTech.price;

      const gexRegime = gexSummary?.regime || { label: 'Unknown', confidence: 0 };
      const walls = gexSummary?.walls || { callWalls: [], putWalls: [] };
      const gammaFlip = gexSummary?.gammaFlip || null;
      const directionSignals = this._assessDirection(intradayTech, gexRegime, walls, gammaFlip, spotPrice, macroRegime);

      let adjustedConviction = directionSignals.conviction;
      const alertMatchesAnalysis = directionSignals.direction === directionHint;
      if (alertMatchesAnalysis) {
        adjustedConviction = Math.min(adjustedConviction + 2, 10);
        directionSignals.reasons.push(`TradingView ${alert.action} signal CONFIRMS direction (+2 conviction)`);
      } else {
        directionSignals.reasons.push(`TradingView ${alert.action} signal conflicts with ${directionSignals.direction} analysis`);
      }

      if (alert.confidence === 'HIGH') {
        adjustedConviction = Math.min(adjustedConviction + 1, 10);
        directionSignals.reasons.push('TradingView HIGH confidence (+1 conviction)');
      }

      const squeezeSignal = gammaSqueeze.getSqueezeSignal(underlying);
      if (squeezeSignal.active) {
        adjustedConviction = Math.min(adjustedConviction + squeezeSignal.convictionBoost, 10);
        directionSignals.reasons.push(`Gamma squeeze: ${squeezeSignal.state} (${squeezeSignal.convictionBoost > 0 ? '+' : ''}${squeezeSignal.convictionBoost})`);
      }

      let mtfResult = null;
      try {
        mtfResult = await analyzeMTFEMA(underlying);
        adjustedConviction = Math.max(1, Math.min(adjustedConviction + mtfResult.convictionBoost, 10));
        directionSignals.reasons.push(`MTF EMA: ${mtfResult.consensus} (${mtfResult.convictionBoost > 0 ? '+' : ''}${mtfResult.convictionBoost})`);
      } catch (err) {
        this._log('alert_trigger', `${underlying}: MTF unavailable (${err.message})`);
      }

      directionSignals.conviction = adjustedConviction;

      this._log('alert_trigger', `${underlying}: direction=${directionSignals.direction}, conviction=${adjustedConviction}/10 (alert ${alertMatchesAnalysis ? 'CONFIRMS' : 'conflicts'}), strategy=${directionSignals.strategy}`);

      if (adjustedConviction < 2) {
        this._log('alert_trigger', `${underlying}: very weak signals (${adjustedConviction}/10) even with TradingView alert — skipping`);
        return;
      }

      const gexContext = gexSummary || this._buildMinimalGexContext(spotPrice);
      const aiDecision = await this._askOptionsAI(underlying, spotPrice, intradayTech, gexContext, macroRegime, { ...directionSignals, conviction: adjustedConviction }, et);

      if (!aiDecision || aiDecision.action === 'SKIP') {
        const reason = aiDecision?.reason || 'AI says skip';
        this._log('alert_trigger', `${underlying}: AI SKIP — ${reason}`);
        return;
      }

      if (aiDecision.conviction < cfg.options_min_conviction) {
        this._log('alert_trigger', `${underlying}: AI conviction ${aiDecision.conviction}/10 below min ${cfg.options_min_conviction}`);
        return;
      }

      this._log('alert_trigger', `${underlying}: AI ${aiDecision.action} — conviction ${aiDecision.conviction}/10 — EXECUTING from TradingView alert`);

      const signal = {
        underlying,
        direction: (aiDecision.action === 'BUY_CALL' || aiDecision.action === 'BUY') ? 'bullish' : 'bearish',
        optionType: (aiDecision.action === 'BUY_CALL' || aiDecision.action === 'BUY') ? 'call' : 'put',
        strategy: aiDecision.strategy || directionSignals.strategy,
        conviction: aiDecision.conviction,
        reason: `Alert trigger: "${alert.reason || alert.action}" → ${aiDecision.reason}`,
        spot: spotPrice,
        gex: gexSummary,
        technicals: intradayTech,
        target: aiDecision.target,
        stopLevel: aiDecision.stopLevel,
      };

      const result = await this._executeEntry(signal, account, optionsPositions.length, et);
      if (result.success) {
        this._log('alert_trigger', `${underlying}: TRADE EXECUTED from alert trigger`);
      } else {
        this._log('alert_trigger', `${underlying}: execution failed — ${result.reason}`);
      }
    } catch (err) {
      this._log('error', `Alert trigger error for ${underlying}: ${err.message}`);
    }
  }

  async manualTrade(underlying, { direction, strategy } = {}) {
    underlying = underlying.toUpperCase();

    if (!alpaca.enabled) {
      return { success: false, message: 'Alpaca API not configured.' };
    }

    const cfg = policy.getConfig();
    if (!cfg.options_enabled) {
      return { success: false, message: 'Options trading is disabled. Use `/agent set key:options_enabled value:true` to enable.' };
    }

    if (policy.killSwitch) {
      return { success: false, message: 'Kill switch is active — trading halted.' };
    }

    const et = this._getETTime();
    const steps = [];

    let account;
    try {
      account = await alpaca.getAccount();
    } catch (err) {
      return { success: false, message: `Account fetch failed: ${err.message}` };
    }
    steps.push(`Account: $${Number(account.equity).toFixed(0)} equity`);

    let macroRegime = { regime: 'CAUTIOUS', score: 0 };
    try {
      macroRegime = await macro.getRegime();
      steps.push(`Macro: ${macroRegime.regime}`);
    } catch (err) {
      steps.push(`Macro: unavailable`);
    }

    let gexSummary;
    try {
      gexSummary = await this._gexEngine.analyze(underlying, { include_expiries: ['0dte'] });
      steps.push(`GEX: ${gexSummary.regime.label} (${(gexSummary.regime.confidence * 100).toFixed(0)}%), flip $${gexSummary.gammaFlip || '—'}`);
    } catch (err) {
      steps.push(`GEX: unavailable (${err.message})`);
      return { success: false, message: `GEX analysis failed: ${err.message}`, details: { steps } };
    }

    let tech;
    try {
      const bars = await alpaca.getIntradayBars(underlying, { timeframe: '5Min', limit: 50 });
      tech = this._computeIntradayTechnicals(bars, gexSummary.spot);
      steps.push(`Technicals: RSI ${tech.rsi?.toFixed(1)}, momentum ${tech.momentum.toFixed(2)}%, VWAP $${tech.vwap.toFixed(2)}`);
    } catch (err) {
      return { success: false, message: `Intraday data error: ${err.message}`, details: { steps } };
    }

    const dirSignals = this._assessDirection(tech, gexSummary.regime, gexSummary.walls, gexSummary.gammaFlip, gexSummary.spot, macroRegime);
    const finalDirection = direction || (dirSignals.direction === 'bullish' ? 'call' : 'put');
    const finalStrategy = strategy || dirSignals.strategy;
    steps.push(`Direction: ${dirSignals.direction} (${dirSignals.conviction}/10), strategy: ${finalStrategy}`);

    let conviction = dirSignals.conviction;
    let reason = dirSignals.reasons.join('; ');

    if (!direction) {
      const aiDecision = await this._askOptionsAI(underlying, gexSummary.spot, tech, gexSummary, macroRegime, dirSignals, et);
      if (aiDecision) {
        conviction = aiDecision.conviction;
        reason = aiDecision.reason;
        steps.push(`AI: ${aiDecision.action} — conviction ${aiDecision.conviction}/10`);
        if (aiDecision.action === 'SKIP') {
          return { success: false, message: `AI says SKIP: ${aiDecision.reason}`, details: { steps } };
        }
      } else {
        steps.push(`AI: no response`);
      }
    } else {
      steps.push(`Direction forced: ${direction}`);
    }

    const signal = {
      underlying,
      direction: finalDirection === 'call' ? 'bullish' : 'bearish',
      optionType: finalDirection,
      strategy: finalStrategy,
      conviction,
      reason,
      spot: gexSummary.spot,
      gex: gexSummary,
      technicals: tech,
    };

    const optionsPositions = await alpaca.getOptionsPositions();
    const result = await this._executeEntry(signal, account, optionsPositions.length, et);

    if (result.success) {
      steps.push(`ORDER PLACED: ${signal.optionType} on ${underlying}`);
      return { success: true, message: `0DTE ${signal.optionType.toUpperCase()} on ${underlying} — order placed.`, details: { steps } };
    } else {
      steps.push(`ORDER FAILED: ${result.reason}`);
      return { success: false, message: `Order failed: ${result.reason}`, details: { steps } };
    }
  }

  async getStatus() {
    const cfg = policy.getConfig();
    const optionsPositions = await alpaca.getOptionsPositions().catch(() => []);
    const et = this._getETTime();

    return {
      enabled: cfg.options_enabled,
      paper: alpaca.isPaper,
      activePositions: optionsPositions.length,
      maxPositions: cfg.options_max_positions,
      dailyLoss: policy.optionsDailyLoss,
      maxDailyLoss: cfg.options_max_daily_loss,
      minutesToClose: et.minutesToClose,
      isMarketHours: this._isMarketHours(),
      positions: optionsPositions.map(p => {
        const parsed = alpaca._parseOccSymbol(p.symbol);
        const tracked = this._activeTrades.get(p.symbol);
        return {
          symbol: p.symbol,
          underlying: parsed.underlying,
          strike: parsed.strike,
          type: parsed.type,
          qty: p.qty,
          avgEntry: Number(p.avg_entry_price || 0),
          marketValue: Number(p.market_value || 0),
          unrealizedPL: Number(p.unrealized_pl || 0),
          unrealizedPLPct: Number(p.unrealized_plpc || 0),
          strategy: tracked?.strategy || 'unknown',
          conviction: tracked?.conviction || 0,
        };
      }),
      config: {
        maxPremium: cfg.options_max_premium_per_trade,
        scalpTP: `${(cfg.options_scalp_take_profit_pct * 100).toFixed(0)}%`,
        scalpSL: `${(cfg.options_scalp_stop_loss_pct * 100).toFixed(0)}%`,
        swingTP: `${(cfg.options_swing_take_profit_pct * 100).toFixed(0)}%`,
        swingSL: `${(cfg.options_swing_stop_loss_pct * 100).toFixed(0)}%`,
        minConviction: cfg.options_min_conviction,
        underlyings: cfg.options_underlyings,
      },
      recentLogs: this._logs.slice(-10),
    };
  }

  formatStatusForDiscord(status) {
    const lines = [
      `**0DTE Options Trading Engine**`,
      `Mode: ${status.paper ? '📄 Paper' : '💵 LIVE'} | Engine: ${status.enabled ? '🟢 **ENABLED**' : '🔴 **DISABLED**'}`,
      `Market: ${status.isMarketHours ? '🟢 Open' : '🔴 Closed'} (${status.minutesToClose} min to close)`,
      ``,
    ];

    if (status.positions.length > 0) {
      lines.push(`**Open Positions** (${status.activePositions}/${status.maxPositions})`);
      for (const p of status.positions) {
        const pnl = p.unrealizedPL;
        const emoji = pnl >= 0 ? '🟢' : '🔴';
        lines.push(`${emoji} **${p.underlying} $${p.strike} ${p.type.toUpperCase()}** — ${p.qty}x @ $${p.avgEntry.toFixed(2)} | P/L: $${pnl.toFixed(2)} (${(p.unrealizedPLPct * 100).toFixed(1)}%) | ${p.strategy}`);
      }
      lines.push(``);
    } else {
      lines.push(`_No open options positions_`);
      lines.push(``);
    }

    lines.push(`**Risk**`);
    lines.push(`Daily Loss: \`$${status.dailyLoss.toFixed(0)}/$${status.maxDailyLoss}\``);
    lines.push(`Max Premium/Trade: \`$${status.config.maxPremium}\``);
    lines.push(`Scalp: TP \`${status.config.scalpTP}\` / SL \`${status.config.scalpSL}\``);
    lines.push(`Swing: TP \`${status.config.swingTP}\` / SL \`${status.config.swingSL}\``);
    lines.push(`Min Conviction: \`${status.config.minConviction}/10\``);
    lines.push(`Underlyings: \`${status.config.underlyings.join(', ')}\``);

    return lines.join('\n');
  }

  _persistTrades() {
    const trades = [...this._activeTrades.values()];
    this._storage.set('activeTrades', trades);
  }
}

module.exports = new OptionsEngine();