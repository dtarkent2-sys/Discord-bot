/**
 * Endpoint-Level TTL Cache — Per-provider, per-endpoint caching.
 *
 * Cache keys include: provider + endpoint + symbol + timeframe.
 * TTL defaults are tuned per data type (profile=24h, news=20m, candles=20s-90s).
 *
 * Env var: CACHE_TTLS — JSON override for TTLs (optional).
 */

const log = require('../../logger')('ResilienceCache');

// ── Default TTLs (milliseconds) ─────────────────────────────────────────
const DEFAULT_TTLS = {
  'profile':      24 * 60 * 60 * 1000,   // 24h — company/profile info
  'company':      24 * 60 * 60 * 1000,   // 24h
  'financials':   24 * 60 * 60 * 1000,   // 24h
  'insider':      12 * 60 * 60 * 1000,   // 12h — insider/ownership
  'ownership':    12 * 60 * 60 * 1000,   // 12h
  'congress':     12 * 60 * 60 * 1000,   // 12h
  'analyst':      12 * 60 * 60 * 1000,   // 12h — analyst ratings
  'ratings':      12 * 60 * 60 * 1000,   // 12h
  'earnings':     12 * 60 * 60 * 1000,   // 12h
  'dividends':    12 * 60 * 60 * 1000,   // 12h
  'news':         20 * 60 * 1000,        // 20m — news headlines
  'headlines':    20 * 60 * 1000,        // 20m
  'candles_1m':   20 * 1000,            // 20s — 1-min candles
  'candles_1min': 20 * 1000,            // 20s
  'candles_5m':   90 * 1000,            // 90s — 5-min candles
  'candles_5min': 90 * 1000,            // 90s
  'candles':      60 * 1000,            // 60s — default candles
  'quote':        15 * 1000,            // 15s — real-time quotes
  'search':       5 * 60 * 1000,        // 5m  — search results
  'default':      60 * 1000,            // 60s — fallback
};

// Parse env override if provided
let ttlOverrides = {};
try {
  if (process.env.CACHE_TTLS) {
    ttlOverrides = JSON.parse(process.env.CACHE_TTLS);
  }
} catch (err) {
  log.warn(`Invalid CACHE_TTLS env var: ${err.message}`);
}

const TTLS = { ...DEFAULT_TTLS, ...ttlOverrides };

// ── Cache storage ────────────────────────────────────────────────────────
const _store = new Map();

const MAX_ENTRIES = 5000;

/**
 * Build a cache key from provider, endpoint, and parameters.
 * @param {string} provider - e.g. 'ainvest', 'fmp', 'searxng'
 * @param {string} endpoint - e.g. 'candles', 'news', 'profile'
 * @param {object} [params] - { symbol, timeframe, ... }
 * @returns {string}
 */
function buildKey(provider, endpoint, params = {}) {
  const parts = [provider, endpoint];
  if (params.symbol) parts.push(params.symbol);
  if (params.timeframe) parts.push(params.timeframe);
  if (params.tab) parts.push(params.tab);
  if (params.query) parts.push(params.query.slice(0, 50));
  return parts.join(':').toLowerCase();
}

/**
 * Resolve TTL for an endpoint type.
 * Matches the most specific key first, then falls back.
 */
function resolveTTL(endpoint, timeframe) {
  // Try specific candle timeframe
  if (endpoint === 'candles' && timeframe) {
    const candleKey = `candles_${timeframe.toLowerCase()}`;
    if (TTLS[candleKey]) return TTLS[candleKey];
  }
  // Try endpoint directly
  if (TTLS[endpoint]) return TTLS[endpoint];
  // Try partial match
  for (const [key, ttl] of Object.entries(TTLS)) {
    if (endpoint.includes(key)) return ttl;
  }
  return TTLS.default;
}

/**
 * Get a cached value.
 * @param {string} key
 * @returns {{ hit: boolean, data: any, age: number }}
 */
function get(key) {
  const entry = _store.get(key);
  if (!entry) {
    return { hit: false, data: null, age: 0 };
  }

  const age = Date.now() - entry.timestamp;
  if (age > entry.ttl) {
    _store.delete(key);
    return { hit: false, data: null, age };
  }

  return { hit: true, data: entry.data, age };
}

/**
 * Set a cached value.
 * @param {string} key
 * @param {any} data
 * @param {number} [ttl] - TTL in ms (optional, auto-resolved if not provided)
 */
function set(key, data, ttl) {
  // Evict oldest entries if at capacity
  if (_store.size >= MAX_ENTRIES) {
    _pruneExpired();
    if (_store.size >= MAX_ENTRIES) {
      // Remove oldest 20%
      const keys = [..._store.keys()];
      const toRemove = Math.ceil(keys.length * 0.2);
      for (let i = 0; i < toRemove; i++) {
        _store.delete(keys[i]);
      }
    }
  }

  _store.set(key, {
    data,
    timestamp: Date.now(),
    ttl: ttl || TTLS.default,
  });
}

/**
 * Check if a key exists and is not expired.
 */
function has(key) {
  return get(key).hit;
}

/**
 * Delete a cache entry.
 */
function del(key) {
  _store.delete(key);
}

/**
 * Clear all cache entries.
 */
function clear() {
  _store.clear();
}

/**
 * Get cache stats.
 */
function stats() {
  _pruneExpired();
  return {
    size: _store.size,
    maxEntries: MAX_ENTRIES,
  };
}

function _pruneExpired() {
  const now = Date.now();
  for (const [key, entry] of _store) {
    if (now - entry.timestamp > entry.ttl) {
      _store.delete(key);
    }
  }
}

module.exports = { buildKey, resolveTTL, get, set, has, del, clear, stats, TTLS };
