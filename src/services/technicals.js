const alpaca = require('./alpaca');

const alpacaBars = require('./alpaca-bars');

const alpacaHistory = require('./alpaca-history');

const yahoo = require('./yahoo');

const technicals = require('./technicals');

const discordify = require('./discordify');

const fs = require('fs');
const path = require('path');

class TechnicalsService {
  constructor() {
    this.cache = new Map();
    this.isInitialized = false;
  }

  async init() {
    if (this.isInitialized) return;
    this.isInitialized = true;
    await alpaca.init();
    await yahoo.init();
    await alpacaBars.init();
    await alpacaHistory.init();
    console.log('[Technicals] Service initialized');
  }

  /**
   * Fetch OHLCV bars with standardized shape
   * @param {string} symbol
   * @param {number} lookbackDays
   * @returns {Array<{t:string,o:number,h:number,l:number,c:number,v:number}>}
   */
  async fetchBars(symbol, lookbackDays = 250) {
    const key = `${symbol}-${lookbackDays}`;
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }

    // Try alpaca history (raw CSV -> bars)
    let bars;
    try {
      const raw = await alpacaHistory.getBars(symbol, lookbackDays);
      bars = raw.map(b => ({
        t: b.date,
        o: b.open,
        h: b.high,
        l: b.low,
        c: b.close,
        v: b.volume,
      }));
    } catch (e) {
      console.warn(`[Bars] alpaca-history failed for ${symbol}: ${e.message}`);
    }

    // Fallback to alpaca-bars (json -> bars)
    if (!bars || bars.length === 0) {
      try {
        const jsonBars = await alpacaBars.getBars(symbol, lookbackDays);
        bars = jsonBars.map(b => ({
          t: b.date,
          o: b.open,
          h: b.high,
          l: b.low,
          c: b.close,
          v: b.volume,
        }));
      } catch (e) {
        console.warn(`[Bars] alpaca-bars failed for ${symbol}: ${e.message}`);
      }
    }

    // Final fallback to yahoo
    if (!bars || bars.length === 0) {
      try {
        const yahooBars = await yahoo.getBars(symbol, lookbackDays);
        bars = yahooBars.map(b => ({
          t: b.date,
          o: b.open,
          h: b.high,
          l: b.low,
          c: b.close,
          v: b.volume,
        }));
      } catch (e) {
        console.warn(`[Bars] yahoo failed for ${symbol}: ${e.message}`);
      }
    }

    if (!bars || bars.length === 0) {
      throw new Error(`Failed to fetch price bars for ${symbol}`);
    }

    // Sort ascending oldest→newest
    bars.sort((a, b) => new Date(a.t) - new Date(b.t));
    this.cache.set(key, bars);
    return bars;
  }
}

module.exports = new TechnicalsService();