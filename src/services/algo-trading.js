/**
 * Algo Trading Engine — Full Databento Algo Trading Suite
 *
 * Implements ALL techniques from Databento's algo trading documentation:
 *   https://databento.com/docs/examples/algo-trading
 *
 * Modules:
 *   1. Book Skew Signal (log₁₀ formulation, k=1.7 threshold)
 *      Source: https://databento.com/blog/liquidity-taking-strategy
 *
 *   2. 10-Level Order Book Imbalance (OBI)
 *      Source: https://databento.com/blog/hft-sklearn-python
 *
 *   3. Liquidity-Taking Strategy (rule-based HFT with position management)
 *      Source: https://databento.com/blog/liquidity-taking-strategy
 *
 *   4. VWAP / TWAP Execution Benchmarking
 *      Source: https://databento.com/blog/vwap-python
 *
 *   5. Pairs Trading / Statistical Arbitrage (Engle-Granger cointegration)
 *      Source: https://databento.com/blog/build-a-pairs-trading-strategy-in-python
 *
 *   6. ML Signal Combiner (linear regression + gradient-boosted trees)
 *      Source: https://databento.com/blog/hft-sklearn-python
 *
 * Consumes events from databento-live.js and provides:
 *   - Real-time signal computation
 *   - Position tracking with online PnL
 *   - Composite multi-factor scoring
 *   - Pairs trade z-score monitoring
 *   - VWAP/TWAP execution benchmarks
 *
 * Emits events:
 *   'algo:signal'        — composite algo signal update
 *   'algo:skew_trade'    — liquidity-taking entry/exit signal
 *   'algo:pairs_signal'  — pairs trading z-score cross
 *   'algo:vwap_cross'    — price crosses VWAP (momentum confirmation)
 *   'algo:obi_extreme'   — extreme order book imbalance detected
 *   'algo:ml_prediction' — ML model prediction update
 */

const { EventEmitter } = require('events');

// ── Constants from Databento research ────────────────────────────────────

// Book Skew (Liquidity-Taking Strategy)
const SKEW_THRESHOLD_K = 1.7;              // From Databento blog: k = 1.7
const SKEW_SIGNAL_COOLDOWN_MS = 500;       // Min time between signals
const MAX_POSITION_LOTS = 10;              // Max position size in lots

// Order Book Imbalance
const OBI_LEVELS = 10;                     // MBP-10 depth levels
const OBI_EXTREME_THRESHOLD = 0.7;         // >70% imbalance = extreme
const OBI_SIGNAL_COOLDOWN_MS = 1000;

// VWAP / TWAP
const VWAP_CROSS_MIN_DELTA = 0.0003;      // 3bp minimum for VWAP cross signal
const TWAP_BUCKET_MS = 60_000;             // 1-minute TWAP buckets

// Pairs Trading
const PAIRS_LOOKBACK = 100;               // Rolling window for cointegration
const PAIRS_ENTRY_ZSCORE = 1.5;           // Enter at ±1.5 std devs
const PAIRS_EXIT_ZSCORE = 0.5;            // Exit at ±0.5 std devs
const PAIRS_EMERGENCY_ZSCORE = 3.0;       // Stop-loss at ±3.0 std devs

// ML Signal Combiner
const ML_FEATURE_WINDOW = 50;             // Feature lookback window
const ML_RETRAIN_INTERVAL_MS = 5 * 60_000; // Retrain every 5 minutes
const ML_MIN_SAMPLES = 30;                // Min samples before prediction

// ═════════════════════════════════════════════════════════════════════════
// 1. BOOK SKEW ENGINE (from Databento Liquidity-Taking Strategy)
// ═════════════════════════════════════════════════════════════════════════
//
// Formula: skew = log₁₀(bid_size) - log₁₀(ask_size)
// Trading rule:
//   - If skew > k (1.7): buy signal (more bids → upward pressure)
//   - If skew < -k: sell signal (more asks → downward pressure)
//   - Position sizing: ±1 lot per signal, max 10 lots
//
// Online PnL tracking:
//   - Mark-to-market on each quote update
//   - Fee model: $0.05 per lot per side (configurable)
// ═════════════════════════════════════════════════════════════════════════

class BookSkewEngine {
  constructor() {
    this._state = new Map();   // ticker → { skew, bidSz, askSz, midPx, ts, ... }
    this._positions = new Map(); // ticker → { lots, avgEntry, realizedPnl, unrealizedPnl, fills }
    this._history = new Map();  // ticker → [{ skew, midPx, ts }] (rolling buffer for ML)
    this._lastSignalTs = new Map();
    this._feePerLot = 0.05;    // Per-side fee
  }

  /**
   * Process a top-of-book quote update (MBP-1 or CBBO).
   * Returns a signal object if a trading signal is generated.
   */
  onQuote(ticker, bidPx, askPx, bidSz, askSz, ts) {
    if (!bidSz || !askSz || bidSz <= 0 || askSz <= 0) return null;

    // Core formula from Databento: skew = log₁₀(bid_size) - log₁₀(ask_size)
    const skew = Math.log10(bidSz) - Math.log10(askSz);
    const midPx = (bidPx + askPx) / 2;
    const spread = askPx - bidPx;
    const spreadBps = midPx > 0 ? (spread / midPx) * 10000 : 0;

    const prev = this._state.get(ticker);
    this._state.set(ticker, {
      skew, bidPx, askPx, bidSz, askSz, midPx, spread, spreadBps,
      ts: ts || Date.now(),
    });

    // Rolling history for ML features
    let hist = this._history.get(ticker);
    if (!hist) { hist = []; this._history.set(ticker, hist); }
    hist.push({ skew, midPx, bidSz, askSz, ts: ts || Date.now() });
    if (hist.length > 500) hist.splice(0, hist.length - 500);

    // Mark-to-market existing position
    this._markToMarket(ticker, midPx);

    // Check for trading signal (cooldown)
    const lastSig = this._lastSignalTs.get(ticker) || 0;
    if ((ts || Date.now()) - lastSig < SKEW_SIGNAL_COOLDOWN_MS) return null;

    let signal = null;

    if (skew > SKEW_THRESHOLD_K) {
      // Strong buy signal — more resting bids than asks
      signal = this._generateTradeSignal(ticker, 'BUY', skew, midPx, ts);
    } else if (skew < -SKEW_THRESHOLD_K) {
      // Strong sell signal — more resting asks than bids
      signal = this._generateTradeSignal(ticker, 'SELL', skew, midPx, ts);
    } else if (prev) {
      // Check for skew flip (sign change with magnitude > 1.0)
      if (Math.abs(skew) > 1.0 && Math.sign(skew) !== Math.sign(prev.skew || 0)) {
        signal = {
          type: 'skew_flip',
          ticker,
          direction: skew > 0 ? 'BULLISH' : 'BEARISH',
          skew: +skew.toFixed(4),
          prevSkew: +(prev.skew || 0).toFixed(4),
          midPx,
          ts: ts || Date.now(),
        };
      }
    }

    if (signal) this._lastSignalTs.set(ticker, ts || Date.now());
    return signal;
  }

