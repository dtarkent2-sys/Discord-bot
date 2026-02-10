/**
 * AInvest API Client — PRIORITY data source for the entire bot.
 *
 * Dual transport:
 *   1. MCP (Model Context Protocol) — via https://docsmcp.ainvest.com
 *   2. REST fallback — via https://openapi.ainvest.com/open
 *
 * MCP tool names (discovered at runtime, 11 tools):
 *   get-marketdata-candles, get-marketdata-trades, get-news-headlines,
 *   get-analyst-ratings, get-analyst-ratings-history, get-analyst-ratings-firms,
 *   get-ownership-insider, get-ownership-congress, securities-search,
 *   get-calendar-dividends, get-calendar-earnings
 *
 * REST endpoints (23 total):
 *   /marketdata/candles, /marketdata/trades,
 *   /news/v1/wire/page/history, /news/v1/wire/info/:id,
 *   /news/v1/article/page/history, /news/v1/article/info/:id,
 *   /analysis-ratings/consensus, /analysis-ratings/history,
 *   /securities/stock/financials, /securities/stock/financials/earnings,
 *   /securities/stock/financials/statements, /securities/stock/financials/dividends,
 *   /securities/search, /securities/etf/profile, /securities/etf/holdings,
 *   /ownership/insider, /ownership/congress,
 *   /calendar/economics, /calendar/earnings, /calendar/dividends,
 *   /calendar/corporateactions, /calendar/ipo, /calendar/earnings/backtesting
 *
 * Auth: Authorization: Bearer <AINVEST_API_KEY>
 * Docs: https://docs.ainvest.com
 */

const config = require('../config');

const BASE_URL = config.ainvestBaseUrl || 'https://openapi.ainvest.com/open';

// MCP client — loaded defensively (non-blocking if MCP fails)
let mcp = null;
let mcpReady = false;

class AInvestService {
  constructor() {
    this._headers = null;
    this._mcpInitPromise = null;
  }

  get enabled() {
    return !!config.ainvestApiKey;
  }

  // ── MCP initialization (background, non-blocking) ─────────────────────

  /**
   * Initialize the MCP connection in the background.
   * Call this once at startup. Does NOT block — the REST API works immediately.
   */
  async initMCP() {
    if (!this.enabled) return;
    if (this._mcpInitPromise) return this._mcpInitPromise;

    this._mcpInitPromise = (async () => {
      try {
        mcp = require('./ainvest-mcp');
        await mcp.initialize();
        mcpReady = true;
        console.log(`[AInvest] MCP connected — ${mcp.getToolNames().length} tools available`);
      } catch (err) {
        console.warn(`[AInvest] MCP init failed (using REST fallback): ${err.message}`);
        mcpReady = false;
      }
    })();

    return this._mcpInitPromise;
  }

  /** Whether MCP transport is available */
  get mcpEnabled() {
    return mcpReady && mcp;
  }

  // ── REST helpers ──────────────────────────────────────────────────────

  _getHeaders() {
    if (!this._headers) {
      this._headers = {
        'Authorization': `Bearer ${config.ainvestApiKey}`,
        'Accept': 'application/json',
      };
    }
    return this._headers;
  }

