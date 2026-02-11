/**
 * Kalshi Prediction Market — Read-only API client with AI betting recommendations.
 *
 * Kalshi is a regulated prediction market exchange. Users buy Yes/No contracts
 * on real-world events (elections, inflation, crypto prices, weather, etc.).
 * A Yes price of 65 means the market implies a 65% probability.
 *
 * This client is read-only — no auth required for public market data.
 * The AI layer cross-references market odds with fundamentals, technicals,
 * and sentiment to find edge (mispricings the market hasn't caught yet).
 *
 * API Base: https://api.elections.kalshi.com/trade-api/v2
 * Rate limit: 20 reads/sec (Basic tier, free)
 *
 * Important: Kalshi uses status="active" (not "open") for live markets.
 * Market tickers look like KXBTC-26FEB14-T98000.
 * Event tickers look like KXBTC-26FEB14.
 * Series tickers look like KXBTC.
 */

const { Ollama } = require('ollama');
const config = require('../config');
const log = require('../logger')('Kalshi');
const { todayString, ragEnforcementBlock } = require('../date-awareness');

const BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';
const FETCH_TIMEOUT = 15000;

// In-memory cache to avoid hammering the API
const cache = new Map();
const CACHE_TTL = 120_000; // 2 minutes

class KalshiService {
  constructor() {
    const opts = { host: config.ollamaHost };
    if (config.ollamaApiKey) {
      opts.headers = { Authorization: `Bearer ${config.ollamaApiKey}` };
    }
    this.ollama = new Ollama(opts);
    this.model = config.ollamaModel;
    log.info('Kalshi prediction market client initialized (read-only, no auth)');
  }

  setModel(modelName) {
    this.model = modelName;
  }

  // ── Core Fetch Helper ──────────────────────────────────────────────

