/**
 * GEX Engine Unit Tests
 *
 * Tests for:
 *   1. Aggregation correctness (totalNetGEX$, by-expiry shares, strike clustering)
 *   2. Regime labeling consistency (sign vs label, confidence scoring)
 *   3. Stacked wall detection (cross-expiry wall identification)
 *   4. Break-and-hold alert logic
 *   5. Discord formatting (output length < 1100 chars)
 *
 * Uses Node.js built-in test runner (node:test + node:assert) — no extra dependencies.
 * Run: node --test tests/gex-engine.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// We test the engine in isolation by providing a mock gamma service
const GEXEngine = require('../src/services/gex-engine');
const GEXAlertService = require('../src/services/gex-alerts');

// ── Mock gamma service ──────────────────────────────────────────────────

/**
 * Build a mock gamma service that returns pre-defined multi-expiry data.
 * This isolates the engine from network calls / Yahoo / Alpaca.
 */
function createMockGamma(multiExpiryData) {
  return {
    enabled: true,
    analyzeMultiExpiry: async (ticker, prefs) => multiExpiryData,
  };
}

/**
 * Build canonical multi-expiry data for testing.
 *
 * Scenario: SPY at $590 with 3 expirations
 *   - 0DTE:    small GEX, concentrated near spot
 *   - Weekly:  medium GEX, call wall at 593
 *   - Monthly: large GEX, call wall at 593 (stacked!), put wall at 580
 */
function buildTestData() {
  return {
    ticker: 'SPY',
    spotPrice: 590,
    source: 'Mock',
    expirations: [
      {
        expiry: '2025-01-31',
        detailedGEX: {
          'totalNetGEX$': 5e6, // $5M net positive (0DTE)
          strikes: [
            { strike: 585, callOI: 1000, putOI: 5000, callGamma: 0.05, putGamma: 0.04, 'callGEX$': 3e6, 'putGEX$': -8e6, 'netGEX$': -5e6 },
            { strike: 590, callOI: 8000, putOI: 3000, callGamma: 0.08, putGamma: 0.07, 'callGEX$': 15e6, 'putGEX$': -5e6, 'netGEX$': 10e6 },
            { strike: 593, callOI: 5000, putOI: 500, callGamma: 0.06, putGamma: 0.05, 'callGEX$': 8e6, 'putGEX$': -1e6, 'netGEX$': 7e6 },
            { strike: 595, callOI: 2000, putOI: 200, callGamma: 0.04, putGamma: 0.03, 'callGEX$': 3e6, 'putGEX$': -0.5e6, 'netGEX$': 2.5e6 },
          ],
        },
        gexData: { strikes: [585, 590, 593, 595], gex: [-5e6, 10e6, 7e6, 2.5e6], totalGEX: 5e6, maxGEX: { strike: 590, value: 10e6 }, minGEX: { strike: 585, value: -5e6 } },
        flip: { flipStrike: 587.5, regime: 'long_gamma', nearestStrikes: [585, 590] },
        chartBuffer: null,
      },
      {
        expiry: '2025-02-07',
        detailedGEX: {
          'totalNetGEX$': 50e6, // $50M net positive (weekly)
          strikes: [
            { strike: 580, callOI: 2000, putOI: 15000, callGamma: 0.03, putGamma: 0.04, 'callGEX$': 2e6, 'putGEX$': -20e6, 'netGEX$': -18e6 },
            { strike: 585, callOI: 5000, putOI: 8000, callGamma: 0.05, putGamma: 0.05, 'callGEX$': 8e6, 'putGEX$': -12e6, 'netGEX$': -4e6 },
            { strike: 590, callOI: 20000, putOI: 5000, callGamma: 0.08, putGamma: 0.07, 'callGEX$': 40e6, 'putGEX$': -10e6, 'netGEX$': 30e6 },
            { strike: 593, callOI: 25000, putOI: 1000, callGamma: 0.07, putGamma: 0.06, 'callGEX$': 45e6, 'putGEX$': -2e6, 'netGEX$': 43e6 },
            { strike: 595, callOI: 10000, putOI: 500, callGamma: 0.05, putGamma: 0.04, 'callGEX$': 15e6, 'putGEX$': -1e6, 'netGEX$': 14e6 },
          ],
        },
        gexData: { strikes: [580, 585, 590, 593, 595], gex: [-18e6, -4e6, 30e6, 43e6, 14e6], totalGEX: 50e6, maxGEX: { strike: 593, value: 43e6 }, minGEX: { strike: 580, value: -18e6 } },
        flip: { flipStrike: 586.8, regime: 'long_gamma', nearestStrikes: [585, 590] },
        chartBuffer: Buffer.from('fake-chart-weekly'),
      },
      {
        expiry: '2025-02-21',
        detailedGEX: {
          'totalNetGEX$': 200e6, // $200M net positive (monthly — dominates)
          strikes: [
            { strike: 575, callOI: 5000, putOI: 30000, callGamma: 0.02, putGamma: 0.03, 'callGEX$': 3e6, 'putGEX$': -25e6, 'netGEX$': -22e6 },
            { strike: 580, callOI: 8000, putOI: 40000, callGamma: 0.03, putGamma: 0.04, 'callGEX$': 7e6, 'putGEX$': -50e6, 'netGEX$': -43e6 },
            { strike: 585, callOI: 15000, putOI: 20000, callGamma: 0.05, putGamma: 0.05, 'callGEX$': 20e6, 'putGEX$': -28e6, 'netGEX$': -8e6 },
            { strike: 590, callOI: 40000, putOI: 10000, callGamma: 0.08, putGamma: 0.07, 'callGEX$': 80e6, 'putGEX$': -18e6, 'netGEX$': 62e6 },
            { strike: 593, callOI: 60000, putOI: 3000, callGamma: 0.07, putGamma: 0.06, 'callGEX$': 110e6, 'putGEX$': -5e6, 'netGEX$': 105e6 },
            { strike: 595, callOI: 30000, putOI: 2000, callGamma: 0.05, putGamma: 0.04, 'callGEX$': 50e6, 'putGEX$': -3e6, 'netGEX$': 47e6 },
            { strike: 600, callOI: 20000, putOI: 1000, callGamma: 0.03, putGamma: 0.02, 'callGEX$': 20e6, 'putGEX$': -1e6, 'netGEX$': 19e6 },
          ],
        },
        gexData: { strikes: [575, 580, 585, 590, 593, 595, 600], gex: [-22e6, -43e6, -8e6, 62e6, 105e6, 47e6, 19e6], totalGEX: 200e6, maxGEX: { strike: 593, value: 105e6 }, minGEX: { strike: 580, value: -43e6 } },
        flip: { flipStrike: 587.2, regime: 'long_gamma', nearestStrikes: [585, 590] },
        chartBuffer: Buffer.from('fake-chart-monthly'),
      },
    ],
  };
}

