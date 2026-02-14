/**
 * Gamma Heat Map Renderer
 *
 * Generates a visual heat map of gamma exposure (GEX) across strikes and
 * expirations, rendered as a PNG image for Discord.
 *
 * Layout mirrors ITMatrixHQ-style gamma heat maps:
 *   - Rows = strike prices (centered around spot price)
 *   - Columns = expiration dates (0DTE, weekly, monthly, etc.)
 *   - Cell color = cyan intensity proportional to |GEX|
 *   - Cell text = GEX value in millions/thousands
 *   - Current price row highlighted
 *
 * Uses the raw canvas module (same dependency as the bar chart renderer).
 */

const path = require('path');
const gamma = require('./gamma');
let databentoLive = null;
try { databentoLive = require('./databento-live'); } catch { /* not available */ }
const tradier = require('./tradier');
const publicService = require('./public');
const priceFetcher = require('../tools/price-fetcher');
const alpaca = require('./alpaca');
const { bsGamma: _bsGamma, estimateIV: _estimateIV } = require('../lib/black-scholes');

// ── Canvas setup (mirrors gamma.js pattern) ──────────────────────────────

let createCanvas, registerFont, canvasAvailable = false;

try {
  const canvasModule = require('canvas');
  createCanvas = canvasModule.createCanvas;
  registerFont = canvasModule.registerFont;

  const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
  try {
    registerFont(path.join(FONT_DIR, 'Inter-Regular.ttf'), { family: 'Inter' });
    registerFont(path.join(FONT_DIR, 'Inter-Bold.ttf'), { family: 'Inter', weight: 'bold' });
  } catch { /* fonts already registered by gamma.js */ }

  canvasAvailable = true;
  console.log('[GammaHeatmap] Canvas loaded');
} catch (err) {
  console.warn('[GammaHeatmap] Canvas not available — heat map rendering disabled:', err.message);
}

// ── Constants ────────────────────────────────────────────────────────────

const FONT = 'Inter, sans-serif';
const BG_COLOR = '#0f1117';
const HEADER_BG = '#161b22';
const GRID_LINE = '#21262d';
const TEXT_DIM = '#8b949e';
const TEXT_BRIGHT = '#e6edf3';
const SPOT_ROW_BG = 'rgba(56, 139, 253, 0.15)';
const SPOT_BORDER = 'rgba(56, 139, 253, 0.6)';

// Cyan gradient for positive GEX (call-dominant)
const POS_COLOR = { r: 0, g: 200, b: 200 }; // cyan
// Red/magenta gradient for negative GEX (put-dominant)
const NEG_COLOR = { r: 220, g: 50, b: 80 }; // red-pink

// Layout
const ROW_HEADER_WIDTH = 80;
const COL_WIDTH = 120;
const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 60;  // title + column headers
const COL_HEADER_HEIGHT = 32;
const PADDING = 16;

class GammaHeatmapService {
  get enabled() {
    return canvasAvailable;
  }

  // ── Main entry: fetch data & render ─────────────────────────────────

