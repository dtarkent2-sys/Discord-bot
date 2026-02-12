/**
 * Resilience Layer Tests — Cache, Rate Limit, Circuit Breaker
 *
 * Run: node --test tests/resilience.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const cache = require('../src/data/resilience/cache');
const rateLimit = require('../src/data/resilience/rate-limit');
const circuitBreaker = require('../src/data/resilience/circuit-breaker');

// ── Cache Tests ──────────────────────────────────────────────────────────

describe('Resilience Cache', () => {
  beforeEach(() => {
    cache.clear();
  });

  it('should build deterministic cache keys', () => {
    const key1 = cache.buildKey('ainvest', 'candles', { symbol: 'SPY', timeframe: '5min' });
    const key2 = cache.buildKey('ainvest', 'candles', { symbol: 'SPY', timeframe: '5min' });
    assert.equal(key1, key2);
    assert.ok(key1.includes('ainvest'));
    assert.ok(key1.includes('spy'));
    assert.ok(key1.includes('5min'));
  });

  it('should return cache miss for unknown key', () => {
    const result = cache.get('unknown-key');
    assert.equal(result.hit, false);
    assert.equal(result.data, null);
  });

  it('should store and retrieve cached data', () => {
    cache.set('test-key', { foo: 'bar' }, 60000);
    const result = cache.get('test-key');
    assert.equal(result.hit, true);
    assert.deepEqual(result.data, { foo: 'bar' });
    assert.ok(result.age < 1000);
  });

  it('should expire entries after TTL', () => {
    // Set with 1ms TTL — will be expired immediately
    cache.set('expire-key', { data: true }, 1);
    // Wait a tick
    const start = Date.now();
    while (Date.now() - start < 5) {} // busy wait 5ms
    const result = cache.get('expire-key');
    assert.equal(result.hit, false);
  });

  it('should resolve correct TTL for candle types', () => {
    const ttl1m = cache.resolveTTL('candles', '1min');
    const ttl5m = cache.resolveTTL('candles', '5min');
    const ttlNews = cache.resolveTTL('news');
    const ttlProfile = cache.resolveTTL('profile');

    assert.equal(ttl1m, 20 * 1000); // 20s
    assert.equal(ttl5m, 90 * 1000); // 90s
    assert.equal(ttlNews, 20 * 60 * 1000); // 20m
    assert.equal(ttlProfile, 24 * 60 * 60 * 1000); // 24h
  });

  it('should delete entries', () => {
    cache.set('del-key', 'value', 60000);
    assert.equal(cache.has('del-key'), true);
    cache.del('del-key');
    assert.equal(cache.has('del-key'), false);
  });
});

// ── Rate Limit Tests ─────────────────────────────────────────────────────

describe('Rate Limiter', () => {
  it('should allow requests within budget', () => {
    const result = rateLimit.tryConsume('ainvest');
    assert.equal(result.allowed, true);
    assert.ok(result.remaining >= 0);
  });

  it('should track remaining tokens', () => {
    const before = rateLimit.remaining('fmp');
    rateLimit.tryConsume('fmp');
    const after = rateLimit.remaining('fmp');
    assert.ok(after <= before);
  });

  it('should reject when bucket is empty', () => {
    // Drain the test bucket
    for (let i = 0; i < 100; i++) {
      rateLimit.tryConsume('searxng');
    }
    const result = rateLimit.tryConsume('searxng');
    assert.equal(result.allowed, false);
    assert.ok(result.retryAfterMs > 0);
  });

  it('should return stats', () => {
    rateLimit.tryConsume('ainvest');
    const stats = rateLimit.stats();
    assert.ok(stats.ainvest);
    assert.ok(typeof stats.ainvest.tokens === 'number');
  });
});

// ── Circuit Breaker Tests ────────────────────────────────────────────────

describe('Provider Circuit Breaker', () => {
  beforeEach(() => {
    // Reset all circuits
    circuitBreaker.reset('test-provider', 'test-endpoint');
    circuitBreaker.reset('test-provider', '*');
    circuitBreaker.reset('ainvest', 'news');
    circuitBreaker.reset('searxng', 'search');
    circuitBreaker.reset('fmp', 'quote');
    circuitBreaker.reset('ainvest', 'mcp:candles');
  });

  it('should be closed initially', () => {
    const status = circuitBreaker.isOpen('test-provider', 'test-endpoint');
    assert.equal(status.open, false);
  });

  it('should trip on HTTP 429', () => {
    circuitBreaker.recordError('searxng', 'search', { statusCode: 429, message: 'Too Many Requests' });
    const status = circuitBreaker.isOpen('searxng', 'search');
    assert.equal(status.open, true);
    assert.ok(status.reason.includes('429'));
    assert.ok(status.cooldownRemaining > 0);
  });

  it('should trip on AInvest 4014', () => {
    circuitBreaker.recordError('ainvest', 'news', { errorCode: 4014, message: 'Rate limited' });
    const status = circuitBreaker.isOpen('ainvest', 'news');
    assert.equal(status.open, true);
    assert.ok(status.reason.includes('4014'));
    // 4014 cooldown should be longer than 429
    assert.ok(status.cooldownRemaining > 15 * 60 * 1000); // > 15 min
  });

  it('should permanently disable MCP tool on 404', () => {
    circuitBreaker.recordError('ainvest', 'mcp:candles', { statusCode: 404, message: 'Tool not found' });
    const status = circuitBreaker.isOpen('ainvest', 'mcp:candles');
    assert.equal(status.open, true);
    assert.equal(status.cooldownRemaining, Infinity);
  });

  it('should reset on success after non-permanent trip', () => {
    circuitBreaker.recordError('fmp', 'quote', { statusCode: 429, message: 'Rate limited' });
    assert.equal(circuitBreaker.isOpen('fmp', 'quote').open, true);
    circuitBreaker.reset('fmp', 'quote');
    assert.equal(circuitBreaker.isOpen('fmp', 'quote').open, false);
  });

  it('should track consecutive errors before tripping', () => {
    // Should not trip on first error (non-429, non-4014)
    circuitBreaker.recordError('test-provider', 'test-endpoint', { statusCode: 500, message: 'Internal error' });
    assert.equal(circuitBreaker.isOpen('test-provider', 'test-endpoint').open, false);

    // Trip after threshold
    for (let i = 0; i < 5; i++) {
      circuitBreaker.recordError('test-provider', 'test-endpoint', { statusCode: 500, message: 'error' });
    }
    assert.equal(circuitBreaker.isOpen('test-provider', 'test-endpoint').open, true);
  });

  it('should throw ProviderUnavailableError when circuit is open and no cache', () => {
    circuitBreaker.recordError('searxng', 'search', { statusCode: 429, message: 'Rate limited' });
    assert.throws(
      () => circuitBreaker.checkOrThrow('searxng', 'search'),
      (err) => err.name === 'ProviderUnavailableError'
    );
  });

  it('should return cached data when circuit is open and cache has data', () => {
    // Prime cache
    cache.set('searxng:search:test', { cached: true }, 60000);
    circuitBreaker.recordError('searxng', 'search', { statusCode: 429, message: 'Rate limited' });
    const result = circuitBreaker.checkOrThrow('searxng', 'search', 'searxng:search:test');
    assert.equal(result.open, true);
    assert.deepEqual(result.cachedData, { cached: true });
  });

  it('should report status of all open circuits', () => {
    circuitBreaker.recordError('ainvest', 'news', { statusCode: 429, message: 'Rate limited' });
    const status = circuitBreaker.getStatus();
    assert.ok(Object.keys(status).length > 0);
    assert.ok(status['ainvest:news']);
  });
});
