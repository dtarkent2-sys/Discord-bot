const CONFIG_MIN_INTERVAL_MS = 60_000;
const CONFIG_MAX_INTERVAL_MS = 86_400_000;
const CONFIG_MAX_COUNT = 1_000;

class AInvestService {
  constructor() {
    this._headers = null;
    this._mcpInitPromise = null;
  }

  get enabled() {
    return !!config.ainvestApiKey;
  }

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

  get mcpEnabled() {
    return mcpReady && mcp;
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

  async _mcpOrRest(mcpToolName, mcpArgs, restPath, restParams) {
    if (mcpReady && mcp) {
      try {
        const result = await mcp.callTool(mcpToolName, mcpArgs);
        if (result == null) {
          console.warn(`[AInvest] MCP tool ${mcpToolName} returned null, falling back to REST`);
        } else if (result.error || (result.status && result.status >= 400)) {
          console.warn(`[AInvest] MCP ${mcpToolName} returned error: ${result.status || ''} ${result.error || ''} — falling back to REST`);
        } else if (result.status_code !== undefined) {
          if (result.status_code !== 0) {
            console.warn(`[AInvest] MCP ${mcpToolName} API error ${result.status_code}: ${result.status_msg || ''} — falling back to REST`);
          } else {
            const unwrapped = result.data !== undefined ? result.data : result;
            console.log(`[AInvest] ${mcpToolName} via MCP OK`);
            return unwrapped;
          }
        } else {
          console.log(`[AInvest] ${mcpToolName} via MCP OK (raw)`);
          return result;
        }
      } catch (err) {
        console.warn(`[AInvest] MCP tool ${mcpToolName} failed, falling back to REST: ${err.message}`);
      }
    }

    const result = await this._fetch(restPath, restParams);
    console.log(`[AInvest] ${restPath} via REST OK`);
    return result;
  }

  async getCandles(ticker, { interval = 'day', step = 1, count = 20 } = {}) {
    const tkr = ticker.toUpperCase();

    if (!Number.isInteger(count) || count <= 0) count = 5;
    if (count > CONFIG_MAX_COUNT) count = CONFIG_MAX_COUNT;

    let fromMs;
    if (interval === 'min') {
      if (!Number.isInteger(step) || step <= 0) step = 1;
      fromMs = Date.now() - count * step * 60 * 1000;
    } else if (interval === 'week') {
      fromMs = Date.now() - count * 7 * 24 * 60 * 60 * 1000;
    } else if (interval === 'month') {
      fromMs = Date.now() - count * 30 * 24 * 60 * 60 * 1000;
    } else {
      fromMs = Date.now() - count * 1.5 * 24 * 60 * 60 * 1000;
    }

    if (fromMs < 0 || fromMs > Date.now()) {
      count = 5;
      const baseStep = interval === 'day' ? 1.5 : interval === 'week' ? 7 : 30;
      fromMs = Date.now() - count * baseStep * 24 * 60 * 60 * 1000;
    }
    const finalInterval = ['min', 'day', 'week', 'month'].includes(interval) ? interval : 'day';

    const timeOffsetStrings = {
      'min': '60 * 1000',
      'day': '24 * 60 * 60 * 1000',
      'week': '7 * 24 * 60 * 60 * 1000',
      'month': '30 * 24 * 60 * 60 * 1000'
    };
    const stepStr = timeOffsetStrings[interval] || '1.5 * 24 * 60 * 60 * 1000';
    const stepCount = Math.max(1, count);
    fromMs = Date.now() - stepCount * step * new Function(`return ${stepStr}`)();

    const restArgs = { ticker: tkr, interval: finalInterval, step, from: Math.floor(fromMs), to: 0 };
    const data = await this._mcpOrRest(
      'get-marketdata-candles',
      restArgs,
      '/marketdata/candles',
      restArgs,
    );

    let candles = data;
    if (!Array.isArray(candles) && candles?.data && Array.isArray(candles.data)) {
      candles = candles.data;
    }
    if (!Array.isArray(candles)) {
      console.warn(`[AInvest] getCandles(${tkr}): unexpected data shape — ${typeof candles}, keys=${candles && typeof candles === 'object' ? Object.keys(candles).join(',') : 'N/A'}`);
      return [];
    }
    return candles.map(c => ({
      open: c.open ?? c.o,
      high: c.high ?? c.h,
      low: c.low ?? c.l,
      close: c.close ?? c.c,
      volume: c.volume ?? c.v,
      dollarVolume: c.dollar_volume ?? c.a ?? null,
      timestamp: c.timestamp ?? c.t,
    }));
  }

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

  async getTrades(ticker, count = 50) {
    const tkr = ticker.toUpperCase();
    const now = Date.now();
    const restParams = { ticker: tkr, count, to: now };
    const mcpArgs = { ...restParams };

    const data = await this._mcpOrRest(
      'get-marketdata-trades', mcpArgs,
      '/marketdata/trades', restParams,
    );
    let payload = data;
    if (!Array.isArray(payload) && !payload?.list && payload?.data) {
      payload = payload.data;
    }
    return Array.isArray(payload) ? payload : (payload?.list || []);
  }

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

    let payload = data;
    if (!Array.isArray(payload) && !payload?.list && payload?.data) {
      payload = payload.data;
    }
    const articles = Array.isArray(payload) ? payload : (payload?.list || []);
    const articleLimit = Math.min(limit, articles.length);
    if (articleLimit === 0) {
      console.warn(`[AInvest] getNews: 0 articles — data shape: ${typeof data}, keys=${data && typeof data === 'object' ? Object.keys(data).join(',') : 'N/A'}`);
    }
    return articles.slice(0, articleLimit).map(a => ({
      title: a.title || a.headline || '',
      summary: (a.summary || a.description || '').slice(0, 500),
      url: a.url || a.source_url || '',
      source: a.source || a.publisher || 'AInvest',
      timestamp: a.published_at || a.publish_time || a.created_at || a.timestamp || '',
      tickers: a.tag_list ? a.tag_list.map(t => t.code || t.ticker).filter(Boolean) : (a.symbols || a.tickers || []),
      contentId: a.content_id || a.id || null,
    }));
  }

