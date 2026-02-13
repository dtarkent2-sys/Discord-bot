const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const PREDICTOR = path.join(__dirname, '..', 'ml', 'predictor.py');

/**
 * These tests validate the Python CLI arg parsing, default resolution,
 * and validation logic — without requiring parquet data or network.
 * They run the Python script and verify the CLI responds correctly
 * to different flag combinations.
 */

describe('ml/predictor.py CLI', () => {

  function runPy(args, env = {}) {
    try {
      const out = execFileSync('python3', [PREDICTOR, ...args], {
        env: { ...process.env, ...env },
        timeout: 10_000,
        encoding: 'utf-8',
      });
      return { stdout: out, code: 0 };
    } catch (err) {
      return { stdout: err.stdout || '', stderr: err.stderr || '', code: err.status };
    }
  }

  it('--ticker is required', () => {
    const { stderr, code } = runPy([]);
    assert.equal(code, 2, 'should exit 2 on missing required arg');
    assert.ok(stderr.includes('--ticker'), 'error should mention --ticker');
  });

  it('--days flag is accepted and validates against ML_MAX_DAYS', () => {
    // days=999999 should be rejected by max_days check when ML_MAX_DAYS is small
    const { stdout, code } = runPy(['--ticker', 'AAPL', '--days', '999999'], { ML_MAX_DAYS: '1000' });
    assert.equal(code, 1);
    const result = JSON.parse(stdout.trim());
    assert.ok(result.error.includes('exceeds max'), `expected max days error, got: ${result.error}`);
  });

  it('ML_MAX_DAYS env var overrides default max', () => {
    // With ML_MAX_DAYS=5, even days=10 should be rejected
    const { stdout, code } = runPy(['--ticker', 'AAPL', '--days', '10'], { ML_MAX_DAYS: '5' });
    assert.equal(code, 1);
    const result = JSON.parse(stdout.trim());
    assert.ok(result.error.includes('exceeds max 5'), `expected max=5 error, got: ${result.error}`);
  });

  it('start_date > end_date is rejected', () => {
    const { stdout, code } = runPy([
      '--ticker', 'AAPL', '--start-date', '2026-03-01', '--end-date', '2026-01-01'
    ]);
    assert.equal(code, 1);
    const result = JSON.parse(stdout.trim());
    assert.ok(result.error.includes('after end_date'), `expected date order error, got: ${result.error}`);
  });

  it('invalid date format is rejected', () => {
    const { stdout, code } = runPy([
      '--ticker', 'AAPL', '--start-date', 'not-a-date', '--end-date', '2026-02-12'
    ]);
    assert.equal(code, 1);
    const result = JSON.parse(stdout.trim());
    assert.ok(result.error.includes('Invalid date'), `expected format error, got: ${result.error}`);
  });

  it('--model accepts valid choices', () => {
    // Just checking the arg parser accepts these without erroring on the flag itself
    for (const model of ['linear', 'gradient_boost', 'both']) {
      const { code } = runPy(['--ticker', 'AAPL', '--model', model, '--days', '99999'], { ML_MAX_DAYS: '100' });
      assert.equal(code, 1, `model=${model} should exit 1 (max days), not 2 (arg error)`);
    }
  });

  it('--forward accepts positive integers', () => {
    const { code } = runPy(['--ticker', 'AAPL', '--forward', '5', '--days', '99999'], { ML_MAX_DAYS: '100' });
    assert.equal(code, 1, 'should exit 1 on max days, not arg error');
  });

});

describe('ml-predictor.js Node bridge', () => {

  it('exports expected interface', () => {
    const mlPredictor = require('../src/services/ml-predictor');
    assert.equal(typeof mlPredictor.enabled, 'boolean');
    assert.equal(mlPredictor.enabled, true, 'should always be enabled (no API key needed)');
    assert.equal(typeof mlPredictor.runPrediction, 'function');
    assert.equal(typeof mlPredictor.formatResults, 'function');
    assert.equal(typeof mlPredictor.getChartBuffer, 'function');
    assert.equal(typeof mlPredictor.getStatus, 'function');

    const status = mlPredictor.getStatus();
    assert.ok(status.engine.includes('parquet'), 'engine should mention parquets');
    assert.equal(status.defaultForward, 20);
    assert.equal(status.defaultDays, 1260);
  });

  it('formatResults handles stock result shape', () => {
    const mlPredictor = require('../src/services/ml-predictor');

    const mockResult = {
      ticker: 'AAPL',
      start_date: '2020-01-02',
      end_date: '2025-12-31',
      forward_days: 20,
      total_price_rows: 1500,
      total_clean_samples: 1200,
      train_size: 840,
      test_size: 360,
      split_type: 'walk-forward chronological',
      technical_features: ['mom_5d', 'mom_20d', 'vol_20d', 'rsi_14'],
      fundamental_features: ['revenue_growth', 'net_margin'],
      models: {
        linear_all: {
          name: 'Linear Regression (all features)',
          type: 'linear_regression',
          coefficients: { mom_5d: 0.0023 },
          oos_correlation: 0.0312,
          r_squared: 0.0010,
          hit_rate: 0.52,
          cumulative_pnl: 0.425,
          avg_monthly_pnl: 0.032,
          sharpe: 0.40,
          max_drawdown: -0.153,
          num_test_periods: 18,
        },
        gradient_boost: {
          name: 'Gradient Boosted Trees',
          type: 'gradient_boost',
          coefficients: { mom_5d: 0.3, vol_20d: 0.25 },
          oos_correlation: 0.0450,
          r_squared: 0.0020,
          hit_rate: 0.55,
          cumulative_pnl: 0.682,
          avg_monthly_pnl: 0.051,
          sharpe: 0.73,
          max_drawdown: -0.121,
          num_test_periods: 18,
        },
      },
      best_model_name: 'Gradient Boosted Trees',
      best_pnl: 0.682,
      best_sharpe: 0.73,
      best_hit_rate: 0.55,
    };

    const output = mlPredictor.formatResults(mockResult);

    assert.ok(output.includes('ML Price Predictor — AAPL'), 'has title with ticker');
    assert.ok(output.includes('2020-01-02 to 2025-12-31'), 'has date range');
    assert.ok(output.includes('walk-forward chronological'), 'has split type');
    assert.ok(output.includes('4 technical + 2 fundamental'), 'has feature counts');
    assert.ok(output.includes('Sharpe'), 'has sharpe in table header');
    assert.ok(output.includes('MaxDD'), 'has maxDD in table header');
    assert.ok(output.includes('Gradient Boosted Trees'), 'has best model');
    assert.ok(output.includes('[GBT]'), 'has model type tag');
    assert.ok(output.includes('[LR]'), 'has LR model type tag');
    assert.ok(output.includes('Sharpe 0.73'), 'has sharpe in best model summary');
  });

});
