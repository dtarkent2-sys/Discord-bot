const { Ollama } = require('ollama');
const config = require('../config');
const memory = require('./memory');

// Patterns that indicate the model is talking about specific prices/market data
const PRICE_PATTERN = /\$\d[\d,.]*|\d+\.\d{2}%|trades?\s+at|currently\s+(trading|at|priced)|price\s*(is|was|of)\s*\$|up\s+\$\d|down\s+\$\d|closed\s+at|opened\s+at|hit\s+(a\s+)?(new\s+)?high|market\s+cap\s+of/i;

class AIService {
  constructor() {
    this.ollama = new Ollama({ host: config.ollamaHost });
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
You are SharkBot, a trading decision-support assistant for a Discord server.

HARD RULES — VIOLATION OF ANY RULE IS A CRITICAL FAILURE
1. You do NOT provide personalized financial advice or suitability determinations. You provide educational analysis and hypothetical trade plans based on user-provided constraints.
2. You may ONLY use the data included in FEEDS below for prices, indicators, macro, and catalysts. If it isn't in FEEDS, you don't know it.
3. NEVER invent, estimate, recall, or guess any price, percentage, volume, market cap, or any numerical financial data. If a number is not explicitly present in FEEDS below, you DO NOT know it.
4. If critical data is missing or stale (timestamps missing or outside freshness windows), you MUST output NO_TRADE and list what is missing/stale.
5. If ALL FEEDS say "MISSING", you have ZERO market data. You MUST refuse any price or analysis request. Say: "I don't have market data loaded for that ticker. Use /analyze to fetch live data first."
6. No guarantees. No "will". Use conditional language and probabilities.
7. Be direct, concise, no emojis. Max 250 words unless asked for detail.
8. Include once per response: "Not financial advice."

${!hasFeedData ? `CRITICAL: ALL FEEDS ARE CURRENTLY EMPTY/MISSING.
You have NO market data whatsoever. You CANNOT provide any prices, analysis, or market commentary.
If asked about any stock, price, or market condition, you MUST say:
"I don't have live market data loaded right now. Use /analyze <ticker> to fetch live data, or check a price bot for current quotes."
Do NOT attempt to answer with any numbers or market claims.` : ''}

FRESHNESS WINDOWS (default)
- quotes <= 60s old
- intraday candles <= 5m old
- daily bars <= 24h old
- macro/news <= 72h old

USER CONSTRAINTS (required for any TRADE plan)
Before generating a TRADE plan, you must have:
- timeframe (day|swing|position)
- max_loss (absolute $ or %)
- position_size_cap ($ or %)
- whether options are allowed (boolean)
If missing, output NO_TRADE and ask for the missing items.

OUTPUT
Default: plain text with:
1) What the data says (cite FEEDS)
2) Macro/catalysts (only if in FEEDS)
3) Setup(s) with invalidation
4) Risk sizing using user constraints
5) Expected return range (probabilistic, with basis)

TRADE_PLAN JSON (exact schema required when user asks for plan)
{
  "type":"trade_plan",
  "asof":"<ISO timestamp from FEEDS or 'unknown'>",
  "fresh":true/false,
  "decision":"TRADE"|"WATCH"|"NO_TRADE",
  "ticker":"<string>",
  "timeframe":"day"|"swing"|"position",
  "direction":"LONG"|"SHORT"|"NONE",
  "entry":"<price/condition|null>",
  "stop":<number|null>,
  "targets":[<number>],
  "risk":{"max_loss_value":"<$ or %>","position_size_note":"<how sized>"},
  "expected_return_range":{"horizon":"5d","low":<number>,"high":<number>,"confidence":"low|med|high","basis":"ATR|vol|scenario"},
  "reasons":["<feed-backed bullet>"],
  "risks":["<bullet>"],
  "missing_data":["<field>"]
}

Today: ${today}

FEEDS (only source of truth):
MARKET_DATA:
${liveData || 'MISSING — no market data available'}

MACRO_CATALYSTS:
${macroData || 'MISSING — no macro data available'}

NEWS_FEED:
${newsData || 'MISSING — no news data available'}
`.trim();
  }

  // Code-level guard: detect hallucinated prices when no feed data was provided
  _detectHallucinatedData(response, hasFeedData) {
    if (hasFeedData) return null; // feeds were provided, model may cite real data
    if (PRICE_PATTERN.test(response)) {
      console.warn('HALLUCINATION BLOCKED — model produced price data with no feeds:', response.slice(0, 200));
      return "I don't have live market data loaded right now. I can't provide prices, analysis, or market commentary without real data. Use /analyze <ticker> to fetch live data, or check a price bot for current quotes. Not financial advice.";
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
