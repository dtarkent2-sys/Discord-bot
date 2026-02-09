/**
 * Sector Rotation Analysis — Druckenmiller's "30% of a stock's move"
 *
 * Identifies which sectors/industries are leading or lagging,
 * and maps individual stocks to their sector for alignment checks.
 *
 * Uses FMP for company sector/industry data and Alpaca for ETF performance.
 *
 * Key concept: Don't pick stocks in weak sectors. Even great companies
 * underperform when their entire industry is out of favor — unless
 * there's a credible catalyst for sector rotation.
 */

const alpaca = require('./alpaca');
const yahoo = require('./yahoo'); // FMP client

// SPDR Sector ETFs → sector name mapping
const SECTOR_ETFS = {
  XLK: 'Technology',
  XLF: 'Financial Services',
  XLE: 'Energy',
  XLV: 'Healthcare',
  XLI: 'Industrials',
  XLY: 'Consumer Cyclical',
  XLP: 'Consumer Defensive',
  XLB: 'Basic Materials',
  XLRE: 'Real Estate',
  XLC: 'Communication Services',
  XLU: 'Utilities',
};

// Map FMP profile sectors → closest sector ETF
const SECTOR_TO_ETF = {
  'Technology': 'XLK',
  'Financial Services': 'XLF',
  'Energy': 'XLE',
  'Healthcare': 'XLV',
  'Industrials': 'XLI',
  'Consumer Cyclical': 'XLY',
  'Consumer Defensive': 'XLP',
  'Basic Materials': 'XLB',
  'Real Estate': 'XLRE',
  'Communication Services': 'XLC',
  'Utilities': 'XLU',
  // Aliases
  'Financial': 'XLF',
  'Consumer Discretionary': 'XLY',
  'Consumer Staples': 'XLP',
  'Materials': 'XLB',
  'Information Technology': 'XLK',
  'Health Care': 'XLV',
};

class SectorService {
  constructor() {
    this._profileCache = new Map(); // symbol → { sector, industry, expiry }
    this._sectorPerfCache = null;
    this._sectorPerfExpiry = 0;
    this._profileCacheMs = 24 * 60 * 60 * 1000; // 24h — sector doesn't change
    this._perfCacheMs = 15 * 60 * 1000; // 15 minutes
  }

