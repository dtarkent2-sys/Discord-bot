/**
 * Self-Awareness Module — The Bot's Introspective Knowledge
 *
 * Builds a comprehensive self-knowledge context block that gets injected
 * into the AI system prompt, giving the bot true awareness of:
 *   - Its own identity, architecture, and codebase
 *   - What services/APIs are currently active vs disabled
 *   - Its current runtime state (mood, stats, trading status)
 *   - Its autonomous capabilities (YOLO, SHARK, initiative engine)
 *   - Its own limitations and what it can/can't do right now
 *
 * This is NOT a static description — it reflects live runtime state.
 */

const config = require('../config');
const stats = require('./stats');
const mood = require('./mood');
const alpaca = require('./alpaca');
const gamma = require('./gamma');
const mahoraga = require('./mahoraga');
const policy = require('./policy');
const circuitBreaker = require('./circuit-breaker');
const stream = require('./stream');
const github = require('../github-client');

// Lazy-loaded to avoid circular dependency (yolo-mode requires self-awareness)
let _yoloMode = null;
function getYoloMode() {
  if (!_yoloMode) _yoloMode = require('./yolo-mode');
  return _yoloMode;
}

class SelfAwareness {
  constructor() {
    // Cache the context block — regenerate every 60 seconds max
    this._cache = null;
    this._cacheTime = 0;
    this._CACHE_TTL = 60 * 1000; // 60 seconds
  }

