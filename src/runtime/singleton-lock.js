/**
 * Singleton Lock — Ensures only ONE bot instance connects to Discord.
 *
 * Railway can briefly run two instances during deploys/restarts.
 * This module acquires a distributed lock via Redis (if REDIS_URL is set)
 * so only the leader connects. If Redis is unavailable, it logs a warning
 * and allows boot (single-instance fallback).
 *
 * Env vars:
 *   REDIS_URL                  — Redis connection string (optional)
 *   LEADER_LOCK_TTL_SECONDS    — Lock expiry in seconds (default 60)
 *   LEADER_LOCK_RENEW_SECONDS  — Renewal interval in seconds (default 30)
 */

const log = require('../logger')('SingletonLock');
const { createRedisClient } = require('./redis-client');

const LOCK_KEY = 'discord-bot:leader';
const DEFAULT_TTL = parseInt(process.env.LEADER_LOCK_TTL_SECONDS, 10) || 60;
const DEFAULT_RENEW = parseInt(process.env.LEADER_LOCK_RENEW_SECONDS, 10) || 30;

let _redis = null;
let _renewInterval = null;
let _lockValue = null;

function _generateLockValue() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Acquire the singleton leader lock.
 */
async function acquireLock() {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    log.warn('REDIS_URL not set — singleton lock DISABLED. Multiple instances may connect to Discord simultaneously.');
    return;
  }

  log.info(`Attempting Redis lock (url scheme: ${new URL(redisUrl).protocol})`);

  try {
    _redis = await createRedisClient(redisUrl);
    _lockValue = _generateLockValue();

    // Try to acquire the lock. Retry a few times to handle the common case
    // where the previous instance's lock hasn't expired yet during a deploy.
    const maxAttempts = 6; // ~30s total — enough for TTL-based expiry during deploys
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await _redis.sendCommand('SET', LOCK_KEY, _lockValue, 'NX', 'EX', String(DEFAULT_TTL));

      if (result === 'OK') {
        log.info(`Leader lock ACQUIRED (key=${LOCK_KEY}, ttl=${DEFAULT_TTL}s, value=${_lockValue})`);

        _renewInterval = setInterval(async () => {
          try {
            await _renewLock();
          } catch (err) {
            log.error(`Lock renewal failed: ${err.message}`);
            _stopRenewal();
            // Don't exit — keep running, just lose leader exclusivity.
            // Exiting with code 0 under ON_FAILURE restart policy kills the bot permanently.
            log.warn('Lost leader lock — continuing without lock');
          }
        }, DEFAULT_RENEW * 1000);

        if (_renewInterval.unref) _renewInterval.unref();
        return;
      }

      const ttl = await _redis.sendCommand('TTL', LOCK_KEY);
      const waitSec = Math.min(ttl > 0 ? ttl : 5, 10);

      if (attempt < maxAttempts) {
        log.info(`Leader lock held by another instance (TTL ${ttl}s). Retrying in ${waitSec}s... (attempt ${attempt}/${maxAttempts})`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
      } else {
        // Don't process.exit(0) — Railway's ON_FAILURE restart policy won't restart
        // a process that exits with code 0, killing the bot permanently.
        log.warn(`Leader lock NOT acquired after ${maxAttempts} attempts — proceeding WITHOUT lock`);
        _redis.quit();
        _redis = null;
      }
    }
  } catch (err) {
    log.error(`Redis lock error: ${err.message} — proceeding WITHOUT lock (fallback mode)`);
    if (_redis) { try { _redis.quit(); } catch {} }
    _redis = null;
  }
}

async function _renewLock() {
  if (!_redis || !_lockValue) return;
  const current = await _redis.sendCommand('GET', LOCK_KEY);
  if (current !== _lockValue) {
    throw new Error(`Lock value mismatch: expected ${_lockValue}, got ${current}`);
  }
  await _redis.sendCommand('EXPIRE', LOCK_KEY, String(DEFAULT_TTL));
  log.info(`Leader lock RENEWED (ttl=${DEFAULT_TTL}s)`);
}

async function releaseLock() {
  _stopRenewal();
  if (!_redis || !_lockValue) return;
  try {
    const current = await _redis.sendCommand('GET', LOCK_KEY);
    if (current === _lockValue) {
      await _redis.sendCommand('DEL', LOCK_KEY);
      log.info('Leader lock RELEASED');
    }
  } catch (err) {
    log.warn(`Error releasing lock: ${err.message}`);
  } finally {
    try { _redis.quit(); } catch {}
    _redis = null;
    _lockValue = null;
  }
}

function _stopRenewal() {
  if (_renewInterval) {
    clearInterval(_renewInterval);
    _renewInterval = null;
  }
}

process.on('SIGTERM', async () => {
  await releaseLock();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await releaseLock();
  process.exit(0);
});

module.exports = { acquireLock, releaseLock };
