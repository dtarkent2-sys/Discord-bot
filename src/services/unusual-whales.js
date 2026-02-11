/**
 * Unusual Whales — Options flow, dark pool, congress trades, institutional data,
 * short interest, GEX, market tide, and more.
 *
 * API Base: https://api.unusualwhales.com
 * Auth: Bearer token via Authorization header
 * Rate limit: 30s timeout per request, standard rate limits apply
 *
 * This service wraps the highest-value endpoints for a trading Discord bot:
 *   - Flow alerts (unusual options activity)
 *   - Dark pool prints
 *   - Congress & insider trades
 *   - Short interest / FTDs
 *   - GEX / spot exposures
 *   - Market tide & SPIKE
 *   - Earnings with expected moves
 */

const config = require('../config');
const log = require('../logger')('UW');

const BASE_URL = 'https://api.unusualwhales.com';
const FETCH_TIMEOUT = 20000;

// In-memory cache (most UW data doesn't change second-by-second)
const cache = new Map();
const CACHE_TTL = 90_000; // 90 seconds

class UnusualWhalesService {
  constructor() {
    this._token = config.unusualWhalesApiKey || '';
    if (this._token) {
      log.info('Unusual Whales API key configured');
    } else {
      log.warn('UNUSUAL_WHALES_API_KEY not set — UW features disabled');
    }
  }

  get enabled() {
    return !!this._token;
  }

  // ── Core Fetch ─────────────────────────────────────────────────────

