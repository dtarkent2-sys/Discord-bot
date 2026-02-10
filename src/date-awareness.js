/**
 * Date awareness utilities for RAG-enforced freshness.
 *
 * Every LLM prompt in the bot should use these helpers so the model
 * always knows today's REAL date AND never trusts its own training data
 * for anything after the cutoff.
 *
 * KEY INSIGHT: Models like Kimi K2.5, Qwen 2.5, Llama 3.x have knowledge
 * cutoffs around December 2024 / early 2025. Even if released in 2026,
 * their weights don't contain 2026 knowledge. We MUST force tool/search
 * usage for anything recent.
 */

// Confirmed reliable cutoff for Kimi K2.5 / Qwen 2.5 family.
// Update this when you switch to a model with a verifiably newer cutoff.
const MODEL_CUTOFF = process.env.MODEL_CUTOFF || 'December 2024';

/**
 * Full date + time string in EST, e.g.:
 *   "Monday, February 10, 2026, 7:36 PM EST"
 */
function nowEST() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    timeZoneName: 'short',
  });
}

/**
 * Short date-only string, e.g.:
 *   "Monday, February 10, 2026"
 */
function todayString() {
  return new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function isoTimestamp() {
  return new Date().toISOString();
}

/**
 * Concise date header for system prompts.
 */
function dateHeader() {
  return `Current date and time: ${nowEST()}.`;
}

/**
 * Full RAG enforcement block to inject into ANY system prompt.
 * Uses ALL-CAPS for critical rules — models attend to this more strongly.
 */
function ragEnforcementBlock() {
  const now = nowEST();
  return `
=== CRITICAL: DATE & FRESHNESS RULES ===
Current real-world date and time (EST): ${now}
You are running LIVE in ${new Date().getFullYear()}. This is NOT a simulation.

YOUR TRAINING DATA ENDS RELIABLY AROUND ${MODEL_CUTOFF.toUpperCase()}. You are MISSING over a year of real-world events, market history, prices, earnings, news, policy changes, and company developments.

MANDATORY RULES — VIOLATION = HALLUCINATION:
1. For ANY fact, price, event, statistic, news, market move, company update, crypto change, or reference AFTER ${MODEL_CUTOFF}: you MUST use ONLY the live data, search results, or tool outputs provided in this conversation. NEVER guess, NEVER fill in from stale training memory, NEVER extrapolate from old data.
2. If you are asked about something recent and NO live data is provided: respond "I don't have current data for that — let me look it up" or "Current data unavailable." Do NOT fabricate a plausible-sounding answer.
3. When LIVE DATA or SEARCH RESULTS sections appear below, they are your SOLE source of truth for prices, metrics, and market conditions. NEVER contradict live data with outdated training knowledge.
4. NEVER say "as of my last update", "my knowledge cutoff", or "I was trained on data through..." — just use the live data or honestly say you need to look it up.
5. If tools fail or return no recent data for a market/trading question, say: "Current data unavailable — my analysis would be unreliable without live data."
=== END FRESHNESS RULES ===`.trim();
}

/**
 * Short RAG reminder for mid-prompt injection (between analyst stages, etc.)
 */
function ragReminder() {
  return `REMINDER: Current date is ${nowEST()}. Use ONLY the data provided above. Your training data ends around ${MODEL_CUTOFF} — do NOT use stale internal knowledge for any recent prices, events, or market conditions.`;
}

/**
 * Date anchor to prepend to user messages.
 * Repeating the date at the message level (not just system prompt) gives
 * the model a stronger anchor against defaulting to training-era thinking.
 */
function userMessageDateAnchor() {
  return `[Current date: ${nowEST()}]`;
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
};
