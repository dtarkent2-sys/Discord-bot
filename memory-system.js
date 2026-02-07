const Database = require('better-sqlite3');
const path = require('path');

class MemorySystem {
  constructor(dbPath = './memory.db') {
    this.db = new Database(path.resolve(dbPath));
    this._initTables();
  }

  _initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        sentiment TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        message_count INTEGER DEFAULT 0,
        avg_sentiment REAL DEFAULT 0,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_user
        ON conversations(user_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_conversations_channel
        ON conversations(channel_id, created_at DESC);
    `);
  }

  addMessage(userId, channelId, role, content, sentiment = null) {
    const stmt = this.db.prepare(`
      INSERT INTO conversations (user_id, channel_id, role, content, sentiment)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(userId, channelId, role, content, sentiment);
  }

  getRecentConversation(channelId, limit = 10) {
    const stmt = this.db.prepare(`
      SELECT role, content, user_id, created_at
      FROM conversations
      WHERE channel_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(channelId, limit).reverse();
  }

  getUserHistory(userId, limit = 20) {
    const stmt = this.db.prepare(`
      SELECT role, content, channel_id, created_at
      FROM conversations
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(userId, limit).reverse();
  }

  updateUserProfile(userId, username, sentiment = null) {
    const existing = this.db.prepare(
      'SELECT * FROM user_profiles WHERE user_id = ?'
    ).get(userId);

    if (existing) {
      const newCount = existing.message_count + 1;
      const newSentiment = sentiment !== null
        ? (existing.avg_sentiment * existing.message_count + sentiment) / newCount
        : existing.avg_sentiment;

      this.db.prepare(`
        UPDATE user_profiles
        SET username = ?, message_count = ?, avg_sentiment = ?, last_seen = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).run(username, newCount, newSentiment, userId);
    } else {
      this.db.prepare(`
        INSERT INTO user_profiles (user_id, username, message_count, avg_sentiment)
        VALUES (?, ?, 1, ?)
      `).run(userId, username, sentiment || 0);
    }
  }

  getUserProfile(userId) {
    return this.db.prepare(
      'SELECT * FROM user_profiles WHERE user_id = ?'
    ).get(userId);
  }

  getActiveUsers(hours = 24) {
    return this.db.prepare(`
      SELECT * FROM user_profiles
      WHERE last_seen > datetime('now', ?)
      ORDER BY last_seen DESC
    `).all(`-${hours} hours`);
  }

  buildContextString(channelId, limit = 5) {
    const messages = this.getRecentConversation(channelId, limit);
    return messages
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');
  }

  close() {
    this.db.close();
  }
}

module.exports = MemorySystem;
