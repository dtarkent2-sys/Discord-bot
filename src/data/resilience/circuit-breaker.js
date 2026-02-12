/**
 * Provider Circuit Breaker — Disables providers/endpoints after repeated errors.
 *
 * Rules:
 *   HTTP 429          → disable provider/endpoint for 15 minutes
 *   AInvest code 4014 → disable for 60 minutes
 *   HTTP 404 for MCP  → disable tool permanently until restart
 *   Other errors      → after 5 consecutive errors, disable for 5 minutes
 *
 * When circuit is open: skip call, return cached value if present,
 * else throw ProviderUnavailableError.
 *
 * NOTE: This is SEPARATE from the trading circuit breaker in
 * src/services/circuit-breaker.js which handles trade-level pauses.
 * This handles provider-level API failures.
 */

const log = require('../../logger')('ProviderBreaker');
const cache = require('./cache');

// ── Cooldown durations ───────────────────────────────────────────────────
const COOLDOWN_429 = 15 * 60 * 1000;     // 15 minutes for HTTP 429
const COOLDOWN_4014 = 60 * 60 * 1000;    // 60 minutes for AInvest 4014
const COOLDOWN_DEFAULT = 5 * 60 * 1000;  // 5 minutes for general errors
const ERROR_THRESHOLD = 5;                // consecutive errors before tripping

// ── Typed error ──────────────────────────────────────────────────────────

class ProviderUnavailableError extends Error {
  constructor(provider, endpoint, reason, cooldownRemaining) {
    super(`${provider}/${endpoint} unavailable: ${reason} (${Math.ceil(cooldownRemaining / 1000)}s remaining)`);
    this.name = 'ProviderUnavailableError';
    this.provider = provider;
    this.endpoint = endpoint;
    this.reason = reason;
    this.cooldownRemaining = cooldownRemaining;
  }
}

// ── State ────────────────────────────────────────────────────────────────

// Map of "provider:endpoint" → { disabledUntil, reason, permanent, consecutiveErrors }
const _circuits = new Map();

/**
 * Get the circuit key.
 */
function _key(provider, endpoint) {
  return `${provider}:${endpoint || '*'}`;
}

/**
 * Check if a provider/endpoint is currently disabled.
 * @param {string} provider
 * @param {string} [endpoint]
 * @returns {{ open: boolean, reason?: string, cooldownRemaining?: number }}
 */
function isOpen(provider, endpoint) {
  // Check specific endpoint first, then wildcard
  for (const k of [_key(provider, endpoint), _key(provider, '*')]) {
    const circuit = _circuits.get(k);
    if (!circuit) continue;

    if (circuit.permanent) {
      return {
        open: true,
        reason: circuit.reason,
        cooldownRemaining: Infinity,
      };
    }

    const remaining = circuit.disabledUntil - Date.now();
    if (remaining > 0) {
      return {
        open: true,
        reason: circuit.reason,
        cooldownRemaining: remaining,
      };
    }

    // Cooldown expired — reset
    _circuits.delete(k);
  }

  return { open: false };
}

/**
 * Check circuit and throw if open, optionally returning cached data.
 * @param {string} provider
 * @param {string} endpoint
 * @param {string} [cacheKey] - If provided, returns cached data when circuit is open
 * @returns {{ open: boolean, cachedData?: any }}
 */
function checkOrThrow(provider, endpoint, cacheKey) {
  const status = isOpen(provider, endpoint);
  if (!status.open) return { open: false };

  log.warn(`circuit_open provider=${provider} endpoint=${endpoint} reason="${status.reason}" cooldown_remaining=${Math.ceil((status.cooldownRemaining || 0) / 1000)}s`);

  // Try returning cached data
  if (cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached.hit) {
      log.info(`circuit_open returning cached data for ${cacheKey} (age=${Math.ceil(cached.age / 1000)}s)`);
      return { open: true, cachedData: cached.data };
    }
  }

  throw new ProviderUnavailableError(
    provider, endpoint, status.reason, status.cooldownRemaining || 0
  );
}

