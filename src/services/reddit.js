const SUBREDDITS = ['wallstreetbets', 'stocks', 'investing', 'options'];

const REDDIT_HEADERS = {
  'User-Agent': 'SharkBot/1.0 (Discord trading bot; educational use)',
  'Accept': 'application/json',
};

const TICKER_REGEX = /\$([A-Z]{1,5})\b/g;
const LOOSE_TICKER_REGEX = /\b([A-Z]{2,5})\b/g;

const NOT_TICKERS = new Set([
  'THE', 'AND', 'FOR', 'ARE', 'BUT', 'NOT', 'YOU', 'ALL', 'CAN', 'HAD', 'HER',
  'WAS', 'ONE', 'OUR', 'OUT', 'HAS', 'HIS', 'HOW', 'ITS', 'LET', 'MAY', 'NEW',
  'NOW', 'OLD', 'SEE', 'WAY', 'WHO', 'BOY', 'DID', 'GET', 'HIM', 'LET', 'SAY',
  'SHE', 'TOO', 'USE', 'DAD', 'MOM', 'BIG', 'JUST', 'LIKE', 'WHAT', 'WHEN',
  'WITH', 'THIS', 'THAT', 'FROM', 'THEY', 'BEEN', 'HAVE', 'MANY', 'SOME', 'THEM',
  'THAN', 'EACH', 'MAKE', 'WILL', 'BEEN', 'CALL', 'COME', 'MADE', 'FIND', 'LONG',
  'LOOK', 'MORE', 'ONLY', 'OVER', 'SUCH', 'TAKE', 'THAN', 'THEM', 'VERY', 'AFTER',
  'ALSO', 'INTO', 'JUST', 'MOST', 'YOUR', 'HOLD', 'SELL', 'BEAR', 'BULL', 'PUTS',
  'CALL', 'YOLO', 'FOMO', 'HODL', 'MOON', 'PUMP', 'DUMP', 'GAIN', 'LOSS', 'DOWN',
  'CASH', 'DEBT', 'RATE', 'HIGH', 'WEEK', 'YEAR', 'NEXT', 'LAST', 'BEST', 'GOOD',
  'FREE', 'HELP', 'NEED', 'BACK', 'EVEN', 'MUCH', 'STILL', 'SINCE', 'COULD', 'THESE',
  'OTHER', 'WOULD', 'ABOUT', 'WHICH', 'THEIR', 'FIRST', 'THINK', 'THOSE', 'BEING',
  'TODAY', 'EVERY', 'NEVER', 'MONEY', 'STOCK', 'TRADE', 'SHORT', 'PRICE', 'MARKET',
  'DAILY', 'WORTH', 'GREAT', 'RIGHT', 'GOING', 'MIGHT', 'COULD', 'WOULD', 'SHOULD',
  'IMO', 'LOL', 'WTF', 'FYI', 'TBH', 'EDIT', 'POST', 'THREAD', 'UPDATE',
  'DD', 'ITM', 'OTM', 'ATM', 'DTE', 'ATH', 'CEO', 'CFO', 'IPO', 'SEC', 'FED',
  'GDP', 'CPI', 'ETF', 'USA', 'EPS', 'P/E', 'ROE', 'RSI', 'SMA', 'EMA',
]);

class RedditService {
  constructor() {
    this._cache = new Map(); // subreddit → { posts, expiry }
    this._mentionCache = null;
    this._mentionExpiry = 0;
    this._cacheMs = 5 * 60 * 1000; // 5 min cache per sub
    this._mentionCacheMs = 10 * 60 * 1000; // 10 min aggregate cache
  }

  _extractTickers(text) {
    if (!text) return [];
    const tickers = new Set();

    // First pass: explicit $TICKER mentions (high confidence)
    let match;
    TICKER_REGEX.lastIndex = 0;
    while ((match = TICKER_REGEX.exec(text)) !== null) {
      const sym = match[1];
      if (sym.length >= 1 && sym.length <= 5 && !NOT_TICKERS.has(sym)) {
        tickers.add(sym);
      }
    }

    // Second pass: loose uppercase words (lower confidence)
    LOOSE_TICKER_REGEX.lastIndex = 0;
    while ((match = LOOSE_TICKER_REGEX.exec(text)) !== null) {
      const sym = match[1];
      if (sym.length >= 2 && sym.length <= 5 && !NOT_TICKERS.has(sym)) {
        tickers.add(sym);
      }
    }

    return [...tickers];
  }

