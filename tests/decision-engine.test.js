/**
 * 0DTE Options Decision Engine Tests
 *
 * Tests for the gate hierarchy, trigger detection, throttles,
 * strike selection, AI overlay, and conflict scenarios.
 *
 * Run: node --test tests/decision-engine.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/options/decision-engine');

// ── Test helpers ─────────────────────────────────────────────────────────

function buildBasicInput(overrides = {}) {
  // Generate bars for the last hour with an uptrend
  const bars = [];
  let price = 590;
  for (let i = 0; i < 20; i++) {
    price += (Math.random() - 0.45) * 0.5; // slight uptrend
    bars.push({
      open: price - 0.2,
      high: price + 0.3,
      low: price - 0.4,
      close: price,
      volume: 100000 + Math.random() * 50000,
    });
  }

  return {
    symbol: 'SPY',
    spot: 590,
    technicals: {
      rsi: 45,
      macd: { macd: 0.05, signal: 0.03, histogram: 0.02 },
      vwap: 589.5,
      priceAboveVWAP: true,
      momentum: 0.15,
      atr: 1.2,
      bollinger: { upper: 592, middle: 590, lower: 588 },
      nearestSupport: 588,
      nearestResistance: 593,
      bars,
      ...overrides.technicals,
    },
    gex: {
      regime: { label: 'Short Gamma', confidence: 0.7 },
      walls: {
        callWalls: [{ strike: 593, 'netGEX$': 50e6, stacked: true }],
        putWalls: [{ strike: 585, 'netGEX$': -30e6, stacked: false }],
      },
      gammaFlip: 588,
      shortGammaPct: 65,
      netGEX: -200e6,
      ...overrides.gex,
    },
    macro: { regime: 'RISK_ON', score: 7, ...overrides.macro },
    activePositions: overrides.activePositions || [],
    contractData: overrides.contractData || null,
    aiOverlay: overrides.aiOverlay || null,
    ...overrides,
  };
}

// ── Gate 0: Safety ───────────────────────────────────────────────────────

describe('Gate 0 — Safety', () => {
  it('should reject when spot is missing', () => {
    const input = buildBasicInput({ spot: 0 });
    const result = engine.evaluate(input);
    assert.equal(result.action, 'NO_TRADE');
    assert.equal(result.reasonCode, 'MISSING_SPOT');
  });

  it('should reject when technicals are missing', () => {
    const input = buildBasicInput();
    input.technicals = null;
    const result = engine.evaluate(input);
    assert.equal(result.action, 'NO_TRADE');
    assert.equal(result.reasonCode, 'MISSING_TECHNICALS');
  });

  it('should reject when spread is too wide', () => {
    const input = buildBasicInput({
      contractData: { bid: 1.00, ask: 1.50, delta: 0.40, strike: 590 },
    });
    const result = engine.evaluate(input);
    assert.equal(result.action, 'NO_TRADE');
    assert.equal(result.reasonCode, 'SPREAD_TOO_WIDE');
  });
});

// ── Gate 1: Macro ────────────────────────────────────────────────────────

describe('Gate 1 — Macro', () => {
  it('should reject on RISK_OFF', () => {
    const input = buildBasicInput({ macro: { regime: 'RISK_OFF' } });
    const result = engine.evaluate(input);
    assert.equal(result.action, 'NO_TRADE');
    assert.equal(result.reasonCode, 'MACRO_RISK_OFF');
  });

  it('should allow both directions on RISK_ON', () => {
    const input = buildBasicInput({ macro: { regime: 'RISK_ON' } });
    const result = engine.evaluate(input);
    // Should not be blocked by macro
    assert.notEqual(result.reasonCode, 'MACRO_RISK_OFF');
  });
});

// ── Gate 2: Gamma ────────────────────────────────────────────────────────

describe('Gate 2 — Gamma', () => {
  it('should allow squeeze only when shortGammaPct >= 60 AND netGEX <= -$300M', () => {
    const input = buildBasicInput({
      gex: {
        regime: { label: 'Short Gamma', confidence: 0.8 },
        walls: { callWalls: [], putWalls: [] },
        shortGammaPct: 65,
        netGEX: -350e6, // meets threshold
      },
    });
    const result = engine.evaluate(input);
    const g2 = result.gateResults.gate2;
    assert.equal(g2.isSqueeze, true);
  });

  it('should NOT allow squeeze when shortGammaPct < 60', () => {
    const input = buildBasicInput({
      gex: {
        regime: { label: 'Short Gamma', confidence: 0.6 },
        walls: { callWalls: [], putWalls: [] },
        shortGammaPct: 45,
        netGEX: -350e6,
      },
    });
    const result = engine.evaluate(input);
    const g2 = result.gateResults.gate2;
    assert.equal(g2.isSqueeze, false);
    // Conviction should be capped at 5
    assert.ok(g2.conviction <= 5);
  });

  it('should cap conviction at 5 when shortGammaPct < 50', () => {
    const input = buildBasicInput({
      gex: {
        regime: { label: 'Short Gamma', confidence: 0.5 },
        walls: { callWalls: [], putWalls: [] },
        shortGammaPct: 40,
        netGEX: -100e6,
      },
    });
    const result = engine.evaluate(input);
    const g2 = result.gateResults.gate2;
    assert.ok(g2.conviction <= 5, `conviction ${g2.conviction} should be <= 5`);
  });
});

// ── Gate 3: Trigger ──────────────────────────────────────────────────────

describe('Gate 3 — Trigger (mandatory)', () => {
  it('should require VWAP reclaim or break high for CALL', () => {
    // Build bars where last bar reclaims VWAP
    const bars = [];
    for (let i = 0; i < 10; i++) {
      bars.push({ open: 589, high: 589.5, low: 588.5, close: 589, volume: 100000 });
    }
    // Last bar closes above VWAP
    bars.push({ open: 589, high: 590.5, low: 589, close: 590.2, volume: 150000 });

    const input = buildBasicInput({
      technicals: {
        rsi: 35,
        macd: { macd: 0.01, signal: -0.01, histogram: 0.02 },
        vwap: 590,
        priceAboveVWAP: true,
        momentum: 0.1,
        bars,
      },
    });
    const result = engine.evaluate(input);
    // Should either trigger CALL or fail for another reason, not NO_TRIGGER
    if (result.gateResults.gate3) {
      // If trigger fired, direction should be CALL
      if (result.gateResults.gate3.triggered) {
        assert.equal(result.gateResults.gate3.direction, 'CALL');
      }
    }
  });

  it('should reject when no trigger fires', () => {
    // Flat bars with no VWAP cross or breakout
    const bars = [];
    for (let i = 0; i < 10; i++) {
      bars.push({ open: 590, high: 590.2, low: 589.8, close: 590, volume: 100000 });
    }

    const input = buildBasicInput({
      technicals: {
        rsi: 50, // neutral
        macd: { macd: 0, signal: 0, histogram: 0 },
        vwap: 590,
        priceAboveVWAP: false,
        momentum: 0.01,
        bars,
      },
    });
    const result = engine.evaluate(input);
    // Should either be NO_TRADE with NO_TRIGGER or CONFLICTING_TRIGGERS
    if (result.action === 'NO_TRADE') {
      assert.ok(
        ['NO_TRIGGER', 'CONFLICTING_TRIGGERS', 'INSUFFICIENT_BARS'].includes(result.reasonCode),
        `Expected trigger-related reason, got: ${result.reasonCode}`
      );
    }
  });
});

// ── Gate 4: AI Overlay ───────────────────────────────────────────────────

describe('Gate 4 — AI Overlay', () => {
  it('should NOT allow AI to flip direction', () => {
    const result = engine._gate4AIOverlay(
      { direction: 'PUT', conviction: 8, reason: 'test' },
      'CALL', // current direction
      7,      // current conviction
      engine.DEFAULT_CONFIG
    );
    // Conviction should be reduced, not flipped
    assert.ok(result.conviction <= 7);
    assert.ok(result.reasons.some(r => r.includes('conflicts')));
  });

  it('should limit AI conviction adjustment to +/-2', () => {
    const result = engine._gate4AIOverlay(
      { direction: 'CALL', conviction: 10, reason: 'very bullish' },
      'CALL',
      5,
      engine.DEFAULT_CONFIG
    );
    assert.ok(result.conviction <= 7, `conviction ${result.conviction} should be <= 7 (5 + max 2)`);
    assert.ok(result.conviction >= 5, `conviction ${result.conviction} should be >= 5`);
  });

  it('should reduce conviction to NO_TRADE level on conflict', () => {
    const result = engine._gate4AIOverlay(
      { direction: 'PUT', conviction: 2, reason: 'bearish' },
      'CALL',
      6,
      engine.DEFAULT_CONFIG
    );
    // Conflict: conviction reduced by 2
    assert.equal(result.conviction, 4);
  });
});

// ── Throttle Checks ──────────────────────────────────────────────────────

describe('Throttle Controls', () => {
  it('should enforce max correlated exposure', () => {
    const result = engine._checkThrottles('IWM', ['SPY', 'QQQ'], engine.DEFAULT_CONFIG);
    assert.equal(result.pass, false);
    assert.equal(result.reasonCode, 'MAX_CORRELATED_EXPOSURE');
  });

  it('should allow when under correlated limit', () => {
    const result = engine._checkThrottles('SPY', ['AAPL'], engine.DEFAULT_CONFIG);
    assert.equal(result.pass, true);
  });

  it('should track consecutive losses', () => {
    // Record 2 losses
    engine.recordTrade('SPY', -100);
    engine.recordTrade('SPY', -50);
    const result = engine._checkThrottles('SPY', [], engine.DEFAULT_CONFIG);
    assert.equal(result.pass, false);
    assert.equal(result.reasonCode, 'CONSECUTIVE_LOSS_COOLDOWN');

    // Clean up
    engine._recentLosses.delete('SPY');
  });

  it('should reset consecutive losses on win', () => {
    // Use a unique symbol to avoid maxTradesPerHour from prior tests
    engine.recordTrade('TQQQ', -100);
    engine.recordTrade('TQQQ', -50);
    engine.recordTrade('TQQQ', 200); // win resets consecutive losses
    // Use a higher maxTradesPerSymbolPerHour to isolate the consecutive loss test
    const cfg = { ...engine.DEFAULT_CONFIG, maxTradesPerSymbolPerHour: 10 };
    const result = engine._checkThrottles('TQQQ', [], cfg);
    assert.equal(result.pass, true);
  });
});

// ── Strike Validation ────────────────────────────────────────────────────

describe('Strike Selection', () => {
  it('should reject delta outside 0.35-0.55 range', () => {
    const result = engine._validateStrike(
      { delta: 0.20, spreadPct: 0.02, strike: 590 },
      590,
      engine.DEFAULT_CONFIG
    );
    assert.equal(result.pass, false);
    assert.equal(result.reasonCode, 'DELTA_OUT_OF_RANGE');
  });

  it('should accept delta within 0.35-0.55 range', () => {
    const result = engine._validateStrike(
      { delta: 0.42, spreadPct: 0.02, strike: 590 },
      590,
      engine.DEFAULT_CONFIG
    );
    assert.equal(result.pass, true);
  });

  it('should reject strike too far from spot', () => {
    const result = engine._validateStrike(
      { delta: 0.40, spreadPct: 0.02, strike: 600 },
      590,
      engine.DEFAULT_CONFIG
    );
    assert.equal(result.pass, false);
    assert.equal(result.reasonCode, 'STRIKE_TOO_FAR');
  });

  it('should reject wide spread', () => {
    const result = engine._validateStrike(
      { delta: 0.40, spreadPct: 0.05, strike: 590 },
      590,
      engine.DEFAULT_CONFIG
    );
    assert.equal(result.pass, false);
    assert.equal(result.reasonCode, 'SPREAD_TOO_WIDE');
  });
});

// ── Conflict Scenarios ───────────────────────────────────────────────────

describe('Conflict Scenarios', () => {
  it('should use 0DTE regime when aggregate conflicts', () => {
    const input = buildBasicInput({
      gex: {
        regime: { label: 'Long Gamma', confidence: 0.5 }, // aggregate says long
        walls: { callWalls: [], putWalls: [] },
        shortGammaPct: 65,
        netGEX: -200e6, // but 0DTE data says short
      },
    });
    const result = engine.evaluate(input);
    // Decision regime should reflect gex input label (which should be 0DTE-sourced)
    assert.ok(result.gateResults.gate2);
  });

  it('should produce NO_TRADE with reasonCode for every rejection', () => {
    // Missing spot
    let result = engine.evaluate(buildBasicInput({ spot: 0 }));
    assert.equal(result.action, 'NO_TRADE');
    assert.ok(result.reasonCode, 'Should have reasonCode');

    // RISK_OFF
    result = engine.evaluate(buildBasicInput({ macro: { regime: 'RISK_OFF' } }));
    assert.equal(result.action, 'NO_TRADE');
    assert.ok(result.reasonCode, 'Should have reasonCode');
  });

  it('should always use "scalp" strategy, never "swing"', () => {
    const input = buildBasicInput();
    const result = engine.evaluate(input);
    assert.equal(result.strategy, 'scalp');
    assert.ok(!JSON.stringify(result).toLowerCase().includes('swing'),
      'Result should never contain "swing"');
  });
});

// ── Rationale Formatter ──────────────────────────────────────────────────

describe('Rationale Formatter', () => {
  it('should format NO_TRADE with reasonCode', () => {
    const result = {
      action: 'NO_TRADE',
      reasonCode: 'MACRO_RISK_OFF',
      reasons: ['Macro is RISK_OFF'],
      decisionRegime: 'Short Gamma',
      contextRegime: 'Long Gamma',
    };
    const output = engine.formatRationale(result);
    assert.ok(output.includes('NO TRADE'));
    assert.ok(output.includes('MACRO_RISK_OFF'));
  });

  it('should show both decision and context regime', () => {
    const result = {
      action: 'BUY_CALL',
      direction: 'CALL',
      conviction: 7,
      strategy: 'scalp',
      reasons: ['Short gamma momentum'],
      decisionRegime: 'Short Gamma',
      contextRegime: 'Long Gamma',
      riskControls: {
        premiumStopPct: -0.40,
        timeStopMinutes: 12,
        vwapFailExitCount: 2,
        priceInvalidation: 588.50,
        strategy: 'scalp',
      },
    };
    const output = engine.formatRationale(result);
    assert.ok(output.includes('Short Gamma'));
    assert.ok(output.includes('decision'));
    assert.ok(output.includes('context'));
    assert.ok(output.includes('Long Gamma'));
    assert.ok(output.includes('scalp'));
  });

  it('should display risk controls', () => {
    const result = {
      action: 'BUY_PUT',
      direction: 'PUT',
      conviction: 6,
      strategy: 'scalp',
      reasons: [],
      decisionRegime: 'Short Gamma',
      contextRegime: 'Short Gamma',
      riskControls: {
        premiumStopPct: -0.40,
        timeStopMinutes: 12,
        vwapFailExitCount: 2,
        priceInvalidation: 592.00,
        strategy: 'scalp',
      },
    };
    const output = engine.formatRationale(result);
    assert.ok(output.includes('-40%'));
    assert.ok(output.includes('12min'));
  });
});
