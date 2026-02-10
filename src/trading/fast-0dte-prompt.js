/**
 * Fast 0DTE Alert Prompt — Shortened pipeline for quick webhook analysis.
 *
 * Skips the full multi-agent debate. Instead, uses a single concise prompt
 * that returns structured JSON with conviction, action, stop-loss, and mood.
 * Designed for the lighter ALERT_OLLAMA_MODEL (default: qwen3:4b).
 */

const { todayString, ragEnforcementBlock } = require('../date-awareness');

/**
 * Build a fast analysis prompt for a 0DTE alert.
 *
 * @param {object} params
 * @param {object} params.alert — Parsed alert data { action, type, price, reason }
 * @param {string} params.priceData — Live SPY price string from yahoo-finance2
 * @param {string} params.newsData — Recent news snippets from SearXNG
 * @param {string} params.mood — Current bot mood from mood engine
 * @returns {string}
 */
function buildFast0DTEPrompt({ alert, priceData, newsData, mood }) {
  const today = todayString();

  return `You are a fast 0DTE options analyst. Analyze this alert using ONLY the live data provided.

${ragEnforcementBlock()}

=== ALERT ===
Action: ${alert.action || 'UNKNOWN'}
Type: ${alert.type || 'SPY 0DTE'}
Alert Price: $${alert.price || 'N/A'}
Timeframe: ${alert.interval || 'N/A'}
Confidence: ${alert.confidence || 'N/A'}
Stop Loss: ${alert.stopLoss ? '$' + alert.stopLoss : 'N/A'}
Take Profit: ${alert.takeProfit ? '$' + alert.takeProfit : 'N/A'}
Signal Text: ${alert.reason || 'No reason provided'}

=== LIVE SPY DATA ===
${priceData || 'UNAVAILABLE'}

=== RECENT NEWS ===
${newsData || 'No recent news available'}

=== CURRENT MOOD ===
${mood || 'Neutral'}

=== INSTRUCTIONS ===
Provide a FAST analysis of this 0DTE alert. Consider:
1. Does the alert direction align with current price action?
2. What is the risk/reward for this 0DTE play?
3. Key levels to watch (support/resistance near current price)
4. Any news that supports or contradicts this trade?

Respond with ONLY valid JSON (no markdown, no explanation outside JSON):
{
  "action": "BUY" | "SELL" | "SKIP",
  "conviction": 1-10,
  "bullScore": 1-10,
  "bearScore": 1-10,
  "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "EXTREME",
  "stopLoss": "<price or percentage>",
  "target": "<price or percentage>",
  "timeframe": "<e.g. 30min, 1hr, EOD>",
  "mood": "<one word: Confident, Cautious, Excited, Nervous, Skeptical>",
  "summary": "<2-3 sentence analysis citing specific data points>"
}`;
}

module.exports = { buildFast0DTEPrompt };
