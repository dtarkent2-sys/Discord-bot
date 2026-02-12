const Storage = require('./storage');

// Common ticker patterns for topic extraction
const KNOWN_TICKERS = new Set([
  // Mega-cap tech
  'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'META', 'TSLA', 'NVDA', 'AMD',
  'AVGO', 'ORCL', 'CRM', 'ADBE', 'INTC', 'QCOM', 'TXN', 'MU', 'AMAT',
  'LRCX', 'KLAC', 'MRVL', 'SNPS', 'CDNS', 'ARM', 'SMCI', 'DELL',
  // Consumer / streaming / social
  'NFLX', 'DIS', 'SNAP', 'UBER', 'LYFT', 'ABNB', 'DASH', 'SHOP', 'PINS',
  'RBLX', 'ROKU', 'SPOT', 'TTD',
  // Financials
  'JPM', 'GS', 'MS', 'BAC', 'WFC', 'C', 'SCHW', 'BLK', 'ICE',
  'V', 'MA', 'PYPL', 'SQ', 'COIN', 'SOFI', 'HOOD', 'MSTR',
  // Industrials / defense / aero
  'BA', 'LMT', 'RTX', 'GE', 'CAT', 'DE', 'HON', 'UNP',
  // Autos / EV
  'F', 'GM', 'RIVN', 'LCID', 'NIO', 'LI', 'XPEV',
  // Healthcare / biotech
  'UNH', 'JNJ', 'LLY', 'NVO', 'ABBV', 'PFE', 'MRK', 'MRNA', 'BNTX',
  'AMGN', 'GILD', 'BMY', 'ISRG', 'TMO', 'DHR',
  // Cybersecurity / SaaS
  'CRWD', 'PANW', 'ZS', 'FTNT', 'NET', 'DDOG', 'MDB', 'SNOW', 'NOW',
  'PLTR', 'AI', 'PATH', 'HUBS', 'TEAM', 'ZM', 'OKTA', 'S',
  // AI / data
  'GOOG', 'IBM', 'ORCL',
  // Meme / retail favorites
  'GME', 'AMC', 'BBBY', 'SPCE',
  // Energy
  'XOM', 'CVX', 'COP', 'SLB', 'OXY', 'DVN', 'MPC',
  // ETFs
  'SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'VOO', 'ARKK', 'ARKG', 'ARKF',
  'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLC', 'XLY', 'XLP', 'XLU', 'XLRE', 'XLB',
  'TLT', 'HYG', 'GLD', 'SLV', 'USO', 'UNG', 'VXX', 'SOXL', 'TQQQ', 'SQQQ',
  // Crypto-adjacent
  'MARA', 'RIOT', 'CLSK', 'BITF',
]);

// Topic keywords to track conversational themes
const TOPIC_KEYWORDS = {
  options: /\b(options?|calls?|puts?|strike|expir|premium|iv|greeks|theta|delta)\b/i,
  technical: /\b(support|resistance|breakout|moving average|rsi|macd|volume|candle|pattern|chart)\b/i,
  fundamental: /\b(earnings|revenue|eps|pe ratio|market cap|dividend|balance sheet|valuation)\b/i,
  crypto: /\b(bitcoin|btc|ethereum?|crypto|blockchain|defi|nft)\b/i,
  macro: /\b(fed|interest rate|inflation|cpi|gdp|unemployment|treasury|yield|fomc|recession)\b/i,
  risk: /\b(stop loss|risk|position size|hedge|protect|downside|max loss)\b/i,
};

class MemoryService {
  constructor() {
    this.store = new Storage('memory.json');
  }

  // Get memory for a specific user
  getUser(userId) {
    return this.store.get(userId, {
      facts: [],
      preferences: {},
      interactionCount: 0,
      firstSeen: null,
      lastSeen: null,
      recentTopics: [],
      lastInteraction: null,
    });
  }

  // Record an interaction and extract facts + topics
  recordInteraction(userId, username, message) {
    // ★ Robust input validation ★
    let sanitizedMessage = ''

    // Empty or non-string handling
    if (typeof message !== 'string' || message.trim() === '') {
      // Return early with clear feedback instead of crashing
      return {
        error: 'Invalid or empty message content',
        user: this.getUser(userId)
      }
    }

    // Sanitize whitespace and strip control characters
    sanitizedMessage = message.trim().replace(/[\x00-\x1F\x7F]/g, '')

    // Add user context tracking — only if valid message exists
    const user = this.getUser(userId);
    user.interactionCount++;
    user.lastSeen = new Date().toISOString();
    if (!user.firstSeen) {
      user.firstSeen = user.lastSeen;
    }
    if (!user.username || user.username !== username) {
      user.username = username;
    }

    // Extract basic facts from messages
    const facts = this._extractFacts(sanitizedMessage);
    for (const fact of facts) {
      if (!user.facts.includes(fact)) {
        user.facts.push(fact);
      }
    }

    // Keep facts list manageable
    if (user.facts.length > 50) {
      user.facts = user.facts.slice(-50);
    }

    // Extract tickers and topics
    const tickers = this._extractTickers(sanitizedMessage);
    const topics = this._extractTopics(sanitizedMessage);

    // Store last interaction for context-aware callbacks
    user.lastInteraction = {
      message: sanitizedMessage.slice(0, 300),
      topic: topics[0] || null,
      tickers,
      timestamp: user.lastSeen,
    };

    // Track recent topics (last 20)
    if (topics.length > 0 || tickers.length > 0) {
      user.recentTopics.push({
        topics,
        tickers,
        timestamp: user.lastSeen,
      });
      if (user.recentTopics.length > 20) {
        user.recentTopics = user.recentTopics.slice(-20);
      }
    }

    this.store.set(userId, user);
    return user;
  }

