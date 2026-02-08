/**
 * Trade analysis prompt template.
 * Hard rule: only use provided context. If data is missing, output NO_TRADE.
 */

function buildTradeAnalysisPrompt(marketContext) {
  const snapshot = marketContext.snapshot || {};

  return `You are a strict, data-only trade analyst. Follow these rules WITHOUT EXCEPTION:

=== HARD RULES ===
1. ONLY use the market data provided below. Do NOT invent, assume, or hallucinate any prices, dates, percentages, or facts.
2. If BOTH the Quote AND Price History sections are missing, you MUST respond with direction "NO_TRADE" and list "quote" and "price_history" in "missingFields".
3. Never reference external knowledge about this stock. You know NOTHING except what is in the PROVIDED DATA section.
4. Every claim in "reasoning" must directly cite a data point from the PROVIDED DATA.
5. If you are uncertain, choose NO_TRADE. Never guess.

=== OUTPUT FORMAT ===
Respond with ONLY a JSON object matching this exact structure (no markdown, no explanation outside the JSON):
{
  "ticker": "<TICKER>",
  "direction": "LONG" | "SHORT" | "NO_TRADE",
  "confidence": "LOW" | "MEDIUM" | "HIGH",
  "reasoning": "<cite specific data points>",
  "entry": <number or null>,
  "exit": <number or null>,
  "stopLoss": <number or null>,
  "timeframe": "intraday" | "swing" | "position",
  "dataUsed": ["quote", "candles_1d", ...],
  "missingFields": ["field1", ...] // only if NO_TRADE
}

=== PROVIDED DATA ===
Ticker: ${marketContext.ticker}
Fetched at: ${marketContext.fetchedAt}

Quote: ${JSON.stringify(marketContext.quote, null, 2) ?? 'MISSING'}

Fundamentals:
  P/B: ${snapshot.PB ?? 'N/A'}
  Div Yield: ${snapshot.DivYield != null ? snapshot.DivYield + '%' : 'N/A'}
  ROE: ${snapshot.ROE != null ? snapshot.ROE + '%' : 'N/A'}
  EPS: ${snapshot.EPS != null ? '$' + snapshot.EPS : 'N/A'}
  1-Week Return: ${snapshot['1wkReturn'] != null ? ((snapshot['1wkReturn'] - 1) * 100).toFixed(2) + '%' : 'N/A'}
  1-Month Return: ${snapshot['1moReturn'] != null ? ((snapshot['1moReturn'] - 1) * 100).toFixed(2) + '%' : 'N/A'}

Price History (daily, last 30 days): ${formatCandles(marketContext.candles_1d)}

=== REMINDER ===
Use the Quote and Price History to form your analysis. Fundamentals marked "N/A" are not available but do NOT prevent a trade signal — base your analysis on whatever data IS present. Do NOT fabricate data.`;
}

function formatCandles(candles) {
  if (!candles || candles.length === 0) return 'MISSING';
  // Show last 10 candles to keep prompt size manageable
  const recent = candles.slice(-10);
  return JSON.stringify(recent, null, 2);
}

module.exports = { buildTradeAnalysisPrompt };