  _generateTradeSignal(ticker, side, skew, midPx, ts) {
    let pos = this._positions.get(ticker);
    if (!pos) {
      pos = { lots: 0, avgEntry: 0, realizedPnl: 0, unrealizedPnl: 0, fills: [], tradeCount: 0 };
      this._positions.set(ticker, pos);
    }

    const desiredDelta = side === 'BUY' ? 1 : -1;

    // Position limit check
    if (Math.abs(pos.lots + desiredDelta) > MAX_POSITION_LOTS) {
      return {
        type: 'skew_signal_blocked',
        ticker, side, skew: +skew.toFixed(4), midPx,
        reason: `Position limit (${MAX_POSITION_LOTS} lots)`,
        currentLots: pos.lots,
        ts: ts || Date.now(),
      };
    }

    // Execute fill
    const fillPx = midPx;
    const prevLots = pos.lots;
    const fee = this._feePerLot;

    if (desiredDelta > 0) {
      // Buying
      if (pos.lots >= 0) {
        // Adding to long or opening long
        const totalCost = pos.avgEntry * pos.lots + fillPx * desiredDelta;
        pos.lots += desiredDelta;
        pos.avgEntry = pos.lots > 0 ? totalCost / pos.lots : 0;
      } else {
        // Covering short
        pos.realizedPnl += (pos.avgEntry - fillPx) * Math.min(Math.abs(desiredDelta), Math.abs(pos.lots));
        pos.lots += desiredDelta;
        if (pos.lots > 0) pos.avgEntry = fillPx;
        else if (pos.lots === 0) pos.avgEntry = 0;
      }
    } else {
      // Selling
      if (pos.lots <= 0) {
        // Adding to short or opening short
        const totalCost = Math.abs(pos.avgEntry * pos.lots) + fillPx * Math.abs(desiredDelta);
        pos.lots += desiredDelta;
        pos.avgEntry = pos.lots < 0 ? totalCost / Math.abs(pos.lots) : 0;
      } else {
        // Closing long
        pos.realizedPnl += (fillPx - pos.avgEntry) * Math.min(Math.abs(desiredDelta), pos.lots);
        pos.lots += desiredDelta;
        if (pos.lots < 0) pos.avgEntry = fillPx;
        else if (pos.lots === 0) pos.avgEntry = 0;
      }
    }

    // Track fee
    pos.realizedPnl -= fee;
    pos.tradeCount++;

    // Record fill
    pos.fills.push({
      side, price: fillPx, lots: Math.abs(desiredDelta), skew: +skew.toFixed(4),
      ts: ts || Date.now(), fee,
    });
    if (pos.fills.length > 200) pos.fills.splice(0, pos.fills.length - 200);

    this._markToMarket(ticker, midPx);

    return {
      type: 'skew_trade',
      ticker, side,
      skew: +skew.toFixed(4),
      fillPrice: +fillPx.toFixed(4),
      lots: pos.lots,
      prevLots,
      avgEntry: +pos.avgEntry.toFixed(4),
      realizedPnl: +pos.realizedPnl.toFixed(2),
      unrealizedPnl: +pos.unrealizedPnl.toFixed(2),
      totalPnl: +(pos.realizedPnl + pos.unrealizedPnl).toFixed(2),
      tradeCount: pos.tradeCount,
      ts: ts || Date.now(),
    };
  }

  _markToMarket(ticker, midPx) {
    const pos = this._positions.get(ticker);
    if (!pos || pos.lots === 0) return;
    if (pos.lots > 0) {
      pos.unrealizedPnl = (midPx - pos.avgEntry) * pos.lots;
    } else {
      pos.unrealizedPnl = (pos.avgEntry - midPx) * Math.abs(pos.lots);
    }
  }

  getState(ticker) {
    return this._state.get(ticker.toUpperCase()) || null;
  }

  getPosition(ticker) {
    return this._positions.get(ticker.toUpperCase()) || null;
  }

  getHistory(ticker, count = 100) {
    const hist = this._history.get(ticker.toUpperCase());
    return hist ? hist.slice(-count) : [];
  }

  getAllPositions() {
    const result = {};
    for (const [ticker, pos] of this._positions) {
      if (pos.lots !== 0 || pos.realizedPnl !== 0) {
        result[ticker] = { ...pos, fills: pos.fills.slice(-10) };
      }
    }
    return result;
  }

  getTotalPnl() {
    let realized = 0, unrealized = 0;
    for (const pos of this._positions.values()) {
      realized += pos.realizedPnl;
      unrealized += pos.unrealizedPnl;
    }
    return { realized: +realized.toFixed(2), unrealized: +unrealized.toFixed(2), total: +(realized + unrealized).toFixed(2) };
  }

  reset(ticker) {
    if (ticker) {
      const tk = ticker.toUpperCase();
      this._state.delete(tk);
      this._positions.delete(tk);
      this._history.delete(tk);
      this._lastSignalTs.delete(tk);
    } else {
      this._state.clear();
      this._positions.clear();
      this._history.clear();
      this._lastSignalTs.clear();
    }
  }
}


// ═════════════════════════════════════════════════════════════════════════
// 2. ORDER BOOK IMBALANCE ENGINE (10-Level Depth)
// ═════════════════════════════════════════════════════════════════════════
//
// From Databento HFT with sklearn blog:
//   - top_of_book_skew = log(bid_size_0 / ask_size_0)
//   - order_imbalance = Σ(bid_size_i) / (Σ(bid_size_i) + Σ(ask_size_i))
//   - Separate: depth-weighted imbalance by price level
//
// MBP-10 schema provides 10 levels of bid/ask with sizes and counts.
// Features computed:
//   1. Top-of-book skew (level 0 only)
//   2. Aggregate OBI across all 10 levels
//   3. Price-weighted OBI (deeper levels weighted less)
//   4. Order count imbalance (number of orders, not just size)
//   5. Bid/ask depth ratio per level
//   6. Cumulative depth profiles
// ═════════════════════════════════════════════════════════════════════════

class OrderBookImbalanceEngine {
  constructor() {
    this._books = new Map();    // ticker → { levels, obi, features, ts }
    this._history = new Map();  // ticker → [{ obi, priceWeightedObi, ts }]
    this._lastSignalTs = new Map();
  }

  /**
   * Process a multi-level book update (MBP-10).
   * @param {string} ticker - Underlying symbol
   * @param {Array} levels - Array of { bidPx, bidSz, bidCt, askPx, askSz, askCt }
   *                         where index 0 = best bid/ask (top of book)
   * @param {number} [ts] - Timestamp
   * @returns {Object|null} Signal if extreme imbalance detected
   */
  onBookUpdate(ticker, levels, ts) {
    if (!levels || levels.length === 0) return null;

    const numLevels = Math.min(levels.length, OBI_LEVELS);

    // Compute features across all depth levels
    let totalBidSz = 0, totalAskSz = 0;
    let totalBidCt = 0, totalAskCt = 0;
    let weightedBidSz = 0, weightedAskSz = 0;
    const levelFeatures = [];

    for (let i = 0; i < numLevels; i++) {
      const lv = levels[i];
      if (!lv) continue;

      const bidSz = lv.bidSz || 0;
      const askSz = lv.askSz || 0;
      const bidCt = lv.bidCt || 0;
      const askCt = lv.askCt || 0;

      totalBidSz += bidSz;
      totalAskSz += askSz;
      totalBidCt += bidCt;
      totalAskCt += askCt;

      // Price-weighted: closer levels matter more (weight = 1/(i+1))
      const weight = 1 / (i + 1);
      weightedBidSz += bidSz * weight;
      weightedAskSz += askSz * weight;

      levelFeatures.push({
        level: i,
        bidPx: lv.bidPx, askPx: lv.askPx,
        bidSz, askSz, bidCt, askCt,
        depthRatio: (bidSz + askSz) > 0 ? bidSz / (bidSz + askSz) : 0.5,
      });
    }

    // Core OBI metrics
    const totalDepth = totalBidSz + totalAskSz;
    const obi = totalDepth > 0 ? totalBidSz / totalDepth : 0.5;

    const weightedTotal = weightedBidSz + weightedAskSz;
    const priceWeightedObi = weightedTotal > 0 ? weightedBidSz / weightedTotal : 0.5;

    const totalOrders = totalBidCt + totalAskCt;
    const orderCountImbalance = totalOrders > 0 ? totalBidCt / totalOrders : 0.5;

    // Top-of-book skew (log₁₀ formulation)
    const topBidSz = levels[0]?.bidSz || 1;
    const topAskSz = levels[0]?.askSz || 1;
    const topSkew = Math.log10(topBidSz) - Math.log10(topAskSz);

    // Mid price from top of book
    const topBidPx = levels[0]?.bidPx || 0;
    const topAskPx = levels[0]?.askPx || 0;
    const midPx = (topBidPx + topAskPx) / 2;

    // Cumulative depth profiles (for visualization)
    let cumBid = 0, cumAsk = 0;
    const depthProfile = levelFeatures.map(lf => {
      cumBid += lf.bidSz;
      cumAsk += lf.askSz;
      return { level: lf.level, cumBid, cumAsk, cumRatio: (cumBid + cumAsk) > 0 ? cumBid / (cumBid + cumAsk) : 0.5 };
    });

    const bookState = {
      ticker,
      numLevels,
      obi: +obi.toFixed(4),
      priceWeightedObi: +priceWeightedObi.toFixed(4),
      orderCountImbalance: +orderCountImbalance.toFixed(4),
      topSkew: +topSkew.toFixed(4),
      midPx,
      totalBidSz, totalAskSz, totalBidCt, totalAskCt,
      levels: levelFeatures,
      depthProfile,
      direction: obi > 0.55 ? 'BULLISH' : obi < 0.45 ? 'BEARISH' : 'NEUTRAL',
      ts: ts || Date.now(),
    };

    this._books.set(ticker, bookState);

    // History for ML
    let hist = this._history.get(ticker);
    if (!hist) { hist = []; this._history.set(ticker, hist); }
    hist.push({
      obi, priceWeightedObi, orderCountImbalance, topSkew, midPx,
      totalBidSz, totalAskSz, ts: ts || Date.now(),
    });
    if (hist.length > 500) hist.splice(0, hist.length - 500);

    // Extreme imbalance signal
    const lastSig = this._lastSignalTs.get(ticker) || 0;
    if ((ts || Date.now()) - lastSig >= OBI_SIGNAL_COOLDOWN_MS) {
      if (Math.abs(obi - 0.5) > (OBI_EXTREME_THRESHOLD - 0.5)) {
        this._lastSignalTs.set(ticker, ts || Date.now());
        return {
          type: 'obi_extreme',
          ticker,
          obi: +obi.toFixed(4),
          priceWeightedObi: +priceWeightedObi.toFixed(4),
          direction: obi > 0.5 ? 'BULLISH' : 'BEARISH',
          strength: +((Math.abs(obi - 0.5) / 0.5) * 100).toFixed(1),
          midPx,
          ts: ts || Date.now(),
        };
      }
    }

    return null;
  }

