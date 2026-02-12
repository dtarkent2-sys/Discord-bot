/**
 * Validea Guru Analysis — Authenticated Scraper
 *
 * Scrapes guru strategy scores from Validea's subscriber pages.
 * Each stock is rated 0-100% across ~22 guru strategies based on fundamental
 * criteria from investors like Warren Buffett, Peter Lynch, Benjamin Graham, etc.
 *
 * Authentication (in priority order):
 *   1. VALIDEA_COOKIE env var — paste session cookie from browser (most reliable)
 *   2. VALIDEA_EMAIL + VALIDEA_PASSWORD — auto-login via POST
 *   3. Unauthenticated fallback — public page (limited data)
 *
 * Scores:
 *   - 90%+ = Strong Interest
 *   - 80%+ = Some Interest
 *   - Below 80% = Fail / Neutral
 *
 * Data is cached for 12 hours (Validea updates nightly).
 */

const config = require('../config');

const VALIDEA_HOST = 'https://www.validea.com';
const VALIDEA_BASE = `${VALIDEA_HOST}/guru-analysis`;

// Known guru strategies and their common identifiers in Validea's HTML
const GURU_STRATEGIES = [
  { id: 'twin_momentum', guru: 'Dashan Huang', name: 'Twin Momentum Investor', keywords: ['twin momentum'] },
  { id: 'patient_investor', guru: 'Warren Buffett', name: 'Patient Investor', keywords: ['patient investor', 'buffett'] },
  { id: 'pe_growth', guru: 'Peter Lynch', name: 'P/E/Growth Investor', keywords: ['p/e/growth', 'peter lynch', 'lynch'] },
  { id: 'price_sales', guru: 'Kenneth Fisher', name: 'Price/Sales Investor', keywords: ['price/sales', 'kenneth fisher', 'fisher'] },
  { id: 'low_pe', guru: 'John Neff', name: 'Low P/E Investor', keywords: ['low p/e', 'john neff', 'neff'] },
  { id: 'growth_value', guru: "James O'Shaughnessy", name: 'Growth/Value Investor', keywords: ['growth/value', "o'shaughnessy"] },
  { id: 'value_composite', guru: "James O'Shaughnessy", name: 'Value Composite Investor', keywords: ['value composite'] },
  { id: 'book_market', guru: 'Joseph Piotroski', name: 'Book/Market Investor', keywords: ['book/market', 'piotroski'] },
  { id: 'contrarian', guru: 'David Dreman', name: 'Contrarian Investor', keywords: ['contrarian', 'dreman'] },
  { id: 'earnings_yield', guru: 'Joel Greenblatt', name: 'Earnings Yield Investor', keywords: ['earnings yield', 'greenblatt', 'magic formula'] },
  { id: 'pb_growth', guru: 'Partha Mohanram', name: 'P/B Growth Investor', keywords: ['p/b growth', 'mohanram'] },
  { id: 'multi_factor', guru: 'Pim van Vliet', name: 'Multi-Factor Investor', keywords: ['multi-factor', 'van vliet'] },
  { id: 'millennial', guru: "Patrick O'Shaughnessy", name: 'Millennial Investor', keywords: ['millennial'] },
  { id: 'earnings_revision', guru: 'Wayne Thorp', name: 'Earnings Revision Investor', keywords: ['earnings revision', 'thorp'] },
  { id: 'quantitative_momentum', guru: 'Wesley Gray', name: 'Quantitative Momentum Investor', keywords: ['quantitative momentum', 'wesley gray'] },
  { id: 'shareholder_yield', guru: 'Meb Faber', name: 'Shareholder Yield Investor', keywords: ['shareholder yield', 'faber'] },
  { id: 'acquirers_multiple', guru: 'Tobias Carlisle', name: "Acquirer's Multiple Investor", keywords: ["acquirer", 'carlisle'] },
  { id: 'momentum', guru: 'Validea', name: 'Momentum Investor', keywords: ['momentum investor'] },
  { id: 'graham_defensive', guru: 'Benjamin Graham', name: 'Defensive Investor', keywords: ['defensive investor', 'graham'] },
  { id: 'graham_enterprising', guru: 'Benjamin Graham', name: 'Enterprising Investor', keywords: ['enterprising investor'] },
  { id: 'small_cap_growth', guru: 'Motley Fool', name: 'Small-Cap Growth Investor', keywords: ['small-cap growth', 'motley fool'] },
  { id: 'top_gurus', guru: 'Validea', name: 'Top Guru Composite', keywords: ['guru composite', 'top guru'] },
];

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-User': '?1',
};

