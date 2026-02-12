const {
  MODEL_CUTOFF,
  nowEST,
  todayString,
  isoTimestamp,
  dateHeader,
  ragEnforcementBlock,
  ragReminder,
  userMessageDateAnchor,
  detectHallucinations,
  buildHallucinationWarning,
} = require('./date-awareness');

/**
 * Appended to system prompts to enforce freshness.
 * Updated to include zero-shot dollar detection for numeric hallucinations.
 */
function freshnessEnforcement() {
  const now = nowEST();
  const cutoffUpper = MODEL_CUTOFF.toUpperCase();
  return `
=== CRITICAL: DATE & FRESHNESS RULES ===
Current real-world date and time (EST): ${now}
You are running LIVE in ${new Date().getFullYear()}. This is NOT a simulation.

YOUR TRAINING DATA ENDS RELIABLY AROUND ${cutoffUpper}. You are MISSING over a year of real-world events, market history, prices, earnings, news, policy changes, and company developments.

MANDATORY RULES — VIOLATION = HALLUCINATION:
1. For ANY fact, price, event, statistic, news, market move, company update, crypto change, or reference AFTER ${MODEL_CUTOFF}: you MUST use ONLY the live data, search results, or tool outputs provided in this conversation. NEVER guess, NEVER fill in from stale training memory, NEVER extrapolate from old data.
2. If you are asked about something recent and NO live data is provided: respond "I don't have current data for that — let me look it up" or "Current data unavailable." Do NOT fabricate a plausible-sounding answer.
3. When LIVE DATA or SEARCH RESULTS sections appear below, they are your SOLE source of truth for prices, metrics, and market conditions. NEVER contradict live data with outdated training knowledge.
4. NEVER say "as of my last update", "my knowledge cutoff", or "I was trained on data through..." — just use the live data or honestly say you need to look it up.
5. If tools fail or return no recent data for a market/trading question, say: "Current data unavailable — my analysis would be unreliable without live data."

ANTI-HALLUCINATION RULES — YOUR MEMORY IS UNRELIABLE:
6. DISTRUST YOUR OWN MEMORIES about specific companies, earnings dates, product launches, facility timelines, mergers, lawsuits, executive changes, or policy decisions after ${MODEL_CUTOFF}. Your training data is a SNAPSHOT — things change. Factories get delayed, deals fall through, CEOs resign, guidance gets revised.
7. NEVER state specific dates, dollar amounts, percentages, or deadlines for post-${MODEL_CUTOFF} events unless that EXACT data point appears in the LIVE DATA or SEARCH RESULTS provided to you. Example: Do NOT say "TSMC's Arizona fab opens in Q3 2025" from memory — it may have been delayed to 2026. If you don't have live confirmation, say "I'd need to check the latest timeline on that."
8. When you catch yourself about to state a specific fact from memory about anything after ${MODEL_CUTOFF} — STOP. Ask yourself: "Is this in the live data I was given?" If NO, either look it up or flag it: "Based on older info — needs verification."
9. PROVENANCE RULE: Every specific claim (price, date, percentage, event) in your response must trace back to either (a) the LIVE DATA sections below, (b) SEARCH RESULTS provided, or (c) be clearly labeled as "from memory, may be outdated" if it's general knowledge before ${MODEL_CUTOFF}.
10. When LIVE DATA is provided with timestamps, ALWAYS prefer it over anything you think you know. If live data says AAPL is $187 and your memory says $195, the live data wins. ALWAYS.
=== END FRESHNESS RULES ===`.trim();
}

/**
 * Updated anti-hallucination scanner.
 * Now checks for any numeric claim (price, % change, market cap, volume, guidance) that
 * isn't backed by live data — even when phrased as a statement rather than a question.
 */