  getBook(ticker) {
    return this._books.get(ticker.toUpperCase()) || null;
  }

  getHistory(ticker, count = 100) {
    const hist = this._history.get(ticker.toUpperCase());
    return hist ? hist.slice(-count) : [];
  }

  reset(ticker) {
    if (ticker) {
      const tk = ticker.toUpperCase();
      this._books.delete(tk);
      this._history.delete(tk);
      this._lastSignalTs.delete(tk);
    } else {
      this._books.clear();
      this._history.clear();
      this._lastSignalTs.clear();
    }
  }
}


// ═════════════════════════════════════════════════════════════════════════
// 3. VWAP / TWAP ENGINE
// ═════════════════════════════════════════════════════════════════════════
//
// From Databento VWAP blog:
//   VWAP = Σ(Price × Volume) / Σ(Volume)
//   Two methods: OHLCV bars and tick-by-tick trades
//
// TWAP = Σ(Price) / N (time-weighted, equal weight per time bucket)
//
// Features:
//   - Running cumulative VWAP (tick-by-tick)
//   - OHLCV bar-based VWAP (1-min bars)
//   - TWAP from equal-interval buckets
//   - Price vs VWAP delta (momentum signal)
//   - VWAP cross detection
//   - Upper/lower VWAP bands (±1σ, ±2σ)
//   - Volume profile (price × volume distribution)
// ═════════════════════════════════════════════════════════════════════════

class VwapTwapEngine {
  constructor() {
    this._vwap = new Map();      // ticker → { cumPV, cumVol, vwap, trades, ... }
    this._twap = new Map();      // ticker → { buckets, twap }
    this._bars = new Map();      // ticker → [{ open, high, low, close, vol, vwap, ts }]
    this._volumeProfile = new Map(); // ticker → Map<priceLevel, volume>
    this._lastCrossTs = new Map();
  }

  /**
   * Process a trade (tick-by-tick VWAP).
   * @returns {Object|null} Signal on VWAP cross
   */
  onTrade(ticker, price, size, ts) {
    if (!price || !size || price <= 0 || size <= 0) return null;

    // Cumulative VWAP
    let v = this._vwap.get(ticker);
    if (!v) {
      v = {
        cumPV: 0, cumVol: 0, vwap: 0,
        cumPV2: 0,          // For variance calculation (VWAP bands)
        tradeCount: 0,
        high: -Infinity, low: Infinity,
        prevPrice: null,
        sessionStart: ts || Date.now(),
      };
      this._vwap.set(ticker, v);
    }

    v.cumPV += price * size;
    v.cumVol += size;
    v.cumPV2 += (price * price) * size;  // Σ(P² × V) for variance
    v.vwap = v.cumPV / v.cumVol;
    v.tradeCount += 1;
    if (price > v.high) v.high = price;
    if (price < v.low) v.low = price;

    // VWAP standard deviation: σ = sqrt(Σ(P²×V)/ΣV - VWAP²)
    const variance = (v.cumPV2 / v.cumVol) - (v.vwap * v.vwap);
    v.stdDev = Math.sqrt(Math.max(0, variance));
    v.upperBand1 = v.vwap + v.stdDev;
    v.lowerBand1 = v.vwap - v.stdDev;
    v.upperBand2 = v.vwap + 2 * v.stdDev;
    v.lowerBand2 = v.vwap - 2 * v.stdDev;

    // VWAP delta
    v.vwapDelta = v.vwap > 0 ? (price - v.vwap) / v.vwap : 0;
    v.vwapDeltaBps = +(v.vwapDelta * 10000).toFixed(1);

    // VWAP cross detection
    let signal = null;
    if (v.prevPrice !== null) {
      const prevAbove = v.prevPrice > v.vwap;
      const nowAbove = price > v.vwap;
      if (prevAbove !== nowAbove && Math.abs(v.vwapDelta) >= VWAP_CROSS_MIN_DELTA) {
        const lastCross = this._lastCrossTs.get(ticker) || 0;
        if ((ts || Date.now()) - lastCross >= 5000) {  // 5s cooldown
          this._lastCrossTs.set(ticker, ts || Date.now());
          signal = {
            type: 'vwap_cross',
            ticker,
            direction: nowAbove ? 'BULLISH' : 'BEARISH',
            price, vwap: +v.vwap.toFixed(4),
            deltaBps: v.vwapDeltaBps,
            volume: v.cumVol,
            tradeCount: v.tradeCount,
            ts: ts || Date.now(),
          };
        }
      }
    }
    v.prevPrice = price;

    // TWAP update
    this._updateTwap(ticker, price, ts);

    // Volume profile (bucket prices to 2 decimal places)
    let vp = this._volumeProfile.get(ticker);
    if (!vp) { vp = new Map(); this._volumeProfile.set(ticker, vp); }
    const priceKey = +price.toFixed(2);
    vp.set(priceKey, (vp.get(priceKey) || 0) + size);

    return signal;
  }

  /**
   * Process an OHLCV bar (bar-based VWAP — alternative method).
   */
  onBar(ticker, open, high, low, close, volume, ts) {
    if (!volume || volume <= 0) return;

    let bars = this._bars.get(ticker);
    if (!bars) { bars = []; this._bars.set(ticker, bars); }

    // Typical price = (H + L + C) / 3 — standard VWAP from bars
    const typicalPrice = (high + low + close) / 3;
    const barPV = typicalPrice * volume;

    bars.push({ open, high, low, close, volume, typicalPrice, pv: barPV, ts: ts || Date.now() });
    if (bars.length > 500) bars.splice(0, bars.length - 500);
  }

  _updateTwap(ticker, price, ts) {
    let tw = this._twap.get(ticker);
    const now = ts || Date.now();

    if (!tw) {
      tw = { buckets: [], currentBucket: { prices: [price], start: now }, twap: price };
      this._twap.set(ticker, tw);
      return;
    }

    // Add to current bucket
    tw.currentBucket.prices.push(price);

    // Roll bucket if time elapsed
    if (now - tw.currentBucket.start >= TWAP_BUCKET_MS) {
      const avg = tw.currentBucket.prices.reduce((a, b) => a + b, 0) / tw.currentBucket.prices.length;
      tw.buckets.push({ price: avg, ts: tw.currentBucket.start });
      if (tw.buckets.length > 500) tw.buckets.splice(0, tw.buckets.length - 500);
      tw.currentBucket = { prices: [price], start: now };

      // Recompute TWAP
      const allPrices = tw.buckets.map(b => b.price);
      tw.twap = allPrices.reduce((a, b) => a + b, 0) / allPrices.length;
    }
  }

