/**
 * GEX Gamma Heat Map — Interactive Dashboard Routes
 *
 * Serves:
 *   GET  /gex                          → Interactive dashboard page
 *   GET  /api/gex/heatmap/:ticker      → JSON heatmap data
 *   GET  /api/gex/heatmap/:ticker/stream → SSE real-time updates
 *   GET  /api/gex/expirations/:ticker  → Available expiration dates
 *
 * The dashboard is a single-page app with vanilla JS (zero external deps).
 * Real-time updates use Server-Sent Events (SSE) for live data push.
 */

const gamma = require('../services/gamma');
const alpaca = require('../services/alpaca');
const tradier = require('../services/tradier');
const publicService = require('../services/public');
const priceFetcher = require('../tools/price-fetcher');
const { bsGamma: _bsGamma, estimateIV: _estimateIV } = require('../lib/black-scholes');

// Active SSE connections per ticker for cleanup
const _sseClients = new Map(); // ticker → Set<res>

// ── Live GEX Cache ─────────────────────────────────────────────────────
// When Databento Live is streaming, we maintain a shadow heatmap cache
// that updates in real-time as OI/trades come in from the TCP stream.
// The cached greeks from the last full fetch are used to recalculate GEX.

const _liveGexCache = new Map(); // ticker → { data, contracts, spotPrice, lastFullFetch, lastLiveUpdate }
let _liveWired = false;

/**
 * Wire the Databento Live stream into the GEX heatmap cache.
 * Called once when the first SSE client connects.
 */
function _wireLiveStream() {
  if (_liveWired) return;
  let live;
  try { live = require('../services/databento-live'); } catch { return; }
  if (!live.client.enabled) return;

  _liveWired = true;
  console.log('[GEXHeatmap] Wiring live Databento stream for real-time GEX updates');

  // On trade: update volume counters
  live.client.on('trade', (trade) => {
    if (!trade.underlying || !trade.strike || !trade.optionType || !trade.expirationDate) return;
    const ticker = trade.underlying;
    const cache = _liveGexCache.get(ticker);
    if (!cache || !cache.contracts) return;

    // Find matching contract and increment volume
    const key = `${trade.strike}_${trade.optionType}_${trade.expirationDate}`;
    const contract = cache.contracts.get(key);
    if (contract) {
      contract.volume = (contract.volume || 0) + (trade.size || 1);
      cache.lastLiveUpdate = Date.now();
    }
  });

  // On OI stat: update open interest and recalculate GEX
  live.client.on('statistic', (stat) => {
    if (stat.statType !== 9) return; // 9 = OPEN_INTEREST
    if (!stat.underlying || !stat.strike || !stat.optionType) return;

    const ticker = stat.underlying;
    const cache = _liveGexCache.get(ticker);
    if (!cache || !cache.contracts) return;

    // stat.quantity is BigInt from DBN i64 field — convert to Number for OI
    const oi = Number(stat.quantity);
    if (oi <= 0) return;

    const key = `${stat.strike}_${stat.optionType}_${stat.expirationDate}`;
    const contract = cache.contracts.get(key);
    if (contract) {
      contract.openInterest = oi;
      cache.dirty = true;
      cache.lastLiveUpdate = Date.now();
    }
  });

  // On quote: update spot price from underlying quotes (not option quotes)
  live.client.on('quote', (quote) => {
    if (!quote.underlying || !quote.level) return;
    // Only update if this is actually the underlying equity quote
    // (option quotes have strikes, equity quotes don't)
    if (quote.strike) return;
    const ticker = quote.underlying;
    const cache = _liveGexCache.get(ticker);
    if (cache && quote.level.bidPx && quote.level.askPx) {
      const mid = (quote.level.bidPx + quote.level.askPx) / 2;
      if (mid > 0) {
        cache.spotPrice = mid;
        cache.dirty = true;
        cache.lastLiveUpdate = Date.now();
      }
    }
  });

  // Push live updates to SSE clients every 5 seconds
  setInterval(() => {
    for (const [ticker, cache] of _liveGexCache) {
      if (!cache.dirty) continue;
      cache.dirty = false;

      const clients = _sseClients.get(ticker);
      if (!clients || clients.size === 0) continue;

      // Rebuild heatmap from cached contracts with updated OI
      try {
        const data = _rebuildHeatmapFromCache(cache);
        if (!data) continue;
        const payload = `data: ${JSON.stringify(data)}\n\n`;
        for (const res of clients) {
          try { res.write(payload); } catch { /* client gone */ }
        }
      } catch (err) {
        console.warn(`[GEXHeatmap] Live rebuild failed for ${ticker}: ${err.message}`);
      }
    }
  }, 5000);
}

/**
 * Rebuild the heatmap data structure from cached contracts.
 * Uses cached gamma values with updated OI to recalculate GEX.
 */
function _rebuildHeatmapFromCache(cache) {
  if (!cache.data || !cache.contracts || !cache.spotPrice) return null;

  const spotPrice = cache.spotPrice;
  const oldData = cache.data;

  // Recalculate GEX per strike per expiration
  const expirationResults = [];
  const allStrikes = new Set();

  for (const exp of oldData.expirations) {
    const strikeGEX = {};
    let totalGEX = 0;

    for (const [key, c] of cache.contracts) {
      // Key format: strike_type_date (e.g. "605_call_2026-02-13")
      if (c.expiration !== exp.date) continue;
      if (!c.gamma || !c.openInterest) continue;

      const gex = c.openInterest * c.gamma * 100 * spotPrice;
      const strike = c.strike;
      const entry = strikeGEX[strike] || { net: 0, call: 0, put: 0, callOI: 0, putOI: 0 };

      if (c.type === 'call') {
        entry.call += gex;
        entry.callOI += c.openInterest;
      } else {
        entry.put -= gex;
        entry.putOI += c.openInterest;
      }
      entry.net = entry.call + entry.put;
      strikeGEX[strike] = entry;
      allStrikes.add(strike);
    }

    totalGEX = Object.values(strikeGEX).reduce((s, e) => s + e.net, 0);
    expirationResults.push({ date: exp.date, strikeGEX, totalGEX });
  }

  if (expirationResults.length === 0) return null;

  // Reuse the same strike range from cached data
  const selectedStrikes = [...oldData.strikes].reverse(); // un-reverse to ascending
  const grid = [];
  let maxAbsGEX = 0;

  for (const strike of selectedStrikes) {
    const row = { strike, values: [] };
    for (const exp of expirationResults) {
      const data = exp.strikeGEX[strike] || { net: 0, call: 0, put: 0, callOI: 0, putOI: 0 };
      row.values.push(data);
      if (Math.abs(data.net) > maxAbsGEX) maxAbsGEX = Math.abs(data.net);
    }
    grid.push(row);
  }

  const profile = selectedStrikes.map(strike => {
    let totalNet = 0, totalCall = 0, totalPut = 0;
    for (const exp of expirationResults) {
      const d = exp.strikeGEX[strike];
      if (d) { totalNet += d.net; totalCall += d.call; totalPut += d.put; }
    }
    return { strike, net: totalNet, call: totalCall, put: totalPut };
  });

  // Compute key levels
  let callWall = null, putWall = null, gammaFlip = null;
  const posStrikes = profile.filter(p => p.net > 0);
  if (posStrikes.length > 0) callWall = posStrikes.reduce((best, p) => p.net > best.net ? p : best);
  const negStrikes = profile.filter(p => p.net < 0);
  if (negStrikes.length > 0) putWall = negStrikes.reduce((best, p) => p.net < best.net ? p : best);

  let cumulative = 0;
  for (let i = 0; i < profile.length; i++) {
    const prev = cumulative;
    cumulative += profile[i].net;
    if (i > 0 && prev !== 0 && Math.sign(prev) !== Math.sign(cumulative)) {
      const ratio = Math.abs(prev) / (Math.abs(prev) + Math.abs(profile[i].net));
      gammaFlip = Math.round((profile[i - 1].strike + ratio * (profile[i].strike - profile[i - 1].strike)) * 100) / 100;
      break;
    }
  }

  // Reverse for display (highest strike on top)
  selectedStrikes.reverse();
  grid.reverse();
  profile.reverse();

  return {
    ticker: oldData.ticker,
    spotPrice,
    source: oldData.source + ' (LIVE)',
    timestamp: new Date().toISOString(),
    expirations: expirationResults.map(e => ({ date: e.date, totalGEX: e.totalGEX })),
    availableExpirations: oldData.availableExpirations,
    strikes: selectedStrikes,
    grid, profile, maxAbsGEX,
    callWall: callWall ? { strike: callWall.strike, gex: callWall.net } : null,
    putWall: putWall ? { strike: putWall.strike, gex: putWall.net } : null,
    gammaFlip,
  };
}

