/**
 * Databento — Institutional-Grade OPRA Market Data
 *
 * Provides real-time and historical options data from the OPRA consolidated feed
 * (all 17 US options exchanges) via Databento's HTTP API.
 *
 * What Databento gives us:
 *   - Tick-level NBBO quotes (consolidated best bid/offer across all exchanges)
 *   - Trade prints (every fill, every exchange, nanosecond resolution)
 *   - Open interest (via statistics schema, exchange-disseminated)
 *   - Volume (via OHLCV or trades aggregation)
 *   - Instrument definitions (strike, expiration, underlying, multiplier)
 *
 * What Databento does NOT give us:
 *   - Greeks (delta, gamma, theta, vega) — use Tradier/ORATS for these
 *   - Implied volatility — compute from quotes or get from Tradier
 *
 * Auth: HTTP Basic Auth (API key as username, empty password)
 * Dataset: OPRA.PILLAR
 * Encoding: JSON Lines (for Node.js compatibility — no DBN binary parser)
 *
 * Docs: https://databento.com/docs
 */

const config = require('../config');

const HIST_BASE = 'https://hist.databento.com';
const API_VERSION = '0';

// Stat types from the statistics schema
const STAT_OPEN_INTEREST = 9;
const STAT_SETTLEMENT_PRICE = 3;
const STAT_CLEARED_VOLUME = 6;

// Price fields in Databento are fixed-point: divide by 1e9 for dollars
const PRICE_SCALE = 1_000_000_000;

// Cache for instrument definitions (symbol → definition map)
// TTL: definitions rarely change intraday
const _defCache = new Map(); // `${ticker}_${date}` → { data, ts }
const DEF_CACHE_TTL = 30 * 60 * 1000; // 30 min

// Cache for OI + quotes to avoid hammering the API
const _dataCache = new Map();
const DATA_CACHE_TTL = 60 * 1000; // 60s default (overridable via config)

// Databento historical pipeline lag — data is typically available ~25-30 min after real-time.
// Use 35 min buffer to avoid 422 "end after available_end" errors.
// Observed lag: OPRA.PILLAR data available up to 14:50 at 15:18 UTC = 28 min gap.
const HIST_LAG_MS = 35 * 60 * 1000;

class DatabentoService {
  constructor() {
    this._authHeader = null;
  }

  get enabled() {
    return !!config.databentoApiKey;
  }

  _getAuthHeader() {
    if (!this._authHeader) {
      // HTTP Basic Auth: API key as username, empty password
      const encoded = Buffer.from(config.databentoApiKey + ':').toString('base64');
      this._authHeader = `Basic ${encoded}`;
    }
    return this._authHeader;
  }

  // ── Generic HTTP POST to Databento Historical API ──────────────────

  /**
   * POST to timeseries.get_range — returns parsed JSON records.
   * Databento returns JSON Lines (one JSON object per line).
   * Streams the response body to avoid Node.js string-length limits
   * (~512 MB) on large OPRA datasets (SPY has 12K+ instruments).
   */
  async _getRange(params, timeoutMs = 30000) {
    if (!this.enabled) throw new Error('Databento API key not configured');

    const url = `${HIST_BASE}/v${API_VERSION}/timeseries.get_range`;
    const body = new URLSearchParams({
      dataset: 'OPRA.PILLAR',
      encoding: 'json',
      compression: 'none',
      ...params,
    });

    console.log(`[Databento] POST timeseries.get_range schema=${params.schema} symbols=${params.symbols}`);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': this._getAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Databento API ${res.status}: ${text.slice(0, 500)}`);
    }

