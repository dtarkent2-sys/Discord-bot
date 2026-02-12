/**
 * Agent Swarm — Parallel multi-agent research pipeline.
 *
 * Takes a complex query, decomposes it into parallel sub-tasks,
 * runs independent research agents (each with web search), then
 * synthesizes everything into a single coherent response.
 *
 * Pipeline:
 *   1. Coordinator decomposes query → 2-6 sub-tasks
 *   2. Agents run in parallel (each can web-search independently)
 *   3. Synthesizer merges all findings into a final answer
 *
 * Uses Kimi API with $web_search when available, falls back to Ollama + SearXNG.
 */

const { Ollama } = require('ollama');
const config = require('../config');
const { webSearch, formatResultsForAI } = require('../tools/web-search');
const marketData = require('./yahoo');
const alpaca = require('./alpaca');
const { getMarketContext } = require('../data/market');
const { todayString, ragEnforcementBlock, MODEL_CUTOFF } = require('../date-awareness');

// AInvest — news, analyst ratings, fundamentals (optional enrichment)
let ainvest;
try {
  ainvest = require('./ainvest');
} catch {
  ainvest = null;
}

const KIMI_TOOLS = [
  { type: 'builtin_function', function: { name: '$web_search' } },
];

class AgentSwarm {
  constructor() {
    this.kimiEnabled = !!config.kimiApiKey;

    // Ollama fallback
    const opts = { host: config.ollamaHost };
    if (config.ollamaApiKey) {
      opts.headers = { Authorization: `Bearer ${config.ollamaApiKey}` };
    }
    this.ollama = new Ollama(opts);
    this.model = config.ollamaModel;
  }

  /** Update the model used for research (called when user switches via /model) */
  setModel(modelName) {
    this.model = modelName;
  }

  getModel() {
    return this.model;
  }

  /**
   * Run a full agent swarm research query.
   * @param {string} query — the user's research question
   * @param {function} [onProgress] — optional callback(message) for live status updates
   * @returns {string} — synthesized markdown response
   */
  async research(query, onProgress) {
    const progress = onProgress || (() => {});

    // Step 0: Gather real-time context (market data + web search)
    progress('Gathering real-time data...');
    const realTimeContext = await this._gatherRealTimeContext(query);

    // Step 1: Decompose query into sub-tasks
    progress('Breaking down your query into research tasks...');
    const subtasks = await this._decompose(query);
    progress(`Spawned **${subtasks.length}** research agents in parallel...`);

    // Step 2: Run all agents in parallel with real-time context injected
    const results = await this._runAgents(subtasks, progress, realTimeContext);
    const successful = results.filter(r => !r.failed);
    progress(`${successful.length}/${subtasks.length} agents finished. Synthesizing findings...`);

    // Step 3: Synthesize into one coherent response
    const synthesis = await this._synthesize(query, results);
    return { synthesis, agents: results, taskCount: subtasks.length };
  }

  // ── Step 0: Gather real-time context ──────────────────────────────────