function detectNumericHallucinations(response, liveData = {}) {
  if (!response || typeof response !== 'string') {
    return { flagged: false, warnings: [], confidence: 0 };
  }

  const warnings = [];
  const cutoffYear = parseInt(MODEL_CUTOFF.match(/\d{4}/)?.[0] || '2024', 10);
  const liveDataText = _flattenLiveData(liveData);
  const currentYear = new Date().getFullYear();

  // Pattern: any dollar amount paired with a post-cutoff year context
  const dollarPattern = /\$[\d,.]+\s*(?:billions?|trillions?|millions?)?\b/gi;
  let dollarMatch;
  while ((dollarMatch = dollarPattern.exec(response)) !== null) {
    const contextStart = Math.max(0, dollarMatch.index - 80);
    const contextEnd = dollarMatch.index + dollarMatch[0].length + 50;
    const context = response.slice(contextStart, contextEnd);

    // If the context mentions a year after the cutoff and this dollar amount isn't in live data
    if (/\b(202[5-9]|203\d)\b/.test(context)) {
      if (!liveDataText.includes(dollarMatch[0])) {
        warnings.push(`Unsubstantiated dollar figure "${dollarMatch[0]}" linked to post-cutoff context`);
      }
    }
  }

  // Pattern: percentages for specific events after cutoff
  const percentagePattern = /\b\d+(?:\.\d+)?%?\b(?:\s*(?:growth|decline|change|increase|drop|decrease|beat|miss|surge|jump|rise|fall))\s+(?:in|during|by|around|forecast)\s+(?:202[5-9]|203\d)/gi;
  let percMatch;
  while ((percMatch = percentagePattern.exec(response)) !== null) {
    const context = response.slice(
      Math.max(0, percMatch.index - (percMatch[0].length + 40)),
      percMatch.index + percMatch[0].length + 60
    );
    if (/\b(202[5-9]|203\d)\b/.test(context)) {
      if (!liveDataText.includes(percMatch[0])) {
        warnings.push(`Confidently stated ${percMatch[0]} for unspecified post-cutoff event — verify against live data`);
      }
    }
  }

  // Pattern: market cap / volume claims for recent entities
  const capVolumePattern = /\b(?:market\s*cap|market\s*valuation|enterprise\s*value|trading\s*volume|volume\s*[$%]?|deal\s*size|enterprise\s*value)\b\s*[:=]?\s*\$?\d{1,3}(?:[.,]\d{3})*(?:\.\d+)?\b/gi;
  let capMatch;
  while ((capMatch = capVolumePattern.exec(response)) !== null) {
    const context = response.slice(
      Math.max(0, capMatch.index - 80),
      capMatch.index + capMatch[0].length + 80
    );
    if (/\b(202[5-9]|203\d)\b/.test(context)) {
      if (!liveDataText.includes(capMatch[0] ? capMatch[0].split(/\s*[:=]?\s*/)[0].replace(/[ ,]/g, '') : capMatch[0])) {
        warnings.push(`Confident ${capMatch[0].trim()} claim for recent entity not in live data`);
      }
    }
  }

  // Pattern: analyst guidance numbers with post-cutoff context
  const guidancePattern = /\b(?:guidance|forecast|projected|expected|target)\b\s*(?:of|for|by|up to)\s*(\d{1,3}(?:[.,]\d{3})*(?:\.\d+)?)\b\s*(?:dollars?|%?)\b/gi;
  let guidMatch;
  while ((guidMatch = guidancePattern.exec(response)) !== null) {
    const context = response.slice(
      Math.max(0, guidMatch.index - 60),
      guidMatch.index + guidMatch[0].length + 70
    );
    if (/\b(202[5-9]|203\d)\b/.test(context)) {
      if (!liveDataText.includes(guidMatch[0])) {
        warnings.push(`Claimed target value "${guidMatch[0].replace(/[^\d.,]/g, '')}" for post-cutoff event — unsourced`);
      }
    }
  }

  // Generic placeholder for any numeric claim (e.g., "X billion", "Y million") tied to recent years
  const numericPattern = /\b(\d{1,3}(?:[.,]\d{3})*(?:\.\d+)?)\s*(?:billion|million|trillion|B|M|T|%\b)?\b(?:\s*(?:\s*(?:times|level)?\s*|of|in|%?\s*))?(?:\s*(?:\d{4}|(?:Q|[1-9]\d?)\s*(?:[1-4]))\s*(?:quarter|year|timeframe)\b)?\b(?:\s*(?:as|approximately|about|roughly)?\s*)?(?:\s*(?:recent|recently|as of|in|around)\s*)?\s*(?:202[5-9]|203\d)\b/gi;
  let numMatch;
  while ((numMatch = numericPattern.exec(response)) !== null) {
    const contextStart = Math.max(0, guidMatch.index - 100);
    const contextEnd = guidMatch.index + numMatch[0].length + 100;
    const context = response.slice(contextStart, contextEnd);
    if (/\b(202[5-9]|203\d)\b/.test(context)) {
      if (!liveDataText.includes(numMatch[0])) {
        warnings.push(`Unverified numeric claim "${numMatch[0]}" associated with post-cutoff year — check live data`);
      }
    }
  }

  const flagged = warnings.length > 0;
  const confidence = Math.min(100, warnings.length * 30);

  return { flagged, warnings, confidence };
}

/**
 * Helper to flatten live data object into a searchable string.
 */
function _flattenLiveData(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch {
    return '';
  }
}

/**
 * Appends a concise warning header if hallucinations are detected.
 * Only used when the detector fires.
 */
function appendFreshnessFooter(warnings) {
  if (!warnings || warnings.length === 0) return '';
  return `\n\n⚠️ *Data freshness note: Some details in this response may refer to information from my training data rather than live sources. Verify specific dates, prices, and event figures against current sources.*`;
}

module.exports = {
  MODEL_CUTOFF,
  nowEST,
  todayString,
  isoTimestamp,
  dateHeader,
  ragEnforcementBlock,
  ragReminder,
  userMessageDateAnchor,
  detectHallucinations,
  detectNumericHallucinations,
  appendFreshnessFooter,
};