  /**
   * Get VWAP state for a ticker.
   */
  getVwap(ticker) {
    const tk = ticker.toUpperCase();
    const v = this._vwap.get(tk);
    if (!v) return null;

    const tw = this._twap.get(tk);

    return {
      ticker: tk,
      vwap: +v.vwap.toFixed(4),
      twap: tw ? +tw.twap.toFixed(4) : null,
      volume: v.cumVol,
      tradeCount: v.tradeCount,
      high: v.high === -Infinity ? null : v.high,
      low: v.low === Infinity ? null : v.low,
      lastPrice: v.prevPrice,
      vwapDelta: +v.vwapDelta.toFixed(6),
      vwapDeltaBps: v.vwapDeltaBps,
      stdDev: +v.stdDev.toFixed(4),
      upperBand1: +v.upperBand1.toFixed(4),
      lowerBand1: +v.lowerBand1.toFixed(4),
      upperBand2: +v.upperBand2.toFixed(4),
      lowerBand2: +v.lowerBand2.toFixed(4),
      priceVsVwap: v.prevPrice > v.vwap ? 'ABOVE' : v.prevPrice < v.vwap ? 'BELOW' : 'AT',
      sessionStart: v.sessionStart,
    };
  }

  /**
   * Get bar-based VWAP (alternative calculation from OHLCV bars).
   */
  getBarVwap(ticker) {
    const bars = this._bars.get(ticker.toUpperCase());
    if (!bars || bars.length === 0) return null;

    const cumPV = bars.reduce((s, b) => s + b.pv, 0);
    const cumVol = bars.reduce((s, b) => s + b.volume, 0);
    const barVwap = cumVol > 0 ? cumPV / cumVol : 0;

    return {
      ticker: ticker.toUpperCase(),
      barVwap: +barVwap.toFixed(4),
      barCount: bars.length,
      totalVolume: cumVol,
    };
  }

  /**
   * Get volume profile (price distribution).
   */
  getVolumeProfile(ticker, buckets = 20) {
    const vp = this._volumeProfile.get(ticker.toUpperCase());
    if (!vp || vp.size === 0) return null;

    // Sort by price
    const entries = [...vp.entries()].sort((a, b) => a[0] - b[0]);
    const minPx = entries[0][0];
    const maxPx = entries[entries.length - 1][0];
    const range = maxPx - minPx;
    if (range <= 0) return null;

    const bucketSize = range / buckets;
    const profile = [];
    for (let i = 0; i < buckets; i++) {
      const low = minPx + i * bucketSize;
      const high = low + bucketSize;
      let vol = 0;
      for (const [px, v] of entries) {
        if (px >= low && px < high) vol += v;
      }
      profile.push({ priceLow: +low.toFixed(2), priceHigh: +high.toFixed(2), volume: vol });
    }

    // Point of Control = price level with highest volume
    const poc = entries.reduce((best, curr) => curr[1] > best[1] ? curr : best, entries[0]);

    return {
      ticker: ticker.toUpperCase(),
      profile,
      poc: { price: poc[0], volume: poc[1] },
      totalVolume: entries.reduce((s, e) => s + e[1], 0),
    };
  }

  reset(ticker) {
    if (ticker) {
      const tk = ticker.toUpperCase();
      this._vwap.delete(tk);
      this._twap.delete(tk);
      this._bars.delete(tk);
      this._volumeProfile.delete(tk);
      this._lastCrossTs.delete(tk);
    } else {
      this._vwap.clear();
      this._twap.clear();
      this._bars.clear();
      this._volumeProfile.clear();
      this._lastCrossTs.clear();
    }
  }
}


// ═════════════════════════════════════════════════════════════════════════
// 4. PAIRS TRADING / STATISTICAL ARBITRAGE ENGINE
// ═════════════════════════════════════════════════════════════════════════
//
// From Databento Pairs Trading blog:
//   1. Engle-Granger cointegration test
//   2. Rolling linear regression for hedge ratio (β)
//   3. Spread = Y - β*X (residuals)
//   4. Z-score normalization: z = (spread - μ) / σ
//   5. Entry at |z| > 1.5, exit at |z| < 0.5
//   6. Emergency exit at |z| > 3.0
//   7. Sharpe ratio tracking
//
// Pairs: any two tickers with price history. Common:
//   SPY/QQQ, GLD/SLV, XLE/USO, MSFT/AAPL
// ═════════════════════════════════════════════════════════════════════════

class PairsTradingEngine {
  constructor() {
    this._pairs = new Map();     // pairKey → PairState
    this._priceHistory = new Map(); // ticker → [price]
  }

  /**
   * Register a pairs trading pair.
   * @param {string} tickerY - The dependent (long) side
   * @param {string} tickerX - the independent (hedge) side
   * @param {Object} [opts] - Options override
   */
  addPair(tickerY, tickerX, opts = {}) {
    const key = `${tickerY.toUpperCase()}/${tickerX.toUpperCase()}`;
    this._pairs.set(key, {
      tickerY: tickerY.toUpperCase(),
      tickerX: tickerX.toUpperCase(),
      lookback: opts.lookback || PAIRS_LOOKBACK,
      entryZ: opts.entryZ || PAIRS_ENTRY_ZSCORE,
      exitZ: opts.exitZ || PAIRS_EXIT_ZSCORE,
      emergencyZ: opts.emergencyZ || PAIRS_EMERGENCY_ZSCORE,

      // State
      hedgeRatio: null,        // β from linear regression
      spreadMean: null,        // μ of spread
      spreadStd: null,         // σ of spread
      currentSpread: null,
      currentZ: null,
      position: null,          // null | 'long_spread' | 'short_spread'
      entryZ: opts.entryZ || PAIRS_ENTRY_ZSCORE,
      entrySpread: null,
      pnl: 0,
      tradeCount: 0,
      wins: 0,
      losses: 0,
      returns: [],             // For Sharpe ratio
      lastUpdate: null,
      cointegrated: null,      // Result of cointegration test
      correlation: null,
    });
  }

  /**
   * Update price for a ticker (feeds into all pairs containing it).
   * @returns {Array} Array of signals generated
   */
  onPrice(ticker, price, ts) {
    const tk = ticker.toUpperCase();

    // Store price history
    let hist = this._priceHistory.get(tk);
    if (!hist) { hist = []; this._priceHistory.set(tk, hist); }
    hist.push(price);
    if (hist.length > 1000) hist.splice(0, hist.length - 1000);

    // Check all pairs containing this ticker
    const signals = [];
    for (const [key, pair] of this._pairs) {
      if (pair.tickerY !== tk && pair.tickerX !== tk) continue;

      const histY = this._priceHistory.get(pair.tickerY);
      const histX = this._priceHistory.get(pair.tickerX);
      if (!histY || !histX) continue;

      const minLen = Math.min(histY.length, histX.length, pair.lookback);
      if (minLen < 20) continue; // Need minimum data

      // Get aligned price windows
      const y = histY.slice(-minLen);
      const x = histX.slice(-minLen);

      // Linear regression: Y = α + β*X + ε
      const { beta, alpha, rSquared } = this._linearRegression(y, x);
      pair.hedgeRatio = beta;
      pair.correlation = this._correlation(y, x);

      // Compute spread residuals
      const spreads = y.map((yi, i) => yi - beta * x[i] - alpha);
      const spreadMean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
      const spreadStd = Math.sqrt(spreads.reduce((s, v) => s + (v - spreadMean) ** 2, 0) / spreads.length);

      pair.spreadMean = spreadMean;
      pair.spreadStd = spreadStd;

      // Current spread and z-score
      const currentSpread = y[y.length - 1] - beta * x[x.length - 1] - alpha;
      pair.currentSpread = currentSpread;
      pair.currentZ = spreadStd > 0 ? (currentSpread - spreadMean) / spreadStd : 0;
      pair.lastUpdate = ts || Date.now();

      // Cointegration check (simplified ADF-like test)
      // Uses variance ratio test as proxy: if spread is mean-reverting,
      // long-horizon variance should be less than short-horizon variance scaled up
      pair.cointegrated = this._varianceRatioTest(spreads);

      // Trading signals
      const z = pair.currentZ;
      const signal = this._checkPairSignal(pair, z, ts);
      if (signal) signals.push(signal);
    }

    return signals;
  }