/**
 * Populate the live GEX cache for a ticker after a full data fetch.
 * Stores all contracts with their gamma values for incremental updates.
 * When no real greeks are available, estimates gamma via Black-Scholes.
 */
function _populateLiveCache(ticker, data, source) {
  let live;
  try { live = require('../services/databento-live'); } catch { return; }
  if (!live.client.connected) return;

  // Build contract map — either from live stream or from the last full fetch
  const contractMap = new Map();
  const spotPrice = data.spotPrice;

  const buildFromLive = () => {
    for (const exp of data.expirations) {
      const T = Math.max((new Date(exp.date).getTime() - Date.now()) / (365.25 * 86400000), 1 / 365);
      const contracts = live.getOptionsChain(ticker, exp.date);
      for (const c of contracts) {
        if (!c.strike || !c.openInterest) continue;
        let g = c.gamma;
        if (!g || g === 0) {
          const mid = c.lastPrice || (c.bid > 0 && c.ask > 0 ? (c.bid + c.ask) / 2 : 0);
          const iv = _estimateIV(mid, spotPrice, c.strike, T, c.type === 'call');
          g = _bsGamma(spotPrice, c.strike, iv, T);
        }
        if (!g) continue;
        const key = `${c.strike}_${c.type}_${exp.date}`;
        contractMap.set(key, {
          strike: c.strike, type: c.type, expiration: exp.date,
          gamma: g, openInterest: c.openInterest, volume: c.volume || 0,
        });
      }
    }
  };

  const buildFromApi = async () => {
    try {
      for (const exp of data.expirations) {
        const T = Math.max((new Date(exp.date).getTime() - Date.now()) / (365.25 * 86400000), 1 / 365);
        let contracts;
        if (source === 'Tradier') {
          contracts = await tradier.getOptionsWithGreeks(ticker, exp.date);
        } else if (source === 'Public.com') {
          contracts = await publicService.getOptionsWithGreeks(ticker, exp.date);
        }
        if (!contracts) continue;

        for (const c of contracts) {
          if (!c.strike || !c.openInterest) continue;
          let g = c.gamma;
          if (!g || g === 0) {
            const mid = c.lastPrice || (c.bid > 0 && c.ask > 0 ? (c.bid + c.ask) / 2 : 0);
            const iv = _estimateIV(mid, spotPrice, c.strike, T, c.type === 'call');
            g = _bsGamma(spotPrice, c.strike, iv, T);
          }
          if (!g) continue;
          const key = `${c.strike}_${c.type}_${exp.date}`;
          contractMap.set(key, {
            strike: c.strike, type: c.type, expiration: exp.date,
            gamma: g, openInterest: c.openInterest, volume: c.volume || 0,
          });
        }
      }
    } catch (err) {
      console.warn(`[GEXHeatmap] Live cache populate failed: ${err.message}`);
      return;
    }
  };

  const finalize = () => {
    if (contractMap.size === 0) return;
    _liveGexCache.set(ticker, {
      data, contracts: contractMap, spotPrice,
      lastFullFetch: Date.now(), lastLiveUpdate: null, dirty: false,
    });
    console.log(`[GEXHeatmap] Live cache populated: ${ticker} (${contractMap.size} contracts, source=${source})`);
  };

  if (source === 'DatabentoLive') {
    buildFromLive();
    finalize();
  } else if (source !== 'Yahoo') {
    buildFromApi().then(finalize);
  }
}

/**
 * Register all GEX heatmap routes on the Express app.
 * @param {import('express').Express} app
 */