  async _gatherRealTimeContext(query) {
    const parts = [];

    // Extract potential stock tickers from query and fetch live market data
    const tickers = this._extractTickers(query);
    if (tickers.length > 0) {
      const results = await Promise.all(
        tickers.slice(0, 5).map(async (ticker) => {
          try {
            const context = await getMarketContext(ticker, { skipAlpaca: true });
            if (context?.snapshot) return this._formatSnapshot(context.snapshot);
            return null;
          } catch (err) {
            console.warn(`[AgentSwarm] Market data for ${ticker} failed:`, err.message);
            return null;
          }
        })
      );
      const validData = results.filter(Boolean);
      if (validData.length > 0) {
        parts.push(`LIVE MARKET DATA (real-time, use these numbers):\n${validData.join('\n\n')}`);
      }
    } else if (marketData.enabled || alpaca.enabled) {
      // No specific tickers found — fetch market overview so agents have real data
      // This covers open-ended queries like "top stocks to buy tomorrow"
      const overviewParts = [];

      // Fetch major indices/ETFs for broad market context
      const majorTickers = ['SPY', 'QQQ', 'DIA', 'IWM'];
      try {
        if (alpaca.enabled) {
          const snapshots = await alpaca.getSnapshots(majorTickers);
          if (snapshots.length > 0) {
            const lines = snapshots.map(s => {
              const pct = s.changePercent;
              const dir = pct > 0 ? '+' : '';
              return `${s.ticker}: $${s.price?.toFixed(2) || '?'} (${dir}${pct?.toFixed(2) || '?'}%)`;
            });
            overviewParts.push(`MARKET INDICES:\n${lines.join('\n')}`);
          }
        } else if (marketData.enabled) {
          const quotes = await marketData.getQuotes(majorTickers);
          const valid = quotes.filter(q => q.regularMarketPrice != null);
          if (valid.length > 0) {
            const lines = valid.map(q => {
              const pct = q.regularMarketChangePercent;
              const dir = pct > 0 ? '+' : '';
              return `${q.symbol}: $${q.regularMarketPrice.toFixed(2)} (${dir}${pct?.toFixed(2) || '?'}%)`;
            });
            overviewParts.push(`MARKET INDICES:\n${lines.join('\n')}`);
          }
        }
      } catch (err) {
        console.warn('[AgentSwarm] Market indices fetch failed:', err.message);
      }

      // Detect screening/portfolio queries and use FMP screener
      const isScreeningQuery = this._isScreeningQuery(query);

      if (isScreeningQuery && marketData.enabled) {
        // Use the advanced screener to find stocks matching the query intent
        try {
          const screenResults = await this._runSmartScreen(query);
          if (screenResults.length > 0) {
            overviewParts.push(screenResults.join('\n\n'));
          }
        } catch (err) {
          console.warn('[AgentSwarm] Smart screen failed:', err.message);
        }
      }

      // Fetch top gainers + most active + losers for broader context
      const [gainers, mostActive, losers] = await Promise.all([
        marketData.screenByGainers().catch(() => []),
        marketData.screenByMostActive ? marketData.screenByMostActive().catch(() => []) : Promise.resolve([]),
        marketData.screenByLosers ? marketData.screenByLosers().catch(() => []) : Promise.resolve([]),
      ]);

      if (gainers.length > 0) {
        const top = gainers.slice(0, 10);
        const lines = top.map(g => {
          const pct = g.regularMarketChangePercent;
          const dir = pct > 0 ? '+' : '';
          return `${g.symbol} (${g.shortName || ''}): $${g.regularMarketPrice?.toFixed(2) || '?'} ${dir}${pct?.toFixed(2) || '?'}% | Vol: ${g.regularMarketVolume ? (g.regularMarketVolume / 1e6).toFixed(1) + 'M' : 'N/A'} | MktCap: ${g.marketCap ? '$' + (g.marketCap / 1e9).toFixed(1) + 'B' : 'N/A'}`;
        });
        overviewParts.push(`TOP GAINERS TODAY:\n${lines.join('\n')}`);
      }

      if (mostActive.length > 0) {
        const top = mostActive.slice(0, 10);
        const lines = top.map(g => {
          const pct = g.regularMarketChangePercent;
          const dir = pct > 0 ? '+' : '';
          return `${g.symbol} (${g.shortName || ''}): $${g.regularMarketPrice?.toFixed(2) || '?'} ${dir}${pct?.toFixed(2) || '?'}% | Vol: ${g.regularMarketVolume ? (g.regularMarketVolume / 1e6).toFixed(1) + 'M' : 'N/A'}`;
        });
        overviewParts.push(`MOST ACTIVE BY VOLUME:\n${lines.join('\n')}`);
      }

      if (losers.length > 0) {
        const top = losers.slice(0, 5);
        const lines = top.map(g => {
          const pct = g.regularMarketChangePercent;
          const dir = pct > 0 ? '+' : '';
          return `${g.symbol} (${g.shortName || ''}): $${g.regularMarketPrice?.toFixed(2) || '?'} ${dir}${pct?.toFixed(2) || '?'}%`;
        });
        overviewParts.push(`TOP LOSERS TODAY:\n${lines.join('\n')}`);
      }

      if (overviewParts.length > 0) {
        parts.push(`LIVE MARKET OVERVIEW (real-time — use these numbers):\n${overviewParts.join('\n\n')}`);
      }
    }

    // AInvest enrichment — news, analyst ratings, fundamentals for detected tickers
    // Calls are staggered to avoid AInvest rate limits
    if (ainvest && ainvest.enabled && tickers.length > 0) {
      const ainvestParts = [];
      const staggerDelay = (ms) => new Promise(r => setTimeout(r, ms));
      const STAGGER_MS = 350;

      for (const ticker of tickers.slice(0, 3)) {
        try {
          const lines = [`AINVEST DATA FOR ${ticker}:`];

          // Sequential calls with stagger to respect rate limits
          let analysts, financials, news;
          try { analysts = await ainvest.getAnalystConsensus(ticker); } catch { analysts = null; }
          await staggerDelay(STAGGER_MS);
          try { financials = await ainvest.getFinancials(ticker); } catch { financials = null; }
          await staggerDelay(STAGGER_MS);
          try { news = await ainvest.getNews({ tickers: [ticker], limit: 5 }); } catch { news = null; }

          if (analysts) {
            const a = analysts;
            lines.push(`  Analyst Consensus (${a.totalAnalysts} analysts): Buy ${a.strongBuy + a.buy} | Hold ${a.hold} | Sell ${a.sell + a.strongSell}`);
            if (a.targetAvg != null) lines.push(`  Price Target: $${a.targetLow}–$${a.targetHigh} (avg $${a.targetAvg})`);
          }

          if (financials) {
            const f = financials;
            const fParts = [];
            if (f.peTTM != null) fParts.push(`P/E: ${f.peTTM.toFixed(1)}`);
            if (f.epsTTM != null) fParts.push(`EPS: $${f.epsTTM.toFixed(2)}`);
            if (f.roeTTM != null) fParts.push(`ROE: ${(f.roeTTM * 100).toFixed(1)}%`);
            if (f.marketCap != null) fParts.push(`Mkt Cap: $${(f.marketCap / 1e9).toFixed(1)}B`);
            if (fParts.length > 0) lines.push(`  Fundamentals: ${fParts.join(' | ')}`);
          }

          if (news && news.length > 0) {
            lines.push(`  Recent News:`);
            for (const n of news.slice(0, 3)) {
              lines.push(`    • ${n.title} (${n.source || 'AInvest'})`);
            }
          }

          if (lines.length > 1) ainvestParts.push(lines.join('\n'));
          if (tickers.indexOf(ticker) < tickers.length - 1) await staggerDelay(STAGGER_MS);
        } catch (err) {
          console.warn(`[AgentSwarm] AInvest data for ${ticker} failed:`, err.message);
        }
      }
      if (ainvestParts.length > 0) {
        parts.push(`AINVEST FUNDAMENTALS & NEWS (real-time):\n${ainvestParts.join('\n\n')}`);
      }
    }

    // Web search on the full query for current information
    if (config.searxngUrl) {
      try {
        const searchResult = await webSearch(query, 5);
        if (!searchResult.error && searchResult.results?.length > 0) {
          parts.push(`WEB SEARCH RESULTS (current as of today):\n${formatResultsForAI(searchResult)}`);
        }
      } catch (err) {
        console.warn('[AgentSwarm] Initial web search failed:', err.message);
      }
    }

    return parts.length > 0 ? parts.join('\n\n---\n\n') : '';
  }

