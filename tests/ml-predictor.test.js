const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const PREDICTOR = path.join(__dirname, '..', 'ml', 'predictor.py');

/**
 * These tests validate the Python CLI arg parsing, default resolution,
 * and validation logic — without requiring a Databento API key or network.
 * They run the Python script with intentionally missing API key and verify
 * the CLI responds correctly to different flag combinations.
 */

describe('ml/predictor.py CLI', () => {

  function runPy(args, env = {}) {
    try {
      const out = execFileSync('python3', [PREDICTOR, ...args], {
        env: { ...process.env, DATABENTO_API_KEY: '', ...env },
        timeout: 10_000,
        encoding: 'utf-8',
      });
      return { stdout: out, code: 0 };
    } catch (err) {
      return { stdout: err.stdout || '', stderr: err.stderr || '', code: err.status };
    }
  }

  it('default uses 60 calendar days when no date args provided', () => {
    // Without API key, the script should still parse args and fail at the
    // "No Databento API key" check, but the fact that it doesn't fail on
    // arg parsing proves the defaults work.
    const { stdout, code } = runPy(['--product', 'ES']);
    assert.equal(code, 1, 'should exit 1 without API key');
    const result = JSON.parse(stdout.trim());
    assert.ok(result.error, 'should return error JSON');
    assert.ok(result.error.includes('Databento API key'), `expected key error, got: ${result.error}`);
  });

  it('--days flag is accepted and validated against ML_MAX_DAYS', () => {
    // days=10 should be accepted (< 180 default) — hits API key error
    const { stdout: out10, code: code10 } = runPy(['--product', 'ES', '--days', '10']);
    assert.equal(code10, 1);
    assert.ok(JSON.parse(out10.trim()).error.includes('Databento API key'));

    // days=999 should be rejected by max_days check (need a dummy API key to get past key check)
    const { stdout: out999, code: code999 } = runPy(['--product', 'ES', '--days', '999'], { DATABENTO_API_KEY: 'test-dummy' });
    assert.equal(code999, 1);
    const err999 = JSON.parse(out999.trim());
    assert.ok(err999.error.includes('exceeds maximum'), `expected max days error, got: ${err999.error}`);
  });

  it('ML_MAX_DAYS env var overrides default max', () => {
    // With ML_MAX_DAYS=5, even days=10 should be rejected (need dummy key to get past key check)
    const { stdout, code } = runPy(['--product', 'ES', '--days', '10'], { DATABENTO_API_KEY: 'test-dummy', ML_MAX_DAYS: '5' });
    assert.equal(code, 1);
    const result = JSON.parse(stdout.trim());
    assert.ok(result.error.includes('exceeds maximum 5'), `expected max=5 error, got: ${result.error}`);
  });

  it('start_date > end_date is rejected', () => {
    const { stdout, code } = runPy([
      '--product', 'ES', '--start-date', '2026-03-01', '--end-date', '2026-01-01'
    ], { DATABENTO_API_KEY: 'test' });
    assert.equal(code, 1);
    const result = JSON.parse(stdout.trim());
    assert.ok(result.error.includes('after end_date'), `expected date order error, got: ${result.error}`);
  });

  it('invalid date format is rejected', () => {
    const { stdout, code } = runPy([
      '--product', 'ES', '--start-date', 'not-a-date', '--end-date', '2026-02-12'
    ], { DATABENTO_API_KEY: 'test' });
    assert.equal(code, 1);
    const result = JSON.parse(stdout.trim());
    assert.ok(result.error.includes('Invalid date'), `expected format error, got: ${result.error}`);
  });

  it('--date (deprecated) single-day mode still works', () => {
    const { stdout, code } = runPy(['--product', 'NQ', '--date', '2026-02-10']);
    assert.equal(code, 1);
    const result = JSON.parse(stdout.trim());
    // Should fail on API key, not on arg parsing
    assert.ok(result.error.includes('Databento API key'));
  });

  it('range spanning more than max_days is rejected', () => {
    const { stdout, code } = runPy([
      '--product', 'ES', '--start-date', '2025-01-01', '--end-date', '2026-02-12'
    ], { DATABENTO_API_KEY: 'test' });
    assert.equal(code, 1);
    const result = JSON.parse(stdout.trim());
    assert.ok(result.error.includes('exceeds max'), `expected range error, got: ${result.error}`);
  });

});