/**
 * Record an error and potentially trip the circuit.
 * @param {string} provider
 * @param {string} endpoint
 * @param {object} error - { statusCode, errorCode, message }
 */
function recordError(provider, endpoint, error) {
  const key = _key(provider, endpoint);
  const { statusCode, errorCode, message } = error;

  // HTTP 429 — rate limited, disable for 15 min
  if (statusCode === 429) {
    _trip(key, COOLDOWN_429, `HTTP 429 rate limited`);
    log.warn(`circuit_tripped provider=${provider} endpoint=${endpoint} reason=HTTP_429 cooldown=15m`);
    return;
  }

  // AInvest error code 4014 — disable for 60 min
  if (errorCode === 4014 || errorCode === '4014') {
    _trip(key, COOLDOWN_4014, `AInvest error 4014`);
    log.warn(`circuit_tripped provider=${provider} endpoint=${endpoint} reason=AINVEST_4014 cooldown=60m`);
    return;
  }

  // HTTP 404 for MCP tool — disable permanently
  if (statusCode === 404 && endpoint.startsWith('mcp:')) {
    _circuits.set(key, {
      disabledUntil: Infinity,
      reason: `MCP tool 404: ${message || endpoint}`,
      permanent: true,
      consecutiveErrors: 0,
    });
    log.warn(`circuit_tripped provider=${provider} endpoint=${endpoint} reason=MCP_404 cooldown=PERMANENT`);
    return;
  }

  // General errors — track consecutive, trip after threshold
  let circuit = _circuits.get(key);
  if (!circuit || (circuit.disabledUntil && circuit.disabledUntil < Date.now())) {
    circuit = { disabledUntil: 0, reason: '', permanent: false, consecutiveErrors: 0 };
    _circuits.set(key, circuit);
  }

  circuit.consecutiveErrors++;
  if (circuit.consecutiveErrors >= ERROR_THRESHOLD) {
    _trip(key, COOLDOWN_DEFAULT, `${circuit.consecutiveErrors} consecutive errors: ${message || statusCode}`);
    log.warn(`circuit_tripped provider=${provider} endpoint=${endpoint} reason=consecutive_errors count=${circuit.consecutiveErrors} cooldown=5m`);
  }
}

/**
 * Record a success — resets consecutive error counter.
 */
function recordSuccess(provider, endpoint) {
  const key = _key(provider, endpoint);
  const circuit = _circuits.get(key);
  if (circuit && !circuit.permanent) {
    circuit.consecutiveErrors = 0;
  }
}

/**
 * Trip the circuit for a given duration.
 */
function _trip(key, durationMs, reason) {
  _circuits.set(key, {
    disabledUntil: Date.now() + durationMs,
    reason,
    permanent: false,
    consecutiveErrors: 0,
  });
}

/**
 * Manually reset a circuit.
 */
function reset(provider, endpoint) {
  const key = _key(provider, endpoint);
  _circuits.delete(key);
  log.info(`Circuit reset: ${key}`);
}

/**
 * Get status of all circuits.
 */
function getStatus() {
  const result = {};
  for (const [key, circuit] of _circuits) {
    const remaining = circuit.permanent ? Infinity : Math.max(0, circuit.disabledUntil - Date.now());
    if (remaining > 0 || circuit.permanent) {
      result[key] = {
        reason: circuit.reason,
        permanent: circuit.permanent,
        cooldownRemainingMs: remaining,
        cooldownRemainingMin: circuit.permanent ? 'permanent' : Math.ceil(remaining / 60000),
        consecutiveErrors: circuit.consecutiveErrors,
      };
    }
  }
  return result;
}

module.exports = {
  ProviderUnavailableError,
  isOpen,
  checkOrThrow,
  recordError,
  recordSuccess,
  reset,
  getStatus,
};
