/**
 * StockTwits Social Sentiment Provider
 *
 * Ported from SHARK (https://github.com/ygwyg/SHARK)
 * Fetches trending tickers and social sentiment from StockTwits.
 * No API key required — uses the free public API.
 *
 * Key data:
 *   - Trending symbols (what retail is watching)
 *   - Per-ticker message streams with bullish/bearish tags
 *   - Aggregated sentiment score (-1 to +1)
 */

const STOCKTWITS_BASE = 'https://api.stocktwits.com/api/2';

class StockTwitsService {
  constructor() {
    this._cache = new Map(); // symbol → { data, expiry }
    this._trendingCache = null;
    this._trendingExpiry = 0;
  }

  // ── Trending Symbols ──────────────────────────────────────────────

  /**
   * Get currently trending symbols on StockTwits.
   * @returns {Array<{symbol: string, watchlistCount: number, title: string}>}
   */
  async getTrending() {
    // Cache for 5 minutes
    if (this._trendingCache && Date.now() < this._trendingExpiry) {
      return this._trendingCache;
    }

    const res = await fetch(`${STOCKTWITS_BASE}/trending/symbols.json`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) throw new Error(`StockTwits API error: ${res.status}`);
    const data = await res.json();
    const symbols = (data.symbols || []).map(s => ({
      symbol: s.symbol,
      watchlistCount: s.watchlist_count || 0,
      title: s.title || s.symbol,
    }));

    this._trendingCache = symbols;
    this._trendingExpiry = Date.now() + 5 * 60 * 1000;
    return symbols;
  }

  // ── Symbol Stream ─────────────────────────────────────────────────

  /**
   * Get recent messages for a specific ticker.
   * @param {string} symbol
   * @param {number} limit
   * @returns {Array<{id: number, body: string, createdAt: string, username: string, followers: number, sentiment: string|null, symbols: string[]}>}
   */
  async getStream(symbol, limit = 30) {
    const upper = symbol.toUpperCase();

    // Cache for 2 minutes
    const cached = this._cache.get(upper);
    if (cached && Date.now() < cached.expiry) {
      return cached.data;
    }

    const res = await fetch(`${STOCKTWITS_BASE}/streams/symbol/${upper}.json?limit=${limit}`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      if (res.status === 404) return [];
      throw new Error(`StockTwits API error for ${upper}: ${res.status}`);
    }

    const data = await res.json();
    const messages = (data.messages || []).map(msg => ({
      id: msg.id,
      body: msg.body,
      createdAt: msg.created_at,
      username: msg.user?.username || 'unknown',
      followers: msg.user?.followers || 0,
      sentiment: msg.entities?.sentiment?.basic || null, // "Bullish" | "Bearish" | null
      symbols: (msg.symbols || []).map(s => s.symbol),
    }));

    this._cache.set(upper, { data: messages, expiry: Date.now() + 2 * 60 * 1000 });
    return messages;
  }

  // ── Trending Stream ───────────────────────────────────────────────

  /**
   * Get the trending message stream (across all tickers).
   */
  async getTrendingStream(limit = 30) {
    const res = await fetch(`${STOCKTWITS_BASE}/streams/trending.json?limit=${limit}`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) throw new Error(`StockTwits API error: ${res.status}`);
    const data = await res.json();
    return (data.messages || []).map(msg => ({
      id: msg.id,
      body: msg.body,
      createdAt: msg.created_at,
      username: msg.user?.username || 'unknown',
      followers: msg.user?.followers || 0,
      sentiment: msg.entities?.sentiment?.basic || null,
      symbols: (msg.symbols || []).map(s => s.symbol),
    }));
  }

  // ── Sentiment Analysis ────────────────────────────────────────────

