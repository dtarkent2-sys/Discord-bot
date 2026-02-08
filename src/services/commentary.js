/**
 * commentary.js — AI-powered personality inflection.
 *
 * Instead of canned strings, uses Ollama to phrase data in Sprocket's voice.
 * Falls back to persona speech patterns if AI is unavailable.
 */

const { persona, pick } = require('../personality');
const mood = require('./mood');

class CommentaryGenerator {
  constructor() {
    // Lazy-load ai to avoid circular dependency
    this._ai = null;
  }

  get ai() {
    if (!this._ai) {
      this._ai = require('./ai');
    }
    return this._ai;
  }

  /**
   * Generate a single line of in-character commentary about a data point.
   * Uses AI when available, falls back to speech patterns.
   *
   * @param {object} dataPoint - The data to comment on (e.g. { ticker: 'SPY', change: 1.2 })
   * @param {string} context - Situational context (e.g. 'pre-market briefing', 'sector update')
   * @returns {string} A single commentary line in Sprocket's voice
   */
  async generate(dataPoint, context) {
    try {
      const prompt = `You are ${persona.name}, ${persona.tone} Your quirks: ${persona.quirks.join('. ')}.
Your current mood: ${mood.getMood()}.
Context: ${context}.
Data: ${JSON.stringify(dataPoint)}.

Generate a single concise line of commentary (under 100 words) in your voice. Stay in character. Do not invent data — only reference what's in "Data" above. If data is missing, say so. Include "Not financial advice." at the end.`;

      const result = await this.ai.complete(prompt);
      if (result && result.length > 5 && result.length < 500) {
        return result.trim();
      }
    } catch (err) {
      console.warn('[Commentary] AI generation failed, using fallback:', err.message);
    }

    // Fallback: pick a mood-appropriate canned line
    return this._fallback(dataPoint, context);
  }

  /**
   * Generate commentary for a market move.
   */
  async marketMove(ticker, changePercent) {
    return this.generate(
      { ticker, changePercent: `${changePercent > 0 ? '+' : ''}${changePercent}%` },
      `${ticker} price movement update`
    );
  }

  /**
   * Generate a greeting/briefing opener.
   */
  async briefingOpener() {
    return this.generate(
      { mood: mood.getMood(), time: new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }) },
      'opening a market briefing'
    );
  }

  /**
   * Generate a reaction to unusual activity.
   */
  async unusualActivity(ticker, detail) {
    return this.generate(
      { ticker, activity: detail },
      'spotted unusual market activity'
    );
  }

  _fallback(dataPoint, context) {
    const moodLine = mood.getMoodLine();
    if (context.includes('briefing')) {
      return `${pick(persona.speechPatterns.greetings)} ${moodLine} Not financial advice.`;
    }
    if (dataPoint.changePercent) {
      const num = parseFloat(dataPoint.changePercent);
      if (num > 0) return `${pick(persona.speechPatterns.marketUp)} Not financial advice.`;
      if (num < 0) return `${pick(persona.speechPatterns.marketDown)} Not financial advice.`;
    }
    return `${moodLine} Not financial advice.`;
  }
}

module.exports = new CommentaryGenerator();