  _checkPairSignal(pair, z, ts) {
    // Emergency exit
    if (pair.position && Math.abs(z) > pair.emergencyZ) {
      return this._closePairPosition(pair, z, 'emergency_stop', ts);
    }

    // Exit signal
    if (pair.position === 'long_spread' && z <= pair.exitZ && z >= -pair.exitZ) {
      return this._closePairPosition(pair, z, 'exit', ts);
    }
    if (pair.position === 'short_spread' && z <= pair.exitZ && z >= -pair.exitZ) {
      return this._closePairPosition(pair, z, 'exit', ts);
    }

    // Entry signals (only if cointegrated)
    if (!pair.position && pair.cointegrated) {
      if (z < -pair.entryZ) {
        // Z-score very negative → spread below mean → buy spread (long Y, short X)
        pair.position = 'long_spread';
        pair.entrySpread = pair.currentSpread;
        pair.tradeCount++;
        return {
          type: 'pairs_entry',
          pair: `${pair.tickerY}/${pair.tickerX}`,
          direction: 'long_spread',
          action: `LONG ${pair.tickerY} / SHORT ${pair.tickerX}`,
          zScore: +z.toFixed(3),
          hedgeRatio: +pair.hedgeRatio.toFixed(4),
          spread: +pair.currentSpread.toFixed(4),
          correlation: +pair.correlation.toFixed(3),
          ts: ts || Date.now(),
        };
      }
      if (z > pair.entryZ) {
        // Z-score very positive → spread above mean → sell spread (short Y, long X)
        pair.position = 'short_spread';
        pair.entrySpread = pair.currentSpread;
        pair.tradeCount++;
        return {
          type: 'pairs_entry',
          pair: `${pair.tickerY}/${pair.tickerX}`,
          direction: 'short_spread',
          action: `SHORT ${pair.tickerY} / LONG ${pair.tickerX}`,
          zScore: +z.toFixed(3),
          hedgeRatio: +pair.hedgeRatio.toFixed(4),
          spread: +pair.currentSpread.toFixed(4),
          correlation: +pair.correlation.toFixed(3),
          ts: ts || Date.now(),
        };
      }
    }

    return null;
  }

  _closePairPosition(pair, z, reason, ts) {
    const pnl = pair.position === 'long_spread'
      ? pair.currentSpread - pair.entrySpread
      : pair.entrySpread - pair.currentSpread;

    pair.pnl += pnl;
    if (pnl > 0) pair.wins++; else pair.losses++;
    pair.returns.push(pnl);
    if (pair.returns.length > 500) pair.returns.splice(0, pair.returns.length - 500);

    const signal = {
      type: 'pairs_exit',
      pair: `${pair.tickerY}/${pair.tickerX}`,
      reason,
      prevPosition: pair.position,
      zScore: +z.toFixed(3),
      tradePnl: +pnl.toFixed(4),
      totalPnl: +pair.pnl.toFixed(4),
      winRate: pair.tradeCount > 0 ? +((pair.wins / pair.tradeCount) * 100).toFixed(1) : 0,
      sharpe: this._computeSharpe(pair.returns),
      ts: ts || Date.now(),
    };

    pair.position = null;
    pair.entrySpread = null;
    return signal;
  }

  /**
   * Ordinary least squares linear regression.
   * Returns { beta, alpha, rSquared }.
   */
  _linearRegression(y, x) {
    const n = y.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += x[i]; sumY += y[i];
      sumXY += x[i] * y[i];
      sumX2 += x[i] * x[i];
      sumY2 += y[i] * y[i];
    }
    const beta = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const alpha = (sumY - beta * sumX) / n;

    // R²
    const yMean = sumY / n;
    let ssTot = 0, ssRes = 0;
    for (let i = 0; i < n; i++) {
      ssTot += (y[i] - yMean) ** 2;
      ssRes += (y[i] - alpha - beta * x[i]) ** 2;
    }
    const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

    return { beta, alpha, rSquared };
  }

  _correlation(y, x) {
    const n = y.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += x[i]; sumY += y[i];
      sumXY += x[i] * y[i];
      sumX2 += x[i] * x[i];
      sumY2 += y[i] * y[i];
    }
    const num = n * sumXY - sumX * sumY;
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    return den > 0 ? num / den : 0;
  }

  /**
   * Variance ratio test (simplified cointegration proxy).
   * If the spread is mean-reverting, Var(k-period returns) / (k * Var(1-period returns)) < 1.
   * Uses k=10. Returns true if ratio < 0.8 (strong mean-reversion).
   */
  _varianceRatioTest(spreads) {
    if (spreads.length < 30) return false;

    // 1-period returns
    const returns1 = [];
    for (let i = 1; i < spreads.length; i++) {
      returns1.push(spreads[i] - spreads[i - 1]);
    }
    const var1 = this._variance(returns1);
    if (var1 === 0) return false;

    // k-period returns (k=10)
    const k = 10;
    const returnsK = [];
    for (let i = k; i < spreads.length; i++) {
      returnsK.push(spreads[i] - spreads[i - k]);
    }
    const varK = this._variance(returnsK);

    const ratio = varK / (k * var1);
    return ratio < 0.8;
  }

  _variance(arr) {
    if (arr.length === 0) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  }

  _computeSharpe(returns) {
    if (returns.length < 5) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const std = Math.sqrt(this._variance(returns));
    // Annualized (assuming ~252 trading days, ~6.5 hrs, ~390 samples/day)
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
    return +sharpe.toFixed(2);
  }

  /**
   * Get status for a specific pair.
   */
  getPairStatus(tickerY, tickerX) {
    const key = `${tickerY.toUpperCase()}/${tickerX.toUpperCase()}`;
    const pair = this._pairs.get(key);
    if (!pair) return null;

    return {
      pair: key,
      tickerY: pair.tickerY,
      tickerX: pair.tickerX,
      hedgeRatio: pair.hedgeRatio ? +pair.hedgeRatio.toFixed(4) : null,
      correlation: pair.correlation ? +pair.correlation.toFixed(3) : null,
      currentZ: pair.currentZ ? +pair.currentZ.toFixed(3) : null,
      currentSpread: pair.currentSpread ? +pair.currentSpread.toFixed(4) : null,
      spreadMean: pair.spreadMean ? +pair.spreadMean.toFixed(4) : null,
      spreadStd: pair.spreadStd ? +pair.spreadStd.toFixed(4) : null,
      cointegrated: pair.cointegrated,
      position: pair.position,
      pnl: +pair.pnl.toFixed(4),
      tradeCount: pair.tradeCount,
      wins: pair.wins,
      losses: pair.losses,
      winRate: pair.tradeCount > 0 ? +((pair.wins / pair.tradeCount) * 100).toFixed(1) : 0,
      sharpe: this._computeSharpe(pair.returns),
      lastUpdate: pair.lastUpdate,
    };
  }

  /**
   * Get all pairs status.
   */
  getAllPairs() {
    const result = [];
    for (const [key, pair] of this._pairs) {
      result.push(this.getPairStatus(pair.tickerY, pair.tickerX));
    }
    return result;
  }

  reset(pairKey) {
    if (pairKey) {
      this._pairs.delete(pairKey.toUpperCase());
    } else {
      for (const pair of this._pairs.values()) {
        pair.position = null;
        pair.pnl = 0;
        pair.tradeCount = 0;
        pair.wins = 0;
        pair.losses = 0;
        pair.returns = [];
      }
      this._priceHistory.clear();
    }
  }
}


// ═════════════════════════════════════════════════════════════════════════
// 5. ML SIGNAL COMBINER
// ═════════════════════════════════════════════════════════════════════════
//
// From Databento HFT with sklearn blog:
//   - Individual features (skew, OBI) have low R² ≈ 0.01
//   - Combined features outperform individual ones
//   - Linear regression as baseline
//   - Gradient-boosted trees for non-linear relationships
//
// Pure JavaScript implementation (no external ML libs needed):
//   1. Online linear regression (OLS with rolling window)
//   2. Gradient-boosted decision stumps (simplified GBT)
//   3. Feature engineering pipeline
//   4. Rolling R² and prediction quality metrics
// ═════════════════════════════════════════════════════════════════════════

class MLSignalCombiner {
  constructor() {
    this._features = new Map();     // ticker → [{ features..., target }]
    this._models = new Map();       // ticker → { linear, gbt, lastTrain }
    this._predictions = new Map();  // ticker → { prediction, confidence, features }
  }

  /**
   * Add a feature observation with known target (next-period return).
   * Called after each price update when we know the realized return.
   */
  addSample(ticker, features, target) {
    let samples = this._features.get(ticker);
    if (!samples) { samples = []; this._features.set(ticker, samples); }
    samples.push({ ...features, _target: target, _ts: Date.now() });
    if (samples.length > 1000) samples.splice(0, samples.length - 1000);
  }

