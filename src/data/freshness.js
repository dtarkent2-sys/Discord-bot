/**
 * Data freshness gate — refuses to proceed with stale or missing data.
 */

class FreshnessError extends Error {
  constructor(field, ageSeconds, maxAgeSeconds) {
    super(`Data for "${field}" is stale: ${ageSeconds}s old (max ${maxAgeSeconds}s)`);
    this.name = 'FreshnessError';
    this.field = field;
    this.ageSeconds = ageSeconds;
    this.maxAgeSeconds = maxAgeSeconds;
  }
}

/**
 * Assert that a timestamp is within max_age_seconds of now.
 * @param {string|number|Date} ts - The timestamp to check
 * @param {number} maxAgeSeconds - Maximum allowed age in seconds
 * @param {string} [label='data'] - Label for error messages
 * @throws {FreshnessError} if data is stale
 */
function assertFresh(ts, maxAgeSeconds, label = 'data') {
  if (!ts) {
    throw new FreshnessError(label, Infinity, maxAgeSeconds);
  }

  const timestamp = new Date(ts).getTime();
  if (isNaN(timestamp)) {
    throw new FreshnessError(label, Infinity, maxAgeSeconds);
  }

  const ageSeconds = Math.floor((Date.now() - timestamp) / 1000);
  if (ageSeconds > maxAgeSeconds) {
    throw new FreshnessError(label, ageSeconds, maxAgeSeconds);
  }

  return ageSeconds;
}

module.exports = { assertFresh, FreshnessError };