  async _fetch(path, params = {}) {
    const url = new URL(`${BASE_URL}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, String(v));
    }

    const cacheKey = url.toString();
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return cached.data;
    }

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Kalshi ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json();
    cache.set(cacheKey, { data, ts: Date.now() });
    return data;
  }

  // ── Market Data Endpoints ──────────────────────────────────────────

  /** List events (prediction market categories) */
  async getEvents({ status, limit = 50, cursor, seriesTicker, withMarkets = false } = {}) {
    const params = { limit, with_nested_markets: withMarkets };
    if (status) params.status = status;
    if (cursor) params.cursor = cursor;
    if (seriesTicker) params.series_ticker = seriesTicker;
    return this._fetch('/events', params);
  }

  /** Get a single event with its markets */
  async getEvent(eventTicker) {
    return this._fetch(`/events/${encodeURIComponent(eventTicker)}`, {
      with_nested_markets: true,
    });
  }

  /** List markets with filtering — no status filter by default to get all active markets */
  async getMarkets({ limit = 200, cursor, eventTicker, seriesTicker, tickers } = {}) {
    const params = { limit };
    if (cursor) params.cursor = cursor;
    if (eventTicker) params.event_ticker = eventTicker;
    if (seriesTicker) params.series_ticker = seriesTicker;
    if (tickers) params.tickers = tickers;
    return this._fetch('/markets', params);
  }

  /** Get a single market by ticker */
  async getMarket(ticker) {
    const data = await this._fetch(`/markets/${encodeURIComponent(ticker)}`);
    return data.market || data;
  }

  /** Get recent trades for a market */
  async getTrades(ticker, limit = 20) {
    return this._fetch('/markets/trades', { ticker, limit });
  }

  /** List series (recurring event templates) */
  async getSeries({ limit = 50 } = {}) {
    return this._fetch('/series', { limit });
  }

  /** Exchange status */
  async getExchangeStatus() {
    return this._fetch('/exchange/status');
  }

  // ── Search / Discovery ─────────────────────────────────────────────

  /**
   * Build searchable text from a market object.
   * Combines all text fields for keyword matching.
   */
  _marketSearchText(m) {
    return [
      m.title || '',
      m.subtitle || '',
      m.yes_sub_title || '',
      m.no_sub_title || '',
      m.ticker || '',
      m.event_ticker || '',
      m.rules_primary || '',
    ].join(' ').toLowerCase();
  }

  /**
   * Fetch a large batch of markets for client-side search.
   * No status filter — the API returns active/live markets by default.
   */
  async _fetchMarketBatch(pages = 3) {
    const allMarkets = [];
    let cursor = null;

    for (let page = 0; page < pages; page++) {
      const params = { limit: 1000 };
      if (cursor) params.cursor = cursor;

      const result = await this._fetch('/markets', params);
      const markets = result.markets || [];
      allMarkets.push(...markets);

      cursor = result.cursor;
      if (!cursor || markets.length === 0) break;
    }

    return allMarkets;
  }

  /**
   * Search for markets by keyword. Kalshi doesn't have a text search endpoint,
   * so we fetch markets and filter client-side across all text fields.
   * Supports multi-word queries (all words must match).
   *
   * Also tries events-first search and known series tickers for common queries
   * to improve coverage when the market batch misses niche categories.
   */
  async searchMarkets(query, limit = 10) {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    if (words.length === 0) return [];

    const allMatches = new Map(); // ticker → market (dedupe across strategies)

    // ── Strategy 1: Fetch market batch and filter (primary, fast) ──
    const allMarkets = await this._fetchMarketBatch(3);

    for (const m of allMarkets) {
      const text = this._marketSearchText(m);
      if (words.every(w => text.includes(w))) {
        allMatches.set(m.ticker, m);
      }
    }

    // ── Strategy 2: Search events with nested markets (catches categorized markets) ──
    if (allMatches.size < limit) {
      try {
        let cursor = null;
        for (let page = 0; page < 3; page++) {
          const params = { limit: 100, with_nested_markets: true };
          if (cursor) params.cursor = cursor;

          const result = await this._fetch('/events', params);
          const events = result.events || [];

          for (const event of events) {
            const eventText = `${event.title || ''} ${event.sub_title || ''} ${event.category || ''} ${event.event_ticker || ''}`.toLowerCase();
            if (words.every(w => eventText.includes(w))) {
              for (const m of (event.markets || [])) {
                allMatches.set(m.ticker, m);
              }
            }
          }

          cursor = result.cursor;
          if (!cursor || events.length === 0) break;
          if (allMatches.size >= limit * 3) break;
        }
      } catch (err) {
        log.warn(`Event search failed: ${err.message}`);
      }
    }

    // ── Strategy 3: Known series tickers for common queries ──
    if (allMatches.size < limit) {
      const seriesMap = {
        bitcoin: ['KXBTC', 'KXBTCRESERVESTATES', 'KXELSALVADORBTC', 'KXTEXASBTC'],
        btc: ['KXBTC', 'KXBTCRESERVESTATES'],
        crypto: ['KXBTC', 'KXBTCRESERVESTATES'],
        fed: ['TERMINALRATE'],
        'interest rate': ['TERMINALRATE'],
      };

      const lower = query.toLowerCase();
      const matchingSeries = Object.entries(seriesMap)
        .filter(([kw]) => lower.includes(kw))
        .flatMap(([, tickers]) => tickers);

      for (const seriesTicker of [...new Set(matchingSeries)]) {
        try {
          const result = await this._fetch('/events', {
            series_ticker: seriesTicker,
            with_nested_markets: true,
            limit: 50,
          });
          for (const event of (result.events || [])) {
            for (const m of (event.markets || [])) {
              allMatches.set(m.ticker, m);
            }
          }
        } catch (err) {
          log.warn(`Series ${seriesTicker} fetch failed: ${err.message}`);
        }
      }
    }

    // Sort by volume (most active first), then by 24h volume
    const sorted = [...allMatches.values()];
    sorted.sort((a, b) => (b.volume_24h || b.volume || 0) - (a.volume_24h || a.volume || 0));

    return sorted.slice(0, limit);
  }

  /**
   * Get trending/hot markets — most 24h volume.
   */
  async getTrendingMarkets(limit = 15) {
    const allMarkets = await this._fetchMarketBatch(2);

    // Sort by 24h volume (most recently active), fallback to total volume
    allMarkets.sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0) || (b.volume || 0) - (a.volume || 0));

    return allMarkets.slice(0, limit);
  }

  /**
   * Get markets by category keyword (economics, crypto, politics, tech, etc.)
   */
  async getMarketsByCategory(category, limit = 10) {
    // Map common categories to likely keyword matches
    const categoryMap = {
      economics: ['inflation', 'gdp', 'fed', 'interest rate', 'cpi', 'jobs', 'unemployment', 'recession', 'tariff'],
      crypto: ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'solana', 'sol', 'coin'],
      politics: ['president', 'election', 'congress', 'senate', 'democrat', 'republican', 'trump', 'biden', 'governor', 'vote'],
      tech: ['ai', 'openai', 'google', 'apple', 'tesla', 'meta', 'nvidia', 'microsoft', 'tiktok'],
      markets: ['s&p', 'sp500', 'nasdaq', 'dow', 'stock', 'market', 'spy', 'index'],
      weather: ['temperature', 'weather', 'hurricane', 'rainfall', 'climate'],
      sports: ['nfl', 'nba', 'mlb', 'super bowl', 'world series', 'nhl', 'ufc', 'game'],
    };

    const keywords = categoryMap[category.toLowerCase()] || [category.toLowerCase()];

    const allMarkets = await this._fetchMarketBatch(3);

    const matches = allMarkets.filter(m => {
      const text = this._marketSearchText(m);
      return keywords.some(kw => text.includes(kw));
    });

    matches.sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0) || (b.volume || 0) - (a.volume || 0));
    return matches.slice(0, limit);
  }

  // ── Data Formatting ─────────────────────────────────────────────────

  /** Format a single market for display */
  formatMarket(m) {
    const yesPrice = m.yes_ask ?? m.last_price ?? m.yes_bid ?? null;
    const noPrice = yesPrice != null ? (100 - yesPrice) : null;
    const prob = yesPrice != null ? `${yesPrice}%` : 'N/A';
    const volume = m.volume ? Number(m.volume).toLocaleString() : '0';
    const volume24h = m.volume_24h ? Number(m.volume_24h).toLocaleString() : null;
    const openInterest = m.open_interest ? Number(m.open_interest).toLocaleString() : null;

    const closeDate = m.close_time || m.expected_expiration_time || m.expiration_time;
    const closeDateStr = closeDate ? new Date(closeDate).toLocaleDateString() : 'TBD';

    // Build a descriptive title — combine title + yes_sub_title when available
    let title = m.title || m.ticker;
    if (m.yes_sub_title && m.title && !m.title.includes(m.yes_sub_title)) {
      title = `${m.title}: ${m.yes_sub_title}`;
    }

    return {
      ticker: m.ticker,
      title,
      subtitle: m.subtitle || m.yes_sub_title || '',
      yesPrice,
      noPrice,
      prob,
      volume,
      volume24h,
      openInterest,
      closeDateStr,
      status: m.status || 'active',
      eventTicker: m.event_ticker,
    };
  }

  /** Format market list for Discord */
  formatMarketsForDiscord(markets, title = 'Prediction Markets') {
    if (!markets || markets.length === 0) {
      return `**${title}**\nNo markets found.`;
    }

    const lines = [`**${title}**\n`];

    for (let i = 0; i < markets.length; i++) {
      const m = this.formatMarket(markets[i]);
      const probEmoji = m.yesPrice >= 70 ? '🟢' : m.yesPrice <= 30 ? '🔴' : '🟡';
      const vol24h = m.volume24h ? ` (24h: ${m.volume24h})` : '';
      lines.push(`${probEmoji} **${m.title}**`);
      lines.push(`   Yes: \`${m.prob}\` | Vol: \`${m.volume}\`${vol24h} | Closes: \`${m.closeDateStr}\` | \`${m.ticker}\``);
      if (i < markets.length - 1) lines.push('');
    }