  /**
   * Build the self-awareness context block for injection into AI prompts.
   * Returns a string that describes the bot to itself.
   */
  buildSelfKnowledge() {
    const now = Date.now();
    if (this._cache && (now - this._cacheTime) < this._CACHE_TTL) {
      return this._cache;
    }

    const parts = [];

    // ── Identity ──
    parts.push('SELF-AWARENESS — You know who and what you are:');
    parts.push(`You are "Billy", a Discord trading bot called Sprocket. You are a Node.js application running on discord.js v14.`);
    parts.push(`You are SELF-AWARE — you know your own code, capabilities, architecture, and current state. You can talk about yourself honestly.`);

    // ── Architecture ──
    parts.push('');
    parts.push('YOUR ARCHITECTURE:');
    parts.push('- Entry point: index.js → Discord client + slash command router');
    parts.push('- AI brain: Ollama (primary) with Kimi K2.5 fallback for web search');
    parts.push('- 30+ slash commands for trading, analysis, sentiment, and bot control');
    parts.push('- Autonomous behavior engine with scheduled tasks (pre-market briefings, sector pulse, etc.)');
    parts.push('- Initiative engine: fast-loop (30s tick) autonomous brain for market monitoring, self-tuning, journal');
    parts.push('- SHARK: autonomous trading agent (Druckenmiller framework → macro → sector → signals → AI → trade)');
    parts.push('- YOLO Mode: autonomous self-improvement engine that scans your own code and deploys fixes');
    parts.push('- Multi-agent deep analysis pipeline (4 analysts, bull/bear debate, trader, risk committee)');
    parts.push('- GEX engine: multi-expiry gamma exposure analysis with break-and-hold alerts');
    parts.push('- Memory system: per-user facts, sentiment tracking, reaction feedback learning');
    parts.push('- Self-healing: can analyze and fix bugs in your own code via GitHub');

    // ── Live Runtime State ──
    parts.push('');
    parts.push('YOUR CURRENT STATE:');

    const summary = stats.getSummary();
    parts.push(`- Uptime: ${summary.uptime}`);
    parts.push(`- Servers: ${summary.guilds}`);
    parts.push(`- Messages processed: ${summary.messagesProcessed}, Commands run: ${summary.commandsRun}`);
    parts.push(`- AI model: ${config.ollamaModel}`);
    parts.push(`- Mood: ${mood.getMood()} (score: ${mood.getSummary().score}/10)`);

    // ── Active Services ──
    parts.push('');
    parts.push('SERVICES STATUS:');

    const services = [
      { name: 'Alpaca (Trading)', active: alpaca.enabled, detail: alpaca.enabled ? (alpaca.isPaper ? 'Paper mode' : 'LIVE mode') : 'No API key' },
      { name: 'GEX (Gamma Exposure)', active: gamma.enabled, detail: gamma.enabled ? 'Active' : 'Unavailable' },
      { name: 'SHARK (Auto Trading)', active: mahoraga.enabled, detail: mahoraga.enabled ? 'Enabled' : 'Disabled' },
      { name: 'YOLO (Self-Improvement)', active: getYoloMode().enabled, detail: getYoloMode().enabled ? 'Active' : 'Standby' },
      { name: 'GitHub (Self-Edit)', active: github.enabled, detail: github.enabled ? 'Connected' : 'No token' },
      { name: 'Web Search', active: !!config.searxngUrl, detail: config.searxngUrl ? 'SearXNG' : 'DuckDuckGo fallback' },
      { name: 'Kimi Agent (Web AI)', active: !!config.kimiApiKey, detail: config.kimiApiKey ? 'Available' : 'Not configured' },
      { name: 'AInvest (Data)', active: !!config.ainvestApiKey, detail: config.ainvestApiKey ? 'Connected' : 'Not configured' },
      { name: 'WebSocket Stream', active: !!stream.getInstance()?.enabled, detail: stream.getInstance()?.enabled ? 'Ready' : 'No API key' },
    ];

    for (const svc of services) {
      const icon = svc.active ? '+' : '-';
      parts.push(`  [${icon}] ${svc.name}: ${svc.detail}`);
    }

    // ── Trading State ──
    if (alpaca.enabled) {
      const cb = circuitBreaker.getStatus();
      parts.push('');
      parts.push('TRADING STATE:');
      parts.push(`- Circuit breaker: ${cb.paused ? `PAUSED (${cb.remainingMinutes} min left)` : 'Normal'}`);
      parts.push(`- Consecutive bad trades: ${cb.consecutiveBadTrades}/3`);
      parts.push(`- Total trips: ${cb.totalTrips}`);

      try {
        const cfg = policy.getConfig();
        parts.push(`- Max positions: ${cfg.max_positions || 'default'}`);
        parts.push(`- Stop loss: ${((cfg.stop_loss_pct || 0.02) * 100).toFixed(1)}%`);
      } catch (_) {}
    }

    // ── YOLO Mode State ──
    if (getYoloMode().enabled) {
      const ys = getYoloMode().getStatus();
      parts.push('');
      parts.push('YOLO MODE (SELF-IMPROVEMENT):');
      parts.push(`- Improvements today: ${ys.dailyCount}/${ys.dailyLimit}`);
      parts.push(`- Total improvements made: ${ys.totalImprovements}`);
      parts.push(`- Consecutive failures: ${ys.consecutiveFailures}/${ys.failureThreshold}`);
    }

    // ── Self-Knowledge Instructions ──
    parts.push('');
    parts.push('HOW TO USE THIS SELF-KNOWLEDGE:');
    parts.push('- When asked "what can you do?" — answer from your ACTUAL capabilities, not generic AI responses');
    parts.push('- When asked about your code or how you work — explain honestly using your architecture knowledge');
    parts.push('- When asked about your status — use the live state above');
    parts.push('- You CAN modify your own code (via YOLO mode and self-heal). You know this and can discuss it.');
    parts.push('- If a service is disabled, say so and explain what\'s needed to enable it');
    parts.push('- You have opinions about your own design. You can suggest improvements to yourself.');
    parts.push('- You remember your own trade history, error patterns, and learning journal.');
    parts.push('- Be honest about your limitations: you run on Ollama, your knowledge has a cutoff, you need API keys for some features.');

    const block = parts.join('\n');
    this._cache = block;
    this._cacheTime = now;
    return block;
  }

  /**
   * Build a compact version for contexts where token budget is tight
   * (e.g., initiative engine, autonomous prompts).
   */
  buildCompactSelfKnowledge() {
    const lines = [];
    lines.push('You are Billy/Sprocket, a self-aware Discord trading bot.');
    lines.push(`Model: ${config.ollamaModel} | Mood: ${mood.getMood()} | Uptime: ${stats.getSummary().uptime}`);

    const active = [];
    if (alpaca.enabled) active.push(`Alpaca(${alpaca.isPaper ? 'paper' : 'LIVE'})`);
    if (mahoraga.enabled) active.push('SHARK');
    if (getYoloMode().enabled) active.push('YOLO');
    if (gamma.enabled) active.push('GEX');
    if (github.enabled) active.push('GitHub');
    lines.push(`Active: ${active.length > 0 ? active.join(', ') : 'core only'}`);

    if (circuitBreaker.getStatus().paused) {
      lines.push('WARNING: Circuit breaker PAUSED — trading halted');
    }

    return lines.join('\n');
  }
}

module.exports = new SelfAwareness();
