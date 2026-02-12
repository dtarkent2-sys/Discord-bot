const path = require('path');

// Ensure fontconfig can find a config file before canvas initialises.
// On minimal deployment images (Railway/NIXPACKS) the default path may be missing.
if (!process.env.FONTCONFIG_PATH) {
  const candidates = ['/etc/fonts', '/usr/share/fontconfig'];
  const fs = require('fs');
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'fonts.conf'))) {
      process.env.FONTCONFIG_PATH = dir;
      break;
    }
  }
  // Last resort: point at our bundled minimal config
  if (!process.env.FONTCONFIG_PATH) {
    const bundledConf = path.join(__dirname, '..', '..', 'assets', 'fontconfig');
    if (fs.existsSync(path.join(bundledConf, 'fonts.conf'))) {
      process.env.FONTCONFIG_PATH = bundledConf;
    }
  }
}

const config = require('../config');
const alpaca = require('./alpaca');
const priceFetcher = require('../tools/price-fetcher');

const YAHOO_OPTIONS_BASE = 'https://query2.finance.yahoo.com/v7/finance/options';
const FMP_BASE = 'https://financialmodelingprep.com/stable';
const RISK_FREE_RATE = 0.045; // approximate 10Y yield

const FONT_FAMILY = 'Inter';

// Canvas/chartjs are native modules that may fail to load on some platforms.
// If unavailable, GEX analysis still works but chart rendering is disabled.
let chartRenderer = null;