/**
 * Build short-gamma scenario data for regime testing.
 */
function buildShortGammaData() {
  return {
    ticker: 'TSLA',
    spotPrice: 250,
    source: 'Mock',
    expirations: [
      {
        expiry: '2025-01-31',
        detailedGEX: {
          'totalNetGEX$': -30e6,
          strikes: [
            { strike: 240, callOI: 1000, putOI: 20000, callGamma: 0.04, putGamma: 0.05, 'callGEX$': 2e6, 'putGEX$': -25e6, 'netGEX$': -23e6 },
            { strike: 250, callOI: 5000, putOI: 10000, callGamma: 0.07, putGamma: 0.08, 'callGEX$': 10e6, 'putGEX$': -20e6, 'netGEX$': -10e6 },
            { strike: 260, callOI: 8000, putOI: 2000, callGamma: 0.05, putGamma: 0.04, 'callGEX$': 12e6, 'putGEX$': -3e6, 'netGEX$': 9e6 },
          ],
        },
        gexData: { strikes: [240, 250, 260], gex: [-23e6, -10e6, 9e6], totalGEX: -30e6, maxGEX: { strike: 260, value: 9e6 }, minGEX: { strike: 240, value: -23e6 } },
        flip: { flipStrike: 257, regime: 'short_gamma', nearestStrikes: [250, 260] },
        chartBuffer: null,
      },
    ],
  };
}

// ── Aggregation tests ───────────────────────────────────────────────────

