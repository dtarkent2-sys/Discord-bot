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
const tradier = require('./tradier');
const publicService = require('./public');
const priceFetcher = require('../tools/price-fetcher');
const alpaca = require('./alpaca');

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

    // ── Data source priority: Tradier (ORATS) > Public.com > Yahoo (Black-Scholes) ──
    let source = 'Yahoo';
    let allExpDates = null;
    let yahooExps = null;

    // 1. Get available expirations — try sources in order
    if (tradier.enabled) {
      try {
        const dates = await tradier.getOptionExpirations(upper);
        if (dates.length > 0) { allExpDates = dates; source = 'Tradier'; }
      } catch (err) {
        console.warn(`[GammaHeatmap] Tradier expirations failed: ${err.message}`);
      }
    }
    if (!allExpDates && publicService.enabled) {
      try {
        const dates = await publicService.getOptionExpirations(upper);
        if (dates && dates.length > 0) { allExpDates = dates; source = 'Public.com'; }
      } catch (err) {
        console.warn(`[GammaHeatmap] Public.com expirations failed: ${err.message}`);
      }
    }
    if (!allExpDates) {
      yahooExps = await gamma.fetchAvailableExpirations(upper);
      if (yahooExps.length === 0) throw new Error(`No options expirations found for ${upper}`);
      allExpDates = yahooExps.map(e => e.date);
      source = 'Yahoo';
    }

    // Pick up to 6 nearest future expirations
    const today = new Date().toISOString().slice(0, 10);
    const futureExpDates = allExpDates.filter(d => d >= today).sort().slice(0, 6);

    if (futureExpDates.length === 0) {
      throw new Error(`No upcoming expirations for ${upper}`);
    }

    const targetExpDates = opts.expirations
      ? allExpDates.filter(d => opts.expirations.includes(d))
      : futureExpDates;

    if (targetExpDates.length === 0) {
      throw new Error('None of the specified expiration dates are available.');
    }

    // 2. Get spot price
    let spotPrice = null;
    if (source === 'Tradier') {
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

    // 3. Fetch options chain for each expiration and compute per-strike GEX
    const expirationData = [];
    let allStrikes = new Set();

    for (const expDate of targetExpDates) {
      try {
        let strikeGEX;
        let totalGEX;

        if (source === 'Tradier' || source === 'Public.com') {
          // ── Real greeks path: Tradier (ORATS) or Public.com ──
          let contracts;
          if (source === 'Tradier') {
            contracts = await tradier.getOptionsWithGreeks(upper, expDate);
          } else {
            contracts = await publicService.getOptionsWithGreeks(upper, expDate);
          }
          if (!contracts || contracts.length === 0) continue;

          strikeGEX = new Map();
          totalGEX = 0;
          for (const c of contracts) {
            if (!c.strike || !c.openInterest || !c.gamma) continue;
            const gex = c.openInterest * c.gamma * 100 * spotPrice;
            const prev = strikeGEX.get(c.strike) || 0;
            const contribution = c.type === 'call' ? gex : -gex;
            strikeGEX.set(c.strike, prev + contribution);
            allStrikes.add(c.strike);
            totalGEX += contribution;
          }
        } else {
          // ── Yahoo fallback: Black-Scholes estimated gamma ──
          const expObj = yahooExps?.find(e => e.date === expDate);
          if (!expObj) continue;
          const result = await gamma._yahooFetch(upper, expObj.epoch);
          const options = result.options?.[0];
          if (!options) continue;

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
          strikeGEX = new Map();
          for (const s of detailed.strikes) {
            strikeGEX.set(s.strike, s['netGEX$']);
            allStrikes.add(s.strike);
          }
          totalGEX = detailed['totalNetGEX$'];
        }

        expirationData.push({ date: expDate, strikeGEX, totalGEX });
      } catch (err) {
        console.warn(`[GammaHeatmap] Skipping ${expDate}: ${err.message}`);
      }
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
    const sourceLabel = source === 'Tradier' ? 'Tradier (ORATS real greeks)'
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
