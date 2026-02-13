/**
 * ML Trading Predictor — Multi-Day Walk-Forward Backtesting
 *
 * Node.js bridge to ml/predictor.py. Spawns Python subprocess with CLI args,
 * captures JSON output, and formats results for Discord.
 *
 * Pipeline (Python): Databento MBP-10 -> feature extraction -> walk-forward
 *   chronological split -> scikit-learn (LinearRegression + GBT) -> matplotlib chart
 *
 * Supports:
 *   - Date range backtesting (start_date + end_date)
 *   - Days shortcut (e.g. days=60 = last 60 calendar days)
 *   - Single date (deprecated, backward-compat)
 *   - ML_MAX_DAYS env var to cap compute
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('../config');

const ML_SCRIPT = path.join(__dirname, '..', '..', 'ml', 'predictor.py');

const _resultCache = new Map();
const RESULT_CACHE_TTL = 5 * 60 * 1000;

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

const ML_MAX_DAYS = parseInt(process.env.ML_MAX_DAYS, 10) || 180;

class MLPredictor {
  get enabled() {
    return !!config.databentoApiKey;
  }

  /**
   * @param {string} product
   * @param {object} [options]
   * @param {string} [options.startDate] - YYYY-MM-DD
   * @param {string} [options.endDate]   - YYYY-MM-DD
   * @param {number} [options.days]      - calendar days back from endDate
   * @param {string} [options.date]      - deprecated single date
   * @param {number} [options.markout=300]
   * @param {string} [options.model='both']
   */
  async runPrediction(product, options = {}) {
    product = product.toUpperCase();
    const meta = PRODUCTS[product];
    if (!meta) throw new Error(`Unknown product: ${product}. Supported: ${Object.keys(PRODUCTS).join(', ')}`);
    if (!this.enabled) throw new Error('Databento API key not configured (DATABENTO_API_KEY)');

    const markout = options.markout || 300;
    const model = options.model || 'both';

    const cacheKey = `${product}_${options.startDate || ''}_${options.endDate || ''}_${options.days || ''}_${options.date || ''}_${markout}_${model}`;
    const cached = _resultCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < RESULT_CACHE_TTL) {
      console.log(`[ML-Predictor] Cache hit for ${cacheKey}`);
      return cached.data;
    }

    const args = [ML_SCRIPT, '--product', product, '--markout', String(markout), '--model', model];
    args.push('--train-split', String(options.trainSplit || 0.70));

    if (options.date && !options.startDate && !options.endDate && !options.days) {
      args.push('--date', options.date);
    } else {
      if (options.startDate) args.push('--start-date', options.startDate);
      if (options.endDate) args.push('--end-date', options.endDate);
      if (options.days) args.push('--days', String(options.days));
    }

    console.log(`[ML-Predictor] Spawning Python: product=${product} markout=${markout} model=${model}`);
    const t0 = Date.now();

    const result = await this._spawnPython(args);
    console.log(`[ML-Predictor] Python pipeline completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    if (result.error) throw new Error(result.error);

    _resultCache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  }

  _spawnPython(args) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, DATABENTO_API_KEY: config.databentoApiKey };
      if (process.env.ML_MAX_DAYS) env.ML_MAX_DAYS = process.env.ML_MAX_DAYS;

      const proc = spawn('python3', args, {
        env,
        cwd: path.join(__dirname, '..', '..'),
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 600_000, // 10 min for multi-day fetches
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk) => {
        const line = chunk.toString();
        stderr += line;
        if (line.trim()) console.log(line.trimEnd());
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn Python: ${err.message}. Ensure python3 and ml/requirements.txt deps are installed.`));
      });

      proc.on('close', (code) => {
        if (code !== 0 && !stdout.trim()) {
          const errMsg = stderr.trim().split('\n').slice(-3).join(' ') || `Python exited with code ${code}`;
          reject(new Error(errMsg));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (parseErr) {
          reject(new Error(`Failed to parse Python output: ${parseErr.message}\nstdout: ${stdout.slice(0, 500)}`));
        }
      });
    });
  }

  async getChartBuffer(result) {
    if (!result.chart_path) throw new Error('No chart generated');
    try {
      const buf = fs.readFileSync(result.chart_path);
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

    const W = 14;
    let out = '```\n';
    out += ''.padEnd(W) + columns.map(c => c.slice(0, 12).padStart(W)).join('') + '\n';
    for (let i = 0; i < columns.length; i++) {
      let row = columns[i].slice(0, 12).padEnd(W);
      for (let j = 0; j < columns.length; j++) {
        const key = `${columns[i]}__${columns[j]}`;
        const alt = `${columns[j]}__${columns[i]}`;
        const val = correlation[key] ?? correlation[alt] ?? '';
        row += (j >= i && val !== '' ? Number(val).toFixed(4) : '').padStart(W);
      }
      out += row + '\n';
    }
    out += '```';
    return out;
  }

  formatResults(result) {
    const {
      product, product_name, start_date, end_date, num_sessions,
      total_sessions_attempted, total_raw_records, total_trade_samples,
      train_size, test_size, markout, split_type, models,
      best_model_name, best_pnl, best_sharpe,
    } = result;

    const deprecated = result._deprecated_single_date ? ' *(single-date mode — deprecated, use start_date/end_date)*' : '';
    const lines = [
      `**ML Price Predictor — ${product} (${product_name})**`,
      '',
      `**Range:** ${start_date} to ${end_date} (${num_sessions}/${total_sessions_attempted} sessions)${deprecated}`,
      `**Data:** ${(total_raw_records || 0).toLocaleString()} raw MBP-10 records -> ${(total_trade_samples || 0).toLocaleString()} trade samples`,
      `**Markout:** ${markout} trades | **Split:** ${split_type} (${(train_size || 0).toLocaleString()} train / ${(test_size || 0).toLocaleString()} test)`,
      `**Features:** skew, imbalance, depth_pressure, spread, micro_dev`,
      '',
      `**In-Sample Correlation Matrix:**`,
      this.formatCorrelationMatrix(result),
      '',
      '**Out-of-Sample Performance:**',
    ];

    if (models) {
      // Header
      lines.push('```');
      lines.push('Model                    corr    R²      PnL    avgPnL  Sharpe  MaxDD   Days');
      lines.push('─'.repeat(85));
      for (const [, m] of Object.entries(models)) {
        const tag = m.type === 'gradient_boost' ? '[GBT]' : '[LR] ';
        const name = `${tag} ${m.name}`.slice(0, 24).padEnd(24);
        const corr = n(m.oos_correlation, 4).padStart(7);
        const r2 = n(m.r_squared, 4).padStart(7);
        const pnl = nSigned(m.final_pnl, 1).padStart(7);
        const avg = nSigned(m.avg_daily_pnl, 1).padStart(8);
        const sharpe = n(m.sharpe, 2).padStart(7);
        const dd = nSigned(m.max_drawdown, 1).padStart(8);
        const days = String(m.num_test_days || 0).padStart(5);
        lines.push(`${name}${corr}${r2}${pnl}${avg}${sharpe}${dd}${days}`);
      }
      lines.push('```');
    }

    lines.push('');
    if (best_model_name) {
      const sign = best_pnl >= 0 ? '+' : '';
      const sh = best_sharpe != null ? ` | Sharpe ${Number(best_sharpe).toFixed(2)}` : '';
      lines.push(`**Best model:** ${best_model_name} (${sign}${Number(best_pnl).toFixed(1)} ticks PnL${sh})`);
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
      defaultDays: 60,
      maxDays: ML_MAX_DAYS,
      supportedProducts: Object.keys(PRODUCTS),
      cacheSize: _resultCache.size,
    };
  }
}

function n(v, decimals) { return Number(v || 0).toFixed(decimals); }
function nSigned(v, decimals) { const x = Number(v || 0); return (x >= 0 ? '+' : '') + x.toFixed(decimals); }

module.exports = new MLPredictor();
