const Sentiment = require('sentiment');
const Storage = require('./storage');

class SentimentService {
  constructor() {
    this.analyzer = new Sentiment();
    this.store = new Storage('sentiment.json');
  }

  // Analyze a message and return sentiment info
  analyze(text) {
    const result = this.analyzer.analyze(text);
    return {
      score: result.score,           // overall score (negative = bad, positive = good)
      comparative: result.comparative, // normalized score per word
      positive: result.positive,      // positive words found
      negative: result.negative,      // negative words found
      label: this._scoreToLabel(result.score),
    };
  }

  // Track sentiment for a user over time
  track(userId, text) {
    const result = this.analyze(text);
    const userData = this.store.get(userId, { history: [], average: 0 });

    userData.history.push({
      score: result.score,
      timestamp: new Date().toISOString(),
    });

    // Keep last 100 entries
    if (userData.history.length > 100) {
      userData.history = userData.history.slice(-100);
    }

    // Calculate rolling average
    const recent = userData.history.slice(-20);
    userData.average = recent.reduce((sum, h) => sum + h.score, 0) / recent.length;

    this.store.set(userId, userData);
    return result;
  }

  // Get sentiment trend for a user
  getTrend(userId) {
    const userData = this.store.get(userId, { history: [], average: 0 });
    if (userData.history.length < 2) return 'neutral';

    const recent = userData.history.slice(-10);
    const older = userData.history.slice(-20, -10);

    if (older.length === 0) return this._scoreToLabel(userData.average);

    const recentAvg = recent.reduce((s, h) => s + h.score, 0) / recent.length;
    const olderAvg = older.reduce((s, h) => s + h.score, 0) / older.length;

    if (recentAvg > olderAvg + 1) return 'improving';
    if (recentAvg < olderAvg - 1) return 'declining';
    return this._scoreToLabel(userData.average);
  }

  // Get stats for a user
  getStats(userId) {
    const userData = this.store.get(userId, { history: [], average: 0 });
    return {
      totalMessages: userData.history.length,
      average: Math.round(userData.average * 100) / 100,
      trend: this.getTrend(userId),
      label: this._scoreToLabel(userData.average),
    };
  }

  _scoreToLabel(score) {
    if (score <= -3) return 'very negative';
    if (score < 0) return 'slightly negative';
    if (score === 0) return 'neutral';
    if (score <= 3) return 'slightly positive';
    return 'very positive';
  }
}

module.exports = new SentimentService();