  async _fetch(path, params = {}) {
    if (!this.enabled) throw new Error('Unusual Whales API key not configured. Set UNUSUAL_WHALES_API_KEY in .env');

    const url = new URL(`${BASE_URL}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v != null) {
        // Handle array params like issue_types[] and rule_name[]
        if (Array.isArray(v)) {
          for (const item of v) url.searchParams.append(k, String(item));
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const cacheKey = url.toString();
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return cached.data;
    }

    const res = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json, text/plain',
        Authorization: `Bearer ${this._token}`,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`UW ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json();
    cache.set(cacheKey, { data, ts: Date.now() });
    return data;
  }

  // ── OPTIONS FLOW ───────────────────────────────────────────────────

  /**
   * Get unusual options flow alerts — the core UW feature.
   * Filters for significant/unusual trades.
   */
  async getFlowAlerts({ ticker, minPremium = 100000, minDte = 1, limit = 25, isCall, isPut, isSweep } = {}) {
    const params = {
      'issue_types[]': ['Common Stock'],
      min_premium: minPremium,
      min_dte: minDte,
      limit,
    };
    if (ticker) params.ticker_symbol = ticker.toUpperCase();
    if (isCall != null) params.is_call = isCall;
    if (isPut != null) params.is_put = isPut;
    if (isSweep != null) params.is_sweep = isSweep;

    return this._fetch('/api/option-trades/flow-alerts', params);
  }

  /**
   * Get flow alerts for a specific ticker (via the stock endpoint).
   */
  async getTickerFlow(ticker) {
    return this._fetch(`/api/stock/${encodeURIComponent(ticker.toUpperCase())}/flow-alerts`);
  }

  /**
   * Get recent flow for a ticker.
   */
  async getTickerFlowRecent(ticker) {
    return this._fetch(`/api/stock/${encodeURIComponent(ticker.toUpperCase())}/flow-recent`);
  }

  // ── DARK POOL ──────────────────────────────────────────────────────

  /**
   * Get dark pool prints for a specific ticker.
   */
  async getDarkPool(ticker, { limit = 50, date, minPremium, minSize } = {}) {
    const params = { limit };
    if (date) params.date = date;
    if (minPremium) params.min_premium = minPremium;
    if (minSize) params.min_size = minSize;

    return this._fetch(`/api/darkpool/${encodeURIComponent(ticker.toUpperCase())}`, params);
  }

  /**
   * Get recent dark pool prints across all tickers.
   */
  async getDarkPoolRecent({ limit = 50, minPremium = 500000 } = {}) {
    return this._fetch('/api/darkpool/recent', { limit, min_premium: minPremium });
  }

  // ── CONGRESS ───────────────────────────────────────────────────────

  /**
   * Recent congressional trades.
   */
  async getCongressTrades({ ticker, limit = 25 } = {}) {
    const params = { limit };
    if (ticker) params.ticker = ticker.toUpperCase();
    return this._fetch('/api/congress/recent-trades', params);
  }

  // ── INSIDER ────────────────────────────────────────────────────────

  /**
   * Insider transactions for a ticker.
   */
  async getInsiderTrades(ticker) {
    return this._fetch(`/api/insider/${encodeURIComponent(ticker.toUpperCase())}`);
  }

  /**
   * Market-wide insider buy/sell summary.
   */
  async getInsiderBuySells() {
    return this._fetch('/api/market/insider-buy-sells');
  }

  // ── INSTITUTIONS ───────────────────────────────────────────────────

  /**
   * Institutional ownership for a ticker.
   */
  async getInstitutionalOwnership(ticker) {
    return this._fetch(`/api/institution/${encodeURIComponent(ticker.toUpperCase())}/ownership`);
  }

  // ── SHORTS ─────────────────────────────────────────────────────────

  /**
   * Short data for a ticker (interest, volume, ratio).
   */
  async getShortData(ticker) {
    return this._fetch(`/api/shorts/${encodeURIComponent(ticker.toUpperCase())}/data`);
  }

  /**
   * Failures to deliver.
   */
  async getFTDs(ticker) {
    return this._fetch(`/api/shorts/${encodeURIComponent(ticker.toUpperCase())}/ftds`);
  }

  /**
   * Short interest and float.
   */
  async getShortInterest(ticker) {
    return this._fetch(`/api/shorts/${encodeURIComponent(ticker.toUpperCase())}/interest-float`);
  }

  // ── GREEKS / GEX ──────────────────────────────────────────────────

  /**
   * Spot exposures (GEX, DEX, etc.) for a ticker.
   */
  async getSpotExposures(ticker) {
    return this._fetch(`/api/stock/${encodeURIComponent(ticker.toUpperCase())}/spot-exposures`);
  }

  /**
   * Spot exposures by strike.
   */
  async getSpotExposuresByStrike(ticker) {
    return this._fetch(`/api/stock/${encodeURIComponent(ticker.toUpperCase())}/spot-exposures/strike`);
  }

  /**
   * Greek exposure breakdown.
   */
  async getGreekExposure(ticker) {
    return this._fetch(`/api/stock/${encodeURIComponent(ticker.toUpperCase())}/greek-exposure`);
  }

  /**
   * Max pain calculation.
   */
  async getMaxPain(ticker) {
    return this._fetch(`/api/stock/${encodeURIComponent(ticker.toUpperCase())}/max-pain`);
  }

  /**
   * Net premium ticks with volumes and net delta.
   */
  async getNetPremTicks(ticker) {
    return this._fetch(`/api/stock/${encodeURIComponent(ticker.toUpperCase())}/net-prem-ticks`);
  }

  /**
   * OI change data.
   */
  async getOIChange(ticker) {
    return this._fetch(`/api/stock/${encodeURIComponent(ticker.toUpperCase())}/oi-change`);
  }

  // ── MARKET OVERVIEW ────────────────────────────────────────────────

  /**
   * Market tide — overall market sentiment indicator.
   */
  async getMarketTide() {
    return this._fetch('/api/market/market-tide');
  }

  /**
   * SPIKE volatility indicator.
   */
  async getSpike() {
    return this._fetch('/api/market/spike');
  }

  /**
   * Sector tide for a specific sector.
   */
  async getSectorTide(sector) {
    return this._fetch(`/api/market/${encodeURIComponent(sector)}/sector-tide`);
  }

  /**
   * Market-wide OI change.
   */
  async getMarketOIChange() {
    return this._fetch('/api/market/oi-change');
  }

  /**
   * Total options volume market-wide.
   */
  async getTotalOptionsVolume() {
    return this._fetch('/api/market/total-options-volume');
  }

  /**
   * Sector ETF data.
   */
  async getSectorETFs() {
    return this._fetch('/api/market/sector-etfs');
  }

  // ── EARNINGS ───────────────────────────────────────────────────────

  /**
   * Upcoming earnings (premarket or afterhours).
   */
  async getEarnings(timing = 'premarket', { date, limit = 20 } = {}) {
    const params = { limit };
    if (date) params.date = date;
    return this._fetch(`/api/earnings/${timing}`, params);
  }

  /**
   * Historical earnings for a ticker.
   */
  async getTickerEarnings(ticker) {
    return this._fetch(`/api/earnings/${encodeURIComponent(ticker.toUpperCase())}`);
  }

  // ── STOCK INFO ─────────────────────────────────────────────────────

  /**
   * Stock info (sector, market cap, etc.).
   */
  async getStockInfo(ticker) {
    return this._fetch(`/api/stock/${encodeURIComponent(ticker.toUpperCase())}/info`);
  }

  /**
   * Current stock state (price, volume, prev close).
   */
  async getStockState(ticker) {
    return this._fetch(`/api/stock/${encodeURIComponent(ticker.toUpperCase())}/stock-state`);
  }

  /**
   * IV rank for a ticker.
   */
  async getIVRank(ticker) {
    return this._fetch(`/api/stock/${encodeURIComponent(ticker.toUpperCase())}/iv-rank`);
  }

  /**
   * Volatility stats.
   */
  async getVolatilityStats(ticker) {
    return this._fetch(`/api/stock/${encodeURIComponent(ticker.toUpperCase())}/volatility/stats`);
  }

  // ── SEASONALITY ────────────────────────────────────────────────────

  /**
   * Monthly seasonality for a ticker.
   */
  async getSeasonality(ticker) {
    return this._fetch(`/api/seasonality/${encodeURIComponent(ticker.toUpperCase())}/monthly`);
  }

  // ── NEWS ───────────────────────────────────────────────────────────

  /**
   * Financial news headlines.
   */
  async getNews({ limit = 20, search, majorOnly } = {}) {
    const params = { limit };
    if (search) params.search_term = search;
    if (majorOnly) params.major_only = true;
    return this._fetch('/api/news/headlines', params);
  }

  // ── DISCORD FORMATTERS ─────────────────────────────────────────────

  /**
   * Format flow alerts for Discord.
   */
  formatFlowForDiscord(data, ticker) {
    const alerts = data?.data || data || [];
    if (!Array.isArray(alerts) || alerts.length === 0) {
      return `**Options Flow${ticker ? ` — ${ticker}` : ''}**\nNo unusual flow detected.`;
    }

    const title = ticker
      ? `**Unusual Options Flow — ${ticker.toUpperCase()}**`
      : '**Unusual Options Flow — Market Wide**';

    const lines = [title, ''];

    for (const a of alerts.slice(0, 12)) {
      const sym = a.ticker_symbol || a.underlying_symbol || a.symbol || '???';
      const type = a.put_call === 'C' || a.is_call ? 'CALL' : a.put_call === 'P' || a.is_put ? 'PUT' : a.put_call || '?';
      const typeEmoji = type === 'CALL' ? '🟢' : type === 'PUT' ? '🔴' : '⚪';
      const sweep = a.is_sweep ? ' 🔥SWEEP' : '';
      const strike = a.strike != null ? `$${a.strike}` : '';
      const expiry = a.expiry || a.expires || '';
      const premium = a.premium != null ? `$${Number(a.premium).toLocaleString()}` : '';
      const size = a.size || a.volume || '';
      const sentiment = a.sentiment || (a.is_ask_side ? 'Bullish' : a.is_bid_side ? 'Bearish' : '');
      const sentEmoji = sentiment === 'Bullish' ? '🐂' : sentiment === 'Bearish' ? '🐻' : '';

      lines.push(`${typeEmoji} **${sym}** ${strike} ${type} ${expiry}${sweep}`);
      lines.push(`   Premium: \`${premium}\` | Size: \`${size}\` ${sentEmoji} ${sentiment}`);
      lines.push('');
    }

    if (alerts.length > 12) {
      lines.push(`_...and ${alerts.length - 12} more alerts_`);
    }

    lines.push(`_Data via Unusual Whales | ${new Date().toLocaleString()}_`);

    let output = lines.join('\n');
    if (output.length > 1950) output = output.slice(0, 1950) + '\n...';
    return output;
  }

  /**
   * Format dark pool data for Discord.
   */
  formatDarkPoolForDiscord(data, ticker) {
    const prints = data?.data || data || [];
    if (!Array.isArray(prints) || prints.length === 0) {
      return `**Dark Pool — ${ticker}**\nNo dark pool prints found.`;
    }

    const lines = [`**Dark Pool Activity — ${ticker.toUpperCase()}**`, ''];

    // Aggregate stats
    let totalVolume = 0;
    let totalPremium = 0;
    let printCount = prints.length;

    for (const p of prints) {
      totalVolume += Number(p.size || p.volume || 0);
      totalPremium += Number(p.premium || 0);
    }

    lines.push(`**Summary:** \`${printCount}\` prints | \`${totalVolume.toLocaleString()}\` shares | \`$${(totalPremium / 1e6).toFixed(2)}M\` premium`);
    lines.push('');
    lines.push('**Largest Prints:**');

    // Sort by premium/size and show top prints
    const sorted = [...prints].sort((a, b) => (Number(b.premium || 0)) - (Number(a.premium || 0)));

    for (const p of sorted.slice(0, 8)) {
      const price = p.price ? `$${Number(p.price).toFixed(2)}` : '';
      const size = p.size || p.volume || '?';
      const premium = p.premium ? `$${Number(p.premium).toLocaleString()}` : '';
      const time = p.executed_at ? new Date(p.executed_at).toLocaleTimeString() : '';
      const nbboMid = (p.nbbo_ask && p.nbbo_bid) ? ((Number(p.nbbo_ask) + Number(p.nbbo_bid)) / 2).toFixed(2) : null;
      const aboveBelow = (nbboMid && p.price) ? (Number(p.price) >= nbboMid ? '🟢 Above mid' : '🔴 Below mid') : '';

      lines.push(`  ${price} x \`${Number(size).toLocaleString()}\` shares (\`${premium}\`) ${aboveBelow} ${time}`);
    }

    if (prints.length > 8) {
      lines.push(`  _...and ${prints.length - 8} more prints_`);
    }

    lines.push(`\n_Data via Unusual Whales | ${new Date().toLocaleString()}_`);

    let output = lines.join('\n');
    if (output.length > 1950) output = output.slice(0, 1950) + '\n...';
    return output;
  }

  /**
   * Format a combined "whales" dashboard for Discord.
   */
  formatWhalesDashboard(ticker, { flow, darkPool, shortData, insider } = {}) {
    const upper = ticker.toUpperCase();
    const lines = [`**Whale Activity Dashboard — ${upper}**`, ''];

    // Options flow summary
    const flowAlerts = flow?.data || flow || [];
    if (Array.isArray(flowAlerts) && flowAlerts.length > 0) {
      const calls = flowAlerts.filter(a => a.put_call === 'C' || a.is_call).length;
      const puts = flowAlerts.filter(a => a.put_call === 'P' || a.is_put).length;
      const sweeps = flowAlerts.filter(a => a.is_sweep).length;
      const totalPrem = flowAlerts.reduce((s, a) => s + Number(a.premium || 0), 0);
      const bias = calls > puts ? '🟢 CALL HEAVY' : puts > calls ? '🔴 PUT HEAVY' : '🟡 BALANCED';

      lines.push('**Options Flow:**');
      lines.push(`  ${bias} | Calls: \`${calls}\` Puts: \`${puts}\` | Sweeps: \`${sweeps}\``);
      lines.push(`  Total premium: \`$${(totalPrem / 1e6).toFixed(2)}M\``);

      // Top 3 flow alerts
      const topFlow = [...flowAlerts].sort((a, b) => Number(b.premium || 0) - Number(a.premium || 0)).slice(0, 3);
      for (const a of topFlow) {
        const type = a.put_call === 'C' || a.is_call ? 'CALL' : 'PUT';
        const emoji = type === 'CALL' ? '🟢' : '🔴';
        const sweep = a.is_sweep ? ' SWEEP' : '';
        lines.push(`  ${emoji} $${a.strike || '?'} ${type} ${a.expiry || ''} — $${Number(a.premium || 0).toLocaleString()}${sweep}`);
      }
      lines.push('');
    } else {
      lines.push('**Options Flow:** No unusual activity detected');
      lines.push('');
    }

    // Dark pool summary
    const dpPrints = darkPool?.data || darkPool || [];
    if (Array.isArray(dpPrints) && dpPrints.length > 0) {
      const totalDPVol = dpPrints.reduce((s, p) => s + Number(p.size || p.volume || 0), 0);
      const totalDPPrem = dpPrints.reduce((s, p) => s + Number(p.premium || 0), 0);

      lines.push('**Dark Pool:**');
      lines.push(`  \`${dpPrints.length}\` prints | \`${totalDPVol.toLocaleString()}\` shares | \`$${(totalDPPrem / 1e6).toFixed(2)}M\``);
      lines.push('');
    } else {
      lines.push('**Dark Pool:** No recent prints');
      lines.push('');
    }

    // Short data
    const shorts = shortData?.data || shortData;
    if (shorts && !Array.isArray(shorts)) {
      const si = shorts.short_interest || shorts.shortInterest;
      const ratio = shorts.short_ratio || shorts.days_to_cover;
      const parts = [];
      if (si != null) parts.push(`SI: \`${typeof si === 'number' ? (si * 100).toFixed(1) + '%' : si}\``);
      if (ratio != null) parts.push(`Days to cover: \`${ratio}\``);
      if (parts.length > 0) {
        lines.push(`**Short Interest:** ${parts.join(' | ')}`);
        lines.push('');
      }
    } else if (Array.isArray(shorts) && shorts.length > 0) {
      const latest = shorts[0];
      const parts = [];
      if (latest.short_interest != null) parts.push(`SI: \`${latest.short_interest}\``);
      if (latest.days_to_cover != null) parts.push(`Days to cover: \`${latest.days_to_cover}\``);
      if (parts.length > 0) {
        lines.push(`**Short Interest:** ${parts.join(' | ')}`);
        lines.push('');
      }
    }

    // Insider trades
    const insiderTrades = insider?.data || insider || [];
    if (Array.isArray(insiderTrades) && insiderTrades.length > 0) {
      lines.push('**Insider Trades (recent):**');
      for (const t of insiderTrades.slice(0, 3)) {
        const name = t.full_name || t.insider_name || t.name || 'Unknown';
        const type = t.acquisition_or_disposition === 'A' ? '🟢 BUY' : t.acquisition_or_disposition === 'D' ? '🔴 SELL' : t.trade_type || '?';
        const shares = t.shares || t.number_of_shares || '?';
        const price = t.price_per_share ? `@ $${t.price_per_share}` : '';
        const date = t.filing_date || t.date || '';
        lines.push(`  ${type} ${name} — ${Number(shares).toLocaleString()} shares ${price} (${date})`);
      }
      lines.push('');
    }

    lines.push(`_Data via Unusual Whales | ${new Date().toLocaleString()}_`);

    let output = lines.join('\n');
    if (output.length > 1950) output = output.slice(0, 1950) + '\n...';
    return output;
  }

  /**
   * Format market tide for Discord (used by /macro integration).
   */
  formatMarketTideForDiscord(data) {
    const tide = data?.data || data;
    if (!tide) return '';

    const lines = ['**Market Tide (Options Sentiment):**'];

    if (Array.isArray(tide) && tide.length > 0) {
      const latest = tide[tide.length - 1];
      const callPrem = Number(latest.net_call_premium || 0);
      const putPrem = Number(latest.net_put_premium || 0);
      const net = callPrem - putPrem;
      const bias = net > 0 ? '🟢 CALL-DOMINANT' : net < 0 ? '🔴 PUT-DOMINANT' : '🟡 BALANCED';

      lines.push(`  ${bias}`);
      lines.push(`  Net Call Premium: \`$${(callPrem / 1e9).toFixed(2)}B\``);
      lines.push(`  Net Put Premium: \`$${(putPrem / 1e9).toFixed(2)}B\``);
      lines.push(`  Net Delta: \`$${(net / 1e9).toFixed(2)}B\``);
    } else if (tide && typeof tide === 'object') {
      // Single object format
      for (const [k, v] of Object.entries(tide)) {
        if (typeof v === 'number') {
          lines.push(`  ${k}: \`${v.toLocaleString()}\``);
        }
      }
    }

    return lines.join('\n');
  }

  // ── AI / DEEP ANALYSIS FORMATTERS ─────────────────────────────────

  /**
   * Fetch and format UW data for inclusion in TradingAgents prompts.
   * Returns a text block suitable for appending to market data.
   */
  async getEnrichmentForAnalysis(ticker) {
    if (!this.enabled) return '';

    const upper = ticker.toUpperCase();
    const sections = [];

    // Fetch multiple data sources in parallel
    const results = await Promise.allSettled([
      this.getTickerFlow(upper),
      this.getDarkPool(upper, { limit: 20 }),
      this.getShortInterest(upper),
      this.getInsiderTrades(upper),
      this.getIVRank(upper),
      this.getMaxPain(upper),
    ]);

    const [flowResult, dpResult, shortResult, insiderResult, ivResult, maxPainResult] = results;

    // Options flow
    if (flowResult.status === 'fulfilled') {
      const alerts = flowResult.value?.data || flowResult.value || [];
      if (Array.isArray(alerts) && alerts.length > 0) {
        const calls = alerts.filter(a => a.put_call === 'C' || a.is_call).length;
        const puts = alerts.filter(a => a.put_call === 'P' || a.is_put).length;
        const sweeps = alerts.filter(a => a.is_sweep).length;
        const totalPrem = alerts.reduce((s, a) => s + Number(a.premium || 0), 0);
        const bias = calls > puts * 1.5 ? 'HEAVILY BULLISH' : puts > calls * 1.5 ? 'HEAVILY BEARISH' : calls > puts ? 'LEAN BULLISH' : puts > calls ? 'LEAN BEARISH' : 'BALANCED';

        sections.push(`UNUSUAL OPTIONS FLOW (Unusual Whales):
  ${alerts.length} unusual trades detected | Calls: ${calls} | Puts: ${puts} | Sweeps: ${sweeps}
  Total unusual premium: $${(totalPrem / 1e6).toFixed(2)}M
  Flow bias: ${bias}
  Top trades:`);

        const top = [...alerts].sort((a, b) => Number(b.premium || 0) - Number(a.premium || 0)).slice(0, 5);
        for (const a of top) {
          const type = a.put_call === 'C' || a.is_call ? 'CALL' : 'PUT';
          const sweep = a.is_sweep ? ' [SWEEP]' : '';
          sections.push(`    $${a.strike || '?'} ${type} exp ${a.expiry || '?'} — $${Number(a.premium || 0).toLocaleString()}${sweep}`);
        }
      }
    }

    // Dark pool
    if (dpResult.status === 'fulfilled') {
      const prints = dpResult.value?.data || dpResult.value || [];
      if (Array.isArray(prints) && prints.length > 0) {
        const totalVol = prints.reduce((s, p) => s + Number(p.size || p.volume || 0), 0);
        const totalPrem = prints.reduce((s, p) => s + Number(p.premium || 0), 0);

        sections.push(`\nDARK POOL ACTIVITY (Unusual Whales):
  ${prints.length} off-exchange prints | ${totalVol.toLocaleString()} shares | $${(totalPrem / 1e6).toFixed(2)}M
  (High dark pool activity suggests institutional positioning)`);
      }
    }

    // Short interest
    if (shortResult.status === 'fulfilled') {
      const shorts = shortResult.value?.data || shortResult.value;
      if (shorts) {
        const si = Array.isArray(shorts) && shorts.length > 0 ? shorts[0] : shorts;
        const parts = [];
        if (si.short_interest != null) parts.push(`Short Interest: ${si.short_interest}`);
        if (si.shares_short != null) parts.push(`Shares Short: ${Number(si.shares_short).toLocaleString()}`);
        if (si.days_to_cover != null) parts.push(`Days to Cover: ${si.days_to_cover}`);
        if (si.short_percent_of_float != null) parts.push(`Short % of Float: ${si.short_percent_of_float}`);
        if (parts.length > 0) {
          sections.push(`\nSHORT INTEREST DATA (Unusual Whales):\n  ${parts.join(' | ')}`);
        }
      }
    }

    // Insider trades
    if (insiderResult.status === 'fulfilled') {
      const trades = insiderResult.value?.data || insiderResult.value || [];
      if (Array.isArray(trades) && trades.length > 0) {
        const buys = trades.filter(t => t.acquisition_or_disposition === 'A').length;
        const sells = trades.filter(t => t.acquisition_or_disposition === 'D').length;
        sections.push(`\nINSIDER TRADING (Unusual Whales):
  Recent insider activity: ${buys} buys, ${sells} sells`);
        for (const t of trades.slice(0, 3)) {
          const name = t.full_name || t.insider_name || 'Unknown';
          const type = t.acquisition_or_disposition === 'A' ? 'BUY' : 'SELL';
          const shares = t.shares || t.number_of_shares || '?';
          sections.push(`    ${type}: ${name} — ${Number(shares).toLocaleString()} shares (${t.filing_date || ''})`);
        }
      }
    }

    // IV rank
    if (ivResult.status === 'fulfilled') {
      const iv = ivResult.value?.data || ivResult.value;
      if (iv) {
        const rank = iv.iv_rank ?? iv.ivRank;
        const percentile = iv.iv_percentile ?? iv.ivPercentile;
        if (rank != null || percentile != null) {
          const parts = [];
          if (rank != null) parts.push(`IV Rank: ${typeof rank === 'number' ? (rank * 100).toFixed(0) + '%' : rank}`);
          if (percentile != null) parts.push(`IV Percentile: ${typeof percentile === 'number' ? (percentile * 100).toFixed(0) + '%' : percentile}`);
          sections.push(`\nIMPLIED VOLATILITY (Unusual Whales):\n  ${parts.join(' | ')}`);
        }
      }
    }

    // Max pain
    if (maxPainResult.status === 'fulfilled') {
      const mp = maxPainResult.value?.data || maxPainResult.value;
      if (mp) {
        const pain = Array.isArray(mp) ? mp[0]?.max_pain || mp[0]?.price : mp.max_pain || mp.price;
        if (pain != null) {
          sections.push(`\nMAX PAIN: $${pain}
  (Price level where option writers have minimum payout)`);
        }
      }
    }

    if (sections.length === 0) return '';
    return `=== UNUSUAL WHALES DATA ===\n${sections.join('\n')}`;
  }
}

module.exports = new UnusualWhalesService();
