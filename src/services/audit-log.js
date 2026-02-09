/**
 * Audit Log — Persistent structured logging for autonomous actions.
 *
 * Logs every autonomous action, trade, Ollama prompt/response, and safety event
 * to rotating JSON-lines files in data/logs/. Provides queryable in-memory buffer
 * for the dashboard and Discord commands.
 *
 * Files:
 *   data/logs/audit-YYYY-MM-DD.jsonl   — one JSON object per line
 *   data/logs/ollama-YYYY-MM-DD.jsonl  — full Ollama prompt/response pairs
 *   data/logs/postmortem-<timestamp>.json — emergency stop post-mortem snapshots
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const LOG_DIR = path.join(config.dataDir, 'logs');
const MAX_MEMORY_ENTRIES = 500;
const MAX_LOG_FILES = 14; // keep 2 weeks of logs

class AuditLog {
  constructor() {
    this._buffer = [];  // in-memory ring buffer for dashboard
    this._ensureDir();
    this._cleanOldFiles();
  }

  _ensureDir() {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  }

  _today() {
    return new Date().toISOString().slice(0, 10);
  }

  _auditPath() {
    return path.join(LOG_DIR, `audit-${this._today()}.jsonl`);
  }

  _ollamaPath() {
    return path.join(LOG_DIR, `ollama-${this._today()}.jsonl`);
  }

  /**
   * Log a general autonomous action.
   * @param {string} category - 'trade'|'blocked'|'cycle'|'scan'|'emergency'|'mood'|'schedule'|'error'
   * @param {string} message - Human-readable description
   * @param {object} [meta] - Additional structured data
   */
  log(category, message, meta = {}) {
    const entry = {
      ts: new Date().toISOString(),
      cat: category,
      msg: message,
      ...meta,
    };

    // In-memory buffer
    this._buffer.push(entry);
    if (this._buffer.length > MAX_MEMORY_ENTRIES) {
      this._buffer.splice(0, this._buffer.length - MAX_MEMORY_ENTRIES);
    }

    // File append (non-blocking, fire-and-forget)
    try {
      fs.appendFileSync(this._auditPath(), JSON.stringify(entry) + '\n');
    } catch (err) {
      console.error('[AuditLog] Write failed:', err.message);
    }

    // Also mirror to console with prefix
    console.log(`[Audit:${category}] ${message}`);
  }

  /**
   * Log an Ollama prompt/response pair for debugging AI decisions.
   * @param {string} symbol - Ticker being evaluated (or 'chat' for general)
   * @param {string} prompt - Full prompt sent to Ollama
   * @param {string} response - Full response from Ollama
   * @param {number} durationMs - How long the call took
   */
  logOllama(symbol, prompt, response, durationMs) {
    const entry = {
      ts: new Date().toISOString(),
      symbol,
      prompt_length: prompt.length,
      response_length: (response || '').length,
      duration_ms: durationMs,
      prompt: prompt.slice(0, 5000), // cap at 5KB to avoid huge files
      response: (response || '').slice(0, 5000),
    };

    try {
      fs.appendFileSync(this._ollamaPath(), JSON.stringify(entry) + '\n');
    } catch (err) {
      console.error('[AuditLog] Ollama log write failed:', err.message);
    }
  }

  /**
   * Write a post-mortem snapshot on emergency stop.
   * Captures full system state for debugging.
   * @param {object} state - Full system state snapshot
   * @returns {string} Path to the post-mortem file
   */
  writePostMortem(state) {
    const filename = `postmortem-${Date.now()}.json`;
    const filepath = path.join(LOG_DIR, filename);

    const postmortem = {
      timestamp: new Date().toISOString(),
      trigger: 'emergency_stop',
      ...state,
      recentAuditEntries: this._buffer.slice(-50),
    };

    try {
      fs.writeFileSync(filepath, JSON.stringify(postmortem, null, 2));
      console.log(`[AuditLog] Post-mortem written: ${filepath}`);
    } catch (err) {
      console.error('[AuditLog] Post-mortem write failed:', err.message);
    }

    return filepath;
  }

  /**
   * Get recent audit entries for dashboard/Discord display.
   * @param {number} [count=50] - Number of entries to return
   * @param {string} [category] - Optional filter by category
   * @returns {Array<object>}
   */
  getRecent(count = 50, category = null) {
    let entries = this._buffer;
    if (category) {
      entries = entries.filter(e => e.cat === category);
    }
    return entries.slice(-count);
  }

  /**
   * Get summary stats from the in-memory buffer.
   */
  getStats() {
    const counts = {};
    for (const entry of this._buffer) {
      counts[entry.cat] = (counts[entry.cat] || 0) + 1;
    }
    return {
      total: this._buffer.length,
      byCategory: counts,
      logDir: LOG_DIR,
      today: this._today(),
    };
  }

  /**
   * Clean log files older than MAX_LOG_FILES days.
   */
  _cleanOldFiles() {
    try {
      const files = fs.readdirSync(LOG_DIR)
        .filter(f => f.startsWith('audit-') || f.startsWith('ollama-'))
        .sort();

      // Group by prefix
      for (const prefix of ['audit-', 'ollama-']) {
        const prefixFiles = files.filter(f => f.startsWith(prefix));
        if (prefixFiles.length > MAX_LOG_FILES) {
          const toDelete = prefixFiles.slice(0, prefixFiles.length - MAX_LOG_FILES);
          for (const file of toDelete) {
            fs.unlinkSync(path.join(LOG_DIR, file));
            console.log(`[AuditLog] Cleaned old log: ${file}`);
          }
        }
      }
    } catch {
      // Ignore cleanup errors on startup
    }
  }
}

module.exports = new AuditLog();
