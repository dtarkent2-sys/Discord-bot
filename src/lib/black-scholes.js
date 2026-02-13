/**
 * Black-Scholes Greeks & IV Estimation — Shared Core
 *
 * Single source of truth for BS pricing, gamma, vega, and implied volatility.
 * Used by: gamma.js, gamma-heatmap.js, gex-heatmap.js
 *
 * Risk-free rate auto-fetches from US Treasury Direct API at startup
 * and refreshes daily. Falls back to 4.5% if the fetch fails.
 */

const https = require('https');

// ── Risk-Free Rate (auto-updated) ──────────────────────────────────────

let _riskFreeRate = 0.045; // default fallback
let _lastRateFetch = 0;
const RATE_TTL_MS = 24 * 60 * 60 * 1000; // refresh daily

/**
 * Fetch the most recent 10-year Treasury yield from US Treasury Direct.
 * Free API, no key required.
 */
function _fetchTreasuryYield() {
  return new Promise((resolve) => {
    const url = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/'
      + 'v2/accounting/od/avg_interest_rates'
      + '?filter=security_desc:eq:Treasury Notes'
      + '&sort=-record_date&page[size]=1'
      + '&fields=record_date,avg_interest_rate_amt';

    const req = https.get(url, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          const rate = parseFloat(json.data?.[0]?.avg_interest_rate_amt);
          if (rate > 0 && rate < 20) {
            resolve(rate / 100); // convert 4.5 → 0.045
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function _refreshRate() {
  if (Date.now() - _lastRateFetch < RATE_TTL_MS) return;
  const rate = await _fetchTreasuryYield();
  if (rate !== null) {
    const old = _riskFreeRate;
    _riskFreeRate = rate;
    _lastRateFetch = Date.now();
    if (Math.abs(old - rate) > 0.001) {
      console.log(`[BlackScholes] Risk-free rate updated: ${(old * 100).toFixed(2)}% → ${(rate * 100).toFixed(2)}%`);
    }
  } else {
    _lastRateFetch = Date.now(); // don't retry immediately on failure
    console.warn(`[BlackScholes] Treasury yield fetch failed, using ${(_riskFreeRate * 100).toFixed(2)}%`);
  }
}

// Fire-and-forget at startup
_refreshRate();

/** Get current risk-free rate (auto-refreshes daily in background). */
function getRiskFreeRate() {
  // Trigger background refresh if stale (non-blocking)
  if (Date.now() - _lastRateFetch > RATE_TTL_MS) _refreshRate();
  return _riskFreeRate;
}

// ── Math Primitives ────────────────────────────────────────────────────

const SQRT_2PI = Math.sqrt(2 * Math.PI);

function normalPDF(x) {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

/** Abramowitz-Stegun CDF approximation (~4-5 decimal accuracy) */
function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}

// ── Black-Scholes Pricing ──────────────────────────────────────────────

function d1(S, K, r, sigma, T) {
  return (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
}

function bsPrice(S, K, r, sigma, T, isCall) {
  const d1v = d1(S, K, r, sigma, T);
  const d2 = d1v - sigma * Math.sqrt(T);
  const Nd1 = normalCDF(d1v);
  const Nd2 = normalCDF(d2);
  if (isCall) return S * Nd1 - K * Math.exp(-r * T) * Nd2;
  return K * Math.exp(-r * T) * (1 - Nd2) - S * (1 - Nd1);
}

function bsGamma(S, K, sigma, T) {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return 0;
  const r = getRiskFreeRate();
  const d1v = d1(S, K, r, sigma, T);
  return normalPDF(d1v) / (S * sigma * Math.sqrt(T));
}

function bsVega(S, K, r, sigma, T) {
  const d1v = d1(S, K, r, sigma, T);
  return S * normalPDF(d1v) * Math.sqrt(T);
}

// ── Implied Volatility — Binary Search ─────────────────────────────────
//
// Replaces Brenner-Subrahmanyam + Newton-Raphson with a bisection search.
// Much more robust for OTM options where the B-S approximation diverges
// and Newton-Raphson can oscillate. Converges in ~20 iterations to 0.0001
// accuracy across the full vol surface.

const IV_FLOOR = 0.01;   // 1%  — minimum plausible IV
const IV_CEIL  = 5.0;    // 500% — maximum (meme stocks, pre-earnings)
const IV_DEFAULT = 0.25;  // 25% fallback
const IV_TOLERANCE = 0.0001; // convergence: 0.01% vol
const IV_MAX_ITER = 40;

function estimateIV(midPrice, spotPrice, strike, T, isCall) {
  if (midPrice <= 0 || T <= 0 || spotPrice <= 0 || strike <= 0) return IV_DEFAULT;

  const r = getRiskFreeRate();

  // Compute intrinsic value — if mid is below intrinsic, IV is near zero
  const intrinsic = isCall
    ? Math.max(spotPrice - strike * Math.exp(-r * T), 0)
    : Math.max(strike * Math.exp(-r * T) - spotPrice, 0);
  if (midPrice <= intrinsic) return IV_FLOOR;

  let lo = IV_FLOOR;
  let hi = IV_CEIL;

  // Quick bounds check: if price at IV_CEIL is still below mid, give up
  const pHi = bsPrice(spotPrice, strike, r, hi, T, isCall);
  if (pHi < midPrice) return IV_CEIL;

  // Binary search
  for (let i = 0; i < IV_MAX_ITER; i++) {
    const mid = (lo + hi) / 2;
    const p = bsPrice(spotPrice, strike, r, mid, T, isCall);

    if (Math.abs(p - midPrice) < IV_TOLERANCE * spotPrice) return mid;

    if (p < midPrice) {
      lo = mid;
    } else {
      hi = mid;
    }

    if (hi - lo < IV_TOLERANCE) return mid;
  }

  return (lo + hi) / 2;
}

// ── Exports ────────────────────────────────────────────────────────────

module.exports = {
  getRiskFreeRate,
  normalPDF,
  normalCDF,
  d1,
  bsPrice,
  bsGamma,
  bsVega,
  estimateIV,
  // Constants for callers that need them
  IV_DEFAULT,
};