  /**
   * Get sector performance data with multi-timeframe analysis.
   * Uses Alpaca ETF history to compute 1d, 1w, 1m, 3m returns.
   * @returns {Array<{symbol, name, daily, weekly, monthly, quarterly, score, rank}>}
   */
  async getSectorPerformance() {
    if (this._sectorPerfCache && Date.now() < this._sectorPerfExpiry) {
      return this._sectorPerfCache;
    }

    if (!alpaca.enabled) return [];

    const symbols = Object.keys(SECTOR_ETFS);
    const results = [];

    // Fetch 90 days of bars for each sector ETF
    const barPromises = symbols.map(async (sym) => {
      try {
        const bars = await alpaca.getHistory(sym, 95);
        return { symbol: sym, bars };
      } catch (err) {
        console.warn(`[Sectors] History failed for ${sym}: ${err.message}`);
        return { symbol: sym, bars: [] };
      }
    });

    const allBars = await Promise.all(barPromises);

    for (const { symbol, bars } of allBars) {
      if (bars.length < 5) continue;

      const closes = bars.map(b => b.close);
      const current = closes[closes.length - 1];

      // Calculate returns for different timeframes
      const daily = closes.length >= 2
        ? ((current - closes[closes.length - 2]) / closes[closes.length - 2]) * 100
        : 0;
      const weekly = closes.length >= 6
        ? ((current - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
        : 0;
      const monthly = closes.length >= 22
        ? ((current - closes[closes.length - 22]) / closes[closes.length - 22]) * 100
        : 0;
      const quarterly = closes.length >= 66
        ? ((current - closes[closes.length - 66]) / closes[closes.length - 66]) * 100
        : 0;

      // Composite score: weight recent performance more heavily
      // 40% monthly + 30% weekly + 20% quarterly + 10% daily
      const score = (monthly * 0.4) + (weekly * 0.3) + (quarterly * 0.2) + (daily * 0.1);

      results.push({
        symbol,
        name: SECTOR_ETFS[symbol],
        price: current,
        daily: Math.round(daily * 100) / 100,
        weekly: Math.round(weekly * 100) / 100,
        monthly: Math.round(monthly * 100) / 100,
        quarterly: Math.round(quarterly * 100) / 100,
        score: Math.round(score * 100) / 100,
      });
    }

    // Rank by composite score
    results.sort((a, b) => b.score - a.score);
    results.forEach((r, i) => { r.rank = i + 1; });

    this._sectorPerfCache = results;
    this._sectorPerfExpiry = Date.now() + this._perfCacheMs;
    return results;
  }

  /**
   * Get the sector and industry for a specific stock using FMP profile.
   * @param {string} symbol
   * @returns {{ sector: string, industry: string, sectorEtf: string|null }}
   */
  async getStockSector(symbol) {
    const upper = symbol.toUpperCase();

    // Check cache
    const cached = this._profileCache.get(upper);
    if (cached && Date.now() < cached.expiry) {
      return { sector: cached.sector, industry: cached.industry, sectorEtf: cached.sectorEtf };
    }

    // Fetch from FMP
    if (!yahoo.enabled) {
      return { sector: null, industry: null, sectorEtf: null };
    }

    try {
      const data = await yahoo._fmpFetch('/profile', { symbol: upper });
      const profile = Array.isArray(data) ? data[0] : data;

      if (!profile) {
        return { sector: null, industry: null, sectorEtf: null };
      }

      const sector = profile.sector || null;
      const industry = profile.industry || null;
      const sectorEtf = sector ? (SECTOR_TO_ETF[sector] || null) : null;

      this._profileCache.set(upper, {
        sector,
        industry,
        sectorEtf,
        expiry: Date.now() + this._profileCacheMs,
      });

      return { sector, industry, sectorEtf };
    } catch (err) {
      console.warn(`[Sectors] Profile fetch failed for ${upper}: ${err.message}`);
      return { sector: null, industry: null, sectorEtf: null };
    }
  }

  /**
   * Check if a stock's sector is aligned with the current rotation.
   * Returns a sector alignment score and whether the sector is favorable.
   *
   * @param {string} symbol - Stock ticker
   * @returns {{ aligned: boolean, sectorRank: number|null, sectorScore: number|null, sector: string|null, sectorEtf: string|null, industry: string|null }}
   */
  async checkAlignment(symbol) {
    const [stockSector, performance] = await Promise.all([
      this.getStockSector(symbol),
      this.getSectorPerformance(),
    ]);

    if (!stockSector.sectorEtf || performance.length === 0) {
      return {
        aligned: true, // benefit of the doubt when data unavailable
        sectorRank: null,
        sectorScore: null,
        sector: stockSector.sector,
        sectorEtf: stockSector.sectorEtf,
        industry: stockSector.industry,
      };
    }

    const sectorData = performance.find(s => s.symbol === stockSector.sectorEtf);
    if (!sectorData) {
      return {
        aligned: true,
        sectorRank: null,
        sectorScore: null,
        sector: stockSector.sector,
        sectorEtf: stockSector.sectorEtf,
        industry: stockSector.industry,
      };
    }

    // Sector is "aligned" if it's in the top half (rank <= 6 out of 11)
    // or if its composite score is positive
    const aligned = sectorData.rank <= 6 || sectorData.score > 0;

    return {
      aligned,
      sectorRank: sectorData.rank,
      sectorScore: sectorData.score,
      sectorPerf: {
        daily: sectorData.daily,
        weekly: sectorData.weekly,
        monthly: sectorData.monthly,
        quarterly: sectorData.quarterly,
      },
      sector: stockSector.sector,
      sectorEtf: stockSector.sectorEtf,
      industry: stockSector.industry,
    };
  }

  /**
   * Get leading sectors (top 3) and lagging sectors (bottom 3).
   * @returns {{ leaders: Array, laggers: Array }}
   */
  async getRotation() {
    const performance = await this.getSectorPerformance();
    return {
      leaders: performance.slice(0, 3),
      laggers: performance.slice(-3),
    };
  }

  clearCache() {
    this._profileCache.clear();
    this._sectorPerfCache = null;
    this._sectorPerfExpiry = 0;
  }

  // ── Discord Formatting ──────────────────────────────────────────

  formatForDiscord(performance) {
    if (!performance || performance.length === 0) {
      return '_Could not fetch sector data._';
    }

    const lines = [
      '**Sector Rotation — Performance Heatmap**',
      '',
      '```',
      'Rank | ETF  | Sector               | Day    | Week   | Month  | Qtr    | Score',
      '-----|------|----------------------|--------|--------|--------|--------|------',
    ];

    for (const s of performance) {
      const fmtPct = (v) => {
        const str = `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
        return str.padStart(6);
      };
      const rank = String(s.rank).padStart(2);
      const sym = s.symbol.padEnd(4);
      const name = s.name.padEnd(20).slice(0, 20);

      lines.push(
        `  ${rank} | ${sym} | ${name} | ${fmtPct(s.daily)} | ${fmtPct(s.weekly)} | ${fmtPct(s.monthly)} | ${fmtPct(s.quarterly)} | ${fmtPct(s.score)}`
      );
    }

    lines.push('```');
    lines.push('');

    // Highlight leaders and laggers
    const leaders = performance.slice(0, 3);
    const laggers = performance.slice(-3).reverse();

    lines.push('__Leading Sectors__');
    for (const s of leaders) {
      lines.push(`🟢 **${s.name}** (${s.symbol}): monthly ${s.monthly > 0 ? '+' : ''}${s.monthly.toFixed(1)}%, score ${s.score.toFixed(1)}`);
    }

    lines.push('');
    lines.push('__Lagging Sectors__');
    for (const s of laggers) {
      lines.push(`🔴 **${s.name}** (${s.symbol}): monthly ${s.monthly > 0 ? '+' : ''}${s.monthly.toFixed(1)}%, score ${s.score.toFixed(1)}`);
    }

    lines.push('');
    lines.push(`_Composite score: 40% monthly + 30% weekly + 20% quarterly + 10% daily_`);
    lines.push(`_Updated: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET_`);

    return lines.join('\n');
  }
}

module.exports = new SectorService();
