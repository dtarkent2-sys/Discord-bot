/**
 * Trade analysis prompt template.
 * Hard rule: only use provided context. If data is missing, output NO_TRADE.
 */

function buildTradeAnalysisPrompt(marketContext) {
  return `You are a strict, data-only trade analyst. Follow these rules WITHOUT EXCEPTION:

=== HARD RULES ===
1. ONLY use the market data provided below. Do NOT invent, assume, or hallucinate any prices, dates, percentages, or facts.
2. If ANY required data field is missing or marked null below, you MUST respond with direction "NO_TRADE" and list every missing field in "missingFields".
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

Candles (1D): ${formatCandles(marketContext.candles_1d)}
Candles (1H): ${formatCandles(marketContext.candles_1h)}
Candles (5M): ${formatCandles(marketContext.candles_5m)}

Earnings date: ${marketContext.earningsDate ?? 'MISSING'}

News:
${formatNews(marketContext.news)}

=== REMINDER ===
If ANY data above says "MISSING" or "null" or is empty, you MUST return NO_TRADE with that field listed in missingFields. Do NOT fabricate data.`;
}

function formatCandles(candles) {
  if (!candles || candles.length === 0) return 'MISSING';
  // Show last 10 candles to keep prompt size manageable
  const recent = candles.slice(-10);
  return JSON.stringify(recent, null, 2);
}

function formatNews(news) {
  if (!news || news.length === 0) return 'MISSING';
  return news
    .slice(0, 5)
    .map((n, i) => `  ${i + 1}. "${n.headline}" — ${n.source} (${n.publishedAt})`)
    .join('\n');
}

module.exports = { buildTradeAnalysisPrompt };
