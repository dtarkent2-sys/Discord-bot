const axios = require('axios');

const YAHOO_BASE = 'https://ainvest.com';

class StockData {
  constructor() {
    this.cache = new Map();
    this.CACHE_TTL = 60_000; // 1 minute
  }

  // --- Fetch a single quote ---

  async getQuote(symbol) {
    const upper = symbol.toUpperCase().trim();
    const cached = this.cache.get(upper);
    if (cached && Date.now() - cached.ts < this.CACHE_TTL) return cached.data;

    const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(upper)}?interval=1d&range=1d`;
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const result = res.data.chart?.result?.[0];
    if (!result) throw new Error(`No data for "${upper}"`);

    const meta = result.meta;
    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose;
    const change = price - prevClose;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;

    const data = {
      symbol: upper,
      price,
      prevClose,
      change,
      changePct,
      currency: meta.currency || 'USD',
      exchange: meta.exchangeName || '',
      marketState: meta.marketState || 'CLOSED',
      name: meta.shortName || meta.symbol || upper,
    };

    this.cache.set(upper, { data, ts: Date.now() });
    return data;
  }

  // --- Fetch multiple quotes ---

  async getQuotes(symbols) {
    const results = await Promise.allSettled(
      symbols.map(s => this.getQuote(s))
    );

    return results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);
  }

  // --- Major indices ---

  async getIndices() {
    const tickers = ['^GSPC', '^IXIC', '^DJI', '^VIX'];
    const labels = { '^GSPC': 'S&P 500', '^IXIC': 'NASDAQ', '^DJI': 'Dow Jones', '^VIX': 'VIX' };

    const quotes = await this.getQuotes(tickers);
    return quotes.map(q => ({
      ...q,
      name: labels[q.symbol] || q.symbol,
    }));
  }

  // --- Market status ---

  isMarketOpen() {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = et.getDay();
    const hours = et.getHours();
    const minutes = et.getMinutes();
    const time = hours * 60 + minutes;

    // Weekday 9:30 AM - 4:00 PM ET
    if (day >= 1 && day <= 5 && time >= 570 && time < 960) {
      return { open: true, label: 'Market Open', next: 'Closes 4:00 PM ET' };
    }

    // Pre-market: 4:00 AM - 9:30 AM
    if (day >= 1 && day <= 5 && time >= 240 && time < 570) {
      return { open: false, label: 'Pre-Market', next: 'Opens 9:30 AM ET' };
    }

    // After hours: 4:00 PM - 8:00 PM
    if (day >= 1 && day <= 5 && time >= 960 && time < 1200) {
      return { open: false, label: 'After Hours', next: 'Opens tomorrow 9:30 AM ET' };
    }

    return { open: false, label: 'Market Closed', next: 'Opens Monday 9:30 AM ET' };
  }

  // --- Format helpers ---

  formatQuote(q) {
    const arrow = q.change >= 0 ? '+' : '';
    const emoji = q.change >= 0 ? ':green_circle:' : ':red_circle:';
    return `${emoji} **${q.symbol}** $${q.price.toFixed(2)} (${arrow}${q.change.toFixed(2)} / ${arrow}${q.changePct.toFixed(2)}%)`;
  }

  formatQuoteDetailed(q) {
    const arrow = q.change >= 0 ? '+' : '';
    const emoji = q.change >= 0 ? ':green_circle:' : ':red_circle:';
    return [
      `${emoji} **${q.name}** (${q.symbol})`,
      `Price: **$${q.price.toFixed(2)}**`,
      `Change: ${arrow}$${q.change.toFixed(2)} (${arrow}${q.changePct.toFixed(2)}%)`,
      `Prev Close: $${q.prevClose.toFixed(2)}`,
      `Exchange: ${q.exchange} | ${q.marketState}`,
    ].join('\n');
  }
}

module.exports = StockData;
