/**
 * Validea Guru Analysis Scraper
 *
 * Scrapes guru strategy scores from Validea's public stock analysis pages.
 * Each stock is rated 0-100% across ~22 guru strategies based on fundamental
 * criteria from investors like Warren Buffett, Peter Lynch, Benjamin Graham, etc.
 *
 * Scores:
 *   - 90%+ = Strong Interest
 *   - 80%+ = Some Interest
 *   - Below 80% = Fail / Neutral
 *
 * Data is cached for 12 hours (Validea updates nightly).
 * Falls back gracefully when scraping is blocked.
 */

const VALIDEA_BASE = 'https://www.validea.com/guru-analysis';

// Known guru strategies and their common identifiers in Validea's HTML
const GURU_STRATEGIES = [
  { id: 'twin_momentum', guru: 'Dashan Huang', name: 'Twin Momentum Investor' },
  { id: 'patient_investor', guru: 'Warren Buffett', name: 'Patient Investor' },
  { id: 'pe_growth', guru: 'Peter Lynch', name: 'P/E/Growth Investor' },
  { id: 'price_sales', guru: 'Kenneth Fisher', name: 'Price/Sales Investor' },
  { id: 'low_pe', guru: 'John Neff', name: 'Low P/E Investor' },
  { id: 'growth_value', guru: "James O'Shaughnessy", name: 'Growth/Value Investor' },
  { id: 'value_composite', guru: "James O'Shaughnessy", name: 'Value Composite Investor' },
  { id: 'book_market', guru: 'Joseph Piotroski', name: 'Book/Market Investor' },
  { id: 'contrarian', guru: 'David Dreman', name: 'Contrarian Investor' },
  { id: 'earnings_yield', guru: 'Joel Greenblatt', name: 'Earnings Yield Investor' },
  { id: 'pb_growth', guru: 'Partha Mohanram', name: 'P/B Growth Investor' },
  { id: 'multi_factor', guru: 'Pim van Vliet', name: 'Multi-Factor Investor' },
  { id: 'millennial', guru: "Patrick O'Shaughnessy", name: 'Millennial Investor' },
  { id: 'earnings_revision', guru: 'Wayne Thorp', name: 'Earnings Revision Investor' },
  { id: 'quantitative_momentum', guru: 'Wesley Gray', name: 'Quantitative Momentum Investor' },
  { id: 'shareholder_yield', guru: 'Meb Faber', name: 'Shareholder Yield Investor' },
  { id: 'acquirers_multiple', guru: 'Tobias Carlisle', name: "Acquirer's Multiple Investor" },
  { id: 'momentum', guru: 'Validea', name: 'Momentum Investor' },
  { id: 'graham_defensive', guru: 'Benjamin Graham', name: 'Defensive Investor' },
  { id: 'graham_enterprising', guru: 'Benjamin Graham', name: 'Enterprising Investor' },
  { id: 'small_cap_growth', guru: 'Motley Fool', name: 'Small-Cap Growth Investor' },
  { id: 'top_gurus', guru: 'Validea', name: 'Top Guru Composite' },
];

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Cache-Control': 'max-age=0',
};

class ValideaService {
  constructor() {
    this._cache = new Map(); // symbol → { data, expiry }
    this._cacheMs = 12 * 60 * 60 * 1000; // 12 hours (scores update nightly)
  }

  /**
   * Fetch and parse Validea guru scores for a stock.
   * @param {string} symbol - Ticker symbol (e.g. AAPL)
   * @returns {{ symbol, scores: Array<{guru, name, score, interest}>, topStrategy, avgScore, strongCount, someCount, scraped, error? }}
   */
  async analyze(symbol) {
    const upper = symbol.toUpperCase();

    // Check cache
    const cached = this._cache.get(upper);
    if (cached && Date.now() < cached.expiry) {
      return cached.data;
    }

    const url = `${VALIDEA_BASE}/${upper}`;
    let html;

    try {
      const res = await fetch(url, {
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(15000),
        redirect: 'follow',
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      html = await res.text();
    } catch (err) {
      console.warn(`[Validea] Fetch failed for ${upper}: ${err.message}`);
      return this._buildFallback(upper, `Could not reach Validea: ${err.message}`);
    }

    // Parse scores from HTML
    const scores = this._parseScores(html, upper);

    if (scores.length === 0) {
      // Page loaded but we couldn't parse scores — might be behind a paywall or different structure
      return this._buildFallback(upper, 'Could not parse guru scores (page structure may have changed or content may require login)');
    }

    const result = this._buildResult(upper, scores);
    this._cache.set(upper, { data: result, expiry: Date.now() + this._cacheMs });
    return result;
  }

  /**
   * Parse guru scores from Validea's HTML.
   * Looks for percentage patterns near known guru/strategy names.
   */
  _parseScores(html, symbol) {
    const scores = [];

    // Strategy 1: Look for patterns like "93%" or "Score: 93" near guru names
    // Validea pages typically show scores in table rows or score cards

    // Pattern: Match guru name followed by a percentage somewhere nearby
    for (const strategy of GURU_STRATEGIES) {
      // Search for the guru name or strategy name in the HTML
      const guruEscaped = strategy.guru.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nameEscaped = strategy.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Try multiple patterns
      const patterns = [
        // "Strategy Name ... XX%"
        new RegExp(`${nameEscaped}[^%]*?(\\d{1,3})\\s*%`, 'i'),
        // "Guru Name ... XX%"
        new RegExp(`${guruEscaped}[^%]*?(\\d{1,3})\\s*%`, 'i'),
        // Shorter name match (e.g. just "Twin Momentum" or "Patient Investor")
        new RegExp(`${strategy.name.split(' ').slice(0, 2).join('\\s+')}[^%]*?(\\d{1,3})\\s*%`, 'i'),
      ];

      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) {
          const score = parseInt(match[1], 10);
          if (score >= 0 && score <= 100) {
            // Avoid duplicates
            if (!scores.find(s => s.id === strategy.id)) {
              scores.push({
                id: strategy.id,
                guru: strategy.guru,
                name: strategy.name,
                score,
                interest: score >= 90 ? 'Strong Interest' : score >= 80 ? 'Some Interest' : score >= 60 ? 'Neutral' : 'Fail',
              });
            }
            break;
          }
        }
      }
    }

    // Strategy 2: Broader pattern — find all "NN%" patterns in score-like contexts
    // This catches scores we might miss with name-based matching
    if (scores.length === 0) {
      // Look for table rows or divs with percentage scores
      const broadPattern = /(?:score|rating|grade)[^%]*?(\d{1,3})\s*%/gi;
      let match;
      while ((match = broadPattern.exec(html)) !== null) {
        const score = parseInt(match[1], 10);
        if (score >= 0 && score <= 100) {
          scores.push({
            id: `unknown_${scores.length}`,
            guru: 'Unknown',
            name: `Strategy ${scores.length + 1}`,
            score,
            interest: score >= 90 ? 'Strong Interest' : score >= 80 ? 'Some Interest' : score >= 60 ? 'Neutral' : 'Fail',
          });
        }
      }
    }

    return scores;
  }