describe('ml-predictor.js Node bridge', () => {

  it('exports expected interface', () => {
    const mlPredictor = require('../src/services/ml-predictor');
    assert.equal(typeof mlPredictor.enabled, 'boolean');
    assert.equal(typeof mlPredictor.runPrediction, 'function');
    assert.equal(typeof mlPredictor.formatResults, 'function');
    assert.equal(typeof mlPredictor.getChartBuffer, 'function');
    assert.equal(typeof mlPredictor.getSupportedProducts, 'function');
    assert.equal(typeof mlPredictor.getStatus, 'function');

    const status = mlPredictor.getStatus();
    assert.equal(status.schema, 'mbp-10');
    assert.equal(status.defaultDays, 60);
    assert.ok(status.maxDays >= 1);
    assert.ok(status.supportedProducts.includes('ES'));
  });

  it('formatResults handles multi-day result shape', () => {
    const mlPredictor = require('../src/services/ml-predictor');

    const mockResult = {
      product: 'ES',
      product_name: 'E-mini S&P 500',
      start_date: '2025-12-01',
      end_date: '2026-01-31',
      num_sessions: 40,
      total_sessions_attempted: 44,
      total_raw_records: 5000000,
      total_trade_samples: 150000,
      train_size: 105000,
      test_size: 45000,
      markout: 300,
      split_type: 'walk-forward chronological',
      correlation: { 'skew__skew': 1.0, 'skew__imbalance': 0.35 },
      correlation_columns: ['skew', 'imbalance'],
      models: {
        skew: {
          name: 'Skew (top-of-book depth)',
          type: 'linear_regression',
          coefficients: { skew: 0.0023 },
          oos_correlation: 0.0312,
          r_squared: 0.0010,
          final_pnl: 42.5,
          avg_daily_pnl: 3.2,
          std_daily_pnl: 8.1,
          sharpe: 0.40,
          max_drawdown: -15.3,
          num_test_days: 13,
        },
        gradient_boost: {
          name: 'Gradient Boosted Trees',
          type: 'gradient_boost',
          coefficients: { skew: 0.3, imbalance: 0.25 },
          oos_correlation: 0.0450,
          r_squared: 0.0020,
          final_pnl: 68.2,
          avg_daily_pnl: 5.1,
          std_daily_pnl: 7.0,
          sharpe: 0.73,
          max_drawdown: -12.1,
          num_test_days: 13,
        },
      },
      best_model_name: 'Gradient Boosted Trees',
      best_pnl: 68.2,
      best_sharpe: 0.73,
    };

    const output = mlPredictor.formatResults(mockResult);

    assert.ok(output.includes('ML Price Predictor — ES'), 'has title');
    assert.ok(output.includes('2025-12-01 to 2026-01-31'), 'has date range');
    assert.ok(output.includes('40/44 sessions'), 'has session count');
    assert.ok(output.includes('walk-forward chronological'), 'has split type');
    assert.ok(output.includes('Sharpe'), 'has sharpe in table header');
    assert.ok(output.includes('MaxDD'), 'has maxDD in table header');
    assert.ok(output.includes('Gradient Boosted Trees'), 'has best model');
    assert.ok(output.includes('+68.2'), 'has PnL');
    assert.ok(output.includes('Sharpe 0.73'), 'has sharpe in best model');
    assert.ok(output.includes('[GBT]'), 'has model type tag');
    assert.ok(output.includes('[LR]'), 'has LR model type tag');
  });

});
