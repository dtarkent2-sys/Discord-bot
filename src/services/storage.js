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
let _redis = null;
let _redisReady = false;
const _instances = [];

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
    _redisReady = true;
    log.info('Redis storage connection established');

    // Hydrate every Storage instance that was created before Redis connected
    await Promise.all(_instances.map(inst => inst._loadFromRedis()));
    log.info(`Hydrated ${_instances.length} stores from Redis`);
  } catch (err) {
    log.warn(`Redis storage connection failed: ${err.message} — using file-only storage`);
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
    if (_redisReady) {
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
    if (!_redisReady) return;
    try {
      const raw = await _redis.sendCommand('GET', this.redisKey);
      if (raw) {
        this.data = JSON.parse(raw);
      } else {
        // First time: seed Redis with whatever file data we have
        await this._saveToRedis();
      }
    } catch (err) {
      log.warn(`Redis load failed for ${this.filename}: ${err.message}`);
    }
  }

  async _saveToRedis() {
    if (!_redisReady) return;
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
      if (!_redisReady) {
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
