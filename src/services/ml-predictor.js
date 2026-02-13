/**
 * ML Trading Predictor — MBP-10 Order Book Machine Learning Pipeline
 *
 * Node.js bridge to the Python ML service (ml/predictor.py).
 *
 * Uses the official Databento Python client with scikit-learn to:
 *   1. Fetch 10-level order book data (MBP-10 schema) via `databento` library
 *   2. Extract features: skew, imbalance, depth pressure, spread, microprice
 *   3. Train LinearRegression + HistGradientBoostingRegressor (scikit-learn)
 *   4. Generate matplotlib PnL charts
 *   5. Return JSON results to Discord bot
 *
 * Based on: https://databento.com/blog/hft-sklearn-python
 * Docs:     https://databento.com/docs/api-reference-historical/client
 * Schema:   https://databento.com/docs/schemas-and-data-formats/mbp-10
 *
 * Dependencies (Python): databento, scikit-learn, matplotlib, numpy, pandas
 * Install: pip install -r ml/requirements.txt
 *
 * Supported products: ES, NQ, CL, GC, YM, RTY, ZB, ZN and other CME Globex futures
 * Dataset: GLBX.MDP3 (CME Globex MDP 3.0)
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('../config');

const ML_SCRIPT = path.join(__dirname, '..', '..', 'ml', 'predictor.py');

// Result cache
const _resultCache = new Map();
const RESULT_CACHE_TTL = 5 * 60 * 1000; // 5 min

// Product metadata (mirrors ml/predictor.py for validation before spawning Python)
const PRODUCTS = {
  ES:  { name: 'E-mini S&P 500' },
  NQ:  { name: 'E-mini Nasdaq-100' },
  YM:  { name: 'E-mini Dow' },
  RTY: { name: 'E-mini Russell 2000' },
  CL:  { name: 'Crude Oil' },
  GC:  { name: 'Gold' },
  SI:  { name: 'Silver' },
  ZB:  { name: '30-Year Treasury Bond' },
  ZN:  { name: '10-Year Treasury Note' },
  ZF:  { name: '5-Year Treasury Note' },
  HG:  { name: 'Copper' },
  NG:  { name: 'Natural Gas' },
};

class MLPredictor {
  get enabled() {
    return !!config.databentoApiKey;
  }

  /**
   * Run the full ML prediction pipeline via Python subprocess.
   *
   * @param {string} product - Futures product (e.g. 'ES', 'NQ')
   * @param {object} [options]
   * @param {string} [options.start] - Start time
   * @param {string} [options.end] - End time
   * @param {string} [options.date] - Trading date (YYYY-MM-DD)
   * @param {number} [options.markout=500] - Forward trade count for returns
   * @param {number} [options.trainSplit=0.66] - In-sample fraction
   * @param {string} [options.model='both'] - Model type: 'linear', 'gradient_boost', or 'both'
   * @returns {Promise<object>} Full prediction results from Python
   */
  async runPrediction(product, options = {}) {
    product = product.toUpperCase();
    const meta = PRODUCTS[product];
    if (!meta) throw new Error(`Unknown product: ${product}. Supported: ${Object.keys(PRODUCTS).join(', ')}`);
    if (!this.enabled) throw new Error('Databento API key not configured (DATABENTO_API_KEY)');

    const markout = options.markout || 500;
    const model = options.model || 'both';

    // Default: last trading day regular hours
    let start = options.start;
    let end = options.end;
    const date = options.date;

    // Check cache
    const cacheKey = `${product}_${date || start}_${end}_${markout}_${model}`;
    const cached = _resultCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < RESULT_CACHE_TTL) {
      console.log(`[ML-Predictor] Cache hit for ${cacheKey}`);
      return cached.data;
    }

    // Build Python CLI args
    const args = [ML_SCRIPT, '--product', product, '--markout', String(markout), '--model', model];

    if (date) {
      args.push('--date', date);
    } else if (start && end) {
      args.push('--start', start, '--end', end);
    }
    // If neither date nor start/end, Python will default to last trading day

    args.push('--train-split', String(options.trainSplit || 0.66));

    console.log(`[ML-Predictor] Spawning Python ML pipeline for ${product} (markout=${markout}, model=${model})`);
    const t0 = Date.now();

    const result = await this._spawnPython(args);
    const elapsed = Date.now() - t0;
    console.log(`[ML-Predictor] Python pipeline completed in ${(elapsed / 1000).toFixed(1)}s`);

    if (result.error) {
      throw new Error(result.error);
    }

    // Cache result
    _resultCache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  }

  /**
   * Spawn Python process and capture JSON output.
   */
  _spawnPython(args) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, DATABENTO_API_KEY: config.databentoApiKey };

      const proc = spawn('python3', args, {
        env,
        cwd: path.join(__dirname, '..', '..'),
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 300_000, // 5 min max
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk) => {
        const line = chunk.toString();
        stderr += line;
        // Forward Python logs to Node console
        if (line.trim()) console.log(line.trimEnd());
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn Python: ${err.message}. Ensure python3 and ml/requirements.txt dependencies are installed.`));
      });

      proc.on('close', (code) => {
        if (code !== 0 && !stdout.trim()) {
          const errMsg = stderr.trim().split('\n').slice(-3).join(' ') || `Python exited with code ${code}`;
          reject(new Error(errMsg));
          return;
        }

        try {
          const result = JSON.parse(stdout.trim());
          resolve(result);
        } catch (parseErr) {
          reject(new Error(`Failed to parse Python output: ${parseErr.message}\nstdout: ${stdout.slice(0, 500)}`));
        }
      });
    });
  }

  /**
   * Get the chart image buffer from the path returned by Python.
   * @param {object} result - Result from runPrediction
   * @returns {Promise<Buffer>} PNG image buffer
   */
  async getChartBuffer(result) {
    if (!result.chart_path) throw new Error('No chart generated');
    try {
      const buf = fs.readFileSync(result.chart_path);
      // Clean up temp file
      fs.unlink(result.chart_path, () => {});
      return buf;
    } catch (err) {
      throw new Error(`Failed to read chart: ${err.message}`);
    }
  }

  // ── Discord Formatting ────────────────────────────────────────────────

  formatCorrelationMatrix(result) {
    const { correlation, correlation_columns: columns } = result;
    if (!correlation || !columns) return '*(correlation data unavailable)*';

    const colWidth = 16;
    let out = '```\n';
    out += ''.padEnd(colWidth) + columns.map(c => c.slice(0, 14).padStart(colWidth)).join('') + '\n';

    for (let i = 0; i < columns.length; i++) {
      let row = columns[i].slice(0, 14).padEnd(colWidth);
      for (let j = 0; j < columns.length; j++) {
        const key = `${columns[i]}__${columns[j]}`;
        const altKey = `${columns[j]}__${columns[i]}`;
        const val = correlation[key] ?? correlation[altKey] ?? '';
        row += (j >= i && val !== '' ? Number(val).toFixed(4) : '').padStart(colWidth);
      }
      out += row + '\n';
    }
    out += '```';
    return out;
  }

  formatResults(result) {
    const { product, product_name, start, end, total_raw_records, total_trade_samples,
            train_size, test_size, markout, models, best_model, best_model_name, best_pnl } = result;

    const startDate = (start || '').replace(/T.*/, '');
    const lines = [
      `**ML Order Book Predictor — ${product} (${product_name})**`,
      '',
      `**Schema:** MBP-10 (10-level order book) | **Date:** ${startDate}`,
      `**Data:** ${(total_raw_records || 0).toLocaleString()} raw records -> ${(total_trade_samples || 0).toLocaleString()} trade samples`,
      `**Markout:** ${markout} trades forward | **Split:** ${(train_size || 0).toLocaleString()} train / ${(test_size || 0).toLocaleString()} test`,
      '',
      `**Features:** skew, imbalance, depth_pressure, spread, micro_dev`,
      '',
      `**In-Sample Correlation Matrix:**`,
      this.formatCorrelationMatrix(result),
      '',
      '**Out-of-Sample Model Performance:**',
    ];

    if (models) {
      for (const [key, model] of Object.entries(models)) {
        const coeffStr = model.coefficients
          ? Object.entries(model.coefficients).map(([k, v]) => `${k}=${Number(v).toFixed(4)}`).join(', ')
          : '';
        const pnlSign = model.final_pnl >= 0 ? '+' : '';
        const r2 = model.r_squared != null ? ` | R²=${Number(model.r_squared).toFixed(4)}` : '';
        const type = model.type === 'gradient_boost' ? ' [GBT]' : ' [LR]';
        lines.push(`  **${model.name}**${type}`);
        lines.push(`    corr=${Number(model.oos_correlation).toFixed(4)}${r2} | PnL=${pnlSign}${Number(model.final_pnl).toFixed(2)}`);
        if (coeffStr) lines.push(`    ${model.type === 'gradient_boost' ? 'importance' : 'coeff'}: ${coeffStr}`);
      }
    }

    lines.push('');
    if (best_model_name) {
      const sign = best_pnl >= 0 ? '+' : '';
      lines.push(`**Best model:** ${best_model_name} (${sign}${Number(best_pnl).toFixed(2)} ticks cumulative return)`);
    }

    return lines.join('\n');
  }

  getSupportedProducts() {
    return Object.entries(PRODUCTS).map(([symbol, meta]) => ({ symbol, name: meta.name }));
  }

  getStatus() {
    return {
      enabled: this.enabled,
      schema: 'mbp-10',
      engine: 'python (databento + scikit-learn + matplotlib)',
      supportedProducts: Object.keys(PRODUCTS),
      cacheSize: _resultCache.size,
    };
  }
}

module.exports = new MLPredictor();
