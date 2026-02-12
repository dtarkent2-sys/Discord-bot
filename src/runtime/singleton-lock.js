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

const LOCK_KEY = 'discord-bot:leader';
const DEFAULT_TTL = parseInt(process.env.LEADER_LOCK_TTL_SECONDS, 10) || 60;
const DEFAULT_RENEW = parseInt(process.env.LEADER_LOCK_RENEW_SECONDS, 10) || 30;

let _redis = null;
let _renewInterval = null;
let _lockValue = null;

/**
 * Generate a unique lock value for this process instance.
 */
function _generateLockValue() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Create a minimal Redis client using native TCP or TLS.
 * Uses the RESP protocol directly to avoid adding a Redis dependency.
 * Supports both redis:// (plain TCP) and rediss:// (TLS) URLs.
 */
function _createRedisClient(redisUrl) {
  const url = new URL(redisUrl);
  const host = url.hostname || '127.0.0.1';
  const port = parseInt(url.port, 10) || 6379;
  const password = url.password ? decodeURIComponent(url.password) : null;
  const username = url.username ? decodeURIComponent(url.username) : null;
  const useTls = url.protocol === 'rediss:';

  log.info(`Redis connecting to ${host}:${port} (TLS: ${useTls})`);

  return new Promise((resolve, reject) => {
    let socket;
    if (useTls) {
      const tls = require('tls');
      socket = tls.connect({ host, port, rejectUnauthorized: false }, onConnect);
    } else {
      const net = require('net');
      socket = net.createConnection({ host, port }, onConnect);
    }

    function onConnect() {
      let buffer = '';
      const pending = [];

      function sendCommand(...args) {
        return new Promise((res, rej) => {
          const parts = [`*${args.length}`];
          for (const arg of args) {
            const str = String(arg);
            parts.push(`$${Buffer.byteLength(str)}`, str);
          }
          pending.push({ resolve: res, reject: rej });
          socket.write(parts.join('\r\n') + '\r\n');
        });
      }

      function parseResponse(data) {
        buffer += data;
        while (buffer.length > 0) {
          const nlIndex = buffer.indexOf('\r\n');
          if (nlIndex === -1) break;

          const type = buffer[0];
          const line = buffer.slice(1, nlIndex);

          if (type === '+') {
            // Simple string
            buffer = buffer.slice(nlIndex + 2);
            if (pending.length > 0) pending.shift().resolve(line);
          } else if (type === '-') {
            // Error
            buffer = buffer.slice(nlIndex + 2);
            if (pending.length > 0) pending.shift().reject(new Error(line));
          } else if (type === ':') {
            // Integer
            buffer = buffer.slice(nlIndex + 2);
            if (pending.length > 0) pending.shift().resolve(parseInt(line, 10));
          } else if (type === '$') {
            // Bulk string
            const len = parseInt(line, 10);
            if (len === -1) {
              buffer = buffer.slice(nlIndex + 2);
              if (pending.length > 0) pending.shift().resolve(null);
            } else {
              const totalLen = nlIndex + 2 + len + 2;
              if (buffer.length < totalLen) break; // wait for more data
              const val = buffer.slice(nlIndex + 2, nlIndex + 2 + len);
              buffer = buffer.slice(totalLen);
              if (pending.length > 0) pending.shift().resolve(val);
            }
          } else {
            // Unknown type, skip
            buffer = buffer.slice(nlIndex + 2);
          }
        }
      }

       socket.on('data', (data) => parseResponse(data.toString()));
      socket.on('error', (err) => {
        if (pending.length > 0) pending.shift().reject(err);
      });

      const client = {
        sendCommand,
        quit() {
          try { socket.end(); } catch {}
        },
      };

      // Authenticate if password is present.
      // Redis 6+ ACL supports AUTH username password; fall back to AUTH password.
      if (password) {
        const authArgs = username && username !== 'default'
          ? ['AUTH', username, password]
          : ['AUTH', password];
        sendCommand(...authArgs)
          .then(() => {
            log.info('Redis AUTH successful');
            resolve(client);
          })
          .catch(reject);
      } else {
        resolve(client);
      }
    });

    socket.on('error', reject);
    setTimeout(() => reject(new Error('Redis connection timeout')), 5000);
  });
}

/**
 * Acquire the singleton leader lock.
 *
 * - If REDIS_URL is set: attempts SET with NX + EX.
 *   If lock not acquired (another instance is leader), logs and exits.
 *   If acquired, starts renewal interval.
 * - If REDIS_URL is not set: logs WARN and allows boot.
 *
 * @returns {Promise<void>}
 */
async function acquireLock() {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    log.warn('REDIS_URL not set — singleton lock DISABLED. Multiple instances may connect to Discord simultaneously.');
    return;
  }

  log.info(`Attempting Redis lock (url scheme: ${new URL(redisUrl).protocol})`);

  try {
    _redis = await _createRedisClient(redisUrl);
    _lockValue = _generateLockValue();

    // SET key value NX EX ttl
    const result = await _redis.sendCommand('SET', LOCK_KEY, _lockValue, 'NX', 'EX', String(DEFAULT_TTL));

    if (result === 'OK') {
      log.info(`Leader lock ACQUIRED (key=${LOCK_KEY}, ttl=${DEFAULT_TTL}s, value=${_lockValue})`);

      // Start renewal
      _renewInterval = setInterval(async () => {
        try {
          await _renewLock();
        } catch (err) {
          log.error(`Lock renewal failed: ${err.message}`);
          _stopRenewal();
          log.error('Lost leader lock — exiting to allow another instance to take over');
          process.exit(0);
        }
      }, DEFAULT_RENEW * 1000);

      // Don't let the interval keep the process alive if everything else shuts down
      if (_renewInterval.unref) _renewInterval.unref();

      return;
    }

    // Lock NOT acquired — another instance is leader
    log.info(`Leader lock NOT acquired — another instance holds the lock. Exiting gracefully.`);
    _redis.quit();
    process.exit(0);
  } catch (err) {
    log.error(`Redis lock error: ${err.message} — proceeding WITHOUT lock (fallback mode)`);
    if (_redis) { try { _redis.quit(); } catch {} }
    _redis = null;
  }
}

/**
 * Renew the lock by checking ownership and extending TTL.
 */
async function _renewLock() {
  if (!_redis || !_lockValue) return;

  // GET the current value to verify we still own the lock
  const current = await _redis.sendCommand('GET', LOCK_KEY);
  if (current !== _lockValue) {
    throw new Error(`Lock value mismatch: expected ${_lockValue}, got ${current}`);
  }

  // Extend TTL
  await _redis.sendCommand('EXPIRE', LOCK_KEY, String(DEFAULT_TTL));
  log.info(`Leader lock RENEWED (ttl=${DEFAULT_TTL}s)`);
}

/**
 * Release the lock on shutdown.
 */
async function releaseLock() {
  _stopRenewal();

  if (!_redis || !_lockValue) return;

  try {
    // Only delete if we still own it
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

// Release lock on process exit
process.on('SIGTERM', async () => {
  await releaseLock();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await releaseLock();
  process.exit(0);
});

module.exports = { acquireLock, releaseLock };