  async _fetch(path, params = {}, timeoutMs = 15000) {
    if (!this.enabled) throw new Error('AINVEST_API_KEY not configured');

    const url = new URL(`${BASE_URL}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, String(v));
    }

    const res = await fetch(url.toString(), {
      headers: this._getHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`AInvest ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = await res.json();

    if (json.status_code !== undefined && json.status_code !== 0) {
      throw new Error(`AInvest API error ${json.status_code}: ${json.status_msg || 'unknown'}`);
    }

    return json.data !== undefined ? json.data : json;
  }

  /**
   * Try MCP first, fall back to REST.
   * @param {string} mcpToolName — MCP tool name (hyphenated, e.g. 'get-marketdata-candles')
   * @param {object} mcpArgs — MCP tool arguments
   * @param {string} restPath — REST endpoint path
   * @param {object} restParams — REST query params
   */
  async _mcpOrRest(mcpToolName, mcpArgs, restPath, restParams) {
    // Try MCP first (faster, single connection, richer data)
    if (mcpReady && mcp) {
      try {
        const result = await mcp.callTool(mcpToolName, mcpArgs);
        if (result != null) {
          console.log(`[AInvest] ${mcpToolName} via MCP OK`);
          return result;
        }
        console.warn(`[AInvest] MCP tool ${mcpToolName} returned null, falling back to REST`);
      } catch (err) {
        console.warn(`[AInvest] MCP tool ${mcpToolName} failed, falling back to REST: ${err.message}`);
      }
    }

    // REST fallback
    const result = await this._fetch(restPath, restParams);
    console.log(`[AInvest] ${restPath} via REST OK`);
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  MARKET DATA
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Fetch OHLCV candles.
   * @param {string} ticker
   * @param {object} [opts]
   * @param {string} [opts.interval='day'] - 'min' | 'day' | 'week' | 'month'
   * @param {number} [opts.step=1] - Aggregation multiplier (e.g. 15 for 15-min candles)
   * @param {number} [opts.count=20] - How many candles to request (used to compute 'from')
   */
  async getCandles(ticker, { interval = 'day', step = 1, count = 20 } = {}) {
    const tkr = ticker.toUpperCase();

    // Compute 'from' timestamp (ms) based on count + interval
    const now = Date.now();
    let fromMs;
    if (interval === 'min') {
      fromMs = now - count * step * 60 * 1000;
    } else if (interval === 'week') {
      fromMs = now - count * 7 * 24 * 60 * 60 * 1000;
    } else if (interval === 'month') {
      fromMs = now - count * 30 * 24 * 60 * 60 * 1000;
    } else {
      // 'day' default — add extra days for weekends/holidays
      fromMs = now - count * 1.5 * 24 * 60 * 60 * 1000;
    }

    const restArgs = { ticker: tkr, interval, step, from: Math.floor(fromMs), to: 0 };
    const data = await this._mcpOrRest(
      'get-marketdata-candles',
      restArgs,
      '/marketdata/candles',
      restArgs,
    );

    if (!Array.isArray(data)) return [];
    return data.map(c => ({
      open: c.open ?? c.o,
      high: c.high ?? c.h,
      low: c.low ?? c.l,
      close: c.close ?? c.c,
      volume: c.volume ?? c.v,
      dollarVolume: c.dollar_volume ?? c.a ?? null,
      timestamp: c.timestamp ?? c.t,
    }));
  }

  /**
   * Get normalized price quote from latest candles (compatible with price-fetcher).
   */
  async getQuote(ticker) {
    const candles = await this.getCandles(ticker, { interval: 'day', count: 2 });
    if (!candles || candles.length === 0) return null;

    const latest = candles[candles.length - 1];
    const prev = candles.length > 1 ? candles[candles.length - 2] : null;
    const price = latest.close;
    const prevClose = prev ? prev.close : null;
    const change = prevClose ? price - prevClose : null;
    const changePercent = prevClose ? (change / prevClose) * 100 : null;

    return {
      ticker: ticker.toUpperCase(),
      symbol: ticker.toUpperCase(),
      price,
      change,
      changePercent,
      volume: latest.volume,
      marketCap: null,
      dayHigh: latest.high,
      dayLow: latest.low,
      previousClose: prevClose,
      fiftyTwoWeekHigh: null,
      fiftyTwoWeekLow: null,
      lastUpdated: new Date().toISOString(),
      source: 'ainvest',
    };
  }

  /**
   * Fetch current-day tick trades for a ticker.
   */
  async getTrades(ticker, count = 50) {
    const tkr = ticker.toUpperCase();
    const now = Date.now();
    const data = await this._mcpOrRest(
      'get-marketdata-trades', { ticker: tkr, count, to: now },
      '/marketdata/trades', { ticker: tkr, count, to: now },
    );
    return Array.isArray(data) ? data : (data?.list || []);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  NEWS & CONTENT
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Fetch news wire articles.
   * @param {object} [opts]
   * @param {string} [opts.tab='all'] - 'all'|'important'|'earnings'|'insider_trades'|'technical'
   * @param {string[]} [opts.tickers]
   * @param {number} [opts.limit=10]
   */
  async getNews({ tab = 'all', tickers = [], limit = 10 } = {}) {
    const size = Math.min(Math.max(limit, 1), 50);
    const restParams = { tab, size };
    const mcpArgs = { ...restParams };

    if (tickers.length > 0) {
      restParams.tickers = tickers.join(',');
      mcpArgs.tickers = tickers.join(',');
    }

    const data = await this._mcpOrRest(
      'get-news-headlines', mcpArgs,
      '/news/v1/wire/page/history', restParams,
    );

    const articles = Array.isArray(data) ? data : (data?.list || []);
    return articles.slice(0, limit).map(a => ({
      title: a.title || a.headline || '',
      summary: (a.summary || a.description || '').slice(0, 500),
      url: a.url || a.source_url || '',
      source: a.source || a.publisher || 'AInvest',
      timestamp: a.published_at || a.publish_time || a.created_at || a.timestamp || '',
      tickers: a.tag_list ? a.tag_list.map(t => t.code || t.ticker).filter(Boolean) : (a.symbols || a.tickers || []),
      contentId: a.content_id || a.id || null,
    }));
  }

  /**
   * Fetch full wire content by content ID. (REST only — no MCP tool)
   */
  async getWireContent(contentId) {
    return this._fetch(`/news/v1/wire/info/${contentId}`, {});
  }

  /**
   * Fetch articles (longer-form analysis pieces). (REST only — no MCP tool)
   */
  async getArticles({ limit = 10 } = {}) {
    const params = { size: Math.min(limit, 50) };

    const data = await this._fetch('/news/v1/article/page/history', params);

    const articles = Array.isArray(data) ? data : (data?.list || []);
    return articles.slice(0, limit).map(a => ({
      title: a.title || '',
      summary: (a.summary || a.description || '').slice(0, 500),
      url: a.url || '',
      source: a.source || 'AInvest',
      timestamp: a.published_at || a.publish_time || a.created_at || '',
      contentId: a.content_id || a.id || null,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  ANALYST RATINGS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get analyst consensus (buy/hold/sell + price targets).
   */
  async getAnalystConsensus(ticker) {
    const tkr = ticker.toUpperCase();
    const data = await this._mcpOrRest(
      'get-analyst-ratings', { ticker: tkr },
      '/analysis-ratings/consensus', { ticker: tkr },
    );

    if (!data) return null;

    // REST response is nested: { analysts_ratings: {...}, target_price: {...} }
    // MCP may return flat or nested — handle both
    const ratings = data.analysts_ratings || data;
    const targets = data.target_price || data;

    return {
      buy: ratings.buy || 0,
      hold: ratings.hold || 0,
      sell: ratings.sell || 0,
      strongBuy: ratings.strong_buy || 0,
      strongSell: ratings.strong_sell || 0,
      avgRating: ratings.average_rating || ratings.avg_rating || null,
      targetHigh: targets.high || targets.target_price_high || null,
      targetLow: targets.low || targets.target_price_low || null,
      targetAvg: targets.average || targets.target_price_avg || targets.average_target_price || null,
      totalAnalysts: (ratings.buy || 0) + (ratings.hold || 0) + (ratings.sell || 0) + (ratings.strong_buy || 0) + (ratings.strong_sell || 0),
    };
  }

  /**
   * Get full analyst ratings history (individual firm ratings).
   */
  async getAnalystHistory(ticker, limit = 10) {
    const tkr = ticker.toUpperCase();
    const data = await this._mcpOrRest(
      'get-analyst-ratings-history', { ticker: tkr },
      '/analysis-ratings/history', { ticker: tkr },
    );

    const list = Array.isArray(data) ? data : (data?.list || []);
    return list.slice(0, limit).map(r => ({
      date: r.date || r.published_at || '',
      firm: r.firm || r.analyst_firm || '',
      action: r.action || r.rating_action || '',
      rating: r.rating || r.current_rating || '',
      targetPrice: r.target_price ?? r.price_target ?? null,
      previousRating: r.previous_rating || r.rating_previous || null,
      previousTarget: r.previous_target_price ?? r.target_price_previous ?? null,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  SECURITIES & COMPANY DATA
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get fundamental financial data (P/E, EPS, margins, etc.). (REST only)
   */
  async getFinancials(ticker) {
    const tkr = ticker.toUpperCase();
    const data = await this._fetch('/securities/stock/financials', { ticker: tkr });

    if (!data) return null;
    return {
      epsTTM: data.eps_ttm ?? null,
      peTTM: data.pe_ttm ?? null,
      pb: data.pb ?? null,
      roeTTM: data.roe_ttm ?? null,
      grossMargin: data.gross_profit_ratio_ttm ?? data.gross_margin ?? null,
      operatingMargin: data.operating_margin ?? null,
      netMargin: data.net_profit_ratio_ttm ?? data.net_margin ?? null,
      debtRatio: data.assets_debt_ratio ?? data.debt_ratio ?? null,
      dividendYield: data.dividend_yield_ratio_ttm ?? data.dividend_yield ?? null,
      marketCap: data.market_cap ?? null,
      revenueGrowth: data.revenue_growth ?? null,
      earningsGrowth: data.earnings_growth ?? data.net_profit_yoy ?? null,
    };
  }

  /**
   * Get earnings history (actual vs forecast). (REST only)
   */
  async getEarnings(ticker, limit = 4) {
    const tkr = ticker.toUpperCase();
    const data = await this._fetch(
      '/securities/stock/financials/earnings',
      { ticker: tkr, size: limit },
    );

    if (!data) return [];
    const list = Array.isArray(data) ? data : (data.list || data.earnings || []);
    return list.slice(0, limit).map(e => ({
      date: e.release_date || e.report_date || e.date || '',
      periodName: e.period_name || null,
      epsActual: e.eps_actual ?? e.actual_eps ?? null,
      epsForecast: e.eps_forecast ?? e.estimated_eps ?? null,
      epsSurprise: e.eps_surprise ?? e.surprise_percent ?? null,
      revenueActual: e.revenue_actual ?? null,
      revenueForecast: e.revenue_forecast ?? null,
      revenueSurprise: e.revenue_surprise ?? null,
      summary: e.earnings_call_summary || e.summary || null,
    }));
  }

  /**
   * Get financial statements (income, balance sheet, cash flow). (REST only)
   * @param {string} ticker
   * @param {object} [opts]
   * @param {number} [opts.period=4] - 0=each, 1=Q1, 2=mid-year, 3=Q3, 4=annual
   */
  async getFinancialStatements(ticker, { period = 4 } = {}) {
    const tkr = ticker.toUpperCase();
    return this._fetch(
      '/securities/stock/financials/statements',
      { ticker: tkr, period },
    );
  }

  /**
   * Get stock dividend history. (REST only)
   */
  async getStockDividends(ticker) {
    const tkr = ticker.toUpperCase();
    return this._fetch('/securities/stock/financials/dividends', { ticker: tkr });
  }

  /**
   * Search securities by ticker or name.
   */
  async searchSecurities(query) {
    return this._mcpOrRest(
      'securities-search', { query },
      '/securities/search', { query },
    );
  }

  // ── ETF Data ──────────────────────────────────────────────────────────

  /**
   * Get ETF profile (expense ratio, AUM, etc.). (REST only)
   */
  async getETFProfile(ticker) {
    const tkr = ticker.toUpperCase();
    return this._fetch('/securities/etf/profile', { ticker: tkr });
  }

  /**
   * Get top ETF holdings. (REST only)
   */
  async getETFHoldings(ticker) {
    const tkr = ticker.toUpperCase();
    return this._fetch('/securities/etf/holdings', { ticker: tkr });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  OWNERSHIP & TRADING
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get insider trades for a ticker.
   */
  async getInsiderTrades(ticker) {
    const tkr = ticker.toUpperCase();
    const data = await this._mcpOrRest(
      'get-ownership-insider', { ticker: tkr },
      '/ownership/insider', { ticker: tkr },
    );
    return Array.isArray(data) ? data : (data?.list || []);
  }

  /**
   * Get US Congress member trades.
   */
  async getCongressTrades(ticker) {
    const tkr = ticker.toUpperCase();
    const data = await this._mcpOrRest(
      'get-ownership-congress', { ticker: tkr },
      '/ownership/congress', { ticker: tkr },
    );
    return Array.isArray(data) ? data : (data?.list || []);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  CALENDARS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get economic calendar events. (REST only — no MCP tool)
   */
  async getEconomicCalendar({ date, importance } = {}) {
    const params = {};
    // Default to today's date (required by API)
    params.date = date || new Date().toISOString().split('T')[0];
    if (importance) params.importance = importance;

    const data = await this._fetch('/calendar/economics', params);

    if (!data) return [];
    const list = Array.isArray(data) ? data : (data.list || data.events || []);
    return list.map(e => ({
      event: e.index || e.event || e.title || e.name || '',
      date: e.date || e.time || '',
      importance: e.importance ?? 'medium',
      actual: e.actual ?? null,
      forecast: e.forecast ?? e.consensus ?? null,
      previous: e.previous ?? null,
      country: e.country || 'US',
    }));
  }

  /**
   * Get earnings calendar for a date.
   */
  async getEarningsCalendar(date) {
    // Default to today's date (required by API)
    const d = date || new Date().toISOString().split('T')[0];

    return this._mcpOrRest(
      'get-calendar-earnings', { date: d },
      '/calendar/earnings', { date: d },
    );
  }

  /**
   * Get dividends calendar.
   */
  async getDividendsCalendar(date) {
    const d = date || new Date().toISOString().split('T')[0];

    return this._mcpOrRest(
      'get-calendar-dividends', { date: d },
      '/calendar/dividends', { date: d },
    );
  }

  /**
   * Get stock splits calendar. (REST only)
   */
  async getSplitsCalendar(date) {
    const d = date || new Date().toISOString().split('T')[0];
    return this._fetch('/calendar/corporateactions', { date: d });
  }

  /**
   * Get IPO calendar. (REST only)
   */
  async getIPOCalendar(date) {
    const d = date || new Date().toISOString().split('T')[0];
    return this._fetch('/calendar/ipo', { date: d });
  }

  /**
   * Get earnings backtesting data. (REST only)
   * @param {string} uniqueId — from earnings calendar `unique_id` field
   */
  async getEarningsBacktesting(uniqueId) {
    return this._fetch('/calendar/earnings/backtesting', { unique_id: uniqueId });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  FORMATTED CONTEXT FOR AI PROMPTS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Build a comprehensive fundamental context block for LLM prompts.
   * Fetches analyst ratings, financials, earnings, insider trades, and economic events.
   *
   * @param {string} ticker
   * @returns {string} Formatted multi-section context
   */
  async getFundamentalContext(ticker) {
    const sections = [];

    // Fetch all data in parallel
    const [analysts, financials, earnings, insiders, econ] = await Promise.allSettled([
      this.getAnalystConsensus(ticker),
      this.getFinancials(ticker),
      this.getEarnings(ticker, 2),
      this.getInsiderTrades(ticker).then(t => t.slice(0, 3)),
      this.getEconomicCalendar({ importance: 'high' }).then(e => e.slice(0, 3)),
    ]);

    // Analyst ratings
    if (analysts.status === 'fulfilled' && analysts.value) {
      const a = analysts.value;
      sections.push(
        `ANALYST CONSENSUS (${a.totalAnalysts} analysts):`,
        `  Buy: ${a.strongBuy + a.buy} | Hold: ${a.hold} | Sell: ${a.sell + a.strongSell}`,
        a.targetAvg ? `  Price Target: $${a.targetLow}–$${a.targetHigh} (avg $${a.targetAvg})` : '',
      );
    }

    // Financials
    if (financials.status === 'fulfilled' && financials.value) {
      const f = financials.value;
      const parts = [];
      if (f.peTTM != null) parts.push(`P/E: ${f.peTTM.toFixed(1)}`);
      if (f.epsTTM != null) parts.push(`EPS: $${f.epsTTM.toFixed(2)}`);
      if (f.pb != null) parts.push(`P/B: ${f.pb.toFixed(1)}`);
      if (f.roeTTM != null) parts.push(`ROE: ${(f.roeTTM * 100).toFixed(1)}%`);
      if (f.dividendYield != null) parts.push(`Div Yield: ${(f.dividendYield * 100).toFixed(2)}%`);
      if (f.netMargin != null) parts.push(`Net Margin: ${(f.netMargin * 100).toFixed(1)}%`);
      if (f.debtRatio != null) parts.push(`Debt Ratio: ${f.debtRatio.toFixed(2)}`);
      if (f.marketCap != null) parts.push(`Mkt Cap: $${(f.marketCap / 1e9).toFixed(1)}B`);
      if (parts.length > 0) {
        sections.push(`FUNDAMENTALS: ${parts.join(' | ')}`);
      }
    }

    // Earnings
    if (earnings.status === 'fulfilled' && earnings.value && earnings.value.length > 0) {
      sections.push('RECENT EARNINGS:');
      for (const e of earnings.value) {
        const surprise = e.epsSurprise != null ? ` (${e.epsSurprise > 0 ? '+' : ''}${e.epsSurprise}% surprise)` : '';
        sections.push(`  ${e.date}: EPS $${e.epsActual ?? 'N/A'} vs est $${e.epsForecast ?? 'N/A'}${surprise}`);
      }
    }

    // Insider trades (smart money signal)
    if (insiders.status === 'fulfilled' && insiders.value && insiders.value.length > 0) {
      sections.push('RECENT INSIDER TRADES:');
      for (const t of insiders.value) {
        const name = t.name || t.insider_name || 'Unknown';
        const type = t.trade_type || t.transaction_type || t.type || '?';
        const shares = t.shares || t.quantity || '?';
        const price = t.price ? `@ $${t.price}` : '';
        sections.push(`  ${name}: ${type} ${shares} shares ${price}`);
      }
    }

    // Economic calendar (macro context)
    if (econ.status === 'fulfilled' && econ.value && econ.value.length > 0) {
      sections.push('HIGH-IMPACT ECONOMIC EVENTS TODAY:');
      for (const e of econ.value) {
        const actual = e.actual != null ? `Actual: ${e.actual}` : '';
        const forecast = e.forecast != null ? `Est: ${e.forecast}` : '';
        sections.push(`  ${e.event} — ${[actual, forecast].filter(Boolean).join(' | ') || 'Pending'}`);
      }
    }

    return sections.filter(Boolean).join('\n');
  }
}

module.exports = new AInvestService();