try {
  const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
  const { registerFont } = require('canvas');

  // Register bundled fonts so charts render text correctly on any server
  const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
  try {
    registerFont(path.join(FONT_DIR, 'Inter-Regular.ttf'), { family: 'Inter' });
    registerFont(path.join(FONT_DIR, 'Inter-Bold.ttf'), { family: 'Inter', weight: 'bold' });
    console.log('[Gamma] Fonts registered: Inter Regular + Bold');
  } catch (fontErr) {
    console.warn('[Gamma] Font registration failed (chart text may render as boxes):', fontErr.message);
  }

  chartRenderer = new ChartJSNodeCanvas({
    width: 700,
    height: 420,
    backgroundColour: '#1e1e2e',
    chartCallback: (ChartJS) => {
      ChartJS.defaults.font.family = FONT_FAMILY;
    },
  });

  console.log('[Gamma] Canvas/chart renderer loaded successfully');
} catch (err) {
  console.warn('[Gamma] Canvas module failed to load — chart rendering disabled:', err.message);
}

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

  // ── Yahoo Finance auth (crumb + cookie) ───────────────────────────────────────

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
      // Empty cookie list means no new set-cookie header was sent
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

  // ── Yahoo Finance options chain ────────────────────────────────────────────────

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
   *
   * @param {string} ticker - Stock symbol
   * @param {string} [expirationPref='0dte'] - '0dte', 'weekly', or 'monthly'
   */
  async fetchOptionsChain(ticker, expirationPref = '0dte') {
    const upper = ticker.toUpperCase();

    // First fetch — gets list of all expirations + data for the nearest one
    const initial = await this._yahooFetch(upper);
    const spotPrice = initial.quote?.regularMarketPrice;
    const expirations = initial.expirationDates || [];

    if (expirations.length === 0) {
      throw new Error(`No options expirations found for ${upper}. This ticker may not have listed options.`);
    }

    const now = Date.now() / 1000;
    const targetDate = this._computeTargetDate(expirationPref);
    const targetEpoch = new Date(targetDate + 'T00:00:00Z').getTime() / 1000;

    let bestExp;

    if (expirationPref === '0dte') {
      // Look for today's expiration
      const todayMatch = expirations.find(e => {
        const d = new Date(e * 1000);
        return this._formatDate(d) === targetDate;
      });
      if (todayMatch) {
        bestExp = todayMatch;
      } else {
        // No 0DTE — pick nearest future expiration
        const future = expirations.filter(e => e >= now);
        bestExp = future[0] || expirations[0];
        console.log(`[Gamma] No 0DTE available for ${upper}, using nearest: ${new Date(bestExp * 1000).toISOString().slice(0, 10)}`);
      }
    } else if (expirationPref === 'weekly') {
      // Find closest to this week's Friday
      bestExp = expirations.reduce((best, e) =>
        Math.abs(e - targetEpoch) < Math.abs(best - targetEpoch) ? e : best
      );
    } else {
      // Monthly — find 3rd Friday OPEX dates
      const monthlyExps = expirations.filter(epoch => {
        const d = new Date(epoch * 1000);
        return d.getUTCDay() === 5 && d.getUTCDate() >= 15 && d.getUTCDate() <= 21;
      });
      const upcomingMonthly = monthlyExps.filter(e => e >= now);
      if (upcomingMonthly.length > 0) {
        bestExp = upcomingMonthly[0];
      } else {
        bestExp = expirations.reduce((best, e) =>
          Math.abs(e - targetEpoch) < Math.abs(best - targetEpoch) ? e : best
        );
      }
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

  // ── FMP spot price (fallback) ────────────────────────────────────────────────

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

  // ── Black-Scholes gamma ───────────────────────────────────────────────────────

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

  // ── GEX calculation ───────────────────────────────────────────────────────────

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

  // ── Detailed GEX (canonical per-strike breakdown) ─────────────────────────────

  /**
   * Calculate detailed per-strike Gamma Exposure with call/put breakdown.
   *
   * Returns canonical strike data for the multi-expiry engine:
   *   GEX$ (dealer perspective) = OI × BS_gamma × 100 × spot
   *   - callGEX$ is positive (dealers short calls → long gamma)
   *   - putGEX$ is negative (dealers short puts → short gamma)
   *   - netGEX$ = callGEX$ + putGEX$
   *
   * @param {Array} chain - unified options array from fetchOptionsChain
   * @param {number} spotPrice - current underlying price
   * @returns {{ strikes: Array<{strike,callOI,putOI,callGamma,putGamma,callGEX$,putGEX$,netGEX$}>, totalNetGEX$: number }}
   */
  calculateDetailedGEX(chain, spotPrice) {
    const now = Date.now();
    const strikeMap = new Map(); // strike → { callOI, putOI, callGamma, putGamma, callGEX$, putGEX$ }

    for (const opt of chain) {
      const strike = opt.strike;
      const oi = opt.openInterest || 0;
      const iv = opt.impliedVolatility || 0;
      const type = opt.type;

      if (!strike || oi === 0 || iv === 0) continue;

      const expMs = opt.expirationEpoch
        ? opt.expirationEpoch * 1000
        : new Date(opt.expiration).getTime();
      const T = Math.max((expMs - now) / (365.25 * 86400000), 1 / 365);
      const gamma = this._bsGamma(spotPrice, strike, iv, T);
      const gexDollar = oi * gamma * 100 * spotPrice;

      const entry = strikeMap.get(strike) || {
        callOI: 0, putOI: 0, callGamma: 0, putGamma: 0, 'callGEX$': 0, 'putGEX$': 0,
      };

      if (type === 'call') {
        entry.callOI += oi;
        entry.callGamma = gamma; // last-seen gamma (one call per strike per expiry)
        entry['callGEX$'] += gexDollar;
      } else if (type === 'put') {
        entry.putOI += oi;
        entry.putGamma = gamma;
        entry['putGEX$'] -= gexDollar; // negative for dealer short puts
      }

      strikeMap.set(strike, entry);
    }

    const lo = spotPrice * 0.85;
    const hi = spotPrice * 1.15;

    const strikes = [...strikeMap.entries()]
      .filter(([k]) => k >= lo && k <= hi)
      .sort((a, b) => a[0] - b[0])
      .map(([strike, data]) => ({
        strike,
        callOI: data.callOI,
        putOI: data.putOI,
        callGamma: data.callGamma,
        putGamma: data.putGamma,
        'callGEX$': data['callGEX$'],
        'putGEX$': data['putGEX$'],
        'netGEX$': data['callGEX$'] + data['putGEX$'],
      }));

    const totalNetGEX = strikes.reduce((sum, s) => sum + s['netGEX$'], 0);

    return { strikes, 'totalNetGEX$': totalNetGEX };
  }

  /**
   * Detailed GEX using Alpaca pre-calculated greeks.
   * Same canonical output as calculateDetailedGEX but uses Alpaca gamma directly.
   */
  calculateDetailedGEXFromAlpaca(options, spotPrice, expiration) {
    const strikeMap = new Map();

    for (const opt of options) {
      if (expiration && opt.expiration !== expiration) continue;

      const strike = opt.strike;
      const oi = opt.openInterest || 0;
      const gamma = opt.gamma || 0;
      const type = opt.type;

      if (!strike || oi === 0 || gamma === 0) continue;

      const gexDollar = oi * gamma * 100 * spotPrice;
      const entry = strikeMap.get(strike) || {
        callOI: 0, putOI: 0, callGamma: 0, putGamma: 0, 'callGEX$': 0, 'putGEX$': 0,
      };

      if (type === 'call') {
        entry.callOI += oi;
        entry.callGamma = gamma;
        entry['callGEX$'] += gexDollar;
      } else if (type === 'put') {
        entry.putOI += oi;
        entry.putGamma = gamma;
        entry['putGEX$'] -= gexDollar;
      }

      strikeMap.set(strike, entry);
    }

    const lo = spotPrice * 0.85;
    const hi = spotPrice * 1.15;

    const strikes = [...strikeMap.entries()]
      .filter(([k]) => k >= lo && k <= hi)
      .sort((a, b) => a[0] - b[0])
      .map(([strike, data]) => ({
        strike,
        callOI: data.callOI,
        putOI: data.putOI,
        callGamma: data.callGamma,
        putGamma: data.putGamma,
        'callGEX$': data['callGEX$'],
        'putGEX$': data['putGEX$'],
        'netGEX$': data['callGEX$'] + data['putGEX$'],
      }));

    const totalNetGEX = strikes.reduce((sum, s) => sum + s['netGEX$'], 0);
    return { strikes, 'totalNetGEX$': totalNetGEX };
  }

  // ── Multi-expiry fetch ──────────────────────────────────────────────────

  /**
   * Fetch available expirations for a ticker from Yahoo Finance.
   * Returns sorted array of { epoch, date } objects.
   */
  async fetchAvailableExpirations(ticker) {
    const upper = ticker.toUpperCase();
    const initial = await this._yahooFetch(upper);
    const epochs = initial.expirationDates || [];
    return epochs.map(e => ({
      epoch: e,
      date: new Date(e * 1000).toISOString().slice(0, 10),
    }));
  }

  /**
   * Analyze a ticker across multiple expirations.
   * Returns canonical structure used by gex-engine for aggregation.
   *
   * @param {string} ticker
   * @param {string[]} expiryPrefs - e.g. ['0dte', 'weekly', 'monthly'] or explicit dates
   * @returns {{ ticker, spotPrice, expirations: Array<{expiry, detailedGEX, gexData, flip}>, source }}
   */
  async analyzeMultiExpiry(ticker, expiryPrefs = ['0dte', 'weekly', 'monthly']) {
    const upper = ticker.toUpperCase();
    const results = [];
    let spotPrice = null;
    let source = 'Yahoo';

    for (const pref of expiryPrefs) {
      try {
        const result = await this.analyze(upper, pref);
        if (!spotPrice) spotPrice = result.spotPrice;
        source = result.source;

        // Now compute detailed GEX for this expiry
        let detailedGEX;
        if (result.source === 'Alpaca') {
          // Re-fetch Alpaca data for detailed breakdown
          const targetExp = this._computeTargetDate(pref);
          const [options] = await Promise.all([
            alpaca.getOptionsSnapshots(upper, targetExp),
          ]);
          const expiration = this._pickAlpacaExpiration(options, pref) || targetExp;
          detailedGEX = this.calculateDetailedGEXFromAlpaca(options, spotPrice, expiration);
        } else {
          // Re-fetch Yahoo chain for detailed breakdown
          const { chain } = await this.fetchOptionsChain(upper, pref);
          detailedGEX = this.calculateDetailedGEX(chain, spotPrice);
        }

        results.push({
          expiry: result.expiration,
          detailedGEX,
          gexData: result.gexData,
          flip: result.flip,
          chartBuffer: result.chartBuffer,
        });
      } catch (err) {
        console.warn(`[Gamma] Multi-expiry: failed ${pref} for ${upper}: ${err.message}`);
      }
    }

    if (results.length === 0) {
      throw new Error(`No options data available for ${upper} across requested expirations`);
    }

    if (!spotPrice) throw new Error(`Could not determine spot price for ${upper}`);

    return { ticker: upper, spotPrice, expirations: results, source };
  }

  // ── Gamma flip detection ───────────────────────────────────────────────────

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

  // ── Chart generation ─────────────────────────────────────────────────────────

  /**
   * Generate a GEX bar chart as a PNG buffer (for Discord attachment).
   * Green bars = positive GEX (call wall), Red bars = negative GEX (put wall).
   * Vertical line at spot price, dashed line at gamma flip.
   */
  async generateChart(gexData, spotPrice, ticker, flipStrike) {
    if (!chartRenderer) return null;

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

  // ── Discord formatting ───────────────────────────────────────────────────

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