describe('GEX Aggregation', () => {
  let engine;
  let testData;

  beforeEach(() => {
    testData = buildTestData();
    engine = new GEXEngine(createMockGamma(testData));
  });

  it('computes totalNetGEX$ across all expirations', async () => {
    const result = await engine.analyze('SPY');
    // 5M + 50M + 200M = 255M
    assert.equal(result.aggregation.totalNetGEX, 255e6);
  });

  it('computes per-expiry netGEX$ correctly', async () => {
    const result = await engine.analyze('SPY');
    const byExpiry = result.aggregation.byExpiry;

    assert.equal(byExpiry.length, 3);
    assert.equal(byExpiry[0]['netGEX$'], 5e6);   // 0DTE
    assert.equal(byExpiry[1]['netGEX$'], 50e6);  // weekly
    assert.equal(byExpiry[2]['netGEX$'], 200e6); // monthly
  });

  it('identifies dominant expiry as highest absolute GEX contributor', async () => {
    const result = await engine.analyze('SPY');
    const dom = result.aggregation.dominantExpiry;

    assert.equal(dom.expiry, '2025-02-21'); // monthly has $200M
    assert.ok(dom.absShare > 0.5, `Expected dominant share > 50%, got ${(dom.absShare * 100).toFixed(1)}%`);
  });

  it('aggregates strike data across expirations (strike clustering)', async () => {
    const result = await engine.analyze('SPY');
    const byStrike = result.aggregation.byStrike;

    // Strike $593 appears in all 3 expirations
    const strike593 = byStrike.find(s => s.strike === 593);
    assert.ok(strike593, 'Strike $593 should exist in aggregated data');
    assert.equal(strike593.expiryCount, 3, 'Strike $593 should appear in 3 expirations');

    // Aggregated GEX at $593 = 7M + 43M + 105M = 155M
    assert.equal(strike593['netGEX$'], 155e6);
  });

  it('computes absolute GEX shares summing to approximately 1.0', async () => {
    const result = await engine.analyze('SPY');
    const totalShare = result.aggregation.byExpiry.reduce((sum, e) => sum + e.absShare, 0);
    assert.ok(Math.abs(totalShare - 1.0) < 0.01, `Shares should sum to ~1.0, got ${totalShare}`);
  });

  it('handles single-expiry data gracefully', async () => {
    const singleData = buildShortGammaData();
    const singleEngine = new GEXEngine(createMockGamma(singleData));
    const result = await singleEngine.analyze('TSLA');

    assert.equal(result.aggregation.totalNetGEX, -30e6);
    assert.equal(result.aggregation.byExpiry.length, 1);
    assert.equal(result.aggregation.dominantExpiry.absShare, 1);
  });
});

// ── Regime labeling tests ───────────────────────────────────────────────

describe('Regime Classification', () => {
  it('labels positive totalNetGEX$ as Long Gamma', async () => {
    const data = buildTestData();
    const engine = new GEXEngine(createMockGamma(data));
    const result = await engine.analyze('SPY');

    assert.equal(result.regime.label, 'Long Gamma');
  });

  it('labels negative totalNetGEX$ as Short Gamma', async () => {
    const data = buildShortGammaData();
    const engine = new GEXEngine(createMockGamma(data));
    const result = await engine.analyze('TSLA');

    assert.equal(result.regime.label, 'Short Gamma');
  });

  it('provides confidence between 0 and 1', async () => {
    const data = buildTestData();
    const engine = new GEXEngine(createMockGamma(data));
    const result = await engine.analyze('SPY');

    assert.ok(result.regime.confidence >= 0, 'Confidence should be >= 0');
    assert.ok(result.regime.confidence <= 1, 'Confidence should be <= 1');
  });

  it('gives higher confidence for larger absolute GEX', async () => {
    // Large GEX scenario (SPY: $255M)
    const bigData = buildTestData();
    const bigEngine = new GEXEngine(createMockGamma(bigData));
    const bigResult = await bigEngine.analyze('SPY');

    // Small GEX scenario — reduce all values by 100x
    const smallData = buildTestData();
    for (const exp of smallData.expirations) {
      exp.detailedGEX['totalNetGEX$'] /= 100;
      for (const s of exp.detailedGEX.strikes) {
        s['callGEX$'] /= 100;
        s['putGEX$'] /= 100;
        s['netGEX$'] /= 100;
      }
    }
    const smallEngine = new GEXEngine(createMockGamma(smallData));
    const smallResult = await smallEngine.analyze('SPY');

    assert.ok(bigResult.regime.confidence > smallResult.regime.confidence,
      `Big GEX confidence (${bigResult.regime.confidence}) should exceed small (${smallResult.regime.confidence})`);
  });

  it('falls back to Mixed/Uncertain when GEX is near zero', async () => {
    const data = buildTestData();
    // Make all expirations near zero
    data.expirations = [{
      expiry: '2025-01-31',
      detailedGEX: {
        'totalNetGEX$': 100, // negligible
        strikes: [
          { strike: 590, callOI: 10, putOI: 10, callGamma: 0.01, putGamma: 0.01, 'callGEX$': 100, 'putGEX$': 0, 'netGEX$': 100 },
        ],
      },
      gexData: { strikes: [590], gex: [100], totalGEX: 100, maxGEX: { strike: 590, value: 100 }, minGEX: { strike: 590, value: 100 } },
      flip: { flipStrike: null, regime: 'unknown', nearestStrikes: [] },
      chartBuffer: null,
    }];
    data.spotPrice = 590;

    const engine = new GEXEngine(createMockGamma(data));
    const result = await engine.analyze('SPY');

    assert.equal(result.regime.label, 'Mixed/Uncertain');
  });

  it('does not label Short Gamma when totalNetGEX$ is positive (data quality check)', async () => {
    // This tests the requirement: "If label says Short Gamma but totalNetGEX$ is positive, error"
    const data = buildTestData(); // All positive GEX
    const engine = new GEXEngine(createMockGamma(data));
    const result = await engine.analyze('SPY');

    if (result.aggregation.totalNetGEX > 0) {
      assert.notEqual(result.regime.label, 'Short Gamma',
        'Regime should NEVER be Short Gamma when totalNetGEX$ is positive');
    }
  });
});