  /**
   * Aggregate sentiment from a list of StockTwits messages.
   * Groups by symbol and calculates bullish/bearish score.
   *
   * @param {Array} messages - from getStream() or getTrendingStream()
   * @returns {Array<{symbol: string, bullish: number, bearish: number, neutral: number, total: number, score: number}>}
   */
  analyzeSentiment(messages) {
    const bySymbol = new Map();

    for (const msg of messages) {
      for (const sym of msg.symbols) {
        if (!bySymbol.has(sym)) {
          bySymbol.set(sym, { bullish: 0, bearish: 0, neutral: 0, total: 0 });
        }
        const data = bySymbol.get(sym);
        data.total++;

        if (msg.sentiment === 'Bullish') data.bullish++;
        else if (msg.sentiment === 'Bearish') data.bearish++;
        else data.neutral++;
      }
    }

    return [...bySymbol.entries()].map(([symbol, data]) => ({
      symbol,
      bullish: data.bullish,
      bearish: data.bearish,
      neutral: data.neutral,
      total: data.total,
      score: data.total > 0 ? (data.bullish - data.bearish) / data.total : 0,
    }));
  }

  // ── Full Sentiment Analysis for a Ticker ──────────────────────────

  /**
   * Get social sentiment analysis for a specific ticker.
   * Fetches stream + calculates aggregate sentiment.
   *
   * @param {string} ticker
   * @returns {{ ticker, messages: number, bullish, bearish, neutral, score, label, recentPosts }}
   */
  async analyzeSymbol(ticker) {
    const upper = ticker.toUpperCase();
    const messages = await this.getStream(upper, 30);

    let bullish = 0, bearish = 0, neutral = 0;
    for (const msg of messages) {
      if (msg.sentiment === 'Bullish') bullish++;
      else if (msg.sentiment === 'Bearish') bearish++;
      else neutral++;
    }

    const total = messages.length;
    const score = total > 0 ? (bullish - bearish) / total : 0;
    const label = score > 0.2 ? 'Bullish' : score < -0.2 ? 'Bearish' : 'Mixed';

    // Top 5 most recent posts (for display)
    const recentPosts = messages.slice(0, 5).map(m => ({
      user: m.username,
      text: m.body.slice(0, 200),
      sentiment: m.sentiment || 'Neutral',
    }));

    return { ticker: upper, messages: total, bullish, bearish, neutral, score, label, recentPosts };
  }

  // ── Discord Formatting ────────────────────────────────────────────

  /**
   * Format trending tickers for Discord.
   */
  formatTrendingForDiscord(trending) {
    if (!trending || trending.length === 0) {
      return '_No trending data available from StockTwits._';
    }

    const lines = [
      `**StockTwits Trending Tickers**`,
      ``,
    ];

    for (let i = 0; i < Math.min(trending.length, 15); i++) {
      const t = trending[i];
      lines.push(`**${i + 1}.** \`$${t.symbol}\` — ${t.title} (${t.watchlistCount.toLocaleString()} watchers)`);
    }

    lines.push(``);
    lines.push(`_Updated: ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET_`);
    return lines.join('\n');
  }

  /**
   * Format symbol sentiment for Discord.
   */
  formatSentimentForDiscord(result) {
    const { ticker, messages, bullish, bearish, neutral, score, label, recentPosts } = result;

    const emoji = score > 0.2 ? '🟢' : score < -0.2 ? '🔴' : '🟡';
    const barLen = 10;
    const bullBar = messages > 0 ? Math.round((bullish / messages) * barLen) : 0;
    const bearBar = messages > 0 ? Math.round((bearish / messages) * barLen) : 0;
    const neutBar = barLen - bullBar - bearBar;

    const lines = [
      `**${ticker} — Social Sentiment** (StockTwits)`,
      ``,
      `${emoji} **${label}** — Score: \`${(score * 100).toFixed(0)}%\``,
      `${'🟩'.repeat(bullBar)}${'⬜'.repeat(Math.max(0, neutBar))}${'🟥'.repeat(bearBar)}`,
      `Bullish: **${bullish}** | Bearish: **${bearish}** | Neutral: **${neutral}** (${messages} posts)`,
    ];

    if (recentPosts.length > 0) {
      lines.push(``);
      lines.push(`**Recent Posts**`);
      for (const post of recentPosts) {
        const sentEmoji = post.sentiment === 'Bullish' ? '🟢' : post.sentiment === 'Bearish' ? '🔴' : '⚪';
        lines.push(`${sentEmoji} **@${post.user}**: ${post.text.slice(0, 120)}${post.text.length > 120 ? '...' : ''}`);
      }
    }

    lines.push(``);
    lines.push(`_Source: StockTwits | Not financial advice_`);
    return lines.join('\n');
  }
}

module.exports = new StockTwitsService();
