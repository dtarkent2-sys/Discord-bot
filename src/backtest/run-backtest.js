#!/usr/bin/env node
'use strict';

/**
 * run-backtest.js — CLI runner for the 0DTE backtesting engine.
 *
 * Usage:
 *   node src/backtest/run-backtest.js                          # today
 *   node src/backtest/run-backtest.js 2026-02-12               # specific date
 *   node src/backtest/run-backtest.js 2026-02-03 2026-02-14    # date range
 *   node src/backtest/run-backtest.js 2026-02-12 --symbol QQQ  # different symbol
 *   node src/backtest/run-backtest.js 2026-02-12 --stress downtrend
 *   node src/backtest/run-backtest.js 2026-02-12 --csv          # export CSV
 *   node src/backtest/run-backtest.js 2026-02-12 --trades       # show individual trades
 *   node src/backtest/run-backtest.js 2026-02-12 --conviction 8 # override min conviction
 *   node src/backtest/run-backtest.js 2026-02-12 --iv 0.25      # override base IV
 *
 * npm script: npm run backtest -- 2026-02-12
 */

const BacktestHarness = require('./backtest-harness');

// ── Parse CLI args ──────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {};
  let startDate = null;
  let endDate = null;
  let showTrades = false;
  let exportCSV = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--symbol' || arg === '-s') {
      config.symbol = args[++i]?.toUpperCase();
    } else if (arg === '--stress') {
      config.stressMode = args[++i]; // 'downtrend', 'volatility_spike', 'v_reversal'
    } else if (arg === '--iv') {
      config.baseIV = parseFloat(args[++i]);
    } else if (arg === '--conviction') {
      config.minConviction = parseInt(args[++i], 10);
    } else if (arg === '--stop') {
      config.premiumStopPct = -Math.abs(parseFloat(args[++i]));
    } else if (arg === '--target') {
      config.premiumTargetPct = Math.abs(parseFloat(args[++i]));
    } else if (arg === '--max-hold') {
      config.maxHoldMinutes = parseInt(args[++i], 10);
    } else if (arg === '--max-trades') {
      config.maxTradesPerDay = parseInt(args[++i], 10);
    } else if (arg === '--contracts') {
      config.contractQty = parseInt(args[++i], 10);
    } else if (arg === '--macro') {
      config.macroRegime = { regime: args[++i]?.toUpperCase(), score: 0 };
    } else if (arg === '--csv') {
      exportCSV = true;
    } else if (arg === '--trades') {
      showTrades = true;
    } else if (arg === '--interval') {
      config.barInterval = args[++i]; // '1m' or '5m'
    } else if (arg === '--iv-mult') {
      config.stressIVMultiplier = parseFloat(args[++i]);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      if (!startDate) startDate = arg;
      else endDate = arg;
    }
  }

  // Default to yesterday if no date given
  if (!startDate) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    // Skip to Friday if yesterday was weekend
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
    startDate = d.toISOString().slice(0, 10);
  }

  return { startDate, endDate: endDate || startDate, config, showTrades, exportCSV };
}

function printHelp() {
  console.log(`
  0DTE Backtest Runner
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Usage: node src/backtest/run-backtest.js [dates] [options]

  Dates:
    <YYYY-MM-DD>                Single date backtest
    <start> <end>               Date range backtest
    (none)                      Previous trading day

  Options:
    --symbol, -s <SYM>          Underlying (default: SPY)
    --conviction <N>            Min conviction threshold (default: 7)
    --stop <pct>                Premium stop loss % (default: 0.20)
    --target <pct>              Profit target % (default: 0.25)
    --max-hold <min>            Max hold minutes (default: 15)
    --max-trades <N>            Max trades per day (default: 6)
    --contracts <N>             Contracts per trade (default: 2)
    --iv <val>                  Base implied volatility (default: 0.20)
    --iv-mult <val>             IV multiplier for stress (default: 1.0)
    --macro <REGIME>            Force macro regime: RISK_ON, CAUTIOUS, RISK_OFF
    --interval <1m|5m>          Bar interval (default: 5m)
    --stress <mode>             Stress test: downtrend, volatility_spike, v_reversal
    --trades                    Show individual trade details
    --csv                       Export results to CSV
    --help, -h                  Show this help

  Examples:
    node src/backtest/run-backtest.js 2026-02-12
    node src/backtest/run-backtest.js 2026-02-03 2026-02-14 --symbol QQQ
    node src/backtest/run-backtest.js 2026-02-12 --stress downtrend --csv
    node src/backtest/run-backtest.js 2026-02-12 --conviction 8 --trades
    npm run backtest -- 2026-02-12 --symbol SPY --csv --trades
  `);
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const { startDate, endDate, config, showTrades, exportCSV } = parseArgs();

  console.log(`\n  0DTE Backtest: ${config.symbol || 'SPY'} | ${startDate}${endDate !== startDate ? ' to ' + endDate : ''}`);
  if (config.stressMode) console.log(`  Stress mode: ${config.stressMode}`);
  console.log('');

  const harness = new BacktestHarness(config);

  try {
    const results = await harness.run(startDate, endDate);

    harness.printSummary(results);

    if (showTrades && results.trades.length > 0) {
      harness.printTrades(results);
    }

    if (exportCSV) {
      harness.exportCSV(results);
    }

    // Exit code: 0 if profitable, 1 if not (useful for CI/scripts)
    process.exit(results.totalNetPnL >= 0 ? 0 : 1);
  } catch (err) {
    console.error(`\n  ERROR: ${err.message}\n`);
    if (err.message.includes('No data')) {
      console.error('  Hint: Yahoo Finance only provides ~30 days of intraday data.');
      console.error('  For older dates, set POLYGON_API_KEY environment variable.');
    }
    process.exit(2);
  }
}

main();