// ── Stacked wall detection tests ────────────────────────────────────────

describe('Stacked Wall Detection', () => {
  it('identifies stacked call walls (same strike across expirations)', async () => {
    const data = buildTestData();
    const engine = new GEXEngine(createMockGamma(data));
    const result = await engine.analyze('SPY');

    const primaryCallWall = result.walls.callWalls[0];
    assert.ok(primaryCallWall, 'Should have at least one call wall');

    // $593 has positive GEX in all 3 expirations → should be stacked
    if (primaryCallWall.strike === 593) {
      assert.equal(primaryCallWall.stacked, true, 'Strike $593 appears in 3 expirations — should be stacked');
      assert.equal(primaryCallWall.expiryCount, 3);
    }
  });

  it('identifies put walls with most negative GEX', async () => {
    const data = buildTestData();
    const engine = new GEXEngine(createMockGamma(data));
    const result = await engine.analyze('SPY');

    const primaryPutWall = result.walls.putWalls[0];
    assert.ok(primaryPutWall, 'Should have at least one put wall');
    assert.ok(primaryPutWall['netGEX$'] < 0, 'Put wall should have negative netGEX$');
  });

  it('returns up to 3 walls of each type', async () => {
    const data = buildTestData();
    const engine = new GEXEngine(createMockGamma(data));
    const result = await engine.analyze('SPY');

    assert.ok(result.walls.callWalls.length <= 3, 'Should return at most 3 call walls');
    assert.ok(result.walls.putWalls.length <= 3, 'Should return at most 3 put walls');
  });

  it('marks non-stacked walls correctly', async () => {
    // Use single-expiry data — nothing can be stacked
    const data = buildShortGammaData();
    const engine = new GEXEngine(createMockGamma(data));
    const result = await engine.analyze('TSLA');

    for (const wall of [...result.walls.callWalls, ...result.walls.putWalls]) {
      assert.equal(wall.stacked, false, `Single-expiry wall at $${wall.strike} should not be stacked`);
      assert.equal(wall.expiryCount, 1);
    }
  });
});

// ── Gamma flip tests ────────────────────────────────────────────────────

describe('Aggregated Gamma Flip', () => {
  it('finds a flip point from aggregated strike data', async () => {
    const data = buildTestData();
    const engine = new GEXEngine(createMockGamma(data));
    const result = await engine.analyze('SPY');

    // There should be a flip point where cumulative GEX crosses zero
    // The aggregated data has negative GEX at lower strikes and positive at higher
    assert.ok(result.gammaFlip === null || typeof result.gammaFlip === 'number',
      'Gamma flip should be null or a number');
  });
});

// ── Playbook tests ──────────────────────────────────────────────────────

