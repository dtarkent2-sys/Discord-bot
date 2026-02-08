const { execFile } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'yfinance_fetch.py');
const TIMEOUT = 30000; // 30 seconds

class YahooFinanceClient {
  constructor() {
    this._pythonCmd = null;
  }

  // Detect python3 or python
  async _getPython() {
    if (this._pythonCmd) return this._pythonCmd;

    for (const cmd of ['python3', 'python']) {
      try {
        await this._exec(cmd, ['--version']);
        this._pythonCmd = cmd;
        return cmd;
      } catch { /* try next */ }
    }
    throw new Error('Python not found. Install Python 3 and yfinance: pip install yfinance');
  }

  // Run a shell command and return stdout
  _exec(cmd, args) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: TIMEOUT }, (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve(stdout);
      });
    });
  }

  // Call the Python yfinance script
  async _call(command, ...args) {
    const python = await this._getPython();
    const stdout = await this._exec(python, [SCRIPT, command, ...args]);
    const result = JSON.parse(stdout.trim());
    if (result && result.error) {
      throw new Error(result.error);
    }
    return result;
  }

  get enabled() {
    return true; // yfinance needs no API key
  }

  // ── Quote — current price + key stats ───────────────────────────────
  async getQuote(ticker) {
    return this._call('quote', ticker.toUpperCase());
  }

  // ── Quotes — batch price lookup ─────────────────────────────────────
  async getQuotes(tickers) {
    const tickerStr = tickers.map(t => t.toUpperCase()).join(',');
    return this._call('quotes', tickerStr);
  }

  // ── Historical — price history ──────────────────────────────────────
  async getHistory(ticker, days = 30) {
    return this._call('history', ticker.toUpperCase(), String(days));
  }

  // ── Ticker Snapshot — full fundamentals + technicals ────────────────
  async getTickerSnapshot(ticker) {
    const data = await this._call('snapshot', ticker.toUpperCase());
    data.timestamp = new Date().toISOString();
    return data;
  }

  // ── Search — find tickers by name ───────────────────────────────────
  async search(query) {
    return this._call('search', query);
  }

  // ── Screening — trending tickers ──────────────────────────────────
  async screenByGainers() {
    const data = await this._call('trending');
    return Array.isArray(data) ? data : [];
  }

  // ── Format helpers ──────────────────────────────────────────────────

  formatQuoteForDiscord(quote) {
    if (!quote) return 'No data available.';

    const lines = [`**${quote.symbol || quote.ticker}** — ${quote.shortName || quote.name || 'Unknown'}\n`];
    if (quote.price != null) lines.push(`**Price:** $${Number(quote.price).toFixed(2)}`);
    if (quote.changePercent != null) {
      const pct = quote.changePercent;
      lines.push(`**Change:** ${pct > 0 ? '+' : ''}${Number(pct).toFixed(2)}%`);
    }
    if (quote.volume) lines.push(`**Volume:** ${Number(quote.volume).toLocaleString()}`);
    if (quote.marketCap) lines.push(`**Market Cap:** $${(quote.marketCap / 1e9).toFixed(2)}B`);
    return lines.join('\n');
  }

  formatScreenForDiscord(quotes, maxRows = 15) {
    if (!quotes || quotes.length === 0) return 'No results found.';

    const rows = quotes.slice(0, maxRows);
    let output = `**Screen Results** (${quotes.length} stocks)\n\`\`\`\n`;
    output += 'Ticker   | Price     | Change   | Volume\n';
    output += '---------|-----------|----------|----------\n';
    for (const q of rows) {
      const sym = (q.symbol || '').padEnd(8);
      const price = q.price != null ? `$${Number(q.price).toFixed(2)}`.padEnd(9) : 'N/A'.padEnd(9);
      const change = q.changePercent != null
        ? `${q.changePercent > 0 ? '+' : ''}${Number(q.changePercent).toFixed(2)}%`.padEnd(8)
        : 'N/A'.padEnd(8);
      const vol = q.volume ? `${(q.volume / 1e6).toFixed(1)}M` : 'N/A';
      output += `${sym} | ${price} | ${change} | ${vol}\n`;
    }
    output += '```';

    if (output.length > 1900) {
      output = output.slice(0, 1900) + '\n...```';
    }
    return output;
  }
}

module.exports = new YahooFinanceClient();
