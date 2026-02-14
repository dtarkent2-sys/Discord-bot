/**
 * ML Portfolio Backtester — Node.js Bridge
 *
 * Spawns ml/portfolio_backtester.py as a subprocess, captures JSON output,
 * and formats results for Discord display.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ML_SCRIPT = path.join(__dirname, '..', '..', 'ml', 'portfolio_backtester.py');

const _resultCache = new Map();
const RESULT_CACHE_TTL = 10 * 60 * 1000; // 10 min cache for portfolio (heavier compute)

/** Extract the last JSON object from stdout (handles stray print output) */
function _extractJson(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trimStart().startsWith('{')) {
      return lines.slice(i).join('\n');
    }
  }
  return trimmed;
}

class MLPortfolio {
  get enabled() {
    return true; // No API key needed — uses local parquet data
  }

  /**
   * @param {object} options
   * @param {string} options.tickers        - Comma-separated or preset name
   * @param {string} [options.startDate]
   * @param {string} [options.endDate]
   * @param {number} [options.days]
   * @param {number} [options.forward=20]
   * @param {string} [options.rebalance='W-MON']
   * @param {number} [options.topK=10]
   * @param {number} [options.bottomK=0]
   * @param {string} [options.weighting='equal']
   * @param {number} [options.maxWeight=0.15]
   * @param {number} [options.maxLeverage=1.0]
   * @param {number} [options.costBps=10]
   * @param {number} [options.slippageBps=0]
   * @param {number} [options.volWindow=20]
   * @param {number} [options.targetVolAnnual=0.15]
   * @param {string} [options.model='gradient_boost']
   * @param {number} [options.seed=42]
   */
  async runBacktest(options = {}) {
    const tickers = options.tickers || 'mega';
    const forward = options.forward || 20;
    const rebalance = options.rebalance || 'W-MON';
    const topK = options.topK || 10;
    const bottomK = options.bottomK || 0;
    const weighting = options.weighting || 'equal';
    const maxWeight = options.maxWeight || 0.15;
    const maxLeverage = options.maxLeverage || 1.0;
    const costBps = options.costBps != null ? options.costBps : 10;
    const slippageBps = options.slippageBps != null ? options.slippageBps : 0;
    const volWindow = options.volWindow || 20;
    const targetVolAnnual = options.targetVolAnnual || 0.15;
    const model = options.model || 'gradient_boost';
    const seed = options.seed || 42;

    const cacheKey = [
      tickers, options.startDate, options.endDate, options.days,
      forward, rebalance, topK, bottomK, weighting,
      maxWeight, maxLeverage, costBps, slippageBps,
      volWindow, targetVolAnnual, model, seed,
    ].join('|');

    const cached = _resultCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < RESULT_CACHE_TTL) {
      console.log(`[ML-Portfolio] Cache hit`);
      return cached.data;
    }

    const args = [
      ML_SCRIPT,
      '--tickers', tickers,
      '--forward', String(forward),
      '--rebalance', rebalance,
      '--top-k', String(topK),
      '--bottom-k', String(bottomK),
      '--weighting', weighting,
      '--max-weight', String(maxWeight),
      '--max-leverage', String(maxLeverage),
      '--cost-bps', String(costBps),
      '--slippage-bps', String(slippageBps),
      '--vol-window', String(volWindow),
      '--target-vol-annual', String(targetVolAnnual),
      '--model', model,
      '--seed', String(seed),
    ];

    if (options.startDate) args.push('--start-date', options.startDate);
    if (options.endDate) args.push('--end-date', options.endDate);
    if (options.days) args.push('--days', String(options.days));
    if (process.env.ML_DATA_DIR) args.push('--data-dir', process.env.ML_DATA_DIR);

    console.log(`[ML-Portfolio] Spawning: tickers=${tickers} fwd=${forward}d reb=${rebalance} top_k=${topK} wt=${weighting}`);
    const t0 = Date.now();

