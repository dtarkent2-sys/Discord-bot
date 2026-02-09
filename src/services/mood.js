/**
 * mood-engine.js — Sprocket's emotional state.
 *
 * Mood shifts based on market conditions and portfolio P&L.
 * Doesn't change decisions — only flavors response tone.
 * Persists across restarts via storage.
 */

const Storage = require('./storage');

const MOODS = {
  EUPHORIC:             { label: 'Euphoric',              threshold: 5 },
  OPTIMISTICALLY_BULL:  { label: 'Optimistically Bullish', threshold: 2 },
  CONTENT:              { label: 'Content',                threshold: 0.5 },
  NEUTRAL:              { label: 'Neutral',                threshold: -0.5 },
  CAUTIOUS:             { label: 'Cautious',               threshold: -2 },
  MEASUREDLY_CONCERNED: { label: 'Measuredly Concerned',   threshold: -5 },
  DISTRESSED:           { label: 'Distressed',             threshold: -Infinity },
};

class MoodEngine {
  constructor() {
    this.store = new Storage('mood.json');
    const saved = this.store.get('state', null);
    this.state = saved || {
      baseline: 50,
      score: 0,
      currentMood: 'Neutral',
      lastUpdate: null,
      lastPortfolioChange: 0,
      history: [],
    };
  }

  // Get current mood
  getMood() {
    return this.state.currentMood;
  }

  // Update mood based on portfolio/market P&L percentage change
  updateFromPnL(changePercent) {
    this.state.lastPortfolioChange = changePercent;
    this.state.score = this._calculateScore(changePercent);
    this.state.currentMood = this._scoreToMood(this.state.score);
    this.state.lastUpdate = new Date().toISOString();

    // Track history (last 50 entries)
    this.state.history.push({
      score: this.state.score,
      mood: this.state.currentMood,
      pnl: changePercent,
      timestamp: this.state.lastUpdate,
    });
    if (this.state.history.length > 50) {
      this.state.history = this.state.history.slice(-50);
    }

    this._save();
    return this.state.currentMood;
  }

  // Update mood from market sentiment signal (e.g. VIX spike, broad sell-off)
  updateFromMarketSignal(signal) {
    const nudge = {
      'bull': 1.5,
      'bear': -1.5,
      'volatile': -1,
      'calm': 0.5,
      'crash': -4,
      'rally': 3,
    }[signal] || 0;

    this.state.score = Math.max(-10, Math.min(10, this.state.score + nudge));
    this.state.currentMood = this._scoreToMood(this.state.score);
    this.state.lastUpdate = new Date().toISOString();
    this._save();
    return this.state.currentMood;
  }

  // Decay mood toward neutral over time (call periodically)
  decay() {
    if (this.state.score > 0) {
      this.state.score = Math.max(0, this.state.score - 0.3);
    } else if (this.state.score < 0) {
      this.state.score = Math.min(0, this.state.score + 0.3);
    }
    this.state.currentMood = this._scoreToMood(this.state.score);
    this._save();
  }

  // Build mood context string for the AI system prompt
  buildMoodContext() {
    return `Your mood right now: ${this.state.currentMood}. The market's been ${this.state.lastPortfolioChange >= 0 ? 'treating you well' : 'rough'} lately (${this.state.lastPortfolioChange}%). Let this naturally affect your vibe — don't mention it directly, just let it come through.`;
  }

  getSummary() {
    return {
      mood: this.state.currentMood,
      score: Math.round(this.state.score * 10) / 10,
      lastPnL: this.state.lastPortfolioChange,
      lastUpdate: this.state.lastUpdate,
    };
  }

  _calculateScore(changePercent) {
    // Clamp between -10 and 10, with momentum from previous score
    const raw = changePercent * 1.5;
    const blended = (this.state.score * 0.3) + (raw * 0.7);
    return Math.max(-10, Math.min(10, blended));
  }

  _scoreToMood(score) {
    for (const mood of Object.values(MOODS)) {
      if (score >= mood.threshold) {
        return mood.label;
      }
    }
    return 'Neutral';
  }

  _save() {
    this.store.set('state', this.state);
  }
}

module.exports = new MoodEngine();
