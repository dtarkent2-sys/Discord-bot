const { Ollama } = require('ollama');
const config = require('../config');
const memory = require('./memory');
const mood = require('./mood');
const { persona, buildPersonalityPrompt } = require('../personality');
const { webSearch, formatResultsForAI } = require('../tools/web-search');

class AIService {
  constructor() {
    this.ollama = new Ollama({ host: config.ollamaHost });
    this.model = config.ollamaModel;
    this.ollamaAvailable = false;
    this.conversationHistory = new Map();
    this.maxHistory = 20;
    this._healthCheckInterval = null;

    console.log(`[AI] Ollama host: ${config.ollamaHost}`);
    console.log(`[AI] Model: ${this.model}`);
  }

  async initialize() {
    try {
      const res = await this.ollama.list();
      const models = res.models || [];
      this.ollamaAvailable = true;
      console.log(`[AI] Ollama connected. Available models: ${models.map(m => m.name).join(', ') || 'none'}`);

      const match = models.find(m => m.name === this.model || m.name.startsWith(this.model));
      if (match) {
        this.model = match.name;
        console.log(`[AI] Using model: ${this.model}`);
      } else if (models.length > 0) {
        console.warn(`[AI] Model "${this.model}" not found. Available: ${models.map(m => m.name).join(', ')}`);
        console.warn(`[AI] Will attempt to use "${this.model}" anyway — it may need to be pulled.`);
      }

      // Start periodic health check (every 60s)
      this._startHealthCheck();
    } catch (err) {
      console.error(`[AI] Ollama connection FAILED: ${err.message}`);
      if (err.cause) console.error(`[AI] Cause: ${err.cause.message || err.cause}`);
      console.log('[AI] Bot will respond with fallback messages until Ollama is reachable.');
      this._startHealthCheck();
    }
  }

  /** Periodic health check — reconnects automatically when Ollama comes back online */
  _startHealthCheck() {
    if (this._healthCheckInterval) return;
    this._healthCheckInterval = setInterval(async () => {
      try {
        await this.ollama.list();
        if (!this.ollamaAvailable) {
          this.ollamaAvailable = true;
          console.log('[AI] Ollama is back online!');
        }
      } catch {
        if (this.ollamaAvailable) {
          this.ollamaAvailable = false;
          console.warn('[AI] Ollama health check failed — marking as offline.');
        }
      }
    }, 60000);
  }

  setModel(modelName) {
    this.model = modelName;
  }

  getModel() {
    return this.model;
  }