    const result = await this._spawnPython(args);
    console.log(`[ML-Portfolio] Completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    if (result.error) throw new Error(result.error);

    _resultCache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  }

  _spawnPython(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn('python3', args, {
        env: { ...process.env },
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
          const jsonStr = _extractJson(stdout);
          resolve(JSON.parse(jsonStr));
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

  // ── Discord Formatting ──────────────────────────────────────────────

  formatResults(result) {
    const cfg = result.config || {};
    const strat = result.strategy || {};
    const gross = strat.gross || {};
    const net = strat.net || {};
    const benchmarks = result.benchmarks || {};
    const warns = result.warnings || [];

    const lines = [
      `**ML Portfolio Backtester**`,
      '',
      `**Config:** ${cfg.tickers_loaded || '?'} tickers | fwd=${cfg.forward || 20}d | reb=${cfg.rebalance || 'W-MON'} | top_k=${cfg.top_k || 10}`,
      `**Weighting:** ${cfg.weighting || 'equal'} | max_wt=${pct1(cfg.max_weight)} | lev_cap=${n2(cfg.max_leverage)} | cost=${cfg.cost_bps || 10}bp + slip=${cfg.slippage_bps || 0}bp`,
      `**Period:** ${cfg.start_date || '?'} to ${cfg.end_date || '?'} | seed=${cfg.seed || 42}`,
      '',
    ];

    // Summary table
    lines.push('**Performance Summary:**');
    lines.push('```');
    lines.push('                        CAGR     Vol  Sharpe Sortino  MaxDD%  Calmar');
    lines.push('\u2500'.repeat(72));

    const formatRow = (label, m) => {
      const lbl = label.padEnd(24);
      const cagr = pctSigned(m.cagr).padStart(7);
      const vol = pctSigned(m.vol).padStart(7);
      const sharpe = n2(m.sharpe).padStart(7);
      const sortino = n2(m.sortino).padStart(8);
      const maxdd = pctSigned(m.max_dd).padStart(7);
      const calmar = n2(m.calmar).padStart(8);
      return `${lbl}${cagr}${vol}${sharpe}${sortino}${maxdd}${calmar}`;
    };

    lines.push(formatRow('Strategy (gross)', gross));
    lines.push(formatRow('Strategy (net)', net));

    for (const [, bm] of Object.entries(benchmarks)) {
      lines.push(formatRow(bm.label || 'Benchmark', bm));
    }
    lines.push('```');

    // Trading stats
    lines.push('');
    lines.push('**Trading Stats:**');
    lines.push('```');
    lines.push(`Hit Rate (rebalance): ${pct1(strat.hit_rate)}`);
    lines.push(`Avg Holdings:         ${n1(strat.avg_holdings)}`);
    lines.push(`Turnover/yr:          ${n2(strat.turnover_annual)}`);
    lines.push(`Total Costs:          ${pctSigned(strat.total_cost)}`);
    lines.push(`Rebalances:           ${strat.num_rebalances || 0}`);
    lines.push(`Gross Return:         ${pctSigned(gross.total_return)}`);
    lines.push(`Net Return:           ${pctSigned(net.total_return)}`);
    lines.push('```');

    // Subperiod breakdown
    const subperiod = result.subperiod || {};
    const years = Object.keys(subperiod);
    if (years.length > 0) {
      lines.push('');
      lines.push('**Annual Breakdown:**');
      lines.push('```');
      lines.push('Year   Return  Sharpe  MaxDD%');
      lines.push('\u2500'.repeat(32));
      for (const y of years) {
        const sp = subperiod[y];
        lines.push(
          `${y}  ${pctSigned(sp.cagr).padStart(7)}  ${n2(sp.sharpe).padStart(6)}  ${pctSigned(sp.max_dd).padStart(7)}`
        );
      }
      lines.push('```');
    }

    // Missing tickers
    const missing = cfg.tickers_missing || {};
    const missingKeys = Object.keys(missing);
    if (missingKeys.length > 0) {
      lines.push('');
      lines.push(`**Missing tickers (${missingKeys.length}):** ${missingKeys.slice(0, 10).join(', ')}${missingKeys.length > 10 ? '...' : ''}`);
    }

    // Warnings
    if (warns.length > 0) {
      lines.push('');
      lines.push('**Warnings:**');
      for (const w of warns) {
        lines.push(`- ${w}`);
      }
    }

    return lines.join('\n');
  }

  getStatus() {
    return {
      enabled: this.enabled,
      engine: 'python (local parquets + scikit-learn + portfolio engine)',
      cacheSize: _resultCache.size,
    };
  }
}

function n1(v) { return Number(v || 0).toFixed(1); }
function n2(v) { return Number(v || 0).toFixed(2); }
function pct1(v) { return (Number(v || 0) * 100).toFixed(1) + '%'; }
function pctSigned(v) {
  const x = Number(v || 0) * 100;
  return (x >= 0 ? '+' : '') + x.toFixed(1) + '%';
}

module.exports = new MLPortfolio();
