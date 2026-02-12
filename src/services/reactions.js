const Storage = require('./storage');

class ReactionLearningService {
  constructor() {
    this.store = new Storage('reactions.json');
  }

  // Record feedback on a bot response
  recordFeedback(userId, messageContent, responseContent, isPositive) {
    const feedback = this.store.get('feedback', []);

    feedback.push({
      userId,
      userMessage: messageContent.slice(0, 200),
      botResponse: responseContent.slice(0, 200),
      positive: isPositive,
      timestamp: new Date().toISOString(),
    });

    // Keep last 500 feedback entries
    if (feedback.length > 500) {
      feedback.splice(0, feedback.length - 500);
    }

    this.store.set('feedback', feedback);

    // Update user-specific scores
    const userStats = this.store.get(`user_${userId}`, { thumbsUp: 0, thumbsDown: 0 });
    if (isPositive) {
      userStats.thumbsUp++;
    } else {
      userStats.thumbsDown++;
    }
    this.store.set(`user_${userId}`, userStats);

    // Update pattern tracking
    this._updatePatterns(messageContent, isPositive);
  }

  // Get successful patterns for building better responses
  getPatternInsights() {
    const patterns = this.store.get('patterns', {});
    const successful = [];

    for (const [topic, data] of Object.entries(patterns)) {
      const ratio = data.positive / (data.positive + data.negative || 1);
      if (ratio > 0.6 && data.positive >= 2) {
        successful.push({ topic, ratio: Math.round(ratio * 100), count: data.positive + data.negative });
      }
    }

    return successful.sort((a, b) => b.ratio - a.ratio).slice(0, 10);
  }

  // Get feedback stats
  getStats() {
    const feedback = this.store.get('feedback', []);
    const positive = feedback.filter(f => f.positive).length;
    const negative = feedback.filter(f => !f.positive).length;

    return {
      total: feedback.length,
      positive,
      negative,
      ratio: feedback.length > 0 ? Math.round((positive / feedback.length) * 100) : 0,
      patterns: this.getPatternInsights(),
    };
  }

  // Get recent negative feedback (for the AI to learn what NOT to do)
  getRecentNegative(count = 3) {
    const feedback = this.store.get('feedback', []);
    return feedback
      .filter(f => !f.positive)
      .slice(-count);
  }

  // Get stats for a specific user
  getUserStats(userId) {
    return this.store.get(`user_${userId}`, { thumbsUp: 0, thumbsDown: 0 });
  }

  _updatePatterns(message, isPositive) {
    const patterns = this.store.get('patterns', {});

    // Extract keywords/topics from the message
    const topics = this._extractTopics(message);
    for (const topic of topics) {
      if (!patterns[topic]) {
        patterns[topic] = { positive: 0, negative: 0 };
      }
      if (isPositive) {
        patterns[topic].positive++;
      } else {
        patterns[topic].negative++;
      }
    }

    this.store.set('patterns', patterns);
  }

  _extractTopics(message) {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'it', 'this', 'that', 'i', 'me',
      'my', 'we', 'you', 'your', 'he', 'she', 'they', 'what', 'how', 'why',
      'when', 'where', 'who', 'which', 'and', 'or', 'but', 'not', 'so',
    ]);

    return message
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w))
      .slice(0, 5);
  }
}

module.exports = new ReactionLearningService();
