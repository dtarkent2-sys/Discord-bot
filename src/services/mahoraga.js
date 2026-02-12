const { EventEmitter } = require('events');

class Storage {
  constructor(defaults) {
    this.defaults = defaults;
    this.data = this.load();
  }

  load() {
    const saved = localStorage.getItem(this.defaults.id || '__shark_state__');
    return saved ? JSON.parse(saved) : this.defaults;
  }

  set(key, value) {
    const current = { ...this.data, [key]: value };
    this.data = current;
    try {
      localStorage.setItem(this.defaults.id || '__shark_state__', JSON.stringify(current));
    } catch (e) {
      console.warn('[SHARK] Storage write failed', e.message);
    }
  }

  get(key, fallback = null) {
    const provided = key in this.data ? this.data[key] : false;
    return provided === false ? fallback : this.data[key];
  }

  setMultiple(overrides) {
    const current = { ...this.data, ...overrides };
    this.data = current;
    try {
      localStorage.setItem(this.defaults.id || '__shark_state__', JSON.stringify(current));
    } catch (e) {
      console.warn('[SHARK] Storage update failed', e.message);
    }
  }

  getAll() {
    return { ...this.data };
  }
}

class AuditLog {
  constructor() {
    this.logs = [];
    this.historyDir = './audit-history';
    this._init();
  }

  _init() {
    if (!this._fileExistsSync(this.historyDir)) {
      const fs = require('fs');
      fs.mkdirSync(this.historyDir, { recursive: true });
    }
  }

  log(type, message) {
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      message,
      user: process.env.USERS_EXPOSED || 'system',
    };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.length = 500;

    const logPath = `${this.historyDir}/log-${this._currentDate()}.json`;
    const fs = require('fs');
    try {
      const all = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      const index = all.findIndex(e => e.timestamp === entry.timestamp);
      if (index > -1) all[index] = entry;
      else all.push(entry);
      fs.writeFileSync(logPath, JSON.stringify(all, null, 2));
    } catch (e) {
      // Ignore on initial writes
    }
  }

  writePostMortem(state) {
    const fs = require('fs');
    const timestamp = new Date().toISOString();
    const path = `${this.historyDir}/postmortem-${timestamp.replace(/[:.]/g, '-')}.json`;
    const content = JSON.stringify(state, null, 2);
    fs.writeFileSync(path, content);
    return path;
  }

  logOllama(symbol, prompt, response, durationMs) {
    const fs = require('fs');
    const entry = {
      timestamp: new Date().toISOString(),
      symbol,
      prompt,
      response,
      durationMs
    };
    const path = `${this.historyDir}/ollama-${this._currentDate()}.json`;
    try {
      const all = JSON.parse(fs.readFileSync(path, 'utf8'));
      all.push(entry);
      fs.writeFileSync(path, JSON.stringify(all, null, 2));
    } catch (e) {
      fs.writeFileSync(path, JSON.stringify([entry], null, 2));
    }
  }

  _currentDate() {
    return new Date().toISOString().substring(0, 10);
  }

  _fileExistsSync(path) {
    const fs = require('fs');
    try {
      return fs.statSync(path).isDirectory();
    } catch {
      return false;
    }
  }
}

const auditLog = new AuditLog();

module.exports = { Storage, AuditLog };