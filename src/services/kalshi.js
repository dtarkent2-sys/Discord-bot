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
   * Fetch events with nested markets, tagging each market with its event's category.
   * Uses the /events endpoint which has an authoritative `category` field
   * (e.g. "Sports", "Economics", "Politics") — far more reliable than
   * guessing from ticker strings.
   *
   * @param {number} pages - Number of pages to fetch
   * @param {object} opts
   * @param {boolean} opts.excludeSports - Skip sports/esports events entirely
   * @returns {Array} Markets enriched with _category and _eventTitle
   */
  async _fetchEventBatch(pages = 3, { excludeSports = false } = {}) {
    const allMarkets = [];
    let cursor = null;

    for (let page = 0; page < pages; page++) {
      const params = { limit: 200, with_nested_markets: true };
      if (cursor) params.cursor = cursor;

      const result = await this._fetch('/events', params);
      const events = result.events || [];

      for (const event of events) {
        const category = (event.category || '').toLowerCase();

        // Skip sports entirely if requested
        if (excludeSports && (category === 'sports' || category === 'esports')) continue;

        for (const m of (event.markets || [])) {
          m._category = category;
          m._eventTitle = event.title || '';
          allMarkets.push(m);
        }
      }

      cursor = result.cursor;
      if (!cursor || events.length === 0) break;
    }

    return allMarkets;
  }

  /**
   * Detect if a market is a sports/game betting market.
   * Primarily uses the _category tag set by _fetchEventBatch (authoritative).
   * Falls back to ticker/title pattern matching for markets from other sources.
   */
  _isSportsMarket(m) {
    // Primary: use the event category tag (set by _fetchEventBatch)
    const cat = (m._category || m.category || '').toLowerCase();
    if (cat === 'sports' || cat === 'esports') return true;
    // If we have a known non-sports category, trust it
    if (cat && cat !== 'sports' && cat !== 'esports') return false;

    // Fallback: ticker pattern matching for untagged markets (e.g., from /markets endpoint)
    const ticker = (m.event_ticker || m.ticker || '').toUpperCase();
    const sportsTickerParts = [
      'NBA', 'NFL', 'MLB', 'NHL', 'MLS', 'WNBA', 'NCAAB', 'NCAAF', 'NCAAM',
      'UFC', 'PGA', 'LIV', 'LPGA', 'ATP', 'WTA', 'NASCAR',
      'EPL', 'LALIGA', 'SOCCER', 'FIFAWC',
      'CRICKET', 'IPL', 'CFL', 'XFL', 'CFB',
    ];
    return sportsTickerParts.some(s => ticker.includes(s));
  }

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

    // ── Strategy 1: Fetch events with nested markets (has category data) ──
    // Uses /events endpoint which tags each market with its event category,
    // so we can reliably distinguish sports from non-sports.
    const allMarkets = await this._fetchEventBatch(3);

    for (const m of allMarkets) {
      const text = this._marketSearchText(m);
      if (words.every(w => text.includes(w))) {
        allMatches.set(m.ticker, m);
      }
    }

    // ── Strategy 2: Known series tickers for common queries ──
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

    // Filter out sports unless the query is sports-related
    const sportsQueries = ['nfl', 'nba', 'mlb', 'nhl', 'ufc', 'pga', 'soccer', 'football', 'basketball', 'baseball', 'hockey', 'sports', 'game', 'super bowl', 'world series', 'march madness', 'playoff'];
    const isSportsQuery = sportsQueries.some(sq => query.toLowerCase().includes(sq));

    let sorted = [...allMatches.values()];

    if (!isSportsQuery) {
      sorted = sorted.filter(m => !this._isSportsMarket(m));
    }

    // Sort by volume (most active first), then by 24h volume
    sorted.sort((a, b) => (b.volume_24h || b.volume || 0) - (a.volume_24h || a.volume || 0));

    return sorted.slice(0, limit);
  }

  /**
   * Get trending/hot markets — most 24h volume, diversified across categories.
   * Uses the events endpoint (has authoritative category field) and excludes
   * sports, which dominate Kalshi by 10-100x volume and drown out everything.
   */
  async getTrendingMarkets(limit = 15) {
    // Fetch non-sports markets via events endpoint (authoritative category)
    const nonSports = await this._fetchEventBatch(3, { excludeSports: true });

    // Sort by 24h volume
    nonSports.sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0) || (b.volume || 0) - (a.volume || 0));

    return nonSports.slice(0, limit);
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

    const isSportsCategory = category.toLowerCase() === 'sports';
    // Use event-based fetch — excludes sports automatically for non-sports categories
    const allMarkets = await this._fetchEventBatch(3, { excludeSports: !isSportsCategory });

    const matches = allMarkets.filter(m => {
      const text = this._marketSearchText(m);
      return keywords.some(kw => text.includes(kw));
    });

    matches.sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0) || (b.volume || 0) - (a.volume || 0));
    return matches.slice(0, limit);
  }

  // ── Data Formatting ─────────────────────────────────────────────────

  /**
   * Group markets by event_ticker and pick the best contract per event.
   * This deduplicates the wall of strike-price contracts into one per event.
   */
  _groupByEvent(markets) {
    if (!markets || markets.length === 0) return [];

    const groups = new Map(); // event_ticker → [markets]
    for (const m of markets) {
      const key = m.event_ticker || m.ticker; // solo markets use their own ticker
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }

    // For each event, pick the "best" contract
    const picks = [];
    for (const [eventTicker, contracts] of groups) {
      const best = this._pickBestContract(contracts);
      best._eventTicker = eventTicker;
      best._contractCount = contracts.length;
      best._eventVolume = contracts.reduce((s, c) => s + (c.volume_24h || c.volume || 0), 0);
      picks.push(best);
    }

    // Sort by total event volume (most active events first)
    picks.sort((a, b) => (b._eventVolume || 0) - (a._eventVolume || 0));
    return picks;
  }

  /**
   * Pick the most "interesting" contract from a set of sibling contracts.
   * Prefers: high volume + probability between 15-85% (where edge lives).
   * Avoids extreme prices (>92% or <8%) which are boring/illiquid.
   */
  _pickBestContract(contracts) {
    if (contracts.length === 1) return contracts[0];

    return contracts.reduce((best, c) => {
      const bestScore = this._contractScore(best);
      const cScore = this._contractScore(c);
      return cScore > bestScore ? c : best;
    });
  }

  _contractScore(m) {
    const price = m.yes_ask ?? m.last_price ?? m.yes_bid ?? 50;
    const vol = m.volume_24h || m.volume || 0;

    // Probability score: peak at 50%, drops toward extremes
    // Sweet spot: 15-85% range (where real bets happen)
    const probScore = price <= 8 || price >= 92 ? 0.1 :
                      price <= 15 || price >= 85 ? 0.5 :
                      price <= 30 || price >= 70 ? 0.8 : 1.0;

    // Volume score: log scale, more volume = better
    const volScore = vol > 0 ? Math.log10(vol + 1) / 5 : 0.01;

    return probScore * 2 + volScore;
  }

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

  /**
   * Format market list for Discord — groups by event so users aren't overwhelmed
   * by 20 strike-price contracts for the same underlying question.
   */
  formatMarketsForDiscord(markets, title = 'Prediction Markets') {
    if (!markets || markets.length === 0) {
      return `**${title}**\nNo markets found.`;
    }

    // Group by event — show 1 "best" contract per event
    const grouped = this._groupByEvent(markets);

    const lines = [`**${title}**\n`];

    for (let i = 0; i < Math.min(grouped.length, 10); i++) {
      const raw = grouped[i];
      const m = this.formatMarket(raw);
      const probEmoji = m.yesPrice >= 70 ? '🟢' : m.yesPrice <= 30 ? '🔴' : '🟡';
      const vol24h = m.volume24h ? ` (24h: ${m.volume24h})` : '';
      const siblings = raw._contractCount > 1 ? ` (+${raw._contractCount - 1} contracts)` : '';

      lines.push(`${probEmoji} **${m.title}**${siblings}`);
      lines.push(`   Yes: \`${m.prob}\` | Vol: \`${m.volume}\`${vol24h} | Closes: \`${m.closeDateStr}\` | \`${m.ticker}\``);
      if (i < Math.min(grouped.length, 10) - 1) lines.push('');
    }

    if (grouped.length > 10) {
      lines.push(`\n_...and ${grouped.length - 10} more events_`);
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
   * Analyze markets and produce ONE clear high-conviction play.
   * Users want a simple "here's your bet" — not a wall of analysis.
   */
  async analyzeBets(markets, query) {
    if (!markets || markets.length === 0) return null;

    // Group by event first so the AI sees unique events, not duplicate strike prices
    const grouped = this._groupByEvent(markets);
    const topEvents = grouped.slice(0, 8);

    const marketSummary = topEvents.map(m => {
      const fm = this.formatMarket(m);
      const siblings = m._contractCount > 1 ? ` [${m._contractCount} contracts in this event]` : '';
      // Include YES/NO meanings so the AI knows exactly what each side represents
      const yesMeaning = m.yes_sub_title ? ` (YES = "${m.yes_sub_title}")` : '';
      const noMeaning = m.no_sub_title ? ` (NO = "${m.no_sub_title}")` : '';
      return `- "${fm.title}" | Yes: ${fm.prob}${yesMeaning}${noMeaning} | Volume: ${fm.volume} | Closes: ${fm.closeDateStr} | Ticker: ${fm.ticker}${siblings}`;
    }).join('\n');

    const prompt = `You are a sharp prediction market trader. A user asked for a play on "${query}". Here are the available Kalshi markets:

${marketSummary}

TODAY'S DATE: ${todayString()}

IMPORTANT CONTEXT:
- Each market is a specific YES/NO question with a specific threshold (e.g. "Bitcoin above $98,000?" is DIFFERENT from "Bitcoin above $105,000?")
- "BUY YES" = you believe the specific event described WILL happen
- "BUY NO" = you believe the specific event described will NOT happen
- Your recommendation must be about THIS EXACT CONTRACT at THIS EXACT threshold — do not generalize
- Reference the specific ticker so the user knows exactly which contract to trade

Pick your #1 HIGH CONVICTION play. The user wants ONE clear bet, not a dissertation.

Analyze which market has the biggest mispricing — where the market odds are WRONG based on current evidence. Consider:
- Is the market over/underpricing the probability?
- What catalyst or trend does the market not reflect yet?
- Volume matters — illiquid markets are riskier

FORMAT YOUR RESPONSE EXACTLY LIKE THIS (keep it punchy):

🎯 **THE PLAY**
**[Full market question including the specific threshold]** (\`[TICKER]\`)
Side: **BUY [YES/NO]** @ [current price]c
Meaning: [1 sentence explaining what your bet means in plain English, e.g. "Betting Bitcoin stays above $98k by Feb 14"]
My odds: [your probability]% vs market's [their probability]%
Edge: [difference]%

**Why:** [2-3 sentences max — the core thesis for why this is mispriced]

**Key catalyst:** [1 sentence — what event/data will move this]

**Risk:** [1 sentence — what could go wrong]

**Conviction: [7-10]/10**

${topEvents.length > 3 ? `\nIf you see a second strong play, add it as:

🥈 **RUNNER-UP**
(same format but briefer)` : ''}

If you genuinely don't see edge in any of these markets, say so directly — don't force a bad pick.`;

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
    // Include what YES/NO means so the AI doesn't misinterpret the sides
    const yesMeaning = market.yes_sub_title ? `\nYES means: "${market.yes_sub_title}"` : '';
    const noMeaning = market.no_sub_title ? `\nNO means: "${market.no_sub_title}"` : '';

    const prompt = `You are a sharp prediction market trader. Give a clear, decisive analysis.

MARKET: "${fm.title}"
${fm.subtitle && fm.subtitle !== fm.title ? `Context: ${fm.subtitle}` : ''}
Current Yes Price: ${fm.prob} (market-implied probability)${yesMeaning}${noMeaning}
Volume: ${fm.volume} contracts traded
Closes: ${fm.closeDateStr}
Ticker: ${fm.ticker}${rulesContext}
${tradeContext}

TODAY'S DATE: ${todayString()}

IMPORTANT: "BUY YES" means you believe the specific event/threshold WILL happen. "BUY NO" means you believe it will NOT happen. Be precise about what you're betting on.

FORMAT YOUR RESPONSE (keep it punchy — traders don't read essays):

📊 **MARKET: ${fm.prob} implied probability**
My estimate: **[X]%** → Edge: **[diff]%**

🎯 **VERDICT: BUY YES / BUY NO / NO BET**
Meaning: [1 sentence in plain English, e.g. "Betting inflation stays above 3%"]
Entry: [price]c | Conviction: [1-10]/10

**Thesis:** [2-3 sentences — the core reasoning]

**Catalyst:** [1 sentence — what moves this next]
${tradeContext ? '\n**Flow read:** [1 sentence on what trade flow signals]' : ''}

**Risk:** [1 sentence — the bear case]

Be decisive. If you see edge, say it clearly. If you don't, say "NO BET" — don't hedge.`;

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
