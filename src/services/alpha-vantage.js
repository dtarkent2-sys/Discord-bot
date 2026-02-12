/**
 * Alpha Vantage API Client — Market data, server-side technicals,
 * fundamentals, and news sentiment.
 *
 * Free tier: 25 requests/day. Premium plans allow higher throughput.
 * Docs: https://www.alphavantage.co/documentation/
 * MCP:  https://mcp.alphavantage.co/
 *
 * Wrapped with the provider resilience layer (cache + rate-limit + circuit breaker).
 * Cache-aggressive to stay within free-tier budget.
 *
 * Env var: ALPHA_API_KEY
 */

const config = require('../config');
const resilience = require('../data/resilience');
const log = require('../logger')('AlphaVantage');

const AV_BASE = 'https://www.alphavantage.co/query';

class AlphaVantageClient {
  constructor() {}

  get enabled() {
    return !!config.alphaApiKey;
  }

  // ── Raw fetch helper ───────────────────────────────────────────────────

  async _avFetch(params) {
    if (!this.enabled) throw new Error('ALPHA_API_KEY not configured');

    const url = new URL(AV_BASE);
    url.searchParams.set('apikey', config.alphaApiKey);
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, String(v));
    }

    log.debug(`Fetching: function=${params.function} ${params.symbol || ''}`);
    const res = await fetch(url.toString(), {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Alpha Vantage API ${res.status}: ${text.slice(0, 200)}`);
      err.statusCode = res.status;
      throw err;
    }

    const data = await res.json();

    // Alpha Vantage returns error messages inside the JSON body
    if (data['Error Message']) {
      throw new Error(`Alpha Vantage: ${data['Error Message']}`);
    }
    if (data['Note']) {
      // Rate limit warning — treat as 429
      const err = new Error(`Alpha Vantage rate limited: ${data['Note']}`);
      err.statusCode = 429;
      throw err;
    }
    if (data['Information'] && data['Information'].includes('API call frequency')) {
      const err = new Error(`Alpha Vantage rate limited: ${data['Information']}`);
      err.statusCode = 429;
      throw err;
    }

    return data;
  }

  /**
   * Resilience-wrapped fetch. Automatically caches, rate-limits, and circuit-breaks.
   */
  async _fetch(endpoint, params, cacheOpts = {}) {
    return resilience.call(
      'alphavantage',
      endpoint,
      { symbol: params.symbol, timeframe: cacheOpts.timeframe },
      () => this._avFetch(params),
      { cacheTtl: cacheOpts.ttl }
    );
  }

  // ── Quote — current price ──────────────────────────────────────────────

  async getQuote(ticker) {
    const symbol = this._sanitize(ticker);
    const data = await this._fetch('quote', {
      function: 'GLOBAL_QUOTE',
      symbol,
    }, { ttl: 60 * 1000 }); // 60s cache

    const q = data['Global Quote'];
    if (!q || !q['05. price']) throw new Error(`No quote data for ${symbol}`);

    return {
      symbol: q['01. symbol'],
      shortName: symbol,
      longName: symbol,
      regularMarketPrice: parseFloat(q['05. price']),
      regularMarketPreviousClose: parseFloat(q['08. previous close']),
      regularMarketOpen: parseFloat(q['02. open']),
      regularMarketDayHigh: parseFloat(q['03. high']),
      regularMarketDayLow: parseFloat(q['04. low']),
      regularMarketVolume: parseInt(q['06. volume'], 10),
      regularMarketChange: parseFloat(q['09. change']),
      regularMarketChangePercent: parseFloat(q['10. change percent']),
      source: 'AlphaVantage',
    };
  }

  // ── Intraday candles ───────────────────────────────────────────────────

  /**
   * Fetch intraday OHLCV candles.
   * @param {string} ticker
   * @param {'1min'|'5min'|'15min'|'30min'|'60min'} interval
   * @param {'compact'|'full'} outputsize - compact=100 bars, full=30 days
   */
  async getIntraday(ticker, interval = '5min', outputsize = 'compact') {
    const symbol = this._sanitize(ticker);
    const ttlMap = {
      '1min': 20 * 1000,
      '5min': 90 * 1000,
      '15min': 3 * 60 * 1000,
      '30min': 5 * 60 * 1000,
      '60min': 10 * 60 * 1000,
    };

    const data = await this._fetch('candles', {
      function: 'TIME_SERIES_INTRADAY',
      symbol,
      interval,
      outputsize,
    }, { ttl: ttlMap[interval] || 60 * 1000, timeframe: interval });

    const seriesKey = `Time Series (${interval})`;
    const series = data[seriesKey];
    if (!series) throw new Error(`No intraday data for ${symbol} at ${interval}`);

    // Convert to array (newest first → reverse to oldest first)
    return Object.entries(series).reverse().map(([timestamp, bar]) => ({
      timestamp: new Date(timestamp + ' EST'),
      open: parseFloat(bar['1. open']),
      high: parseFloat(bar['2. high']),
      low: parseFloat(bar['3. low']),
      close: parseFloat(bar['4. close']),
      volume: parseInt(bar['5. volume'], 10),
    }));
  }

  // ── Daily history ──────────────────────────────────────────────────────

  async getHistory(ticker, days = 30) {
    const symbol = this._sanitize(ticker);
    const outputsize = days > 100 ? 'full' : 'compact';

    const data = await this._fetch('history', {
      function: 'TIME_SERIES_DAILY',
      symbol,
      outputsize,
    }, { ttl: 60 * 60 * 1000 }); // 1h cache for daily data

    const series = data['Time Series (Daily)'];
    if (!series) throw new Error(`No daily data for ${symbol}`);

    const bars = Object.entries(series).reverse().map(([date, bar]) => ({
      date: new Date(date),
      open: parseFloat(bar['1. open']),
      high: parseFloat(bar['2. high']),
      low: parseFloat(bar['3. low']),
      close: parseFloat(bar['4. close']),
      volume: parseInt(bar['5. volume'], 10),
    }));

    return bars.slice(-days);
  }

  // ── Server-side Technical Indicators ───────────────────────────────────
  // Alpha Vantage computes these server-side — no client-side math needed.

  /**
   * Fetch RSI from Alpha Vantage's server-side computation.
   * @param {string} ticker
   * @param {'1min'|'5min'|'15min'|'daily'} interval
   * @param {number} timePeriod
   */
  async getRSI(ticker, interval = 'daily', timePeriod = 14) {
    const symbol = this._sanitize(ticker);
    const data = await this._fetch('rsi', {
      function: 'RSI',
      symbol,
      interval,
      time_period: timePeriod,
      series_type: 'close',
    }, { ttl: this._techTTL(interval), timeframe: interval });

    const series = data['Technical Analysis: RSI'];
    if (!series) throw new Error(`No RSI data for ${symbol}`);

    const entries = Object.entries(series).slice(0, 10);
    return entries.map(([date, val]) => ({
      date,
      rsi: parseFloat(val['RSI']),
    }));
  }

  /**
   * Fetch MACD from Alpha Vantage's server-side computation.
   */
  async getMACD(ticker, interval = 'daily') {
    const symbol = this._sanitize(ticker);
    const data = await this._fetch('macd', {
      function: 'MACD',
      symbol,
      interval,
      series_type: 'close',
    }, { ttl: this._techTTL(interval), timeframe: interval });

    const series = data['Technical Analysis: MACD'];
    if (!series) throw new Error(`No MACD data for ${symbol}`);

    const entries = Object.entries(series).slice(0, 10);
    return entries.map(([date, val]) => ({
      date,
      macd: parseFloat(val['MACD']),
      signal: parseFloat(val['MACD_Signal']),
      histogram: parseFloat(val['MACD_Hist']),
    }));
  }

  /**
   * Fetch Bollinger Bands.
   */
  async getBBands(ticker, interval = 'daily', timePeriod = 20) {
    const symbol = this._sanitize(ticker);
    const data = await this._fetch('bbands', {
      function: 'BBANDS',
      symbol,
      interval,
      time_period: timePeriod,
      series_type: 'close',
    }, { ttl: this._techTTL(interval), timeframe: interval });

    const series = data['Technical Analysis: BBANDS'];
    if (!series) throw new Error(`No Bollinger data for ${symbol}`);

    const entries = Object.entries(series).slice(0, 10);
    return entries.map(([date, val]) => ({
      date,
      upper: parseFloat(val['Real Upper Band']),
      middle: parseFloat(val['Real Middle Band']),
      lower: parseFloat(val['Real Lower Band']),
    }));
  }

  /**
   * Fetch SMA.
   */
  async getSMA(ticker, interval = 'daily', timePeriod = 50) {
    const symbol = this._sanitize(ticker);
    const data = await this._fetch('sma', {
      function: 'SMA',
      symbol,
      interval,
      time_period: timePeriod,
      series_type: 'close',
    }, { ttl: this._techTTL(interval), timeframe: interval });

    const series = data['Technical Analysis: SMA'];
    if (!series) throw new Error(`No SMA data for ${symbol}`);

    const entries = Object.entries(series).slice(0, 5);
    return entries.map(([date, val]) => ({
      date,
      sma: parseFloat(val['SMA']),
    }));
  }

  /**
   * Fetch EMA.
   */
  async getEMA(ticker, interval = 'daily', timePeriod = 12) {
    const symbol = this._sanitize(ticker);
    const data = await this._fetch('ema', {
      function: 'EMA',
      symbol,
      interval,
      time_period: timePeriod,
      series_type: 'close',
    }, { ttl: this._techTTL(interval), timeframe: interval });

    const series = data['Technical Analysis: EMA'];
    if (!series) throw new Error(`No EMA data for ${symbol}`);

    const entries = Object.entries(series).slice(0, 5);
    return entries.map(([date, val]) => ({
      date,
      ema: parseFloat(val['EMA']),
    }));
  }

  /**
   * Fetch ATR (Average True Range).
   */
  async getATR(ticker, interval = 'daily', timePeriod = 14) {
    const symbol = this._sanitize(ticker);
    const data = await this._fetch('atr', {
      function: 'ATR',
      symbol,
      interval,
      time_period: timePeriod,
    }, { ttl: this._techTTL(interval), timeframe: interval });

    const series = data['Technical Analysis: ATR'];
    if (!series) throw new Error(`No ATR data for ${symbol}`);

    const entries = Object.entries(series).slice(0, 5);
    return entries.map(([date, val]) => ({
      date,
      atr: parseFloat(val['ATR']),
    }));
  }

  /**
   * Fetch VWAP (Volume Weighted Average Price).
   * Note: VWAP only works with intraday intervals.
   */
  async getVWAP(ticker, interval = '5min') {
    const symbol = this._sanitize(ticker);
    const data = await this._fetch('vwap', {
      function: 'VWAP',
      symbol,
      interval,
    }, { ttl: this._techTTL(interval), timeframe: interval });

    const series = data['Technical Analysis: VWAP'];
    if (!series) throw new Error(`No VWAP data for ${symbol}`);

    const entries = Object.entries(series).slice(0, 10);
    return entries.map(([date, val]) => ({
      date,
      vwap: parseFloat(val['VWAP']),
    }));
  }

  /**
   * Fetch a full technical snapshot for a ticker.
   * Batches multiple indicator calls in parallel.
   * Results are cached individually by the resilience layer.
   */
  async getTechnicalSnapshot(ticker, interval = 'daily') {
    const [rsiData, macdData, bbandsData, atrData] = await Promise.allSettled([
      this.getRSI(ticker, interval),
      this.getMACD(ticker, interval),
      this.getBBands(ticker, interval),
      this.getATR(ticker, interval),
    ]);

    const latest = (result) => result.status === 'fulfilled' && result.value?.[0] ? result.value[0] : null;

    const rsi = latest(rsiData);
    const macd = latest(macdData);
    const bbands = latest(bbandsData);
    const atr = latest(atrData);

    return {
      rsi: rsi?.rsi ?? null,
      macd: macd ? { macd: macd.macd, signal: macd.signal, histogram: macd.histogram } : null,
      bollinger: bbands ? { upper: bbands.upper, middle: bbands.middle, lower: bbands.lower } : null,
      atr: atr?.atr ?? null,
      source: 'AlphaVantage',
      interval,
    };
  }

  // ── News & Sentiment ───────────────────────────────────────────────────

  /**
   * Fetch news with AI-scored sentiment for a ticker or topic.
   * @param {string} [tickers] - Comma-separated tickers (e.g. 'AAPL,MSFT')
   * @param {object} [opts] - { topics, limit, sort }
   */
  async getNewsSentiment(tickers, opts = {}) {
    const params = {
      function: 'NEWS_SENTIMENT',
    };
    if (tickers) params.tickers = this._sanitize(tickers);
    if (opts.topics) params.topics = opts.topics;
    if (opts.limit) params.limit = opts.limit;
    if (opts.sort) params.sort = opts.sort;

    const data = await this._fetch('news', params, { ttl: 20 * 60 * 1000 }); // 20m cache

    const feed = data.feed || [];
    return feed.slice(0, opts.limit || 10).map(item => ({
      title: item.title,
      url: item.url,
      summary: item.summary?.slice(0, 300),
      source: item.source,
      publishedAt: item.time_published,
      overallSentiment: item.overall_sentiment_label,
      sentimentScore: item.overall_sentiment_score,
      tickerSentiment: (item.ticker_sentiment || []).map(ts => ({
        ticker: ts.ticker,
        relevance: parseFloat(ts.relevance_score),
        sentiment: ts.ticker_sentiment_label,
        score: parseFloat(ts.ticker_sentiment_score),
      })),
    }));
  }

  // ── Fundamentals ───────────────────────────────────────────────────────

  /**
   * Fetch company overview (sector, PE, EPS, market cap, dividend, etc.)
   */
  async getCompanyOverview(ticker) {
    const symbol = this._sanitize(ticker);
    const data = await this._fetch('profile', {
      function: 'OVERVIEW',
      symbol,
    }, { ttl: 24 * 60 * 60 * 1000 }); // 24h cache

    if (!data || !data.Symbol) throw new Error(`No overview for ${symbol}`);

    return {
      symbol: data.Symbol,
      name: data.Name,
      description: data.Description?.slice(0, 500),
      sector: data.Sector,
      industry: data.Industry,
      exchange: data.Exchange,
      marketCap: parseFloat(data.MarketCapitalization) || null,
      pe: parseFloat(data.PERatio) || null,
      forwardPE: parseFloat(data.ForwardPE) || null,
      pb: parseFloat(data.PriceToBookRatio) || null,
      eps: parseFloat(data.EPS) || null,
      divYield: parseFloat(data.DividendYield) ? parseFloat(data.DividendYield) * 100 : null,
      beta: parseFloat(data.Beta) || null,
      fiftyTwoWeekHigh: parseFloat(data['52WeekHigh']) || null,
      fiftyTwoWeekLow: parseFloat(data['52WeekLow']) || null,
      profitMargin: parseFloat(data.ProfitMargin) ? parseFloat(data.ProfitMargin) * 100 : null,
      roe: parseFloat(data.ReturnOnEquityTTM) ? parseFloat(data.ReturnOnEquityTTM) * 100 : null,
      revenueGrowth: parseFloat(data.QuarterlyRevenueGrowthYOY) ? parseFloat(data.QuarterlyRevenueGrowthYOY) * 100 : null,
      sma50: parseFloat(data['50DayMovingAverage']) || null,
      sma200: parseFloat(data['200DayMovingAverage']) || null,
      analystTargetPrice: parseFloat(data.AnalystTargetPrice) || null,
      source: 'AlphaVantage',
    };
  }

  /**
   * Fetch earnings data (quarterly).
   */
  async getEarnings(ticker) {
    const symbol = this._sanitize(ticker);
    const data = await this._fetch('earnings', {
      function: 'EARNINGS',
      symbol,
    }, { ttl: 12 * 60 * 60 * 1000 }); // 12h cache

    const quarterly = (data.quarterlyEarnings || []).slice(0, 8);
    return quarterly.map(e => ({
      date: e.fiscalDateEnding,
      reportedDate: e.reportedDate,
      epsEstimate: parseFloat(e.estimatedEPS) || null,
      epsActual: parseFloat(e.reportedEPS) || null,
      surprise: parseFloat(e.surprise) || null,
      surprisePct: parseFloat(e.surprisePercentage) || null,
    }));
  }

  // ── Movers — top gainers/losers ────────────────────────────────────────

  async getTopMovers() {
    const data = await this._fetch('movers', {
      function: 'TOP_GAINERS_LOSERS',
    }, { ttl: 5 * 60 * 1000 }); // 5m cache

    return {
      gainers: (data.top_gainers || []).slice(0, 10).map(this._mapMover),
      losers: (data.top_losers || []).slice(0, 10).map(this._mapMover),
      mostActive: (data.most_actively_traded || []).slice(0, 10).map(this._mapMover),
    };
  }

  _mapMover(item) {
    return {
      symbol: item.ticker,
      price: parseFloat(item.price),
      change: parseFloat(item.change_amount),
      changePercent: parseFloat(item.change_percentage),
      volume: parseInt(item.volume, 10),
    };
  }

  // ── Ticker search ──────────────────────────────────────────────────────

  async search(query) {
    const data = await this._fetch('search', {
      function: 'SYMBOL_SEARCH',
      keywords: query,
    }, { ttl: 60 * 60 * 1000 }); // 1h cache

    return (data.bestMatches || []).map(m => ({
      symbol: m['1. symbol'],
      shortname: m['2. name'],
      type: m['3. type'],
      region: m['4. region'],
      matchScore: parseFloat(m['9. matchScore']),
    }));
  }

  // ── Full Ticker Snapshot (matches FMP's getTickerSnapshot interface) ────

  /**
   * Fetch a complete snapshot matching the FMP MarketDataClient interface.
   * Used as a fallback in the market context pipeline.
   */
  async getTickerSnapshot(ticker) {
    const symbol = this._sanitize(ticker);

    // Fetch quote + overview + history in parallel
    const [quoteData, overviewData, history] = await Promise.allSettled([
      this.getQuote(symbol),
      this.getCompanyOverview(symbol),
      this.getHistory(symbol, 200),
    ]);

    const quote = quoteData.status === 'fulfilled' ? quoteData.value : null;
    const overview = overviewData.status === 'fulfilled' ? overviewData.value : null;
    const historyBars = history.status === 'fulfilled' ? history.value : [];

    if (!quote) throw new Error(`No quote data for ${symbol} from Alpha Vantage`);

    // Compute technicals from history if available
    const closes = historyBars.map(d => d.close).filter(c => c != null);
    const sma50 = closes.length >= 50 ? this._sma(closes, 50) : (overview?.sma50 || null);
    const sma200 = closes.length >= 200 ? this._sma(closes, 200) : (overview?.sma200 || null);
    const rsi14 = closes.length >= 15 ? this._rsi(closes, 14) : null;

    return {
      ticker: symbol,
      name: overview?.name || symbol,
      price: quote.regularMarketPrice,
      previousClose: quote.regularMarketPreviousClose,
      open: quote.regularMarketOpen,
      dayHigh: quote.regularMarketDayHigh,
      dayLow: quote.regularMarketDayLow,
      volume: quote.regularMarketVolume,
      marketCap: overview?.marketCap || null,
      change: quote.regularMarketChange,
      changePercent: quote.regularMarketChangePercent,

      // Fundamentals from overview
      pe: overview?.pe || null,
      forwardPE: overview?.forwardPE || null,
      pb: overview?.pb || null,
      eps: overview?.eps || null,
      divYield: overview?.divYield || null,
      roe: overview?.roe || null,
      profitMargin: overview?.profitMargin || null,
      revenueGrowth: overview?.revenueGrowth || null,
      beta: overview?.beta || null,
      fiftyTwoWeekHigh: overview?.fiftyTwoWeekHigh || null,
      fiftyTwoWeekLow: overview?.fiftyTwoWeekLow || null,

      // Technicals
      sma50,
      sma200,
      rsi14,

      // Recent history
      priceHistory: historyBars.slice(-30),

      timestamp: new Date().toISOString(),
      source: 'AlphaVantage',
    };
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  _sanitize(ticker) {
    if (!ticker || typeof ticker !== 'string') return '';
    return ticker.replace(/[^A-Za-z0-9.\-,]/g, '').trim().toUpperCase();
  }

  _techTTL(interval) {
    if (interval === '1min') return 20 * 1000;
    if (interval === '5min') return 90 * 1000;
    if (interval === '15min') return 3 * 60 * 1000;
    if (interval === 'daily') return 60 * 60 * 1000;
    return 60 * 1000;
  }

  _sma(prices, period) {
    const recent = prices.slice(-period);
    return Math.round((recent.reduce((a, b) => a + b, 0) / recent.length) * 100) / 100;
  }

  _rsi(prices, period = 14) {
    if (prices.length < period + 1) return null;
    let gains = 0;
    let losses = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
      const diff = prices[i] - prices[i - 1];
      if (diff > 0) gains += diff;
      else losses -= diff;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return Math.round((100 - (100 / (1 + rs))) * 100) / 100;
  }
}

module.exports = new AlphaVantageClient();
