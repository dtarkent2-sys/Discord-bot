/**
 * Gamma Exposure (GEX) Engine
 *
 * Pulls options chain data from FMP, calculates per-strike gamma exposure
 * using Black-Scholes, finds the gamma flip point (where net GEX crosses
 * zero), and generates bar-chart PNGs for Discord.
 *
 * Key concepts:
 *   - GEX per strike = (CallOI × CallGamma − PutOI × PutGamma) × 100 × Spot
 *   - Gamma Flip = strike level where cumulative dealer GEX crosses zero
 *   - Above flip → dealers are long gamma (mean-reversion regime)
 *   - Below flip → dealers are short gamma (trend/volatility regime)
 */

const config = require('../config');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

const FMP_BASE = 'https://financialmodelingprep.com/stable';
const RISK_FREE_RATE = 0.045; // approximate 10Y yield — tweak as needed

// Reusable chart renderer (600×400, dark theme)
const chartRenderer = new ChartJSNodeCanvas({ width: 700, height: 420, backgroundColour: '#1e1e2e' });

class GammaService {
  get enabled() {
    return !!config.fmpApiKey;
  }

  // ── FMP fetch helper (mirrors yahoo.js pattern) ──────────────────────

  async _fmpFetch(endpoint, params = {}) {
    if (!config.fmpApiKey) throw new Error('FMP_API_KEY not set');

    const url = new URL(`${FMP_BASE}${endpoint}`);
    url.searchParams.set('apikey', config.fmpApiKey);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }

