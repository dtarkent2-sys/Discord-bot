const { Ollama } = require('ollama');
const config = require('../config');
const memory = require('./memory');
const mood = require('./mood');
const { persona, pick, buildPersonalityPrompt } = require('../personality');
const { webSearch, formatResultsForAI } = require('../tools/web-search');

class AIService {
  constructor() {
    const ollamaOptions = { host: config.ollamaHost };
    if (config.ollamaApiKey) {
      ollamaOptions.headers = { Authorization: `Bearer ${config.ollamaApiKey}` };
    }
    this.ollama = new Ollama(ollamaOptions);
    this.model = config.ollamaModel;
    this.ollamaAvailable = false;
    this.conversationHistory = new Map();
    this.maxHistory = 20;

    // Kimi K2.5 agent mode — uses Moonshot API with built-in web search
    this.kimiEnabled = !!(config.kimiApiKey && this._isKimiModel());

    console.log(`[AI] Ollama host: ${config.ollamaHost}`);
    console.log(`[AI] Ollama model: ${this.model}`);
    console.log(`[AI] API key: ${config.ollamaApiKey ? 'set' : 'NOT SET'}`);
    if (this.kimiEnabled) {
      console.log(`[AI] Kimi agent mode ENABLED (${config.kimiBaseUrl}, model: ${config.kimiModel})`);
    }
  }

