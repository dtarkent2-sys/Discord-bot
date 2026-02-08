const config = require('../config');

const BASE_URL = 'https://api.portfolio123.com';

class P123Client {
  constructor() {
    this._token = null;
    this._tokenExpiry = 0;

    // Debug: log what env vars we found
    console.log(`[P123] API ID: ${config.p123ApiId ? 'set (' + config.p123ApiId.slice(0, 4) + '...)' : 'NOT SET'}`);
    console.log(`[P123] API Key: ${config.p123ApiKey ? 'set (' + config.p123ApiKey.slice(0, 4) + '...)' : 'NOT SET'}`);

    // Log which env var names have values (helps debug naming mismatches)
    const p123Vars = ['P123_API_ID', 'P123_API_KEY', 'PORTFOLIO123_API_ID', 'PORTFOLIO123_API_KEY', 'P123_ID', 'P123_KEY'];
    const found = p123Vars.filter(v => !!process.env[v]);
    if (found.length > 0) {
      console.log(`[P123] Found env vars: ${found.join(', ')}`);
    } else {
      console.log(`[P123] No P123 env vars found. Checked: ${p123Vars.join(', ')}`);
    }

    if (!config.p123ApiId || !config.p123ApiKey) {
      console.warn('[P123] Portfolio123 integration disabled — need both API ID and API Key.');
    } else {
      console.log('[P123] Portfolio123 API configured and ready.');
    }
  }

  get enabled() {
    return !!(config.p123ApiId && config.p123ApiKey);
  }

