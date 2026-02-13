'use strict';

/**
 * option-simulator.js — Simulates realistic 0DTE option chains.
 *
 * Uses a simplified Black-Scholes model to price calls/puts at any point
 * during the trading day. Accounts for:
 *   - Time-to-expiration (intraday, measured in minutes)
 *   - Implied volatility (configurable, defaults to ~20% annualized)
 *   - Delta approximation
 *   - Bid/ask spread simulation (2-4% of mid)
 *   - Theta decay (non-linear, accelerates into close)
 *   - Slippage model
 */

// ── Normal CDF approximation (Abramowitz & Stegun) ──────────────────

function _normalCDF(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1.0 + sign * y);
}

function _normalPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// ── Black-Scholes pricing ───────────────────────────────────────────

/**
 * Price a European option using Black-Scholes.
 *
 * @param {number} S  - Spot price
 * @param {number} K  - Strike price
 * @param {number} T  - Time to expiration in years (for 0DTE: minutes / 252 / 390)
 * @param {number} r  - Risk-free rate (annualized, e.g. 0.05)
 * @param {number} iv - Implied volatility (annualized, e.g. 0.20)
 * @param {'call'|'put'} type
 * @returns {{ price: number, delta: number, gamma: number, theta: number, vega: number }}
 */
function blackScholes(S, K, T, r, iv, type = 'call') {
  // Floor T to prevent division by zero — minimum 1 minute of life
  T = Math.max(T, 1 / (252 * 390));

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * iv * iv) * T) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;

  let price, delta;

  if (type === 'call') {
    price = S * _normalCDF(d1) - K * Math.exp(-r * T) * _normalCDF(d2);
    delta = _normalCDF(d1);
  } else {
    price = K * Math.exp(-r * T) * _normalCDF(-d2) - S * _normalCDF(-d1);
    delta = _normalCDF(d1) - 1;
  }

  // Greeks
  const gamma = _normalPDF(d1) / (S * iv * sqrtT);
  const theta = (-(S * _normalPDF(d1) * iv) / (2 * sqrtT) - r * K * Math.exp(-r * T) *
    (type === 'call' ? _normalCDF(d2) : _normalCDF(-d2))) / 252; // daily theta
  const vega = S * sqrtT * _normalPDF(d1) / 100; // per 1% IV move

  return {
    price: Math.max(price, 0.01), // floor at $0.01
    delta,
    gamma,
    theta,
    vega,
  };
}

// ── 0DTE Chain Simulator ────────────────────────────────────────────

/**
 * Generate a simulated 0DTE option chain at a given point in time.
 *
 * @param {number} spot - Current underlying price
 * @param {Date|string} timestamp - Current time (for calculating time-to-expiry)
 * @param {object} [opts]
 * @param {number} [opts.iv=0.20] - Base implied volatility (annualized)
 * @param {number} [opts.ivSkew=0.02] - IV increase per $1 OTM (smile/skew)
 * @param {number} [opts.riskFreeRate=0.05] - Annual risk-free rate
 * @param {number} [opts.spreadPct=0.03] - Bid/ask spread as % of mid (default 3%)
 * @param {number} [opts.minDelta=0.15] - Minimum delta to include
 * @param {number} [opts.maxDelta=0.75] - Maximum delta to include
 * @param {number} [opts.strikeStep] - Strike increment (auto: $1 for SPY-range, $0.50 for <$50)
 * @returns {object[]} Array of contract objects
 */
function simulate0DTEChain(spot, timestamp, opts = {}) {
  const {
    iv = 0.20,
    ivSkew = 0.02,
    riskFreeRate = 0.05,
    spreadPct = 0.03,
    minDelta = 0.15,
    maxDelta = 0.75,
    strikeStep = spot > 100 ? 1 : 0.50,
  } = opts;

  const now = timestamp instanceof Date ? timestamp : new Date(timestamp);

  // Market close = 4:00 PM ET. Must compute in ET timezone.
  // Convert to ET string, parse back, then construct close time.
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etNow = new Date(etStr);
  const closeET = new Date(etStr);
  closeET.setHours(16, 0, 0, 0);

  // Time to expiration in trading-year fraction
  const minutesToClose = Math.max((closeET - etNow) / 60000, 1);
  const T = minutesToClose / (252 * 390); // fraction of a trading year

  // Generate strikes: ±5% around spot in $1 increments
  const range = spot * 0.05;
  const lowStrike = Math.floor((spot - range) / strikeStep) * strikeStep;
  const highStrike = Math.ceil((spot + range) / strikeStep) * strikeStep;

  const contracts = [];

  for (let K = lowStrike; K <= highStrike; K += strikeStep) {
    const moneyness = Math.abs(spot - K);
    const contractIV = iv + ivSkew * moneyness; // simple smile

    for (const type of ['call', 'put']) {
      const bs = blackScholes(spot, K, T, riskFreeRate, contractIV, type);
      const absDelta = Math.abs(bs.delta);

      // Filter to tradeable delta range
      if (absDelta < minDelta || absDelta > maxDelta) continue;

      // Simulate bid/ask spread (wider for lower-premium contracts)
      const dynamicSpread = bs.price < 1.00
        ? spreadPct * 1.5  // wider spread on cheap contracts
        : spreadPct;
      const halfSpread = bs.price * dynamicSpread / 2;
      const bid = Math.max(Math.round((bs.price - halfSpread) * 100) / 100, 0.01);
      const ask = Math.round((bs.price + halfSpread) * 100) / 100;
      const mid = Math.round(((bid + ask) / 2) * 100) / 100;

      // Simulate OI and volume (based on delta proximity to 0.40)
      const deltaProximity = 1 - Math.abs(absDelta - 0.40) / 0.40;
      const baseOI = 2000 + Math.floor(deltaProximity * 8000);
      const baseVol = 200 + Math.floor(deltaProximity * 2000);

      contracts.push({
        symbol: `${_formatOCCSymbol(spot > 100 ? 'SPY' : 'QQQ', K, type, now)}`,
        strike: K,
        type,
        expiry: now.toISOString().slice(0, 10),
        bid,
        ask,
        mid,
        spread: ask - bid,
        spreadPct: mid > 0 ? (ask - bid) / mid : 1,
        delta: bs.delta,
        gamma: bs.gamma,
        theta: bs.theta,
        vega: bs.vega,
        iv: contractIV,
        price: bs.price,
        openInterest: baseOI,
        volume: baseVol,
        minutesToExpiry: minutesToClose,
        T,
      });
    }
  }

  return contracts;
}