  /**
   * Detect if the query is asking to screen/find/build a portfolio of stocks
   * rather than asking about specific tickers.
   */
  _isScreeningQuery(query) {
    const lower = query.toLowerCase();
    const screeningKeywords = [
      'portfolio', 'screen', 'find stocks', 'find me', 'pick stocks',
      'best stocks', 'top stocks', 'build me', 'stock picks', 'pump',
      'undervalued', 'high volume', 'momentum', 'growth stocks',
      'dividend stocks', 'value stocks', 'small cap', 'large cap',
      'mid cap', 'high beta', 'low beta', 'penny stocks',
      'screener', 'scanner', 'filter stocks', 'stock ideas',
      'what to buy', 'what should i buy', 'recommendations',
    ];
    return screeningKeywords.some(kw => lower.includes(kw));
  }

  /**
   * Run multiple screener queries to get diverse stock data for portfolio building.
   * Parses the query to extract criteria and runs targeted screens.
   */
  async _runSmartScreen(query) {
    const lower = query.toLowerCase();
    const results = [];

    // Parallel screener calls for different criteria
    const screens = [];

    // Large-cap high-volume (liquid, safe)
    screens.push({
      label: 'LARGE-CAP HIGH-VOLUME STOCKS',
      filters: { marketCapMin: 10e9, volumeMin: 5e6, country: 'US', isActivelyTrading: true, limit: 20 },
    });

    // Detect sector preferences from query
    const sectorMap = {
      tech: 'Technology', technology: 'Technology',
      health: 'Healthcare', healthcare: 'Healthcare', pharma: 'Healthcare', biotech: 'Healthcare',
      energy: 'Energy', oil: 'Energy', gas: 'Energy',
      finance: 'Financial Services', financial: 'Financial Services', bank: 'Financial Services',
      consumer: 'Consumer Cyclical', retail: 'Consumer Cyclical',
      industrial: 'Industrials', manufacturing: 'Industrials',
      real: 'Real Estate', reit: 'Real Estate',
      utilities: 'Utilities',
      materials: 'Basic Materials',
      communication: 'Communication Services', media: 'Communication Services',
    };

    let sectorFilter = null;
    for (const [keyword, sector] of Object.entries(sectorMap)) {
      if (lower.includes(keyword)) {
        sectorFilter = sector;
        break;
      }
    }

    if (sectorFilter) {
      screens.push({
        label: `${sectorFilter.toUpperCase()} SECTOR SCREEN`,
        filters: { sector: sectorFilter, marketCapMin: 1e9, volumeMin: 1e6, country: 'US', isActivelyTrading: true, limit: 20 },
      });
    }

    // Detect market cap preference
    if (lower.includes('small cap') || lower.includes('smallcap') || lower.includes('penny')) {
      screens.push({
        label: 'SMALL-CAP STOCKS (under $2B)',
        filters: { marketCapMax: 2e9, marketCapMin: 100e6, volumeMin: 500000, country: 'US', isActivelyTrading: true, limit: 20 },
      });
    }

    if (lower.includes('mid cap') || lower.includes('midcap')) {
      screens.push({
        label: 'MID-CAP STOCKS ($2B–$10B)',
        filters: { marketCapMin: 2e9, marketCapMax: 10e9, volumeMin: 1e6, country: 'US', isActivelyTrading: true, limit: 20 },
      });
    }

    // Dividend stocks
    if (lower.includes('dividend') || lower.includes('yield') || lower.includes('income')) {
      screens.push({
        label: 'HIGH-DIVIDEND STOCKS (yield > 3%)',
        filters: { dividendMin: 3, marketCapMin: 1e9, country: 'US', isActivelyTrading: true, limit: 20 },
      });
    }

    // High-beta / momentum
    if (lower.includes('momentum') || lower.includes('high beta') || lower.includes('aggressive') || lower.includes('pump')) {
      screens.push({
        label: 'HIGH-BETA MOMENTUM STOCKS (beta > 1.5)',
        filters: { betaMin: 1.5, marketCapMin: 500e6, volumeMin: 2e6, country: 'US', isActivelyTrading: true, limit: 20 },
      });
    }

    // Low-beta / defensive
    if (lower.includes('defensive') || lower.includes('low beta') || lower.includes('safe') || lower.includes('conservative')) {
      screens.push({
        label: 'LOW-BETA DEFENSIVE STOCKS (beta < 0.8)',
        filters: { betaMax: 0.8, betaMin: 0, marketCapMin: 5e9, country: 'US', isActivelyTrading: true, limit: 20 },
      });
    }

    // Value / undervalued — use low price + high market cap as proxy
    if (lower.includes('value') || lower.includes('undervalued') || lower.includes('cheap')) {
      screens.push({
        label: 'VALUE STOCKS (large-cap, lower price)',
        filters: { priceMax: 50, marketCapMin: 5e9, country: 'US', isActivelyTrading: true, limit: 20 },
      });
    }

    // Run all screens in parallel
    const screenResults = await Promise.all(
      screens.map(async ({ label, filters }) => {
        try {
          const stocks = await marketData.screenStocks(filters);
          if (stocks.length === 0) return null;
          const lines = stocks.slice(0, 15).map(s => {
            const vol = s.regularMarketVolume ? (s.regularMarketVolume / 1e6).toFixed(1) + 'M' : 'N/A';
            const cap = s.marketCap ? '$' + (s.marketCap / 1e9).toFixed(1) + 'B' : 'N/A';
            const beta = s.beta != null ? s.beta.toFixed(2) : 'N/A';
            const div = s.lastDividend != null ? '$' + s.lastDividend.toFixed(2) : 'N/A';
            return `  ${s.symbol} (${s.shortName || '?'}) | Price: $${s.regularMarketPrice?.toFixed(2) || '?'} | Vol: ${vol} | MktCap: ${cap} | Beta: ${beta} | Div: ${div} | Sector: ${s.sector || 'N/A'}`;
          });
          return `SCREENER — ${label} (${stocks.length} results):\n${lines.join('\n')}`;
        } catch (err) {
          console.warn(`[AgentSwarm] Screen "${label}" failed:`, err.message);
          return null;
        }
      })
    );

    return screenResults.filter(Boolean);
  }