  /**
   * Predict next-period return from current features.
   * Retrains model if stale.
   */
  predict(ticker, currentFeatures) {
    const tk = ticker.toUpperCase();
    const samples = this._features.get(tk);
    if (!samples || samples.length < ML_MIN_SAMPLES) return null;

    // Retrain if needed
    let model = this._models.get(tk);
    if (!model || Date.now() - model.lastTrain > ML_RETRAIN_INTERVAL_MS) {
      model = this._train(tk, samples);
      if (!model) return null;
      this._models.set(tk, model);
    }

    // Predict with both models
    const linearPred = this._linearPredict(model.linear, currentFeatures);
    const gbtPred = this._gbtPredict(model.gbt, currentFeatures);

    // Ensemble: 40% linear + 60% GBT (GBT captures non-linearities better)
    const ensemble = 0.4 * linearPred + 0.6 * gbtPred;

    const result = {
      ticker: tk,
      prediction: +ensemble.toFixed(6),
      linearPrediction: +linearPred.toFixed(6),
      gbtPrediction: +gbtPred.toFixed(6),
      direction: ensemble > 0 ? 'UP' : ensemble < 0 ? 'DOWN' : 'FLAT',
      confidence: Math.min(1, Math.abs(ensemble) * 1000),
      rSquared: +model.rSquared.toFixed(4),
      sampleCount: samples.length,
      features: currentFeatures,
      lastTrain: model.lastTrain,
    };

    this._predictions.set(tk, result);
    return result;
  }

  _train(ticker, samples) {
    const n = samples.length;
    if (n < ML_MIN_SAMPLES) return null;

    // Extract feature names (exclude _target and _ts)
    const featureNames = Object.keys(samples[0]).filter(k => !k.startsWith('_'));
    if (featureNames.length === 0) return null;

    // Build X matrix and y vector
    const X = [];
    const y = [];
    for (const s of samples) {
      const row = featureNames.map(f => s[f] || 0);
      X.push(row);
      y.push(s._target);
    }

    // 1. Train linear regression (OLS)
    const linear = this._trainLinear(X, y, featureNames);

    // 2. Train gradient-boosted stumps
    const gbt = this._trainGBT(X, y, featureNames);

    // Compute R² on last 20% as validation
    const valStart = Math.floor(n * 0.8);
    let ssTot = 0, ssRes = 0;
    const yMean = y.reduce((a, b) => a + b, 0) / y.length;
    for (let i = valStart; i < n; i++) {
      const pred = 0.4 * this._linearPredict(linear, this._featureObj(featureNames, X[i]))
                 + 0.6 * this._gbtPredict(gbt, this._featureObj(featureNames, X[i]));
      ssTot += (y[i] - yMean) ** 2;
      ssRes += (y[i] - pred) ** 2;
    }
    const rSquared = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

    return { linear, gbt, featureNames, rSquared, lastTrain: Date.now() };
  }

  _featureObj(names, row) {
    const obj = {};
    for (let i = 0; i < names.length; i++) obj[names[i]] = row[i];
    return obj;
  }

  /**
   * OLS Linear Regression (closed-form via normal equations).
   * Returns { weights, bias, featureNames }.
   */
  _trainLinear(X, y, featureNames) {
    const n = X.length;
    const p = featureNames.length;

    // Normalize features (z-score)
    const means = new Array(p).fill(0);
    const stds = new Array(p).fill(0);
    for (let j = 0; j < p; j++) {
      for (let i = 0; i < n; i++) means[j] += X[i][j];
      means[j] /= n;
      for (let i = 0; i < n; i++) stds[j] += (X[i][j] - means[j]) ** 2;
      stds[j] = Math.sqrt(stds[j] / n) || 1;
    }

    // Solve via gradient descent (stable for any feature count)
    const weights = new Array(p).fill(0);
    let bias = 0;
    const lr = 0.01;
    const epochs = 100;

    for (let epoch = 0; epoch < epochs; epoch++) {
      const dw = new Array(p).fill(0);
      let db = 0;

      for (let i = 0; i < n; i++) {
        let pred = bias;
        for (let j = 0; j < p; j++) {
          pred += weights[j] * ((X[i][j] - means[j]) / stds[j]);
        }
        const err = pred - y[i];
        for (let j = 0; j < p; j++) {
          dw[j] += err * ((X[i][j] - means[j]) / stds[j]);
        }
        db += err;
      }

      for (let j = 0; j < p; j++) {
        weights[j] -= lr * dw[j] / n;
      }
      bias -= lr * db / n;
    }

    return { weights, bias, means, stds, featureNames };
  }

  _linearPredict(model, features) {
    let pred = model.bias;
    for (let j = 0; j < model.featureNames.length; j++) {
      const val = features[model.featureNames[j]] || 0;
      pred += model.weights[j] * ((val - model.means[j]) / model.stds[j]);
    }
    return pred;
  }

  /**
   * Gradient-Boosted Decision Stumps.
   * Each "tree" is a single split on one feature at a threshold.
   * Boosting: fit residuals from previous ensemble.
   */
  _trainGBT(X, y, featureNames) {
    const n = X.length;
    const p = featureNames.length;
    const numRounds = 20;
    const learningRate = 0.1;
    const stumps = [];

    // Initialize residuals
    const residuals = [...y];
    const predictions = new Array(n).fill(0);

    for (let round = 0; round < numRounds; round++) {
      // Find best stump (feature + threshold + left/right values)
      let bestStump = null;
      let bestLoss = Infinity;

      for (let j = 0; j < p; j++) {
        // Try a few quantile thresholds
        const vals = X.map(row => row[j]).sort((a, b) => a - b);
        const thresholds = [
          vals[Math.floor(n * 0.25)],
          vals[Math.floor(n * 0.5)],
          vals[Math.floor(n * 0.75)],
        ];

        for (const thresh of thresholds) {
          let leftSum = 0, leftCount = 0, rightSum = 0, rightCount = 0;
          for (let i = 0; i < n; i++) {
            if (X[i][j] <= thresh) { leftSum += residuals[i]; leftCount++; }
            else { rightSum += residuals[i]; rightCount++; }
          }

          if (leftCount === 0 || rightCount === 0) continue;

          const leftVal = leftSum / leftCount;
          const rightVal = rightSum / rightCount;

          // MSE loss
          let loss = 0;
          for (let i = 0; i < n; i++) {
            const pred = X[i][j] <= thresh ? leftVal : rightVal;
            loss += (residuals[i] - pred) ** 2;
          }

          if (loss < bestLoss) {
            bestLoss = loss;
            bestStump = { feature: j, featureName: featureNames[j], threshold: thresh, leftVal, rightVal };
          }
        }
      }

      if (!bestStump) break;

      // Update predictions and residuals
      for (let i = 0; i < n; i++) {
        const stumpPred = X[i][bestStump.feature] <= bestStump.threshold
          ? bestStump.leftVal : bestStump.rightVal;
        predictions[i] += learningRate * stumpPred;
        residuals[i] = y[i] - predictions[i];
      }

      stumps.push({ ...bestStump, weight: learningRate });
    }

    return { stumps, featureNames };
  }

  _gbtPredict(model, features) {
    let pred = 0;
    for (const stump of model.stumps) {
      const val = features[stump.featureName] || 0;
      pred += stump.weight * (val <= stump.threshold ? stump.leftVal : stump.rightVal);
    }
    return pred;
  }

  getPrediction(ticker) {
    return this._predictions.get(ticker.toUpperCase()) || null;
  }

  getModelInfo(ticker) {
    const model = this._models.get(ticker.toUpperCase());
    if (!model) return null;
    return {
      featureNames: model.featureNames,
      rSquared: +model.rSquared.toFixed(4),
      linearWeights: Object.fromEntries(model.featureNames.map((f, i) => [f, +model.linear.weights[i].toFixed(6)])),
      gbtStumps: model.gbt.stumps.length,
      sampleCount: this._features.get(ticker.toUpperCase())?.length || 0,
      lastTrain: model.lastTrain,
    };
  }

  reset(ticker) {
    if (ticker) {
      const tk = ticker.toUpperCase();
      this._features.delete(tk);
      this._models.delete(tk);
      this._predictions.delete(tk);
    } else {
      this._features.clear();
      this._models.clear();
      this._predictions.clear();
    }
  }
}


// ═════════════════════════════════════════════════════════════════════════
// 6. COMPOSITE ALGO TRADING ENGINE
// ═════════════════════════════════════════════════════════════════════════
//
// Orchestrates all sub-engines, processes DatabentoLive events,
// and provides unified API + Discord formatting.
// ═════════════════════════════════════════════════════════════════════════

