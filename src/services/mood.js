const Storage = require("../storage");
const MOODS = {
  EUPHORIC: { label: "Euphoric", threshold: 5 },
  OPTIMISTICALLY_BULL: { label: "Optimistically Bullish", threshold: 2 },
  CONTENT: { label: "Content", threshold: 0.5 },
  NEUTRAL: { label: "Neutral", threshold: -0.5 },
  CAUTIOUS: { label: "Cautious", threshold: -2 },
  MEASUREDLY_CONCERNED: { label: "Measuredly Concerned", threshold: -5 },
  DISTRESSED: { label: "Distressed", threshold: -Infinity },
};
const PNL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SCORE_DELTA = 2.0;
class MoodEngine {
  constructor() {
    this.store = new Storage("mood.json");
    const saved = this.store.get("state", null);
    this.state = saved || {
      baseline: 50,
      score: 0,
      currentMood: "Neutral",
      lastUpdate: null,
      lastPortfolioChange: 0,
      history: [],
      pnlWindow: [],
    };
    if (!this.state.pnlWindow) this.state.pnlWindow = [];
  }
  getMood() {
    return this.state.currentMood;
  }
  updateFromPnL(changePercent) {
    const now = Date.now();
    this.state.lastPortfolioChange = changePercent;
    this.state.pnlWindow.push({
      pnl: changePercent,
      ts: now,
    });
    this.state.pnlWindow = this.state.pnlWindow.filter(
      (e) => now - e.ts < PNL_WINDOW_MS
    );
    this.state.score = this._calculateRollingScore();
    this.state.currentMood = this._scoreToMood(this.state.score);
    this.state.lastUpdate = new Date().toISOString();
    this.state.history.push({
      score: this.state.score,
      mood: this.state.currentMood,
      pnl: changePercent,
      rollingAvg: this._getRollingAvgPnL(),
      windowSize: this.state.pnlWindow.length,
      timestamp: this.state.lastUpdate,
    });
    if (this.state.history.length > 50) {
      this.state.history = this.state.history.slice(-50);
    }
    this._save();
    return this.state.currentMood;
  }
  updateFromMarketSignal(signal) {
    const nudge = {
      bull: 1,
      bear: -1,
      volatile: -0.5,
      calm: 0.3,
      crash: -2,
      rally: 1.5,
    }[signal] || 0;
    const clampedNudge = Math.max(
      -MAX_SCORE_DELTA,
      Math.min(MAX_SCORE_DELTA, nudge)
    );
    this.state.score = Math.max(
      -10,
      Math.min(10, this.state.score + clampedNudge)
    );
    this.state.currentMood = this._scoreToMood(this.state.score);
    this.state.lastUpdate = new Date().toISOString();
    this._save();
    return this.state.currentMood;
  }
  decay() {
    if (this.state.score > 0) {
      this.state.score = Math.max(0, this.state.score - 0.2);
    } else if (this.state.score < 0) {
      this.state.score = Math.min(0, this.state.score + 0.2);
    }
    this.state.currentMood = this._scoreToMood(this.state.score);
    this._save();
  }
  buildMoodContext() {
    const avgPnl = this._getRollingAvgPnL();
    const trend = avgPnl >= 0 ? "treating you well" : "rough";
    return `Your mood right now: ${this.state.currentMood}. The market's been ${trend} over the past week (rolling avg: ${avgPnl.toFixed(
      2
    )}%). Let this naturally affect your vibe — don't mention it directly, just let it come through.`;
  }
  getSummary() {
    return {
      mood: this.state.currentMood,
      score: Math.round(this.state.score * 10) / 10,
      lastPnL: this.state.lastPortfolioChange,
      rollingAvgPnL: this._getRollingAvgPnL(),
      windowSize: this.state.pnlWindow.length,
      lastUpdate: this.state.lastUpdate,
    };
  }
  _calculateRollingScore() {
    const window = this.state.pnlWindow;
    if (window.length === 0) return this.state.score;
    const now = Date.now();
    let weightedSum = 0;
    let weightTotal = 0;
    for (const entry of window) {
      const age = now - entry.ts;
      const weight = 1 - age / PNL_WINDOW_MS;
      const clampedWeight = Math.max(0.1, weight);
      weightedSum += entry.pnl * clampedWeight;
      weightTotal += clampedWeight;
    }
    const avgPnl = weightTotal > 0 ? weightedSum / weightTotal : 0;
    const rawScore = avgPnl * 1;
    const targetScore = Math.max(-10, Math.min(10, rawScore));
    const delta = targetScore - this.state.score;
    const clampedDelta = Math.max(-MAX_SCORE_DELTA, Math.min(MAX_SCORE_DELTA, delta));
    return Math.max(-10, Math.min(10, this.state.score + clampedDelta));
  }
  _getRollingAvgPnL() {
    const window = this.state.pnlWindow;
    if (window.length === 0) return 0;
    const sum = window.reduce((acc, e) => acc + e.pnl, 0);
    return sum / window.length;
  }
  _scoreToMood(score) {
    for (const mood of Object.values(MOODS)) {
      if (score >= mood.threshold) return mood.label;
    }
    return "Neutral";
  }
  _save() {
    this.store.set("state", this.state);
  }
}
module.exports = new MoodEngine();