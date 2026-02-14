/**
 * ML Portfolio Backtester — Node.js Bridge (v2)
 *
 * Patterns:
 *  - Config-driven: compile slash args -> config object -> SHA-256 hash
 *  - Redis distributed lock: SET NX PX prevents concurrent backtests
 *  - Atomic state: lock logs, fallback to in-process mutex
 *  - Spawns ml/portfolio_backtester.py, captures JSON, formats for Discord
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ML_SCRIPT = path.join(__dirname, '..', '..', 'ml', 'portfolio_backtester.py');

const _resultCache = new Map();
const RESULT_CACHE_TTL = 10 * 60 * 1000;

// In-process mutex fallback (when Redis unavailable)
let _inProcessLock = false;
const LOCK_KEY = 'mlportfolio:run';
const LOCK_TTL_MS = 600_000; // 10 min max run

/** Extract last JSON object from stdout */
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

/**
 * Compile slash command options into a canonical config object.
 * This mirrors BacktestConfig in Python — same fields, same hash.
 */
function compileConfig(options = {}) {
  const cfg = {
    tickers: options.tickers || 'mega',
    start_date: options.startDate || null,
    end_date: options.endDate || null,
    days: options.days || null,
    forward: options.forward || 20,
    rebalance: options.rebalance || 'W-MON',
    top_k: options.topK || 10,
    bottom_k: options.bottomK || 0,
    weighting: options.weighting || 'equal',
    max_weight: options.maxWeight || 0.15,
    max_leverage: options.maxLeverage || 1.0,
    cost_bps: options.costBps != null ? options.costBps : 10,
    slippage_bps: options.slippageBps != null ? options.slippageBps : 0,
    vol_window: options.volWindow || 20,
    target_vol_annual: options.targetVolAnnual || 0.15,
    model_type: options.model || 'gradient_boost',
    seed: options.seed || 42,
    debug: options.debug || false,
  };

  // Deterministic hash (matches Python BacktestConfig.config_hash)
  // Exclude debug and data_dir — they don't affect results
  const hashObj = { ...cfg };
  delete hashObj.debug;
  const canonical = JSON.stringify(hashObj, Object.keys(hashObj).sort());
  cfg._hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);

  return cfg;
}


// ── Redis Distributed Lock ──────────────────────────────────────────────

let _redisClient = null;

async function _getRedis() {
  if (_redisClient) return _redisClient;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;

  try {
    const { createRedisClient } = require('../runtime/redis-client');
    _redisClient = await createRedisClient(redisUrl);
    return _redisClient;
  } catch (err) {
    console.log(`[ML-Portfolio] Redis unavailable: ${err.message} — using in-process lock`);
    return null;
  }
}

async function acquireRunLock(configHash) {
  const lockKey = `${LOCK_KEY}:${configHash}`;
  const lockValue = `${process.pid}-${Date.now()}`;

  // Try Redis lock first
  const redis = await _getRedis();
  if (redis && redis.connected) {
    try {
      const result = await redis.sendCommand('SET', lockKey, lockValue, 'NX', 'PX', String(LOCK_TTL_MS));
      if (result === 'OK') {
        console.log(`[ML-Portfolio] Redis lock ACQUIRED: ${lockKey} (ttl=${LOCK_TTL_MS / 1000}s)`);
        return { type: 'redis', key: lockKey, value: lockValue };
      }
      // Lock held by another run
      const ttl = await redis.sendCommand('PTTL', lockKey);
      console.log(`[ML-Portfolio] Redis lock BUSY: ${lockKey} (remaining=${ttl}ms)`);
      return null; // Caller should tell user to wait
    } catch (err) {
      console.log(`[ML-Portfolio] Redis lock error: ${err.message} — fallback to in-process`);
    }
  }

  // Fallback: in-process mutex
  if (_inProcessLock) {
    console.log('[ML-Portfolio] In-process lock BUSY');
    return null;
  }
  _inProcessLock = true;
  console.log('[ML-Portfolio] In-process lock ACQUIRED');
  return { type: 'memory' };
}

async function releaseRunLock(lock) {
  if (!lock) return;

  if (lock.type === 'redis') {
    try {
      const redis = await _getRedis();
      if (redis && redis.connected) {
        // Only release if we still own it (compare-and-delete)
        const current = await redis.sendCommand('GET', lock.key);
        if (current === lock.value) {
          await redis.sendCommand('DEL', lock.key);
          console.log(`[ML-Portfolio] Redis lock RELEASED: ${lock.key}`);
        }
      }
    } catch (err) {
      console.log(`[ML-Portfolio] Redis lock release error: ${err.message}`);
    }
  } else {
    _inProcessLock = false;
    console.log('[ML-Portfolio] In-process lock RELEASED');
  }
}


