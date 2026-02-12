/**
 * Provider Resilience Layer — Unified wrapper for all outbound API calls.
 *
 * Combines:
 *   1. Per-provider token bucket rate limiting
 *   2. Endpoint-level TTL cache
 *   3. Circuit breaker on error codes
 *
 * Usage:
 *   const resilience = require('./data/resilience');
 *   const data = await resilience.call('ainvest', 'candles', { symbol: 'SPY', timeframe: '5min' }, fetchFn);
 */

const cache = require('./cache');
const rateLimit = require('./rate-limit');
const circuitBreaker = require('./circuit-breaker');
const log = require('../../logger')('Resilience');

/**
 * Execute a provider call with full resilience wrapping.
 *
 * @param {string} provider - Provider name (ainvest, fmp, searxng)
 * @param {string} endpoint - Endpoint type (candles, news, profile, etc.)
 * @param {object} params - { symbol, timeframe, ... } for cache key building
 * @param {Function} fetchFn - The actual async function to call
 * @param {object} [opts] - { cacheTtl, skipCache, skipRateLimit }
 * @returns {Promise<any>}
 */
async function call(provider, endpoint, params, fetchFn, opts = {}) {
  const cacheKey = cache.buildKey(provider, endpoint, params);
  const ttl = opts.cacheTtl || cache.resolveTTL(endpoint, params.timeframe);

  // 1. Check cache first (unless skipped)
  if (!opts.skipCache) {
    const cached = cache.get(cacheKey);
    if (cached.hit) {
      log.debug(`cache_hit provider=${provider} endpoint=${endpoint} key=${cacheKey} age=${Math.ceil(cached.age / 1000)}s`);
      return cached.data;
    }
    log.debug(`cache_miss provider=${provider} endpoint=${endpoint} key=${cacheKey}`);
  }

  // 2. Check circuit breaker
  const breakerResult = circuitBreaker.checkOrThrow(provider, endpoint, cacheKey);
  if (breakerResult.open && breakerResult.cachedData !== undefined) {
    return breakerResult.cachedData;
  }

  // 3. Check rate limit
  if (!opts.skipRateLimit) {
    const rlResult = rateLimit.tryConsume(provider);
    if (!rlResult.allowed) {
      log.warn(`rate_limited provider=${provider} endpoint=${endpoint} retry_after=${rlResult.retryAfterMs}ms`);
      // Try to return cached data even if expired
      const stale = cache.get(cacheKey);
      if (stale.hit) return stale.data;
      throw new Error(`Rate limited: ${provider} — retry after ${rlResult.retryAfterMs}ms`);
    }
  }

  // 4. Execute the actual call
  try {
    const result = await fetchFn();

    // Record success
    circuitBreaker.recordSuccess(provider, endpoint);

    // Cache the result
    cache.set(cacheKey, result, ttl);

    return result;
  } catch (err) {
    // Extract error info for circuit breaker
    const statusCode = err.status || err.statusCode || _extractStatusCode(err.message);
    const errorCode = err.code || err.errorCode || _extractErrorCode(err.message);

    circuitBreaker.recordError(provider, endpoint, {
      statusCode,
      errorCode,
      message: err.message,
    });

    throw err;
  }
}

/**
 * Extract HTTP status code from error message.
 */
function _extractStatusCode(msg) {
  if (!msg) return null;
  const match = msg.match(/\b(4\d{2}|5\d{2})\b/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Extract error code from message.
 */
function _extractErrorCode(msg) {
  if (!msg) return null;
  const match = msg.match(/code[:\s]+(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

module.exports = {
  call,
  cache,
  rateLimit,
  circuitBreaker,
};