class AlgoTradingEngine extends EventEmitter {
  constructor() {
    super();

    this.bookSkew = new BookSkewEngine();
    this.obi = new OrderBookImbalanceEngine();
    this.vwapTwap = new VwapTwapEngine();
    this.pairs = new PairsTradingEngine();
    this.ml = new MLSignalCombiner();

    this._live = null;
    this._prevMidPrices = new Map();  // For ML target computation
    this._signalLog = [];             // Recent signals for audit

    // Register default pairs (common stat-arb pairs)
    this.pairs.addPair('SPY', 'QQQ');
    this.pairs.addPair('GLD', 'SLV');
    this.pairs.addPair('XLE', 'USO');
    this.pairs.addPair('MSFT', 'AAPL');
    this.pairs.addPair('JPM', 'BAC');
    this.pairs.addPair('TLT', 'IEF');
  }

  /**
   * Wire up to DatabentoLive client for real-time event processing.
   */
  connectLive(liveClient) {
    this._live = liveClient;

    // Process quote events → book skew + OBI
    liveClient.on('quote', (q) => this._onQuote(q));

    // Process trade events → VWAP/TWAP + pairs + ML
    liveClient.on('trade', (t) => this._onTrade(t));

    // Process OHLCV bars → bar-based VWAP
    liveClient.on('ohlcv', (bar) => this._onBar(bar));

    // Daily reset at market open
    liveClient.on('connected', () => {
      console.log('[AlgoTrading] Connected to DatabentoLive feed');
    });

    console.log('[AlgoTrading] Wired to DatabentoLive event stream');
  }

  _onQuote(quote) {
    if (!quote.underlying) return;
    const ticker = quote.underlying;

    // Only process underlying equity quotes (not individual options)
    // Options quotes have strike/expiration, equity quotes don't
    if (quote.strike || quote.expirationDate) return;

    const level = quote.level;
    if (!level) return;

    // Book Skew (top-of-book)
    const skewSignal = this.bookSkew.onQuote(
      ticker, level.bidPx, level.askPx, level.bidSz, level.askSz, quote.ts
    );
    if (skewSignal) {
      this._logSignal(skewSignal);
      this.emit('algo:skew_trade', skewSignal);
    }

    // 10-Level OBI (if depth levels available)
    if (quote.levels && quote.levels.length > 1) {
      const obiSignal = this.obi.onBookUpdate(ticker, quote.levels, quote.ts);
      if (obiSignal) {
        this._logSignal(obiSignal);
        this.emit('algo:obi_extreme', obiSignal);
      }
    }

    // ML feature engineering + prediction
    this._updateMLFeatures(ticker, quote.ts);
  }

  _onTrade(trade) {
    if (!trade.underlying || !trade.price || !trade.size) return;
    const ticker = trade.underlying;

    // Only underlying trades for algo engine (not individual option trades)
    // But we also use option trade prices for pairs via underlying mapping
    if (trade.strike || trade.expirationDate) return;

    // VWAP/TWAP
    const vwapSignal = this.vwapTwap.onTrade(ticker, trade.price, trade.size, trade.ts);
    if (vwapSignal) {
      this._logSignal(vwapSignal);
      this.emit('algo:vwap_cross', vwapSignal);
    }

    // Pairs trading
    const pairsSignals = this.pairs.onPrice(ticker, trade.price, trade.ts);
    for (const sig of pairsSignals) {
      this._logSignal(sig);
      this.emit('algo:pairs_signal', sig);
    }

    // Track mid price for ML target
    this._prevMidPrices.set(ticker, { price: trade.price, ts: trade.ts || Date.now() });
  }

  _onBar(bar) {
    if (!bar.underlying) return;
    this.vwapTwap.onBar(bar.underlying, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.ts);
  }

  _updateMLFeatures(ticker, ts) {
    // Build feature vector from all sub-engines
    const skewState = this.bookSkew.getState(ticker);
    const obiState = this.obi.getBook(ticker);
    const vwapState = this.vwapTwap.getVwap(ticker);

    if (!skewState) return;

    // Compute ML target: realized return over last observation
    const prev = this._prevMidPrices.get(ticker);
    if (prev && skewState.midPx > 0 && prev.price > 0) {
      const realizedReturn = (skewState.midPx - prev.price) / prev.price;

      // Build feature vector matching Databento HFT sklearn blog
      const features = {
        book_skew: skewState.skew || 0,
        spread_bps: skewState.spreadBps || 0,
        bid_size: Math.log10(Math.max(1, skewState.bidSz)),
        ask_size: Math.log10(Math.max(1, skewState.askSz)),
      };

      // Add OBI features if available
      if (obiState) {
        features.obi = obiState.obi;
        features.price_weighted_obi = obiState.priceWeightedObi;
        features.order_count_imbalance = obiState.orderCountImbalance;
        features.total_depth = Math.log10(Math.max(1, obiState.totalBidSz + obiState.totalAskSz));
      }

      // Add VWAP features if available
      if (vwapState) {
        features.vwap_delta_bps = vwapState.vwapDeltaBps || 0;
        features.price_vs_vwap = vwapState.lastPrice > vwapState.vwap ? 1 : -1;
      }

      // Add sample for training
      this.ml.addSample(ticker, features, realizedReturn);

      // Get prediction
      const prediction = this.ml.predict(ticker, features);
      if (prediction) {
        this.emit('algo:ml_prediction', prediction);
      }
    }
  }

  _logSignal(signal) {
    this._signalLog.push(signal);
    if (this._signalLog.length > 500) this._signalLog.splice(0, this._signalLog.length - 500);
  }

  // ── Query API ──────────────────────────────────────────────────────────

  /**
   * Get comprehensive algo trading state for a ticker.
   */
  getSignals(ticker) {
    const tk = ticker.toUpperCase();
    return {
      ticker: tk,
      bookSkew: this.bookSkew.getState(tk),
      position: this.bookSkew.getPosition(tk),
      obi: this.obi.getBook(tk),
      vwap: this.vwapTwap.getVwap(tk),
      barVwap: this.vwapTwap.getBarVwap(tk),
      volumeProfile: this.vwapTwap.getVolumeProfile(tk),
      mlPrediction: this.ml.getPrediction(tk),
      mlModel: this.ml.getModelInfo(tk),
      ts: Date.now(),
    };
  }

  /**
   * Get all pairs trading status.
   */
  getPairsStatus() {
    return this.pairs.getAllPairs();
  }

  /**
   * Get specific pair status.
   */
  getPairStatus(tickerY, tickerX) {
    return this.pairs.getPairStatus(tickerY, tickerX);
  }

  /**
   * Get P&L summary across all book skew positions.
   */
  getPnl() {
    return {
      bookSkew: this.bookSkew.getTotalPnl(),
      positions: this.bookSkew.getAllPositions(),
    };
  }

  /**
   * Get recent signal log.
   */
  getRecentSignals(limit = 20) {
    return this._signalLog.slice(-limit);
  }

  /**
   * Add a custom pairs trading pair.
   */
  addPair(tickerY, tickerX, opts) {
    this.pairs.addPair(tickerY, tickerX, opts);
  }

