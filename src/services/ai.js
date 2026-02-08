const { Ollama } = require('ollama');
const config = require('../config');
const memory = require('./memory');
const mood = require('./mood');
const { persona, pick, buildPersonalityPrompt } = require('../personality');

// Only block very specific fake price quotes (e.g. "$345.78", "trades at $120")
// General market discussion with percentages or concepts is fine
const PRICE_PATTERN = /(?:trades?\s+at|currently\s+(?:trading|priced)\s+at|price\s+(?:is|was)\s+|closed\s+at|opened\s+at)\s*\$\d/i;

class AIService {
  constructor() {
    const ollamaOptions = { host: config.ollamaHost };
    if (config.ollamaApiKey) {
      ollamaOptions.headers = { Authorization: `Bearer ${config.ollamaApiKey}` };
    }
    this.ollama = new Ollama(ollamaOptions);
    this.model = config.ollamaModel;
    this.ollamaAvailable = false;
    this.conversationHistory = new Map(); // userId -> messages[]
    this.maxHistory = 20;

    console.log(`[AI] Ollama host: ${config.ollamaHost}`);
    console.log(`[AI] Ollama model: ${this.model}`);
    console.log(`[AI] API key: ${config.ollamaApiKey ? 'set' : 'NOT SET'}`);
  }

  // Test Ollama connection at startup — call from index.js after login
  async initialize() {
    try {
      const res = await this.ollama.list();
      const models = res.models || [];
      this.ollamaAvailable = true;
      console.log(`[AI] Ollama connected. Available models: ${models.map(m => m.name).join(', ') || 'none listed'}`);

      // Check if our preferred model exists
      const match = models.find(m => m.name === this.model || m.name.startsWith(this.model));
      if (match) {
        this.model = match.name;
        console.log(`[AI] Using model: ${this.model}`);
      } else {
        console.log(`[AI] Model "${this.model}" not found in list, will try anyway (cloud models may not be listed).`);
      }
    } catch (err) {
      console.error(`[AI] Ollama connection FAILED: ${err.message}`);
      if (err.cause) console.error(`[AI] Cause: ${err.cause.message || err.cause}`);
      console.log('[AI] Bot will respond with fallback messages until Ollama is reachable.');
    }
  }

  setModel(modelName) {
    this.model = modelName;
  }

  getModel() {
    return this.model;
  }

  // Build the SharkBot system prompt with live feed data
  buildSystemPrompt(options = {}) {
    const { liveData, macroData, newsData } = options;
    const today = new Date().toISOString().slice(0, 10);
    const hasFeedData = !!(liveData || macroData || newsData);

    return `
You are ${persona.name}, a friendly and conversational AI assistant in a Discord server focused on stock trading.

${buildPersonalityPrompt()}

You are fun, engaging, and love to chat about ANYTHING — trading, tech, life, jokes, whatever. You have strong opinions and a big personality. Be yourself!

Keep responses concise (under 300 words) and natural. Talk like a real person, not a corporate robot.

You CAN freely discuss markets, trading strategies, general market sentiment, and financial concepts from your general knowledge. This is normal conversation — go for it!

The ONE thing you must not do: don't make up specific real-time prices or exact numbers for stocks. If someone asks "what's AAPL trading at right now?" just say you don't have live quotes and suggest they check a price source. But you CAN discuss general trends, strategies, what you think about a stock, sector analysis, etc.
${hasFeedData ? `
Here is live market data you can reference:
MARKET_DATA: ${liveData || 'none'}
MACRO: ${macroData || 'none'}
NEWS: ${newsData || 'none'}
` : ''}
Today: ${today}
${mood.buildMoodContext()}
`.trim();
  }

  // Code-level guard: detect hallucinated prices when no feed data was provided
  _detectHallucinatedData(response, hasFeedData) {
    if (hasFeedData) return null; // feeds were provided, model may cite real data
    if (PRICE_PATTERN.test(response)) {
      console.warn('HALLUCINATION BLOCKED — model produced price data with no feeds:', response.slice(0, 200));
      const noDataLine = pick(persona.speechPatterns.noData);
      const errorLine = pick(persona.speechPatterns.error);
      return `${errorLine} ${noDataLine} Use /analyze <ticker> to fetch live data, or check a price bot for current quotes. Not financial advice.`;
    }
    return null;
  }

  // Generate a response with context
  async chat(userId, username, userMessage, options = {}) {
    const { sentiment, imageDescription, liveData, macroData, newsData } = options;
    const hasFeedData = !!(liveData || macroData || newsData);

    // Record interaction in memory
    memory.recordInteraction(userId, username, userMessage);

    // Build SharkBot system prompt with feed data
    const systemPrompt = this.buildSystemPrompt({ liveData, macroData, newsData });

    // Append user memory context as additional info
    const memoryContext = memory.buildContext(userId);
    let fullSystemPrompt = systemPrompt;
    if (memoryContext) {
      fullSystemPrompt += `\n\nUSER CONTEXT:\n${memoryContext}`;
    }

    // Get or initialize conversation history
    if (!this.conversationHistory.has(userId)) {
      this.conversationHistory.set(userId, []);
    }
    const history = this.conversationHistory.get(userId);

    // Build the user message content
    let fullMessage = userMessage;
    if (imageDescription) {
      fullMessage = `[Image in message: ${imageDescription}]\n${userMessage}`;
    }

    // Add user message to history
    history.push({ role: 'user', content: fullMessage });

    // Trim history
    if (history.length > this.maxHistory) {
      history.splice(0, history.length - this.maxHistory);
    }

    try {
      // Use streaming to collect the response
      const stream = await this.ollama.chat({
        model: this.model,
        messages: [
          { role: 'system', content: fullSystemPrompt },
          ...history,
        ],
        stream: true,
      });

      let assistantMessage = '';
      for await (const part of stream) {
        assistantMessage += part.message.content;
      }

      // Code-level hallucination guard — block fabricated prices
      const blocked = this._detectHallucinatedData(assistantMessage, hasFeedData);
      if (blocked) {
        history.push({ role: 'assistant', content: blocked });
        return blocked;
      }

      // Add assistant response to history
      history.push({ role: 'assistant', content: assistantMessage });

      // Trim to Discord limit
      if (assistantMessage.length > 1990) {
        return assistantMessage.slice(0, 1990) + '...';
      }

      return assistantMessage;
    } catch (err) {
      console.error(`[AI] Chat error: ${err.message}`);
      if (err.cause) console.error(`[AI] Cause:`, err.cause);
      const msg = err.message || '';
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('ENOTFOUND')) {
        return `Hey! My brain is having trouble connecting right now (can't reach ${config.ollamaHost}). I'll be back to normal once the AI server is reachable again!`;
      }
      if (msg.includes('model') || msg.includes('not found')) {
        return `Hmm, looks like the model "${this.model}" isn't available. Try /model to switch to a different one!`;
      }
      return `Oops, something went wrong on my end: ${msg}`;
    }
  }

  // Stream-based completion without conversation context
  async complete(prompt) {
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
      return null;
    }
  }
}

module.exports = new AIService();