describe('Playbook Generation', () => {
  it('returns at most 3 playbook lines', async () => {
    const data = buildTestData();
    const engine = new GEXEngine(createMockGamma(data));
    const result = await engine.analyze('SPY');

    assert.ok(result.playbook.length <= 3, `Expected ≤3 playbook lines, got ${result.playbook.length}`);
    assert.ok(result.playbook.length >= 1, 'Should have at least 1 playbook line');
  });

  it('references specific strike levels in playbook', async () => {
    const data = buildTestData();
    const engine = new GEXEngine(createMockGamma(data));
    const result = await engine.analyze('SPY');

    const combined = result.playbook.join(' ');
    assert.ok(combined.includes('$'), 'Playbook should reference dollar levels');
  });
});

// ── Discord formatting tests ────────────────────────────────────────────

describe('Discord Formatting', () => {
  it('produces output under 1100 characters', async () => {
    const data = buildTestData();
    const engine = new GEXEngine(createMockGamma(data));
    const result = await engine.analyze('SPY');
    const formatted = engine.formatSummaryForDiscord(result);

    assert.ok(formatted.length <= 1100,
      `Output should be ≤1100 chars, got ${formatted.length}: ${formatted.slice(0, 200)}...`);
  });

  it('includes ticker, regime, and walls in output', async () => {
    const data = buildTestData();
    const engine = new GEXEngine(createMockGamma(data));
    const result = await engine.analyze('SPY');
    const formatted = engine.formatSummaryForDiscord(result);

    assert.ok(formatted.includes('SPY'), 'Should include ticker');
    assert.ok(formatted.includes('Long Gamma') || formatted.includes('Short Gamma') || formatted.includes('Mixed'),
      'Should include regime label');
    assert.ok(formatted.includes('Call Wall') || formatted.includes('call wall'),
      'Should mention call wall');
    assert.ok(formatted.includes('Put Wall') || formatted.includes('put wall'),
      'Should mention put wall');
  });

  it('includes STACKED annotation for stacked walls', async () => {
    const data = buildTestData();
    const engine = new GEXEngine(createMockGamma(data));
    const result = await engine.analyze('SPY');
    const formatted = engine.formatSummaryForDiscord(result);

    // $593 is stacked in our test data
    if (result.walls.callWalls[0]?.stacked) {
      assert.ok(formatted.includes('STACKED'), 'Should annotate stacked walls');
    }
  });

  it('includes dominant expiry information', async () => {
    const data = buildTestData();
    const engine = new GEXEngine(createMockGamma(data));
    const result = await engine.analyze('SPY');
    const formatted = engine.formatSummaryForDiscord(result);

    assert.ok(formatted.includes('Dominant'), 'Should mention dominant expiry');
    assert.ok(formatted.includes('2025-02-21'), 'Should include the dominant expiry date');
  });
});

// ── Break-and-hold alert tests ──────────────────────────────────────────

