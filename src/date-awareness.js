const MODEL_CUTOFF = process.env.MODEL_CUTOFF || 'December 2024';

const _nowESTCache = new Date().toLocaleString('en-US', {
  timeZone: 'America/New_York',
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  timeZoneName: 'short',
});

const _todayStringCache = new Date().toLocaleDateString('en-US', {
  timeZone: 'America/New_York',
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

function nowEST() {
  return _nowESTCache;
}

function todayString() {
  return _todayStringCache;
}

function isoTimestamp() {
  return new Date().toISOString();
}

function dateHeader() {
  return `Current date and time: ${nowEST()}.`;
}

function ragEnforcementBlock() {
  const now = nowEST();
  const year = new Date().getFullYear();
  const cutoffUpper = MODEL_CUTOFF.toUpperCase();
  return `
=== CRITICAL: DATE & FRESHNESS RULES ===
Current real-world date and time (EST): ${now}
You are running LIVE in ${year}. This is NOT a simulation.

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

function ragReminder() {
  return `REMINDER: Current date is ${nowEST()}. Use ONLY the data provided above. Your training data ends around ${MODEL_CUTOFF} — do NOT use stale internal knowledge for any recent prices, events, or market conditions.`;
}

function userMessageDateAnchor() {
  return `[Current date: ${nowEST()}]`;
}

function detectHallucinations(response, liveData = {}) {
  if (!response || typeof response !== 'string') {
    return { flagged: false, warnings: [], confidence: 0 };
  }

  const warnings = [];
  const cutoffYear = parseInt(MODEL_CUTOFF.match(/\d{4}/)?.[0] || '2024', 10);
  const currentYear = new Date().getFullYear();

  const liveDataText = _flattenLiveData(liveData);

  const futureDatePatterns = [
    /\b(?:in|by|around|during|scheduled for|expected in|opens? in|launches? in|releases? in|completes? in|delayed (?:to|until))\s+Q[1-4]\s+(\d{4})\b/gi,
    /\b(?:in|by|around|on|scheduled for|expected in|opens? in|launches? in|delayed (?:to|until))\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/gi,
    /\b(?:by|in|around)\s+(?:early|mid|late)[\s-]+(\d{4})\b/gi,
  ];

  for (const pattern of futureDatePatterns) {
    let match;
    while ((match = pattern.exec(response)) !== null) {
      const year = parseInt(match[1], 10);
      if (year > cutoffYear) {
        const claimContext = response.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40);
        if (!liveDataText.includes(match[0])) {
          warnings.push(`Possible hallucinated date: "${match[0].trim()}" — this is after your training cutoff (${MODEL_CUTOFF}) and wasn't in live data`);
        }
      }
    }
  }

  const asOfPattern = /\bas of\s+(?:(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+)?(\d{4})\b/gi;
  let asOfMatch;
  while ((asOfMatch = asOfPattern.exec(response)) !== null) {
    const year = parseInt(asOfMatch[1], 10);
    if (year > cutoffYear && !liveDataText.includes(asOfMatch[0])) {
      warnings.push(`Suspicious "as of" date claim: "${asOfMatch[0]}" — not backed by provided live data`);
    }
  }

  const dollarPattern = /\$[\d,.]+\s*(?:billion|million|trillion|B|M|T)\b/gi;
  let dollarMatch;
  while ((dollarMatch = dollarPattern.exec(response)) !== null) {
    const context = response.slice(Math.max(0, dollarMatch.index - 80), dollarMatch.index + dollarMatch[0].length + 40);
    const yearInContext = context.match(/\b(202[5-9]|203\d)\b/);
    if (yearInContext && !liveDataText.includes(dollarMatch[0])) {
      warnings.push(`Specific dollar amount near post-cutoff date: "${dollarMatch[0]}" in context about ${yearInContext[0]} — verify against live data`);
    }
  }

  const guessingPatterns = [
    { pattern: /\b(?:I (?:recall|remember|believe|think) (?:that )?(?:in|around|during) (?:20(?:2[5-9]|3\d)))\b/gi, label: 'Model claiming to recall post-cutoff events' },
    { pattern: /\b(?:as of my (?:last )?(?:update|training|knowledge))\b/gi, label: 'Model referencing its training cutoff explicitly' },
    { pattern: /\b(?:my (?:training|knowledge) (?:data )?(?:cutoff|goes up to|ends))\b/gi, label: 'Model referencing training cutoff' },
  ];

  for (const { pattern, label } of guessingPatterns) {
    if (pattern.test(response)) {
      warnings.push(label);
    }
  }

  const flagged = warnings.length > 0;
  const confidence = Math.min(100, warnings.length * 25);

  return { flagged, warnings, confidence };
}

function _flattenLiveData(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch {
    return '';
  }
}

function buildHallucinationWarning(warnings) {
  if (!warnings || warnings.length === 0) return '';
  return `\n\n⚠️ *Data freshness note: Some details in this response may reference information from my training data rather than live sources. Always verify specific dates, prices, and event timelines against current sources.*`;
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
  buildHallucinationWarning,
};