  /**
   * Generate a gamma heat map for a ticker.
   *
   * @param {string} ticker
   * @param {object} [opts]
   * @param {number} [opts.strikeRange=20] - Number of strikes above/below spot
   * @param {string[]} [opts.expirations] - Explicit expiration dates (YYYY-MM-DD)
   * @returns {Promise<{ buffer: Buffer, spotPrice: number, source: string, expirations: string[] }>}
   */
  async generate(ticker, opts = {}) {
    if (!canvasAvailable) throw new Error('Canvas module not available — cannot render heat map.');

    const upper = ticker.toUpperCase();
    const strikeRange = opts.strikeRange || 20;

    // 1. Get spot price (source-independent — OPRA is options-only, always need equity quote)
    let spotPrice = null;
    if (tradier.enabled) {
      try {
        const q = await tradier.getQuote(upper);
        spotPrice = q.price;
      } catch { /* fallback */ }
    }
    if (!spotPrice && alpaca.enabled) {
      try {
        const snap = await alpaca.getSnapshot(upper);
        spotPrice = snap.price;
      } catch { /* fallback */ }
    }
    if (!spotPrice) {
      const pf = await priceFetcher.getCurrentPrice(upper);
      if (!pf.error) spotPrice = pf.price;
    }
    if (!spotPrice) throw new Error(`Could not determine spot price for ${upper}`);

    // 2. Build source priority list — try each in order with fallback
    // If a source has expirations but produces no usable chain data (e.g. OI=0), fall back to next
    const sourcesToTry = [];
    if (databentoLive && databentoLive.hasDataFor(upper)) sourcesToTry.push('DatabentoLive');
    if (tradier.enabled) sourcesToTry.push('Tradier');
    if (publicService.enabled) sourcesToTry.push('Public.com');
    sourcesToTry.push('Yahoo');
    if (sourcesToTry.length === 1) {
      console.warn('[GammaHeatmap] No premium sources configured — using Yahoo only. Set TRADIER_API_KEY for real greeks (free sandbox).');
    }

    let source = null;
    let expirationData = [];
    let allStrikes = new Set();
    let bestFallback = null; // Track best data if no source meets MIN_STRIKES

    for (const trySource of sourcesToTry) {
      // ── Get available expirations for this source ──
      let allExpDates = null;
      let yahooExps = null;

      try {
        if (trySource === 'DatabentoLive') {
          const dates = databentoLive.getExpirations(upper);
          if (dates.length > 0) allExpDates = dates;
        } else if (trySource === 'Tradier') {
          const dates = await tradier.getOptionExpirations(upper);
          if (dates.length > 0) allExpDates = dates;
        } else if (trySource === 'Public.com') {
          const dates = await publicService.getOptionExpirations(upper);
          if (dates && dates.length > 0) allExpDates = dates;
        } else {
          yahooExps = await gamma.fetchAvailableExpirations(upper);
          if (yahooExps.length > 0) allExpDates = yahooExps.map(e => e.date);
        }
      } catch (err) {
        console.warn(`[GammaHeatmap] ${trySource} expirations failed: ${err.message}`);
        continue;
      }

      if (!allExpDates || allExpDates.length === 0) continue;

      // Pick up to 6 nearest future expirations
      const today = new Date().toISOString().slice(0, 10);
      const futureExpDates = allExpDates.filter(d => d >= today).sort().slice(0, 6);
      if (futureExpDates.length === 0) continue;

      const targetExpDates = opts.expirations
        ? allExpDates.filter(d => opts.expirations.includes(d))
        : futureExpDates;
      if (targetExpDates.length === 0) continue;

      // ── Fetch options chain for each expiration and compute per-strike GEX ──
      expirationData = [];
      allStrikes = new Set();

      if (trySource === 'Yahoo') {
        // ── Yahoo: fetch all expirations in parallel for speed ──
        const fetchResults = await Promise.allSettled(targetExpDates.map(async (expDate) => {
          const expObj = yahooExps?.find(e => e.date === expDate);
          if (!expObj) return null;
          const result = await gamma._yahooFetch(upper, expObj.epoch);
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
          const strikeGEX = new Map();
          const strikes = [];
          for (const s of detailed.strikes) {
            strikeGEX.set(s.strike, s['netGEX$']);
            strikes.push(s.strike);
          }
          return { date: expDate, strikeGEX, totalGEX: detailed['totalNetGEX$'], strikes };
        }));

        for (const r of fetchResults) {
          if (r.status === 'fulfilled' && r.value && r.value.strikeGEX.size > 0) {
            expirationData.push({ date: r.value.date, strikeGEX: r.value.strikeGEX, totalGEX: r.value.totalGEX });
            for (const s of r.value.strikes) allStrikes.add(s);
          } else if (r.status === 'rejected') {
            console.warn(`[GammaHeatmap] Yahoo exp failed: ${r.reason?.message}`);
          }
        }
      } else {
        // ── Non-Yahoo sources: sequential (DatabentoLive is in-memory = fast) ──
        for (const expDate of targetExpDates) {
          try {
            let contracts;
            if (trySource === 'DatabentoLive') {
              contracts = databentoLive.getOptionsChain(upper, expDate);
            } else if (trySource === 'Tradier') {
              contracts = await tradier.getOptionsWithGreeks(upper, expDate);
            } else {
              contracts = await publicService.getOptionsWithGreeks(upper, expDate);
            }
            if (!contracts || contracts.length === 0) continue;

            const T = Math.max((new Date(expDate).getTime() - Date.now()) / (365.25 * 86400000), 1 / 365);

            const strikeGEX = new Map();
            let totalGEX = 0;
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
              const prev = strikeGEX.get(c.strike) || 0;
              const contribution = c.type === 'call' ? gex : -gex;
              strikeGEX.set(c.strike, prev + contribution);
              allStrikes.add(c.strike);
              totalGEX += contribution;
            }

            if (strikeGEX.size > 0) {
              expirationData.push({ date: expDate, strikeGEX, totalGEX });
            }
          } catch (err) {
            console.warn(`[GammaHeatmap] Skipping ${expDate}: ${err.message}`);
            if (err.name === 'TimeoutError' || err.message.includes('timeout')) break;
          }
        }
      }

      // Require a minimum number of strikes to consider a source usable —
      // DatabentoLive often has sparse OI early in the session which produces
      // a nearly-empty heatmap. Fall back to a richer source instead.
      const MIN_STRIKES = 10;
      if (expirationData.length > 0 && allStrikes.size >= MIN_STRIKES) {
        source = trySource;
        console.log(`[GammaHeatmap] Using ${trySource} for ${upper} (${expirationData.length} expirations, ${allStrikes.size} strikes)`);
        break; // Success — use this source
      }

      // Track best fallback in case no source meets MIN_STRIKES
      if (expirationData.length > 0 && allStrikes.size > 0 &&
          (!bestFallback || allStrikes.size > bestFallback.allStrikes.size)) {
        bestFallback = { source: trySource, expirationData: [...expirationData], allStrikes: new Set(allStrikes) };
      }

      console.warn(`[GammaHeatmap] ${trySource} had expirations but insufficient data (${expirationData.length} exps, ${allStrikes.size} strikes), falling back...`);
    }