  /**
   * Fetch hot posts from a single subreddit.
   * @param {string} subreddit
   * @param {number} limit - max posts (default 25)
   * @returns {Array<{title, score, comments, upvoteRatio, created, flair, author, tickers}>}
   */
  async getHotPosts(subreddit, limit = 25) {
    const cached = this._cache.get(subreddit);
    if (cached && Date.now() < cached.expiry) {
      return cached.posts;
    }

    try {
      const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}&raw_json=1`;
      const res = await fetch(url, {
        headers: REDDIT_HEADERS,
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        if (res.status === 429) {
          console.warn(`[Reddit] Rate limited on r/${subreddit}`);
          return [];
        }
        throw new Error(`Reddit ${res.status}`);
      }

      const data = await res.json();
      const children = data?.data?.children || [];

      const posts = children
        .filter(c => c.kind === 't3' && c.data && !c.data.stickied)
        .map(c => {
          const d = c.data;
          const tickers = this._extractTickers(d.title + ' ' + (d.selftext || '').slice(0, 500));
          return {
            id: d.id,
            title: d.title,
            score: d.score || 0,
            comments: d.num_comments || 0,
            upvoteRatio: d.upvote_ratio || 0.5,
            created: d.created_utc || 0,
            flair: d.link_flair_text || null,
            author: d.author || 'unknown',
            subreddit,
            tickers,
            url: `https://reddit.com${d.permalink}`,
          };
        });

      this._cache.set(subreddit, { posts, expiry: Date.now() + this._cacheMs });
      return posts;
    } catch (err) {
      console.warn(`[Reddit] Fetch failed for r/${subreddit}: ${err.message}`);
      return [];
    }
  }

  /**
   * Fetch posts from all tracked subreddits.
   * @returns {Array} All posts from all subreddits
   */
  async getAllPosts() {
    const results = await Promise.allSettled(
      SUBREDDITS.map(sub => this.getHotPosts(sub, 25))
    );

    const allPosts = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allPosts.push(...result.value);
      }
    }

    return allPosts;
  }

  /**
   * Get aggregate ticker mentions across all subreddits.
   * Returns tickers ranked by total engagement (score + comments).
   *
   * @returns {Array<{symbol, mentions, totalScore, totalComments, avgUpvoteRatio, subreddits, posts}>}
   */
  async getTrendingTickers() {
    // Check cache
    if (this._mentionCache && Date.now() < this._mentionExpiry) {
      return this._mentionCache;
    }

    const allPosts = await this.getAllPosts();
    const tickerMap = new Map();

    for (const post of allPosts) {
      for (const ticker of post.tickers) {
        if (!tickerMap.has(ticker)) {
          tickerMap.set(ticker, {
            symbol: ticker,
            mentions: 0,
            totalScore: 0,
            totalComments: 0,
            upvoteRatios: [],
            subreddits: new Set(),
            topPosts: [],
          });
        }

        const entry = tickerMap.get(ticker);
        entry.mentions++;
        entry.totalScore += post.score;
        entry.totalComments += post.comments;
        entry.upvoteRatios.push(post.upvoteRatio);
        entry.subreddits.add(post.subreddit);

        if (entry.topPosts.length < 3) {
          entry.topPosts.push({
            title: post.title.slice(0, 120),
            score: post.score,
            subreddit: post.subreddit,
            url: post.url,
          });
        }
      }
    }

    // Sort by engagement (mentions * avg_score)
    const trending = [...tickerMap.values()]
      .filter(t => t.mentions >= 2) // require at least 2 mentions
      .map(t => ({
        symbol: t.symbol,
        mentions: t.mentions,
        totalScore: t.totalScore,
        totalComments: t.totalComments,
        avgUpvoteRatio: t.upvoteRatios.reduce((a, b) => a + b, 0) / t.upvoteRatios.length,
        subreddits: [...t.subreddits],
        topPosts: t.topPosts,
        engagementScore: t.mentions * (t.totalScore / Math.max(t.mentions, 1)),
      }))
      .sort((a, b) => b.engagementScore - a.engagementScore);

    this._mentionCache = trending;
    this._mentionExpiry = Date.now() + this._mentionCacheMs;
    return trending;
  }

  /**
   * Get Reddit sentiment for a specific ticker.
   * @param {string} symbol
   * @returns {{ symbol, mentions, score, sentiment, subreddits, posts }}
   */
  async analyzeSymbol(symbol) {
    const upper = symbol.toUpperCase();
    const allPosts = await this.getAllPosts();

    const relevantPosts = allPosts.filter(p => p.tickers.includes(upper));

    if (relevantPosts.length === 0) {
      return {
        symbol: upper,
        mentions: 0,
        score: 0,
        sentiment: 'none',
        subreddits: [],
        posts: [],
      };
    }

    const totalScore = relevantPosts.reduce((sum, p) => sum + p.score, 0);
    const avgUpvote = relevantPosts.reduce((sum, p) => sum + p.upvoteRatio, 0) / relevantPosts.length;
    const subreddits = [...new Set(relevantPosts.map(p => p.subreddit))];

    // Sentiment: high upvote ratio + high score = bullish social signal
    // Transform upvote ratio (0.5-1.0) to sentiment (-1 to +1)
    const sentimentScore = (avgUpvote - 0.5) * 2; // 0.75 upvote → 0.5 sentiment

    return {
      symbol: upper,
      mentions: relevantPosts.length,
      score: sentimentScore,
      totalRedditScore: totalScore,
      avgUpvoteRatio: avgUpvote,
      sentiment: sentimentScore > 0.3 ? 'Bullish' : sentimentScore < -0.1 ? 'Bearish' : 'Mixed',
      subreddits,
      posts: relevantPosts.slice(0, 5).map(p => ({
        title: p.title.slice(0, 120),
        score: p.score,
        comments: p.comments,
        subreddit: p.subreddit,
        flair: p.flair,
      })),
    };
  }

  clearCache() {
    this._cache.clear();
    this._mentionCache = null;
    this._mentionExpiry = 0;
  }

  // ── Discord Formatting ──────────────────────────────────────────

  formatTrendingForDiscord(trending) {
    if (!trending || trending.length === 0) {
      return '_No trending tickers found on Reddit right now._';
    }

    const lines = [
      '**Reddit Trending Tickers**',
      `_Scanned: ${SUBREDDITS.map(s => `r/${s}`).join(', ')}_`,
      '',
    ];

    for (let i = 0; i < Math.min(trending.length, 10); i++) {
      const t = trending[i];
      const subs = t.subreddits.map(s => `r/${s}`).join(', ');
      lines.push(
        `**${i + 1}.** \`$${t.symbol}\` — ${t.mentions} mentions | ` +
        `Score: ${t.totalScore.toLocaleString()} | ` +
        `Upvote: ${(t.avgUpvoteRatio * 100).toFixed(0)}% | ` +
        `${subs}`
      );
    }

    lines.push('');
    lines.push(`_Updated: ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET_`);
    return lines.join('\n');
  }

  formatSymbolForDiscord(result) {
    if (!result || result.mentions === 0) {
      return `_No Reddit discussion found for ${result?.symbol || 'this ticker'}._`;
    }

    const emoji = result.sentiment === 'Bullish' ? '🟢' : result.sentiment === 'Bearish' ? '🔴' : '🟡';
    const lines = [
      `**${result.symbol} — Reddit Sentiment**`,
      '',
      `${emoji} **${result.sentiment}** — ${result.mentions} mentions across ${result.subreddits.map(s => `r/${s}`).join(', ')}`,
      `Score: \`${result.totalRedditScore.toLocaleString()}\` | Avg Upvote: \`${(result.avgUpvoteRatio * 100).toFixed(0)}%\``,
    ];

    if (result.posts.length > 0) {
      lines.push('');
      lines.push('**Recent Posts**');
      for (const p of result.posts) {
        const flairStr = p.flair ? ` [${p.flair}]` : '';
        lines.push(`• **${p.score}** pts | r/${p.subreddit}${flairStr}: ${p.title}`);
      }
    }

    lines.push('');
    lines.push(`_Source: Reddit | Not financial advice_`);
    return lines.join('\n');
  }
}

module.exports = new RedditService();