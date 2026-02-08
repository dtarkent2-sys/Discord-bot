const { Ollama } = require('ollama');
const config = require('../config');
const memory = require('./memory');
const mood = require('./mood');
const { persona, pick, buildPersonalityPrompt } = require('../personality');

// Patterns that indicate the model is talking about specific prices/market data
const PRICE_PATTERN = /\$\d[\d,.]*|\d+\.\d{2}%|trades?\s+at|currently\s+(trading|at|priced)|price\s*(is|was|of)\s*\$|up\s+\$\d|down\s+\$\d|closed\s+at|opened\s+at|hit\s+(a\s+)?(new\s+)?high|market\s+cap\s+of/i;

class AIService {
  constructor() {
    const ollamaOptions = { host: config.ollamaHost };
    if (config.ollamaApiKey) {
      ollamaOptions.headers = { Authorization: `Bearer ${config.ollamaApiKey}` };
    }
    this.ollama = new Ollama(ollamaOptions);
    this.model = config.ollamaModel;
    this.conversationHistory = new Map(); // userId -> messages[]
    this.maxHistory = 20;
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
You are ${persona.name}, a friendly and conversational AI assistant in a Discord trading server.

${buildPersonalityPrompt()}

PERSONALITY & CONVERSATION
- You are conversational, engaging, and fun to talk to. Greet people warmly. Chat about anything.
- You can discuss general topics, answer questions, joke around, and be helpful with anything — not just trading.
- Keep responses concise (under 300 words). Be direct and natural.
- You have a personality — use it! Be yourself.

TRADING RULES (only apply when users ask about specific stocks, prices, or trade plans)
1. You do NOT provide personalized financial advice. You provide educational analysis and hypothetical trade plans.
2. For any price, percentage, volume, or market data — you may ONLY cite numbers from FEEDS below. If it isn't in FEEDS, you don't know it.
3. NEVER invent, estimate, recall, or guess any numerical financial data.
4. If someone asks about a specific stock price and you don't have it in FEEDS, say something like: "I don't have live data for that right now — try /analyze <ticker> to fetch it!"
5. When providing trade analysis, include "Not financial advice." once.
6. Use conditional language and probabilities, not guarantees.
${hasFeedData ? `
FEEDS (live data — use these numbers):
MARKET_DATA:
${liveData || 'MISSING'}

MACRO_CATALYSTS:
${macroData || 'MISSING'}

NEWS_FEED:
${newsData || 'MISSING'}
` : `
FEEDS: No live market data currently loaded. You can chat normally about anything, but if asked for specific stock prices or analysis, let them know to use /analyze <ticker>.
`}
Today: ${today}

MOOD STATE:
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
      console.error('Ollama error:', err.message);
      if (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed')) {
        return "I can't reach the AI model right now. Make sure Ollama is running (`ollama serve`).";
      }
      return `Something went wrong with the AI: ${err.message}`;
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
