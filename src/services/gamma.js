/**
 * Gamma Exposure (GEX) Engine
 *
 * Pulls options chain data from Yahoo Finance (free, no API key needed),
 * calculates per-strike gamma exposure using Black-Scholes, finds the
 * gamma flip point, and generates bar-chart PNGs for Discord.
 *
 * Data source: Yahoo Finance options endpoint (OI, IV, strikes, expirations)
 * Spot price: FMP quote (already configured) with Yahoo fallback
 *
 * Key concepts:
 *   - GEX per strike = (CallOI × CallGamma − PutOI × PutGamma) × 100 × Spot
 *   - Gamma Flip = strike level where cumulative dealer GEX crosses zero
 *   - Above flip → dealers are long gamma (mean-reversion regime)
 *   - Below flip → dealers are short gamma (trend/volatility regime)
 */

const path = require('path');
const config = require('../config');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { registerFont } = require('canvas');
const alpaca = require('./alpaca');

const YAHOO_OPTIONS_BASE = 'https://query2.finance.yahoo.com/v7/finance/options';
const FMP_BASE = 'https://financialmodelingprep.com/stable';
const RISK_FREE_RATE = 0.045; // approximate 10Y yield

// Register bundled fonts so charts render text correctly on any server
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
try {
  registerFont(path.join(FONT_DIR, 'Inter-Regular.ttf'), { family: 'Inter' });
  registerFont(path.join(FONT_DIR, 'Inter-Bold.ttf'), { family: 'Inter', weight: 'bold' });
  console.log('[Gamma] Fonts registered: Inter Regular + Bold');
} catch (err) {
  console.warn('[Gamma] Font registration failed (chart text may render as boxes):', err.message);
}

const FONT_FAMILY = 'Inter';

// Reusable chart renderer (dark theme)
const chartRenderer = new ChartJSNodeCanvas({
  width: 700,
  height: 420,
  backgroundColour: '#1e1e2e',
  chartCallback: (ChartJS) => {
    ChartJS.defaults.font.family = FONT_FAMILY;
  },
});

// Yahoo expects browser-like headers
const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

class GammaService {
  constructor() {
    // Yahoo Finance crumb/cookie auth state (cached across calls)
    this._yahooCookie = null;
    this._yahooCrumb = null;
    this._yahooAuthExpiry = 0; // ms timestamp — refresh after 30 min
  }

  get enabled() {
    // Works with or without FMP — Yahoo Finance provides options data for free
    return true;
  }

  // ── Yahoo Finance auth (crumb + cookie) ──────────────────────────────