    console.log(`[Gamma] Fetching: ${endpoint} ${JSON.stringify(params)}`);
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`FMP ${res.status}: ${text.slice(0, 200)}`);
    }

    return res.json();
  }

  // ── Options chain from FMP ───────────────────────────────────────────

  /**
   * Fetch the full options chain for a ticker.
   * Returns an array of { strike, expiration, type, openInterest, impliedVolatility, ... }
   */
  async fetchOptionsChain(ticker) {
    const upper = ticker.toUpperCase();

    const data = await this._fmpFetch('/options/chain', { symbol: upper });
    const chain = Array.isArray(data) ? data : [];

    if (chain.length === 0) {
      throw new Error(`No options data returned for ${upper}. The ticker may not have listed options or your FMP plan may not include options data.`);
    }

    return chain;
  }

  /**
   * Get the nearest monthly expiration from a chain.
   * Picks the expiration with the most open interest that's 14-45 days out
   * (the "front month" where gamma is most concentrated).
   */
  pickFrontExpiration(chain) {
    const now = Date.now();
    const minDays = 7;
    const maxDays = 50;

    // Group OI by expiration
    const oiByExp = {};
    for (const opt of chain) {
      const exp = opt.expiration || opt.expirationDate;
      if (!exp) continue;
      const daysOut = (new Date(exp) - now) / 86400000;
      if (daysOut < minDays || daysOut > maxDays) continue;
      oiByExp[exp] = (oiByExp[exp] || 0) + (opt.openInterest || 0);
    }

    const exps = Object.entries(oiByExp);
    if (exps.length === 0) {
      // Fallback: nearest expiration overall
      const allExps = [...new Set(chain.map(o => o.expiration || o.expirationDate).filter(Boolean))].sort();
      return allExps[0] || null;
    }

    // Pick the one with max OI
    exps.sort((a, b) => b[1] - a[1]);
    return exps[0][0];
  }

  // ── Black-Scholes gamma ──────────────────────────────────────────────

  _normalPDF(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  }

  _d1(S, K, r, sigma, T) {
    return (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  }

  /**
   * Black-Scholes gamma for a single option.
   * @param {number} S - spot price
   * @param {number} K - strike price
   * @param {number} sigma - implied volatility (decimal, e.g. 0.30 = 30%)
   * @param {number} T - time to expiry in years
   * @returns {number} gamma value
   */
  _bsGamma(S, K, sigma, T) {
    if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return 0;
    const d1 = this._d1(S, K, RISK_FREE_RATE, sigma, T);
    return this._normalPDF(d1) / (S * sigma * Math.sqrt(T));
  }

  // ── GEX calculation ──────────────────────────────────────────────────

  /**
   * Calculate net Gamma Exposure (GEX) per strike.
   *
   * For each strike:
   *   callGEX = callOI × bsGamma(call) × 100 × spotPrice
   *   putGEX  = putOI  × bsGamma(put)  × 100 × spotPrice
   *   netGEX  = callGEX − putGEX
   *
   * Dealer positioning: dealers are opposite side of retail,
   * so calls sold by dealers = positive gamma, puts sold = negative gamma.
   *
   * @param {Array} chain - full options chain from FMP
   * @param {number} spotPrice - current underlying price
   * @param {string} [expiration] - filter to a specific expiration (optional)
   * @returns {{ strikes: number[], gex: number[], totalGEX: number, maxGEX: {strike,value}, minGEX: {strike,value} }}
   */
  calculateGEX(chain, spotPrice, expiration) {
    const now = Date.now();
    const gexMap = new Map(); // strike → net GEX

    for (const opt of chain) {
      const exp = opt.expiration || opt.expirationDate;
      if (expiration && exp !== expiration) continue;

      const strike = opt.strike;
      const oi = opt.openInterest || 0;
      const iv = opt.impliedVolatility || 0;
      const type = (opt.type || opt.optionType || '').toLowerCase();

      if (!strike || oi === 0 || iv === 0) continue;

      // Time to expiry in years
      const T = Math.max((new Date(exp) - now) / (365.25 * 86400000), 1 / 365);

      const gamma = this._bsGamma(spotPrice, strike, iv, T);
      // GEX = OI × gamma × 100 (contract multiplier) × spot
      const gexValue = oi * gamma * 100 * spotPrice;

      const current = gexMap.get(strike) || 0;
      if (type === 'call') {
        // Dealers short calls → long gamma when calls are bought
        gexMap.set(strike, current + gexValue);
      } else if (type === 'put') {
        // Dealers short puts → short gamma when puts are bought
        gexMap.set(strike, current - gexValue);
      }
    }

    // Sort by strike
    const sorted = [...gexMap.entries()].sort((a, b) => a[0] - b[0]);

    // Filter to strikes within ±15% of spot (avoid far OTM noise)
    const lo = spotPrice * 0.85;
    const hi = spotPrice * 1.15;
    const filtered = sorted.filter(([k]) => k >= lo && k <= hi);

    const strikes = filtered.map(([k]) => k);
    const gex = filtered.map(([, v]) => v);

    // Summary stats
    const totalGEX = gex.reduce((a, b) => a + b, 0);
    let maxGEX = { strike: 0, value: -Infinity };
    let minGEX = { strike: 0, value: Infinity };
    for (let i = 0; i < strikes.length; i++) {
      if (gex[i] > maxGEX.value) maxGEX = { strike: strikes[i], value: gex[i] };
      if (gex[i] < minGEX.value) minGEX = { strike: strikes[i], value: gex[i] };
    }

    return { strikes, gex, totalGEX, maxGEX, minGEX };
  }

  // ── Gamma flip detection ─────────────────────────────────────────────

  /**
   * Find the gamma flip point — the strike where cumulative GEX crosses zero.
   * This is the "magnet" level. Above it, dealers hedge by selling into rallies
   * (suppresses volatility). Below it, dealers amplify moves (increases vol).
   *
   * @returns {{ flipStrike: number|null, regime: 'long_gamma'|'short_gamma', nearestStrikes: [number,number] }}
   */
  findGammaFlip(gexData, spotPrice) {
    const { strikes, gex } = gexData;
    if (strikes.length === 0) return { flipStrike: null, regime: 'unknown', nearestStrikes: [] };

    // Walk strikes from low to high, accumulate GEX
    let cumulative = 0;
    let flipStrike = null;
    let nearestStrikes = [];

    for (let i = 0; i < strikes.length; i++) {
      const prev = cumulative;
      cumulative += gex[i];

      // Zero crossing — interpolate between adjacent strikes
      if (prev !== 0 && Math.sign(prev) !== Math.sign(cumulative)) {
        // Linear interpolation for more precise flip level
        const ratio = Math.abs(prev) / (Math.abs(prev) + Math.abs(gex[i]));
        flipStrike = strikes[i - 1] + ratio * (strikes[i] - strikes[i - 1]);
        nearestStrikes = [strikes[i - 1], strikes[i]];
        break;
      }
    }

    // If no crossing found, determine regime from total
    const regime = spotPrice > (flipStrike || 0) ? 'long_gamma' : 'short_gamma';

    return {
      flipStrike: flipStrike ? Math.round(flipStrike * 100) / 100 : null,
      regime,
      nearestStrikes,
    };
  }

  // ── Chart generation ─────────────────────────────────────────────────

  /**
   * Generate a GEX bar chart as a PNG buffer (for Discord attachment).
   * Green bars = positive GEX (call wall), Red bars = negative GEX (put wall).
   * Vertical line at spot price, dashed line at gamma flip.
   */
  async generateChart(gexData, spotPrice, ticker, flipStrike) {
    const { strikes, gex } = gexData;

    // Normalize GEX to millions for readable axis
    const scale = Math.max(...gex.map(Math.abs));
    const divisor = scale > 1e9 ? 1e9 : scale > 1e6 ? 1e6 : 1;
    const unit = divisor === 1e9 ? 'B' : divisor === 1e6 ? 'M' : '';
    const scaledGex = gex.map(v => v / divisor);

    // Color: green for positive, red for negative
    const colors = scaledGex.map(v => v >= 0 ? 'rgba(34, 197, 94, 0.85)' : 'rgba(239, 68, 68, 0.85)');
    const borderColors = scaledGex.map(v => v >= 0 ? 'rgb(34, 197, 94)' : 'rgb(239, 68, 68)');

    // Find spot price index for annotation
    const spotIdx = strikes.reduce((best, s, i) =>
      Math.abs(s - spotPrice) < Math.abs(strikes[best] - spotPrice) ? i : best, 0);

    const chartConfig = {
      type: 'bar',
      data: {
        labels: strikes.map(s => `$${s}`),
        datasets: [{
          label: `Net GEX ($${unit})`,
          data: scaledGex,
          backgroundColor: colors,
          borderColor: borderColors,
          borderWidth: 1,
        }],
      },
      options: {
        responsive: false,
        plugins: {
          title: {
            display: true,
            text: `${ticker.toUpperCase()} — Gamma Exposure by Strike`,
            color: '#e0e0e0',
            font: { size: 16, weight: 'bold' },
          },
          legend: { display: false },
        },
        scales: {
          x: {
            ticks: {
              color: '#a0a0a0',
              maxRotation: 45,
              autoSkip: true,
              maxTicksLimit: 25,
            },
            grid: { color: 'rgba(255,255,255,0.05)' },
          },
          y: {
            ticks: { color: '#a0a0a0' },
            grid: { color: 'rgba(255,255,255,0.1)' },
            title: {
              display: true,
              text: `GEX ($${unit})`,
              color: '#a0a0a0',
            },
          },
        },
      },
      plugins: [{
        // Custom plugin: draw spot price line + gamma flip line
        id: 'annotations',
        afterDraw(chart) {
          const ctx = chart.ctx;
          const xAxis = chart.scales.x;
          const yAxis = chart.scales.y;

          // Spot price vertical line
          const spotX = xAxis.getPixelForValue(spotIdx);
          ctx.save();
          ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)';
          ctx.lineWidth = 2;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(spotX, yAxis.top);
          ctx.lineTo(spotX, yAxis.bottom);
          ctx.stroke();

          // Spot label
          ctx.fillStyle = 'rgba(59, 130, 246, 1)';
          ctx.font = 'bold 11px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(`SPOT $${spotPrice}`, spotX, yAxis.top - 5);

          // Gamma flip dashed line
          if (flipStrike) {
            const flipIdx = strikes.reduce((best, s, i) =>
              Math.abs(s - flipStrike) < Math.abs(strikes[best] - flipStrike) ? i : best, 0);
            const flipX = xAxis.getPixelForValue(flipIdx);

            ctx.strokeStyle = 'rgba(250, 204, 21, 0.9)';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            ctx.moveTo(flipX, yAxis.top);
            ctx.lineTo(flipX, yAxis.bottom);
            ctx.stroke();

            ctx.fillStyle = 'rgba(250, 204, 21, 1)';
            ctx.font = 'bold 11px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(`FLIP $${flipStrike}`, flipX, yAxis.top - 5);
          }

          ctx.restore();
        },
      }],
    };

    return chartRenderer.renderToBuffer(chartConfig);
  }

  // ── Full analysis (single entry point) ───────────────────────────────

  /**
   * Run full GEX analysis for a ticker:
   *   1. Fetch options chain
   *   2. Get spot price from first option's underlying or fall back to FMP quote
   *   3. Pick front-month expiration
   *   4. Calculate GEX per strike
   *   5. Find gamma flip
   *   6. Render chart
   *
   * @returns {{ gexData, flip, spotPrice, expiration, chartBuffer, ticker }}
   */
  async analyze(ticker) {
    const upper = ticker.toUpperCase();

    // Fetch chain + spot price in parallel
    const [chain, quoteData] = await Promise.all([
      this.fetchOptionsChain(upper),
      this._fmpFetch('/quote', { symbol: upper }).catch(() => null),
    ]);

    const quote = Array.isArray(quoteData) ? quoteData?.[0] : quoteData;
    const spotPrice = quote?.price || chain[0]?.underlyingPrice || chain[0]?.lastPrice;
    if (!spotPrice) throw new Error(`Could not determine spot price for ${upper}`);

    // Pick best expiration
    const expiration = this.pickFrontExpiration(chain);
    if (!expiration) throw new Error(`No valid expirations found for ${upper}`);

    // Calculate GEX
    const gexData = this.calculateGEX(chain, spotPrice, expiration);
    if (gexData.strikes.length === 0) {
      throw new Error(`Not enough options data at strikes near the current price for ${upper}`);
    }

    // Find gamma flip
    const flip = this.findGammaFlip(gexData, spotPrice);

    // Generate chart
    const chartBuffer = await this.generateChart(gexData, spotPrice, upper, flip.flipStrike);

    return {
      ticker: upper,
      spotPrice,
      expiration,
      gexData,
      flip,
      chartBuffer,
    };
  }

  // ── Discord formatting ───────────────────────────────────────────────

  formatForDiscord(result) {
    const { ticker, spotPrice, expiration, gexData, flip } = result;
    const { totalGEX, maxGEX, minGEX } = gexData;

    const scale = Math.abs(totalGEX) > 1e9 ? 1e9 : Math.abs(totalGEX) > 1e6 ? 1e6 : 1;
    const unit = scale === 1e9 ? 'B' : scale === 1e6 ? 'M' : '';
    const fmt = (v) => `$${(v / scale).toFixed(2)}${unit}`;

    const regimeEmoji = flip.regime === 'long_gamma' ? '🟢' : '🔴';
    const regimeLabel = flip.regime === 'long_gamma'
      ? 'Long Gamma (dealers suppress moves — mean-reversion)'
      : 'Short Gamma (dealers amplify moves — trend/volatility)';

    const lines = [
      `**${ticker} — Gamma Exposure Analysis**`,
      `Expiration: \`${expiration}\` | Spot: \`$${spotPrice}\``,
      ``,
      `${regimeEmoji} **Regime:** ${regimeLabel}`,
      flip.flipStrike
        ? `⚡ **Gamma Flip:** \`$${flip.flipStrike}\` ${spotPrice > flip.flipStrike ? '(spot is ABOVE flip)' : '(spot is BELOW flip)'}`
        : `⚡ **Gamma Flip:** Not detected in range`,
      ``,
      `📊 **Net GEX:** ${fmt(totalGEX)}`,
      `🟢 **Call Wall (max GEX):** \`$${maxGEX.strike}\` (${fmt(maxGEX.value)})`,
      `🔴 **Put Wall (min GEX):** \`$${minGEX.strike}\` (${fmt(minGEX.value)})`,
      ``,
      `_Call wall = magnet/resistance | Put wall = support | Flip = regime boundary_`,
    ];

    return lines.join('\n');
  }
}

module.exports = new GammaService();