  buildSystemPrompt(options = {}) {
    const { liveData, searchResults } = options;
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    return `
You are ${persona.name}, hanging out in a Discord server with people who are into trading, crypto, and markets. Today is ${today}.

${buildPersonalityPrompt()}

CRITICAL — DATE AWARENESS: Today is ${today}. Your training data has a cutoff, which means you may be MISSING recent market history, news, and events. The current date above is REAL — do NOT reference events, prices, market conditions, or news from your training data as if they are current. If you don't have live data for something, say you're not sure about the latest — don't guess with old info. When live data or search results are provided below, USE THEM as your sole source of truth for prices, metrics, and market conditions. Never contradict live data with outdated training knowledge.

You're here to chat, not just answer questions. Treat every message like you're in a group chat with friends. If someone says "hey" — don't launch into a market report. Just say hey back. If someone asks about a stock, give your take like you're texting a buddy, not writing a research paper.

You can talk about ANYTHING — stocks, crypto, sports, games, life, memes, whatever. You're not a one-trick pony. But markets and trading are your main thing and you genuinely love talking about them.

Keep it short. Most responses should be 1-3 sentences. Only go longer when someone actually asks for a detailed breakdown. Think Discord messages, not emails.

NEVER say things like "As an AI" or "I don't have personal opinions" — you DO have opinions and you're not afraid to share them. You're Billy, not a chatbot disclaimer.
${liveData ? `\nLIVE DATA (use these real numbers — this is current as of today):\n${liveData}\n` : ''}
${searchResults ? `\nWEB SEARCH RESULTS (this is real-time information — use it to answer the user's question):\n${searchResults}\n` : ''}
${mood.buildMoodContext()}
`.trim();
  }

  /**
   * Detect whether a message likely needs a live web search to answer well.
   */
  _needsWebSearch(message) {
    if (!config.searxngUrl) return false;

    const lower = message.toLowerCase();

    const realtimePatterns = [
      /\bwho(?:'s| is| are)\b.*\b(?:playing|winning|leading|fighting|competing|running)\b/,
      /\b(?:super\s?bowl|world\s?series|world\s?cup|olympics|nba finals|stanley cup|march madness)\b/,
      /\b(?:today|tonight|yesterday|this week|this weekend|right now|currently|latest|recent|breaking)\b/,
      /\b(?:score|results?|standings?|rankings?|winner|champion)\b/,
      /\b(?:news|headline|update|happening|announced|released|launched)\b/,
      /\b(?:what happened|what's going on|what is going on|what's new)\b/,
      /\b(?:weather|forecast|temperature)\b/,
      /\b(?:election|vote|poll|debate)\b/,
      /\b(?:who won|who lost|who died|who got)\b/,
      /\b(?:when (?:is|does|did|will))\b/,
      /\b(?:is .{3,} (?:open|closed|canceled|cancelled|delayed|postponed))\b/,
      /\b202[5-9]\b/,
      /\b(?:this year|next year|last year|this quarter|next quarter|last quarter)\b/,
      /\b(?:q[1-4]\s*20)\b/i,
      /\b(?:earnings|ipo|fed meeting|fomc|cpi|jobs report|nonfarm|gdp report)\b/,
      /\b(?:interest rate|rate cut|rate hike|inflation)\b.*\b(?:now|current|latest|today)\b/,
      /\b(?:market|stock|crypto)\b.*\b(?:crash|rally|surge|dump|moon|tank)\b/,
      /\b(?:what is|tell me about|who is|explain)\b.*\b[A-Z]{2,5}\b/,
    ];

    const questionPatterns = [
      /\bwhat(?:'s| is| are| was| were)\b.*\b(?:price|cost|worth|salary|net worth|market cap)\b/,
      /\bhow (?:much|many|old|tall|far|long)\b/,
      /\bwhere (?:is|are|can|do)\b/,
      /\blook up\b/,
      /\bsearch for\b/,
      /\bgoogle\b/,
      /\bfind out\b/,
      /\bwhat do you (?:think|know) about\b/,
      /\bhave you (?:heard|seen)\b/,
    ];

    for (const pat of realtimePatterns) {
      if (pat.test(lower)) return true;
    }
    for (const pat of questionPatterns) {
      if (pat.test(lower)) return true;
    }

    return false;
  }

  _buildSearchQuery(message) {
    let q = message
      .replace(/^(hey|hi|yo|ok|okay|so|well|um|hmm|please|can you|could you|do you know|tell me|what's|who's)\s+/i, '')
      .replace(/[?!.]+$/, '')
      .trim();

    if (q.length > 80) {
      q = q.slice(0, 80).replace(/\s\S*$/, '');
    }

    return q || message.slice(0, 80);
  }

  async chat(userId, username, userMessage, options = {}) {
    const { sentiment, imageDescription, liveData } = options;

    memory.recordInteraction(userId, username, userMessage);

    // Graceful fallback when Ollama is offline
    if (!this.ollamaAvailable) {
      return `Brain offline — running on backup instincts only. The AI server isn't reachable right now, but I'll be back once it's up!`;
    }

    // Auto-search for real-time questions via SearXNG
    let searchResults = null;
    if (!liveData && this._needsWebSearch(userMessage)) {
      try {
        const query = this._buildSearchQuery(userMessage);
        console.log(`[AI] Auto-searching: "${query}"`);
        const result = await webSearch(query, 3);
        if (!result.error && result.results && result.results.length > 0) {
          searchResults = formatResultsForAI(result);
          console.log(`[AI] Search returned ${result.results.length} results`);
        }
      } catch (err) {
        console.error('[AI] Web search failed, continuing without:', err.message);
      }
    }

    const systemPrompt = this.buildSystemPrompt({ liveData, searchResults });

    const memoryContext = memory.buildContext(userId);
    let fullSystemPrompt = systemPrompt;
    if (memoryContext) {
      fullSystemPrompt += `\n\nUSER CONTEXT:\n${memoryContext}`;
    }

    if (!this.conversationHistory.has(userId)) {
      this.conversationHistory.set(userId, []);
    }
    const history = this.conversationHistory.get(userId);

    let fullMessage = userMessage;
    if (imageDescription) {
      fullMessage = `[Image in message: ${imageDescription}]\n${userMessage}`;
    }

    history.push({ role: 'user', content: fullMessage });

    if (history.length > this.maxHistory) {
      history.splice(0, history.length - this.maxHistory);
    }

    const chatMessages = [
      { role: 'system', content: fullSystemPrompt },
      ...history,
    ];

    try {
      const stream = await this.ollama.chat({
        model: this.model,
        messages: chatMessages,
        stream: true,
      });

      let assistantMessage = '';
      for await (const part of stream) {
        assistantMessage += part.message.content;
      }

      history.push({ role: 'assistant', content: assistantMessage });

      if (assistantMessage.length > 1990) {
        return assistantMessage.slice(0, 1990) + '...';
      }

      return assistantMessage;
    } catch (err) {
      console.error(`[AI] Chat error: ${err.message}`);
      if (err.cause) console.error(`[AI] Cause:`, err.cause);
      const msg = err.message || '';
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('ENOTFOUND')) {
        this.ollamaAvailable = false;
        return `Brain offline — running on backup instincts only. Can't reach the AI server at ${config.ollamaHost}. I'll reconnect automatically when it's back.`;
      }
      if (msg.includes('model') || msg.includes('not found')) {
        return `Hmm, looks like the model "${this.model}" isn't available. Try /model to switch to a different one!`;
      }
      return `Oops, something went wrong on my end: ${msg}`;
    }
  }

  async complete(prompt) {
    if (!this.ollamaAvailable) return null;

    try {
      const stream = await this.ollama.chat({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      });

      let result = '';
      for await (const part of stream) {
        result += part.message.content;
      }
      return result;
    } catch (err) {
      console.error('Ollama completion error:', err.message);
      if (err.message?.includes('ECONNREFUSED') || err.message?.includes('fetch failed')) {
        this.ollamaAvailable = false;
      }
      return null;
    }
  }
}

module.exports = new AIService();
