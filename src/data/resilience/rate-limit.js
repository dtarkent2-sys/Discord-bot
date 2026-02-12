/**
 * Per-Provider Token Bucket Rate Limiter
 *
 * Prevents outbound API spam by enforcing per-provider request budgets.
 * Uses a simple token bucket algorithm: tokens refill at a fixed rate,
 * each request consumes one token, requests are rejected when bucket is empty.
 *
 * Env var: RATE_LIMITS — JSON override for provider limits (optional).
 *   e.g. RATE_LIMITS='{"ainvest":{"maxTokens":20,"refillPerSecond":2}}'
 */

const log = require('../../logger')('RateLimit');

// ── Default rate limits per provider ─────────────────────────────────────
const DEFAULT_LIMITS = {
  ainvest:  { maxTokens: 30, refillPerSecond: 2 },    // 30 burst, 2/sec steady
  fmp:     { maxTokens: 20, refillPerSecond: 1 },    // 20 burst, 1/sec steady
  searxng: { maxTokens: 10, refillPerSecond: 0.5 },  // 10 burst, 1 per 2s
  alpaca:  { maxTokens: 50, refillPerSecond: 5 },    // 50 burst, 5/sec
  default: { maxTokens: 20, refillPerSecond: 2 },
};

// Parse env override
let limitOverrides = {};
try {
  if (process.env.RATE_LIMITS) {
    limitOverrides = JSON.parse(process.env.RATE_LIMITS);
  }
} catch (err) {
  log.warn(`Invalid RATE_LIMITS env var: ${err.message}`);
}

const LIMITS = { ...DEFAULT_LIMITS, ...limitOverrides };

// ── Bucket state ─────────────────────────────────────────────────────────
const _buckets = new Map();

/**
 * Get or create a token bucket for a provider.
 */
function _getBucket(provider) {
  let bucket = _buckets.get(provider);
  if (!bucket) {
    const config = LIMITS[provider] || LIMITS.default;
    bucket = {
      tokens: config.maxTokens,
      maxTokens: config.maxTokens,
      refillPerSecond: config.refillPerSecond,
      lastRefill: Date.now(),
    };
    _buckets.set(provider, bucket);
  }
  return bucket;
}

/**
 * Refill tokens based on elapsed time.
 */
function _refill(bucket) {
  const now = Date.now();
  const elapsed = (now - bucket.lastRefill) / 1000;
  const newTokens = elapsed * bucket.refillPerSecond;
  bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + newTokens);
  bucket.lastRefill = now;
}

/**
 * Try to consume a token from the provider's bucket.
 * @param {string} provider - Provider name
 * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }}
 */
function tryConsume(provider) {
  const bucket = _getBucket(provider);
  _refill(bucket);

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
  }

  // Calculate time until next token
  const retryAfterMs = Math.ceil((1 - bucket.tokens) / bucket.refillPerSecond * 1000);
  log.warn(`Rate limited: ${provider} — ${bucket.tokens.toFixed(1)} tokens remaining, retry in ${retryAfterMs}ms`);
  return { allowed: false, remaining: 0, retryAfterMs };
}

/**
 * Check remaining tokens without consuming.
 */
function remaining(provider) {
  const bucket = _getBucket(provider);
  _refill(bucket);
  return Math.floor(bucket.tokens);
}

/**
 * Get stats for all providers.
 */
function stats() {
  const result = {};
  for (const [provider, bucket] of _buckets) {
    _refill(bucket);
    result[provider] = {
      tokens: Math.floor(bucket.tokens),
      maxTokens: bucket.maxTokens,
      refillPerSecond: bucket.refillPerSecond,
    };
  }
  return result;
}

module.exports = { tryConsume, remaining, stats };
