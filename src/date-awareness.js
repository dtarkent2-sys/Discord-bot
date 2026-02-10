/**
 * Date awareness utilities for RAG-enforced freshness.
 *
 * Every LLM prompt in the bot should use these helpers so the model
 * always knows today's date AND never trusts its own training data
 * for anything after the cutoff.
 */

// Approximate cutoff of the default Ollama model (Gemma/Llama/Qwen family).
// Update this when you swap to a model with a newer cutoff.
const MODEL_CUTOFF = process.env.MODEL_CUTOFF || 'mid-2024';

function todayString() {
  return new Date().toLocaleDateString('en-US', {
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
 * Returns something like:
 *   "Current date: Monday, February 10, 2026."
 */
function dateHeader() {
  return `Current date: ${todayString()}.`;
}

/**
 * Full RAG enforcement block to inject into ANY system prompt.
 * Tells the model its cutoff, today's real date, and strict rules.
 */
function ragEnforcementBlock() {
  return `
=== DATE & FRESHNESS RULES ===
Today is ${todayString()}. The current UTC timestamp is ${isoTimestamp()}.
Your internal training data ends around ${MODEL_CUTOFF}. That means you are MISSING many months of real-world events, prices, earnings, news, and market history.

STRICT RULES:
1. For ANY fact, price, event, statistic, or development AFTER ${MODEL_CUTOFF}: you MUST rely ONLY on live data, search results, or tool outputs provided in this prompt. NEVER guess or fill in from stale memory.
2. If no live data is provided for a question about recent events, say "I don't have current data for that" — do NOT fabricate an answer.
3. Every price, metric, or date you cite must come from the PROVIDED DATA sections in this prompt. If a field says "N/A" or "MISSING", acknowledge it — do not invent a value.
4. Never say "as of my last update" or "my knowledge cutoff" to users — just use the live data or say you don't have it.
=== END FRESHNESS RULES ===`.trim();
}

/**
 * Short RAG reminder for mid-prompt injection (e.g. between analyst stages).
 */
function ragReminder() {
  return `REMINDER: Today is ${todayString()}. Use ONLY the data provided above — never rely on training data for recent prices or events.`;
}

module.exports = {
  MODEL_CUTOFF,
  todayString,
  isoTimestamp,
  dateHeader,
  ragEnforcementBlock,
  ragReminder,
};
