/**
 * Trading Regime Selection — Single Authoritative Regime for 0DTE
 *
 * Resolves the contradiction where aggregate GEX says one thing but
 * individual expirations say another. For 0DTE decision-making, uses
 * a weighted blend of nearest expiry (today) + next expiry (tomorrow/weekly).
 *
 * Horizons:
 *   0DTE      → 70% today + 30% next expiry (authoritative for options decisions)
 *   WEEKLY    → next weekly expiry only
 *   AGGREGATE → sum of all expirations (context only, NOT for options decisions)
 */

const log = require('../logger')('TradingRegime');

/**
 * Get the authoritative trading regime for a given horizon.
 *
 * @param {object} gexSnapshot - GEX summary from GEXEngine.analyze()
 *   Must contain: { aggregation, expirations (canonical), regime, spot }
 * @param {'0DTE'|'WEEKLY'|'AGGREGATE'} horizon
 * @returns {{ label, confidence, netGEX, source, warning? }}
 */
function getTradingRegime(gexSnapshot, horizon = '0DTE') {
  if (!gexSnapshot) {
    return { label: 'Unknown', confidence: 0, netGEX: 0, source: 'none', warning: 'No GEX data' };
  }

  switch (horizon) {
    case '0DTE':
      return _get0DTERegime(gexSnapshot);
    case 'WEEKLY':
      return _getWeeklyRegime(gexSnapshot);
    case 'AGGREGATE':
      return _getAggregateRegime(gexSnapshot);
    default:
      log.warn(`Unknown horizon "${horizon}" — falling back to AGGREGATE`);
      return _getAggregateRegime(gexSnapshot);
  }
}

/**
 * 0DTE regime: 70% nearest expiry (today) + 30% next expiry.
 * This is the AUTHORITATIVE regime for 0DTE options decisions.
 */
function _get0DTERegime(snapshot) {
  const expirations = snapshot.expirations || snapshot.aggregation?.byExpiry || [];

  if (expirations.length === 0) {
    return { label: 'Unknown', confidence: 0, netGEX: 0, source: '0DTE/empty', warning: 'No expiration data' };
  }

  // Sort expirations by date (nearest first)
  const sorted = [...expirations].sort((a, b) => {
    const dateA = a.expiry || '';
    const dateB = b.expiry || '';
    return dateA.localeCompare(dateB);
  });

  const nearest = sorted[0];
  const next = sorted.length > 1 ? sorted[1] : null;

  const nearestGEX = nearest['netGEX$'] || nearest.netGEX || 0;
  const nextGEX = next ? (next['netGEX$'] || next.netGEX || 0) : 0;

  // Weighted blend: 70% today + 30% next
  const blendedGEX = nearestGEX * 0.7 + nextGEX * 0.3;

  const label = blendedGEX > 0 ? 'Long Gamma' : blendedGEX < 0 ? 'Short Gamma' : 'Mixed/Uncertain';

  // Confidence: based on magnitude and agreement between today and next
  const normFactor = 1e8;
  let confidence = Math.min(Math.abs(blendedGEX) / normFactor, 1.0);

  // Boost if both expirations agree on direction
  const sameDirection = next && Math.sign(nearestGEX) === Math.sign(nextGEX);
  if (sameDirection) {
    confidence = Math.min(confidence * 1.2, 1.0);
  }
  // Reduce if they disagree
  if (next && Math.sign(nearestGEX) !== Math.sign(nextGEX) && nextGEX !== 0) {
    confidence *= 0.7;
  }

  confidence = Math.round(confidence * 100) / 100;

  // Warning if 0DTE regime disagrees with aggregate
  const aggregateGEX = snapshot.aggregation?.totalNetGEX || 0;
  let warning = null;
  if (aggregateGEX !== 0 && Math.sign(blendedGEX) !== Math.sign(aggregateGEX)) {
    warning = `0DTE regime (${label}) disagrees with aggregate (${aggregateGEX > 0 ? 'Long Gamma' : 'Short Gamma'}) — using 0DTE for decisions`;
    log.warn(warning);
  }

  log.info(`0DTE regime: ${label} (conf=${confidence}), blended=$${(blendedGEX / 1e6).toFixed(1)}M (today=$${(nearestGEX / 1e6).toFixed(1)}M, next=$${(nextGEX / 1e6).toFixed(1)}M)`);

  return {
    label,
    confidence,
    netGEX: blendedGEX,
    source: '0DTE',
    nearestExpiry: nearest.expiry,
    nextExpiry: next?.expiry || null,
    warning,
  };
}

/**
 * WEEKLY regime: next weekly expiry only.
 */
function _getWeeklyRegime(snapshot) {
  const expirations = snapshot.expirations || snapshot.aggregation?.byExpiry || [];

  if (expirations.length === 0) {
    return { label: 'Unknown', confidence: 0, netGEX: 0, source: 'WEEKLY/empty' };
  }

  // Find the next non-today expiry (weekly)
  const sorted = [...expirations].sort((a, b) => {
    const dateA = a.expiry || '';
    const dateB = b.expiry || '';
    return dateA.localeCompare(dateB);
  });

  // Skip the nearest (today) if there are more expirations
  const weekly = sorted.length > 1 ? sorted[1] : sorted[0];
  const weeklyGEX = weekly['netGEX$'] || weekly.netGEX || 0;

  const label = weeklyGEX > 0 ? 'Long Gamma' : weeklyGEX < 0 ? 'Short Gamma' : 'Mixed/Uncertain';
  const normFactor = 1e8;
  const confidence = Math.round(Math.min(Math.abs(weeklyGEX) / normFactor, 1.0) * 100) / 100;

  return {
    label,
    confidence,
    netGEX: weeklyGEX,
    source: 'WEEKLY',
    expiry: weekly.expiry,
  };
}

/**
 * AGGREGATE regime: sum across all expirations.
 * Available for context but must NOT drive options decisions.
 */
function _getAggregateRegime(snapshot) {
  const regime = snapshot.regime || {};
  const totalNetGEX = snapshot.aggregation?.totalNetGEX || 0;

  return {
    label: regime.label || (totalNetGEX > 0 ? 'Long Gamma' : totalNetGEX < 0 ? 'Short Gamma' : 'Mixed/Uncertain'),
    confidence: regime.confidence || 0,
    netGEX: totalNetGEX,
    source: 'AGGREGATE',
    warning: regime.warning || null,
  };
}

module.exports = { getTradingRegime };