function registerGEXHeatmapRoutes(app) {

  // ── JSON data endpoint ──────────────────────────────────────────────

  app.get('/api/gex/expirations/:ticker', async (req, res) => {
    try {
      const ticker = req.params.ticker.toUpperCase().replace(/[^A-Z0-9.]/g, '');
      const exps = await gamma.fetchAvailableExpirations(ticker);
      res.json({ ticker, expirations: exps.map(e => e.date) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/gex/heatmap/:ticker', async (req, res) => {
    try {
      const ticker = req.params.ticker.toUpperCase().replace(/[^A-Z0-9.]/g, '');
      const range = Math.min(Math.max(parseInt(req.query.range) || 20, 5), 50);
      const expirations = req.query.expirations
        ? req.query.expirations.split(',').map(s => s.trim())
        : null; // null = auto-pick nearest

      const data = await _fetchHeatmapData(ticker, range, expirations);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── SSE real-time stream ────────────────────────────────────────────
  // When Databento Live is streaming, live OI/trade updates are pushed
  // every 5s via the _wireLiveStream() interval. The full API re-fetch
  // happens on a longer interval to refresh greeks/spot baseline.

  app.get('/api/gex/heatmap/:ticker/stream', (req, res) => {
    const ticker = req.params.ticker.toUpperCase().replace(/[^A-Z0-9.]/g, '');
    const range = Math.min(Math.max(parseInt(req.query.range) || 20, 5), 50);
    const intervalSec = Math.min(Math.max(parseInt(req.query.interval) || 60, 15), 300);
    const expirations = req.query.expirations
      ? req.query.expirations.split(',').map(s => s.trim())
      : null;

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Track this client
    if (!_sseClients.has(ticker)) _sseClients.set(ticker, new Set());
    _sseClients.get(ticker).add(res);

    // Wire the live stream on first SSE connection
    _wireLiveStream();

    // Send initial data immediately (full fetch to populate greeks cache)
    _fetchAndPush(res, ticker, range, expirations);

    // Full API re-fetch on longer interval (refreshes greeks baseline)
    // Live updates between full fetches are pushed by _wireLiveStream's 5s interval
    const timer = setInterval(() => {
      _fetchAndPush(res, ticker, range, expirations);
    }, intervalSec * 1000);

    // Cleanup on disconnect
    req.on('close', () => {
      clearInterval(timer);
      const clients = _sseClients.get(ticker);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) {
          _sseClients.delete(ticker);
          _liveGexCache.delete(ticker); // Free memory when no one's watching
        }
      }
    });
  });

  // ── Interactive dashboard page ──────────────────────────────────────

  app.get('/gex', (_req, res) => {
    res.send(_dashboardHTML());
  });

  console.log('[Dashboard] GEX Heatmap routes registered: /gex, /api/gex/heatmap/:ticker, /api/gex/heatmap/:ticker/stream');
}

// ── Data fetching ─────────────────────────────────────────────────────

async function _fetchHeatmapData(ticker, strikeRange, requestedExps) {
  // 1. Get spot price (source-independent — OPRA is options-only, always need equity quote)
  let spotPrice = null;
  if (tradier.enabled) {
    try {
      const q = await tradier.getQuote(ticker);
      spotPrice = q.price;
    } catch { /* fallback */ }
  }
  if (!spotPrice && alpaca.enabled) {
    try {
      const snap = await alpaca.getSnapshot(ticker);
      spotPrice = snap.price;
    } catch { /* fallback */ }
  }
  if (!spotPrice) {
    const pf = await priceFetcher.getCurrentPrice(ticker);
    if (!pf.error) spotPrice = pf.price;
  }
  if (!spotPrice) throw new Error(`Cannot determine spot price for ${ticker}`);

  // 2. Build source priority list — try each in order with fallback
  // If a source has expirations but produces no usable chain data (e.g. OI=0), fall back to next
  let live;
  try { live = require('../services/databento-live'); } catch { live = null; }

  const sourcesToTry = [];
  if (live && live.hasDataFor(ticker)) sourcesToTry.push('DatabentoLive');
  if (tradier.enabled) sourcesToTry.push('Tradier');
  if (publicService.enabled) sourcesToTry.push('Public.com');
  // Alpaca omitted: indicative feed has no open interest data (OI=0),
  // and no expiration discovery API. Needs SIP feed ($99/mo) for OI.
  // Free alternative: set TRADIER_API_KEY (sandbox is free, includes ORATS greeks + OI)
  sourcesToTry.push('Yahoo');
  if (sourcesToTry.length === 1) {
    console.warn('[GEXHeatmap] No premium sources configured — using Yahoo only. Set TRADIER_API_KEY for real greeks (free sandbox).');
  }

  let source = null;
  let expirationResults = [];
  let allStrikes = new Set();
  let futureExpDates = [];
  let bestFallback = null; // Track best data if no source meets MIN_STRIKES

  for (const trySource of sourcesToTry) {
    // ── Get available expirations for this source ──
    let allExpDates = null;
    let yahooExps = null;

    try {
      if (trySource === 'DatabentoLive') {
        const dates = live.getExpirations(ticker);
        if (dates.length > 0) allExpDates = dates;
      } else if (trySource === 'Tradier') {
        const dates = await tradier.getOptionExpirations(ticker);
        if (dates.length > 0) allExpDates = dates;
      } else if (trySource === 'Public.com') {
        const dates = await publicService.getOptionExpirations(ticker);
        if (dates && dates.length > 0) allExpDates = dates;
      } else {
        yahooExps = await gamma.fetchAvailableExpirations(ticker);
        if (yahooExps.length > 0) allExpDates = yahooExps.map(e => e.date);
      }
    } catch (err) {
      console.warn(`[GEXHeatmap] ${trySource} expirations failed: ${err.message}`);
      continue;
    }

    if (!allExpDates || allExpDates.length === 0) continue;

    const today = new Date().toISOString().slice(0, 10);
    futureExpDates = allExpDates.filter(d => d >= today).sort();

    let targetExpDates;
    if (requestedExps && requestedExps.length > 0) {
      targetExpDates = allExpDates.filter(d => requestedExps.includes(d));
    } else {
      targetExpDates = futureExpDates.slice(0, 6);
    }
    if (targetExpDates.length === 0) continue;

    // ── Fetch chains and compute GEX per strike per expiration ──
    expirationResults = [];
    allStrikes = new Set();

    if (trySource === 'Yahoo') {
      // ── Yahoo: fetch all expirations in parallel for speed ──
      const fetchResults = await Promise.allSettled(targetExpDates.map(async (expDate) => {
        const expObj = yahooExps?.find(e => e.date === expDate);
        if (!expObj) return null;
        const result = await gamma._yahooFetch(ticker, expObj.epoch);
        const options = result.options?.[0];
        if (!options) return null;

        const chain = [];
        for (const c of (options.calls || [])) {
          chain.push({
            strike: c.strike, expiration: expDate, expirationEpoch: expObj.epoch,
            type: 'call', openInterest: c.openInterest || 0, impliedVolatility: c.impliedVolatility || 0,
          });
        }
        for (const p of (options.puts || [])) {
          chain.push({
            strike: p.strike, expiration: expDate, expirationEpoch: expObj.epoch,
            type: 'put', openInterest: p.openInterest || 0, impliedVolatility: p.impliedVolatility || 0,
          });
        }

        const detailed = gamma.calculateDetailedGEX(chain, spotPrice);
        const strikeGEXMap = {};
        const strikes = [];
        for (const s of detailed.strikes) {
          strikeGEXMap[s.strike] = {
            net: s['netGEX$'], call: s['callGEX$'], put: s['putGEX$'],
            callOI: s.callOI, putOI: s.putOI,
          };
          strikes.push(s.strike);
        }
        return { date: expDate, strikeGEX: strikeGEXMap, totalGEX: detailed['totalNetGEX$'], strikes };
      }));

      for (const r of fetchResults) {
        if (r.status === 'fulfilled' && r.value && Object.keys(r.value.strikeGEX).length > 0) {
          expirationResults.push({ date: r.value.date, strikeGEX: r.value.strikeGEX, totalGEX: r.value.totalGEX });
          for (const s of r.value.strikes) allStrikes.add(s);
        } else if (r.status === 'rejected') {
          console.warn(`[GEXHeatmap] Yahoo exp failed: ${r.reason?.message}`);
        }
      }
    } else {
      // ── Non-Yahoo sources: sequential (DatabentoLive is in-memory = fast) ──
      for (const expDate of targetExpDates) {
        try {
          let contracts;
          if (trySource === 'DatabentoLive') {
            contracts = live.getOptionsChain(ticker, expDate);
          } else if (trySource === 'Tradier') {
            contracts = await tradier.getOptionsWithGreeks(ticker, expDate);
          } else {
            contracts = await publicService.getOptionsWithGreeks(ticker, expDate);
          }
          if (!contracts || contracts.length === 0) continue;

          const T = Math.max((new Date(expDate).getTime() - Date.now()) / (365.25 * 86400000), 1 / 365);

          const strikeMap = new Map();
          for (const c of contracts) {
            if (!c.strike || !c.openInterest) continue;

            let contractGamma = c.gamma;
            if (!contractGamma || contractGamma === 0) {
              const mid = c.lastPrice || (c.bid > 0 && c.ask > 0 ? (c.bid + c.ask) / 2 : 0);
              const iv = _estimateIV(mid, spotPrice, c.strike, T, c.type === 'call');
              contractGamma = _bsGamma(spotPrice, c.strike, iv, T);
            }
            if (!contractGamma) continue;

            const gex = c.openInterest * contractGamma * 100 * spotPrice;
            const entry = strikeMap.get(c.strike) || { net: 0, call: 0, put: 0, callOI: 0, putOI: 0 };
            if (c.type === 'call') {
              entry.call += gex;
              entry.callOI += c.openInterest;
            } else {
              entry.put -= gex;
              entry.putOI += c.openInterest;
            }
            entry.net = entry.call + entry.put;
            strikeMap.set(c.strike, entry);
          }

          const strikeGEXMap = {};
          let totalGEX = 0;
          for (const [strike, data] of strikeMap) {
            strikeGEXMap[strike] = data;
            allStrikes.add(strike);
            totalGEX += data.net;
          }

          if (Object.keys(strikeGEXMap).length > 0) {
            expirationResults.push({ date: expDate, strikeGEX: strikeGEXMap, totalGEX });
          }
        } catch (err) {
          console.warn(`[GEXHeatmap API] Skipping ${expDate}: ${err.message}`);
          if (err.name === 'TimeoutError' || err.message.includes('timeout')) break;
        }
      }
    }

    // Require a minimum number of strikes to consider a source usable —
    // DatabentoLive often has sparse OI early in the session which produces
    // a nearly-empty heatmap. Fall back to a richer source instead.
    const MIN_STRIKES = 10;
    if (expirationResults.length > 0 && allStrikes.size >= MIN_STRIKES) {
      source = trySource;
      console.log(`[GEXHeatmap] Using ${trySource} for ${ticker} (${expirationResults.length} expirations, ${allStrikes.size} strikes)`);
      break; // Success — use this source
    }

    // Track best fallback in case no source meets MIN_STRIKES
    if (expirationResults.length > 0 && allStrikes.size > 0 &&
        (!bestFallback || allStrikes.size > bestFallback.allStrikes.size)) {
      bestFallback = { source: trySource, expirationResults: [...expirationResults], allStrikes: new Set(allStrikes), futureExpDates: [...futureExpDates] };
    }

    console.warn(`[GEXHeatmap] ${trySource} had expirations but insufficient data (${expirationResults.length} exps, ${allStrikes.size} strikes), falling back...`);
  }

  // If no source met MIN_STRIKES but we have some data, use the best available
  if (!source && bestFallback) {
    source = bestFallback.source;
    expirationResults = bestFallback.expirationResults;
    allStrikes = bestFallback.allStrikes;
    futureExpDates = bestFallback.futureExpDates;
    console.warn(`[GEXHeatmap] No source met MIN_STRIKES, using best fallback: ${source} (${expirationResults.length} exps, ${allStrikes.size} strikes)`);
  }

  if (expirationResults.length === 0) throw new Error(`No options data for ${ticker}`);

  // 4. Select strikes around spot
  const sortedStrikes = [...allStrikes].sort((a, b) => a - b);
  const spotIdx = sortedStrikes.reduce((best, s, i) =>
    Math.abs(s - spotPrice) < Math.abs(sortedStrikes[best] - spotPrice) ? i : best, 0);

  const startIdx = Math.max(0, spotIdx - strikeRange);
  const endIdx = Math.min(sortedStrikes.length, spotIdx + strikeRange + 1);
  const selectedStrikes = sortedStrikes.slice(startIdx, endIdx);

  // 5. Build grid
  const grid = [];
  let maxAbsGEX = 0;

  for (const strike of selectedStrikes) {
    const row = { strike, values: [] };
    for (const exp of expirationResults) {
      const data = exp.strikeGEX[strike] || { net: 0, call: 0, put: 0, callOI: 0, putOI: 0 };
      row.values.push(data);
      if (Math.abs(data.net) > maxAbsGEX) maxAbsGEX = Math.abs(data.net);
    }
    grid.push(row);
  }

  // 6. Build aggregated profile (net GEX per strike across all expirations)
  const profile = selectedStrikes.map(strike => {
    let totalNet = 0, totalCall = 0, totalPut = 0;
    for (const exp of expirationResults) {
      const d = exp.strikeGEX[strike];
      if (d) { totalNet += d.net; totalCall += d.call; totalPut += d.put; }
    }
    return { strike, net: totalNet, call: totalCall, put: totalPut };
  });

  // 7. Compute key levels: call wall, put wall, gamma flip (from friend's algo)
  let callWall = null, putWall = null, gammaFlip = null;
  if (profile.length > 0) {
    // Call wall = strike with highest positive net GEX
    const posStrikes = profile.filter(p => p.net > 0);
    if (posStrikes.length > 0) {
      callWall = posStrikes.reduce((best, p) => p.net > best.net ? p : best);
    }
    // Put wall = strike with most negative net GEX
    const negStrikes = profile.filter(p => p.net < 0);
    if (negStrikes.length > 0) {
      putWall = negStrikes.reduce((best, p) => p.net < best.net ? p : best);
    }
    // Gamma flip = where cumulative GEX crosses zero (interpolated)
    let cumulative = 0;
    for (let i = 0; i < profile.length; i++) {
      const prev = cumulative;
      cumulative += profile[i].net;
      if (i > 0 && prev !== 0 && Math.sign(prev) !== Math.sign(cumulative)) {
        const ratio = Math.abs(prev) / (Math.abs(prev) + Math.abs(profile[i].net));
        gammaFlip = profile[i - 1].strike + ratio * (profile[i].strike - profile[i - 1].strike);
        gammaFlip = Math.round(gammaFlip * 100) / 100;
        break;
      }
    }
  }

  // Reverse so highest strike is on top (trader convention: calls on top, puts on bottom)
  selectedStrikes.reverse();
  grid.reverse();
  profile.reverse();

  return {
    ticker,
    spotPrice,
    source,
    timestamp: new Date().toISOString(),
    expirations: expirationResults.map(e => ({ date: e.date, totalGEX: e.totalGEX })),
    availableExpirations: futureExpDates,
    strikes: selectedStrikes,
    grid,
    profile,
    maxAbsGEX,
    // Key levels (from friend's algo)
    callWall: callWall ? { strike: callWall.strike, gex: callWall.net } : null,
    putWall: putWall ? { strike: putWall.strike, gex: putWall.net } : null,
    gammaFlip,
  };
}

async function _fetchAndPush(res, ticker, range, expirations) {
  try {
    const data = await _fetchHeatmapData(ticker, range, expirations);
    res.write(`data: ${JSON.stringify(data)}\n\n`);

    // Populate live GEX cache so real-time updates can update OI incrementally
    _populateLiveCache(ticker, data, data.source);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
}

// ── Dashboard HTML ────────────────────────────────────────────────────

function _dashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gamma Heat Map — Billy Dashboard</title>
<style>
  :root {
    --bg: #0d1117; --bg2: #161b22; --bg3: #1c2128; --border: #30363d;
    --text: #e6edf3; --text-dim: #8b949e; --text-muted: #484f58;
    --accent: #58a6ff; --green: #3fb950; --red: #f85149; --cyan: #39d2c0;
    --cyan-dim: rgba(57,210,192,0.15); --red-dim: rgba(248,81,73,0.15);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); overflow-x: hidden; }

  /* ── Top Bar ── */
  .topbar { display: flex; align-items: center; gap: 12px; padding: 12px 20px; background: var(--bg2); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .topbar h1 { font-size: 16px; font-weight: 700; white-space: nowrap; }
  .topbar h1 span { color: var(--accent); }
  .ticker-input { background: var(--bg3); border: 1px solid var(--border); color: var(--text); padding: 6px 12px; border-radius: 6px; font-size: 14px; width: 100px; text-transform: uppercase; font-weight: 600; }
  .ticker-input:focus { outline: none; border-color: var(--accent); }
  .btn { background: var(--bg3); border: 1px solid var(--border); color: var(--text); padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; transition: all 0.15s; }
  .btn:hover { background: var(--border); }
  .btn.active { background: var(--accent); color: #000; border-color: var(--accent); font-weight: 600; }
  .btn.live { background: #1a7f37; border-color: var(--green); }
  .btn.live.active { background: var(--green); color: #000; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.7; } }

  .controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .control-group { display: flex; align-items: center; gap: 4px; }
  .control-label { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; }
  .range-input { width: 80px; accent-color: var(--accent); }
  .range-val { font-size: 12px; color: var(--text-dim); min-width: 28px; text-align: center; }
  .separator { width: 1px; height: 24px; background: var(--border); margin: 0 4px; }

  .spot-badge { background: rgba(88,166,255,0.15); color: var(--accent); padding: 4px 10px; border-radius: 12px; font-size: 13px; font-weight: 600; white-space: nowrap; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 4px; }
  .status-dot.live { background: var(--green); }
  .status-dot.off { background: var(--text-muted); }

  /* ── View Toggle ── */
  .view-tabs { display: flex; gap: 2px; background: var(--bg3); border-radius: 6px; padding: 2px; }
  .view-tab { padding: 5px 14px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); transition: all 0.15s; border: none; background: none; }
  .view-tab.active { background: var(--accent); color: #000; }
  .view-tab:hover:not(.active) { color: var(--text); }

  /* ── Expiration Chips ── */
  .exp-bar { display: flex; align-items: center; gap: 6px; padding: 8px 20px; background: var(--bg2); border-bottom: 1px solid var(--border); overflow-x: auto; }
  .exp-chip { padding: 4px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; cursor: pointer; border: 1px solid var(--border); background: var(--bg3); color: var(--text-dim); transition: all 0.15s; white-space: nowrap; user-select: none; }
  .exp-chip.active { background: rgba(57,210,192,0.2); color: var(--cyan); border-color: var(--cyan); }
  .exp-chip:hover { border-color: var(--text-dim); }
  .exp-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-right: 4px; }

  /* ── Main Content ── */
  .main { display: flex; height: calc(100vh - 100px); }
  .main.with-exp-bar { height: calc(100vh - 140px); }

  /* ── Heatmap Table ── */
  .heatmap-wrap { flex: 1; overflow: auto; position: relative; }
  .heatmap-table { border-collapse: collapse; width: max-content; min-width: 100%; }
  .heatmap-table th { position: sticky; top: 0; z-index: 2; background: var(--bg2); padding: 8px 6px; font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid var(--border); white-space: nowrap; }
  .heatmap-table th.strike-col { position: sticky; left: 0; z-index: 3; min-width: 70px; text-align: right; padding-right: 12px; }
  .heatmap-table td { padding: 0; text-align: center; font-size: 12px; font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; border: 1px solid rgba(48,54,61,0.4); height: 28px; min-width: 110px; position: relative; cursor: crosshair; transition: filter 0.1s; }
  .heatmap-table td:hover { filter: brightness(1.4); z-index: 1; }
  .heatmap-table td.strike-cell { position: sticky; left: 0; z-index: 1; background: var(--bg2); text-align: right; padding-right: 12px; font-weight: 500; color: var(--text-dim); cursor: default; border-right: 2px solid var(--border); min-width: 70px; }
  .heatmap-table tr.spot-row td.strike-cell { color: var(--accent); font-weight: 700; background: rgba(88,166,255,0.08); }
  .heatmap-table tr.spot-row td { box-shadow: inset 0 -2px 0 rgba(88,166,255,0.4), inset 0 2px 0 rgba(88,166,255,0.4); }

  /* ── Tooltip ── */
  .tooltip { position: fixed; z-index: 100; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; font-size: 12px; pointer-events: none; opacity: 0; transition: opacity 0.12s; box-shadow: 0 8px 24px rgba(0,0,0,0.4); max-width: 260px; }
  .tooltip.show { opacity: 1; }
  .tooltip .tt-title { font-weight: 700; margin-bottom: 6px; color: var(--accent); }
  .tooltip .tt-row { display: flex; justify-content: space-between; gap: 16px; margin: 2px 0; }
  .tooltip .tt-label { color: var(--text-dim); }
  .tooltip .tt-val { font-family: 'SF Mono', monospace; font-weight: 600; }
  .tt-pos { color: var(--cyan); }
  .tt-neg { color: var(--red); }

  /* ── Profile Panel ── */
  .profile-panel { width: 350px; border-left: 1px solid var(--border); overflow-y: auto; background: var(--bg); display: none; flex-direction: column; }
  .profile-panel.show { display: flex; }
  .profile-title { padding: 10px 16px; font-size: 13px; font-weight: 700; border-bottom: 1px solid var(--border); background: var(--bg2); text-transform: uppercase; letter-spacing: 0.5px; }
  .profile-bars { flex: 1; padding: 4px 0; overflow-y: auto; }
  .profile-row { display: flex; align-items: center; height: 28px; padding: 0 12px; font-size: 11px; }
  .profile-row.spot { background: rgba(88,166,255,0.08); }
  .profile-strike { width: 50px; text-align: right; color: var(--text-dim); font-weight: 500; flex-shrink: 0; }
  .profile-bar-wrap { flex: 1; display: flex; align-items: center; margin: 0 8px; height: 18px; position: relative; }
  .profile-bar { height: 14px; border-radius: 2px; min-width: 1px; transition: width 0.3s; }
  .profile-bar.positive { background: var(--cyan); margin-left: auto; border-radius: 2px 0 0 2px; }
  .profile-bar.negative { background: var(--red); margin-right: auto; border-radius: 0 2px 2px 0; }
  .profile-center { position: absolute; left: 50%; width: 1px; height: 100%; background: var(--border); }
  .profile-val { width: 60px; font-family: monospace; font-size: 10px; color: var(--text-dim); }

  /* ── Loading / Error ── */
  .loading { display: flex; align-items: center; justify-content: center; height: 100%; flex-direction: column; gap: 12px; }
  .loading .spinner { width: 32px; height: 32px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error-msg { color: var(--red); background: var(--red-dim); padding: 12px 20px; border-radius: 8px; margin: 20px; font-size: 13px; }

  /* ── Key Levels Badges ── */
  .key-levels { display: flex; gap: 6px; font-size: 11px; font-weight: 600; }
  .kl-badge { padding: 3px 8px; border-radius: 10px; white-space: nowrap; }
  .kl-call { background: rgba(57,210,192,0.15); color: var(--cyan); }
  .kl-put { background: var(--red-dim); color: var(--red); }
  .kl-flip { background: rgba(210,168,57,0.15); color: #d2a839; }

  /* ── Profile Annotations ── */
  .profile-annotation { position: absolute; right: 4px; font-size: 9px; font-weight: 700; padding: 1px 4px; border-radius: 3px; }
  .profile-row { position: relative; }
  .profile-row.wall-call { border-right: 3px solid var(--cyan); }
  .profile-row.wall-put { border-right: 3px solid var(--red); }
  .profile-row.flip-row { border-right: 3px solid #d2a839; }
  .profile-agg-line { position: absolute; top: 0; width: 2px; height: 100%; background: #d2a839; z-index: 2; pointer-events: none; }

  /* ── Footer ── */
  .footer { padding: 6px 20px; font-size: 10px; color: var(--text-muted); background: var(--bg2); border-top: 1px solid var(--border); display: flex; justify-content: space-between; }
</style>
</head>
<body>

<!-- Top Bar -->
<div class="topbar">
  <h1><span>GAMMA</span> HEATMAP</h1>
  <input type="text" class="ticker-input" id="tickerInput" value="SPY" placeholder="TICKER" maxlength="6" />
  <button class="btn" id="loadBtn" onclick="loadTicker()">Load</button>
  <div class="separator"></div>

  <div class="view-tabs">
    <button class="view-tab active" data-view="heatmap" onclick="setView('heatmap')">Heatmap</button>
    <button class="view-tab" data-view="split" onclick="setView('split')">Split</button>
    <button class="view-tab" data-view="profile" onclick="setView('profile')">Profile</button>
  </div>
  <div class="separator"></div>

  <div class="control-group">
    <span class="control-label">Range</span>
    <input type="range" class="range-input" id="rangeSlider" min="5" max="40" value="20" oninput="updateRange(this.value)" />
    <span class="range-val" id="rangeVal">±20</span>
  </div>
  <div class="separator"></div>

  <div class="control-group">
    <span class="control-label">Refresh</span>
    <button class="btn" data-interval="0" onclick="setInterval_(0)">Off</button>
    <button class="btn" data-interval="30" onclick="setInterval_(30)">30s</button>
    <button class="btn active" data-interval="60" onclick="setInterval_(60)">1m</button>
    <button class="btn" data-interval="120" onclick="setInterval_(120)">2m</button>
  </div>

  <div style="margin-left:auto;display:flex;align-items:center;gap:10px">
    <span class="spot-badge" id="spotBadge">—</span>
    <span class="key-levels" id="keyLevels"></span>
    <button class="btn live" id="liveBtn" onclick="toggleLive()">
      <span class="status-dot off" id="liveDot"></span> LIVE
    </button>
  </div>
</div>

<!-- Expiration Chips -->
<div class="exp-bar" id="expBar">
  <span class="exp-label">Expirations:</span>
</div>

<!-- Main Content -->
<div class="main with-exp-bar" id="mainArea">
  <div class="heatmap-wrap" id="heatmapWrap">
    <div class="loading" id="loadingIndicator">
      <div class="spinner"></div>
      <div style="color:var(--text-dim);font-size:13px">Enter a ticker and click Load</div>
    </div>
    <table class="heatmap-table" id="heatmapTable" style="display:none"></table>
  </div>
  <div class="profile-panel" id="profilePanel">
    <div class="profile-title">GEX Profile</div>
    <div class="profile-bars" id="profileBars"></div>
  </div>
</div>

<!-- Tooltip -->
<div class="tooltip" id="tooltip"></div>

<!-- Footer -->
<div class="footer">
  <span id="footerLeft">GEX = OI × Gamma × 100 × Spot | Data: Yahoo Finance</span>
  <span id="footerRight">—</span>
</div>

<script>
// ── State ──
let state = {
  ticker: 'SPY',
  data: null,
  selectedExps: [],     // indices into data.expirations
  allExps: [],
  view: 'heatmap',      // 'heatmap' | 'split' | 'profile'
  range: 20,
  refreshInterval: 60,  // seconds, 0 = off
  live: false,
  eventSource: null,
  refreshTimer: null,
};

// ── Init ──
document.getElementById('tickerInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') loadTicker();
});

// ── Load Ticker ──
async function loadTicker() {
  const input = document.getElementById('tickerInput');
  const ticker = input.value.trim().toUpperCase().replace(/[^A-Z0-9.]/g, '');
  if (!ticker) return;

  input.value = ticker;
  state.ticker = ticker;

  // If live is on, let SSE handle the initial fetch (avoids double-fetch)
  if (state.live) {
    showLoading('Connecting live stream...');
    startSSE();
    return;
  }

  showLoading('Fetching gamma data...');

  try {
    const url = '/api/gex/heatmap/' + ticker + '?range=' + state.range;
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) throw new Error(data.error);

    state.data = data;
    state.allExps = data.expirations.map((e, i) => i);
    state.selectedExps = [...state.allExps];

    renderExpChips();
    renderAll();
    updateSpotBadge();
    updateFooter();

    // Start auto-refresh
    if (state.refreshInterval > 0) startAutoRefresh();

  } catch (err) {
    showError(err.message);
  }
}

// ── Rendering ──

function renderAll() {
  if (!state.data) return;
  renderHeatmap();
  renderProfile();
}

function renderHeatmap() {
  const { data, selectedExps } = state;
  if (!data) return;

  const table = document.getElementById('heatmapTable');
  const loading = document.getElementById('loadingIndicator');

  const visibleExps = selectedExps.map(i => data.expirations[i]).filter(Boolean);
  if (visibleExps.length === 0) {
    table.style.display = 'none';
    loading.style.display = 'flex';
    loading.innerHTML = '<div style="color:var(--text-dim);font-size:13px">Select at least one expiration</div>';
    return;
  }

  // Find max abs GEX among visible expirations for color scaling
  let maxAbs = 0;
  for (const row of data.grid) {
    for (const idx of selectedExps) {
      const v = row.values[idx];
      if (v && Math.abs(v.net) > maxAbs) maxAbs = Math.abs(v.net);
    }
  }

  // Find spot row
  const spotStrikeIdx = data.strikes.reduce((best, s, i) =>
    Math.abs(s - data.spotPrice) < Math.abs(data.strikes[best] - data.spotPrice) ? i : best, 0);

  // Build table
  let html = '<thead><tr><th class="strike-col">Strike</th>';
  for (const exp of visibleExps) {
    html += '<th>' + exp.date + '</th>';
  }
  html += '</tr></thead><tbody>';

  for (let r = 0; r < data.grid.length; r++) {
    const row = data.grid[r];
    const isSpot = r === spotStrikeIdx;
    html += '<tr class="' + (isSpot ? 'spot-row' : '') + '">';
    html += '<td class="strike-cell">' + row.strike + '</td>';

    for (const idx of selectedExps) {
      const v = row.values[idx];
      if (!v || v.net === 0) {
        html += '<td></td>';
        continue;
      }

      const intensity = maxAbs > 0 ? Math.min(Math.abs(v.net) / maxAbs, 1) : 0;
      const alpha = Math.pow(intensity, 0.55) * 0.85;
      const isPos = v.net >= 0;
      const r_ = isPos ? 57 : 248;
      const g_ = isPos ? 210 : 81;
      const b_ = isPos ? 192 : 73;
      const bg = 'rgba(' + r_ + ',' + g_ + ',' + b_ + ',' + alpha.toFixed(3) + ')';
      const textColor = intensity > 0.25 ? 'var(--text)' : 'var(--text-dim)';
      const display = fmtGEX(v.net);

      html += '<td style="background:' + bg + ';color:' + textColor + '"'
        + ' data-r="' + r + '" data-c="' + idx + '"'
        + ' onmouseenter="showTip(event,' + r + ',' + idx + ')"'
        + ' onmouseleave="hideTip()"'
        + '>' + display + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody>';

  table.innerHTML = html;
  table.style.display = '';
  loading.style.display = 'none';
}

function renderProfile() {
  const panel = document.getElementById('profilePanel');
  const bars = document.getElementById('profileBars');
  if (!state.data) return;

  const { data, selectedExps } = state;

  // Aggregate profile across selected expirations
  const profile = data.strikes.map((strike, si) => {
    let net = 0;
    for (const idx of selectedExps) {
      const v = data.grid[si].values[idx];
      if (v) net += v.net;
    }
    return { strike, net };
  });

  const maxAbs = Math.max(...profile.map(p => Math.abs(p.net)), 1);
  const spotStrikeIdx = data.strikes.reduce((best, s, i) =>
    Math.abs(s - data.spotPrice) < Math.abs(data.strikes[best] - data.spotPrice) ? i : best, 0);

  // Find wall/flip rows for annotation
  const cwStrike = data.callWall?.strike;
  const pwStrike = data.putWall?.strike;
  const flipStrike = data.gammaFlip;

  let html = '';
  for (let i = 0; i < profile.length; i++) {
    const p = profile[i];
    const isSpot = i === spotStrikeIdx;
    const pct = (Math.abs(p.net) / maxAbs * 50).toFixed(1);
    const isPos = p.net >= 0;

    // Determine row annotations
    const isCallWall = cwStrike && p.strike === cwStrike;
    const isPutWall = pwStrike && p.strike === pwStrike;
    const isFlipRow = flipStrike && i > 0 && profile[i-1].strike <= flipStrike && p.strike >= flipStrike;
    let rowClass = 'profile-row';
    if (isSpot) rowClass += ' spot';
    if (isCallWall) rowClass += ' wall-call';
    if (isPutWall) rowClass += ' wall-put';
    if (isFlipRow) rowClass += ' flip-row';

    html += '<div class="' + rowClass + '">';
    html += '<span class="profile-strike" style="' + (isSpot ? 'color:var(--accent);font-weight:700' : '') + '">' + p.strike + '</span>';
    html += '<div class="profile-bar-wrap"><div class="profile-center"></div>';

    if (isPos) {
      html += '<div class="profile-bar positive" style="width:' + pct + '%;margin-left:calc(50% + 1px)"></div>';
    } else {
      html += '<div class="profile-bar negative" style="width:' + pct + '%;position:absolute;right:50%"></div>';
    }

    html += '</div>';
    html += '<span class="profile-val" style="color:' + (isPos ? 'var(--cyan)' : 'var(--red)') + '">' + fmtGEX(p.net) + '</span>';

    // Annotation labels
    if (isCallWall) html += '<span class="profile-annotation" style="background:var(--cyan-dim);color:var(--cyan);top:2px">CALL WALL</span>';
    if (isPutWall) html += '<span class="profile-annotation" style="background:var(--red-dim);color:var(--red);top:2px">PUT WALL</span>';
    if (isFlipRow) html += '<span class="profile-annotation" style="background:rgba(210,168,57,0.15);color:#d2a839;bottom:2px">FLIP</span>';

    html += '</div>';
  }

  bars.innerHTML = html;
}

// ── Expiration Chips ──

function renderExpChips() {
  const bar = document.getElementById('expBar');
  if (!state.data) return;

  let html = '<span class="exp-label">Expirations:</span>';
  html += '<span class="exp-chip' + (state.selectedExps.length === state.allExps.length ? ' active' : '') + '" onclick="toggleAllExps()">ALL</span>';

  for (let i = 0; i < state.data.expirations.length; i++) {
    const exp = state.data.expirations[i];
    const active = state.selectedExps.includes(i);
    const gexLabel = fmtGEX(exp.totalGEX);
    const gexColor = exp.totalGEX >= 0 ? 'var(--cyan)' : 'var(--red)';
    html += '<span class="exp-chip' + (active ? ' active' : '') + '" onclick="toggleExp(' + i + ')">'
      + exp.date + ' <span style="color:' + gexColor + ';margin-left:4px">' + gexLabel + '</span></span>';
  }

  bar.innerHTML = html;
}

function toggleExp(idx) {
  const pos = state.selectedExps.indexOf(idx);
  if (pos >= 0) {
    if (state.selectedExps.length <= 1) return; // keep at least 1
    state.selectedExps.splice(pos, 1);
  } else {
    state.selectedExps.push(idx);
    state.selectedExps.sort((a, b) => a - b);
  }
  renderExpChips();
  renderAll();
}

function toggleAllExps() {
  if (state.selectedExps.length === state.allExps.length) {
    state.selectedExps = [0]; // select only first
  } else {
    state.selectedExps = [...state.allExps];
  }
  renderExpChips();
  renderAll();
}

// ── View Switching ──

function setView(view) {
  state.view = view;
  document.querySelectorAll('.view-tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));

  const heatWrap = document.getElementById('heatmapWrap');
  const profPanel = document.getElementById('profilePanel');

  if (view === 'heatmap') {
    heatWrap.style.display = ''; profPanel.classList.remove('show');
  } else if (view === 'profile') {
    heatWrap.style.display = 'none'; profPanel.classList.add('show'); profPanel.style.width = '100%';
  } else { // split
    heatWrap.style.display = ''; profPanel.classList.add('show'); profPanel.style.width = '350px';
  }
  renderAll();
}

// ── Range ──

function updateRange(val) {
  state.range = parseInt(val);
  document.getElementById('rangeVal').textContent = '±' + val;
}

document.getElementById('rangeSlider').addEventListener('change', () => {
  loadTicker(); // reload with new range
});

// ── Refresh Interval ──

function setInterval_(sec) {
  state.refreshInterval = sec;
  document.querySelectorAll('[data-interval]').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.interval) === sec);
  });

  clearAutoRefresh();
  if (state.live) {
    // Reconnect SSE with updated interval so the change takes effect immediately
    startSSE();
  } else if (sec > 0) {
    startAutoRefresh();
  }
}

function startAutoRefresh() {
  clearAutoRefresh();
  if (state.refreshInterval <= 0) return;
  state.refreshTimer = setInterval(() => {
    if (!state.live) refreshData();
  }, state.refreshInterval * 1000);
}

function clearAutoRefresh() {
  if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = null; }
}

async function refreshData() {
  if (!state.ticker) return;
  try {
    const url = '/api/gex/heatmap/' + state.ticker + '?range=' + state.range
      + (state.selectedExps.length < state.allExps.length
        ? '&expirations=' + state.selectedExps.map(i => state.data.expirations[i].date).join(',')
        : '');
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) return;

    // Preserve expiration selection
    const oldDates = state.selectedExps.map(i => state.data.expirations[i]?.date);
    state.data = data;
    state.allExps = data.expirations.map((_, i) => i);
    state.selectedExps = data.expirations.map((e, i) => oldDates.includes(e.date) ? i : -1).filter(i => i >= 0);
    if (state.selectedExps.length === 0) state.selectedExps = [...state.allExps];

    renderExpChips();
    renderAll();
    updateSpotBadge();
    updateFooter();
  } catch { /* silent */ }
}

// ── SSE Live Mode ──

function toggleLive() {
  state.live = !state.live;
  const btn = document.getElementById('liveBtn');
  const dot = document.getElementById('liveDot');

  if (state.live) {
    btn.classList.add('active');
    dot.classList.replace('off', 'live');
    clearAutoRefresh();
    refreshData();  // Immediate update so heatmap refreshes NOW
    startSSE();     // Then SSE takes over for subsequent live updates
  } else {
    btn.classList.remove('active');
    dot.classList.replace('live', 'off');
    stopSSE();
    refreshData();  // Immediate update so user doesn't wait for next poll
    if (state.refreshInterval > 0) startAutoRefresh();
  }
}

function startSSE() {
  stopSSE();
  if (!state.ticker) return;

  const interval = Math.max(state.refreshInterval, 30);
  const url = '/api/gex/heatmap/' + state.ticker + '/stream?range=' + state.range + '&interval=' + interval;
  state.eventSource = new EventSource(url);

  state.eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.error) return;

      const oldDates = state.selectedExps.map(i => state.data?.expirations[i]?.date).filter(Boolean);
      state.data = data;
      state.allExps = data.expirations.map((_, i) => i);

      if (oldDates.length > 0) {
        state.selectedExps = data.expirations.map((e, i) => oldDates.includes(e.date) ? i : -1).filter(i => i >= 0);
      }
      if (state.selectedExps.length === 0) state.selectedExps = [...state.allExps];

      renderExpChips();
      renderAll();
      updateSpotBadge();
      updateFooter();
    } catch { /* ignore parse errors */ }
  };

  state.eventSource.onerror = () => {
    // Auto-reconnect is built into EventSource
  };
}

function stopSSE() {
  if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
}

// ── Tooltip ──

function showTip(event, rowIdx, colIdx) {
  const { data } = state;
  if (!data) return;

  const row = data.grid[rowIdx];
  const v = row.values[colIdx];
  if (!v) return;

  const exp = data.expirations[colIdx];
  const tt = document.getElementById('tooltip');

  tt.innerHTML = '<div class="tt-title">$' + row.strike + ' — ' + exp.date + '</div>'
    + '<div class="tt-row"><span class="tt-label">Net GEX</span><span class="tt-val ' + (v.net >= 0 ? 'tt-pos' : 'tt-neg') + '">' + fmtGEXFull(v.net) + '</span></div>'
    + '<div class="tt-row"><span class="tt-label">Call GEX</span><span class="tt-val tt-pos">' + fmtGEXFull(v.call) + '</span></div>'
    + '<div class="tt-row"><span class="tt-label">Put GEX</span><span class="tt-val tt-neg">' + fmtGEXFull(v.put) + '</span></div>'
    + '<div class="tt-row"><span class="tt-label">Call OI</span><span class="tt-val">' + v.callOI.toLocaleString() + '</span></div>'
    + '<div class="tt-row"><span class="tt-label">Put OI</span><span class="tt-val">' + v.putOI.toLocaleString() + '</span></div>';

  tt.classList.add('show');

  const rect = event.target.getBoundingClientRect();
  let left = rect.right + 10;
  let top = rect.top;
  if (left + 260 > window.innerWidth) left = rect.left - 270;
  if (top + 150 > window.innerHeight) top = window.innerHeight - 160;
  tt.style.left = left + 'px';
  tt.style.top = Math.max(0, top) + 'px';
}

function hideTip() {
  document.getElementById('tooltip').classList.remove('show');
}

// ── UI Helpers ──

function updateSpotBadge() {
  if (!state.data) return;
  document.getElementById('spotBadge').textContent = state.data.ticker + ' $' + state.data.spotPrice.toFixed(2);

  // Key levels badges
  const kl = document.getElementById('keyLevels');
  let html = '';
  if (state.data.callWall) html += '<span class="kl-badge kl-call">Call Wall $' + state.data.callWall.strike + '</span>';
  if (state.data.putWall) html += '<span class="kl-badge kl-put">Put Wall $' + state.data.putWall.strike + '</span>';
  if (state.data.gammaFlip) html += '<span class="kl-badge kl-flip">Flip $' + state.data.gammaFlip + '</span>';
  kl.innerHTML = html;
}

function updateFooter() {
  if (!state.data) return;
  const src = state.data.source || 'Yahoo';
  document.getElementById('footerLeft').textContent =
    'GEX = OI \\u00d7 Gamma \\u00d7 100 \\u00d7 Spot | Data: ' + src
    + (src === 'Tradier' ? ' (ORATS real greeks)' : src === 'Public.com' ? ' (real greeks)' : src.includes('LIVE') ? ' (OPRA live)' : ' (Black-Scholes est.)');
  document.getElementById('footerRight').textContent =
    'Updated: ' + new Date(state.data.timestamp).toLocaleTimeString() + ' | '
    + state.data.expirations.length + ' expirations | '
    + state.data.strikes.length + ' strikes';
}

function showLoading(msg) {
  const el = document.getElementById('loadingIndicator');
  el.innerHTML = '<div class="spinner"></div><div style="color:var(--text-dim);font-size:13px">' + (msg || 'Loading...') + '</div>';
  el.style.display = 'flex';
  document.getElementById('heatmapTable').style.display = 'none';
}

function showError(msg) {
  const el = document.getElementById('loadingIndicator');
  el.innerHTML = '<div class="error-msg">' + msg + '</div>';
  el.style.display = 'flex';
  document.getElementById('heatmapTable').style.display = 'none';
}

function fmtGEX(val) {
  if (!val || val === 0) return '';
  const abs = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (abs >= 1e9) return sign + (abs/1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return sign + (abs/1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return sign + (abs/1e3).toFixed(0) + 'K';
  if (abs >= 1) return sign + abs.toFixed(0);
  return '';
}

function fmtGEXFull(val) {
  if (!val || val === 0) return '$0';
  const abs = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (abs >= 1e9) return sign + '$' + (abs/1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return sign + '$' + (abs/1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return sign + '$' + (abs/1e3).toFixed(1) + 'K';
  return sign + '$' + abs.toFixed(0);
}
</script>
</body>
</html>`;
}

module.exports = { registerGEXHeatmapRoutes };
