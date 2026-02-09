/**
 * Macro Environment Analysis — Druckenmiller's "50% of a stock's move"
 *
 * Assesses the overall market regime by analyzing:
 *   - S&P 500 trend (200 SMA, momentum)
 *   - Market breadth (sector participation)
 *   - Volatility (VIX proxy via SPY ATR)
 *   - Sector rotation (leading vs lagging)
 *   - Risk appetite (growth vs defensive sector spread)
 *
 * Returns a market regime classification:
 *   RISK_ON    — Bullish macro: falling rates, broad participation, low vol
 *   CAUTIOUS   — Mixed signals: selective opportunities
 *   RISK_OFF   — Bearish macro: rising vol, narrow breadth, defensive rotation
 *
 * Data sources: Alpaca (ETF bars + snapshots), FMP (fundamentals)
 */

const alpaca = require('./alpaca');
const technicals = require('./technicals');

// Sector ETFs — the full SPDR lineup + benchmarks
const SECTOR_ETFS = {
  XLK: 'Technology',
  XLF: 'Financials',
  XLE: 'Energy',
  XLV: 'Healthcare',
  XLI: 'Industrials',
  XLY: 'Consumer Discretionary',
  XLP: 'Consumer Staples',
  XLB: 'Materials',
  XLRE: 'Real Estate',
  XLC: 'Communication Services',
  XLU: 'Utilities',
};

const BENCHMARKS = {
  SPY: 'S&P 500',
  QQQ: 'Nasdaq 100',
  IWM: 'Russell 2000',
  DIA: 'Dow Jones',
};

class MacroService {
  constructor() {
    this._cache = null;
    this._cacheExpiry = 0;
    this._cacheDurationMs = 30 * 60 * 1000; // 30 minutes
  }

