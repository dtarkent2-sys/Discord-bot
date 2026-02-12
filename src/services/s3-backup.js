/**
 * S3 Backup Service — periodic Redis data backups to Railway Object Storage.
 *
 * Backs up all Storage instances to an S3-compatible bucket on a schedule.
 * Supports backup, restore, and automatic cleanup of old backups.
 */

const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { gzipSync, gunzipSync } = require('zlib');
const schedule = require('node-schedule');
const config = require('../config');
const log = require('../logger')('S3Backup');
const auditLog = require('./audit-log');
const { getAllStoreData, restoreFromBackup } = require('./storage');

const BACKUP_PREFIX = 'redis-backups/';

let _s3 = null;
let _lastBackup = null;
let _lastError = null;
let _backupCount = 0;

/**
 * Initialize the S3 client and schedule automatic backups.
 * Call once from index.js after Redis storage is ready.
 */
function initS3Backup() {
  if (!config.s3Endpoint || !config.s3Bucket || !config.s3AccessKeyId) {
    log.info('S3 backup disabled — bucket credentials not configured');
    return;
  }

  _s3 = new S3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    credentials: {
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
    },
    forcePathStyle: true, // Required for Railway/MinIO-style endpoints
  });

  log.info(`S3 backup enabled — bucket: ${config.s3Bucket}`);

  // Schedule daily backup at 3 AM Eastern
  schedule.scheduleJob(
    { rule: '0 3 * * *', tz: 'America/New_York' },
    () => {
      runBackup().catch(err => log.error(`Scheduled backup failed: ${err.message}`));
    }
  );

  // Also backup every 6 hours as extra safety
  schedule.scheduleJob(
    { rule: '0 */6 * * *', tz: 'America/New_York' },
    () => {
      runBackup().catch(err => log.error(`Scheduled backup failed: ${err.message}`));
    }
  );

  // Run an initial backup 60s after boot (let everything stabilize)
  setTimeout(() => {
    runBackup().catch(err => log.error(`Initial backup failed: ${err.message}`));
  }, 60_000);

  log.info('Backup schedule: every 6 hours + 3 AM daily + 60s after boot');
}

/**
 * Run a backup: snapshot all Redis stores, compress, upload to S3.
 */
async function runBackup() {
  if (!_s3) throw new Error('S3 client not initialized');

  const startMs = Date.now();
  const snapshot = getAllStoreData();
  const storeCount = Object.keys(snapshot).length;

  if (storeCount === 0) {
    log.warn('No store data to back up');
    return;
  }

  const json = JSON.stringify(snapshot, null, 2);
  const compressed = gzipSync(Buffer.from(json));
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const key = `${BACKUP_PREFIX}backup-${timestamp}.json.gz`;

  await _s3.send(new PutObjectCommand({
    Bucket: config.s3Bucket,
    Key: key,
    Body: compressed,
    ContentType: 'application/gzip',
    Metadata: {
      stores: String(storeCount),
      uncompressedBytes: String(json.length),
    },
  }));

  const durationMs = Date.now() - startMs;
  _lastBackup = { timestamp: new Date().toISOString(), key, stores: storeCount, bytes: compressed.length, durationMs };
  _lastError = null;
  _backupCount++;

  log.info(`Backup complete: ${storeCount} stores, ${(compressed.length / 1024).toFixed(1)} KB compressed, ${durationMs}ms → ${key}`);
  auditLog.log('backup', `S3 backup: ${storeCount} stores, ${(compressed.length / 1024).toFixed(1)} KB`, { key, durationMs });

  // Clean up old backups
  await cleanupOldBackups().catch(err => log.warn(`Backup cleanup failed: ${err.message}`));
}

/**
 * List all backups in the bucket.
 */
async function listBackups() {
  if (!_s3) return [];

  const result = await _s3.send(new ListObjectsV2Command({
    Bucket: config.s3Bucket,
    Prefix: BACKUP_PREFIX,
  }));

  return (result.Contents || [])
    .filter(obj => obj.Key.endsWith('.json.gz'))
    .sort((a, b) => b.LastModified - a.LastModified)
    .map(obj => ({
      key: obj.Key,
      size: obj.Size,
      lastModified: obj.LastModified.toISOString(),
    }));
}

/**
 * Download and restore the most recent backup (or a specific key).
 */
async function restoreLatest(specificKey) {
  if (!_s3) throw new Error('S3 client not initialized');

  let key = specificKey;
  if (!key) {
    const backups = await listBackups();
    if (backups.length === 0) throw new Error('No backups found');
    key = backups[0].key;
  }

  log.info(`Restoring from backup: ${key}`);

  const result = await _s3.send(new GetObjectCommand({
    Bucket: config.s3Bucket,
    Key: key,
  }));

  const chunks = [];
  for await (const chunk of result.Body) {
    chunks.push(chunk);
  }
  const compressed = Buffer.concat(chunks);
  const json = gunzipSync(compressed).toString('utf-8');
  const snapshot = JSON.parse(json);

  await restoreFromBackup(snapshot);

  log.info(`Restored ${Object.keys(snapshot).length} stores from ${key}`);
  auditLog.log('backup', `S3 restore: ${Object.keys(snapshot).length} stores from ${key}`);

  return { key, stores: Object.keys(snapshot).length };
}

/**
 * Delete backups older than retention period.
 */
async function cleanupOldBackups() {
  const backups = await listBackups();
  const cutoff = Date.now() - config.backupRetentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  for (const backup of backups) {
    if (new Date(backup.lastModified).getTime() < cutoff) {
      await _s3.send(new DeleteObjectCommand({
        Bucket: config.s3Bucket,
        Key: backup.key,
      }));
      deleted++;
    }
  }

  if (deleted > 0) {
    log.info(`Cleaned up ${deleted} old backups (older than ${config.backupRetentionDays} days)`);
  }
}

/**
 * Get backup status for the dashboard.
 */
function getStatus() {
  return {
    enabled: !!_s3,
    bucket: config.s3Bucket || null,
    lastBackup: _lastBackup,
    lastError: _lastError,
    totalBackups: _backupCount,
    retentionDays: config.backupRetentionDays,
  };
}

module.exports = { initS3Backup, runBackup, listBackups, restoreLatest, getStatus };
