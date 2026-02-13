'use strict';

/**
 * backtest-harness.js — Full 0DTE options backtesting engine.
 *
 * Replays the bot's real decision logic on historical intraday data:
 *   1. Fetches 5-min bars for a date range
 *   2. At each bar, computes technicals using the real _computeIntradayTechnicals
 *   3. Runs _assessDirection to get directional signals
 *   4. Simulates an option chain and selects contracts
 *   5. Tracks open positions, applies exits (stop, TP, time, EOD)
 *   6. Calculates realistic P&L with theta decay, slippage, commissions
 *   7. Outputs full summary stats + CSV export
 *
 * Usage:
 *   const harness = new BacktestHarness({ symbol: 'SPY' });
 *   const results = await harness.run('2026-02-12');
 *   harness.printSummary(results);
 */

const { fetchHistoricalBars } = require('./data-fetcher');
const { simulate0DTEChain, repriceOption, calculateTradePL } = require('./option-simulator');
const technicals = require('../services/technicals');
const fs = require('fs');
const path = require('path');

// ── Default configuration ───────────────────────────────────────────

const DEFAULT_CONFIG = {
  // Scanning
  symbol: 'SPY',
  barInterval: '5m',
  scanIntervalBars: 3,              // evaluate every 3 bars (15 min at 5m)
  minBarsForTechnicals: 15,         // need 15 bars before first decision
  skipFirstMinutes: 15,             // skip first 15 min after open (noise)

  // Entry thresholds
  minConviction: 7,                 // minimum direction conviction to enter
  minMomentumAlignment: true,       // require momentum to match direction

  // Position limits
  maxConcurrentPositions: 2,
  maxTradesPerDay: 6,
  cooldownBars: 2,                  // min bars between trades on same symbol

  // Contract selection
  targetDelta: 0.40,
  minDelta: 0.25,
  maxDelta: 0.55,

  // Exit rules
  premiumStopPct: -0.20,            // -20% premium stop
  premiumTargetPct: 0.25,           // +25% profit target
  timeStopMinutes: 12,              // bail if no favorable move in 12 min
  maxHoldMinutes: 15,               // hard max hold
  eodCloseMinutes: 30,              // close 30 min before market close

  // Cost model
  contractQty: 2,                   // contracts per trade
  slippagePct: 0.0075,              // 0.75% slippage per side
  commissionPerContract: 0.65,      // $0.65/contract/side

  // Option pricing
  baseIV: 0.20,                     // base implied volatility
  ivSkew: 0.02,                     // IV smile per $1 OTM
  riskFreeRate: 0.05,

  // Stress test overrides
  stressMode: null,                 // 'downtrend' | 'volatility_spike' | null
  stressIVMultiplier: 1.0,          // multiply IV by this factor

  // Macro regime override for backtest
  macroRegime: { regime: 'CAUTIOUS', score: 0 },
};

// ── BacktestHarness class ───────────────────────────────────────────