// ── Main Service ────────────────────────────────────────────────────────

class MLPortfolio {
  get enabled() {
    return true;
  }

  async runBacktest(options = {}) {
    const cfg = compileConfig(options);

    // Check cache (keyed by config hash)
    const cached = _resultCache.get(cfg._hash);
    if (cached && Date.now() - cached.ts < RESULT_CACHE_TTL) {
      console.log(`[ML-Portfolio] Cache hit: cfg=${cfg._hash}`);
      return cached.data;
    }

    // Acquire distributed lock
    const lock = await acquireRunLock(cfg._hash);
    if (!lock) {
      throw new Error('Another portfolio backtest is running. Please wait and retry.');
    }

    try {
      const args = [
        ML_SCRIPT,
        '--tickers', cfg.tickers,
        '--forward', String(cfg.forward),
        '--rebalance', cfg.rebalance,
        '--top-k', String(cfg.top_k),
        '--bottom-k', String(cfg.bottom_k),
        '--weighting', cfg.weighting,
        '--max-weight', String(cfg.max_weight),
        '--max-leverage', String(cfg.max_leverage),
        '--cost-bps', String(cfg.cost_bps),
        '--slippage-bps', String(cfg.slippage_bps),
        '--vol-window', String(cfg.vol_window),
        '--target-vol-annual', String(cfg.target_vol_annual),
        '--model', cfg.model_type,
        '--seed', String(cfg.seed),
      ];

      if (cfg.start_date) args.push('--start-date', cfg.start_date);
      if (cfg.end_date) args.push('--end-date', cfg.end_date);
      if (cfg.days) args.push('--days', String(cfg.days));
      if (cfg.debug) args.push('--debug', '1');
      if (process.env.ML_DATA_DIR) args.push('--data-dir', process.env.ML_DATA_DIR);

      console.log(`[ML-Portfolio] Spawning: cfg=${cfg._hash} tickers=${cfg.tickers} fwd=${cfg.forward}d`);
      const t0 = Date.now();

      const result = await this._spawnPython(args);
      console.log(`[ML-Portfolio] Completed in ${((Date.now() - t0) / 1000).toFixed(1)}s cfg=${cfg._hash}`);

      if (result.error) throw new Error(result.error);

      _resultCache.set(cfg._hash, { data: result, ts: Date.now() });
      return result;
    } finally {
      await releaseRunLock(lock);
    }
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
    const panel = result.panel_stats || {};

    const lines = [
      `**ML Portfolio Backtester** \`cfg=${cfg.config_hash || '?'}\``,
      '',
      `**Config:** ${cfg.tickers_active || cfg.tickers_loaded || '?'} active tickers | fwd=${cfg.forward || 20}d | reb=${cfg.rebalance || 'W-MON'} | top_k=${cfg.top_k || 10}`,
      `**Weighting:** ${cfg.weighting || 'equal'} | max_wt=${pct1(cfg.max_weight)} | lev_cap=${n2(cfg.max_leverage)} | cost=${cfg.cost_bps || 10}bp + slip=${cfg.slippage_bps || 0}bp`,
      `**Period:** ${cfg.start_date || '?'} to ${cfg.end_date || '?'} | seed=${cfg.seed || 42}`,
      `**Panel:** ${panel.tickers_loaded || '?'} loaded / ${panel.tickers_active || '?'} active × ${panel.dates || '?'} dates | fill=${pct1(panel.fill_rate)} | dropped=${panel.dropped_tickers || 0}`,
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
    lines.push(`Equity Start:         ${n2(gross.equity_start || 1.0)}`);
    lines.push(`Equity End (gross):   ${n2(gross.equity_end || 1.0)}`);
    lines.push(`Equity End (net):     ${n2(net.equity_end || 1.0)}`);
    lines.push(`Gross Return:         ${pctDirect(gross.total_return_pct)}`);
    lines.push(`Net Return:           ${pctDirect(net.total_return_pct)}`);
    lines.push(`Hit Rate (rebalance): ${pct1(strat.hit_rate)}`);
    lines.push(`Avg Holdings:         ${n1(strat.avg_holdings)}`);
    lines.push(`Turnover/yr:          ${n2(strat.turnover_annual)}`);
    lines.push(`Total Costs:          ${pctSigned(strat.total_cost)}`);
    lines.push(`Rebalances:           ${strat.num_rebalances || 0}`);
    lines.push('```');

    // Annual breakdown
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
      engine: 'python v2 (SimClock + DataProvider + SignalModel + PortfolioEngine + ExecSim)',
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
/** total_return_pct is already in % units (e.g. 12.3 means +12.3%) */
function pctDirect(v) {
  const x = Number(v || 0);
  return (x >= 0 ? '+' : '') + x.toFixed(2) + '%';
}

module.exports = new MLPortfolio();