  /**
   * Yahoo Finance requires a session cookie + crumb token for API calls.
   * Flow:
   *   1. GET https://fc.yahoo.com → extracts "set-cookie" header
   *   2. GET https://query2.finance.yahoo.com/v1/test/getcrumb (with cookie) → returns crumb string
   *   3. Pass both cookie + crumb on all subsequent /v7/ API calls
   *
   * Cached for 30 minutes; auto-refreshes on 401.
   */
  async _ensureYahooAuth(forceRefresh = false) {
    if (!forceRefresh && this._yahooCrumb && Date.now() < this._yahooAuthExpiry) {
      return; // still valid
    }

    console.log('[Gamma] Refreshing Yahoo Finance auth (cookie + crumb)...');

    // Step 1: get session cookie
    const cookieRes = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': YAHOO_UA },
      redirect: 'manual', // don't follow — we just need the set-cookie header
      signal: AbortSignal.timeout(15000),
    });

    // Extract all Set-Cookie headers
    const rawCookies = cookieRes.headers.getSetCookie?.() || [];
    if (rawCookies.length === 0) {
      // Fallback: try raw header
      const single = cookieRes.headers.get('set-cookie');
      if (single) rawCookies.push(single);
    }

    // Build cookie string (just the key=value parts)
    const cookieParts = rawCookies.map(c => c.split(';')[0]).filter(Boolean);
    if (cookieParts.length === 0) {
      throw new Error('Yahoo Finance auth failed: no cookies returned from fc.yahoo.com');
    }
    this._yahooCookie = cookieParts.join('; ');

    // Step 2: get crumb using the cookie
    const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': YAHOO_UA,
        'Cookie': this._yahooCookie,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!crumbRes.ok) {
      const text = await crumbRes.text().catch(() => '');
      throw new Error(`Yahoo crumb fetch failed (${crumbRes.status}): ${text.slice(0, 200)}`);
    }

    this._yahooCrumb = (await crumbRes.text()).trim();
    if (!this._yahooCrumb || this._yahooCrumb.includes('Too Many Requests')) {
      throw new Error('Yahoo Finance auth failed: bad crumb value');
    }

    this._yahooAuthExpiry = Date.now() + 30 * 60 * 1000; // 30 min TTL
    console.log(`[Gamma] Yahoo auth OK (crumb: ${this._yahooCrumb.slice(0, 8)}...)`);
  }

  // ── Yahoo Finance options chain ──────────────────────────────────────

  /**
   * Fetch options chain from Yahoo Finance (with crumb auth).
   */
  async _yahooFetch(ticker, expirationEpoch) {
    await this._ensureYahooAuth();

    let url = `${YAHOO_OPTIONS_BASE}/${encodeURIComponent(ticker)}?crumb=${encodeURIComponent(this._yahooCrumb)}`;
    if (expirationEpoch) url += `&date=${expirationEpoch}`;

    console.log(`[Gamma] Yahoo options: ${ticker}${expirationEpoch ? ` exp=${expirationEpoch}` : ''}`);
    const res = await fetch(url, {
      headers: {
        'User-Agent': YAHOO_UA,
        'Accept': 'application/json',
        'Cookie': this._yahooCookie,
      },
      signal: AbortSignal.timeout(20000),
    });

    // If 401, refresh auth and retry once
    if (res.status === 401) {
      console.log('[Gamma] Got 401, refreshing Yahoo auth and retrying...');
      await this._ensureYahooAuth(true);
      return this._yahooFetchInner(ticker, expirationEpoch);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Yahoo Finance ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const result = data?.optionChain?.result?.[0];
    if (!result) throw new Error(`No options data found for ${ticker}`);

    return result;
  }

  /** Inner fetch (used for retry after auth refresh — avoids infinite loop) */
  async _yahooFetchInner(ticker, expirationEpoch) {
    let url = `${YAHOO_OPTIONS_BASE}/${encodeURIComponent(ticker)}?crumb=${encodeURIComponent(this._yahooCrumb)}`;
    if (expirationEpoch) url += `&date=${expirationEpoch}`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': YAHOO_UA,
        'Accept': 'application/json',
        'Cookie': this._yahooCookie,
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Yahoo Finance ${res.status} (after auth refresh): ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const result = data?.optionChain?.result?.[0];
    if (!result) throw new Error(`No options data found for ${ticker}`);

    return result;
  }

  /**
   * Fetch the full options chain for a ticker.
   * First call gets available expirations + first expiration's chain.
   * Prefers the nearest monthly OPEX (3rd Friday) since that's where
   * gamma exposure is most concentrated and meaningful.
   */
  async fetchOptionsChain(ticker) {
    const upper = ticker.toUpperCase();

    // First fetch — gets list of all expirations + data for the nearest one
    const initial = await this._yahooFetch(upper);
    const spotPrice = initial.quote?.regularMarketPrice;
    const expirations = initial.expirationDates || [];

    if (expirations.length === 0) {
      throw new Error(`No options expirations found for ${upper}. This ticker may not have listed options.`);
    }

    const now = Date.now() / 1000;

    // Find monthly OPEX dates (3rd Friday of each month = day 15-21 and Friday)
    const monthlyExps = expirations.filter(epoch => {
      const d = new Date(epoch * 1000);
      const dayOfWeek = d.getUTCDay(); // 5 = Friday
      const dayOfMonth = d.getUTCDate();
      return dayOfWeek === 5 && dayOfMonth >= 15 && dayOfMonth <= 21;
    });

    // Pick the nearest upcoming monthly OPEX (at least 2 days out)
    let bestExp;
    const upcomingMonthly = monthlyExps.filter(e => (e - now) / 86400 >= 2);
    if (upcomingMonthly.length > 0) {
      bestExp = upcomingMonthly[0]; // nearest monthly
    } else {
      // No monthly OPEX found — fall back to nearest future expiration with decent time
      const fallbacks = expirations.filter(e => (e - now) / 86400 >= 2);
      bestExp = fallbacks[0] || expirations[0];
    }

    // Fetch that specific expiration's chain
    const chainData = bestExp === expirations[0]
      ? initial // Already have it from the initial fetch
      : await this._yahooFetch(upper, bestExp);

    const options = chainData.options?.[0];
    if (!options) throw new Error(`No options contracts returned for ${upper}`);

    // Unify calls and puts into a single array
    const chain = [];
    const expDate = new Date(bestExp * 1000).toISOString().slice(0, 10);

    for (const c of (options.calls || [])) {
      chain.push({
        strike: c.strike,
        expiration: expDate,
        expirationEpoch: bestExp,
        type: 'call',
        openInterest: c.openInterest || 0,
        impliedVolatility: c.impliedVolatility || 0,
        volume: c.volume || 0,
        lastPrice: c.lastPrice || 0,
        bid: c.bid || 0,
        ask: c.ask || 0,
      });
    }
    for (const p of (options.puts || [])) {
      chain.push({
        strike: p.strike,
        expiration: expDate,
        expirationEpoch: bestExp,
        type: 'put',
        openInterest: p.openInterest || 0,
        impliedVolatility: p.impliedVolatility || 0,
        volume: p.volume || 0,
        lastPrice: p.lastPrice || 0,
        bid: p.bid || 0,
        ask: p.ask || 0,
      });
    }

    if (chain.length === 0) {
      throw new Error(`Options chain for ${upper} is empty — no contracts with data.`);
    }

    return { chain, spotPrice, expiration: expDate, expirationEpoch: bestExp };
  }

  // ── FMP spot price (fallback) ────────────────────────────────────────

  async _fmpSpotPrice(ticker) {
    if (!config.fmpApiKey) return null;
    try {
      const url = new URL(`${FMP_BASE}/quote`);
      url.searchParams.set('symbol', ticker);
      url.searchParams.set('apikey', config.fmpApiKey);
      const res = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const q = Array.isArray(data) ? data[0] : data;
      return q?.price || null;
    } catch {
      return null;
    }
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
   * Dealer positioning: dealers are opposite side of retail,
   * so calls sold by dealers = positive gamma, puts sold = negative gamma.
   *
   * @param {Array} chain - unified options array
   * @param {number} spotPrice - current underlying price
   * @returns {{ strikes: number[], gex: number[], totalGEX: number, maxGEX: {strike,value}, minGEX: {strike,value} }}
   */
  calculateGEX(chain, spotPrice) {
    const now = Date.now();
    const gexMap = new Map(); // strike → net GEX

    for (const opt of chain) {
      const strike = opt.strike;
      const oi = opt.openInterest || 0;
      const iv = opt.impliedVolatility || 0;
      const type = opt.type;

      if (!strike || oi === 0 || iv === 0) continue;

      // Time to expiry in years
      const expMs = opt.expirationEpoch
        ? opt.expirationEpoch * 1000
        : new Date(opt.expiration).getTime();
      const T = Math.max((expMs - now) / (365.25 * 86400000), 1 / 365);

      const gamma = this._bsGamma(spotPrice, strike, iv, T);
      // GEX = OI × gamma × 100 (contract multiplier) × spot
      const gexValue = oi * gamma * 100 * spotPrice;

      const current = gexMap.get(strike) || 0;
      if (type === 'call') {
        gexMap.set(strike, current + gexValue);
      } else if (type === 'put') {
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
      if (i > 0 && prev !== 0 && Math.sign(prev) !== Math.sign(cumulative)) {
        const ratio = Math.abs(prev) / (Math.abs(prev) + Math.abs(gex[i]));
        flipStrike = strikes[i - 1] + ratio * (strikes[i] - strikes[i - 1]);
        nearestStrikes = [strikes[i - 1], strikes[i]];
        break;
      }
    }

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
            font: { size: 16, weight: 'bold', family: FONT_FAMILY },
          },
          legend: { display: false },
        },
        scales: {
          x: {
            ticks: {
              color: '#a0a0a0',
              font: { family: FONT_FAMILY },
              maxRotation: 45,
              autoSkip: true,
              maxTicksLimit: 25,
            },
            grid: { color: 'rgba(255,255,255,0.05)' },
          },
          y: {
            ticks: { color: '#a0a0a0', font: { family: FONT_FAMILY } },
            grid: { color: 'rgba(255,255,255,0.1)' },
            title: {
              display: true,
              text: `GEX ($${unit})`,
              color: '#a0a0a0',
              font: { family: FONT_FAMILY },
            },
          },
        },
      },
      plugins: [{
        id: 'annotations',
        afterDraw(chart) {
          const ctx = chart.ctx;
          const xAxis = chart.scales.x;
          const yAxis = chart.scales.y;

          // Spot price vertical line (solid blue)
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
          ctx.font = `bold 11px ${FONT_FAMILY}, sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText(`SPOT $${spotPrice}`, spotX, yAxis.top - 5);

          // Gamma flip dashed line (yellow)
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
            ctx.font = `bold 11px ${FONT_FAMILY}, sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillText(`FLIP $${flipStrike}`, flipX, yAxis.top - 5);
          }

          ctx.restore();
        },
      }],
    };

    return chartRenderer.renderToBuffer(chartConfig);
  }

  // ── Alpaca GEX (uses pre-calculated greeks — no Black-Scholes needed) ─

  /**
   * Calculate GEX using Alpaca options snapshots.
   * Alpaca provides gamma directly, so this is more accurate than our BS estimate.
   */
  calculateGEXFromAlpaca(options, spotPrice, expiration) {
    const gexMap = new Map();

    for (const opt of options) {
      if (expiration && opt.expiration !== expiration) continue;

      const strike = opt.strike;
      const oi = opt.openInterest || 0;
      const gamma = opt.gamma || 0;
      const type = opt.type;

      if (!strike || oi === 0 || gamma === 0) continue;

      // GEX = OI × gamma × 100 (contract multiplier) × spot
      const gexValue = oi * gamma * 100 * spotPrice;

      const current = gexMap.get(strike) || 0;
      if (type === 'call') {
        gexMap.set(strike, current + gexValue);
      } else if (type === 'put') {
        gexMap.set(strike, current - gexValue);
      }
    }

    const sorted = [...gexMap.entries()].sort((a, b) => a[0] - b[0]);
    const lo = spotPrice * 0.85;
    const hi = spotPrice * 1.15;
    const filtered = sorted.filter(([k]) => k >= lo && k <= hi);

    const strikes = filtered.map(([k]) => k);
    const gex = filtered.map(([, v]) => v);

    const totalGEX = gex.reduce((a, b) => a + b, 0);
    let maxGEX = { strike: 0, value: -Infinity };
    let minGEX = { strike: 0, value: Infinity };
    for (let i = 0; i < strikes.length; i++) {
      if (gex[i] > maxGEX.value) maxGEX = { strike: strikes[i], value: gex[i] };
      if (gex[i] < minGEX.value) minGEX = { strike: strikes[i], value: gex[i] };
    }

    return { strikes, gex, totalGEX, maxGEX, minGEX };
  }

  /**
   * Pick the best monthly OPEX from Alpaca options data.
   */
  _pickAlpacaExpiration(options) {
    const now = Date.now();
    const expirations = [...new Set(options.map(o => o.expiration).filter(Boolean))].sort();

    // Find monthly OPEX dates (3rd Friday)
    const monthlyExps = expirations.filter(exp => {
      const d = new Date(exp + 'T00:00:00Z');
      return d.getUTCDay() === 5 && d.getUTCDate() >= 15 && d.getUTCDate() <= 21;
    });

    const upcoming = monthlyExps.filter(exp => new Date(exp + 'T00:00:00Z') - now > 2 * 86400000);
    if (upcoming.length > 0) return upcoming[0];

    // Fallback: nearest future expiration
    const futureExps = expirations.filter(exp => new Date(exp + 'T00:00:00Z') - now > 2 * 86400000);
    return futureExps[0] || expirations[0];
  }

  /**
   * Pre-compute the next monthly OPEX date without fetching any data.
   * Returns YYYY-MM-DD string for the 3rd Friday of the current or next month.
   */
  _computeNextMonthlyOPEX() {
    const now = new Date();

    // Check current month and next 2 months
    for (let offset = 0; offset <= 2; offset++) {
      const year = now.getFullYear();
      const month = now.getMonth() + offset;
      const d = new Date(year, month, 1);

      // Find 3rd Friday: first Friday + 14 days
      const firstDay = d.getDay(); // 0=Sun
      const firstFriday = firstDay <= 5 ? (5 - firstDay + 1) : (5 + 7 - firstDay + 1);
      const thirdFriday = firstFriday + 14;

      const opex = new Date(d.getFullYear(), d.getMonth(), thirdFriday);

      // Must be at least 2 days out
      if (opex.getTime() - now.getTime() > 2 * 86400000) {
        const yyyy = opex.getFullYear();
        const mm = String(opex.getMonth() + 1).padStart(2, '0');
        const dd = String(opex.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
      }
    }

    return null; // shouldn't happen
  }

  // ── Full analysis (single entry point) ───────────────────────────────

  /**
   * Run full GEX analysis for a ticker.
   * Prefers Alpaca (pre-calculated greeks, more reliable) → falls back to Yahoo Finance.
   *
   * @returns {{ gexData, flip, spotPrice, expiration, chartBuffer, ticker, source }}
   */
  async analyze(ticker) {
    const upper = ticker.toUpperCase();

    // ── Try Alpaca first (pre-calculated greeks, no auth headaches) ──
    if (alpaca.enabled) {
      try {
        console.log(`[Gamma] Trying Alpaca for ${upper}...`);

        // Pre-compute the monthly OPEX so we only fetch one expiration's options
        // (SPY/QQQ have daily expirations — fetching all = 10k+ contracts = timeout)
        const targetExp = this._computeNextMonthlyOPEX();
        console.log(`[Gamma] Target OPEX: ${targetExp}`);

        const [options, snapshot] = await Promise.all([
          alpaca.getOptionsSnapshots(upper, targetExp),
          alpaca.getSnapshot(upper),
        ]);

        if (options.length > 0 && snapshot.price) {
          const spotPrice = snapshot.price;
          // Use the actual expiration from returned data (may differ slightly)
          const expiration = this._pickAlpacaExpiration(options) || targetExp;

          const gexData = this.calculateGEXFromAlpaca(options, spotPrice, expiration);
          if (gexData.strikes.length > 0) {
            const flip = this.findGammaFlip(gexData, spotPrice);
            const chartBuffer = await this.generateChart(gexData, spotPrice, upper, flip.flipStrike);

            console.log(`[Gamma] ${upper}: Alpaca OK — ${options.length} contracts, exp ${expiration}`);
            return { ticker: upper, spotPrice, expiration, gexData, flip, chartBuffer, source: 'Alpaca' };
          }
        }
        console.log(`[Gamma] Alpaca returned insufficient data for ${upper}, falling back to Yahoo`);
      } catch (err) {
        console.warn(`[Gamma] Alpaca failed for ${upper}: ${err.message}, falling back to Yahoo`);
      }
    }

    // ── Fallback: Yahoo Finance ──
    const { chain, spotPrice: yahooSpot, expiration } = await this.fetchOptionsChain(upper);

    let spotPrice = yahooSpot;
    if (!spotPrice) {
      spotPrice = await this._fmpSpotPrice(upper);
    }
    if (!spotPrice) throw new Error(`Could not determine spot price for ${upper}`);

    const gexData = this.calculateGEX(chain, spotPrice);
    if (gexData.strikes.length === 0) {
      throw new Error(`Not enough options data at strikes near the current price for ${upper}`);
    }

    const flip = this.findGammaFlip(gexData, spotPrice);
    const chartBuffer = await this.generateChart(gexData, spotPrice, upper, flip.flipStrike);

    return { ticker: upper, spotPrice, expiration, gexData, flip, chartBuffer, source: 'Yahoo' };
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
      `_Data: ${result.source || 'Yahoo'}_`,
    ];

    return lines.join('\n');
  }
}

module.exports = new GammaService();
