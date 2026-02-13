/**
 * ML Trading Predictor — Machine Learning Price Prediction
 *
 * Uses Databento Historical MBP-10 (Market-by-Price, 10 levels) data to build
 * high-frequency trading signals and train linear regression models.
 *
 * Based on: https://databento.com/docs/examples/algo-trading/machine-learning
 *
 * Features:
 *   - Book skew: log(bid_size) - log(ask_size) at top-of-book
 *   - Order imbalance: log(total_bid_count) - log(total_ask_count) across 10 levels
 *   - Forward midprice return (markout)
 *
 * Model: OLS linear regression with non-negative coefficient constraint
 *
 * Supported products: ES, NQ, CL, GC, YM, RTY, ZB, ZN and other CME Globex futures
 * Dataset: GLBX.MDP3 (CME Globex MDP 3.0)
 */

const path = require('path');
const config = require('../config');

const HIST_BASE = 'https://hist.databento.com';
const API_VERSION = '0';
const PRICE_SCALE = 1_000_000_000;

// Chart renderer (lazy-loaded)
let chartRenderer = null;
const FONT_FAMILY = 'Inter, "Segoe UI", Arial, sans-serif';

try {
  const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
  const { registerFont } = require('canvas');

  const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
  try {
    registerFont(path.join(FONT_DIR, 'Inter-Regular.ttf'), { family: 'Inter' });
    registerFont(path.join(FONT_DIR, 'Inter-Bold.ttf'), { family: 'Inter', weight: 'bold' });
  } catch {
    // Fonts may already be registered by gamma.js
  }

  chartRenderer = new ChartJSNodeCanvas({
    width: 800,
    height: 480,
    backgroundColour: '#1e1e2e',
    chartCallback: (ChartJS) => {
      ChartJS.defaults.font.family = FONT_FAMILY;
    },
  });
  console.log('[ML-Predictor] Chart renderer loaded');
} catch (err) {
  console.warn('[ML-Predictor] Canvas module failed to load — chart rendering disabled:', err.message);
}

// Result cache to avoid re-running expensive predictions
const _resultCache = new Map();
const RESULT_CACHE_TTL = 5 * 60 * 1000; // 5 min

// Product metadata: dataset and front-month continuous symbol format
const PRODUCTS = {
  ES:  { dataset: 'GLBX.MDP3', name: 'E-mini S&P 500' },
  NQ:  { dataset: 'GLBX.MDP3', name: 'E-mini Nasdaq-100' },
  YM:  { dataset: 'GLBX.MDP3', name: 'E-mini Dow' },
  RTY: { dataset: 'GLBX.MDP3', name: 'E-mini Russell 2000' },
  CL:  { dataset: 'GLBX.MDP3', name: 'Crude Oil' },
  GC:  { dataset: 'GLBX.MDP3', name: 'Gold' },
  SI:  { dataset: 'GLBX.MDP3', name: 'Silver' },
  ZB:  { dataset: 'GLBX.MDP3', name: '30-Year Treasury Bond' },
  ZN:  { dataset: 'GLBX.MDP3', name: '10-Year Treasury Note' },
  ZF:  { dataset: 'GLBX.MDP3', name: '5-Year Treasury Note' },
  HG:  { dataset: 'GLBX.MDP3', name: 'Copper' },
  NG:  { dataset: 'GLBX.MDP3', name: 'Natural Gas' },
};

class MLPredictor {
  constructor() {
    this._authHeader = null;
  }

  get enabled() {
    return !!config.databentoApiKey;
  }

  _getAuthHeader() {
    if (!this._authHeader) {
      const encoded = Buffer.from(config.databentoApiKey + ':').toString('base64');
      this._authHeader = `Basic ${encoded}`;
    }
    return this._authHeader;
  }

  // ── Databento Historical API ─────────────────────────────────────────