    lines.push(`\n_Data via Kalshi | ${new Date().toLocaleString()}_`);

    let output = lines.join('\n');
    if (output.length > 1950) output = output.slice(0, 1950) + '\n...';
    return output;
  }

  /** Format detailed single-market view for Discord */
  formatMarketDetailForDiscord(market, trades) {
    const m = this.formatMarket(market);
    const probEmoji = m.yesPrice >= 70 ? '🟢' : m.yesPrice <= 30 ? '🔴' : '🟡';

    const lines = [
      `${probEmoji} **${m.title}**`,
      m.subtitle && m.subtitle !== m.title ? `_${m.subtitle}_` : '',
      '',
      `**Yes Price:** \`${m.prob}\` ($${((m.yesPrice || 0) / 100).toFixed(2)}/contract)`,
      `**No Price:** \`${m.noPrice != null ? m.noPrice + '%' : 'N/A'}\` ($${((m.noPrice || 0) / 100).toFixed(2)}/contract)`,
      `**Volume:** \`${m.volume}\` contracts${m.volume24h ? ` (24h: ${m.volume24h})` : ''}`,
      m.openInterest ? `**Open Interest:** \`${m.openInterest}\`` : '',
      `**Closes:** \`${m.closeDateStr}\``,
      `**Status:** \`${m.status}\``,
      `**Ticker:** \`${m.ticker}\``,
    ].filter(Boolean);

    // Rules/description
    if (market.rules_primary) {
      const rules = market.rules_primary.slice(0, 200);
      lines.push('');
      lines.push(`**Rules:** _${rules}${market.rules_primary.length > 200 ? '...' : ''}_`);
    }

    // Recent trades
    if (trades && trades.trades && trades.trades.length > 0) {
      lines.push('');
      lines.push('**Recent Trades:**');
      for (const t of trades.trades.slice(0, 5)) {
        const side = t.taker_side === 'yes' ? '🟢 Yes' : '🔴 No';
        const price = t.yes_price || t.price;
        const count = t.count || 1;
        const ts = t.created_time ? new Date(t.created_time).toLocaleTimeString() : '';
        lines.push(`  ${side} @ \`${price}c\` x${count} ${ts}`);
      }
    }

    lines.push(`\n_Data via Kalshi | ${new Date().toLocaleString()}_`);
    return lines.join('\n');
  }

  // ── AI Betting Recommendations ──────────────────────────────────────

  /**
   * Analyze markets and produce AI betting recommendations.
   * Cross-references Kalshi odds with reasoning to find potential edge.
   */
  async analyzeBets(markets, query) {
    if (!markets || markets.length === 0) return null;

    const marketSummary = markets.map(m => {
      const fm = this.formatMarket(m);
      return `- "${fm.title}" | Yes: ${fm.prob} | Volume: ${fm.volume} | Closes: ${fm.closeDateStr} | Ticker: ${fm.ticker}`;
    }).join('\n');

    const prompt = `You are a prediction market analyst. The user searched for "${query}" and found these Kalshi prediction markets:

${marketSummary}

TODAY'S DATE: ${todayString()}

For each market, analyze:
1. Does the current Yes price (implied probability) seem accurate based on available evidence?
2. Where might the market be WRONG? (This is where edge exists)
3. What factors could shift this market's odds significantly before it closes?

Then produce your TOP PICKS — markets where you see the biggest edge (probability mispricing).

FORMAT YOUR RESPONSE EXACTLY LIKE THIS:

TOP PICKS:

🎯 PICK 1: [market title]
Side: YES/NO @ [current price]c
Edge: [your estimated true probability]% vs market's [market price]%
Reasoning: [2-3 sentences explaining why the market is mispriced]
Confidence: [1-10]

🎯 PICK 2: [market title]
Side: YES/NO @ [current price]c
Edge: [your estimated true probability]% vs market's [market price]%
Reasoning: [2-3 sentences]
Confidence: [1-10]

(Continue for up to 3 picks, only pick markets where you see real edge)

AVOID: Markets where the current price seems about right — only recommend where you see genuine mispricing.

End with:
SUMMARY: One sentence with your overall take on this market category.`;

    const response = await this._llmCall(prompt);
    return response;
  }

  /**
   * Deep analysis of a single market — probability assessment + recommendation.
   */
  async analyzeMarket(market, trades) {
    const fm = this.formatMarket(market);

    let tradeContext = '';
    if (trades && trades.trades && trades.trades.length > 0) {
      const recentTrades = trades.trades.slice(0, 15);
      const yesTrades = recentTrades.filter(t => t.taker_side === 'yes').length;
      const noTrades = recentTrades.filter(t => t.taker_side === 'no').length;
      const prices = recentTrades.map(t => t.yes_price || t.price).filter(Boolean);
      const avgPrice = prices.length > 0 ? (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(1) : 'N/A';
      const minPrice = prices.length > 0 ? Math.min(...prices) : 'N/A';
      const maxPrice = prices.length > 0 ? Math.max(...prices) : 'N/A';

      tradeContext = `
RECENT TRADE FLOW:
- Total trades analyzed: ${recentTrades.length}
- Yes-side takers: ${yesTrades} | No-side takers: ${noTrades}
- Flow bias: ${yesTrades > noTrades ? 'MORE YES BUYERS' : noTrades > yesTrades ? 'MORE NO BUYERS' : 'BALANCED'}
- Price range: ${minPrice}c — ${maxPrice}c (avg: ${avgPrice}c)`;
    }

    const rulesContext = market.rules_primary ? `\nRules: ${market.rules_primary.slice(0, 500)}` : '';

    const prompt = `You are a senior prediction market analyst specializing in probability assessment.

MARKET: "${fm.title}"
${fm.subtitle && fm.subtitle !== fm.title ? `Context: ${fm.subtitle}` : ''}
Current Yes Price: ${fm.prob} (the market says there's a ${fm.prob} chance this happens)
Volume: ${fm.volume} contracts traded
Closes: ${fm.closeDateStr}
Ticker: ${fm.ticker}${rulesContext}
${tradeContext}

TODAY'S DATE: ${todayString()}

Perform a deep probability analysis:

1. MARKET ASSESSMENT: What is the market saying at ${fm.prob}? Is this price reflecting consensus?
2. YOUR ESTIMATE: Based on available evidence, what do YOU think the true probability is? Explain your reasoning.
3. TRADE FLOW: What does the recent trade flow tell us about market sentiment direction?
4. CATALYSTS: What upcoming events could move this market significantly?
5. EDGE ANALYSIS: Is there a bet worth making here?

FORMAT YOUR RESPONSE:

PROBABILITY ASSESSMENT:
Market Price: ${fm.prob}
My Estimate: [your estimate]%
Edge: [difference]% — [explain if this is significant enough to trade]

RECOMMENDATION:
Side: BUY YES / BUY NO / NO BET
Entry: [price you'd want to enter at]c
Reasoning: [3-4 sentences with specific reasoning]

KEY RISKS:
- [risk 1]
- [risk 2]

CONVICTION: [1-10]`;

    const response = await this._llmCall(prompt);
    return response;
  }

  // ── LLM Helper ─────────────────────────────────────────────────────

  async _llmCall(prompt) {
    const LLM_TIMEOUT = 90_000;

    const systemMsg = `${ragEnforcementBlock()}

You are a prediction market analyst. You assess probabilities rigorously and identify mispricings.
Today is ${todayString()}. Use current events and data to inform your probability estimates.
Be specific with numbers. Don't hedge excessively — take clear positions when you see edge.
If you genuinely don't see edge, say so — don't force a recommendation.`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT);

      try {
        const stream = await this.ollama.chat({
          model: this.model,
          messages: [
            { role: 'system', content: systemMsg },
            { role: 'user', content: prompt },
          ],
          stream: true,
        });

        let result = '';
        for await (const part of stream) {
          if (controller.signal.aborted) break;
          const content = part.message?.content;
          if (content) result += content;
        }

        clearTimeout(timeout);

        // Strip thinking tags
        result = result
          .replace(/<think>[\s\S]*?<\/think>/gi, '')
          .replace(/<\|think\|>[\s\S]*?<\|\/think\|>/gi, '')
          .trim();

        if (!result || result.length < 30) {
          return 'AI analysis unavailable — model returned insufficient output.';
        }

        return result;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      const isTimeout = err.name === 'AbortError' || err.message?.includes('abort');
      log.error(`LLM call ${isTimeout ? 'timeout' : 'error'}:`, err.message);
      return `AI analysis unavailable: ${err.message}`;
    }
  }
}

module.exports = new KalshiService();