  /**
   * Full macro environment analysis.
   * @returns {{ regime, score, benchmarks, sectors, signals, breadth, timestamp }}
   */
  async analyze() {
    // Cache for 30 minutes
    if (this._cache && Date.now() < this._cacheExpiry) {
      return this._cache;
    }

    if (!alpaca.enabled) {
      return { regime: 'UNKNOWN', score: 0, error: 'Alpaca not configured', signals: [], timestamp: new Date().toISOString() };
    }

    const allSymbols = [...Object.keys(BENCHMARKS), ...Object.keys(SECTOR_ETFS)];
    const result = {
      regime: 'CAUTIOUS',
      score: 0,         // -100 (extreme bearish) to +100 (extreme bullish)
      benchmarks: {},
      sectors: [],
      signals: [],
      breadth: {},
      timestamp: new Date().toISOString(),
    };

    try {
      // Fetch snapshots for all ETFs in one batch call
      const snapshots = await alpaca.getSnapshots(allSymbols);
      const snapMap = new Map(snapshots.map(s => [s.ticker, s]));

      // Fetch SPY history for trend analysis (200 days)
      let spyBars = [];
      try {
        spyBars = await alpaca.getHistory('SPY', 250);
      } catch (err) {
        console.warn('[Macro] SPY history unavailable:', err.message);
      }

      // ── 1. Benchmark Analysis ──
      for (const [sym, name] of Object.entries(BENCHMARKS)) {
        const snap = snapMap.get(sym);
        if (snap) {
          result.benchmarks[sym] = {
            name,
            price: snap.price,
            changePercent: snap.changePercent,
            volume: snap.volume,
          };
        }
      }

      // ── 2. SPY Trend (200 SMA, momentum) ──
      if (spyBars.length >= 200) {
        const closes = spyBars.map(b => b.close);
        const currentPrice = closes[closes.length - 1];
        const sma200 = closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
        const sma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
        const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;

        // 1-month return
        const monthAgo = closes[closes.length - 22] || closes[0];
        const monthReturn = ((currentPrice - monthAgo) / monthAgo) * 100;

        // 3-month return
        const qtrAgo = closes[closes.length - 66] || closes[0];
        const qtrReturn = ((currentPrice - qtrAgo) / qtrAgo) * 100;

        const aboveSma200 = currentPrice > sma200;
        const aboveSma50 = currentPrice > sma50;
        const goldenCross = sma50 > sma200;

        result.benchmarks.SPY = {
          ...result.benchmarks.SPY,
          sma20: Math.round(sma20 * 100) / 100,
          sma50: Math.round(sma50 * 100) / 100,
          sma200: Math.round(sma200 * 100) / 100,
          aboveSma200,
          aboveSma50,
          goldenCross,
          monthReturn: Math.round(monthReturn * 100) / 100,
          qtrReturn: Math.round(qtrReturn * 100) / 100,
        };

        // Score contributions from SPY trend
        if (aboveSma200) { result.score += 20; result.signals.push({ type: 'bullish', msg: 'SPY above 200 SMA — long-term uptrend intact' }); }
        else { result.score -= 20; result.signals.push({ type: 'bearish', msg: 'SPY below 200 SMA — long-term downtrend' }); }

        if (goldenCross) { result.score += 10; result.signals.push({ type: 'bullish', msg: 'SPY golden cross (50 SMA > 200 SMA)' }); }
        else { result.score -= 10; result.signals.push({ type: 'bearish', msg: 'SPY death cross (50 SMA < 200 SMA)' }); }

        if (monthReturn > 3) { result.score += 10; result.signals.push({ type: 'bullish', msg: `SPY 1-month return +${monthReturn.toFixed(1)}%` }); }
        else if (monthReturn < -3) { result.score -= 10; result.signals.push({ type: 'bearish', msg: `SPY 1-month return ${monthReturn.toFixed(1)}%` }); }

        if (qtrReturn > 5) { result.score += 10; result.signals.push({ type: 'bullish', msg: `SPY 3-month return +${qtrReturn.toFixed(1)}%` }); }
        else if (qtrReturn < -5) { result.score -= 10; result.signals.push({ type: 'bearish', msg: `SPY 3-month return ${qtrReturn.toFixed(1)}%` }); }

        // Volatility proxy: distance from 20 SMA
        const volSpread = Math.abs(currentPrice - sma20) / sma20 * 100;
        if (volSpread > 3) {
          result.signals.push({ type: 'caution', msg: `SPY ${volSpread.toFixed(1)}% from 20 SMA — elevated volatility` });
        }
      }

      // ── 3. Sector Analysis ──
      const sectorData = [];
      for (const [sym, name] of Object.entries(SECTOR_ETFS)) {
        const snap = snapMap.get(sym);
        if (snap) {
          sectorData.push({
            symbol: sym,
            name,
            price: snap.price,
            changePercent: snap.changePercent || 0,
          });
        }
      }

      // Sort by performance
      sectorData.sort((a, b) => b.changePercent - a.changePercent);
      result.sectors = sectorData;

      // ── 4. Market Breadth ──
      const advancing = sectorData.filter(s => s.changePercent > 0).length;
      const declining = sectorData.filter(s => s.changePercent < 0).length;
      const totalSectors = sectorData.length;

      result.breadth = {
        advancing,
        declining,
        unchanged: totalSectors - advancing - declining,
        ratio: totalSectors > 0 ? advancing / totalSectors : 0,
      };

      if (result.breadth.ratio > 0.7) {
        result.score += 15;
        result.signals.push({ type: 'bullish', msg: `Broad participation: ${advancing}/${totalSectors} sectors advancing` });
      } else if (result.breadth.ratio < 0.3) {
        result.score -= 15;
        result.signals.push({ type: 'bearish', msg: `Narrow breadth: only ${advancing}/${totalSectors} sectors advancing` });
      }

      // ── 5. Risk Appetite (Growth vs Defensive) ──
      const growthSectors = ['XLK', 'XLY', 'XLC']; // growth / cyclical
      const defensiveSectors = ['XLU', 'XLP', 'XLV']; // defensive / safe haven

      const growthAvg = this._avgChange(sectorData, growthSectors);
      const defenseAvg = this._avgChange(sectorData, defensiveSectors);
      const riskSpread = growthAvg - defenseAvg;

      if (riskSpread > 0.5) {
        result.score += 10;
        result.signals.push({ type: 'bullish', msg: `Risk-on rotation: growth sectors leading defensives by ${riskSpread.toFixed(2)}%` });
      } else if (riskSpread < -0.5) {
        result.score -= 10;
        result.signals.push({ type: 'bearish', msg: `Defensive rotation: safe havens leading growth by ${Math.abs(riskSpread).toFixed(2)}%` });
      }

      // ── 6. Small cap vs Large cap (risk appetite) ──
      const spySnap = snapMap.get('SPY');
      const iwmSnap = snapMap.get('IWM');
      if (spySnap && iwmSnap && spySnap.changePercent != null && iwmSnap.changePercent != null) {
        const smallCapSpread = iwmSnap.changePercent - spySnap.changePercent;
        if (smallCapSpread > 0.5) {
          result.score += 5;
          result.signals.push({ type: 'bullish', msg: `Small caps outperforming (IWM vs SPY: +${smallCapSpread.toFixed(2)}%)` });
        } else if (smallCapSpread < -0.5) {
          result.score -= 5;
          result.signals.push({ type: 'bearish', msg: `Small caps underperforming (IWM vs SPY: ${smallCapSpread.toFixed(2)}%)` });
        }
      }

      // ── Classify Regime ──
      if (result.score >= 30) result.regime = 'RISK_ON';
      else if (result.score <= -30) result.regime = 'RISK_OFF';
      else result.regime = 'CAUTIOUS';

    } catch (err) {
      console.error('[Macro] Analysis error:', err.message);
      result.error = err.message;
    }

    this._cache = result;
    this._cacheExpiry = Date.now() + this._cacheDurationMs;
    return result;
  }