    // Stream JSON Lines response incrementally to avoid string-length overflow.
    // res.text() would load the entire body (~500MB+ for SPY OPRA) into one
    // string, hitting Node.js's 0x1fffffe8-character limit.
    const records = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let partial = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      partial += decoder.decode(value, { stream: true });
      const lines = partial.split('\n');
      partial = lines.pop(); // keep the incomplete trailing line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          records.push(JSON.parse(trimmed));
        } catch {
          // Skip malformed lines
        }
      }
    }

    // Handle final partial line
    if (partial.trim()) {
      try { records.push(JSON.parse(partial.trim())); } catch {}
    }

    return records;
  }

  /**
   * POST to metadata.get_cost — estimate data cost before fetching.
   */
  async estimateCost(params) {
    if (!this.enabled) throw new Error('Databento API key not configured');

    const url = `${HIST_BASE}/v${API_VERSION}/metadata.get_cost`;
    const body = new URLSearchParams({
      dataset: 'OPRA.PILLAR',
      ...params,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': this._getAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Databento cost API ${res.status}: ${text.slice(0, 300)}`);
    }

    return res.json();
  }

  // ── Instrument Definitions ──────────────────────────────────────────

  /**
   * Fetch option instrument definitions for a ticker (all strikes + expirations).
   * Returns a Map of raw_symbol → { strike, expiration, type, underlying, ... }
   *
   * @param {string} ticker - e.g. 'SPY'
   * @param {string} [date] - date to fetch definitions for (YYYY-MM-DD), defaults to today
   * @returns {Promise<Map<string, object>>}
   */
  async getInstrumentDefinitions(ticker, date) {
    const d = date || _today();
    const cacheKey = `${ticker}_${d}`;
    const cached = _defCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < DEF_CACHE_TTL) return cached.data;

    const records = await this._getRange({
      symbols: `${ticker.toUpperCase()}.OPT`,
      schema: 'definition',
      stype_in: 'parent',
      start: `${d}T00:00:00.000000000Z`,
      end: _safeEnd(d),
    }, 45000);

    const defs = new Map();
    for (const rec of records) {
      const rawSymbol = (rec.raw_symbol || '').trim();
      if (!rawSymbol) continue;

      const strikePx = rec.strike_price != null ? rec.strike_price / PRICE_SCALE : 0;
      const expNs = rec.expiration || 0;
      const expDate = expNs ? _nsToDateString(expNs) : '';
      const instrClass = rec.instrument_class || '';

      // Determine call/put from raw_symbol or instrument_class
      let optType = null;
      if (rawSymbol.length > 15) {
        // OCC format: ROOT(6) + YYMMDD(6) + C/P(1) + Strike*1000(8)
        const cpChar = rawSymbol.charAt(rawSymbol.length - 9);
        optType = cpChar === 'C' ? 'call' : cpChar === 'P' ? 'put' : null;
      }

      defs.set(rawSymbol, {
        rawSymbol,
        instrumentId: rec.hd?.instrument_id ?? rec.instrument_id ?? 0,
        strike: strikePx,
        expiration: expDate,
        type: optType,
        underlying: (rec.underlying || ticker).trim().toUpperCase(),
        multiplier: rec.contract_multiplier || 100,
        minPriceIncrement: rec.min_price_increment ? rec.min_price_increment / PRICE_SCALE : 0.01,
      });
    }

    console.log(`[Databento] ${ticker} definitions: ${defs.size} instruments on ${d}`);
    _defCache.set(cacheKey, { data: defs, ts: Date.now() });
    return defs;
  }

  /**
   * Get available expiration dates for a ticker's options.
   * @param {string} ticker
   * @returns {Promise<string[]>} Sorted YYYY-MM-DD dates
   */
  async getOptionExpirations(ticker) {
    const defs = await this.getInstrumentDefinitions(ticker);
    const exps = new Set();
    for (const def of defs.values()) {
      if (def.expiration) exps.add(def.expiration);
    }
    return [...exps].sort();
  }

  // ── Open Interest ──────────────────────────────────────────────────

  /**
   * Fetch open interest for all options of a ticker.
   * Returns a Map of instrumentId → OI quantity.
   *
   * OI is published via the statistics schema (stat_type = 9).
   * Typically published after market close for the prior day.
   *
   * @param {string} ticker - e.g. 'SPY'
   * @param {string} [date] - date to fetch OI for (YYYY-MM-DD)
   * @returns {Promise<Map<number, number>>} instrumentId → OI
   */
  async getOpenInterest(ticker, date) {
    const d = date || _yesterday();

    const records = await this._getRange({
      symbols: `${ticker.toUpperCase()}.OPT`,
      schema: 'statistics',
      stype_in: 'parent',
      start: `${d}T00:00:00.000000000Z`,
      end: _safeEnd(d),
    }, 45000);

    const oiMap = new Map();
    for (const rec of records) {
      if (rec.stat_type !== STAT_OPEN_INTEREST) continue;
      const instrId = rec.hd?.instrument_id ?? rec.instrument_id ?? 0;
      const quantity = rec.quantity || 0;
      // Keep the latest OI update for each instrument
      oiMap.set(instrId, quantity);
    }

    console.log(`[Databento] ${ticker} OI: ${oiMap.size} instruments on ${d}`);
    return oiMap;
  }

  // ── NBBO Quotes (Consolidated Best Bid/Offer) ──────────────────────

  /**
   * Fetch latest NBBO quotes (1-second snapshots) for all options of a ticker.
   * Uses cbbo-1s schema for consolidated BBO across all 17 OPRA exchanges.
   *
   * @param {string} ticker - e.g. 'SPY'
   * @param {string} [start] - start time ISO 8601 (defaults to last 5 min)
   * @param {string} [end] - end time ISO 8601 (defaults to now)
   * @returns {Promise<Map<number, object>>} instrumentId → { bid, ask, bidSize, askSize }
   */
  async getLatestQuotes(ticker, start, end) {
    // Use HIST_LAG_MS buffer to stay within Databento's available data range (~10 min pipeline lag)
    const safeNow = new Date(Date.now() - HIST_LAG_MS);
    const e = end || safeNow.toISOString().replace(/\.\d{3}Z/, '.000000000Z');
    const s = start || new Date(safeNow.getTime() - 5 * 60 * 1000).toISOString().replace(/\.\d{3}Z/, '.000000000Z');

    const records = await this._getRange({
      symbols: `${ticker.toUpperCase()}.OPT`,
      schema: 'cbbo-1s',
      stype_in: 'parent',
      start: s,
      end: e,
    }, 45000);

    // Keep only the latest quote per instrument
    const quotes = new Map();
    for (const rec of records) {
      const instrId = rec.hd?.instrument_id ?? rec.instrument_id ?? 0;
      const bidPx = rec.bid_px_00 != null ? rec.bid_px_00 / PRICE_SCALE
        : rec.levels?.[0]?.bid_px != null ? rec.levels[0].bid_px / PRICE_SCALE : 0;
      const askPx = rec.ask_px_00 != null ? rec.ask_px_00 / PRICE_SCALE
        : rec.levels?.[0]?.ask_px != null ? rec.levels[0].ask_px / PRICE_SCALE : 0;
      const bidSz = rec.bid_sz_00 ?? rec.levels?.[0]?.bid_sz ?? 0;
      const askSz = rec.ask_sz_00 ?? rec.levels?.[0]?.ask_sz ?? 0;

      quotes.set(instrId, { bid: bidPx, ask: askPx, bidSize: bidSz, askSize: askSz });
    }

    console.log(`[Databento] ${ticker} NBBO quotes: ${quotes.size} instruments`);
    return quotes;
  }

  // ── OHLCV Bars ─────────────────────────────────────────────────────

  /**
   * Fetch OHLCV bars for a specific equity (underlying stock, not options).
   * Note: For equities, use the appropriate dataset (e.g. XNAS.ITCH).
   * For options OHLCV, use the OPRA dataset.
   *
   * @param {string} ticker
   * @param {string} schema - 'ohlcv-1s', 'ohlcv-1m', 'ohlcv-1h', 'ohlcv-1d'
   * @param {string} start - ISO 8601
   * @param {string} end - ISO 8601
   * @returns {Promise<object[]>}
   */
  async getOptionsOHLCV(ticker, schema, start, end) {
    const records = await this._getRange({
      symbols: `${ticker.toUpperCase()}.OPT`,
      schema,
      stype_in: 'parent',
      start,
      end,
    }, 45000);

    return records.map(rec => ({
      instrumentId: rec.hd?.instrument_id ?? rec.instrument_id ?? 0,
      open: rec.open != null ? rec.open / PRICE_SCALE : 0,
      high: rec.high != null ? rec.high / PRICE_SCALE : 0,
      low: rec.low != null ? rec.low / PRICE_SCALE : 0,
      close: rec.close != null ? rec.close / PRICE_SCALE : 0,
      volume: rec.volume || 0,
    }));
  }

  // ── Combined: Full Options Chain with OI + Quotes ──────────────────

  /**
   * Build a full options chain for a ticker + expiration date using Databento data.
   * Combines definitions + OI + latest NBBO quotes into a unified format
   * compatible with the rest of Billy's pipeline.
   *
   * NOTE: Does NOT include greeks — pair with Tradier for delta/gamma/theta/vega.
   *
   * @param {string} ticker - e.g. 'SPY'
   * @param {string} expirationDate - e.g. '2026-02-13'
   * @returns {Promise<object[]>} Normalized option contracts (no greeks)
   */
  async getOptionsChain(ticker, expirationDate) {
    const cacheKey = `chain_${ticker}_${expirationDate}`;
    const cached = _dataCache.get(cacheKey);
    const ttl = config.alertCacheTtl || DATA_CACHE_TTL;
    if (cached && Date.now() - cached.ts < ttl) return cached.data;

    // Fetch all three data types in parallel
    const [defs, oiMap, quotes] = await Promise.all([
      this.getInstrumentDefinitions(ticker),
      this.getOpenInterest(ticker),
      this.getLatestQuotes(ticker),
    ]);

    // Filter definitions to the requested expiration
    const contracts = [];
    for (const def of defs.values()) {
      if (def.expiration !== expirationDate) continue;
      if (!def.type || !def.strike) continue;

      const instrId = def.instrumentId;
      const oi = oiMap.get(instrId) || 0;
      const quote = quotes.get(instrId) || { bid: 0, ask: 0, bidSize: 0, askSize: 0 };

      contracts.push({
        symbol: def.rawSymbol,
        ticker: def.underlying || ticker.toUpperCase(),
        strike: def.strike,
        expiration: def.expiration,
        type: def.type,
        openInterest: oi,
        volume: 0, // not available from this combo; use OHLCV if needed
        lastPrice: quote.bid > 0 && quote.ask > 0 ? (quote.bid + quote.ask) / 2 : 0,
        bid: quote.bid,
        ask: quote.ask,
        bidSize: quote.bidSize,
        askSize: quote.askSize,
        // No greeks from Databento — pair with Tradier
        delta: 0,
        gamma: 0,
        theta: 0,
        vega: 0,
        impliedVolatility: 0,
        _source: 'databento',
      });
    }

    // Sort by strike
    contracts.sort((a, b) => a.strike - b.strike);

    console.log(`[Databento] ${ticker} ${expirationDate}: ${contracts.length} contracts (OPRA NBBO + OI)`);
    _dataCache.set(cacheKey, { data: contracts, ts: Date.now() });
    return contracts;
  }

  /**
   * Get a full chain with Databento quotes/OI + Tradier greeks merged.
   * This is the premium data path: institutional OPRA data + ORATS greeks.
   *
   * @param {string} ticker
   * @param {string} expirationDate
   * @returns {Promise<object[]>} Contracts with both OPRA data and real greeks
   */
  async getOptionsWithGreeks(ticker, expirationDate) {
    // Lazy-require Tradier to avoid circular deps at module load
    const tradier = require('./tradier');

    // Fetch Databento chain and Tradier greeks in parallel
    const [dbnContracts, tradierContracts] = await Promise.all([
      this.getOptionsChain(ticker, expirationDate),
      tradier.enabled
        ? tradier.getOptionsWithGreeks(ticker, expirationDate).catch(err => {
            console.warn(`[Databento] Tradier greeks fallback failed: ${err.message}`);
            return [];
          })
        : Promise.resolve([]),
    ]);

    if (tradierContracts.length === 0) {
      // No greeks available — return Databento data as-is
      return dbnContracts;
    }

    // Build a lookup: strike+type → Tradier greeks
    const greeksMap = new Map();
    for (const tc of tradierContracts) {
      greeksMap.set(`${tc.strike}_${tc.type}`, tc);
    }

    // Merge: Databento quotes/OI + Tradier greeks
    for (const dbn of dbnContracts) {
      const key = `${dbn.strike}_${dbn.type}`;
      const tg = greeksMap.get(key);
      if (tg) {
        dbn.delta = tg.delta;
        dbn.gamma = tg.gamma;
        dbn.theta = tg.theta;
        dbn.vega = tg.vega;
        dbn.impliedVolatility = tg.impliedVolatility;
        dbn._source = 'databento+tradier';
      }
    }

    const withGreeks = dbnContracts.filter(c => c.gamma !== 0).length;
    console.log(`[Databento] ${ticker} ${expirationDate}: ${dbnContracts.length} contracts, ${withGreeks} with ORATS greeks`);
    return dbnContracts;
  }

  // ── Spot Price (underlying equity) ─────────────────────────────────

  /**
   * Get latest equity quote using Databento.
   * Note: OPRA.PILLAR is options-only. For equity quotes we fall back to
   * the trade data of near-ATM options to infer spot, or use other feeds.
   * For a direct equity quote, use Alpaca/Tradier instead.
   */
  async getQuote(ticker) {
    // Databento OPRA doesn't have equity quotes directly.
    // Use Tradier or Alpaca for spot prices.
    const tradier = require('./tradier');
    if (tradier.enabled) {
      return tradier.getQuote(ticker);
    }
    throw new Error('Databento does not provide equity quotes — configure Tradier for spot prices');
  }

  // ── Order Flow Analysis (tick-level trade data) ─────────────────────

  /**
   * Analyze recent options order flow for a ticker.
   * Uses tick-level trade data from OPRA to detect:
   *   - Large block trades (institutional activity)
   *   - Net premium flow (calls vs puts, buy vs sell side)
   *   - Unusual volume spikes by strike
   *
   * This is institutional-grade order flow analysis — the kind of data
   * that powers tools like Unusual Whales, FlowAlgo, etc.
   *
   * @param {string} ticker - e.g. 'SPY'
   * @param {number} [lookbackMinutes=15] - minutes of trade data to analyze
   * @returns {Promise<object>} Order flow summary
   */
  async getOrderFlow(ticker, lookbackMinutes = 15) {
    const cacheKey = `flow_${ticker}_${lookbackMinutes}`;
    const cached = _dataCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 30000) return cached.data; // 30s cache

    // Use HIST_LAG_MS buffer to stay within Databento's available data range (~10 min pipeline lag)
    const safeNow = new Date(Date.now() - HIST_LAG_MS);
    const start = new Date(safeNow.getTime() - lookbackMinutes * 60 * 1000);
    const startStr = start.toISOString().replace(/\.\d{3}Z/, '.000000000Z');
    const endStr = safeNow.toISOString().replace(/\.\d{3}Z/, '.000000000Z');

    // Fetch trade data + definitions in parallel
    const [trades, defs] = await Promise.all([
      this._getRange({
        symbols: `${ticker.toUpperCase()}.OPT`,
        schema: 'trades',
        stype_in: 'parent',
        start: startStr,
        end: endStr,
        limit: '50000', // cap to avoid huge responses
      }, 60000),
      this.getInstrumentDefinitions(ticker),
    ]);

    if (trades.length === 0) {
      const empty = { ticker, trades: 0, callFlow: 0, putFlow: 0, netFlow: 0, largeBlocks: [], topStrikes: [] };
      _dataCache.set(cacheKey, { data: empty, ts: Date.now() });
      return empty;
    }

    // Build instrument ID → definition lookup
    const idToDef = new Map();
    for (const def of defs.values()) {
      idToDef.set(def.instrumentId, def);
    }

    // Analyze trades
    let callPremium = 0, putPremium = 0;
    let callVolume = 0, putVolume = 0;
    const strikeVolume = new Map(); // strike → { calls, puts, premium }
    const largeBlocks = []; // trades > $50K notional
    const LARGE_BLOCK_THRESHOLD = 50000; // $50K

    for (const trade of trades) {
      const instrId = trade.hd?.instrument_id ?? trade.instrument_id ?? 0;
      const def = idToDef.get(instrId);
      if (!def) continue;

      const price = trade.price != null ? trade.price / PRICE_SCALE : 0;
      const size = trade.size || 0;
      if (price <= 0 || size <= 0) continue;

      const premium = price * size * (def.multiplier || 100);
      const side = trade.side; // 'A' = ask (buy), 'B' = bid (sell)
      const signedPremium = side === 'A' ? premium : side === 'B' ? -premium : 0;

      if (def.type === 'call') {
        callPremium += signedPremium;
        callVolume += size;
      } else if (def.type === 'put') {
        putPremium += signedPremium;
        putVolume += size;
      }

      // Track per-strike volume
      const sv = strikeVolume.get(def.strike) || { calls: 0, puts: 0, premium: 0 };
      if (def.type === 'call') sv.calls += size;
      else sv.puts += size;
      sv.premium += Math.abs(premium);
      strikeVolume.set(def.strike, sv);

      // Track large blocks
      if (Math.abs(premium) >= LARGE_BLOCK_THRESHOLD) {
        largeBlocks.push({
          strike: def.strike,
          type: def.type,
          expiration: def.expiration,
          size,
          price,
          premium: Math.round(premium),
          side: side === 'A' ? 'buy' : side === 'B' ? 'sell' : 'unknown',
        });
      }
    }

    // Sort large blocks by premium (biggest first)
    largeBlocks.sort((a, b) => Math.abs(b.premium) - Math.abs(a.premium));

    // Top strikes by volume
    const topStrikes = [...strikeVolume.entries()]
      .sort((a, b) => (b[1].calls + b[1].puts) - (a[1].calls + a[1].puts))
      .slice(0, 10)
      .map(([strike, data]) => ({ strike, ...data }));

    const result = {
      ticker: ticker.toUpperCase(),
      lookbackMinutes,
      tradeCount: trades.length,
      callVolume,
      putVolume,
      callPremium: Math.round(callPremium),
      putPremium: Math.round(putPremium),
      netFlow: Math.round(callPremium + putPremium),
      flowDirection: (callPremium + putPremium) > 0 ? 'BULLISH' : 'BEARISH',
      pcVolumeRatio: callVolume > 0 ? (putVolume / callVolume).toFixed(2) : 'N/A',
      largeBlocks: largeBlocks.slice(0, 20), // top 20 blocks
      topStrikes,
    };

    _dataCache.set(cacheKey, { data: result, ts: Date.now() });
    console.log(`[Databento] ${ticker} order flow: ${trades.length} trades, net ${result.flowDirection} ($${Math.abs(result.netFlow).toLocaleString()})`);
    return result;
  }

  /**
   * Format order flow data as a summary string for AI prompts.
   */
  formatOrderFlow(flow) {
    if (!flow || flow.tradeCount === 0) return '';

    const fmtK = (v) => {
      const a = Math.abs(v);
      const s = v < 0 ? '-' : '+';
      return a >= 1e6 ? `${s}$${(a/1e6).toFixed(1)}M` : a >= 1e3 ? `${s}$${(a/1e3).toFixed(0)}K` : `${s}$${a}`;
    };

    const lines = [
      `=== OPTIONS ORDER FLOW (Databento OPRA — last ${flow.lookbackMinutes}min) ===`,
      `${flow.tradeCount} trades | Net flow: ${fmtK(flow.netFlow)} → ${flow.flowDirection}`,
      `Call premium: ${fmtK(flow.callPremium)} (${flow.callVolume} contracts)`,
      `Put premium: ${fmtK(flow.putPremium)} (${flow.putVolume} contracts)`,
      `P/C volume ratio: ${flow.pcVolumeRatio}`,
    ];

    if (flow.largeBlocks.length > 0) {
      lines.push(`Large blocks (>$50K): ${flow.largeBlocks.length}`);
      for (const b of flow.largeBlocks.slice(0, 5)) {
        lines.push(`  ${b.side.toUpperCase()} ${b.size}x $${b.strike} ${b.type} @ $${b.price.toFixed(2)} (${fmtK(b.premium)})`);
      }
    }

    return lines.join('\n');
  }

  // ── Status / Info ──────────────────────────────────────────────────

  getStatus() {
    return {
      enabled: this.enabled,
      dataset: 'OPRA.PILLAR',
      features: [
        'NBBO quotes (all 17 exchanges)',
        'Trade prints (nanosecond)',
        'Open interest',
        'Instrument definitions',
        'Order flow analysis (large blocks, net premium)',
      ],
      greeks: 'via Tradier/ORATS (Databento provides raw data only)',
      defCacheSize: _defCache.size,
      dataCacheSize: _dataCache.size,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function _today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Safe end-of-day timestamp for Databento queries.
 * Databento's historical API rejects `end` values after the latest available data.
 * OPRA.PILLAR has a ~10 min pipeline lag, so for today cap to "now minus 15 min".
 * For past dates, use end-of-day as usual.
 */
function _safeEnd(dateStr) {
  const today = _today();
  if (dateStr === today) {
    // Cap to 15 min ago — Databento's ingest pipeline has ~10 min lag
    const safeNow = new Date(Date.now() - HIST_LAG_MS);
    return safeNow.toISOString().replace(/\.\d{3}Z/, '.000000000Z');
  }
  return `${dateStr}T23:59:59.999999999Z`;
}

function _yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  // Skip weekends for OI (published on business days)
  const day = d.getDay();
  if (day === 0) d.setDate(d.getDate() - 2); // Sunday → Friday
  if (day === 6) d.setDate(d.getDate() - 1); // Saturday → Friday
  return d.toISOString().slice(0, 10);
}

/**
 * Convert nanosecond-epoch timestamp to YYYY-MM-DD string.
 */
function _nsToDateString(ns) {
  // Databento timestamps are nanoseconds since Unix epoch
  const ms = typeof ns === 'bigint' ? Number(ns / 1000000n) : Math.floor(ns / 1000000);
  const d = new Date(ms);
  return d.toISOString().slice(0, 10);
}

module.exports = new DatabentoService();
