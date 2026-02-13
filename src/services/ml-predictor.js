/**
 * ML Trading Predictor — Stock Backtest on Local Parquet Data
 *
 * Node.js bridge to ml/predictor.py. Spawns Python subprocess, captures JSON.
 *
 * Pipeline: Local parquets (EOD prices + financials from Google Drive)
 *   -> technical + fundamental features -> walk-forward split
 *   -> scikit-learn (Linear + GBT) -> matplotlib chart
 *
 * Data auto-downloads from Google Drive on first use. Set ML_DATA_DIR to
 * point at pre-downloaded parquets, or GDRIVE_FOLDER_ID to override source.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ML_SCRIPT = path.join(__dirname, '..', '..', 'ml', 'predictor.py');

const _resultCache = new Map();
const RESULT_CACHE_TTL = 5 * 60 * 1000;

class MLPredictor {
  get enabled() {
    // No API key needed — uses local parquet data
    return true;
  }

  /**
   * @param {string} ticker  - Stock ticker (e.g. AAPL, MSFT, SPY)
   * @param {object} [options]
   * @param {string} [options.startDate]  - YYYY-MM-DD
   * @param {string} [options.endDate]    - YYYY-MM-DD
   * @param {number} [options.days]       - Trading days of history
   * @param {number} [options.forward=20] - Forward return horizon (trading days)
   * @param {string} [options.model='both']
   */
  async runPrediction(ticker, options = {}) {
    ticker = ticker.toUpperCase();
    const forward = options.forward || 20;
    const model = options.model || 'both';

    const cacheKey = `${ticker}_${options.startDate || ''}_${options.endDate || ''}_${options.days || ''}_${forward}_${model}`;
    const cached = _resultCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < RESULT_CACHE_TTL) {
      console.log(`[ML-Predictor] Cache hit for ${cacheKey}`);
      return cached.data;
    }

    const args = [ML_SCRIPT, '--ticker', ticker, '--forward', String(forward), '--model', model];
    args.push('--train-split', String(options.trainSplit || 0.70));

    if (options.startDate) args.push('--start-date', options.startDate);
    if (options.endDate) args.push('--end-date', options.endDate);
    if (options.days) args.push('--days', String(options.days));
    if (process.env.ML_DATA_DIR) args.push('--data-dir', process.env.ML_DATA_DIR);

    console.log(`[ML-Predictor] Spawning Python: ticker=${ticker} forward=${forward}d model=${model}`);
    const t0 = Date.now();

    const result = await this._spawnPython(args);
    console.log(`[ML-Predictor] Completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    if (result.error) throw new Error(result.error);

    _resultCache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  }

  _spawnPython(args) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };

      const proc = spawn('python3', args, {
        env,
        cwd: path.join(__dirname, '..', '..'),
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 600_000,
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

  formatResults(result) {
    const {
      ticker, start_date, end_date, forward_days,
      total_price_rows, total_clean_samples,
      train_size, test_size, split_type,
      technical_features, fundamental_features,
      models, best_model_name, best_pnl, best_sharpe, best_hit_rate,
    } = result;

    const techCount = (technical_features || []).length;
    const fundCount = (fundamental_features || []).length;

    const lines = [
      `**ML Price Predictor — ${ticker}**`,
      '',
      `**Range:** ${start_date} to ${end_date} | **Forward:** ${forward_days} trading days`,
      `**Data:** ${(total_price_rows || 0).toLocaleString()} EOD rows -> ${(total_clean_samples || 0).toLocaleString()} clean samples`,
      `**Split:** ${split_type} (${(train_size || 0).toLocaleString()} train / ${(test_size || 0).toLocaleString()} test)`,
      `**Features:** ${techCount} technical${fundCount > 0 ? ` + ${fundCount} fundamental` : ''}`,
      '',
      '**Out-of-Sample Performance:**',
    ];

    if (models && Object.keys(models).length > 0) {
      lines.push('```');
      lines.push('Model                    corr    R²      Hit%    PnL    avgMo  Sharpe  MaxDD   Mo');
      lines.push('\u2500'.repeat(90));
      for (const [, m] of Object.entries(models)) {
        const tag = m.type === 'gradient_boost' ? '[GBT]' : '[LR] ';
        const name = `${tag} ${m.name}`.slice(0, 24).padEnd(24);
        const corr = n(m.oos_correlation, 4).padStart(7);
        const r2 = n(m.r_squared, 4).padStart(7);
        const hit = pct(m.hit_rate).padStart(7);
        const pnl = nSigned(m.cumulative_pnl * 100, 1).padStart(7);
        const avg = nSigned(m.avg_monthly_pnl * 100, 1).padStart(7);
        const sharpe = n(m.sharpe, 2).padStart(7);
        const dd = nSigned(m.max_drawdown * 100, 1).padStart(8);
        const months = String(m.num_test_periods || 0).padStart(5);
        lines.push(`${name}${corr}${r2}${hit}${pnl}${avg}${sharpe}${dd}${months}`);
      }
      lines.push('```');
    }

    lines.push('');
    if (best_model_name) {
      const pnlStr = nSigned((best_pnl || 0) * 100, 1);
      const sh = best_sharpe != null ? ` | Sharpe ${n(best_sharpe, 2)}` : '';
      const hr = best_hit_rate != null ? ` | Hit ${pct(best_hit_rate)}` : '';
      lines.push(`**Best model:** ${best_model_name} (${pnlStr}% cumulative${sh}${hr})`);
    }

    return lines.join('\n');
  }

  getStatus() {
    return {
      enabled: this.enabled,
      engine: 'python (local parquets + scikit-learn + matplotlib)',
      dataSource: 'Google Drive parquets (EOD + financials)',
      defaultForward: 20,
      defaultDays: 1260,
      cacheSize: _resultCache.size,
    };
  }
}

function n(v, d) { return Number(v || 0).toFixed(d); }
function nSigned(v, d) { const x = Number(v || 0); return (x >= 0 ? '+' : '') + x.toFixed(d); }
function pct(v) { return (Number(v || 0) * 100).toFixed(1) + '%'; }

module.exports = new MLPredictor();