  // Get the last interaction for a user (for context-aware callbacks)
  getLastInteraction(userId) {
    const user = this.getUser(userId);
    return user.lastInteraction;
  }

  // Get tickers this user talks about most
  getFrequentTickers(userId) {
    const user = this.getUser(userId);
    const counts = {};
    for (const entry of (user.recentTopics || [])) {
      for (const t of (entry.tickers || [])) {
        counts[t] = (counts[t] || 0) + 1;
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ticker, count]) => ({ ticker, count }));
  }

  // Check if user recently discussed a specific ticker
  hasRecentTicker(userId, ticker) {
    const user = this.getUser(userId);
    const cutoff = Date.now() - (24 * 60 * 60 * 1000);
    return (user.recentTopics || []).some(
      e => (e.tickers || []).includes(ticker) && new Date(e.timestamp).getTime() > cutoff
    );
  }

  // Add a specific fact about a user
  addFact(userId, fact) {
    const user = this.getUser(userId);
    if (!user.facts.includes(fact)) {
      user.facts.push(fact);
      this.store.set(userId, user);
    }
  }

  // Set a user preference
  setPreference(userId, key, value) {
    const user = this.getUser(userId);
    user.preferences[key] = value;
    this.store.set(userId, user);
  }

  // Build a context string for AI prompts (now includes topic history)
  buildContext(userId) {
    const user = this.getUser(userId);
    if (user.facts.length === 0 && Object.keys(user.preferences).length === 0 && !user.lastInteraction) {
      return '';
    }

    const parts = [];
    if (user.username) {
      parts.push(`User's name: ${user.username}`);
    }
    if (user.facts.length > 0) {
      parts.push(`Known facts: ${user.facts.join('; ')}`);
    }
    if (Object.keys(user.preferences).length > 0) {
      parts.push(`Preferences: ${JSON.stringify(user.preferences)}`);
    }
    parts.push(`Interactions: ${user.interactionCount}`);

    // Add conversational context
    if (user.lastInteraction) {
      const last = user.lastInteraction;
      const ago = this._timeAgo(last.timestamp);
      if (last.tickers.length > 0) {
        parts.push(`Last discussed: ${last.tickers.join(', ')} (${ago})`);
      }
      if (last.topic) {
        parts.push(`Last topic: ${last.topic}`);
      }
    }

    // Add frequent tickers
    const frequent = this.getFrequentTickers(userId);
    if (frequent.length > 0) {
      parts.push(`Frequently discussed tickers: ${frequent.map(f => `${f.ticker}(${f.count}x)`).join(', ')}`);
    }

    return parts.join('\n');
  }

  _extractFacts(message) {
    const facts = [];

    const patterns = [
      { regex: /my name is (\w+)/i, template: (m) => `Name is ${m[1]}` },
      { regex: /i (?:work|am working) (?:as|in) (.+?)(?:\.|$)/i, template: (m) => `Works as/in ${m[1]}` },
      { regex: /i live in (.+?)(?:\.|$)/i, template: (m) => `Lives in ${m[1]}` },
      { regex: /i (?:like|love|enjoy) (.+?)(?:\.|$)/i, template: (m) => `Likes ${m[1]}` },
      { regex: /i (?:hate|dislike|don't like) (.+?)(?:\.|$)/i, template: (m) => `Dislikes ${m[1]}` },
      { regex: /i'm (?:a |an )?(\w+ (?:developer|engineer|designer|student|teacher|artist|musician))/i, template: (m) => `Is a ${m[1]}` },
      { regex: /my favorite (\w+) is (.+?)(?:\.|$)/i, template: (m) => `Favorite ${m[1]} is ${m[2]}` },
    ];

    for (const { regex, template } of patterns) {
      const match = message.match(regex);
      if (match) {
        facts.push(template(match));
      }
    }

    return facts;
  }

  _extractTickers(message) {
    const found = new Set();
    const words = message.toUpperCase().split(/[\s,.:;!?()]+/);
    for (const word of words) {
      if (KNOWN_TICKERS.has(word)) {
        found.add(word);
      }
    }
    return [...found];
  }

  _extractTopics(message) {
    const topics = [];
    for (const [topic, regex] of Object.entries(TOPIC_KEYWORDS)) {
      if (regex.test(message)) {
        topics.push(topic);
      }
    }
    return topics;
  }

  // ── Watchlist ────────────────────────────────────────────────────
  getWatchlist(userId) {
    const key = `watchlist:${userId}`;
    return this.store.get(key, []);
  }

  addToWatchlist(userId, ticker) {
    ticker = ticker.toUpperCase();
    const list = this.getWatchlist(userId);
    if (!list.includes(ticker)) {
      list.push(ticker);
      this.store.set(`watchlist:${userId}`, list);
    }
    return list;
  }

  removeFromWatchlist(userId, ticker) {
    ticker = ticker.toUpperCase();
    const list = this.getWatchlist(userId).filter(t => t !== ticker);
    this.store.set(`watchlist:${userId}`, list);
    return list;
  }

  _timeAgo(timestamp) {
    if (!timestamp) return 'unknown';
    const ms = Date.now() - new Date(timestamp).getTime();
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
}

module.exports = new MemoryService();