class ValideaService {
  constructor() {
    this._cache = new Map(); // symbol -> { data, expiry }
    this._cacheMs = 12 * 60 * 60 * 1000; // 12 hours (scores update nightly)
    this._sessionCookies = null;     // Cookie string from login
    this._sessionExpiry = 0;         // When to re-login
    this._loginAttempted = false;    // Avoid repeated failed logins
  }

  get enabled() {
    return !!(config.valideaCookie || config.valideaEmail);
  }

  // ── Authentication ──────────────────────────────────────────────────

  /**
   * Get valid session cookies for authenticated requests.
   * Priority: manual cookie env var > auto-login > unauthenticated
   */
  async _getSessionCookies() {
    // Priority 1: Manual cookie override (most reliable — bypasses Cloudflare)
    if (config.valideaCookie) {
      return config.valideaCookie;
    }

    // Priority 2: Cached session from previous login
    if (this._sessionCookies && Date.now() < this._sessionExpiry) {
      return this._sessionCookies;
    }

    // Priority 3: Auto-login with email/password
    if (config.valideaEmail && config.valideaPassword && !this._loginAttempted) {
      const cookies = await this._login();
      if (cookies) return cookies;
    }

    // No auth available
    return null;
  }

  /**
   * Attempt to log into Validea and capture session cookies.
   * Validea runs on Classic ASP — login is a form POST with ASPSESSIONID cookies.
   */
  async _login() {
    this._loginAttempted = true;
    console.log('[Validea] Attempting auto-login (Classic ASP)...');

    // Step 1: GET the login page to pick up initial ASPSESSIONID cookie
    let initialCookies = '';
    try {
      const getRes = await fetch(`${VALIDEA_HOST}/login`, {
        headers: BROWSER_HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      const getCookies = getRes.headers.getSetCookie ? getRes.headers.getSetCookie() : [];
      initialCookies = this._parseCookies(getCookies.length > 0 ? getCookies : [getRes.headers.get('set-cookie') || '']) || '';
      console.log(`[Validea] Login page: status ${getRes.status}, cookies: ${getCookies.length}`);

      // Try to find the login form action from the HTML
      if (getRes.ok) {
        const html = await getRes.text();
        const formMatch = html.match(/<form[^>]*action="([^"]*)"[^>]*>/i);
        if (formMatch) {
          console.log(`[Validea] Found login form action: ${formMatch[1]}`);
        }
      }
    } catch (err) {
      console.warn(`[Validea] Could not GET login page: ${err.message}`);
    }

    // Step 2: POST login credentials — try Classic ASP endpoints
    // Classic ASP form fields are typically: username, password, txtUsername, txtPassword
    const loginEndpoints = [
      `${VALIDEA_HOST}/login`,
      `${VALIDEA_HOST}/login.asp`,
      `${VALIDEA_HOST}/account/login`,
      `${VALIDEA_HOST}/checklogin.asp`,
    ];

    // Classic ASP sites use various field name conventions
    const fieldCombos = [
      { username: config.valideaEmail, password: config.valideaPassword },
      { txtUsername: config.valideaEmail, txtPassword: config.valideaPassword },
      { email: config.valideaEmail, password: config.valideaPassword },
      { UserName: config.valideaEmail, Password: config.valideaPassword },
    ];

    for (const url of loginEndpoints) {
      for (const fields of fieldCombos) {
        try {
          const headers = {
            ...BROWSER_HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': `${VALIDEA_HOST}/login`,
          };
          if (initialCookies) {
            headers['Cookie'] = initialCookies;
          }

          const body = new URLSearchParams(fields).toString();

          const res = await fetch(url, {
            method: 'POST',
            headers,
            body,
            redirect: 'manual', // Capture Set-Cookie before redirect
            signal: AbortSignal.timeout(15000),
          });

          // Capture cookies from response
          const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
          const newCookies = this._parseCookies(setCookies.length > 0 ? setCookies : [res.headers.get('set-cookie') || '']);

          // Merge initial + new cookies
          const allCookies = [initialCookies, newCookies].filter(Boolean).join('; ');

          // Classic ASP success: 302 redirect + ASPSESSIONID + username cookie
          const hasAspSession = allCookies.match(/ASPSESSIONID\w+=/i);
          const hasUsername = allCookies.includes('username=');

          if ((res.status === 200 || res.status === 302 || res.status === 303) && hasAspSession) {
            console.log(`[Validea] Login succeeded via ${url} (status ${res.status}, ASP session + username=${!!hasUsername})`);
            this._sessionCookies = allCookies;
            this._sessionExpiry = Date.now() + 4 * 60 * 60 * 1000; // 4 hour session
            this._loginAttempted = false; // Allow re-login after expiry
            return allCookies;
          }

          // Only log interesting results (not 404s)
          if (res.status !== 404 && res.status !== 405) {
            console.log(`[Validea] Login attempt POST ${url} (${Object.keys(fields).join(',')}) — status ${res.status}`);
          }
        } catch (err) {
          if (!err.message.includes('503') && !err.message.includes('timeout')) {
            console.warn(`[Validea] Login POST ${url} failed: ${err.message}`);
          }
        }
      }
    }

    console.warn('[Validea] Auto-login failed — set VALIDEA_COOKIE env var from your browser.');
    console.warn('[Validea] Browser DevTools > Application > Cookies > www.validea.com');
    console.warn('[Validea] Copy: ASPSESSIONID...=value; username=value');
    return null;
  }

  /**
   * Parse Set-Cookie headers into a Cookie header string.
   */
  _parseCookies(setCookieHeaders) {
    const parts = [];
    for (const header of setCookieHeaders) {
      if (!header) continue;
      // Each Set-Cookie may contain multiple cookies separated by comma
      // but also date strings with commas, so split on the cookie name=value part
      const cookieParts = header.split(/,(?=[^ ]+=)/);
      for (const part of cookieParts) {
        const nameValue = part.trim().split(';')[0]; // Take just name=value before attributes
        if (nameValue && nameValue.includes('=')) {
          parts.push(nameValue);
        }
      }
    }
    return parts.length > 0 ? parts.join('; ') : null;
  }

  // ── Fetching ────────────────────────────────────────────────────────

  /**
   * Fetch a Validea page with authentication.
   */
  async _fetchPage(url) {
    const cookies = await this._getSessionCookies();
    const headers = { ...BROWSER_HEADERS };

    if (cookies) {
      headers['Cookie'] = cookies;
    }

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });

