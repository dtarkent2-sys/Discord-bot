const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class MemorySystem {
  constructor(dbPath = './memory.db') {
    this.dbPath = path.resolve(dbPath);
    this.db = null;
    this.ready = false;
  }

  // Must be called before using any other method
  async initialize() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) return reject(err);
        this._initTables().then(() => {
          this.ready = true;
          console.log('[Memory] Database initialized.');
          resolve();
        }).catch(reject);
      });
    });
  }

  _initTables() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        sentiment TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        message_count INTEGER DEFAULT 0,
        avg_sentiment REAL DEFAULT 0,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_conversations_user
        ON conversations(user_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_conversations_channel
        ON conversations(channel_id, created_at DESC)`,
    ];

    return statements.reduce((chain, sql) => {
      return chain.then(() => this._run(sql));
    }, Promise.resolve());
  }

  // --- Promisified helpers ---

  _run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve(this);
      });
    });
  }

  _get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
  }

  _all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  }

  // --- Public API ---

  async addMessage(userId, channelId, role, content, sentiment = null) {
    return this._run(
      `INSERT INTO conversations (user_id, channel_id, role, content, sentiment)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, channelId, role, content, sentiment]
    );
  }

  async getRecentConversation(channelId, limit = 10) {
    const rows = await this._all(
      `SELECT role, content, user_id, created_at
       FROM conversations
       WHERE channel_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [channelId, limit]
    );
    return rows.reverse();
  }

  async getUserHistory(userId, limit = 20) {
    const rows = await this._all(
      `SELECT role, content, channel_id, created_at
       FROM conversations
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [userId, limit]
    );
    return rows.reverse();
  }

  async updateUserProfile(userId, username, sentiment = null) {
    const existing = await this._get(
      'SELECT * FROM user_profiles WHERE user_id = ?',
      [userId]
    );

    if (existing) {
      const newCount = existing.message_count + 1;
      const newSentiment = sentiment !== null
        ? (existing.avg_sentiment * existing.message_count + sentiment) / newCount
        : existing.avg_sentiment;

      return this._run(
        `UPDATE user_profiles
         SET username = ?, message_count = ?, avg_sentiment = ?, last_seen = CURRENT_TIMESTAMP
         WHERE user_id = ?`,
        [username, newCount, newSentiment, userId]
      );
    }

    return this._run(
      `INSERT INTO user_profiles (user_id, username, message_count, avg_sentiment)
       VALUES (?, ?, 1, ?)`,
      [userId, username, sentiment || 0]
    );
  }

  async getUserProfile(userId) {
    return this._get(
      'SELECT * FROM user_profiles WHERE user_id = ?',
      [userId]
    );
  }

  async getActiveUsers(hours = 24) {
    return this._all(
      `SELECT * FROM user_profiles
       WHERE last_seen > datetime('now', ?)
       ORDER BY last_seen DESC`,
      [`-${hours} hours`]
    );
  }

  async buildContextString(channelId, limit = 5) {
    const messages = await this.getRecentConversation(channelId, limit);
    return messages
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');
  }

  close() {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve();
      this.db.close((err) => {
        if (err) return reject(err);
        console.log('[Memory] Database closed.');
        resolve();
      });
    });
  }
}

module.exports = MemorySystem;
