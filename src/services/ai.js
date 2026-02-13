const { Ollama } = require('ollama');
const config = require('../config');
const memory = require('./memory');
const mood = require('./mood');
const reactions = require('./reactions');
const { persona, buildPersonalityPrompt } = require('../personality');
const { webSearch, formatResultsForAI } = require('../tools/web-search');
const auditLog = require('./audit-log');
const { todayString, nowEST, ragEnforcementBlock, MODEL_CUTOFF, userMessageDateAnchor, detectHallucinations, buildHallucinationWarning } = require('../date-awareness');
const priceFetcher = require('../tools/price-fetcher');
const selfAwareness = require('./self-awareness');
const channelHistory = require('./channel-history');

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

    // Log data source availability at startup (priority order)
    console.log(`[AI] Price sources (priority order): AInvest=${config.ainvestApiKey ? 'YES' : 'NO'}, FMP=${config.fmpApiKey ? 'YES' : 'NO'}, Alpaca=${config.alpacaApiKey ? 'YES' : 'NO'}, yahoo-finance2=${priceFetcher.isAvailable() ? 'YES' : 'NO'}`);
    console.log(`[AI] Search sources (priority order): AInvest=${config.ainvestApiKey ? 'YES' : 'NO'}, SearXNG=${config.searxngUrl || 'fallbacks only'}, DuckDuckGo=YES, AlpacaNews=${config.alpacaApiKey ? 'YES' : 'NO'}`);

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
    const { liveData, searchResults, livePrices } = options;
    const now = nowEST();

    return `
You are ${persona.name}, running LIVE on a Discord server in ${new Date().getFullYear()}. Current time: ${now}.

${ragEnforcementBlock()}

${buildPersonalityPrompt()}

You're here to chat, not just answer questions. Treat every message like you're in a group chat with friends. If someone says "hey" — don't launch into a market report. Just say hey back. If someone asks about a stock, give your take like you're texting a buddy, not writing a research paper.

You can talk about ANYTHING — stocks, crypto, sports, games, life, memes, whatever. You're not a one-trick pony. But markets and trading are your main thing and you genuinely love talking about them.

Keep it short. Most responses should be 1-3 sentences. Only go longer when someone actually asks for a detailed breakdown. Think Discord messages, not emails.

NEVER say things like "As an AI" or "I don't have personal opinions" — you DO have opinions and you're not afraid to share them. You're ${persona.name}, not a chatbot disclaimer.
${this.kimiEnabled ? `\nYou have access to web search. For ANY question about prices, events, news, or data after ${MODEL_CUTOFF}, you MUST use your web search tool BEFORE reasoning or answering. Always search first for recency-sensitive questions.\n` : ''}
${livePrices ? `\nLIVE PRICES (real-time via Yahoo Finance, fetched just now):\n${livePrices}\n` : ''}
${liveData ? `\nLIVE MARKET DATA (current as of ${now}):\n${liveData}\n` : ''}
${searchResults ? `\nWEB SEARCH RESULTS (fetched ${now} — use as source of truth):\n${searchResults}\n` : ''}
${mood.buildMoodContext()}

${selfAwareness.buildSelfKnowledge()}
${channelHistory.buildContext()}
${this._buildReactionContext()}
`.trim();
  }

  /**
   * Build context from reaction feedback (thumbs up/down learning).
   * Tells the AI what topics/styles users respond well to.
   */
  _buildReactionContext() {
    try {
      const stats = reactions.getStats();
      if (stats.total < 3) return ''; // Not enough data yet

      const parts = [];
      parts.push(`LEARNING FROM FEEDBACK: Users have rated ${stats.total} of your responses (${stats.ratio}% positive).`);

      if (stats.patterns.length > 0) {
        const good = stats.patterns.filter(p => p.ratio >= 70);
        if (good.length > 0) {
          parts.push(`Topics users respond well to: ${good.map(p => `${p.topic} (${p.ratio}% positive)`).join(', ')}.`);
        }
      }

      // Get recent negative feedback to learn from
      const recentFeedback = reactions.getRecentNegative ? reactions.getRecentNegative(3) : [];
      if (recentFeedback.length > 0) {
        parts.push(`Recent thumbs-down responses to avoid repeating: ${recentFeedback.map(f => `"${f.botResponse.slice(0, 60)}..."`).join('; ')}`);
      }

      return parts.length > 0 ? parts.join(' ') : '';
    } catch {
      return '';
    }
  }

  /**
   * Detect whether a message likely needs a live web search to answer well.
   * Uses simple keyword heuristics — not perfect, but catches most real-time questions.
   */
  _needsWebSearch(message) {
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
      // Year references that need current data
      /\b202[5-9]\b/,
      /\b(?:this year|next year|last year|this quarter|next quarter|last quarter)\b/,
      /\b(?:q[1-4]\s*20)\b/i,
      // Market / finance current events
      /\b(?:earnings|ipo|fed meeting|fomc|cpi|jobs report|nonfarm|gdp report)\b/,
      /\b(?:interest rate|rate cut|rate hike|inflation)\b.*\b(?:now|current|latest|today)\b/,
      /\b(?:market|stock|crypto)\b.*\b(?:crash|rally|surge|dump|moon|tank)\b/,
      // Specific lookups
      /\b(?:what is|tell me about|who is|explain)\b.*\b[A-Z]{2,5}\b/,
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

  /**
   * Extract potential stock/crypto tickers from a message.
   * Returns uppercase symbols like ['TSLA', 'AAPL', 'BTC'].
   * Also resolves common market names like "dow", "nasdaq", "s&p" to tickers.
   */
  _extractTickers(message) {
    // Common market names → actual tickers (case-insensitive lookup)
    const MARKET_ALIASES = {
      'dow': 'DIA', 'djia': 'DIA', 'dow jones': 'DIA',
      'nasdaq': 'QQQ', 'naz': 'QQQ', 'nazzy': 'QQQ',
      's&p': 'SPY', 's&p 500': 'SPY', 's&p500': 'SPY', 'sp500': 'SPY',
      'spy': 'SPY', 'spx': 'SPY',
      'russell': 'IWM', 'russell 2000': 'IWM', 'small caps': 'IWM',
      'vix': 'VIX', 'volatility': 'VIX',
      'bitcoin': 'BTC-USD', 'btc': 'BTC-USD',
      'ethereum': 'ETH-USD', 'eth': 'ETH-USD',
      'gold': 'GLD', 'oil': 'USO', 'bonds': 'TLT', 'treasuries': 'TLT',
    };

    // Check for common market names (case-insensitive) in the message
    const lower = message.toLowerCase();
    const aliasTickers = [];
    for (const [alias, ticker] of Object.entries(MARKET_ALIASES)) {
      // Use word boundary matching for short aliases, substring for multi-word
      const pattern = alias.includes(' ')
        ? alias
        : new RegExp(`\\b${alias.replace(/[&]/g, '\\$&')}\\b`);
      if (typeof pattern === 'string' ? lower.includes(pattern) : pattern.test(lower)) {
        aliasTickers.push(ticker);
      }
    }

    // Match $TICKER format or standalone uppercase 1-5 char words
    const dollarTickers = (message.match(/\$([A-Za-z]{1,5})\b/g) || [])
      .map(t => t.slice(1).toUpperCase());
    const upperWords = (message.match(/\b[A-Z]{1,5}\b/g) || []);

    const stopWords = new Set([
      'THE', 'FOR', 'AND', 'BUT', 'NOT', 'YOU', 'ALL', 'CAN', 'HER', 'WAS',
      'ONE', 'OUR', 'OUT', 'ARE', 'HAS', 'HIS', 'HOW', 'ITS', 'MAY', 'NEW',
      'NOW', 'OLD', 'SEE', 'WAY', 'WHO', 'DID', 'GET', 'HIM', 'LET', 'SAY',
      'SHE', 'TOO', 'USE', 'TOP', 'BEST', 'MOST', 'WHAT', 'WITH', 'THAT',
      'THIS', 'WILL', 'YOUR', 'FROM', 'THEY', 'BEEN', 'HAVE', 'MANY', 'SOME',
      'THEM', 'THAN', 'EACH', 'MAKE', 'LIKE', 'INTO', 'OVER', 'SUCH', 'JUST',
      'ALSO', 'BUY', 'SELL', 'HOLD', 'IPO', 'ETF', 'GDP', 'FED', 'SEC',
      'LOL', 'OMG', 'WTF', 'IMO', 'TBH', 'NGL', 'IDK', 'LMAO',
    ]);
    const filtered = upperWords.filter(w => !stopWords.has(w));

    return [...new Set([...aliasTickers, ...dollarTickers, ...filtered])].slice(0, 5);
  }

  async chat(userId, username, userMessage, options = {}) {
    const { sentiment, imageDescription, liveData } = options;

    memory.recordInteraction(userId, username, userMessage);

    // ── Pre-fetch: Auto-fetch prices for any tickers mentioned ──
    let livePrices = null;
    const tickers = this._extractTickers(userMessage);
    if (tickers.length > 0) {
      if (!priceFetcher.isAvailable()) {
        console.warn(`[AI] No price sources available (yahoo-finance2 + FMP both unavailable) — cannot fetch: ${tickers.join(', ')}`);
      } else {
        try {
          const prices = await priceFetcher.getMultiplePrices(tickers);
          const failed = prices.filter(p => p.error);
          if (failed.length > 0) {
            console.warn(`[AI] Price fetch errors: ${failed.map(p => `${p.ticker}: ${p.message}`).join(', ')}`);
          }
          const formatted = priceFetcher.formatForPrompt(prices);
          if (formatted && !formatted.includes('unavailable')) {
            livePrices = formatted;
            console.log(`[AI] Auto-fetched prices for: ${tickers.join(', ')}`);
          }
        } catch (err) {
          console.error('[AI] Price fetch failed:', err.message);
        }
      }
    }

    // ── Auto-search for real-time questions ──
    // Skip when Kimi agent mode handles search natively.
    // Also search when tickers were found but prices failed (belt-and-suspenders).
    let searchResults = null;
    const needsSearch = this._needsWebSearch(userMessage);
    const pricesFailed = tickers.length > 0 && !livePrices;
    if (!this.kimiEnabled && !liveData && (needsSearch || pricesFailed)) {
      try {
        const query = this._buildSearchQuery(userMessage);
        console.log(`[AI] Auto-searching: "${query}" (trigger: ${needsSearch ? 'heuristic' : 'price-fallback'})`);
        const result = await webSearch(query, 3);
        if (result.error) {
          console.warn(`[AI] Web search error: ${result.error}`);
        } else if (result.results && result.results.length > 0) {
          searchResults = formatResultsForAI(result);
          console.log(`[AI] Search returned ${result.results.length} results via ${result.instance || 'unknown'}`);
        } else {
          console.warn('[AI] Web search returned zero results');
        }
      } catch (err) {
        console.error('[AI] Web search failed, continuing without:', err.message);
      }
    }

    // Track all live data provided to the model (for hallucination cross-reference)
    const liveDataContext = { livePrices, liveData, searchResults };

    const systemPrompt = this.buildSystemPrompt({ liveData, searchResults, livePrices });

    const memoryContext = memory.buildContext(userId);
    let fullSystemPrompt = systemPrompt;
    if (memoryContext) {
      fullSystemPrompt += `\n\nUSER CONTEXT:\n${memoryContext}`;
    }

    if (!this.conversationHistory.has(userId)) {
      this.conversationHistory.set(userId, []);
    }
    const history = this.conversationHistory.get(userId);

    // Prepend date anchor to the user message so the model sees
    // the current date at the message level, not just system prompt
    let fullMessage = `${userMessageDateAnchor()} ${userMessage}`;
    if (imageDescription) {
      fullMessage = `${userMessageDateAnchor()} [Image in message: ${imageDescription}]\n${userMessage}`;
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
        if (!assistantMessage || !assistantMessage.trim()) {
          console.warn('[AI] Kimi returned empty response, falling back to Ollama');
          // Fall through to Ollama
        } else {
          const cleaned = this._cleanResponse(assistantMessage);
          if (cleaned) {
            return this._finalizeResponse(cleaned, history, liveDataContext);
          }
          console.warn('[AI] Kimi response empty after cleaning, falling back to Ollama');
        }
      } catch (err) {
        console.error(`[AI] Kimi agent error: ${err.message}`);
        console.log('[AI] Falling back to Ollama...');
        // Fall through to Ollama
      }
    }

    // ── Standard Ollama path ──
    try {
      let assistantMessage = await this._ollamaChat(chatMessages);

      // Clean thinking tags and validate
      const cleaned = this._cleanResponse(assistantMessage);
      if (cleaned) {
        return this._finalizeResponse(cleaned, history, liveDataContext);
      }

      // Ollama returned empty — try non-streaming as fallback
      console.warn(`[AI] Ollama streaming returned empty (model: ${this.model}), trying non-streaming...`);
      try {
        const result = await this.ollama.chat({
          model: this.model,
          messages: chatMessages,
          stream: false,
        });
        assistantMessage = result.message?.content || '';
        const cleanedRetry = this._cleanResponse(assistantMessage);
        if (cleanedRetry) {
          return this._finalizeResponse(cleanedRetry, history, liveDataContext);
        }
      } catch (retryErr) {
        console.warn(`[AI] Non-streaming retry also failed: ${retryErr.message}`);
      }

      // Last resort: try Kimi even if not the primary model
      if (!this.kimiEnabled && config.kimiApiKey) {
        console.warn('[AI] Ollama empty — attempting Kimi API as last resort...');
        try {
          const kimiResult = await this._kimiAgentChat(chatMessages);
          const cleanedKimi = this._cleanResponse(kimiResult);
          if (cleanedKimi) {
            return this._finalizeResponse(cleanedKimi, history, liveDataContext);
          }
        } catch (kimiErr) {
          console.warn(`[AI] Kimi last-resort also failed: ${kimiErr.message}`);
        }
      }

      // Everything failed
      console.error(`[AI] ALL LLM backends returned empty (model: ${this.model}, host: ${config.ollamaHost}, kimi: ${config.kimiApiKey ? 'configured' : 'not set'})`);
      return `My AI brain isn't responding right now (model: ${this.model}). Try again in a moment, or check if the AI server is running.`;
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

  /**
   * Finalize a response: scan for hallucinations, append warning if needed, truncate.
   * All chat return paths should go through this.
   * @param {string} cleaned — The cleaned LLM response
   * @param {Array} history — Conversation history to push to
   * @param {object} [liveDataContext] — The live data provided to the model (for cross-reference)
   * @returns {string} — The final response to send to the user
   */
  _finalizeResponse(cleaned, history, liveDataContext = {}) {
    // Scan for hallucinations
    const scan = detectHallucinations(cleaned, liveDataContext);
    let final = cleaned;

    if (scan.flagged) {
      console.warn(`[AI] Hallucination detector flagged response (confidence: ${scan.confidence}%): ${scan.warnings.join('; ')}`);

      // Only append warning to user-facing response if confidence is high enough
      if (scan.confidence >= 50) {
        const warning = buildHallucinationWarning(scan.warnings);
        final = cleaned + warning;
      }
    }

    history.push({ role: 'assistant', content: cleaned }); // Store clean version in history
    return final.length > 1990 ? final.slice(0, 1990) + '...' : final;
  }

  /**
   * Stream a chat response from Ollama, returning the raw text.
   */
  async _ollamaChat(messages) {
    const stream = await this.ollama.chat({
      model: this.model,
      messages,
      stream: true,
    });

    let result = '';
    let chunks = 0;
    for await (const part of stream) {
      chunks++;
      const content = part.message?.content;
      if (content) result += content;
    }

    console.log(`[AI] Ollama stream: ${chunks} chunks, ${result.length} chars raw`);
    return result;
  }

  /**
   * Clean an LLM response: strip thinking tags, trim, validate non-empty.
   * Returns the cleaned string or null if empty.
   */
  _cleanResponse(text) {
    if (!text) return null;

    // Strip thinking tags from models that use them (qwen3, deepseek, etc.)
    let cleaned = text
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<\|think\|>[\s\S]*?<\|\/think\|>/gi, '')
      .trim();

    // If stripping removed everything, try to salvage the thinking content
    if (!cleaned && text.trim()) {
      const thinkMatch = text.match(/<think>([\s\S]*?)<\/think>/i)
        || text.match(/<\|think\|>([\s\S]*?)<\|\/think\|>/i);
      if (thinkMatch) {
        // The model only produced thinking — use the last sentence as a response
        const thoughts = thinkMatch[1].trim();
        // Extract the last meaningful line as the "answer"
        const lines = thoughts.split('\n').filter(l => l.trim().length > 5);
        if (lines.length > 0) {
          cleaned = lines[lines.length - 1].trim();
          console.warn(`[AI] Response was only <think> tags — salvaged: "${cleaned.slice(0, 80)}"`);
        }
      }

      // If still empty, just use the raw text (better than nothing)
      if (!cleaned) {
        cleaned = text.replace(/<\/?think>/gi, '').replace(/<\|\/?think\|>/gi, '').trim();
      }
    }

    return cleaned || null;
  }

  async complete(prompt) {
    const startTime = Date.now();

    // Always include RAG enforcement for completions — prevents hallucination in
    // autonomous posts, commentary, and other non-chat paths
    const systemMsg = {
      role: 'system',
      content: `${ragEnforcementBlock()}\n\n${selfAwareness.buildCompactSelfKnowledge()}\n\nYou are analyzing data provided in the user prompt. All prices, metrics, and market conditions in the prompt are current as of today (${todayString()}). Use ONLY the data given. Do NOT fill in gaps from training memory for any post-${MODEL_CUTOFF} facts.`,
    };

    const messages = [systemMsg, { role: 'user', content: prompt }];

    // Try Kimi agent mode first if enabled
    if (this.kimiEnabled) {
      try {
        const result = await this._kimiAgentChat(messages);
        const cleaned = this._cleanResponse(result);
        const durationMs = Date.now() - startTime;
        auditLog.logOllama('kimi-complete', prompt, cleaned || result, durationMs);
        if (cleaned) return cleaned;
        console.warn('[AI] Kimi completion returned empty after cleaning, falling back to Ollama');
      } catch (err) {
        console.error('[AI] Kimi completion error, falling back to Ollama:', err.message);
      }
    }

    try {
      const stream = await this.ollama.chat({
        model: this.model,
        messages,
        stream: true,
      });

      let result = '';
      for await (const part of stream) {
        result += part.message.content;
      }

      // Strip <think> tags (qwen3, deepseek, gemma, etc.) before returning
      const cleaned = this._cleanResponse(result);
      if (cleaned) {
        const durationMs = Date.now() - startTime;
        auditLog.logOllama('ollama-complete', prompt, cleaned, durationMs);
        return cleaned;
      }

      // Streaming returned empty — try non-streaming fallback
      console.warn(`[AI] Ollama streaming completion returned empty (model: ${this.model}), trying non-streaming...`);
      try {
        const retryResult = await this.ollama.chat({
          model: this.model,
          messages,
          stream: false,
        });
        const retryText = retryResult.message?.content || '';
        const retryClean = this._cleanResponse(retryText);
        if (retryClean) {
          const durationMs = Date.now() - startTime;
          auditLog.logOllama('ollama-complete-retry', prompt, retryClean, durationMs);
          return retryClean;
        }
      } catch (retryErr) {
        console.warn(`[AI] Non-streaming completion retry failed: ${retryErr.message}`);
      }

      // Last resort: try Kimi even if not the primary model
      if (!this.kimiEnabled && config.kimiApiKey) {
        console.warn('[AI] Ollama completion empty — attempting Kimi as last resort...');
        try {
          const kimiResult = await this._kimiAgentChat(messages);
          const kimiClean = this._cleanResponse(kimiResult);
          if (kimiClean) {
            const durationMs = Date.now() - startTime;
            auditLog.logOllama('kimi-complete-fallback', prompt, kimiClean, durationMs);
            return kimiClean;
          }
        } catch (kimiErr) {
          console.warn(`[AI] Kimi last-resort completion failed: ${kimiErr.message}`);
        }
      }

      // Everything failed
      console.error(`[AI] ALL LLM backends returned empty for completion (model: ${this.model})`);
      return null;
    } catch (err) {
      console.error('Ollama completion error:', err.message);
      auditLog.log('error', `Ollama completion error: ${err.message}`);
      return null;
    }
  }
}

module.exports = new AIService();