  async getWireContent(contentId) {
    return this._fetch(`/news/v1/wire/info/${contentId}`, {});
  }

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

  async getAnalystConsensus(ticker) {
    const tkr = ticker.toUpperCase();
    const data = await this._mcpOrRest(
      'get-analyst-ratings', { ticker: tkr },
      '/analysis-ratings/consensus', { ticker: tkr },
    );

    if (!data) return null;

    let payload = data;
    if (!payload.analysts_ratings && !payload.buy && payload?.data) {
      payload = payload.data;
    }

    const ratings = payload.analysts_ratings || payload;
    const targets = payload.target_price || payload;

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

  async getAnalystHistory(ticker, limit = 10) {
    const tkr = ticker.toUpperCase();
    const data = await this._mcpOrRest(
      'get-analyst-ratings-history', { ticker: tkr },
      '/analysis-ratings/history', { ticker: tkr },
    );

    let payload = data;
    if (!Array.isArray(payload) && !payload?.list && payload?.data) {
      payload = payload.data;
    }
    const list = Array.isArray(payload) ? payload : (payload?.list || []);
    return list.slice(0, limit).map(r => ({
      date: r.date || r.published_at || '',
      firm: r.firm || r.analyst_firm || '',
      action: r.action || r.rating_action || '',
      rating: r.rating || r.current_rating || '',
      targetPrice: r.target_price ?? r.price_target ?? null,
      previousRating: r.previous_rating || r.rating_previous || null,
      previousTarget: r.previous_target_price ?? r.target_price_previous || null,
    }));
  }

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

  async getFinancialStatements(ticker, { period = 4 } = {}) {
    const tkr = ticker.toUpperCase();
    return this._fetch(
      '/securities/stock/financials/statements',
      { ticker: tkr, period },
    );
  }

  async getStockDividends(ticker) {
    const tkr = ticker.toUpperCase();
    return this._fetch('/securities/stock/financials/dividends', { ticker: tkr });
  }

  async searchSecurities(query) {
    return this._mcpOrRest(
      'securities-search', { query },
      '/securities/search', { query },
    );
  }

  async getETFProfile(ticker) {
    const tkr = ticker.toUpperCase();
    return this._fetch('/securities/etf/profile', { ticker: tkr });
  }

  async getETFHoldings(ticker) {
    const tkr = ticker.toUpperCase();
    return this._fetch('/securities/etf/holdings', { ticker: tkr });
  }

  async getInsiderTrades(ticker) {
    const tkr = ticker.toUpperCase();
    const data = await this._mcpOrRest(
      'get-ownership-insider', { ticker: tkr },
      '/ownership/insider', { ticker: tkr },
    );
    let payload = data;
    if (!Array.isArray(payload) && !payload?.list && payload?.data) {
      payload = payload.data;
    }
    return Array.isArray(payload) ? payload : (payload?.list || []);
  }

  async getCongressTrades(ticker) {
    const tkr = ticker.toUpperCase();
    const data = await this._mcpOrRest(
      'get-ownership-congress', { ticker: tkr },
      '/ownership/congress', { ticker: tkr },
    );
    let payload = data;
    if (!Array.isArray(payload) && !payload?.list && payload?.data) {
      payload = payload.data;
    }
    return Array.isArray(payload) ? payload : (payload?.list || []);
  }

  async getEconomicCalendar({ date, importance } = {}) {
    const params = {};
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

  async getEarningsCalendar(date) {
    const d = date || new Date().toISOString().split('T')[0];
    return this._mcpOrRest(
      'get-calendar-earnings', { date: d },
      '/calendar/earnings', { date: d },
    );
  }

  async getDividendsCalendar(date) {
    const d = date || new Date().toISOString().split('T')[0];
    return this._mcpOrRest(
      'get-calendar-dividends', { date: d },
      '/calendar/dividends', { date: d },
    );
  }

  async getSplitsCalendar(date) {
    const d = date || new Date().toISOString().split('T')[0];
    return this._fetch('/calendar/corporateactions', { date: d });
  }

  async getIPOCalendar(date) {
    const d = date || new Date().toISOString().split('T')[0];
    return this._fetch('/calendar/ipo', { date: d });
  }

  async getEarningsBacktesting(uniqueId) {
    return this._fetch('/calendar/earnings/backtesting', { unique_id: uniqueId });
  }

  formatFlowForDiscord({ insider = [], congress = [] }, ticker) {
    const upper = ticker ? ticker.toUpperCase() : 'Market';
    const lines = [`**Smart Money Flow — ${upper}**`, ''];

    if (insider.length > 0) {
      lines.push('**Insider Trades:**');
      for (const t of insider.slice(0, 8)) {
        const name = t.name || t.insider_name || t.full_name || 'Unknown';
        const title = t.title || t.position || '';
        const type = (t.trade_type || t.transaction_type || t.type || '').toUpperCase();
        const isBuy = /buy|purchase|acquisition/i.test(type) || t.acquisition_or_disposition === 'A';
        const emoji = isBuy ? '🟢' : '🔴';
        const shares = t.shares || t.quantity || t.number_of_shares || '?';
        const price = t.price || t.price_per_share ? `@ $${Number(t.price || t.price_per_share).toFixed(2)}` : '';
        const value = t.value || t.total_value;
        const valStr = value ? ` ($${Number(value).toLocaleString()})` : '';
        const date = t.date || t.filing_date || t.transaction_date || '';

        lines.push(`${emoji} **${name}**${title ? ` (${title})` : ''}`);
        lines.push(`   ${isBuy ? 'BUY' : 'SELL'} \`${Number(shares).toLocaleString()}\` shares ${price}${valStr} — ${date}`);
        lines.push('');
      }
      if (insider.length > 8) lines.push(`_...and ${insider.length - 8} more insider trades_\n`);
    } else {
      lines.push('**Insider Trades:** No recent activity\n');
    }

    if (congress.length > 0) {
      lines.push('**Congress Trades:**');
      for (const t of congress.slice(0, 6)) {
        const name = t.name || t.politician || t.congress_member || 'Unknown';
        const party = t.party || '';
        const type = (t.trade_type || t.transaction_type || t.type || '').toUpperCase();
        const isBuy = /buy|purchase/i.test(type);
        const emoji = isBuy ? '🟢' : '🔴';
        const amount = t.amount || t.dollar_amount || t.value || '';
        const date = t.date || t.transaction_date || t.disclosure_date || '';

        lines.push(`${emoji} **${name}**${party ? ` (${party})` : ''}`);
        lines.push(`   ${isBuy ? 'BUY' : 'SELL'} ${amount ? `\`${amount}\`` : ''} — ${date}`);
        lines.push('');
      }
      if (congress.length > 6) lines.push(`_...and ${congress.length - 6} more congress trades_\n`);
    } else {
      lines.push('**Congress Trades:** No recent activity\n');
    }

    lines.push(`_Data via AInvest | ${new Date().toLocaleString()}_`);

    let output = lines.join('\n');
    if (output.length > 1950) output = output.slice(0, 1950) + '\n...';
    return output;
  }

  formatIntelDashboard(ticker, { analysts, financials, earnings, insider, congress, news } = {}) {
    const upper = ticker.toUpperCase();
    const lines = [`**Market Intelligence — ${upper}**`, ''];

    if (analysts) {
      const total = analysts.totalAnalysts || 0;
      const buys = (analysts.strongBuy || 0) + (analysts.buy || 0);
      const holds = analysts.hold || 0;
      const sells = (analysts.sell || 0) + (analysts.strongSell || 0);
      const bias = buys > sells * 2 ? '🟢 STRONG BUY' : buys > sells ? '🟢 BUY' : sells > buys ? '🔴 SELL' : '🟡 HOLD';

      lines.push(`**Analyst Consensus (${total} analysts):** ${bias}`);
      lines.push(`  Buy: \`${buys}\` | Hold: \`${holds}\` | Sell: \`${sells}\``);
      if (analysts.targetAvg) {
        lines.push(`  Target: \`$${analysts.targetLow}\` – \`$${analysts.targetHigh}\` (avg \`$${analysts.targetAvg}\`)`);
      }
      lines.push('');
    }

    if (financials) {
      const parts = [];
      if (financials.peTTM != null) parts.push(`P/E: \`${financials.peTTM.toFixed(1)}\``);
      if (financials.epsTTM != null) parts.push(`EPS: \`$${financials.epsTTM.toFixed(2)}\``);
      if (financials.roeTTM != null) parts.push(`ROE: \`${(financials.roeTTM * 100).toFixed(1)}%\``);
      if (financials.netMargin != null) parts.push(`Net Margin: \`${(financials.netMargin * 100).toFixed(1)}%\``);
      if (financials.marketCap != null) parts.push(`Mkt Cap: \`$${(financials.marketCap / 1e9).toFixed(1)}B\``);
      if (parts.length > 0) {
        lines.push(`**Fundamentals:** ${parts.join(' | ')}`);
        lines.push('');
      }
    }

    if (earnings && earnings.length > 0) {
      lines.push('**Recent Earnings:**');
      for (const e of earnings.slice(0, 2)) {
        const surprise = e.epsSurprise != null ? ` (${e.epsSurprise > 0 ? '+' : ''}${e.epsSurprise}%)` : '';
        const beat = e.epsSurprise > 0 ? '🟢' : e.epsSurprise < 0 ? '🔴' : '🟡';
        lines.push(`  ${beat} ${e.date}: EPS \`$${e.epsActual ?? 'N/A'}\` vs est \`$${e.epsForecast ?? 'N/A'}\`${surprise}`);
      }
      lines.push('');
    }

    if (insider && insider.length > 0) {
      lines.push('**Insider Trades (recent):**');
      for (const t of insider.slice(0, 3)) {
        const name = t.name || t.insider_name || t.full_name || 'Unknown';
        const type = t.trade_type || t.transaction_type || '?';
        const shares = t.shares || t.quantity || t.number_of_shares || '?';
        const date = t.date || t.filing_date || '';
        lines.push(`  ${type}: ${name} — ${Number(shares).toLocaleString()} shares (${date})`);
      }
      lines.push('');
    }

    if (congress && congress.length > 0) {
      lines.push('**Congress Trades:**');
      for (const t of congress.slice(0, 3)) {
        const name = t.name || t.politician || t.congress_member || 'Unknown';
        const type = t.trade_type || t.transaction_type || '?';
        const isBuy = /buy|purchase/i.test(type);
        const emoji = isBuy ? '🟢 BUY' : '🔴 SELL';
        const amount = t.amount || t.dollar_amount || t.value || '';
        const date = t.date || t.transaction_date || '';
        lines.push(`  ${emoji} ${name} — ${amount ? `\`${amount}\`` : ''} (${date})`);
      }
      lines.push('');
    }

    if (news && news.length > 0) {
      lines.push('**Latest News:**');
      for (const n of news.slice(0, 3)) {
        lines.push(`  - ${n.title}`);
      }
      lines.push('');
    }

    lines.push(`_Data via AInvest | ${new Date().toLocaleString()}_`);

    let output = lines.join('\n');
    if (output.length > 1950) output = output.slice(0, 1950) + '\n...';
    return output;
  }

  async getEnrichmentForAnalysis(ticker) {
    if (!this.enabled) return '';

    const upper = ticker.toUpperCase();
    const sections = [];

    const results = await Promise.allSettled([
      this.getAnalystConsensus(upper),
      this.getFinancials(upper),
      this.getEarnings(upper, 2),
      this.getInsiderTrades(upper).then(t => t.slice(0, 5)),
      this.getCongressTrades(upper).then(t => t.slice(0, 3)),
    ]);

    const [analystResult, financialsResult, earningsResult, insiderResult, congressResult] = results;

    if (analystResult.status === 'fulfilled' && analystResult.value) {
      const a = analystResult.value;
      const buys = (a.strongBuy || 0) + (a.buy || 0);
      const sells = (a.sell || 0) + (a.strongSell || 0);
      const bias = buys > sells * 2 ? 'STRONG BUY' : buys > sells ? 'BUY LEAN' : sells > buys ? 'SELL LEAN' : 'NEUTRAL';

      sections.push(`ANALYST CONSENSUS (${a.totalAnalysts} analysts):
  Buy: ${buys} | Hold: ${a.hold || 0} | Sell: ${sells}
  Consensus: ${bias}${a.targetAvg ? `\n  Price Target: $${a.targetLow}–$${a.targetHigh} (avg $${a.targetAvg})` : ''}`);
    }

    if (financialsResult.status === 'fulfilled' && financialsResult.value) {
      const f = financialsResult.value;
      const parts = [];
      if (f.peTTM != null) parts.push(`P/E: ${f.peTTM.toFixed(1)}`);
      if (f.epsTTM != null) parts.push(`EPS: $${f.epsTTM.toFixed(2)}`);
      if (f.roeTTM != null) parts.push(`ROE: ${(f.roeTTM * 100).toFixed(1)}%`);
      if (f.netMargin != null) parts.push(`Net Margin: ${(f.netMargin * 100).toFixed(1)}%`);
      if (f.marketCap != null) parts.push(`Mkt Cap: $${(f.marketCap / 1e9).toFixed(1)}B`);
      if (parts.length > 0) {
        sections.push(`FUNDAMENTALS: ${parts.join(' | ')}`);
      }
    }

    if (earningsResult.status === 'fulfilled' && earningsResult.value?.length > 0) {
      sections.push('RECENT EARNINGS:');
      for (const e of earningsResult.value) {
        const surprise = e.epsSurprise != null ? ` (${e.epsSurprise > 0 ? '+' : ''}${e.epsSurprise}% surprise)` : '';
        sections.push(`  ${e.date}: EPS $${e.epsActual ?? 'N/A'} vs est $${e.epsForecast ?? 'N/A'}${surprise}`);
      }
    }

    if (insiderResult.status === 'fulfilled' && insiderResult.value?.length > 0) {
      const trades = insiderResult.value;
      sections.push('INSIDER TRADING (AInvest):');
      for (const t of trades) {
        const name = t.name || t.insider_name || 'Unknown';
        const type = t.trade_type || t.transaction_type || t.type || '?';
        const shares = t.shares || t.quantity || '?';
        sections.push(`  ${type}: ${name} — ${Number(shares).toLocaleString()} shares (${t.date || t.filing_date || ''})`);
      }
    }

    if (congressResult.status === 'fulfilled' && congressResult.value?.length > 0) {
      sections.push('CONGRESS TRADES (AInvest):');
      for (const t of congressResult.value) {
        const name = t.name || t.politician || 'Unknown';
        const type = t.trade_type || t.transaction_type || '?';
        const amount = t.amount || t.dollar_amount || '';
        sections.push(`  ${type}: ${name} — ${amount} (${t.date || ''})`);
      }
    }

    if (sections.length === 0) return '';
    return `=== AINVEST MARKET INTELLIGENCE ===\n${sections.join('\n')}`;
  }

  async getFundamentalContext(ticker) {
    const sections = [];

    const [analysts, financials, earnings, insiders, econ] = await Promise.allSettled([
      this.getAnalystConsensus(ticker),
      this.getFinancials(ticker),
      this.getEarnings(ticker, 2),
      this.getInsiderTrades(ticker).then(t => t.slice(0, 3)),
      this.getEconomicCalendar({ importance: 'high' }).then(e => e.slice(0, 3)),
    ]);

    if (analysts.status === 'fulfilled' && analysts.value) {
      const a = analysts.value;
      sections.push(
        `ANALYST CONSENSUS (${a.totalAnalysts} analysts):`,
        `  Buy: ${a.strongBuy + a.buy} | Hold: ${a.hold} | Sell: ${a.sell + a.strongSell}`,
        a.targetAvg ? `  Price Target: $${a.targetLow}–$${a.targetHigh} (avg $${a.targetAvg})` : '',
      );
    }

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

    if (earnings.status === 'fulfilled' && earnings.value && earnings.value.length > 0) {
      sections.push('RECENT EARNINGS:');
      for (const e of earnings.value) {
        const surprise = e.epsSurprise != null ? ` (${e.epsSurprise > 0 ? '+' : ''}${e.epsSurprise}% surprise)` : '';
        sections.push(`  ${e.date}: EPS $${e.epsActual ?? 'N/A'} vs est $${e.epsForecast ?? 'N/A'}${surprise}`);
      }
    }

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