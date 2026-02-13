'use strict';

/**
 * data-fetcher.js — Fetches historical intraday bars for backtesting.
 *
 * Supports two sources:
 *   1. yahoo-finance2 (free, already installed) — 1m/5m bars, up to 30 days back
 *   2. Polygon.io (API key required) — 1m bars, years of history
 *
 * Falls back gracefully: tries Yahoo first, then Polygon if available.
 */

const fs = require('fs');
const path = require('path');

// Cache directory for downloaded bars (avoid re-fetching)
const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'backtest-cache');

// ── Yahoo Finance fetcher ───────────────────────────────────────────

/**
 * Fetch intraday bars from Yahoo Finance.
 *
 * @param {string} symbol - Ticker (SPY, QQQ, IWM)
 * @param {string} date - Date string 'YYYY-MM-DD'
 * @param {object} [opts]
 * @param {'1m'|'5m'} [opts.interval='5m'] - Bar interval
 * @returns {Promise<object[]>} Array of { timestamp, open, high, low, close, volume }
 */
async function fetchBarsYahoo(symbol, date, opts = {}) {
  const { interval = '5m' } = opts;

  // Check cache first
  const cached = _loadCache(symbol, date, interval);
  if (cached) return cached;

  let yahooFinance;
  try {
    yahooFinance = require('yahoo-finance2').default;
  } catch {
    throw new Error('yahoo-finance2 not installed. Run: npm install yahoo-finance2');
  }

  const startDate = new Date(`${date}T09:30:00-05:00`); // 9:30 AM ET
  const endDate = new Date(`${date}T16:01:00-05:00`);   // 4:01 PM ET (inclusive)

  try {
    const result = await yahooFinance.chart(symbol, {
      period1: startDate,
      period2: endDate,
      interval,
    });

    if (!result?.quotes?.length) {
      throw new Error(`No bars returned for ${symbol} on ${date}`);
    }

    const bars = result.quotes
      .filter(q => q.close != null && q.volume != null)
      .map(q => ({
        timestamp: new Date(q.date).toISOString(),
        date: new Date(q.date),
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume,
      }));

    // Cache for future runs
    _saveCache(symbol, date, interval, bars);

    return bars;
  } catch (err) {
    throw new Error(`Yahoo fetch failed for ${symbol} ${date}: ${err.message}`);
  }
}

// ── Polygon.io fetcher ──────────────────────────────────────────────

/**
 * Fetch intraday bars from Polygon.io.
 * Requires POLYGON_API_KEY environment variable.
 *
 * @param {string} symbol - Ticker
 * @param {string} date - Date string 'YYYY-MM-DD'
 * @param {object} [opts]
 * @param {'1'|'5'} [opts.multiplier='5'] - Bar size in minutes
 * @returns {Promise<object[]>}
 */
async function fetchBarsPolygon(symbol, date, opts = {}) {
  const { multiplier = '5' } = opts;
  const apiKey = process.env.POLYGON_API_KEY;

  if (!apiKey) {
    throw new Error('POLYGON_API_KEY not set. Get a free key at https://polygon.io');
  }

  const cacheInterval = `${multiplier}m`;
  const cached = _loadCache(symbol, date, cacheInterval);
  if (cached) return cached;

  const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/${multiplier}/minute/${date}/${date}?adjusted=true&sort=asc&limit=5000&apiKey=${apiKey}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Polygon API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  if (!data.results?.length) {
    throw new Error(`No bars from Polygon for ${symbol} on ${date}`);
  }

  const bars = data.results.map(r => ({
    timestamp: new Date(r.t).toISOString(),
    date: new Date(r.t),
    open: r.o,
    high: r.h,
    low: r.l,
    close: r.c,
    volume: r.v,
  }));

  _saveCache(symbol, date, cacheInterval, bars);
  return bars;
}

// ── Unified fetcher with fallback ───────────────────────────────────

/**
 * Fetch historical intraday bars with automatic source fallback.
 *
 * @param {string} symbol - Ticker
 * @param {string} startDate - Start date 'YYYY-MM-DD'
 * @param {string} [endDate] - End date (defaults to startDate for single day)
 * @param {object} [opts]
 * @param {'1m'|'5m'} [opts.interval='5m']
 * @param {'yahoo'|'polygon'|'auto'} [opts.source='auto']
 * @returns {Promise<Map<string, object[]>>} Map of date → bars array
 */
async function fetchHistoricalBars(symbol, startDate, endDate, opts = {}) {
  const { interval = '5m', source = 'auto' } = opts;
  endDate = endDate || startDate;

  const dates = _getDateRange(startDate, endDate);
  const results = new Map();

  for (const date of dates) {
    let bars = null;

    if (source === 'yahoo' || source === 'auto') {
      try {
        bars = await fetchBarsYahoo(symbol, date, { interval });
      } catch (err) {
        if (source === 'yahoo') throw err;
        console.warn(`[backtest] Yahoo failed for ${symbol} ${date}: ${err.message}`);
      }
    }

    if (!bars && (source === 'polygon' || source === 'auto')) {
      try {
        const multiplier = interval === '1m' ? '1' : '5';
        bars = await fetchBarsPolygon(symbol, date, { multiplier });
      } catch (err) {
        console.warn(`[backtest] Polygon failed for ${symbol} ${date}: ${err.message}`);
      }
    }

    if (bars && bars.length > 0) {
      results.set(date, bars);
    } else {
      console.warn(`[backtest] No data for ${symbol} on ${date} — skipping (weekend/holiday?)`);
    }
  }

  return results;
}

// ── Cache helpers ───────────────────────────────────────────────────

function _getCachePath(symbol, date, interval) {
  return path.join(CACHE_DIR, `${symbol}_${date}_${interval}.json`);
}

function _loadCache(symbol, date, interval) {
  const cachePath = _getCachePath(symbol, date, interval);
  try {
    if (fs.existsSync(cachePath)) {
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if (data.length > 0) {
        // Restore Date objects
        return data.map(b => ({ ...b, date: new Date(b.timestamp) }));
      }
    }
  } catch {
    // Cache miss or corrupt — re-fetch
  }
  return null;
}

function _saveCache(symbol, date, interval, bars) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const cachePath = _getCachePath(symbol, date, interval);
    fs.writeFileSync(cachePath, JSON.stringify(bars, null, 2));
  } catch {
    // Non-fatal — caching is best-effort
  }
}

// ── Date range helper ───────────────────────────────────────────────

function _getDateRange(start, end) {
  const dates = [];
  const current = new Date(`${start}T12:00:00`);
  const last = new Date(`${end}T12:00:00`);

  while (current <= last) {
    const day = current.getDay();
    // Skip weekends
    if (day !== 0 && day !== 6) {
      dates.push(current.toISOString().slice(0, 10));
    }
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

module.exports = {
  fetchBarsYahoo,
  fetchBarsPolygon,
  fetchHistoricalBars,
};