  _extractTickers(query) {
    // Match uppercase words 1-5 chars that look like stock tickers
    const words = query.match(/\b[A-Z]{1,5}\b/g) || [];
    // Filter out common English words
    const stopWords = new Set([
      'THE', 'FOR', 'AND', 'BUT', 'NOT', 'YOU', 'ALL', 'CAN', 'HER', 'WAS',
      'ONE', 'OUR', 'OUT', 'ARE', 'HAS', 'HIS', 'HOW', 'ITS', 'MAY', 'NEW',
      'NOW', 'OLD', 'SEE', 'WAY', 'WHO', 'DID', 'GET', 'HAS', 'HIM', 'LET',
      'SAY', 'SHE', 'TOO', 'USE', 'TOP', 'BEST', 'MOST', 'WHAT', 'WITH',
      'THAT', 'THIS', 'WILL', 'YOUR', 'FROM', 'THEY', 'BEEN', 'HAVE', 'MANY',
      'SOME', 'THEM', 'THAN', 'EACH', 'MAKE', 'LIKE', 'INTO', 'OVER', 'SUCH',
      'TECH', 'BUY', 'SELL', 'HOLD', 'IPO', 'ETF', 'GDP', 'FED', 'SEC',
    ]);
    return [...new Set(words.filter(w => !stopWords.has(w)))];
  }