  async initialize() {
    try {
      const res = await this.ollama.list();
      const models = res.models || [];
      this.ollamaAvailable = true;
      console.log(`[AI] Ollama connected. Available models: ${models.map(m => m.name).join(', ') || 'none listed'}`);

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

  _isKimiModel() {
    return (this.model || '').toLowerCase().includes('kimi');
  }

  setModel(modelName) {
    this.model = modelName;
    this.kimiEnabled = !!(config.kimiApiKey && this._isKimiModel());
  }

  getModel() {
    return this.model;
  }

  /**
   * Kimi K2.5 agent mode — calls Moonshot API directly with built-in $web_search tool.
   * The model autonomously decides when to search the web for current information.
   * Implements the tool call loop: when the model requests a search, we return the
   * arguments as-is (Moonshot handles the actual search server-side) and re-submit.
   */
  async _kimiAgentChat(messages) {
    const url = `${config.kimiBaseUrl}/chat/completions`;
    const headers = {
      'Authorization': `Bearer ${config.kimiApiKey}`,
      'Content-Type': 'application/json',
    };

    const tools = [
      { type: 'builtin_function', function: { name: '$web_search' } },
    ];

    let conversationMessages = [...messages];
    const maxIterations = 5;

    for (let i = 0; i < maxIterations; i++) {
      const body = {
        model: config.kimiModel,
        messages: conversationMessages,
        tools,
        temperature: 0.6,
        max_tokens: 4096,
      };

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => 'Unknown error');
        throw new Error(`Kimi API ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const choice = data.choices[0];
      const finishReason = choice.finish_reason;
      const message = choice.message;

      if (finishReason === 'tool_calls' && message.tool_calls) {
        // Model wants to use a tool — add its message and process each call
        conversationMessages.push(message);

        for (const toolCall of message.tool_calls) {
          const name = toolCall.function.name;
          const args = toolCall.function.arguments;

          let toolResult;
          if (name === '$web_search') {
            // Built-in search: return arguments as-is; Moonshot executes the search server-side
            toolResult = args;
          } else {
            toolResult = JSON.stringify({ error: `Unknown tool: ${name}` });
          }

          conversationMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name,
            content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
          });
        }

        console.log(`[AI] Kimi agent: tool call iteration ${i + 1} (${message.tool_calls.length} tools invoked)`);
        continue;
      }

      // Final answer
      return message.content || '';
    }

    return 'I had trouble completing that search. Please try again.';
  }

  buildSystemPrompt(options = {}) {
    const { liveData, searchResults } = options;
    const today = new Date().toISOString().slice(0, 10);

    return `
You are ${persona.name}, hanging out in a Discord server with people who are into trading, crypto, and markets. Today is ${today}.

${buildPersonalityPrompt()}

You're here to chat, not just answer questions. Treat every message like you're in a group chat with friends. If someone says "hey" — don't launch into a market report. Just say hey back. If someone asks about a stock, give your take like you're texting a buddy, not writing a research paper.

You can talk about ANYTHING — stocks, crypto, sports, games, life, memes, whatever. You're not a one-trick pony. But markets and trading are your main thing and you genuinely love talking about them.

Keep it short. Most responses should be 1-3 sentences. Only go longer when someone actually asks for a detailed breakdown. Think Discord messages, not emails.

NEVER say things like "As an AI" or "I don't have personal opinions" — you DO have opinions and you're not afraid to share them. You're Billy, not a chatbot disclaimer.
${this.kimiEnabled ? `\nYou have access to web search. When users ask about current events, live data, recent news, sports results, or anything requiring up-to-date information, use your web search tool to find accurate, current answers. Mention where you found it.\n` : ''}
${liveData ? `\nLIVE DATA (use these real numbers when available):\n${liveData}\n` : ''}
${searchResults ? `\nWEB SEARCH RESULTS (use this real-time information to answer the user's question — mention where you found it):\n${searchResults}\n` : ''}
${mood.buildMoodContext()}
`.trim();
  }

  /**
   * Detect whether a message likely needs a live web search to answer well.
   * Uses simple keyword heuristics — not perfect, but catches most real-time questions.
   */
  _needsWebSearch(message) {
    if (!config.searxngUrl) return false;

    const lower = message.toLowerCase();

    // Current events / real-time triggers
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
    ];

    // Question patterns that suggest "look this up"
    const questionPatterns = [
      /\bwhat(?:'s| is| are| was| were)\b.*\b(?:price|cost|worth|salary|net worth|market cap)\b/,
      /\bhow (?:much|many|old|tall|far|long)\b/,
      /\bwhere (?:is|are|can|do)\b/,
      /\blook up\b/,
      /\bsearch for\b/,
      /\bgoogle\b/,
      /\bfind out\b/,
    ];

    for (const pat of realtimePatterns) {
      if (pat.test(lower)) return true;
    }
    for (const pat of questionPatterns) {
      if (pat.test(lower)) return true;
    }

    return false;
  }

  /**
   * Build a concise search query from a user message.
   */
  _buildSearchQuery(message) {
    // Strip common filler and just keep the substance
    let q = message
      .replace(/^(hey|hi|yo|ok|okay|so|well|um|hmm|please|can you|could you|do you know|tell me|what's|who's)\s+/i, '')
      .replace(/[?!.]+$/, '')
      .trim();

    // If still too long, truncate to first ~80 chars
    if (q.length > 80) {
      q = q.slice(0, 80).replace(/\s\S*$/, '');
    }

    return q || message.slice(0, 80);
  }

  async chat(userId, username, userMessage, options = {}) {
    const { sentiment, imageDescription, liveData } = options;

    memory.recordInteraction(userId, username, userMessage);

    // Auto-search for real-time questions (skip when Kimi agent mode handles search natively)
    let searchResults = null;
    if (!this.kimiEnabled && !liveData && this._needsWebSearch(userMessage)) {
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

    // ── Kimi agent mode path (Moonshot API with built-in web search) ──
    if (this.kimiEnabled) {
      try {
        const assistantMessage = await this._kimiAgentChat(chatMessages);
        history.push({ role: 'assistant', content: assistantMessage });
        if (assistantMessage.length > 1990) {
          return assistantMessage.slice(0, 1990) + '...';
        }
        return assistantMessage;
      } catch (err) {
        console.error(`[AI] Kimi agent error: ${err.message}`);
        console.log('[AI] Falling back to Ollama...');
        // Fall through to Ollama
      }
    }

    // ── Standard Ollama path ──
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
        return `Hey! My brain is having trouble connecting right now (can't reach ${config.ollamaHost}). I'll be back to normal once the AI server is reachable again!`;
      }
      if (msg.includes('model') || msg.includes('not found')) {
        return `Hmm, looks like the model "${this.model}" isn't available. Try /model to switch to a different one!`;
      }
      return `Oops, something went wrong on my end: ${msg}`;
    }
  }

  async complete(prompt) {
    // Try Kimi agent mode first if enabled
    if (this.kimiEnabled) {
      try {
        return await this._kimiAgentChat([{ role: 'user', content: prompt }]);
      } catch (err) {
        console.error('[AI] Kimi completion error, falling back to Ollama:', err.message);
      }
    }

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