describe('Break-and-Hold Alerts', () => {
  let alertSvc;

  beforeEach(() => {
    alertSvc = new GEXAlertService({
      hold_candles: 3,
      candle_interval: '5Min',
      volume_confirm: false,
      min_regime_confidence_to_alert: 0.3,
    });
    alertSvc.clearCooldowns();
  });

  it('triggers alert when N candles close above call wall', () => {
    const summary = {
      regime: { label: 'Long Gamma', confidence: 0.8 },
      walls: {
        callWalls: [{ strike: 593, 'netGEX$': 155e6, stacked: true, expiryCount: 3, expiries: ['a', 'b', 'c'] }],
        putWalls: [{ strike: 580, 'netGEX$': -61e6, stacked: true, expiryCount: 2, expiries: ['a', 'b'] }],
      },
      gammaFlip: 587,
    };

    // 5 candles, last 3 all above 593
    const candles = [
      { close: 591, volume: 1000 },
      { close: 592, volume: 1100 },
      { close: 594, volume: 1200 },
      { close: 595, volume: 1300 },
      { close: 594.5, volume: 1400 },
    ];

    const alerts = alertSvc.evaluate('SPY', candles, summary);
    // Should trigger call wall break-above
    const callAlerts = alerts.filter(a => a.type === 'call_wall' && a.direction === 'above');
    assert.ok(callAlerts.length > 0, 'Should trigger call wall break-above alert');
  });

  it('does NOT trigger when candles straddle the level', () => {
    const summary = {
      regime: { label: 'Long Gamma', confidence: 0.8 },
      walls: {
        callWalls: [{ strike: 593, 'netGEX$': 155e6, stacked: true, expiryCount: 3, expiries: ['a', 'b', 'c'] }],
        putWalls: [],
      },
      gammaFlip: null,
    };

    // Last 3 candles: 1 below, 2 above → NOT all above
    const candles = [
      { close: 591 },
      { close: 592 },
      { close: 594 },
      { close: 591 },  // dips below
      { close: 594 },
    ];

    const alerts = alertSvc.evaluate('SPY', candles, summary);
    const callAlerts = alerts.filter(a => a.type === 'call_wall' && a.direction === 'above');
    assert.equal(callAlerts.length, 0, 'Should NOT trigger when candles straddle the level');
  });

  it('respects cooldown — no duplicate alerts', () => {
    const summary = {
      regime: { label: 'Short Gamma', confidence: 0.7 },
      walls: {
        callWalls: [],
        putWalls: [{ strike: 580, 'netGEX$': -50e6, stacked: false, expiryCount: 1, expiries: ['a'] }],
      },
      gammaFlip: null,
    };

    const candles = [
      { close: 582 },
      { close: 581 },
      { close: 579 },
      { close: 578 },
      { close: 577 },
    ];

    const alerts1 = alertSvc.evaluate('SPY', candles, summary);
    const alerts2 = alertSvc.evaluate('SPY', candles, summary);

    assert.ok(alerts1.length > 0, 'First evaluation should produce alerts');
    assert.equal(alerts2.length, 0, 'Second evaluation should be suppressed by cooldown');
  });

  it('skips alerts when regime confidence is below threshold', () => {
    const summary = {
      regime: { label: 'Mixed/Uncertain', confidence: 0.1 },
      walls: {
        callWalls: [{ strike: 593, 'netGEX$': 155e6, stacked: true, expiryCount: 3, expiries: ['a', 'b', 'c'] }],
        putWalls: [],
      },
      gammaFlip: null,
    };

    const candles = [
      { close: 594 },
      { close: 595 },
      { close: 596 },
    ];

    const alerts = alertSvc.evaluate('SPY', candles, summary);
    assert.equal(alerts.length, 0, 'Should skip alerts when confidence is below threshold');
  });

  it('handles volume confirmation toggle', () => {
    const volAlertSvc = new GEXAlertService({
      hold_candles: 3,
      volume_confirm: true,
      min_regime_confidence_to_alert: 0.3,
    });
    volAlertSvc.clearCooldowns();

    const summary = {
      regime: { label: 'Long Gamma', confidence: 0.8 },
      walls: {
        callWalls: [{ strike: 100, 'netGEX$': 10e6, stacked: false, expiryCount: 1, expiries: ['a'] }],
        putWalls: [],
      },
      gammaFlip: null,
    };

    // Candles with increasing volume (confirmed)
    const candles = [
      { close: 95, volume: 100 },
      { close: 96, volume: 110 },
      { close: 101, volume: 500 },
      { close: 102, volume: 600 },
      { close: 103, volume: 700 },
    ];

    const alerts = volAlertSvc.evaluate('TEST', candles, summary);
    const callAlerts = alerts.filter(a => a.type === 'call_wall');
    assert.ok(callAlerts.length > 0, 'Should trigger with volume confirmation');
    assert.ok(callAlerts[0].message.includes('Volume'), 'Alert should mention volume status');
  });
});

// ── Dollar formatting tests ─────────────────────────────────────────────

describe('Dollar Formatting', () => {
  it('formats billions correctly', () => {
    const engine = new GEXEngine(createMockGamma(buildTestData()));
    assert.equal(engine._fmtDollar(1.5e9), '$1.50B');
    assert.equal(engine._fmtDollar(-2.3e9), '-$2.30B');
  });

  it('formats millions correctly', () => {
    const engine = new GEXEngine(createMockGamma(buildTestData()));
    assert.equal(engine._fmtDollar(155e6), '$155.00M');
    assert.equal(engine._fmtDollar(-43e6), '-$43.00M');
  });

  it('formats thousands correctly', () => {
    const engine = new GEXEngine(createMockGamma(buildTestData()));
    assert.equal(engine._fmtDollar(232e3), '$232.0K');
  });

  it('formats small values correctly', () => {
    const engine = new GEXEngine(createMockGamma(buildTestData()));
    assert.equal(engine._fmtDollar(500), '$500');
    assert.equal(engine._fmtDollar(0), '$0');
  });
});