  _formatSnapshot(s) {
    const lines = [`${s.ticker} (${s.name || s.ticker}):`];
    if (s.price != null) lines.push(`  Price: $${s.price}`);
    if (s.changePercent != null) lines.push(`  Daily Change: ${s.changePercent > 0 ? '+' : ''}${s.changePercent.toFixed(2)}%`);
    if (s.volume) lines.push(`  Volume: ${Number(s.volume).toLocaleString()}`);
    if (s.marketCap) lines.push(`  Market Cap: $${(s.marketCap / 1e9).toFixed(2)}B`);
    if (s.pe) lines.push(`  P/E: ${s.pe}`);
    if (s.eps) lines.push(`  EPS: $${s.eps}`);
    if (s.sma50) lines.push(`  SMA(50): $${s.sma50}`);
    if (s.sma200) lines.push(`  SMA(200): $${s.sma200}`);
    if (s.rsi14) lines.push(`  RSI(14): ${s.rsi14}`);
    if (s.fiftyTwoWeekHigh) lines.push(`  52W High: $${s.fiftyTwoWeekHigh}`);
    if (s.fiftyTwoWeekLow) lines.push(`  52W Low: $${s.fiftyTwoWeekLow}`);
    if (s.beta) lines.push(`  Beta: ${s.beta}`);
    if (s.divYield) lines.push(`  Div Yield: ${s.divYield.toFixed(2)}%`);
    if (s.roe) lines.push(`  ROE: ${s.roe.toFixed(2)}%`);
    if (s.profitMargin) lines.push(`  Profit Margin: ${s.profitMargin.toFixed(2)}%`);
    lines.push(`  Data as of: ${s.timestamp}`);
    return lines.join('\n');
  }

  // ── Step 1: Decompose ────────────────────────────────────────────────

  async _decompose(query) {
    const prompt = `You are a research coordinator. Break this query into 2-6 specific, independent research sub-tasks that can run in parallel. Each agent will have web search access.

Query: "${query}"

Respond with ONLY a JSON array. No markdown, no explanation, just the array:
[
  {"role": "Role Name", "task": "Specific research task description"},
  {"role": "Role Name", "task": "Specific research task description"}
]

Make tasks specific and non-overlapping. Each should produce independently useful findings.`;

    const response = await this._llmCall(prompt, false);
    return this._parseSubtasks(response);
  }

