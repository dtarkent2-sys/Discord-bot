/**
 * Trading Regime Tests — 0DTE vs Aggregate conflict resolution
 *
 * Run: node --test tests/trading-regime.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { getTradingRegime } = require('../src/services/trading-regime');

// ── Test Data Builders ───────────────────────────────────────────────────

function buildSnapshot(overrides = {}) {
  return {
    expirations: overrides.expirations || [
      { expiry: '2025-01-31', 'netGEX$': -50e6 },   // 0DTE: short gamma
      { expiry: '2025-02-07', 'netGEX$': -30e6 },   // Weekly: short gamma
      { expiry: '2025-02-21', 'netGEX$': 200e6 },   // Monthly: long gamma (dominates aggregate)
    ],
    aggregation: {
      totalNetGEX: overrides.totalNetGEX ?? 120e6, // Aggregate is positive (long gamma)
      byExpiry: overrides.expirations || [
        { expiry: '2025-01-31', 'netGEX$': -50e6, absShare: 0.18 },
        { expiry: '2025-02-07', 'netGEX$': -30e6, absShare: 0.11 },
        { expiry: '2025-02-21', 'netGEX$': 200e6, absShare: 0.71 },
      ],
    },
    regime: overrides.regime || { label: 'Long Gamma', confidence: 0.65 },
    spot: overrides.spot || 590,
    ...overrides,
  };
}

// ── 0DTE Regime Tests ────────────────────────────────────────────────────

describe('0DTE Trading Regime', () => {
  it('should use 70/30 weighted blend of nearest + next expiry', () => {
    const snapshot = buildSnapshot();
    const regime = getTradingRegime(snapshot, '0DTE');

    // 0DTE: -50M * 0.7 + -30M * 0.3 = -35M - 9M = -44M → Short Gamma
    assert.equal(regime.label, 'Short Gamma');
    assert.ok(regime.netGEX < 0);
    assert.equal(regime.source, '0DTE');
  });

  it('should disagree with aggregate when near-term expirations are short gamma', () => {
    const snapshot = buildSnapshot();
    const zerodte = getTradingRegime(snapshot, '0DTE');
    const aggregate = getTradingRegime(snapshot, 'AGGREGATE');

    assert.equal(zerodte.label, 'Short Gamma');
    assert.equal(aggregate.label, 'Long Gamma');
    assert.ok(zerodte.warning, 'Should have disagreement warning');
    assert.ok(zerodte.warning.includes('disagrees'));
  });

  it('should produce higher confidence when both near expirations agree', () => {
    const agreeing = buildSnapshot({
      expirations: [
        { expiry: '2025-01-31', 'netGEX$': -80e6 },
        { expiry: '2025-02-07', 'netGEX$': -60e6 },
      ],
    });

    const disagreeing = buildSnapshot({
      expirations: [
        { expiry: '2025-01-31', 'netGEX$': -80e6 },
        { expiry: '2025-02-07', 'netGEX$': 60e6 },
      ],
    });

    const agree = getTradingRegime(agreeing, '0DTE');
    const disagree = getTradingRegime(disagreeing, '0DTE');

    assert.ok(agree.confidence >= disagree.confidence,
      `Agreeing confidence ${agree.confidence} should be >= disagreeing ${disagree.confidence}`);
  });

  it('should handle single expiration', () => {
    const snapshot = buildSnapshot({
      expirations: [{ expiry: '2025-01-31', 'netGEX$': -50e6 }],
    });
    const regime = getTradingRegime(snapshot, '0DTE');
    assert.equal(regime.label, 'Short Gamma');
    assert.ok(regime.confidence > 0);
  });

  it('should return Unknown for empty data', () => {
    const regime = getTradingRegime(null, '0DTE');
    assert.equal(regime.label, 'Unknown');
    assert.equal(regime.confidence, 0);
  });
});

// ── WEEKLY Regime Tests ──────────────────────────────────────────────────

describe('WEEKLY Trading Regime', () => {
  it('should use only the next weekly expiry', () => {
    const snapshot = buildSnapshot();
    const regime = getTradingRegime(snapshot, 'WEEKLY');

    // Should use the second expiry (2025-02-07)
    assert.equal(regime.source, 'WEEKLY');
    assert.equal(regime.label, 'Short Gamma'); // -30M
    assert.ok(regime.netGEX < 0);
  });
});

// ── AGGREGATE Regime Tests ───────────────────────────────────────────────

describe('AGGREGATE Trading Regime', () => {
  it('should return full aggregate regime', () => {
    const snapshot = buildSnapshot();
    const regime = getTradingRegime(snapshot, 'AGGREGATE');

    assert.equal(regime.source, 'AGGREGATE');
    assert.equal(regime.label, 'Long Gamma');
    assert.ok(regime.netGEX > 0);
  });
});

// ── Conflict Resolution ──────────────────────────────────────────────────

describe('Regime Conflict Resolution', () => {
  it('should ensure 0DTE regime drives options decisions, not aggregate', () => {
    const snapshot = buildSnapshot();
    const decision = getTradingRegime(snapshot, '0DTE');
    const context = getTradingRegime(snapshot, 'AGGREGATE');

    // The key assertion: 0DTE says Short Gamma, Aggregate says Long Gamma
    // Options decisions MUST use 0DTE regime
    assert.notEqual(decision.label, context.label,
      'Test setup: 0DTE and aggregate should disagree');
    assert.equal(decision.label, 'Short Gamma',
      'Decision (0DTE) should be Short Gamma');
    assert.equal(context.label, 'Long Gamma',
      'Context (aggregate) should be Long Gamma');
  });
});