    // Capture any new cookies from the response (ASP may rotate session IDs)
    const newSetCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (newSetCookies.length > 0 && this._sessionCookies) {
      const newCookies = this._parseCookies(newSetCookies);
      if (newCookies) {
        this._sessionCookies = this._mergeCookies(this._sessionCookies, newCookies);
      }
    }

    if (!res.ok) {
      // If we got a redirect to login page, our session is invalid
      const finalUrl = res.url || url;
      if (finalUrl.includes('/login') || finalUrl.includes('/sign_in')) {
        this._sessionCookies = null;
        this._sessionExpiry = 0;
        this._loginAttempted = false;
        throw new Error('Session expired — redirected to login');
      }
      throw new Error(`HTTP ${res.status}`);
    }

    const html = await res.text();

    // Detect if we were soft-redirected to login (page contains login form instead of data)
    if ((html.includes('id="login-form"') || html.includes('name="password"')) && !html.includes('guru-analysis')) {
      this._sessionCookies = null;
      this._sessionExpiry = 0;
      throw new Error('Session invalid — received login page instead of data');
    }

    return { html, authenticated: !!cookies };
  }

  /**
   * Merge two cookie strings, letting newer values override older ones.
   */
  _mergeCookies(existing, newer) {
    const map = new Map();
    for (const str of [existing, newer]) {
      for (const part of str.split(';')) {
        const trimmed = part.trim();
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          map.set(trimmed.slice(0, eqIdx).trim(), trimmed);
        }
      }
    }
    return [...map.values()].join('; ');
  }

  // ── Analysis ────────────────────────────────────────────────────────

  /**
   * Fetch and parse Validea guru scores for a stock.
   * @param {string} symbol - Ticker symbol (e.g. AAPL)
   */
  async analyze(symbol) {
    const upper = symbol.toUpperCase();

    // Check cache
    const cached = this._cache.get(upper);
    if (cached && Date.now() < cached.expiry) {
      return cached.data;
    }

    const url = `${VALIDEA_BASE}/${upper}`;

    try {
      const { html, authenticated } = await this._fetchPage(url);

      // Log page size for debugging
      console.log(`[Validea] Fetched ${upper}: ${html.length} chars (auth=${authenticated})`);

      // Parse scores from HTML
      const scores = this._parseScores(html, upper);

      if (scores.length === 0) {
        // Dump a sample of the HTML for debugging
        const sample = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 500);
        console.warn(`[Validea] ${upper}: 0 scores parsed. Page sample: ${sample}`);

        if (!authenticated) {
          return this._buildFallback(upper, 'Could not parse scores — try setting VALIDEA_COOKIE env var for subscriber access');
        }
        return this._buildFallback(upper, 'Could not parse guru scores (page structure may have changed)');
      }

      console.log(`[Validea] ${upper}: parsed ${scores.length} guru scores (top: ${scores[0]?.guru} ${scores[0]?.score}%)`);

      const result = this._buildResult(upper, scores);
      this._cache.set(upper, { data: result, expiry: Date.now() + this._cacheMs });
      return result;
    } catch (err) {
      console.warn(`[Validea] Fetch failed for ${upper}: ${err.message}`);
      return this._buildFallback(upper, `Could not reach Validea: ${err.message}`);
    }
  }

  // ── HTML Parsing ────────────────────────────────────────────────────

  /**
   * Parse guru scores from Validea's HTML.
   * Tries multiple parsing strategies to extract scores.
   */
  _parseScores(html, symbol) {
    let scores = [];

    // Strategy 1: Look for JSON data embedded in <script> tags
    scores = this._parseFromScripts(html);
    if (scores.length > 0) return scores;

    // Strategy 2: Parse score cards / table rows with guru names + percentages
    scores = this._parseFromGuruNames(html);
    if (scores.length > 0) return scores;

    // Strategy 3: Broad percentage pattern matching near score-like contexts
    scores = this._parseFromBroadPatterns(html);
    return scores;
  }

  /**
   * Strategy 1: Look for JSON or structured data in script tags.
   * Many modern sites embed data as JSON in __NEXT_DATA__, window.__data, etc.
   */
  _parseFromScripts(html) {
    const scores = [];

    // Look for Next.js page data
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      try {
        const data = JSON.parse(nextDataMatch[1]);
        return this._extractScoresFromJson(data);
      } catch { /* not JSON */ }
    }

    // Look for window.__data or similar
    const windowDataPatterns = [
      /window\.__data\s*=\s*({[\s\S]*?});/,
      /window\.guruData\s*=\s*({[\s\S]*?});/,
      /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/,
      /data-scores\s*=\s*'([^']+)'/,
      /data-guru\s*=\s*'([^']+)'/,
    ];

    for (const pattern of windowDataPatterns) {
      const match = html.match(pattern);
      if (match) {
        try {
          const data = JSON.parse(match[1]);
          const extracted = this._extractScoresFromJson(data);
          if (extracted.length > 0) return extracted;
        } catch { /* not JSON */ }
      }
    }

    // Look for JSON-LD structured data
    const jsonLdMatches = html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
    for (const m of jsonLdMatches) {
      try {
        const data = JSON.parse(m[1]);
        if (data.rating || data.score || data.aggregateRating) {
          const extracted = this._extractScoresFromJson(data);
          if (extracted.length > 0) return extracted;
        }
      } catch { /* skip */ }
    }

    return scores;
  }

  /**
   * Recursively search a JSON structure for guru score data.
   */
  _extractScoresFromJson(obj, depth = 0) {
    if (depth > 10 || !obj || typeof obj !== 'object') return [];

    const scores = [];

    // Check if this object looks like a score entry
    if (obj.score !== undefined && (obj.guru || obj.name || obj.strategy)) {
      const matchedStrategy = this._matchStrategy(obj.guru || obj.name || obj.strategy || '');
      scores.push({
        id: matchedStrategy?.id || `json_${scores.length}`,
        guru: matchedStrategy?.guru || obj.guru || 'Unknown',
        name: matchedStrategy?.name || obj.name || obj.strategy || 'Unknown Strategy',
        score: typeof obj.score === 'number' ? obj.score : parseInt(obj.score, 10),
        interest: this._scoreToInterest(typeof obj.score === 'number' ? obj.score : parseInt(obj.score, 10)),
      });
      return scores;
    }

    // Check arrays
    if (Array.isArray(obj)) {
      for (const item of obj) {
        scores.push(...this._extractScoresFromJson(item, depth + 1));
      }
      return scores;
    }

    // Recurse into object values
    for (const value of Object.values(obj)) {
      if (typeof value === 'object' && value !== null) {
        scores.push(...this._extractScoresFromJson(value, depth + 1));
      }
    }

    return scores;
  }

  /**
   * Strategy 2: Match known guru/strategy names near percentage values.
   */
  _parseFromGuruNames(html) {
    const scores = [];

    // Strip HTML tags but keep structure hints (newlines for rows)
    const textBlocks = html
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n');

    for (const strategy of GURU_STRATEGIES) {
      // Build flexible patterns for each keyword
      for (const keyword of strategy.keywords) {
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Pattern: keyword ... NN% (within ~200 chars)
        const patterns = [
          new RegExp(`${escaped}[^\\n]{0,200}?(\\d{1,3})\\s*%`, 'i'),
          new RegExp(`(\\d{1,3})\\s*%[^\\n]{0,100}?${escaped}`, 'i'),
          // "keyword ... Score: NN"
          new RegExp(`${escaped}[^\\n]{0,200}?score[^\\d]{0,20}(\\d{1,3})`, 'i'),
        ];

        let found = false;
        for (const pattern of patterns) {
          const match = textBlocks.match(pattern);
          if (match) {
            const score = parseInt(match[1], 10);
            if (score >= 0 && score <= 100 && !scores.find(s => s.id === strategy.id)) {
              scores.push({
                id: strategy.id,
                guru: strategy.guru,
                name: strategy.name,
                score,
                interest: this._scoreToInterest(score),
              });
              found = true;
              break;
            }
          }
        }
        if (found) break;
      }
    }

    return scores;
  }

  /**
   * Strategy 3: Broader pattern — find percentages in score-like contexts.
   */
  _parseFromBroadPatterns(html) {
    const scores = [];

    // Look for table rows or divs with clear score patterns
    // Pattern: "Something Investor" or "Something Strategy" near NN%
    const investorPattern = /([A-Z][a-z]+(?:\s+[A-Za-z/']+){0,4}\s+(?:Investor|Strategy))[^%]{0,100}?(\d{1,3})\s*%/g;
    let match;
    while ((match = investorPattern.exec(html)) !== null) {
      const name = match[1].trim();
      const score = parseInt(match[2], 10);
      if (score >= 0 && score <= 100) {
        const matchedStrategy = this._matchStrategy(name);
        const id = matchedStrategy?.id || `broad_${scores.length}`;
        if (!scores.find(s => s.id === id)) {
          scores.push({
            id,
            guru: matchedStrategy?.guru || 'Unknown',
            name: matchedStrategy?.name || name,
            score,
            interest: this._scoreToInterest(score),
          });
        }
      }
    }

    // Fallback: any NN% near "score", "rating", "grade" keywords
    if (scores.length === 0) {
      const broadPattern = /(?:score|rating|grade)[^%]{0,50}?(\d{1,3})\s*%/gi;
      while ((match = broadPattern.exec(html)) !== null) {
        const score = parseInt(match[1], 10);
        if (score >= 0 && score <= 100) {
          scores.push({
            id: `unknown_${scores.length}`,
            guru: 'Unknown',
            name: `Strategy ${scores.length + 1}`,
            score,
            interest: this._scoreToInterest(score),
          });
        }
      }
    }

    return scores;
  }

  /**
   * Match a text string to a known guru strategy.
   */
  _matchStrategy(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    for (const strategy of GURU_STRATEGIES) {
      for (const keyword of strategy.keywords) {
        if (lower.includes(keyword)) return strategy;
      }
    }
    return null;
  }

  _scoreToInterest(score) {
    if (score >= 90) return 'Strong Interest';
    if (score >= 80) return 'Some Interest';
    if (score >= 60) return 'Neutral';
    return 'Fail';
  }

  // ── Result Builders ─────────────────────────────────────────────────

  _buildResult(symbol, scores) {
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

  // ── Pipeline Integration ────────────────────────────────────────────

  /**
   * Get a simple score summary for the SHARK trading pipeline.
   * Returns a normalized 0-1 "fundamental score" based on Validea data.
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

  /**
   * Force re-login on next request.
   */
  resetSession() {
    this._sessionCookies = null;
    this._sessionExpiry = 0;
    this._loginAttempted = false;
  }

  // ── Discord Formatting ──────────────────────────────────────────────

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
    const scoreBar = '\u2588'.repeat(Math.round(result.avgScore / 10)) + '\u2591'.repeat(10 - Math.round(result.avgScore / 10));
    lines.push(`**Overall Score:** \`${result.avgScore}%\` [${scoreBar}]`);
    lines.push(`**Strategies Evaluated:** ${result.totalStrategies}`);
    lines.push(`**Strong Interest (90%+):** ${result.strongCount} | **Some Interest (80%+):** ${result.someCount}`);
    lines.push('');

    // Top strategies
    if (result.topStrategy) {
      lines.push('__Top Guru Strategies__');
      const topScores = result.scores.slice(0, 8);
      for (const s of topScores) {
        const indicator = s.score >= 90 ? '[++]' : s.score >= 80 ? '[+ ]' : s.score >= 60 ? '[ +]' : '[--]';
        lines.push(`${indicator} **${s.guru}** (${s.name}): \`${s.score}%\` — ${s.interest}`);
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