  _parseSubtasks(response) {
    try {
      // Extract JSON array from response (may have extra text around it)
      const match = response.match(/\[[\s\S]*\]/);
      if (!match) throw new Error('No JSON array found');
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Empty array');

      // Validate and cap at 6
      return parsed
        .filter(t => t.role && t.task)
        .slice(0, 6)
        .map(t => ({ role: String(t.role), task: String(t.task) }));
    } catch (err) {
      console.error('[AgentSwarm] Failed to parse subtasks, using default split:', err.message);
      // Fallback: create 3 generic research angles
      return [
        { role: 'News Analyst', task: `Search for the latest news and developments related to: ${this._truncate(arguments[0] || 'the query', 200)}` },
        { role: 'Data Analyst', task: `Find specific data, statistics, and financial metrics related to: ${this._truncate(arguments[0] || 'the query', 200)}` },
        { role: 'Risk Analyst', task: `Assess risks, challenges, and contrarian viewpoints related to: ${this._truncate(arguments[0] || 'the query', 200)}` },
      ];
    }
  }

  // ── Step 2: Run agents in parallel ───────────────────────────────────

  async _runAgents(subtasks, progress, realTimeContext = '') {
    const promises = subtasks.map(async (subtask, i) => {
      const label = `[${i + 1}/${subtasks.length}] ${subtask.role}`;
      try {
        progress(`${label}: researching...`);

        let agentPrompt = `You are a ${subtask.role}. Your specific research task:

${subtask.task}`;

        if (realTimeContext) {
          agentPrompt += `

${ragEnforcementBlock()}

--- REAL-TIME DATA (current as of ${todayString()}) ---
${realTimeContext}
--- END REAL-TIME DATA ---

Use the real-time data above as your sole source of truth for any prices, events, or metrics after ${MODEL_CUTOFF}. Do NOT reference outdated training data.`;
        }

        agentPrompt += `

Provide a detailed, factual report with:
- Specific data points, numbers, and dates from the data provided
- Key takeaways clearly highlighted
Be thorough but structured. Use bullet points for clarity.`;

        const result = await this._llmCall(agentPrompt, true);
        progress(`${label}: done.`);
        return { role: subtask.role, task: subtask.task, result, failed: false };
      } catch (err) {
        console.error(`[AgentSwarm] Agent "${subtask.role}" failed:`, err.message);
        progress(`${label}: failed (${err.message})`);
        return { role: subtask.role, task: subtask.task, result: `Research failed: ${err.message}`, failed: true };
      }
    });

    return Promise.all(promises);
  }

  // ── Step 3: Synthesize ───────────────────────────────────────────────

  async _synthesize(originalQuery, agentResults) {
    const findings = agentResults.map(r =>
      `### ${r.role}\n**Task:** ${r.task}\n**Findings:**\n${r.result}`
    ).join('\n\n---\n\n');

    const prompt = `You are a senior research analyst. Multiple research agents have completed their parallel investigations. Synthesize all findings into one clear, well-structured response.

Original query: "${originalQuery}"

--- AGENT FINDINGS ---
${findings}
--- END FINDINGS ---

Write a comprehensive synthesis that:
1. Opens with a direct answer/overview (2-3 sentences)
2. Organizes key findings by theme (use **bold** headers)
3. Includes specific numbers, data points, and sources from the agents
4. Notes any conflicting information between agents
5. Ends with a clear conclusion or recommendation

Keep it under 1800 characters total (Discord limit). Use markdown formatting.`;

    return this._llmCall(prompt, false);
  }

  // ── LLM call (Kimi with web search → Ollama + SearXNG fallback) ─────

  async _llmCall(prompt, withWebSearch = false) {
    if (this.kimiEnabled) {
      return this._kimiCall(prompt, withWebSearch);
    }
    return this._ollamaCall(prompt, withWebSearch);
  }