  _buildResult(symbol, scores) {
    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);

    const strongCount = scores.filter(s => s.score >= 90).length;
    const someCount = scores.filter(s => s.score >= 80 && s.score < 90).length;
    const avgScore = scores.length > 0
      ? scores.reduce((sum, s) => sum + s.score, 0) / scores.length
      : 0;
    const topStrategy = scores.length > 0 ? scores[0] : null;

    return {
      symbol,
      scores,
      topStrategy,
      avgScore: Math.round(avgScore),
      strongCount,
      someCount,
      totalStrategies: scores.length,
      scraped: true,
      timestamp: new Date().toISOString(),
    };
  }

  _buildFallback(symbol, error) {
    return {
      symbol,
      scores: [],
      topStrategy: null,
      avgScore: 0,
      strongCount: 0,
      someCount: 0,
      totalStrategies: 0,
      scraped: false,
      error,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get a simple score summary for use in the SHARK trading pipeline.
   * Returns a normalized 0-1 "fundamental score" based on Validea data.
   *
   * @param {string} symbol
   * @returns {{ score: number, label: string, topGuru: string|null, strategies: number, error?: string }}
   */
  async getScore(symbol) {
    const result = await this.analyze(symbol);

    if (!result.scraped || result.scores.length === 0) {
      return {
        score: 0,
        label: 'unavailable',
        topGuru: null,
        strategies: 0,
        error: result.error || 'No data',
      };
    }

    // Normalize: avgScore (0-100) → 0.0-1.0
    const normalized = result.avgScore / 100;
    const label = normalized >= 0.8 ? 'Strong' : normalized >= 0.6 ? 'Moderate' : normalized >= 0.4 ? 'Weak' : 'Poor';

    return {
      score: normalized,
      label,
      topGuru: result.topStrategy ? `${result.topStrategy.guru} (${result.topStrategy.score}%)` : null,
      strategies: result.totalStrategies,
    };
  }

  /**
   * Clear cache (useful for testing or forcing a refresh).
   */
  clearCache() {
    this._cache.clear();
  }

  // ── Discord Formatting ────────────────────────────────────────────

  formatForDiscord(result) {
    if (!result) return '_Could not fetch Validea data._';

    const lines = [`**${result.symbol} — Validea Guru Analysis**`, ''];

    if (!result.scraped) {
      lines.push(`_${result.error || 'Data unavailable'}_`);
      lines.push('');
      lines.push(`_Try viewing directly: <${VALIDEA_BASE}/${result.symbol}>_`);
      return lines.join('\n');
    }

    // Summary bar
    const scoreBar = '█'.repeat(Math.round(result.avgScore / 10)) + '░'.repeat(10 - Math.round(result.avgScore / 10));
    lines.push(`**Overall Score:** \`${result.avgScore}%\` [${scoreBar}]`);
    lines.push(`**Strategies Evaluated:** ${result.totalStrategies}`);
    lines.push(`**Strong Interest (90%+):** ${result.strongCount} | **Some Interest (80%+):** ${result.someCount}`);
    lines.push('');

    // Top strategies
    if (result.topStrategy) {
      lines.push('__Top Guru Strategies__');
      const topScores = result.scores.slice(0, 8);
      for (const s of topScores) {
        const emoji = s.score >= 90 ? '🟢' : s.score >= 80 ? '🟡' : s.score >= 60 ? '🟠' : '🔴';
        lines.push(`${emoji} **${s.guru}** (${s.name}): \`${s.score}%\` — ${s.interest}`);
      }

      if (result.scores.length > 8) {
        const remaining = result.scores.slice(8);
        const failCount = remaining.filter(s => s.score < 60).length;
        lines.push(`_...and ${remaining.length} more (${failCount} below 60%)_`);
      }
    }

    lines.push('');
    lines.push(`_Source: Validea | Updated: ${new Date(result.timestamp).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET_`);
    lines.push(`_<${VALIDEA_BASE}/${result.symbol}>_`);
    return lines.join('\n');
  }
}

module.exports = new ValideaService();