  /**
   * Fetch MBP-10 data from Databento Historical API.
   * Returns raw JSON records (one per book update event).
   */
  async _fetchMBP10(product, start, end, timeoutMs = 120000) {
    if (!this.enabled) throw new Error('Databento API key not configured');

    const meta = PRODUCTS[product.toUpperCase()];
    if (!meta) throw new Error(`Unknown product: ${product}. Supported: ${Object.keys(PRODUCTS).join(', ')}`);

    const url = `${HIST_BASE}/v${API_VERSION}/timeseries.get_range`;
    const params = {
      dataset: meta.dataset,
      schema: 'mbp-10',
      symbols: `${product.toUpperCase()}.v.0`, // front-month continuous
      stype_in: 'continuous',
      encoding: 'json',
      compression: 'none',
      start,
      end,
    };

    const body = new URLSearchParams(params);
    console.log(`[ML-Predictor] Fetching MBP-10 for ${product} from ${start} to ${end}`);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': this._getAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Databento API ${res.status}: ${text.slice(0, 500)}`);
    }

    const text = await res.text();
    const records = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines
      }
    }

    console.log(`[ML-Predictor] Received ${records.length} MBP-10 records for ${product}`);
    return records;
  }

  // ── Feature Extraction ────────────────────────────────────────────────

  /**
   * Extract a level's bid/ask price, size, and count from a record.
   * Handles both flat format (bid_px_00) and nested levels array.
   */
  _getLevel(rec, level) {
    const pad = String(level).padStart(2, '0');

    // Try flat format first (bid_px_00, ask_px_00, etc.)
    if (rec[`bid_px_${pad}`] != null) {
      return {
        bidPx: rec[`bid_px_${pad}`] / PRICE_SCALE,
        askPx: rec[`ask_px_${pad}`] / PRICE_SCALE,
        bidSz: rec[`bid_sz_${pad}`] || 0,
        askSz: rec[`ask_sz_${pad}`] || 0,
        bidCt: rec[`bid_ct_${pad}`] || 0,
        askCt: rec[`ask_ct_${pad}`] || 0,
      };
    }

    // Try nested levels array
    if (rec.levels && rec.levels[level]) {
      const lv = rec.levels[level];
      return {
        bidPx: (lv.bid_px || 0) / PRICE_SCALE,
        askPx: (lv.ask_px || 0) / PRICE_SCALE,
        bidSz: lv.bid_sz || 0,
        askSz: lv.ask_sz || 0,
        bidCt: lv.bid_ct || 0,
        askCt: lv.ask_ct || 0,
      };
    }

    return { bidPx: 0, askPx: 0, bidSz: 0, askSz: 0, bidCt: 0, askCt: 0 };
  }

  /**
   * Get the action type from a record.
   * Trade actions: 'T' (trade) or numeric equivalent.
   */
  _isTrade(rec) {
    const action = rec.action;
    if (typeof action === 'string') return action === 'T';
    // Databento action enum: Trade = 84 (ASCII 'T')
    if (typeof action === 'number') return action === 84;
    return false;
  }

  /**
   * Process raw MBP-10 records into a feature DataFrame.
   * Filters to trades only, calculates features, and forward returns.
   *
   * @param {object[]} records - Raw MBP-10 JSON records
   * @param {number} markout - Forward trade count for return calculation (default 500)
   * @returns {object} { data: Array<{mid, skew, imbalance, ret}>, stats }
   */
  buildFeatures(records, markout = 500) {
    // Step 1: Filter to trade events only
    const trades = records.filter(rec => this._isTrade(rec));

    if (trades.length < markout * 2) {
      throw new Error(`Insufficient trade data: ${trades.length} trades (need at least ${markout * 2} for markout=${markout})`);
    }

    // Step 2: Extract features for each trade
    const rows = [];
    for (const rec of trades) {
      const top = this._getLevel(rec, 0);

      // Skip records with invalid prices
      if (top.bidPx <= 0 || top.askPx <= 0 || top.bidSz <= 0 || top.askSz <= 0) continue;

      // Midprice
      const mid = (top.bidPx + top.askPx) / 2;

      // Book skew: log imbalance of top-level sizes
      const skew = Math.log(top.bidSz) - Math.log(top.askSz);

      // Order imbalance: log imbalance of order count across all 10 levels
      let totalBidCt = 0;
      let totalAskCt = 0;
      for (let i = 0; i < 10; i++) {
        const lv = this._getLevel(rec, i);
        totalBidCt += lv.bidCt;
        totalAskCt += lv.askCt;
      }

      // Guard against zero counts
      if (totalBidCt <= 0 || totalAskCt <= 0) continue;

      const imbalance = Math.log(totalBidCt) - Math.log(totalAskCt);

      rows.push({ mid, skew, imbalance });
    }

    if (rows.length < markout * 2) {
      throw new Error(`Insufficient valid trades after filtering: ${rows.length} (need ${markout * 2})`);
    }

    // Step 3: Calculate forward midprice returns (markout)
    const data = [];
    for (let i = 0; i < rows.length - markout; i++) {
      data.push({
        mid: rows[i].mid,
        skew: rows[i].skew,
        imbalance: rows[i].imbalance,
        ret: rows[i + markout].mid - rows[i].mid,
      });
    }

    return {
      data,
      stats: {
        totalRecords: records.length,
        totalTrades: trades.length,
        validRows: data.length,
        markout,
      },
    };
  }

  // ── Linear Regression (OLS) ───────────────────────────────────────────

  /**
   * Fit OLS linear regression: y = X * beta (no intercept, non-negative coefficients).
   *
   * For 1-2 features, uses closed-form normal equations.
   * Applies non-negative constraint by clipping coefficients to 0.
   *
   * @param {number[][]} X - Feature matrix (N x p)
   * @param {number[]} y - Target vector (N)
   * @returns {number[]} Coefficients (p)
   */
  fitLinearRegression(X, y) {
    const n = X.length;
    const p = X[0].length;

    // X^T X (p x p)
    const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < p; j++) {
        for (let k = 0; k < p; k++) {
          XtX[j][k] += X[i][j] * X[i][k];
        }
      }
    }

    // X^T y (p x 1)
    const Xty = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < p; j++) {
        Xty[j] += X[i][j] * y[i];
      }
    }

    // Solve XtX * beta = Xty
    let beta;
    if (p === 1) {
      beta = [XtX[0][0] > 0 ? Xty[0] / XtX[0][0] : 0];
    } else if (p === 2) {
      // 2x2 matrix inverse
      const det = XtX[0][0] * XtX[1][1] - XtX[0][1] * XtX[1][0];
      if (Math.abs(det) < 1e-12) {
        beta = [0, 0]; // Singular matrix
      } else {
        beta = [
          (XtX[1][1] * Xty[0] - XtX[0][1] * Xty[1]) / det,
          (XtX[0][0] * Xty[1] - XtX[1][0] * Xty[0]) / det,
        ];
      }
    } else {
      // For larger systems, use Gaussian elimination
      beta = this._solveGaussian(XtX, Xty);
    }

    // Non-negative constraint: clip to 0
    return beta.map(b => Math.max(0, b));
  }

  /**
   * Gaussian elimination for Ax = b.
   */
  _solveGaussian(A, b) {
    const n = A.length;
    const aug = A.map((row, i) => [...row, b[i]]);

    for (let col = 0; col < n; col++) {
      // Partial pivoting
      let maxRow = col;
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
      }
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

      if (Math.abs(aug[col][col]) < 1e-12) continue;

      // Eliminate below
      for (let row = col + 1; row < n; row++) {
        const factor = aug[row][col] / aug[col][col];
        for (let j = col; j <= n; j++) {
          aug[row][j] -= factor * aug[col][j];
        }
      }
    }

    // Back substitution
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      if (Math.abs(aug[i][i]) < 1e-12) continue;
      x[i] = aug[i][n];
      for (let j = i + 1; j < n; j++) {
        x[i] -= aug[i][j] * x[j];
      }
      x[i] /= aug[i][i];
    }

    return x;
  }

  /**
   * Predict using fitted coefficients: y_hat = X * beta
   */
  predict(X, beta) {
    return X.map(row => row.reduce((sum, x, j) => sum + x * beta[j], 0));
  }

  // ── Correlation Matrix ────────────────────────────────────────────────

  /**
   * Compute Pearson correlation matrix for named columns.
   */
  correlationMatrix(data, columns) {
    const n = data.length;
    const vals = columns.map(col => data.map(d => d[col]));

    const means = vals.map(v => v.reduce((s, x) => s + x, 0) / n);
    const stds = vals.map((v, i) => {
      const m = means[i];
      return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / n);
    });

    const corr = Array.from({ length: columns.length }, () => new Array(columns.length).fill(0));
    for (let i = 0; i < columns.length; i++) {
      for (let j = 0; j < columns.length; j++) {
        if (stds[i] === 0 || stds[j] === 0) {
          corr[i][j] = 0;
          continue;
        }
        let cov = 0;
        for (let k = 0; k < n; k++) {
          cov += (vals[i][k] - means[i]) * (vals[j][k] - means[j]);
        }
        corr[i][j] = cov / (n * stds[i] * stds[j]);
      }
    }

    return { columns, matrix: corr };
  }

  // ── Cumulative Markout PnL ────────────────────────────────────────────

  /**
   * Calculate cumulative markout PnL from predictions.
   * Sorts by absolute prediction value, flips return sign for short predictions.
   *
   * Logic: for each trade, if we predict positive return -> go long (keep return as-is)
   *        if we predict negative return -> go short (flip return sign)
   *        sort by prediction value to show PnL from most negative to most positive signal
   */
  getCumulativeMarkoutPnL(predictions, actualReturns) {
    const pairs = predictions.map((pred, i) => ({
      pred,
      ret: pred < 0 ? -actualReturns[i] : actualReturns[i],
    }));

    // Sort by prediction value (most negative to most positive)
    pairs.sort((a, b) => a.pred - b.pred);

    // Cumulative sum
    let cumSum = 0;
    return pairs.map(p => {
      cumSum += p.ret;
      return cumSum;
    });
  }

  // ── Main Prediction Pipeline ──────────────────────────────────────────

  /**
   * Run the full ML prediction pipeline for a futures product.
   *
   * @param {string} product - Futures product (e.g. 'ES', 'NQ')
   * @param {object} [options]
   * @param {string} [options.start] - Start time ISO 8601
   * @param {string} [options.end] - End time ISO 8601
   * @param {number} [options.markout=500] - Forward trade count for returns
   * @param {number} [options.trainSplit=0.66] - In-sample fraction
   * @returns {Promise<object>} Full prediction results
   */
  async runPrediction(product, options = {}) {
    product = product.toUpperCase();
    const meta = PRODUCTS[product];
    if (!meta) throw new Error(`Unknown product: ${product}. Supported: ${Object.keys(PRODUCTS).join(', ')}`);

    const markout = options.markout || 500;
    const trainSplit = options.trainSplit || 0.66;

    // Default: use yesterday's regular trading hours (or a recent trading day)
    let { start, end } = options;
    if (!start || !end) {
      const d = _lastTradingDay();
      start = `${d}T14:30:00`;  // 9:30 AM ET = 14:30 UTC
      end = `${d}T21:00:00`;    // 4:00 PM ET = 21:00 UTC
    }

    // Check cache
    const cacheKey = `${product}_${start}_${end}_${markout}`;
    const cached = _resultCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < RESULT_CACHE_TTL) return cached.data;

    // Step 1: Fetch MBP-10 data
    const records = await this._fetchMBP10(product, start, end);

    // Step 2: Build features
    const { data, stats: featureStats } = this.buildFeatures(records, markout);

    // Step 3: Train/test split
    let splitIdx = Math.floor(trainSplit * data.length);
    splitIdx -= splitIdx % 100; // Round to nearest 100
    const trainData = data.slice(0, splitIdx);
    const testData = data.slice(splitIdx);

    if (trainData.length < 100 || testData.length < 100) {
      throw new Error(`Insufficient data for train/test split: ${trainData.length} train, ${testData.length} test`);
    }

    // Step 4: Correlation analysis (in-sample)
    const corr = this.correlationMatrix(trainData, ['skew', 'imbalance', 'ret']);

    // Step 5: Train models
    const trainY = trainData.map(d => d.ret);
    const testY = testData.map(d => d.ret);

    // Model 1: Skew only
    const trainX_skew = trainData.map(d => [d.skew]);
    const testX_skew = testData.map(d => [d.skew]);
    const beta_skew = this.fitLinearRegression(trainX_skew, trainY);
    const pred_skew = this.predict(testX_skew, beta_skew);

    // Model 2: Imbalance only
    const trainX_imb = trainData.map(d => [d.imbalance]);
    const testX_imb = testData.map(d => [d.imbalance]);
    const beta_imb = this.fitLinearRegression(trainX_imb, trainY);
    const pred_imb = this.predict(testX_imb, beta_imb);

    // Model 3: Combined (skew + imbalance)
    const trainX_combo = trainData.map(d => [d.skew, d.imbalance]);
    const testX_combo = testData.map(d => [d.skew, d.imbalance]);
    const beta_combo = this.fitLinearRegression(trainX_combo, trainY);
    const pred_combo = this.predict(testX_combo, beta_combo);

    // Step 6: Cumulative markout PnL
    const pnl_skew = this.getCumulativeMarkoutPnL(pred_skew, testY);
    const pnl_imb = this.getCumulativeMarkoutPnL(pred_imb, testY);
    const pnl_combo = this.getCumulativeMarkoutPnL(pred_combo, testY);

    // Step 7: Calculate out-of-sample correlations
    const oosCorr_skew = _pearson(pred_skew, testY);
    const oosCorr_imb = _pearson(pred_imb, testY);
    const oosCorr_combo = _pearson(pred_combo, testY);

    const result = {
      product,
      productName: meta.name,
      start,
      end,
      markout,
      trainSplit,
      featureStats,
      trainSize: trainData.length,
      testSize: testData.length,
      correlation: corr,
      models: {
        skew: {
          name: 'Book Skew',
          coefficients: { skew: beta_skew[0] },
          oosCorrelation: oosCorr_skew,
          finalPnL: pnl_skew[pnl_skew.length - 1],
        },
        imbalance: {
          name: 'Order Imbalance',
          coefficients: { imbalance: beta_imb[0] },
          oosCorrelation: oosCorr_imb,
          finalPnL: pnl_imb[pnl_imb.length - 1],
        },
        combined: {
          name: 'Combined (Skew + Imbalance)',
          coefficients: { skew: beta_combo[0], imbalance: beta_combo[1] },
          oosCorrelation: oosCorr_combo,
          finalPnL: pnl_combo[pnl_combo.length - 1],
        },
      },
      pnlCurves: { skew: pnl_skew, imbalance: pnl_imb, combined: pnl_combo },
    };

    _resultCache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  }

  // ── Chart Generation ──────────────────────────────────────────────────

  /**
   * Render cumulative PnL chart as PNG buffer.
   */
  async renderPnLChart(result) {
    if (!chartRenderer) throw new Error('Chart renderer not available');

    const { pnlCurves, product, productName, testSize } = result;

    // Subsample for chart (max 500 points)
    const maxPoints = 500;
    const step = Math.max(1, Math.floor(testSize / maxPoints));

    const labels = [];
    const skewData = [];
    const imbData = [];
    const comboData = [];

    for (let i = 0; i < testSize; i += step) {
      labels.push(Math.round((i / testSize) * 100));
      skewData.push(pnlCurves.skew[i]);
      imbData.push(pnlCurves.imbalance[i]);
      comboData.push(pnlCurves.combined[i]);
    }

    const chartConfig = {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Book Skew',
            data: skewData,
            borderColor: 'rgba(59, 130, 246, 1)',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
          },
          {
            label: 'Order Imbalance',
            data: imbData,
            borderColor: 'rgba(250, 204, 21, 1)',
            backgroundColor: 'rgba(250, 204, 21, 0.1)',
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
          },
          {
            label: 'Combined',
            data: comboData,
            borderColor: 'rgba(34, 197, 94, 1)',
            backgroundColor: 'rgba(34, 197, 94, 0.1)',
            borderWidth: 2.5,
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: {
        responsive: false,
        plugins: {
          title: {
            display: true,
            text: `${product} (${productName}) — ML Forecast: Book Skew vs. Imbalance`,
            color: '#e0e0e0',
            font: { family: FONT_FAMILY, size: 15, weight: 'bold' },
          },
          legend: {
            display: true,
            position: 'top',
            labels: {
              color: '#c0c0c0',
              font: { family: FONT_FAMILY, size: 12 },
              usePointStyle: true,
              pointStyle: 'line',
            },
          },
          subtitle: {
            display: true,
            text: `Out-of-sample cumulative markout return (${result.markout}-trade forward)`,
            color: '#888',
            font: { family: FONT_FAMILY, size: 11 },
          },
        },
        scales: {
          x: {
            title: {
              display: true,
              text: 'Predictor value (percentile)',
              color: '#a0a0a0',
              font: { family: FONT_FAMILY },
            },
            ticks: {
              color: '#a0a0a0',
              font: { family: FONT_FAMILY },
              maxTicksLimit: 10,
            },
            grid: { color: 'rgba(255,255,255,0.05)' },
          },
          y: {
            title: {
              display: true,
              text: 'Cumulative return (ticks)',
              color: '#a0a0a0',
              font: { family: FONT_FAMILY },
            },
            ticks: {
              color: '#a0a0a0',
              font: { family: FONT_FAMILY },
              callback: (v) => v.toFixed(2),
            },
            grid: { color: 'rgba(255,255,255,0.1)' },
          },
        },
      },
    };

    return chartRenderer.renderToBuffer(chartConfig);
  }

  // ── Discord Formatting ────────────────────────────────────────────────

  /**
   * Format correlation matrix as a Discord code block.
   */
  formatCorrelationMatrix(corr) {
    const { columns, matrix } = corr;
    const colWidth = 12;

    let out = '```\n';
    out += ''.padEnd(colWidth) + columns.map(c => c.padStart(colWidth)).join('') + '\n';

    for (let i = 0; i < columns.length; i++) {
      let row = columns[i].padEnd(colWidth);
      for (let j = 0; j < columns.length; j++) {
        // Upper-triangle only (like the Python example)
        if (j >= i) {
          row += matrix[i][j].toFixed(6).padStart(colWidth);
        } else {
          row += ''.padStart(colWidth);
        }
      }
      out += row + '\n';
    }

    out += '```';
    return out;
  }

  /**
   * Format full results as Discord message.
   */
  formatResults(result) {
    const { product, productName, start, end, markout, featureStats, trainSize, testSize, models, correlation } = result;

    const lines = [
      `**ML Price Predictor — ${product} (${productName})**`,
      '',
      `**Data:** ${featureStats.totalRecords.toLocaleString()} MBP-10 records | ${featureStats.totalTrades.toLocaleString()} trades`,
      `**Period:** ${start} to ${end}`,
      `**Markout:** ${markout} trades forward | **Split:** ${trainSize.toLocaleString()} train / ${testSize.toLocaleString()} test`,
      '',
      `**In-Sample Correlation Matrix:**`,
      this.formatCorrelationMatrix(correlation),
      '',
      '**Out-of-Sample Model Performance:**',
    ];

    for (const [key, model] of Object.entries(models)) {
      const coeffStr = Object.entries(model.coefficients)
        .map(([k, v]) => `${k}=${v.toFixed(6)}`)
        .join(', ');
      const pnlSign = model.finalPnL >= 0 ? '+' : '';
      lines.push(`  **${model.name}** | corr=${model.oosCorrelation.toFixed(4)} | PnL=${pnlSign}${model.finalPnL.toFixed(2)} ticks | coeff: ${coeffStr}`);
    }

    // Determine best model
    const best = Object.entries(models).reduce((a, b) => b[1].finalPnL > a[1].finalPnL ? b : a);
    lines.push('');
    lines.push(`**Best model:** ${best[1].name} (${best[1].finalPnL >= 0 ? '+' : ''}${best[1].finalPnL.toFixed(2)} ticks cumulative return)`);

    return lines.join('\n');
  }

  /**
   * Get supported products list.
   */
  getSupportedProducts() {
    return Object.entries(PRODUCTS).map(([symbol, meta]) => ({
      symbol,
      name: meta.name,
    }));
  }

  getStatus() {
    return {
      enabled: this.enabled,
      chartRendererReady: !!chartRenderer,
      supportedProducts: Object.keys(PRODUCTS),
      cacheSize: _resultCache.size,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Get the last trading day (skip weekends).
 */
function _lastTradingDay() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const day = d.getDay();
  if (day === 0) d.setDate(d.getDate() - 2); // Sunday -> Friday
  if (day === 6) d.setDate(d.getDate() - 1); // Saturday -> Friday
  return d.toISOString().slice(0, 10);
}

/**
 * Pearson correlation between two arrays.
 */
function _pearson(a, b) {
  const n = a.length;
  if (n === 0) return 0;

  const meanA = a.reduce((s, x) => s + x, 0) / n;
  const meanB = b.reduce((s, x) => s + x, 0) / n;

  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }

  const denom = Math.sqrt(varA * varB);
  return denom > 0 ? cov / denom : 0;
}

module.exports = new MLPredictor();