  /**
   * Get a simplified regime summary for the SHARK pipeline.
   * @returns {{ regime: string, score: number, positionMultiplier: number, topSectors: string[], bottomSectors: string[] }}
   */
  async getRegime() {
    const analysis = await this.analyze();

    // Position sizing multiplier based on macro regime
    let positionMultiplier = 1.0;
    if (analysis.regime === 'RISK_ON') positionMultiplier = 1.2;     // increase sizing in bullish macro
    else if (analysis.regime === 'RISK_OFF') positionMultiplier = 0.5; // halve sizing in bearish macro

    const topSectors = (analysis.sectors || []).slice(0, 3).map(s => s.name);
    const bottomSectors = (analysis.sectors || []).slice(-3).map(s => s.name);

    return {
      regime: analysis.regime,
      score: analysis.score,
      positionMultiplier,
      topSectors,
      bottomSectors,
      error: analysis.error,
    };
  }

  _avgChange(sectorData, symbols) {
    const matching = sectorData.filter(s => symbols.includes(s.symbol));
    if (matching.length === 0) return 0;
    return matching.reduce((sum, s) => sum + s.changePercent, 0) / matching.length;
  }

  clearCache() {
    this._cache = null;
    this._cacheExpiry = 0;
  }

  // ── Discord Formatting ──────────────────────────────────────────

  formatForDiscord(result) {
    if (!result) return '_Could not fetch macro data._';

    const regimeEmoji = result.regime === 'RISK_ON' ? '🟢' : result.regime === 'RISK_OFF' ? '🔴' : '🟡';
    const lines = [
      `**Macro Environment — ${regimeEmoji} ${result.regime.replace('_', ' ')}** (score: ${result.score})`,
      '',
    ];

    // Benchmarks
    if (Object.keys(result.benchmarks).length > 0) {
      lines.push('__Benchmarks__');
      for (const [sym, data] of Object.entries(result.benchmarks)) {
        const pct = data.changePercent != null ? `${data.changePercent > 0 ? '+' : ''}${data.changePercent.toFixed(2)}%` : 'n/a';
        let extra = '';
        if (data.sma200) {
          extra = ` | ${data.aboveSma200 ? 'Above' : 'Below'} 200 SMA`;
          if (data.monthReturn != null) extra += ` | 1M: ${data.monthReturn > 0 ? '+' : ''}${data.monthReturn.toFixed(1)}%`;
          if (data.qtrReturn != null) extra += ` | 3M: ${data.qtrReturn > 0 ? '+' : ''}${data.qtrReturn.toFixed(1)}%`;
        }
        lines.push(`**${sym}** (${data.name}): $${data.price?.toFixed(2) ?? '—'} (${pct})${extra}`);
      }
      lines.push('');
    }

    // Sector performance
    if (result.sectors.length > 0) {
      lines.push('__Sector Performance (Today)__');
      for (const s of result.sectors) {
        const emoji = s.changePercent > 0.3 ? '🟢' : s.changePercent < -0.3 ? '🔴' : '🟡';
        const pct = `${s.changePercent > 0 ? '+' : ''}${s.changePercent.toFixed(2)}%`;
        lines.push(`${emoji} **${s.symbol}** ${s.name}: ${pct}`);
      }
      lines.push('');
    }

    // Breadth
    if (result.breadth && result.breadth.advancing != null) {
      const b = result.breadth;
      const bar = '🟩'.repeat(b.advancing) + '⬜'.repeat(b.unchanged) + '🟥'.repeat(b.declining);
      lines.push(`__Market Breadth__`);
      lines.push(`${bar}`);
      lines.push(`Advancing: ${b.advancing} | Declining: ${b.declining} | Unchanged: ${b.unchanged}`);
      lines.push('');
    }

    // Key signals
    if (result.signals.length > 0) {
      lines.push('__Key Signals__');
      for (const sig of result.signals) {
        const emoji = sig.type === 'bullish' ? '🟢' : sig.type === 'bearish' ? '🔴' : '🟡';
        lines.push(`${emoji} ${sig.msg}`);
      }
      lines.push('');
    }

    lines.push(`_Updated: ${new Date(result.timestamp).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET_`);
    return lines.join('\n');
  }
}

module.exports = new MacroService();