    // If no source met MIN_STRIKES but we have some data, use the best available
    if (!source && bestFallback) {
      source = bestFallback.source;
      expirationData = bestFallback.expirationData;
      allStrikes = bestFallback.allStrikes;
      console.warn(`[GammaHeatmap] No source met MIN_STRIKES, using best fallback: ${source} (${expirationData.length} exps, ${allStrikes.size} strikes)`);
    }

    if (expirationData.length === 0) {
      throw new Error(`No options data available for ${upper}`);
    }

    // 4. Select strikes centered around spot price
    const sortedStrikes = [...allStrikes].sort((a, b) => a - b);
    const spotIdx = sortedStrikes.reduce((best, s, i) =>
      Math.abs(s - spotPrice) < Math.abs(sortedStrikes[best] - spotPrice) ? i : best, 0);

    const startIdx = Math.max(0, spotIdx - strikeRange);
    const endIdx = Math.min(sortedStrikes.length, spotIdx + strikeRange + 1);
    // Reverse so highest strike is on top (trader convention: calls on top, puts on bottom)
    const selectedStrikes = sortedStrikes.slice(startIdx, endIdx).reverse();

    if (selectedStrikes.length === 0) {
      throw new Error('No strikes near the current price.');
    }

    // 5. Build the data grid: grid[strikeIdx][expIdx] = GEX value
    const grid = [];
    let maxAbsGEX = 0;

    for (const strike of selectedStrikes) {
      const row = [];
      for (const exp of expirationData) {
        const val = exp.strikeGEX.get(strike) || 0;
        row.push(val);
        if (Math.abs(val) > maxAbsGEX) maxAbsGEX = Math.abs(val);
      }
      grid.push(row);
    }

