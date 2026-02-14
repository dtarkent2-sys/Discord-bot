const fs = require('fs');
const path = require('path');
const config = require('../config');
const log = require('../logger')('Storage');
const { createRedisClient } = require('../runtime/redis-client');

// Ensure data directory exists (still used as local cache / fallback)
if (!fs.existsSync(config.dataDir)) {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

// ── Shared Redis connection for all Storage instances ──────────────────
let _redis = null;    // the client object (has .connected, .sendCommand, .quit)
const _instances = [];

/** Check if the Redis client is connected and usable. */
function _isRedisReady() {
  return _redis !== null && _redis.connected === true;
}

/**
 * Initialize the shared Redis connection and hydrate all existing
 * Storage instances from Redis. Called once from index.js after boot.
 */
async function initRedisStorage() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    log.info('REDIS_URL not set — using file-only storage');
    return;
  }

  try {
    _redis = await createRedisClient(redisUrl);
    log.info('Redis storage connection established');

    // Hydrate every Storage instance sequentially (not pipelined) so the
    // minimal RESP parser processes one response at a time.
    // Timeout after 45s so a stuck Redis can never block Discord login
    // but all 16 stores get a fair shot even if a few are slow.
    const deadline = Date.now() + 45_000;
    let hydrated = 0;
    for (const inst of _instances) {
      if (Date.now() > deadline) {
        log.warn(`Hydration timeout — loaded ${hydrated}/${_instances.length} stores, proceeding with file data for the rest`);
        break;
      }
      await inst._loadFromRedis();
      hydrated++;
    }
    log.info(`Hydrated ${hydrated}/${_instances.length} stores from Redis`);
  } catch (err) {
    log.warn(`Redis storage init problem: ${err.message} — using file-backed data (will sync later)`);
  }
}

class Storage {
  constructor(filename) {
    this.filename = filename;
    this.redisKey = `store:${filename}`;
    this.filePath = path.join(config.dataDir, filename);
    this.data = this._loadFile();
    _instances.push(this);

    // If Redis is already connected (unlikely on first boot, but handles late-created instances)
    if (_isRedisReady()) {
      this._loadFromRedis().catch(() => {});
    }
  }

  _loadFile() {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      }
    } catch (err) {
      log.warn(`Failed to load ${this.filePath}: ${err.message}`);
    }
    return {};
  }

  async _loadFromRedis() {
    if (!_isRedisReady()) return;
    try {
      const raw = await _redis.sendCommand('GET', this.redisKey);
      if (raw) {
        try {
          this.data = JSON.parse(raw);
        } catch (parseErr) {
          // Corrupted JSON in Redis — delete the bad key and re-seed from file data
          log.warn(`Corrupted JSON in Redis for ${this.filename}: ${parseErr.message} — deleting key and re-seeding from file`);
          try { await _redis.sendCommand('DEL', this.redisKey); } catch {}
          this.data = this._loadFile();
          await this._saveToRedis();
        }
      } else {
        // First time: seed Redis with whatever file data we have
        await this._saveToRedis();
      }
    } catch (err) {
      log.warn(`Redis load failed for ${this.filename}: ${err.message}`);
    }
  }

  async _saveToRedis() {
    if (!_isRedisReady()) return;
    try {
      await _redis.sendCommand('SET', this.redisKey, JSON.stringify(this.data));
    } catch (err) {
      log.warn(`Redis save failed for ${this.filename}: ${err.message}`);
    }
  }

  save() {
    // File save (local dev / fallback)
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (err) {
      if (!_isRedisReady()) {
        log.error(`Failed to save ${this.filePath}: ${err.message}`);
      }
    }
    // Redis save (async, fire-and-forget — Redis is source of truth on Railway)
    this._saveToRedis();
  }

  get(key, defaultValue = undefined) {
    return this.data[key] ?? defaultValue;
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  getAll() {
    return { ...this.data };
  }
}

/**
 * Return a snapshot of all store data for backup purposes.
 * Returns { "store:filename.json": { ...data }, ... }
 */
function getAllStoreData() {
  const snapshot = {};
  for (const inst of _instances) {
    snapshot[inst.redisKey] = inst.getAll();
  }
  return snapshot;
}

/**
 * Restore all stores from a backup snapshot.
 * @param {Object} snapshot - { "store:filename.json": { ...data }, ... }
 */
async function restoreFromBackup(snapshot) {
  for (const inst of _instances) {
    if (snapshot[inst.redisKey]) {
      inst.data = snapshot[inst.redisKey];
      inst.save();
    }
  }
  log.info(`Restored ${Object.keys(snapshot).length} stores from backup`);
}

module.exports = Storage;
module.exports.initRedisStorage = initRedisStorage;
module.exports.getAllStoreData = getAllStoreData;
module.exports.restoreFromBackup = restoreFromBackup;
