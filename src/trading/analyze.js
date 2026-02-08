/**
 * Trade analysis command — ties together market data, freshness gate,
 * AI prompt, and JSON validation.
 */

const { getMarketContext } = require('../data/market');
const { buildTradeAnalysisPrompt } = require('./prompt');
const { validateTradePlan } = require('./validator');
const ai = require('../services/ai');

/**
 * Run a full trade analysis for a ticker.
 * Returns { success: true, plan } or { success: false, error }.
 */
async function analyzeTicker(ticker) {
  // 1. Fetch market context (with freshness gate)
  const context = await getMarketContext(ticker);

  if (context.error) {
    // Data is missing or stale — refuse to analyze
    return {
      success: false,
      error: context.message,
      missing: context.missing,
    };
  }

  // 2. Build prompt and get AI response
  const prompt = buildTradeAnalysisPrompt(context);
  const rawOutput = await ai.complete(prompt);

  if (!rawOutput) {
    return {
      success: false,
      error: 'AI returned no output. Is Ollama running?',
    };
  }

  // 3. Validate JSON output
  const result = validateTradePlan(rawOutput);

  if (!result.valid) {
    console.error('Trade plan validation failed:', result.errors);
    console.error('Raw AI output:', rawOutput);
    return {
      success: false,
      error: `Invalid plan output, rerun. Validation errors: ${result.errors.join('; ')}`,
    };
  }

  return { success: true, plan: result.plan };
}

/**
 * Format a trade plan for Discord display.
 */
function formatPlanForDiscord(plan) {
  if (plan.direction === 'NO_TRADE') {
    return [
      `**${plan.ticker} — NO TRADE**`,
      `**Reason:** ${plan.reasoning}`,
      `**Missing data:** ${plan.missingFields.join(', ')}`,
    ].join('\n');
  }

  const lines = [
    `**${plan.ticker} — ${plan.direction}** (${plan.confidence} confidence)`,
    `**Entry:** $${plan.entry}  |  **Exit:** $${plan.exit}  |  **Stop:** $${plan.stopLoss}`,
    `**Timeframe:** ${plan.timeframe}`,
    `**Reasoning:** ${plan.reasoning}`,
    `**Data used:** ${plan.dataUsed.join(', ')}`,
  ];

  return lines.join('\n');
}

module.exports = { analyzeTicker, formatPlanForDiscord };