  /**
   * Kimi API call with optional $web_search built-in tool.
   * Handles the tool-call loop (Moonshot executes search server-side).
   */
  async _kimiCall(prompt, withWebSearch) {
    const url = `${config.kimiBaseUrl}/chat/completions`;
    const headers = {
      'Authorization': `Bearer ${config.kimiApiKey}`,
      'Content-Type': 'application/json',
    };

    let messages = [{ role: 'user', content: prompt }];
    const maxIterations = 5;

    for (let i = 0; i < maxIterations; i++) {
      const body = {
        model: config.kimiModel,
        messages,
        temperature: 0.6,
        max_tokens: 4096,
      };
      if (withWebSearch) {
        body.tools = KIMI_TOOLS;
      }

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

      if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
        messages.push(choice.message);

        for (const toolCall of choice.message.tool_calls) {
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: toolCall.function.arguments,
          });
        }
        continue;
      }

      return choice.message.content || '';
    }

    return 'Agent reached maximum search iterations without a final answer.';
  }

  /**
   * Ollama fallback. If web search is requested, runs SearXNG first
   * and injects results into the prompt.
   */
  async _ollamaCall(prompt, withWebSearch) {
    let enrichedPrompt = prompt;

    if (withWebSearch && config.searxngUrl) {
      try {
        // Extract a good search query from the prompt
        // Try "task:" line first, then "research task:" block, then first meaningful line
        let searchQuery = '';
        const taskMatch = prompt.match(/(?:research )?task[:\s]*\n\s*(.+?)(?:\n|$)/i);
        if (taskMatch) {
          searchQuery = taskMatch[1].trim();
        } else {
          // Use the first non-boilerplate line after "You are a..."
          const lines = prompt.split('\n').filter(l => l.trim().length > 10);
          searchQuery = lines.find(l => !l.startsWith('You are') && !l.startsWith('---') && !l.startsWith('IMPORTANT')) || '';
        }
        searchQuery = searchQuery.slice(0, 150).replace(/[*_#]/g, '').trim();
        if (!searchQuery) searchQuery = prompt.slice(0, 100);

        const searchResult = await webSearch(searchQuery, 5);
        if (!searchResult.error && searchResult.results?.length > 0) {
          const formatted = formatResultsForAI(searchResult);
          enrichedPrompt = `${prompt}\n\nADDITIONAL WEB SEARCH RESULTS:\n${formatted}`;
        }
      } catch (err) {
        console.error('[AgentSwarm] SearXNG search failed:', err.message);
      }
    }

    try {
      const stream = await this.ollama.chat({
        model: this.model,
        messages: [{ role: 'user', content: enrichedPrompt }],
        stream: true,
      });

      let result = '';
      for await (const part of stream) {
        const content = part.message?.content;
        if (content) result += content;
      }
      // Strip thinking tags (qwen3, deepseek, etc.)
      result = result
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<\|think\|>[\s\S]*?<\|\/think\|>/gi, '')
        .trim();
      return result;
    } catch (err) {
      console.error('[AgentSwarm] Ollama call error:', err.message);
      throw err;
    }
  }

  // ── Discord formatting ───────────────────────────────────────────────

  formatForDiscord(result) {
    const lines = [
      `**Agent Swarm Research** _(${result.taskCount} parallel agents)_\n`,
      result.synthesis,
    ];

    // Agent status summary
    const statuses = result.agents.map(a => {
      const icon = a.failed ? '❌' : '✅';
      return `${icon} ${a.role}`;
    });
    lines.push(`\n_Agents: ${statuses.join(' | ')}_`);
    lines.push(`_${new Date().toLocaleString()}_`);

    let output = lines.join('\n');
    if (output.length > 1950) {
      output = output.slice(0, 1950) + '\n...';
    }
    return output;
  }

  formatDetailedReport(result) {
    const sections = [
      `# Agent Swarm Research Report`,
      `Query completed at: ${new Date().toISOString()}`,
      `Agents deployed: ${result.taskCount}`,
      '',
    ];

    for (const agent of result.agents) {
      sections.push(`## ${agent.role}`);
      sections.push(`**Task:** ${agent.task}`);
      sections.push(agent.failed ? `**Status:** FAILED` : agent.result);
      sections.push('');
    }

    sections.push('## Synthesized Findings');
    sections.push(result.synthesis);

    return sections.join('\n');
  }

  _truncate(str, len) {
    return str.length > len ? str.slice(0, len) + '...' : str;
  }
}

module.exports = new AgentSwarm();