  // ── Authentication ──────────────────────────────────────────────────
  async _authenticate() {
    console.log(`[P123] Authenticating with API ID: ${config.p123ApiId.slice(0, 4)}...`);
    const res = await fetch(`${BASE_URL}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiId: config.p123ApiId, apiKey: config.p123ApiKey }),
    });

    const text = await res.text();
    if (!res.ok) {
      console.error(`[P123] Auth failed (${res.status}): ${text}`);
      throw new Error(`P123 auth failed (${res.status}): ${text}`);
    }

    // Token may be returned as plain string or as { token: "..." }
    let token;
    try {
      const parsed = JSON.parse(text);
      token = typeof parsed === 'string' ? parsed : parsed.token || parsed;
    } catch {
      token = text.replace(/^"|"$/g, ''); // strip quotes if raw string
    }

    this._token = token;
    this._tokenExpiry = Date.now() + 50 * 60 * 1000;
    console.log(`[P123] Auth successful, token: ${String(token).slice(0, 8)}...`);
    return this._token;
  }

  async _getToken() {
    if (this._token && Date.now() < this._tokenExpiry) return this._token;
    return this._authenticate();
  }

  // ── Generic request with auto-auth and retry ────────────────────────
  async _request(method, path, body = null) {
    if (!this.enabled) throw new Error('P123 not configured');

    const token = await this._getToken();
    const opts = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);

    console.log(`[P123] ${method} ${path}`);
    let res = await fetch(`${BASE_URL}${path}`, opts);

    // Auto re-auth on 401/403
    if (res.status === 401 || res.status === 403) {
      console.log(`[P123] Got ${res.status}, re-authenticating...`);
      await this._authenticate();
      opts.headers['Authorization'] = `Bearer ${this._token}`;
      res = await fetch(`${BASE_URL}${path}`, opts);
    }

    if (!res.ok) {
      const text = await res.text();
      console.error(`[P123] ${method} ${path} failed (${res.status}): ${text}`);
      // Provide user-friendly messages for common errors
      if (res.status === 402) {
        throw new Error(`Portfolio123 subscription required for this feature. Check your P123 account plan.`);
      }
      if (res.status === 403) {
        throw new Error(`Portfolio123 access denied. Your API plan may not include this endpoint. Response: ${text}`);
      }
      throw new Error(`P123 error (${res.status}): ${text}`);
    }

    return res.json();
  }

  // ── Price Data ──────────────────────────────────────────────────────
  // Get historical prices for a ticker
  async getPrices(ticker, startDate, endDate = null) {
    let path = `/data/prices/${encodeURIComponent(ticker)}?start=${startDate}`;
    if (endDate) path += `&end=${endDate}`;
    return this._request('GET', path);
  }

  // Get latest price snapshot (last 5 trading days)
  async getLatestPrice(ticker) {
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 7);
    const start = fiveDaysAgo.toISOString().slice(0, 10);
    const data = await this.getPrices(ticker, start);
    // Return the most recent entry
    if (Array.isArray(data) && data.length > 0) {
      return data[data.length - 1];
    }
    return data;
  }

  // ── Point-in-Time Data ──────────────────────────────────────────────
  // Fetch fundamental/technical data for specific tickers
  async getData(tickers, formulas, options = {}) {
    return this._request('POST', '/data', {
      tickers: Array.isArray(tickers) ? tickers : [tickers],
      formulas,
      startDt: options.startDt,
      endDt: options.endDt,
      pitMethod: options.pitMethod || 'Prelim',
      precision: options.precision || 2,
      includeNames: options.includeNames !== false,
    });
  }

  // Convenience: get key fundamentals for a ticker
  async getTickerSnapshot(ticker) {
    const formulas = [
      'Close(0)',           // Current price
      'Volume(0)',          // Volume
      'MktCap',             // Market cap
      'PE',                 // P/E ratio
      'PB',                 // Price/Book
      'DivYield%',          // Dividend yield
      'ROE%',               // Return on equity
      'EPS',                // EPS
      'Close(0)/Close(-1)', // 1-day return (for daily change %)
      'Close(0)/Close(-5)', // 1-week return
      'Close(0)/Close(-21)',// 1-month return
      'RSI(14)',            // RSI 14-day
      'SMA(50)',            // 50-day SMA
      'SMA(200)',           // 200-day SMA
    ];
    return this._request('POST', '/data', {
      tickers: [ticker],
      formulas,
      names: ['Price', 'Volume', 'MktCap', 'PE', 'PB', 'DivYield', 'ROE', 'EPS', '1dReturn', '1wkReturn', '1moReturn', 'RSI14', 'SMA50', 'SMA200'],
      pitMethod: 'Prelim',
      precision: 2,
      includeNames: true,
    });
  }

  // ── Screen ──────────────────────────────────────────────────────────
  // Run a stock screen
  async screenRun(params) {
    return this._request('POST', '/screen/run', params);
  }

  // Convenience: run a quick screen with a universe and ranking
  async quickScreen(universe, options = {}) {
    return this.screenRun({
      screen: {
        type: options.type || 'stock',
        universe: universe,
        maxNumHoldings: options.maxResults || 20,
      },
      ranking: options.ranking,
      rules: options.rules,
      asOfDt: options.asOfDt,
      precision: 2,
    });
  }

  // ── Ranking ─────────────────────────────────────────────────────────
  // Get ranks for tickers in a ranking system
  async getRanks(rankingSystem, universe, tickers = null, options = {}) {
    const params = {
      rankingSystem,
      universe,
      asOfDt: options.asOfDt || new Date().toISOString().slice(0, 10),
      pitMethod: options.pitMethod || 'Prelim',
      precision: 2,
      includeNames: true,
    };
    if (tickers) params.tickers = Array.isArray(tickers) ? tickers.join(',') : tickers;
    if (options.additionalData) params.additionalData = options.additionalData;
    return this._request('POST', '/rank/ranks', params);
  }

  // ── Strategy ────────────────────────────────────────────────────────
  // Get strategy summary and holdings
  async getStrategy(strategyId) {
    return this._request('GET', `/strategy/${strategyId}`);
  }

  async getStrategyHoldings(strategyId, date = null) {
    let path = `/strategy/${strategyId}/holdings`;
    if (date) path += `?date=${date}`;
    return this._request('GET', path);
  }

  async getStrategyTransactions(strategyId, start, end) {
    return this._request('GET', `/strategy/${strategyId}/transactions?start=${start}&end=${end}`);
  }

  // ── Universe Data ───────────────────────────────────────────────────
  async getUniverseData(universe, formulas, dates, options = {}) {
    return this._request('POST', '/data/universe', {
      universe,
      formulas,
      asOfDts: Array.isArray(dates) ? dates : [dates],
      type: options.type || 'stock',
      pitMethod: options.pitMethod || 'Prelim',
      precision: options.precision || 2,
      includeNames: options.includeNames !== false,
    });
  }

  // ── Formatting helpers ──────────────────────────────────────────────

  // Format a ticker snapshot into a readable string for the AI
  formatSnapshotForAI(ticker, data) {
    if (!data || !data.rows || data.rows.length === 0) {
      return `No data available for ${ticker}`;
    }

    const row = data.rows[0];
    const cols = data.columnNames || data.names || [];
    const vals = row.slice ? row : Object.values(row);

    let lines = [`**${ticker}** — Data Snapshot`];
    for (let i = 0; i < cols.length; i++) {
      const val = vals[i];
      if (val !== null && val !== undefined && val !== '') {
        lines.push(`  ${cols[i]}: ${val}`);
      }
    }
    return lines.join('\n');
  }

  // Format screen results for Discord
  formatScreenForDiscord(results, maxRows = 15) {
    if (!results || !results.rows || results.rows.length === 0) {
      return 'No results found.';
    }

    const headers = results.columnNames || [];
    const rows = results.rows.slice(0, maxRows);

    let output = `**Screen Results** (${results.rows.length} stocks)\n\`\`\`\n`;
    output += headers.join(' | ') + '\n';
    output += headers.map(() => '---').join(' | ') + '\n';
    for (const row of rows) {
      output += (Array.isArray(row) ? row : Object.values(row)).join(' | ') + '\n';
    }
    output += '```';

    if (output.length > 1900) {
      output = output.slice(0, 1900) + '\n...```';
    }
    return output;
  }
}

module.exports = new P123Client();
