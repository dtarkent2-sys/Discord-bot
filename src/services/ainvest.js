/**
 * AInvest API Client — News, Candles, Fundamentals, Analyst Ratings, Earnings.
 *
 * Base URL: https://openapi.ainvest.com/open
 * Auth: Authorization: Bearer <AINVEST_API_KEY>
 * Response envelope: { data, status_code, status_msg } where status_code 0 = success
 *
 * Docs: https://docs.ainvest.com
 *
 * Endpoints implemented:
 *   - GET /marketdata/candles         — OHLCV candles (min/day/week/month)
 *   - GET /news/v1/wire/page/history  — News wire with filters
 *   - GET /analysis-ratings/consensus — Analyst buy/hold/sell consensus + target price
 *   - GET /securities/stock/financials — EPS, P/E, margins, dividend yield, etc.
 *   - GET /securities/stock/financials/earnings — Earnings history + surprise %
 *   - GET /calendar/economics         — Economic calendar events
 */

const config = require('../config');

const BASE_URL = config.ainvestBaseUrl || 'https://openapi.ainvest.com/open';

class AInvestService {
  constructor() {
    this._headers = null;
  }

  get enabled() {
    return !!config.ainvestApiKey;
  }

  _getHeaders() {
    if (!this._headers) {
      this._headers = {
        'Authorization': `Bearer ${config.ainvestApiKey}`,
        'Accept': 'application/json',
      };
    }
    return this._headers;
  }

  // ── Generic fetch helper ──────────────────────────────────────────────

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

    // AInvest envelope: { data, status_code, status_msg }
    if (json.status_code !== undefined && json.status_code !== 0) {
      throw new Error(`AInvest API error ${json.status_code}: ${json.status_msg || 'unknown'}`);
    }

    return json.data !== undefined ? json.data : json;
  }

  // ── Candles (OHLCV) ──────────────────────────────────────────────────

  /**
   * Fetch OHLCV candles for a ticker.
   *
   * @param {string} ticker - Stock symbol (e.g. "SPY", "AAPL")
   * @param {object} [opts]
   * @param {string} [opts.interval='day'] - 'min' | 'day' | 'week' | 'month'
   * @param {number} [opts.count=20] - Number of candles
   * @returns {Array<{ open, high, low, close, volume, timestamp }>}
   */
  async getCandles(ticker, { interval = 'day', count = 20 } = {}) {
    const data = await this._fetch('/marketdata/candles', {
      symbol: ticker.toUpperCase(),
      period_type: interval,
      count,
    });

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
   * Get the latest price for a ticker from the most recent candle.
   * Returns a normalized object compatible with price-fetcher.
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

  // ── News Wire ─────────────────────────────────────────────────────────

  /**
   * Fetch news articles from AInvest wire.
   *
   * @param {object} [opts]
   * @param {string} [opts.tab='all'] - 'all' | 'important' | 'earnings' | 'insider_trades' | 'technical'
   * @param {string[]} [opts.tickers] - Filter by ticker symbols
   * @param {number} [opts.limit=10] - Max articles (up to 50)
   * @returns {Array<{ title, summary, url, source, timestamp, tickers }>}
   */
  async getNews({ tab = 'all', tickers = [], limit = 10 } = {}) {
    const params = {
      tab,
      page_size: Math.min(Math.max(limit, 1), 50),
    };
    if (tickers.length > 0) {
      params.symbols = tickers.join(',');
    }

    const data = await this._fetch('/news/v1/wire/page/history', params);

    // data is { list: [...], has_next: bool } or just an array
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

  // ── Analyst Ratings Consensus ─────────────────────────────────────────

  /**
   * Get analyst consensus for a ticker.
   *
   * @param {string} ticker
   * @returns {{ buy, hold, sell, strongBuy, strongSell, avgRating, targetHigh, targetLow, targetAvg, totalAnalysts }}
   */
  async getAnalystConsensus(ticker) {
    const data = await this._fetch('/analysis-ratings/consensus', {
      symbol: ticker.toUpperCase(),
    });

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

  // ── Stock Financials ──────────────────────────────────────────────────

  /**
   * Get fundamental financial data for a ticker.
   *
   * @param {string} ticker
   * @returns {{ epsTTM, peTTM, pb, roeTTM, grossMargin, operatingMargin, netMargin, debtRatio, dividendYield, marketCap, ... }}
   */
  async getFinancials(ticker) {
    const data = await this._fetch('/securities/stock/financials', {
      symbol: ticker.toUpperCase(),
    });

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

  // ── Earnings ──────────────────────────────────────────────────────────

  /**
   * Get earnings history (actual vs forecast) for a ticker.
   *
   * @param {string} ticker
   * @param {number} [limit=4] - Number of quarters
   * @returns {Array<{ date, epsActual, epsForecast, epsSurprise, revenueActual, revenueForecast }>}
   */
  async getEarnings(ticker, limit = 4) {
    const data = await this._fetch('/securities/stock/financials/earnings', {
      symbol: ticker.toUpperCase(),
    });

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

  // ── Economic Calendar ─────────────────────────────────────────────────

  /**
   * Get upcoming economic events.
   *
   * @param {object} [opts]
   * @param {string} [opts.date] - Specific date (YYYY-MM-DD), defaults to today
   * @param {string} [opts.importance] - 'high' | 'medium' | 'low'
   * @returns {Array<{ event, date, importance, actual, forecast, previous }>}
   */
  async getEconomicCalendar({ date, importance } = {}) {
    const params = {};
    if (date) params.date = date;
    if (importance) params.importance = importance;

    const data = await this._fetch('/calendar/economics', params);

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

  // ── Format for AI Prompts ─────────────────────────────────────────────

  /**
   * Format analyst + financial data as context string for LLM prompts.
   *
   * @param {string} ticker
   * @returns {string} Formatted fundamental data block
   */
  async getFundamentalContext(ticker) {
    const sections = [];

    // Fetch all fundamental data in parallel
    const [analysts, financials, earnings] = await Promise.allSettled([
      this.getAnalystConsensus(ticker),
      this.getFinancials(ticker),
      this.getEarnings(ticker, 2),
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

    return sections.filter(Boolean).join('\n');
  }
}

module.exports = new AInvestService();
