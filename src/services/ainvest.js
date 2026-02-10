/**
 * AInvest API Client — PRIORITY data source for the entire bot.
 *
 * Dual transport:
 *   1. MCP (Model Context Protocol) — via https://docsmcp.ainvest.com
 *   2. REST fallback — via https://openapi.ainvest.com/open
 *
 * All 23 endpoints:
 *   Candles, Trades, News Wires, Wire Content, Articles, Article Content,
 *   Analyst Consensus, Analyst History, Financials, Earnings, Financial Statements,
 *   Dividends, Insider Trades, Congress Trades, ETF Profile, ETF Holdings,
 *   Economic Calendar, Earnings Calendar, Dividends Calendar, Splits Calendar,
 *   IPO Calendar, Earnings Backtesting, Securities Search
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
   * @param {string} mcpToolName — MCP tool name
   * @param {object} mcpArgs — MCP tool arguments
   * @param {string} restPath — REST endpoint path
   * @param {object} restParams — REST query params
   */
  async _mcpOrRest(mcpToolName, mcpArgs, restPath, restParams) {
    // Try MCP first (faster, single connection, richer data)
    if (mcpReady && mcp) {
      try {
        const result = await mcp.callTool(mcpToolName, mcpArgs);
        if (result != null) return result;
      } catch (err) {
        console.warn(`[AInvest] MCP tool ${mcpToolName} failed, falling back to REST: ${err.message}`);
      }
    }

    // REST fallback
    return this._fetch(restPath, restParams);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  MARKET DATA
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Fetch OHLCV candles.
   * @param {string} ticker
   * @param {object} [opts]
   * @param {string} [opts.interval='day'] - 'min' | 'day' | 'week' | 'month'
   * @param {number} [opts.count=20]
   */
  async getCandles(ticker, { interval = 'day', count = 20 } = {}) {
    const symbol = ticker.toUpperCase();
    const data = await this._mcpOrRest(
      'get_candles',
      { symbol, period_type: interval, count },
      '/marketdata/candles',
      { symbol, period_type: interval, count },
    );

    if (!Array.isArray(data)) return [];
    return data.map(c => ({
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      dollarVolume: c.dollar_volume || null,
      timestamp: c.timestamp,
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
  async getTrades(ticker) {
    const symbol = ticker.toUpperCase();
    const data = await this._mcpOrRest(
      'get_trades', { symbol },
      '/marketdata/trades', { symbol },
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
    const params = { tab, page_size: Math.min(Math.max(limit, 1), 50) };
    const mcpArgs = { ...params };
    if (tickers.length > 0) {
      params.symbols = tickers.join(',');
      mcpArgs.symbols = tickers.join(',');
    }

    const data = await this._mcpOrRest(
      'get_news_wires', mcpArgs,
      '/news/v1/wire/page/history', params,
    );

    const articles = Array.isArray(data) ? data : (data?.list || []);
    return articles.slice(0, limit).map(a => ({
      title: a.title || a.headline || '',
      summary: (a.summary || a.description || '').slice(0, 500),
      url: a.url || a.source_url || '',
      source: a.source || a.publisher || 'AInvest',
      timestamp: a.published_at || a.created_at || a.timestamp || '',
      tickers: a.symbols || a.tickers || [],
      contentId: a.content_id || a.id || null,
    }));
  }

  /**
   * Fetch full wire content by content ID.
   */
  async getWireContent(contentId) {
    return this._mcpOrRest(
      'get_wire_content', { content_id: contentId },
      `/news/v1/wire/info/${contentId}`, {},
    );
  }

  /**
   * Fetch articles (longer-form analysis pieces).
   */
  async getArticles({ tickers = [], limit = 10 } = {}) {
    const params = { page_size: Math.min(limit, 50) };
    if (tickers.length > 0) params.symbols = tickers.join(',');

    const data = await this._mcpOrRest(
      'get_articles', params,
      '/news/v1/article/page/history', params,
    );

    const articles = Array.isArray(data) ? data : (data?.list || []);
    return articles.slice(0, limit).map(a => ({
      title: a.title || '',
      summary: (a.summary || a.description || '').slice(0, 500),
      url: a.url || '',
      source: a.source || 'AInvest',
      timestamp: a.published_at || a.created_at || '',
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
    const symbol = ticker.toUpperCase();
    const data = await this._mcpOrRest(
      'get_analyst_consensus', { symbol },
      '/analysis-ratings/consensus', { symbol },
    );

    if (!data) return null;
    return {
      buy: data.buy || 0,
      hold: data.hold || 0,
      sell: data.sell || 0,
      strongBuy: data.strong_buy || 0,
      strongSell: data.strong_sell || 0,
      avgRating: data.average_rating || data.avg_rating || null,
      targetHigh: data.target_price_high || data.price_target_high || null,
      targetLow: data.target_price_low || data.price_target_low || null,
      targetAvg: data.target_price_avg || data.price_target_avg || data.average_target_price || null,
      totalAnalysts: (data.buy || 0) + (data.hold || 0) + (data.sell || 0) + (data.strong_buy || 0) + (data.strong_sell || 0),
    };
  }

  /**
   * Get full analyst ratings history (individual firm ratings).
   */
  async getAnalystHistory(ticker, limit = 10) {
    const symbol = ticker.toUpperCase();
    const data = await this._mcpOrRest(
      'get_analyst_ratings', { symbol },
      '/analysis-ratings/history', { symbol },
    );

    const list = Array.isArray(data) ? data : (data?.list || []);
    return list.slice(0, limit).map(r => ({
      date: r.date || r.published_at || '',
      firm: r.firm || r.analyst_firm || '',
      action: r.action || r.rating_action || '',
      rating: r.rating || r.current_rating || '',
      targetPrice: r.target_price ?? r.price_target ?? null,
      previousRating: r.previous_rating || null,
      previousTarget: r.previous_target_price ?? null,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  SECURITIES & COMPANY DATA
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get fundamental financial data (P/E, EPS, margins, etc.).
   */
  async getFinancials(ticker) {
    const symbol = ticker.toUpperCase();
    const data = await this._mcpOrRest(
      'get_company_financials', { symbol },
      '/securities/stock/financials', { symbol },
    );

    if (!data) return null;
    return {
      epsTTM: data.eps_ttm ?? null,
      peTTM: data.pe_ttm ?? null,
      pb: data.pb ?? null,
      roeTTM: data.roe_ttm ?? null,
      grossMargin: data.gross_margin ?? null,
      operatingMargin: data.operating_margin ?? null,
      netMargin: data.net_margin ?? null,
      debtRatio: data.debt_ratio ?? null,
      dividendYield: data.dividend_yield ?? null,
      marketCap: data.market_cap ?? null,
      revenueGrowth: data.revenue_growth ?? null,
      earningsGrowth: data.earnings_growth ?? null,
    };
  }

  /**
   * Get earnings history (actual vs forecast).
   */
  async getEarnings(ticker, limit = 4) {
    const symbol = ticker.toUpperCase();
    const data = await this._mcpOrRest(
      'get_stock_earnings', { symbol },
      '/securities/stock/financials/earnings', { symbol },
    );

    if (!data) return [];
    const list = Array.isArray(data) ? data : (data.list || data.earnings || []);
    return list.slice(0, limit).map(e => ({
      date: e.report_date || e.date || '',
      epsActual: e.eps_actual ?? e.actual_eps ?? null,
      epsForecast: e.eps_forecast ?? e.estimated_eps ?? null,
      epsSurprise: e.eps_surprise ?? e.surprise_percent ?? null,
      revenueActual: e.revenue_actual ?? null,
      revenueForecast: e.revenue_forecast ?? null,
      summary: e.summary || null,
    }));
  }

  /**
   * Get financial statements (income, balance sheet, cash flow).
   */
  async getFinancialStatements(ticker, { type = 'income', period = 'annual' } = {}) {
    const symbol = ticker.toUpperCase();
    return this._mcpOrRest(
      'get_financial_statements', { symbol, statement_type: type, period },
      '/securities/stock/financials/statements', { symbol, statement_type: type, period },
    );
  }

  /**
   * Get stock dividend history.
   */
  async getStockDividends(ticker) {
    const symbol = ticker.toUpperCase();
    return this._mcpOrRest(
      'get_stock_dividends', { symbol },
      '/securities/stock/financials/dividends', { symbol },
    );
  }

  /**
   * Search securities by ticker or name.
   */
  async searchSecurities(query) {
    return this._mcpOrRest(
      'search_securities', { query },
      '/securities/search', { query },
    );
  }

  // ── ETF Data ──────────────────────────────────────────────────────────

  /**
   * Get ETF profile (expense ratio, AUM, etc.).
   */
  async getETFProfile(ticker) {
    const symbol = ticker.toUpperCase();
    return this._mcpOrRest(
      'get_etf_profile', { symbol },
      '/securities/etf/profile', { symbol },
    );
  }

  /**
   * Get top ETF holdings.
   */
  async getETFHoldings(ticker) {
    const symbol = ticker.toUpperCase();
    return this._mcpOrRest(
      'get_etf_holdings', { symbol },
      '/securities/etf/holdings', { symbol },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  OWNERSHIP & TRADING
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get insider trades for a ticker.
   */
  async getInsiderTrades(ticker) {
    const symbol = ticker.toUpperCase();
    const data = await this._mcpOrRest(
      'get_insider_trades', { symbol },
      '/ownership/insider', { symbol },
    );
    return Array.isArray(data) ? data : (data?.list || []);
  }

  /**
   * Get US Congress member trades.
   */
  async getCongressTrades(ticker) {
    const symbol = ticker.toUpperCase();
    const data = await this._mcpOrRest(
      'get_congress_trades', { symbol },
      '/ownership/congress', { symbol },
    );
    return Array.isArray(data) ? data : (data?.list || []);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  CALENDARS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get economic calendar events.
   */
  async getEconomicCalendar({ date, importance } = {}) {
    const params = {};
    if (date) params.date = date;
    if (importance) params.importance = importance;

    const data = await this._mcpOrRest(
      'get_economic_events', params,
      '/calendar/economics', params,
    );

    if (!data) return [];
    const list = Array.isArray(data) ? data : (data.list || data.events || []);
    return list.map(e => ({
      event: e.event || e.title || e.name || '',
      date: e.date || e.time || '',
      importance: e.importance || e.level || 'medium',
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
    const params = {};
    if (date) params.date = date;

    return this._mcpOrRest(
      'get_earnings_calendar', params,
      '/calendar/earnings', params,
    );
  }

  /**
   * Get dividends calendar.
   */
  async getDividendsCalendar(date) {
    const params = {};
    if (date) params.date = date;

    return this._mcpOrRest(
      'get_dividends_calendar', params,
      '/calendar/dividends', params,
    );
  }

  /**
   * Get stock splits calendar.
   */
  async getSplitsCalendar(date) {
    const params = {};
    if (date) params.date = date;

    return this._mcpOrRest(
      'get_splits_calendar', params,
      '/calendar/corporateactions', params,
    );
  }

  /**
   * Get IPO calendar.
   */
  async getIPOCalendar(date) {
    const params = {};
    if (date) params.date = date;

    return this._mcpOrRest(
      'get_ipo_calendar', params,
      '/calendar/ipo', params,
    );
  }

  /**
   * Get earnings backtesting data.
   */
  async getEarningsBacktesting(ticker) {
    const symbol = ticker.toUpperCase();
    return this._mcpOrRest(
      'get_earnings_backtesting', { symbol },
      '/calendar/earnings/backtesting', { symbol },
    );
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