    // 6. Render the heat map image
    const buffer = this._render(
      upper,
      spotPrice,
      selectedStrikes,
      expirationData.map(e => e.date),
      grid,
      maxAbsGEX,
    );

    return {
      buffer,
      spotPrice,
      source,
      expirations: expirationData.map(e => e.date),
    };
  }

  // ── Canvas renderer ─────────────────────────────────────────────────

  /**
   * Render the heat map to a PNG buffer.
   */
  _render(ticker, spotPrice, strikes, expirations, grid, maxAbsGEX) {
    const numCols = expirations.length;
    const numRows = strikes.length;

    // Calculate dimensions
    const titleHeight = 44;
    const colHeaderH = COL_HEADER_HEIGHT;
    const totalHeaderH = titleHeight + colHeaderH;
    const canvasWidth = ROW_HEADER_WIDTH + (numCols * COL_WIDTH) + PADDING * 2;
    const canvasHeight = totalHeaderH + (numRows * ROW_HEIGHT) + PADDING * 2 + 24; // +24 for footer

    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // ── Title bar ──
    ctx.fillStyle = HEADER_BG;
    ctx.fillRect(0, 0, canvasWidth, titleHeight);

    // Title text
    ctx.fillStyle = TEXT_BRIGHT;
    ctx.font = `bold 16px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${ticker}  GAMMA HEATMAP`, PADDING + 4, titleHeight / 2);

    // Spot price on right side of title
    ctx.textAlign = 'right';
    ctx.fillStyle = '#58a6ff';
    ctx.font = `bold 14px ${FONT}`;
    ctx.fillText(`Spot: $${spotPrice.toFixed(2)}`, canvasWidth - PADDING - 4, titleHeight / 2);

    // ── Column headers (expiration dates) ──
    const gridLeft = PADDING + ROW_HEADER_WIDTH;
    const gridTop = totalHeaderH;

    ctx.fillStyle = HEADER_BG;
    ctx.fillRect(0, titleHeight, canvasWidth, colHeaderH);

    // "STRIKE" label
    ctx.fillStyle = TEXT_DIM;
    ctx.font = `bold 11px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('STRIKE', PADDING + ROW_HEADER_WIDTH / 2, titleHeight + colHeaderH / 2);

    // Expiration date labels
    for (let c = 0; c < numCols; c++) {
      const x = gridLeft + c * COL_WIDTH + COL_WIDTH / 2;
      const y = titleHeight + colHeaderH / 2;
      ctx.fillStyle = TEXT_DIM;
      ctx.font = `bold 11px ${FONT}`;
      ctx.fillText(expirations[c], x, y);
    }

    // Header bottom border
    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, totalHeaderH);
    ctx.lineTo(canvasWidth, totalHeaderH);
    ctx.stroke();

    // ── Grid rows ──
    const spotStrikeIdx = strikes.reduce((best, s, i) =>
      Math.abs(s - spotPrice) < Math.abs(strikes[best] - spotPrice) ? i : best, 0);

    for (let r = 0; r < numRows; r++) {
      const y = gridTop + r * ROW_HEIGHT;
      const isSpotRow = r === spotStrikeIdx;

      // Row background (spot row highlighted)
      if (isSpotRow) {
        ctx.fillStyle = SPOT_ROW_BG;
        ctx.fillRect(0, y, canvasWidth, ROW_HEIGHT);
        // Left accent line
        ctx.fillStyle = SPOT_BORDER;
        ctx.fillRect(PADDING, y, 3, ROW_HEIGHT);
      }

      // Strike label
      ctx.fillStyle = isSpotRow ? '#58a6ff' : TEXT_DIM;
      ctx.font = isSpotRow ? `bold 12px ${FONT}` : `12px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${strikes[r]}`, PADDING + ROW_HEADER_WIDTH - 8, y + ROW_HEIGHT / 2);

      // GEX cells
      for (let c = 0; c < numCols; c++) {
        const val = grid[r][c];
        const cellX = gridLeft + c * COL_WIDTH;
        const cellY = y;

        // Cell background color (intensity based on value)
        if (val !== 0 && maxAbsGEX > 0) {
          const intensity = Math.min(Math.abs(val) / maxAbsGEX, 1);
          // Use power curve for better visual distribution
          const alpha = Math.pow(intensity, 0.6) * 0.85;
          const color = val >= 0 ? POS_COLOR : NEG_COLOR;
          ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
          ctx.fillRect(cellX + 1, cellY + 1, COL_WIDTH - 2, ROW_HEIGHT - 2);
        }

        // Cell value text
        const displayVal = this._formatGEXValue(val);
        if (displayVal !== '0') {
          // Determine text brightness based on background intensity
          const intensity = maxAbsGEX > 0 ? Math.abs(val) / maxAbsGEX : 0;
          ctx.fillStyle = intensity > 0.3 ? TEXT_BRIGHT : TEXT_DIM;
          ctx.font = `11px ${FONT}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(displayVal, cellX + COL_WIDTH / 2, cellY + ROW_HEIGHT / 2);
        }

        // Cell border (subtle)
        ctx.strokeStyle = GRID_LINE;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(cellX, cellY, COL_WIDTH, ROW_HEIGHT);
      }

      // Row divider
      ctx.strokeStyle = GRID_LINE;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(PADDING, y + ROW_HEIGHT);
      ctx.lineTo(canvasWidth - PADDING, y + ROW_HEIGHT);
      ctx.stroke();
    }

    // ── Vertical column separators ──
    for (let c = 0; c <= numCols; c++) {
      const x = gridLeft + c * COL_WIDTH;
      ctx.strokeStyle = GRID_LINE;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(x, totalHeaderH);
      ctx.lineTo(x, gridTop + numRows * ROW_HEIGHT);
      ctx.stroke();
    }

    // Left border of strike column
    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(PADDING, totalHeaderH);
    ctx.lineTo(PADDING, gridTop + numRows * ROW_HEIGHT);
    ctx.stroke();

    // ── Footer ──
    const footerY = gridTop + numRows * ROW_HEIGHT + 12;
    ctx.fillStyle = TEXT_DIM;
    ctx.font = `10px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(
      `GEX = OI × Gamma × 100 × Spot  |  Cyan = Call-dominant (positive)  |  Red = Put-dominant (negative)`,
      PADDING + 4,
      footerY
    );
    ctx.textAlign = 'right';
    ctx.fillText(
      `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      canvasWidth - PADDING - 4,
      footerY
    );

    return canvas.toBuffer('image/png');
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  /**
   * Format a GEX dollar value for display in a heat map cell.
   * Compact: $1.2M → 1.2M, $456K → 456K, $12.3 → 12
   */
  _formatGEXValue(val) {
    if (val === 0) return '0';
    const abs = Math.abs(val);
    const sign = val < 0 ? '-' : '';
    if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K`;
    if (abs >= 1) return `${sign}${abs.toFixed(0)}`;
    return '0';
  }

  /**
   * Format Discord text summary to accompany the heat map image.
   */
  formatForDiscord(ticker, spotPrice, expirations, source) {
    const sourceLabel = source === 'DatabentoLive' ? 'Databento Live OPRA (real-time)'
      : source === 'Tradier' ? 'Tradier (ORATS real greeks)'
      : source === 'Public.com' ? 'Public.com (real greeks)'
      : 'Yahoo Finance (Black-Scholes est.)';
    return [
      `**${ticker} — Gamma Heat Map**`,
      `Spot: \`$${spotPrice.toFixed(2)}\` | ${expirations.length} expirations`,
      ``,
      `🟦 **Cyan** = positive GEX (call-dominant, dealers long gamma)`,
      `🟥 **Red** = negative GEX (put-dominant, dealers short gamma)`,
      `Brighter intensity = higher magnitude`,
      ``,
      `_Data: ${sourceLabel} | Values in $ notional GEX_`,
    ].join('\n');
  }
}

module.exports = new GammaHeatmapService();
