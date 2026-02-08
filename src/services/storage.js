const fs = require('fs');
const path = require('path');
const config = require('../config');

// Ensure data directory exists
if (!fs.existsSync(config.dataDir)) {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

class Storage {
  constructor(filename) {
    this.filePath = path.join(config.dataDir, filename);
    this.data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      }
    } catch (err) {
      console.error(`Failed to load ${this.filePath}:`, err.message);
    }
    return {};
  }

  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error(`Failed to save ${this.filePath}:`, err.message);
    }
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

module.exports = Storage;