class BacktestHarness {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    this._log = [];
  }

  /**
   * Run a backtest for a single date or date range.
   *
   * @param {string} startDate - 'YYYY-MM-DD'
   * @param {string} [endDate] - defaults to startDate
   * @returns {Promise<BacktestResult>}
   */
  async run(startDate, endDate) {
    endDate = endDate || startDate;

    this._log = [];
    this._emit('info', `Backtest: ${this.cfg.symbol} from ${startDate} to ${endDate}`);
    this._emit('info', `Config: conviction >= ${this.cfg.minConviction}, stops: ${this.cfg.premiumStopPct * 100}%/${this.cfg.premiumTargetPct * 100}%, max hold: ${this.cfg.maxHoldMinutes}min`);

    // Fetch bars
    this._emit('info', 'Fetching historical bars...');
    const allBars = await fetchHistoricalBars(this.cfg.symbol, startDate, endDate, {
      interval: this.cfg.barInterval,
    });

    if (allBars.size === 0) {
      throw new Error(`No data fetched for ${this.cfg.symbol} ${startDate} to ${endDate}`);
    }

    // Run each day
    const dailyResults = [];
    for (const [date, bars] of allBars) {
      this._emit('info', `\n${'═'.repeat(60)}`);
      this._emit('info', `Processing ${date}: ${bars.length} bars`);
      const dayResult = await this._runDay(date, bars);
      dailyResults.push(dayResult);
    }

    // Aggregate results
    return this._aggregateResults(dailyResults, startDate, endDate);
  }

  /**
   * Run backtest for a single trading day.
   */
  async _runDay(date, bars) {
    const trades = [];
    const openPositions = [];
    let tradesToday = 0;
    let lastTradeBar = -999;
    let equityCurve = [0]; // start at 0

    // Apply stress test modifications to bars
    const processedBars = this._applyStressTest(bars);

    for (let i = 0; i < processedBars.length; i++) {
      const bar = processedBars[i];
      const barTime = bar.date instanceof Date ? bar.date : new Date(bar.timestamp);

      // Calculate minutes to close (4:00 PM ET) — must compute in ET timezone
      const etStr = barTime.toLocaleString('en-US', { timeZone: 'America/New_York' });
      const etBarTime = new Date(etStr);
      const closeTime = new Date(etStr);
      closeTime.setHours(16, 0, 0, 0);
      const minutesToClose = Math.max((closeTime - etBarTime) / 60000, 0);

      // ── 1. Monitor & exit open positions ──
      for (let p = openPositions.length - 1; p >= 0; p--) {
        const pos = openPositions[p];
        const holdMinutes = (barTime - pos.entryTime) / 60000;

        // Reprice the option at current spot
        const currentPremium = repriceOption(
          bar.close, pos.strike, minutesToClose,
          this.cfg.baseIV * this.cfg.stressIVMultiplier,
          pos.side, this.cfg.riskFreeRate,
        );
        const pnlPct = (currentPremium - pos.entryPremium) / pos.entryPremium;

        let exitReason = null;

        // Check exit conditions (order of priority)
        if (minutesToClose <= this.cfg.eodCloseMinutes) {
          exitReason = 'eod_close';
        } else if (pnlPct <= this.cfg.premiumStopPct) {
          exitReason = 'premium_stop';
        } else if (pnlPct >= this.cfg.premiumTargetPct) {
          exitReason = 'profit_target';
        } else if (holdMinutes >= this.cfg.maxHoldMinutes) {
          exitReason = 'max_hold_time';
        } else if (holdMinutes >= this.cfg.timeStopMinutes && pnlPct <= 0) {
          exitReason = 'time_stop_no_profit';
        }

        if (exitReason) {
          const pl = calculateTradePL({
            entrySpot: pos.entrySpot,
            exitSpot: bar.close,
            strike: pos.strike,
            side: pos.side,
            entryPremium: pos.entryPremium,
            entryMinutesToClose: pos.entryMinutesToClose,
            exitMinutesToClose: minutesToClose,
            qty: pos.qty,
            opts: {
              iv: this.cfg.baseIV * this.cfg.stressIVMultiplier,
              slippagePct: this.cfg.slippagePct,
              commissionPerContract: this.cfg.commissionPerContract,
              riskFreeRate: this.cfg.riskFreeRate,
            },
          });

          const closedTrade = {
            ...pos,
            exitTime: barTime,
            exitBar: i,
            exitSpot: bar.close,
            exitPremium: pl.exitPremium,
            exitReason,
            holdMinutes: pl.holdMinutes,
            grossPnL: pl.grossPnL,
            netPnL: pl.netPnL,
            pnlPct: pl.pnlPct,
            slippage: pl.slippage,
            commission: pl.commission,
            won: pl.netPnL > 0,
          };

          trades.push(closedTrade);
          openPositions.splice(p, 1);

          const emoji = closedTrade.won ? 'WIN' : 'LOSS';
          this._emit('trade', `  [${emoji}] EXIT ${pos.side.toUpperCase()} $${pos.strike} — ${exitReason} — net $${pl.netPnL.toFixed(2)} (${(pl.pnlPct * 100).toFixed(1)}%) held ${pl.holdMinutes}min`);
        }
      }

      // Update equity curve
      const unrealizedPnL = openPositions.reduce((sum, pos) => {
        const curPrem = repriceOption(bar.close, pos.strike, minutesToClose,
          this.cfg.baseIV * this.cfg.stressIVMultiplier, pos.side, this.cfg.riskFreeRate);
        return sum + (curPrem - pos.entryPremium) * 100 * pos.qty;
      }, 0);
      const realizedPnL = trades.reduce((sum, t) => sum + t.netPnL, 0);
      equityCurve.push(realizedPnL + unrealizedPnL);

      // ── 2. Scan for new entries ──
      if (
        i < this.cfg.minBarsForTechnicals ||
        i % this.cfg.scanIntervalBars !== 0 ||
        openPositions.length >= this.cfg.maxConcurrentPositions ||
        tradesToday >= this.cfg.maxTradesPerDay ||
        i - lastTradeBar < this.cfg.cooldownBars ||
        minutesToClose <= this.cfg.eodCloseMinutes + 15 // don't enter if close to EOD exit
      ) {
        continue;
      }

      // Check if past the skip-first-minutes window
      const firstBar = processedBars[0].date instanceof Date ? processedBars[0].date : new Date(processedBars[0].timestamp);
      const minutesSinceOpen = (barTime - firstBar) / 60000;
      if (minutesSinceOpen < this.cfg.skipFirstMinutes) continue;

      // Compute technicals on bars up to this point
      const windowBars = processedBars.slice(Math.max(0, i - 49), i + 1);
      const tech = this._computeTechnicals(windowBars, bar.close);
      if (!tech) continue;

      // Assess direction (replicating options-engine logic)
      const dirSignals = this._assessDirection(tech, bar.close);

      if (dirSignals.conviction < this.cfg.minConviction) continue;

      // Theta timing gate (from options-engine)
      const thetaFloor = minutesToClose > 240 ? this.cfg.minConviction
        : minutesToClose > 120 ? this.cfg.minConviction + 1
        : minutesToClose > 60  ? this.cfg.minConviction + 2
        : 11; // blocked
      if (dirSignals.conviction < thetaFloor) {
        this._emit('scan', `  [SKIP] bar ${i} — conviction ${dirSignals.conviction} below theta floor ${thetaFloor} (${minutesToClose.toFixed(0)} min to close)`);
        continue;
      }

      // Direction/momentum alignment check (the conviction bug fix)
      if (this.cfg.minMomentumAlignment) {
        const momentumConflict = (
          (dirSignals.direction === 'bullish' && tech.momentum < -0.10 && tech.rsi > 55) ||
          (dirSignals.direction === 'bearish' && tech.momentum > 0.10 && tech.rsi < 45)
        );
        if (momentumConflict) {
          this._emit('scan', `  [BLOCKED] bar ${i} — direction ${dirSignals.direction} conflicts with momentum ${tech.momentum.toFixed(2)}%`);
          continue;
        }
      }

      // Simulate option chain and select contract
      const side = dirSignals.direction === 'bullish' ? 'call' : 'put';
      const chain = simulate0DTEChain(bar.close, barTime, {
        iv: this.cfg.baseIV * this.cfg.stressIVMultiplier,
        ivSkew: this.cfg.ivSkew,
        riskFreeRate: this.cfg.riskFreeRate,
        minDelta: this.cfg.minDelta,
        maxDelta: this.cfg.maxDelta,
      });

      const contract = this._selectContract(chain, side);
      if (!contract) {
        this._emit('scan', `  [SKIP] bar ${i} — no suitable ${side} contract found`);
        continue;
      }

      // Enter position
      const position = {
        id: `${date}-${tradesToday + 1}`,
        date,
        side,
        strike: contract.strike,
        symbol: contract.symbol,
        delta: contract.delta,
        entrySpot: bar.close,
        entryPremium: contract.mid,
        entryTime: barTime,
        entryBar: i,
        entryMinutesToClose: minutesToClose,
        qty: this.cfg.contractQty,
        conviction: dirSignals.conviction,
        direction: dirSignals.direction,
        entryReason: dirSignals.reasons.join(' | '),
        entryTechnicals: {
          rsi: tech.rsi,
          momentum: tech.momentum,
          vwap: tech.vwap,
          priceAboveVWAP: tech.priceAboveVWAP,
          choppiness: tech.choppiness,
          todayMoveSigma: tech.todayMoveSigma,
          volumeTrend: tech.volumeTrend,
        },
      };

      openPositions.push(position);
      tradesToday++;
      lastTradeBar = i;

      this._emit('trade', `  [ENTRY] ${side.toUpperCase()} $${contract.strike} @ $${contract.mid.toFixed(2)} — conviction ${dirSignals.conviction}/10 — spot $${bar.close.toFixed(2)} (bar ${i}, ${minutesToClose.toFixed(0)}min to close)`);
    }

    // Force-close any remaining open positions at last bar
    const lastBar = processedBars[processedBars.length - 1];
    for (const pos of openPositions) {
      const pl = calculateTradePL({
        entrySpot: pos.entrySpot,
        exitSpot: lastBar.close,
        strike: pos.strike,
        side: pos.side,
        entryPremium: pos.entryPremium,
        entryMinutesToClose: pos.entryMinutesToClose,
        exitMinutesToClose: 0,
        qty: pos.qty,
        opts: {
          iv: this.cfg.baseIV * this.cfg.stressIVMultiplier,
          slippagePct: this.cfg.slippagePct,
          commissionPerContract: this.cfg.commissionPerContract,
          riskFreeRate: this.cfg.riskFreeRate,
        },
      });

      trades.push({
        ...pos,
        exitTime: lastBar.date instanceof Date ? lastBar.date : new Date(lastBar.timestamp),
        exitBar: processedBars.length - 1,
        exitSpot: lastBar.close,
        exitPremium: pl.exitPremium,
        exitReason: 'eod_forced_close',
        holdMinutes: pl.holdMinutes,
        grossPnL: pl.grossPnL,
        netPnL: pl.netPnL,
        pnlPct: pl.pnlPct,
        slippage: pl.slippage,
        commission: pl.commission,
        won: pl.netPnL > 0,
      });
      this._emit('trade', `  [EOD] FORCED CLOSE ${pos.side.toUpperCase()} $${pos.strike} — net $${pl.netPnL.toFixed(2)}`);
    }

    return { date, trades, equityCurve, barCount: processedBars.length };
  }

  // ── Technicals computation (mirrors options-engine) ─────────────

  _computeTechnicals(bars, currentPrice) {
    if (bars.length < 10) return null;

    const closes = bars.map(b => b.close);
    const volumes = bars.map(b => b.volume);

    const rsi = technicals.calculateRSI(closes, 14);
    const macd = technicals.calculateMACD(closes);
    const bb = technicals.calculateBollingerBands(closes, 20);
    const atrBars = bars.map(b => ({ h: b.high, l: b.low, c: b.close }));
    const atr = technicals.calculateATR(atrBars, 14);

    // VWAP
    let cumTPV = 0, cumVol = 0;
    for (const b of bars) {
      const tp = (b.high + b.low + b.close) / 3;
      cumTPV += tp * b.volume;
      cumVol += b.volume;
    }
    const vwap = cumVol > 0 ? cumTPV / cumVol : currentPrice;

    // Volume trend
    const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const earlierVol = volumes.slice(-15, -5).reduce((a, b) => a + b, 0) / Math.max(volumes.slice(-15, -5).length, 1);
    const volumeTrend = earlierVol > 0 ? recentVol / earlierVol : 1;

    // Momentum
    const recentCloses = closes.slice(-5);
    const momentum = recentCloses.length >= 2
      ? ((recentCloses[recentCloses.length - 1] - recentCloses[0]) / recentCloses[0]) * 100
      : 0;

    // Support/Resistance
    const lows = bars.map(b => b.low).slice(-20);
    const highs = bars.map(b => b.high).slice(-20);

    // Volatility regime
    const logReturns = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i - 1] > 0) logReturns.push(Math.log(closes[i] / closes[i - 1]));
    }
    const stddev = logReturns.length > 5
      ? Math.sqrt(logReturns.reduce((s, r) => s + r * r, 0) / logReturns.length)
      : 0;
    const todayMove = closes.length >= 2
      ? Math.abs(Math.log(closes[closes.length - 1] / closes[0]))
      : 0;
    const todayMoveSigma = stddev > 0 ? todayMove / stddev : 0;

    // Choppiness
    const chopWindow = Math.min(20, logReturns.length);
    let choppiness = 1;
    if (chopWindow >= 5) {
      const windowReturns = logReturns.slice(-chopWindow);
      const totalVol = Math.sqrt(windowReturns.reduce((s, r) => s + r * r, 0));
      const netDisp = Math.abs(windowReturns.reduce((s, r) => s + r, 0));
      choppiness = netDisp > 0 ? totalVol / netDisp : 5;
    }

    return {
      price: currentPrice,
      rsi,
      macd,
      bollinger: bb,
      atr,
      vwap,
      volumeTrend,
      momentum,
      nearestSupport: lows.length > 0 ? Math.min(...lows) : currentPrice,
      nearestResistance: highs.length > 0 ? Math.max(...highs) : currentPrice,
      bars,
      priceAboveVWAP: currentPrice > vwap,
      dailySigma: stddev,
      todayMoveSigma,
      choppiness,
    };
  }

  // ── Direction assessment (mirrors options-engine._assessDirection) ──

  _assessDirection(tech, spot) {
    let bullPoints = 0;
    let bearPoints = 0;
    const reasons = [];

    // Macro (use configured regime)
    const macro = this.cfg.macroRegime;
    if (macro.regime === 'RISK_ON') {
      bullPoints += 2;
      reasons.push('Macro RISK_ON (+2 bull)');
    } else if (macro.regime === 'RISK_OFF') {
      bearPoints += 2;
      reasons.push('Macro RISK_OFF (+2 bear)');
    }

    // RSI
    if (tech.rsi < 30) { bullPoints += 1.5; reasons.push(`RSI oversold ${tech.rsi.toFixed(0)} (+1.5 bull)`); }
    else if (tech.rsi > 70) { bearPoints += 1.5; reasons.push(`RSI overbought ${tech.rsi.toFixed(0)} (+1.5 bear)`); }
    else if (tech.rsi < 40) { bullPoints += 0.5; reasons.push(`RSI leaning oversold ${tech.rsi.toFixed(0)} (+0.5 bull)`); }
    else if (tech.rsi > 60) { bearPoints += 0.5; reasons.push(`RSI leaning overbought ${tech.rsi.toFixed(0)} (+0.5 bear)`); }

    // MACD
    if (tech.macd) {
      if (tech.macd.histogram > 0) { bullPoints += 1; reasons.push('MACD histogram positive (+1 bull)'); }
      else if (tech.macd.histogram < 0) { bearPoints += 1; reasons.push('MACD histogram negative (+1 bear)'); }
    }

    // VWAP
    if (tech.priceAboveVWAP) { bullPoints += 0.5; reasons.push('Price above VWAP (+0.5 bull)'); }
    else { bearPoints += 0.5; reasons.push('Price below VWAP (+0.5 bear)'); }

    // Bollinger
    if (tech.bollinger) {
      const bbPos = (spot - tech.bollinger.lower) / (tech.bollinger.upper - tech.bollinger.lower);
      if (bbPos < 0.15) { bullPoints += 1; reasons.push('At lower Bollinger (+1 bull bounce)'); }
      else if (bbPos > 0.85) { bearPoints += 1; reasons.push('At upper Bollinger (+1 bear fade)'); }
    }

    // Volume
    if (tech.volumeTrend > 1.5) {
      if (tech.momentum > 0) { bullPoints += 0.5; reasons.push('Surging volume + bullish momentum (+0.5 bull)'); }
      else if (tech.momentum < 0) { bearPoints += 0.5; reasons.push('Surging volume + bearish momentum (+0.5 bear)'); }
    }

    // Momentum
    if (tech.momentum > 0.15) { bullPoints += 1; reasons.push(`Strong bullish momentum ${tech.momentum.toFixed(2)}% (+1 bull)`); }
    else if (tech.momentum < -0.15) { bearPoints += 1; reasons.push(`Strong bearish momentum ${tech.momentum.toFixed(2)}% (+1 bear)`); }

    // Volatility regime
    if (tech.todayMoveSigma >= 1.5) {
      if (tech.momentum > 0) bullPoints += 1;
      else bearPoints += 1;
      reasons.push(`Strong intraday move ${tech.todayMoveSigma.toFixed(1)}σ (+1 direction)`);
    }

    // Choppiness penalty
    if (tech.choppiness > 3.0) {
      bullPoints -= 0.5;
      bearPoints -= 0.5;
      reasons.push(`Choppy market ${tech.choppiness.toFixed(1)} (-0.5 both)`);
    }

    // Calculate direction and conviction
    const totalPoints = bullPoints + bearPoints;
    const dominant = bullPoints >= bearPoints ? 'bullish' : 'bearish';
    const dominantPoints = Math.max(bullPoints, bearPoints);
    const clarity = totalPoints > 0 ? dominantPoints / totalPoints : 0;
    const conviction = Math.min(Math.round(dominantPoints * clarity * 2.5), 10);

    return {
      direction: dominant,
      conviction,
      strategy: 'scalp',
      reasons,
      bullPoints,
      bearPoints,
    };
  }

  // ── Contract selection ────────────────────────────────────────────

  _selectContract(chain, side) {
    const candidates = chain.filter(c => c.type === side);
    if (candidates.length === 0) return null;

    // Score by proximity to target delta + tight spread
    const scored = candidates.map(c => {
      const absDelta = Math.abs(c.delta);
      const deltaDistance = Math.abs(absDelta - this.cfg.targetDelta);
      let score = 0;

      // Delta targeting
      if (deltaDistance < 0.05) score += 4;
      else if (deltaDistance < 0.10) score += 3;
      else if (deltaDistance < 0.15) score += 2;
      else score += 1;

      // Spread quality
      if (c.spreadPct < 0.03) score += 4;
      else if (c.spreadPct < 0.05) score += 3;
      else if (c.spreadPct < 0.10) score += 2;

      // Prefer higher delta within range
      score += absDelta * 2;

      return { ...c, score };
    });

    scored.sort((a, b) => b.score - a.score || a.spreadPct - b.spreadPct);
    return scored[0] || null;
  }

  // ── Stress test modifications ─────────────────────────────────────

  _applyStressTest(bars) {
    if (!this.cfg.stressMode) return bars;

    return bars.map((bar, i) => {
      const modified = { ...bar };

      switch (this.cfg.stressMode) {
        case 'downtrend':
          // Simulate a steady -2% intraday grind down
          {
            const pct = (i / bars.length) * 0.02;
            const factor = 1 - pct;
            modified.open *= factor;
            modified.high *= factor;
            modified.low *= factor;
            modified.close *= factor;
          }
          break;

        case 'volatility_spike':
          // Add random volatility spikes (wider candles)
          {
            const spike = (Math.random() - 0.5) * 0.004 * modified.close;
            modified.high += Math.abs(spike);
            modified.low -= Math.abs(spike);
            modified.close += spike;
          }
          break;

        case 'v_reversal':
          // Simulate a V-shaped reversal: down first half, up second half
          {
            const halfPoint = bars.length / 2;
            let pct;
            if (i < halfPoint) {
              pct = (i / halfPoint) * 0.015; // drop 1.5%
              const factor = 1 - pct;
              modified.open *= factor;
              modified.high *= factor;
              modified.low *= factor;
              modified.close *= factor;
            } else {
              pct = ((i - halfPoint) / halfPoint) * 0.02; // rally 2%
              const baseFactor = 1 - 0.015; // bottom
              const factor = baseFactor * (1 + pct);
              modified.open *= factor;
              modified.high *= factor;
              modified.low *= factor;
              modified.close *= factor;
            }
          }
          break;
      }

      return modified;
    });
  }

  // ── Results aggregation ───────────────────────────────────────────

  _aggregateResults(dailyResults, startDate, endDate) {
    const allTrades = dailyResults.flatMap(d => d.trades);
    const wins = allTrades.filter(t => t.won);
    const losses = allTrades.filter(t => !t.won);

    // Equity curve (cumulative across days)
    let cumPnL = 0;
    const equityCurve = [0];
    for (const trade of allTrades) {
      cumPnL += trade.netPnL;
      equityCurve.push(cumPnL);
    }

    // Max drawdown
    let peak = 0;
    let maxDrawdown = 0;
    for (const val of equityCurve) {
      peak = Math.max(peak, val);
      const dd = peak - val;
      maxDrawdown = Math.max(maxDrawdown, dd);
    }

    // Profit factor
    const totalGrossWins = wins.reduce((s, t) => s + t.netPnL, 0);
    const totalGrossLosses = Math.abs(losses.reduce((s, t) => s + t.netPnL, 0));
    const profitFactor = totalGrossLosses > 0 ? totalGrossWins / totalGrossLosses : totalGrossWins > 0 ? Infinity : 0;

    // Sharpe (daily returns)
    const dailyPnLs = dailyResults.map(d => d.trades.reduce((s, t) => s + t.netPnL, 0));
    const avgReturn = dailyPnLs.length > 0 ? dailyPnLs.reduce((a, b) => a + b, 0) / dailyPnLs.length : 0;
    const returnStdDev = dailyPnLs.length > 1
      ? Math.sqrt(dailyPnLs.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (dailyPnLs.length - 1))
      : 0;
    const sharpe = returnStdDev > 0 ? (avgReturn / returnStdDev) * Math.sqrt(252) : 0;

    // Breakdown by direction
    const callTrades = allTrades.filter(t => t.side === 'call');
    const putTrades = allTrades.filter(t => t.side === 'put');

    // Breakdown by exit reason
    const exitReasonCounts = {};
    for (const t of allTrades) {
      exitReasonCounts[t.exitReason] = (exitReasonCounts[t.exitReason] || 0) + 1;
    }

    // Breakdown by market condition
    const upDayTrades = [];
    const downDayTrades = [];
    for (const day of dailyResults) {
      if (day.equityCurve.length < 2) continue;
      // Simple: did the underlying close higher than open?
      const dayTrades = day.trades;
      if (dayTrades.length === 0) continue;
      const firstEntry = dayTrades[0]?.entrySpot || 0;
      const lastExit = dayTrades[dayTrades.length - 1]?.exitSpot || firstEntry;
      if (lastExit >= firstEntry) {
        upDayTrades.push(...dayTrades);
      } else {
        downDayTrades.push(...dayTrades);
      }
    }

    // Average hold time
    const avgHoldMinutes = allTrades.length > 0
      ? allTrades.reduce((s, t) => s + (t.holdMinutes || 0), 0) / allTrades.length
      : 0;

    // Total costs
    const totalSlippage = allTrades.reduce((s, t) => s + (t.slippage || 0), 0);
    const totalCommission = allTrades.reduce((s, t) => s + (t.commission || 0), 0);

    return {
      // ── Summary ──
      symbol: this.cfg.symbol,
      startDate,
      endDate,
      daysTraded: dailyResults.length,
      totalTrades: allTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: allTrades.length > 0 ? (wins.length / allTrades.length * 100).toFixed(1) : '0.0',
      avgWin: wins.length > 0 ? wins.reduce((s, t) => s + t.netPnL, 0) / wins.length : 0,
      avgLoss: losses.length > 0 ? losses.reduce((s, t) => s + t.netPnL, 0) / losses.length : 0,
      largestWin: wins.length > 0 ? Math.max(...wins.map(t => t.netPnL)) : 0,
      largestLoss: losses.length > 0 ? Math.min(...losses.map(t => t.netPnL)) : 0,
      totalNetPnL: cumPnL,
      profitFactor,
      maxDrawdown,
      sharpeRatio: sharpe,
      avgHoldMinutes,

      // ── Costs ──
      totalSlippage,
      totalCommission,
      totalCosts: totalSlippage + totalCommission,

      // ── Equity curve ──
      equityCurve,

      // ── Breakdowns ──
      byDirection: {
        calls: this._summarizeGroup(callTrades),
        puts: this._summarizeGroup(putTrades),
      },
      byExitReason: exitReasonCounts,
      byMarketCondition: {
        upDays: this._summarizeGroup(upDayTrades),
        downDays: this._summarizeGroup(downDayTrades),
      },

      // ── Raw trades ──
      trades: allTrades,
      dailyResults,

      // ── Config used ──
      config: { ...this.cfg },

      // ── Log ──
      log: [...this._log],
    };
  }

  _summarizeGroup(trades) {
    const wins = trades.filter(t => t.won);
    return {
      total: trades.length,
      wins: wins.length,
      losses: trades.length - wins.length,
      winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : '0.0',
      netPnL: trades.reduce((s, t) => s + t.netPnL, 0),
      avgPnL: trades.length > 0 ? trades.reduce((s, t) => s + t.netPnL, 0) / trades.length : 0,
    };
  }

  // ── Output & Export ───────────────────────────────────────────────

  /**
   * Print a formatted summary to console.
   */
  printSummary(results) {
    const r = results;
    const lines = [
      '',
      '═'.repeat(70),
      `  BACKTEST RESULTS: ${r.symbol}  |  ${r.startDate} to ${r.endDate}`,
      '═'.repeat(70),
      '',
      `  Days Traded:     ${r.daysTraded}`,
      `  Total Trades:    ${r.totalTrades}`,
      `  Wins / Losses:   ${r.wins} / ${r.losses}  (${r.winRate}% win rate)`,
      '',
      `  Net P&L:         $${r.totalNetPnL.toFixed(2)}`,
      `  Avg Win:         $${r.avgWin.toFixed(2)}`,
      `  Avg Loss:        $${r.avgLoss.toFixed(2)}`,
      `  Largest Win:     $${r.largestWin.toFixed(2)}`,
      `  Largest Loss:    $${r.largestLoss.toFixed(2)}`,
      '',
      `  Profit Factor:   ${r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2)}`,
      `  Max Drawdown:    $${r.maxDrawdown.toFixed(2)}`,
      `  Sharpe Ratio:    ${r.sharpeRatio.toFixed(2)}`,
      `  Avg Hold Time:   ${r.avgHoldMinutes.toFixed(1)} min`,
      '',
      '  ── Costs ──',
      `  Total Slippage:  $${r.totalSlippage.toFixed(2)}`,
      `  Total Commish:   $${r.totalCommission.toFixed(2)}`,
      `  Total Costs:     $${r.totalCosts.toFixed(2)}`,
      '',
      '  ── By Direction ──',
      `  CALLS:  ${r.byDirection.calls.total} trades, ${r.byDirection.calls.winRate}% WR, net $${r.byDirection.calls.netPnL.toFixed(2)}`,
      `  PUTS:   ${r.byDirection.puts.total} trades, ${r.byDirection.puts.winRate}% WR, net $${r.byDirection.puts.netPnL.toFixed(2)}`,
      '',
      '  ── By Market Condition ──',
      `  Up Days:   ${r.byMarketCondition.upDays.total} trades, ${r.byMarketCondition.upDays.winRate}% WR, net $${r.byMarketCondition.upDays.netPnL.toFixed(2)}`,
      `  Down Days: ${r.byMarketCondition.downDays.total} trades, ${r.byMarketCondition.downDays.winRate}% WR, net $${r.byMarketCondition.downDays.netPnL.toFixed(2)}`,
      '',
      '  ── By Exit Reason ──',
      ...Object.entries(r.byExitReason).map(([reason, count]) => `  ${reason.padEnd(25)} ${count}`),
      '',
      '═'.repeat(70),
    ];

    console.log(lines.join('\n'));
  }

  /**
   * Print individual trade details.
   */
  printTrades(results) {
    console.log('\n  ── Individual Trades ──\n');
    console.log('  ' + [
      'Date'.padEnd(12),
      'Side'.padEnd(6),
      'Strike'.padEnd(8),
      'Entry$'.padEnd(8),
      'Exit$'.padEnd(8),
      'Net P&L'.padEnd(10),
      '%'.padEnd(8),
      'Hold'.padEnd(6),
      'Conv'.padEnd(5),
      'Exit Reason'.padEnd(22),
    ].join(''));
    console.log('  ' + '-'.repeat(95));

    for (const t of results.trades) {
      const dateStr = t.date || (t.entryTime instanceof Date ? t.entryTime.toISOString().slice(0, 10) : '');
      console.log('  ' + [
        dateStr.padEnd(12),
        t.side.toUpperCase().padEnd(6),
        `$${t.strike}`.padEnd(8),
        `$${t.entryPremium.toFixed(2)}`.padEnd(8),
        `$${t.exitPremium.toFixed(2)}`.padEnd(8),
        `$${t.netPnL.toFixed(2)}`.padEnd(10),
        `${(t.pnlPct * 100).toFixed(1)}%`.padEnd(8),
        `${t.holdMinutes}m`.padEnd(6),
        `${t.conviction}`.padEnd(5),
        t.exitReason.padEnd(22),
      ].join(''));
    }
  }

  /**
   * Export results to CSV.
   *
   * @param {object} results - BacktestResult
   * @param {string} [outputPath] - File path (default: backtest-results-{symbol}-{date}.csv)
   */
  exportCSV(results, outputPath) {
    const defaultPath = path.join(
      __dirname, '..', '..', 'data',
      `backtest-${results.symbol}-${results.startDate}.csv`,
    );
    const outPath = outputPath || defaultPath;

    const headers = [
      'date', 'side', 'strike', 'delta', 'conviction', 'direction',
      'entry_spot', 'entry_premium', 'exit_spot', 'exit_premium',
      'gross_pnl', 'net_pnl', 'pnl_pct', 'slippage', 'commission',
      'hold_minutes', 'exit_reason', 'won',
      'entry_rsi', 'entry_momentum', 'entry_choppiness', 'entry_vwap_position',
    ];

    const rows = results.trades.map(t => [
      t.date,
      t.side,
      t.strike,
      t.delta?.toFixed(3) || '',
      t.conviction,
      t.direction,
      t.entrySpot?.toFixed(2),
      t.entryPremium?.toFixed(2),
      t.exitSpot?.toFixed(2),
      t.exitPremium?.toFixed(2),
      t.grossPnL?.toFixed(2),
      t.netPnL?.toFixed(2),
      (t.pnlPct * 100)?.toFixed(2),
      t.slippage?.toFixed(2),
      t.commission?.toFixed(2),
      t.holdMinutes,
      t.exitReason,
      t.won ? 1 : 0,
      t.entryTechnicals?.rsi?.toFixed(1) || '',
      t.entryTechnicals?.momentum?.toFixed(3) || '',
      t.entryTechnicals?.choppiness?.toFixed(2) || '',
      t.entryTechnicals?.priceAboveVWAP ? 'above' : 'below',
    ].join(','));

    const csv = [headers.join(','), ...rows].join('\n');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, csv);
    console.log(`\n  CSV exported to: ${outPath}`);
  }

  // ── Logging ─────────────────────────────────────────────────────

  _emit(type, message) {
    this._log.push({ type, message, time: new Date().toISOString() });
    const prefix = type === 'trade' ? '' : `[${type}] `;
    console.log(`${prefix}${message}`);
  }
}

module.exports = BacktestHarness;