  /**
   * Format signals for Discord embed.
   */
  formatForDiscord(ticker) {
    const tk = ticker.toUpperCase();
    const signals = this.getSignals(tk);
    const parts = [`**Algo Trading Signals — ${tk}**\n`];

    // Book Skew
    if (signals.bookSkew) {
      const bs = signals.bookSkew;
      const skewDir = bs.skew > 0 ? '🟢' : bs.skew < 0 ? '🔴' : '⚪';
      parts.push(`**Book Skew (log₁₀):** ${skewDir} ${bs.skew.toFixed(4)}`);
      parts.push(`  Mid: $${bs.midPx.toFixed(2)} | Spread: ${bs.spreadBps.toFixed(1)}bps | Bid: ${bs.bidSz} | Ask: ${bs.askSz}`);

      if (Math.abs(bs.skew) > SKEW_THRESHOLD_K) {
        parts.push(`  ⚡ **SIGNAL:** ${bs.skew > 0 ? 'BUY' : 'SELL'} (skew ${bs.skew > 0 ? '>' : '<'} ${bs.skew > 0 ? '' : '-'}${SKEW_THRESHOLD_K})`);
      }
    } else {
      parts.push('**Book Skew:** No data');
    }

    // Position
    if (signals.position && (signals.position.lots !== 0 || signals.position.realizedPnl !== 0)) {
      const pos = signals.position;
      const posDir = pos.lots > 0 ? 'LONG' : pos.lots < 0 ? 'SHORT' : 'FLAT';
      const totalPnl = pos.realizedPnl + pos.unrealizedPnl;
      const pnlColor = totalPnl >= 0 ? '🟢' : '🔴';
      parts.push(`\n**Position:** ${posDir} ${Math.abs(pos.lots)} lots @ ${pos.avgEntry.toFixed(2)}`);
      parts.push(`  ${pnlColor} P&L: $${totalPnl.toFixed(2)} (realized: $${pos.realizedPnl.toFixed(2)}, unreal: $${pos.unrealizedPnl.toFixed(2)})`);
      parts.push(`  Trades: ${pos.tradeCount}`);
    }

    // OBI
    if (signals.obi) {
      const ob = signals.obi;
      const obiDir = ob.direction === 'BULLISH' ? '🟢' : ob.direction === 'BEARISH' ? '🔴' : '⚪';
      parts.push(`\n**Order Book Imbalance (${ob.numLevels}-level):** ${obiDir} ${(ob.obi * 100).toFixed(1)}%`);
      parts.push(`  Weighted OBI: ${(ob.priceWeightedObi * 100).toFixed(1)}% | Order Count: ${(ob.orderCountImbalance * 100).toFixed(1)}%`);
      parts.push(`  Bid depth: ${ob.totalBidSz.toLocaleString()} | Ask depth: ${ob.totalAskSz.toLocaleString()}`);
    }

    // VWAP
    if (signals.vwap) {
      const vw = signals.vwap;
      const vwDir = vw.priceVsVwap === 'ABOVE' ? '🟢' : vw.priceVsVwap === 'BELOW' ? '🔴' : '⚪';
      parts.push(`\n**VWAP:** ${vwDir} $${vw.vwap} (${vw.vwapDeltaBps}bps ${vw.priceVsVwap})`);
      parts.push(`  Bands: [$${vw.lowerBand1} — $${vw.upperBand1}] (±1σ)`);
      parts.push(`  Volume: ${vw.volume.toLocaleString()} | Trades: ${vw.tradeCount.toLocaleString()}`);
      if (vw.twap) parts.push(`  TWAP: $${vw.twap}`);
    }

    // Volume Profile POC
    if (signals.volumeProfile) {
      const vp = signals.volumeProfile;
      parts.push(`\n**Point of Control:** $${vp.poc.price} (${vp.poc.volume.toLocaleString()} vol)`);
    }

    // ML Prediction
    if (signals.mlPrediction) {
      const ml = signals.mlPrediction;
      const mlDir = ml.direction === 'UP' ? '🟢' : ml.direction === 'DOWN' ? '🔴' : '⚪';
      parts.push(`\n**ML Signal (combined):** ${mlDir} ${ml.direction} (conf: ${(ml.confidence * 100).toFixed(0)}%)`);
      parts.push(`  Linear: ${(ml.linearPrediction * 10000).toFixed(1)}bps | GBT: ${(ml.gbtPrediction * 10000).toFixed(1)}bps`);
      if (signals.mlModel) {
        parts.push(`  R²: ${signals.mlModel.rSquared} | Samples: ${signals.mlModel.sampleCount}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Format pairs trading status for Discord.
   */
  formatPairsForDiscord() {
    const pairs = this.getPairsStatus();
    if (pairs.length === 0) return '**Pairs Trading** — No pairs registered';

    const parts = ['**Pairs Trading — Statistical Arbitrage**\n'];

    for (const p of pairs) {
      const icon = p.position === 'long_spread' ? '🟢' : p.position === 'short_spread' ? '🔴' : '⚪';
      const cointIcon = p.cointegrated ? '✅' : '❌';

      parts.push(`${icon} **${p.pair}**`);
      if (p.currentZ !== null) {
        parts.push(`  Z-score: ${p.currentZ} | Hedge β: ${p.hedgeRatio || 'N/A'} | Corr: ${p.correlation || 'N/A'}`);
        parts.push(`  Cointegrated: ${cointIcon} | Position: ${p.position || 'FLAT'}`);
      } else {
        parts.push('  Waiting for data...');
        continue;
      }

      if (p.tradeCount > 0) {
        const pnlColor = p.pnl >= 0 ? '🟢' : '🔴';
        parts.push(`  ${pnlColor} P&L: ${p.pnl} | Win: ${p.winRate}% (${p.wins}W/${p.losses}L) | Sharpe: ${p.sharpe}`);
      }
    }

    parts.push(`\n_Entry: |z| > ${PAIRS_ENTRY_ZSCORE} | Exit: |z| < ${PAIRS_EXIT_ZSCORE} | Stop: |z| > ${PAIRS_EMERGENCY_ZSCORE}_`);
    return parts.join('\n');
  }

  /**
   * Format VWAP analysis for Discord.
   */
  formatVwapForDiscord(ticker) {
    const tk = ticker.toUpperCase();
    const vwap = this.vwapTwap.getVwap(tk);
    const barVwap = this.vwapTwap.getBarVwap(tk);
    const vp = this.vwapTwap.getVolumeProfile(tk);

    if (!vwap && !barVwap) return `**VWAP — ${tk}** — No trade data yet`;

    const parts = [`**VWAP / TWAP Analysis — ${tk}**\n`];

    if (vwap) {
      const dir = vwap.priceVsVwap === 'ABOVE' ? '🟢' : vwap.priceVsVwap === 'BELOW' ? '🔴' : '⚪';
      parts.push(`${dir} **Tick VWAP:** $${vwap.vwap}`);
      parts.push(`  Last: $${vwap.lastPrice || 'N/A'} | Delta: ${vwap.vwapDeltaBps}bps ${vwap.priceVsVwap}`);
      parts.push(`  Session H/L: $${vwap.high || 'N/A'} / $${vwap.low || 'N/A'}`);
      parts.push(`  ±1σ Band: [$${vwap.lowerBand1} — $${vwap.upperBand1}]`);
      parts.push(`  ±2σ Band: [$${vwap.lowerBand2} — $${vwap.upperBand2}]`);
      parts.push(`  Volume: ${vwap.volume.toLocaleString()} | Trades: ${vwap.tradeCount.toLocaleString()}`);
      if (vwap.twap) parts.push(`  TWAP: $${vwap.twap}`);
    }

    if (barVwap) {
      parts.push(`\n**Bar VWAP:** $${barVwap.barVwap} (${barVwap.barCount} bars, ${barVwap.totalVolume.toLocaleString()} vol)`);
    }

    if (vp) {
      parts.push(`\n**Volume Profile:**`);
      parts.push(`  Point of Control: $${vp.poc.price} (${vp.poc.volume.toLocaleString()} contracts)`);
      // Show top 5 volume levels
      const topLevels = vp.profile.sort((a, b) => b.volume - a.volume).slice(0, 5);
      for (const lv of topLevels) {
        const bar = '█'.repeat(Math.min(15, Math.round(lv.volume / vp.poc.volume * 15)));
        parts.push(`  $${lv.priceLow}-${lv.priceHigh}: ${bar} ${lv.volume.toLocaleString()}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Reset all state (e.g. at market open).
   */
  reset(ticker) {
    this.bookSkew.reset(ticker);
    this.obi.reset(ticker);
    this.vwapTwap.reset(ticker);
    this.ml.reset(ticker);
    if (!ticker) {
      this.pairs.reset();
      this._prevMidPrices.clear();
      this._signalLog = [];
    }
  }
}


// ── Singleton ────────────────────────────────────────────────────────────

const engine = new AlgoTradingEngine();

module.exports = {
  engine,

  // Sub-engine access
  bookSkew: engine.bookSkew,
  obi: engine.obi,
  vwapTwap: engine.vwapTwap,
  pairs: engine.pairs,
  ml: engine.ml,

  // Convenience methods
  getSignals: (ticker) => engine.getSignals(ticker),
  getPairsStatus: () => engine.getPairsStatus(),
  getPairStatus: (y, x) => engine.getPairStatus(y, x),
  getPnl: () => engine.getPnl(),
  getRecentSignals: (limit) => engine.getRecentSignals(limit),
  addPair: (y, x, opts) => engine.addPair(y, x, opts),

  // Discord formatting
  formatForDiscord: (ticker) => engine.formatForDiscord(ticker),
  formatPairsForDiscord: () => engine.formatPairsForDiscord(),
  formatVwapForDiscord: (ticker) => engine.formatVwapForDiscord(ticker),

  // Lifecycle
  connectLive: (client) => engine.connectLive(client),
  reset: (ticker) => engine.reset(ticker),
};