/**
 * Format an OCC-style symbol for backtesting.
 */
function _formatOCCSymbol(underlying, strike, type, date) {
  const d = date instanceof Date ? date : new Date(date);
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const t = type === 'call' ? 'C' : 'P';
  const s = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${underlying.padEnd(6)}${yy}${mm}${dd}${t}${s}`;
}

// ── Trade P&L Calculator ────────────────────────────────────────────

/**
 * Calculate realistic P&L for a 0DTE options trade.
 *
 * @param {object} params
 * @param {number} params.entrySpot - Underlying price at entry
 * @param {number} params.exitSpot - Underlying price at exit
 * @param {number} params.strike - Option strike price
 * @param {'call'|'put'} params.side - Option type
 * @param {number} params.entryPremium - Entry premium per share (mid price at entry)
 * @param {number} params.entryMinutesToClose - Minutes to close at entry
 * @param {number} params.exitMinutesToClose - Minutes to close at exit
 * @param {number} params.qty - Number of contracts
 * @param {object} [params.opts] - Simulation options
 * @param {number} [params.opts.iv=0.20] - Implied volatility
 * @param {number} [params.opts.slippagePct=0.0075] - Slippage as % of premium (0.75%)
 * @param {number} [params.opts.commissionPerContract=0.65] - Per-contract commission
 * @returns {{ exitPremium, grossPnL, slippage, commission, netPnL, pnlPct, holdMinutes }}
 */
function calculateTradePL(params) {
  const {
    entrySpot, exitSpot, strike, side, entryPremium,
    entryMinutesToClose, exitMinutesToClose, qty,
    opts: {
      iv = 0.20,
      slippagePct = 0.0075,
      commissionPerContract = 0.65,
      riskFreeRate = 0.05,
    } = {},
  } = params;

  // Re-price the option at exit using B-S with updated spot and time
  const exitT = Math.max(exitMinutesToClose, 1) / (252 * 390);
  const exitBS = blackScholes(exitSpot, strike, exitT, riskFreeRate, iv, side);
  const exitPremium = exitBS.price;

  // P&L per share
  const grossPnLPerShare = exitPremium - entryPremium;
  const grossPnL = grossPnLPerShare * 100 * qty;

  // Slippage: applied on both entry and exit
  const entrySlippage = entryPremium * slippagePct * 100 * qty;
  const exitSlippage = exitPremium * slippagePct * 100 * qty;
  const totalSlippage = entrySlippage + exitSlippage;

  // Commission: entry + exit
  const commission = commissionPerContract * qty * 2;

  const netPnL = grossPnL - totalSlippage - commission;
  const holdMinutes = entryMinutesToClose - exitMinutesToClose;

  return {
    exitPremium: Math.round(exitPremium * 100) / 100,
    grossPnL: Math.round(grossPnL * 100) / 100,
    slippage: Math.round(totalSlippage * 100) / 100,
    commission: Math.round(commission * 100) / 100,
    netPnL: Math.round(netPnL * 100) / 100,
    pnlPct: entryPremium > 0 ? Math.round((grossPnLPerShare / entryPremium) * 10000) / 10000 : 0,
    holdMinutes,
  };
}

/**
 * Reprice an option at a new spot/time for position monitoring.
 * Returns the new mid premium.
 */
function repriceOption(spot, strike, minutesToClose, iv, side, riskFreeRate = 0.05) {
  const T = Math.max(minutesToClose, 1) / (252 * 390);
  const bs = blackScholes(spot, strike, T, riskFreeRate, iv, side);
  return bs.price;
}

module.exports = {
  blackScholes,
  simulate0DTEChain,
  calculateTradePL,
  repriceOption,
};
