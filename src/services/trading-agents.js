/**
 * TradingAgents — Multi-agent LLM trading analysis pipeline.
 *
 * Inspired by https://github.com/TauricResearch/TradingAgents
 *
 * Pipeline:
 *   1. Four analyst agents run in parallel (Market, Fundamentals, News, Sentiment)
 *   2. Bull vs Bear debate synthesizes the analyst reports
 *   3. Trader agent makes a BUY / SELL / HOLD decision
 *   4. Three risk managers (aggressive, moderate, conservative) review
 *   5. Final signal is produced with confidence level
 *
 * All LLM calls go through the existing Ollama client.
 * AInvest data is fetched per-analyst for maximum richness.
 */

const { Ollama } = require('ollama');
const config = require('../config');
const yahoo = require('./yahoo');
const { getMarketContext, formatContextForAI } = require('../data/market');
const { todayString, ragEnforcementBlock, ragReminder, MODEL_CUTOFF } = require('../date-awareness');
const priceFetcher = require('../tools/price-fetcher');

// AInvest — analyst ratings, financials, earnings, news (optional enrichment)
let ainvest;
try {
  ainvest = require('./ainvest');
} catch {
  ainvest = null;
}

// LLM call timeout (90 seconds per call)
const LLM_TIMEOUT_MS = 90000;

class TradingAgents {
  constructor() {
    const opts = { host: config.ollamaHost };
    if (config.ollamaApiKey) {
      opts.headers = { Authorization: `Bearer ${config.ollamaApiKey}` };
    }
    this.ollama = new Ollama(opts);
    this.model = config.ollamaModel;
  }

  // ── Main entry point ──────────────────────────────────────────────────

  /**
   * Run the full multi-agent analysis pipeline for a ticker.
   * @param {string} ticker — stock symbol
   * @param {function} [onProgress] — optional callback(stage, message) for live updates
   * @returns {{ signal, confidence, summary, analysts, debate, trader, risk, ticker, timestamp, dataSources }}
   */
  async analyze(ticker, onProgress) {
    const upper = ticker.toUpperCase();
    const progress = onProgress || (() => {});
    const dataSources = []; // Track what data we actually got

    // ── Stage 0: Fetch market data ──
    progress('data', `Fetching market data for ${upper}...`);
    const context = await getMarketContext(upper);
    if (context.error) {
      throw new Error(`Cannot fetch data for ${upper}: ${context.message}`);
    }
    let marketData = formatContextForAI(context);
    const snapshot = context.snapshot || {};
    dataSources.push('market-data');

    // ── Enrich with live price + AInvest data (parallel) ──
    progress('data', `Enriching with AInvest data for ${upper}...`);
    const enrichPromises = [];

    // Live price cross-reference
    if (priceFetcher.isAvailable()) {
      enrichPromises.push(
        priceFetcher.getCurrentPrice(upper)
          .then(livePrice => {
            if (!livePrice.error) {
              marketData += `\n\nLIVE PRICE CROSS-REFERENCE (fetched ${livePrice.lastUpdated}):\n` +
                priceFetcher.formatForPrompt([livePrice]);
              dataSources.push('live-price');
            }
          })
          .catch(err => console.warn(`[TradingAgents] Live price fetch failed for ${upper}:`, err.message))
      );
    }

    // AInvest deep enrichment — fetch ALL data categories in parallel
    let ainvestData = {
      fundamentals: '',
      analystRatings: '',
      analystHistory: '',
      news: '',
      earnings: '',
      insiderTrades: '',
      congressTrades: '',
      economicCalendar: '',
    };

    if (ainvest && ainvest.enabled) {
      enrichPromises.push(
        this._fetchAInvestData(upper, ainvestData, dataSources)
      );
    } else {
      console.warn('[TradingAgents] AInvest not available — analysis will lack fundamentals, news, and analyst ratings');
    }

    await Promise.all(enrichPromises);

    // Append general AInvest context to marketData for prompts that use it
    const ainvestBlock = this._formatAInvestBlock(ainvestData);
    if (ainvestBlock) {
      marketData += `\n\n${ainvestBlock}`;
    }

    console.log(`[TradingAgents] Data sources for ${upper}: ${dataSources.join(', ')}`);

    // ── Stage 1: Four analysts in parallel ──
    progress('analysts', 'Running analyst agents (market, fundamentals, sentiment, news)...');
    const [marketReport, fundReport, sentimentReport, newsReport] = await Promise.all([
      this._marketAnalyst(upper, marketData, snapshot),
      this._fundamentalsAnalyst(upper, marketData, snapshot, ainvestData),
      this._sentimentAnalyst(upper, marketData, snapshot, ainvestData),
      this._newsAnalyst(upper, marketData, snapshot, ainvestData),
    ]);

    const analystReports = {
      market: marketReport,
      fundamentals: fundReport,
      sentiment: sentimentReport,
      news: newsReport,
    };

    // Log analyst output quality
    for (const [name, report] of Object.entries(analystReports)) {
      const rating = this._extractRating(report);
      console.log(`[TradingAgents] ${name} analyst: ${report.length} chars, rating=${rating.rating}, conf=${rating.confidence}`);
    }

    // ── Stage 2: Bull vs Bear debate ──
    progress('debate', 'Running bull vs bear debate...');
    const debate = await this._bullBearDebate(upper, analystReports, marketData);

    // ── Stage 3: Trader decision ──
    progress('trader', 'Trader agent making decision...');
    const traderDecision = await this._traderDecision(upper, analystReports, debate, marketData);

    // ── Stage 4: Risk management review ──
    progress('risk', 'Risk management committee reviewing...');
    const riskReview = await this._riskManagement(upper, traderDecision, analystReports, marketData);

    // ── Stage 5: Final signal ──
    progress('signal', 'Producing final signal...');
    const finalSignal = await this._finalSignal(upper, traderDecision, riskReview, analystReports);

    return {
      ticker: upper,
      signal: finalSignal.signal,
      confidence: finalSignal.confidence,
      summary: finalSignal.summary,
      analysts: analystReports,
      debate,
      trader: traderDecision,
      risk: riskReview,
      dataSources,
      timestamp: new Date().toISOString(),
    };
  }

  // ── AInvest Deep Data Fetching ──────────────────────────────────────────

  /**
   * Fetch all AInvest data categories in parallel for rich analysis.
   */
  async _fetchAInvestData(ticker, data, dataSources) {
    const fetches = [
      // Analyst consensus ratings
      ainvest.getAnalystConsensus(ticker)
        .then(result => {
          if (result) {
            data.analystRatings = this._formatAnalystConsensus(result);
            dataSources.push('ainvest-analyst-ratings');
          }
        })
        .catch(err => console.warn(`[TradingAgents] AInvest analyst consensus failed for ${ticker}:`, err.message)),

      // Recent analyst rating changes (individual firms)
      ainvest.getAnalystHistory(ticker, 10)
        .then(result => {
          if (result && result.length > 0) {
            data.analystHistory = this._formatAnalystHistory(result);
            dataSources.push('ainvest-analyst-history');
          }
        })
        .catch(err => console.warn(`[TradingAgents] AInvest analyst history failed for ${ticker}:`, err.message)),

      // Fundamental financials
      ainvest.getFinancials(ticker)
        .then(result => {
          if (result) {
            data.fundamentals = this._formatFinancials(result);
            dataSources.push('ainvest-financials');
          }
        })
        .catch(err => console.warn(`[TradingAgents] AInvest financials failed for ${ticker}:`, err.message)),

      // Recent earnings
      ainvest.getEarnings(ticker, 4)
        .then(result => {
          if (result && result.length > 0) {
            data.earnings = this._formatEarnings(result);
            dataSources.push('ainvest-earnings');
          }
        })
        .catch(err => console.warn(`[TradingAgents] AInvest earnings failed for ${ticker}:`, err.message)),

      // News headlines
      ainvest.getNews({ tickers: [ticker], limit: 10 })
        .then(result => {
          if (result && result.length > 0) {
            data.news = this._formatNews(result);
            dataSources.push('ainvest-news');
          }
        })
        .catch(err => console.warn(`[TradingAgents] AInvest news failed for ${ticker}:`, err.message)),

      // Insider trades
      ainvest.getInsiderTrades(ticker)
        .then(result => {
          if (result && result.length > 0) {
            data.insiderTrades = this._formatInsiderTrades(result.slice(0, 5));
            dataSources.push('ainvest-insider-trades');
          }
        })
        .catch(err => console.warn(`[TradingAgents] AInvest insider trades failed for ${ticker}:`, err.message)),

      // Congress trades
      ainvest.getCongressTrades(ticker)
        .then(result => {
          if (result && result.length > 0) {
            data.congressTrades = this._formatCongressTrades(result.slice(0, 5));
            dataSources.push('ainvest-congress-trades');
          }
        })
        .catch(err => console.warn(`[TradingAgents] AInvest congress trades failed for ${ticker}:`, err.message)),

      // Economic calendar (macro context)
      ainvest.getEconomicCalendar({ importance: 'high' })
        .then(result => {
          if (result && result.length > 0) {
            data.economicCalendar = this._formatEconomicCalendar(result.slice(0, 5));
            dataSources.push('ainvest-econ-calendar');
          }
        })
        .catch(err => console.warn(`[TradingAgents] AInvest economic calendar failed:`, err.message)),
    ];

    await Promise.allSettled(fetches);
  }

  // ── AInvest Data Formatters ─────────────────────────────────────────────

  _formatAnalystConsensus(a) {
    const lines = [`WALL STREET ANALYST CONSENSUS (${a.totalAnalysts} analysts):`];
    lines.push(`  Strong Buy: ${a.strongBuy} | Buy: ${a.buy} | Hold: ${a.hold} | Sell: ${a.sell} | Strong Sell: ${a.strongSell}`);
    if (a.avgRating != null) lines.push(`  Average Rating: ${a.avgRating}/5`);
    if (a.targetAvg != null) lines.push(`  Price Target: $${a.targetLow} — $${a.targetHigh} (avg $${a.targetAvg})`);
    return lines.join('\n');
  }

  _formatAnalystHistory(history) {
    const lines = ['RECENT ANALYST RATING CHANGES:'];
    for (const r of history) {
      const parts = [];
      if (r.date) parts.push(r.date);
      if (r.firm) parts.push(r.firm);
      if (r.action) parts.push(r.action);
      if (r.rating) parts.push(`→ ${r.rating}`);
      if (r.targetPrice != null) parts.push(`PT: $${r.targetPrice}`);
      if (r.previousRating) parts.push(`(was: ${r.previousRating})`);
      lines.push(`  ${parts.join(' | ')}`);
    }
    return lines.join('\n');
  }

  _formatFinancials(f) {
    const parts = [];
    if (f.peTTM != null) parts.push(`P/E (TTM): ${f.peTTM.toFixed(1)}`);
    if (f.epsTTM != null) parts.push(`EPS (TTM): $${f.epsTTM.toFixed(2)}`);
    if (f.pb != null) parts.push(`P/B: ${f.pb.toFixed(1)}`);
    if (f.roeTTM != null) parts.push(`ROE: ${(f.roeTTM * 100).toFixed(1)}%`);
    if (f.grossMargin != null) parts.push(`Gross Margin: ${(f.grossMargin * 100).toFixed(1)}%`);
    if (f.operatingMargin != null) parts.push(`Operating Margin: ${(f.operatingMargin * 100).toFixed(1)}%`);
    if (f.netMargin != null) parts.push(`Net Margin: ${(f.netMargin * 100).toFixed(1)}%`);
    if (f.debtRatio != null) parts.push(`Debt Ratio: ${f.debtRatio.toFixed(2)}`);
    if (f.dividendYield != null) parts.push(`Dividend Yield: ${(f.dividendYield * 100).toFixed(2)}%`);
    if (f.marketCap != null) parts.push(`Market Cap: $${(f.marketCap / 1e9).toFixed(1)}B`);
    if (f.revenueGrowth != null) parts.push(`Revenue Growth: ${(f.revenueGrowth * 100).toFixed(1)}%`);
    if (f.earningsGrowth != null) parts.push(`Earnings Growth: ${(f.earningsGrowth * 100).toFixed(1)}%`);
    return parts.length > 0 ? `FUNDAMENTALS:\n  ${parts.join('\n  ')}` : '';
  }

  _formatEarnings(earnings) {
    const lines = ['RECENT EARNINGS:'];
    for (const e of earnings) {
      const surprise = e.epsSurprise != null ? ` (${e.epsSurprise > 0 ? '+' : ''}${e.epsSurprise}% surprise)` : '';
      const rev = e.revenueActual != null ? ` | Rev: $${(e.revenueActual / 1e9).toFixed(2)}B` : '';
      const revSurprise = e.revenueSurprise != null ? ` (${e.revenueSurprise > 0 ? '+' : ''}${e.revenueSurprise}% surprise)` : '';
      lines.push(`  ${e.date || 'N/A'}: EPS $${e.epsActual ?? 'N/A'} vs est $${e.epsForecast ?? 'N/A'}${surprise}${rev}${revSurprise}`);
      if (e.summary) lines.push(`    Summary: ${e.summary.slice(0, 200)}`);
    }
    return lines.join('\n');
  }

  _formatNews(articles) {
    const lines = [`LATEST NEWS (${articles.length} articles):`];
    for (const a of articles) {
      const ts = a.timestamp ? ` [${a.timestamp}]` : '';
      lines.push(`  • ${a.title}${ts}`);
      if (a.summary) lines.push(`    ${a.summary.slice(0, 200)}`);
      if (a.source) lines.push(`    Source: ${a.source}`);
    }
    return lines.join('\n');
  }

  _formatInsiderTrades(trades) {
    const lines = ['RECENT INSIDER TRADES:'];
    for (const t of trades) {
      const name = t.name || t.insider_name || 'Unknown';
      const type = t.trade_type || t.transaction_type || t.type || '?';
      const shares = t.shares || t.quantity || '?';
      const price = t.price ? ` @ $${t.price}` : '';
      const value = t.value ? ` ($${(t.value / 1e6).toFixed(2)}M)` : '';
      const date = t.date || t.filing_date || '';
      lines.push(`  ${date ? date + ': ' : ''}${name} — ${type} ${shares} shares${price}${value}`);
    }
    return lines.join('\n');
  }

  _formatCongressTrades(trades) {
    const lines = ['RECENT CONGRESS TRADES:'];
    for (const t of trades) {
      const name = t.name || t.congress_member || t.representative || 'Unknown';
      const type = t.trade_type || t.transaction_type || t.type || '?';
      const amount = t.amount || t.range || '?';
      const date = t.date || t.transaction_date || '';
      lines.push(`  ${date ? date + ': ' : ''}${name} — ${type} (${amount})`);
    }
    return lines.join('\n');
  }

  _formatEconomicCalendar(events) {
    const lines = ['HIGH-IMPACT ECONOMIC EVENTS TODAY:'];
    for (const e of events) {
      const actual = e.actual != null ? `Actual: ${e.actual}` : '';
      const forecast = e.forecast != null ? `Est: ${e.forecast}` : '';
      const previous = e.previous != null ? `Prev: ${e.previous}` : '';
      const parts = [actual, forecast, previous].filter(Boolean).join(' | ');
      lines.push(`  ${e.event} — ${parts || 'Pending'}`);
    }
    return lines.join('\n');
  }

  /** Combine all non-empty AInvest sections into one block */
  _formatAInvestBlock(data) {
    const sections = [];
    if (data.analystRatings) sections.push(data.analystRatings);
    if (data.fundamentals) sections.push(data.fundamentals);
    if (data.earnings) sections.push(data.earnings);
    if (data.insiderTrades) sections.push(data.insiderTrades);
    if (data.congressTrades) sections.push(data.congressTrades);
    if (data.economicCalendar) sections.push(data.economicCalendar);
    // News and analyst history are fed directly to specific analysts
    if (sections.length === 0) return '';
    return `=== AINVEST LIVE DATA ===\n${sections.join('\n\n')}`;
  }

  // ── Analyst Agents ────────────────────────────────────────────────────

  async _marketAnalyst(ticker, marketData, snapshot) {
    const prompt = `You are a senior market/technical analyst at a top trading firm. Analyze ${ticker} using ONLY the data provided below. Focus on:
- Price action and trend direction (current price vs SMA50 vs SMA200)
- RSI reading and what it signals (overbought/oversold/neutral)
- Volume patterns and what they suggest
- Support/resistance levels from 52-week range
- Short-term and medium-term technical outlook

MARKET DATA:
${marketData}

Provide a concise technical analysis report (150-250 words). End with a clear rating and confidence score.

YOU MUST end your response with this EXACT line (copy it exactly, fill in the brackets):
RATING: BULLISH | CONFIDENCE: 7

or

RATING: BEARISH | CONFIDENCE: 6

or

RATING: NEUTRAL | CONFIDENCE: 5

The rating MUST be one of: BULLISH, BEARISH, or NEUTRAL. The confidence MUST be a number 1-10.`;

    return this._llmCall(prompt);
  }

  async _fundamentalsAnalyst(ticker, marketData, snapshot, ainvestData) {
    // Build enriched prompt with AInvest fundamentals + analyst data
    let extraData = '';
    if (ainvestData.fundamentals) extraData += `\n\n${ainvestData.fundamentals}`;
    if (ainvestData.analystRatings) extraData += `\n\n${ainvestData.analystRatings}`;
    if (ainvestData.analystHistory) extraData += `\n\n${ainvestData.analystHistory}`;
    if (ainvestData.earnings) extraData += `\n\n${ainvestData.earnings}`;

    const prompt = `You are a senior fundamentals analyst at a top investment firm. Analyze ${ticker} using ONLY the data provided below. Focus on:
- Valuation metrics (P/E, Forward P/E, P/B) — are they reasonable for the sector?
- Profitability (EPS, profit margins, ROE)
- Growth indicators (revenue growth, earnings growth)
- Wall Street analyst consensus and price targets
- Recent earnings surprises and trends
- Dividend yield and income potential
- Beta and risk characteristics

MARKET DATA:
${marketData}
${extraData}

Provide a concise fundamental analysis report (150-250 words). End with a clear rating and confidence score.

YOU MUST end your response with this EXACT line (copy it exactly, fill in the brackets):
RATING: BULLISH | CONFIDENCE: 7

or

RATING: BEARISH | CONFIDENCE: 6

or

RATING: NEUTRAL | CONFIDENCE: 5

The rating MUST be one of: BULLISH, BEARISH, or NEUTRAL. The confidence MUST be a number 1-10.`;

    return this._llmCall(prompt);
  }

  async _sentimentAnalyst(ticker, marketData, snapshot, ainvestData) {
    // Build enriched prompt with insider/congress trades + sentiment data
    let extraData = '';
    if (ainvestData.insiderTrades) extraData += `\n\n${ainvestData.insiderTrades}`;
    if (ainvestData.congressTrades) extraData += `\n\n${ainvestData.congressTrades}`;

    const prompt = `You are a market sentiment analyst specializing in reading market psychology. Analyze ${ticker} sentiment using the data below. Consider:
- Daily price change direction and magnitude as a sentiment signal
- RSI as a crowd sentiment indicator (extreme readings = extreme sentiment)
- How current price relates to 52-week range (near highs = optimism, near lows = fear)
- Volume as a conviction indicator
- Insider trading patterns (are executives buying or selling?)
- Congressional trading activity (smart money signal)
- Overall market mood implied by the data

MARKET DATA:
${marketData}
${extraData}

Provide a concise sentiment analysis report (150-250 words). Assess whether crowd sentiment is greedy, fearful, or balanced. End with a clear rating and confidence score.

YOU MUST end your response with this EXACT line (copy it exactly, fill in the brackets):
RATING: BULLISH | CONFIDENCE: 7

or

RATING: BEARISH | CONFIDENCE: 6

or

RATING: NEUTRAL | CONFIDENCE: 5

The rating MUST be one of: BULLISH, BEARISH, or NEUTRAL. The confidence MUST be a number 1-10.`;

    return this._llmCall(prompt);
  }

  async _newsAnalyst(ticker, marketData, snapshot, ainvestData) {
    // Build enriched prompt with AInvest news + economic calendar
    let extraData = '';
    if (ainvestData.news) extraData += `\n\n${ainvestData.news}`;
    if (ainvestData.economicCalendar) extraData += `\n\n${ainvestData.economicCalendar}`;

    const prompt = `You are a financial news analyst at a major trading desk. Analyze ${ticker} using the live market data AND news provided below. Focus on:
- Recent news headlines and their implications for the stock
- Macro-economic events and how they affect this company/sector
- Upcoming catalysts (earnings dates, economic data, policy decisions)
- Sector positioning based on current market conditions
- Risk factors visible in recent news and data
- Price action context for the news flow

MARKET DATA:
${marketData}
${extraData}

IMPORTANT: Base your analysis on the data and news above. If news articles are provided, analyze their impact. If no news is available, analyze based on market data and general industry knowledge.

Provide a concise news/macro analysis report (150-250 words). End with a clear rating and confidence score.

YOU MUST end your response with this EXACT line (copy it exactly, fill in the brackets):
RATING: BULLISH | CONFIDENCE: 7

or

RATING: BEARISH | CONFIDENCE: 6

or

RATING: NEUTRAL | CONFIDENCE: 5

The rating MUST be one of: BULLISH, BEARISH, or NEUTRAL. The confidence MUST be a number 1-10.`;

    return this._llmCall(prompt);
  }

  // ── Bull vs Bear Debate ───────────────────────────────────────────────

  async _bullBearDebate(ticker, analysts, marketData) {
    const analystSummary = Object.entries(analysts)
      .map(([name, report]) => `=== ${name.toUpperCase()} ANALYST ===\n${report}`)
      .join('\n\n');

    // Bull makes the case
    const bullPrompt = `You are a BULL advocate in a trading firm debate about ${ticker}. You must argue FOR buying this stock.

Review these analyst reports and the market data, then make the STRONGEST possible bull case:

${analystSummary}

MARKET DATA:
${marketData}

Present your bull case in 150-200 words. Cite specific data points. Acknowledge risks but explain why the opportunity outweighs them. Be persuasive and specific.

${ragReminder()}`;

    const bullCase = await this._llmCall(bullPrompt);

    // Bear makes the case
    const bearPrompt = `You are a BEAR advocate in a trading firm debate about ${ticker}. You must argue AGAINST buying this stock.

Review these analyst reports and the market data, then make the STRONGEST possible bear case:

${analystSummary}

MARKET DATA:
${marketData}

The bull argued:
${bullCase}

Present your bear case in 150-200 words. Counter the bull's arguments with specific data. Highlight risks, overvaluation concerns, and warning signs. Be persuasive and specific.

${ragReminder()}`;

    const bearCase = await this._llmCall(bearPrompt);

    return { bull: bullCase, bear: bearCase };
  }

  // ── Trader Decision ───────────────────────────────────────────────────

  async _traderDecision(ticker, analysts, debate, marketData) {
    const analystSummary = Object.entries(analysts)
      .map(([name, report]) => `=== ${name.toUpperCase()} ANALYST ===\n${report}`)
      .join('\n\n');

    const prompt = `You are a senior trader at a top investment firm. You must make a trading decision on ${ticker} based on all the research below.

ANALYST REPORTS:
${analystSummary}

BULL CASE:
${debate.bull}

BEAR CASE:
${debate.bear}

MARKET DATA:
${marketData}

Based on ALL the above, make your trading decision. Consider:
1. Weight of analyst opinions (consensus vs divergence)
2. Strength of bull vs bear arguments
3. Risk/reward ratio
4. Timing — is now a good entry point?

Provide your decision in 150-200 words. Be decisive. Explain your reasoning clearly.

End with your decision in EXACTLY this format:
DECISION: BUY | CONFIDENCE: 7 | TIMEFRAME: medium-term

The DECISION must be BUY, SELL, or HOLD. CONFIDENCE must be 1-10. TIMEFRAME must be short-term, medium-term, or long-term.`;

    return this._llmCall(prompt);
  }

  // ── Risk Management ───────────────────────────────────────────────────

  async _riskManagement(ticker, traderDecision, analysts, marketData) {
    // Three risk managers with different risk appetites review in parallel
    const [aggressive, moderate, conservative] = await Promise.all([
      this._riskManager(ticker, traderDecision, marketData, 'aggressive',
        'You have a HIGH risk tolerance. You favor growth and momentum plays. Small drawdowns are acceptable for bigger gains.'),
      this._riskManager(ticker, traderDecision, marketData, 'moderate',
        'You have a MODERATE risk tolerance. You seek balanced risk/reward. Position sizing and stop-losses matter.'),
      this._riskManager(ticker, traderDecision, marketData, 'conservative',
        'You have a LOW risk tolerance. Capital preservation is paramount. You prefer high-quality, low-volatility positions.'),
    ]);

    return { aggressive, moderate, conservative };
  }

  async _riskManager(ticker, traderDecision, marketData, style, personality) {
    const prompt = `You are a ${style} risk manager at a trading firm. ${personality}

The trader has proposed this action on ${ticker}:
${traderDecision}

MARKET DATA:
${marketData}

Review this trade proposal from your ${style} risk perspective. Consider:
- Position sizing recommendation
- Stop-loss levels
- Key risk factors
- Whether you APPROVE or REJECT this trade

Keep your review to 100-150 words. End with EXACTLY this format:
VERDICT: APPROVE | RISK_LEVEL: MEDIUM

or

VERDICT: REJECT | RISK_LEVEL: HIGH

The VERDICT must be APPROVE or REJECT. RISK_LEVEL must be LOW, MEDIUM, or HIGH.`;

    return this._llmCall(prompt);
  }

  // ── Final Signal ──────────────────────────────────────────────────────

  async _finalSignal(ticker, traderDecision, riskReview, analysts) {
    const riskSummary = Object.entries(riskReview)
      .map(([style, review]) => `=== ${style.toUpperCase()} RISK MANAGER ===\n${review}`)
      .join('\n\n');

    const prompt = `You are the HEAD OF TRADING at a top investment firm. You must produce the FINAL trading signal for ${ticker}.

TRADER'S DECISION:
${traderDecision}

RISK COMMITTEE REVIEWS:
${riskSummary}

Produce the final trading signal. If risk managers mostly approve, align with the trader. If they mostly reject, consider adjusting to HOLD or reducing confidence.

Output EXACTLY in this format (no extra text before or after):
SIGNAL: BUY
CONFIDENCE: 8
SUMMARY: Two to three sentences explaining the rationale for this signal.

The SIGNAL must be BUY, SELL, or HOLD. CONFIDENCE must be 1-10. SUMMARY must be 2-3 sentences.`;

    const response = await this._llmCall(prompt);

    // Parse the structured response
    return this._parseSignal(response);
  }

  // ── LLM Call Helper ───────────────────────────────────────────────────

  async _llmCall(prompt) {
    const systemMsg = `${ragEnforcementBlock()}

You are analyzing LIVE market data provided in the user prompt. All prices, metrics, and market conditions in the prompt are current as of today (${todayString()}). Use ONLY the data given. Never mention "knowledge cutoff" — just use the live data.

IMPORTANT: Always follow the output format instructions exactly. End your response with the requested format line.`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

      try {
        const stream = await this.ollama.chat({
          model: this.model,
          messages: [
            { role: 'system', content: systemMsg },
            { role: 'user', content: prompt },
          ],
          stream: true,
        });

        let result = '';
        for await (const part of stream) {
          if (controller.signal.aborted) break;
          const content = part.message?.content;
          if (content) result += content;
        }

        clearTimeout(timeout);

        // Strip thinking tags (qwen3, deepseek, etc. wrap responses in <think> blocks)
        result = result
          .replace(/<think>[\s\S]*?<\/think>/gi, '')
          .replace(/<\|think\|>[\s\S]*?<\|\/think\|>/gi, '')
          .trim();

        // Validate response quality
        if (!result || result.trim().length < 30) {
          console.warn(`[TradingAgents] LLM returned very short response (${result.length} chars): "${result.slice(0, 100)}"`);
          // Return a structured fallback so parsing doesn't completely fail
          return `Analysis produced limited output. The model returned: ${result || '(empty)'}\n\nRATING: NEUTRAL | CONFIDENCE: 3`;
        }

        return result;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      const isTimeout = err.name === 'AbortError' || err.message?.includes('abort');
      const errType = isTimeout ? 'timeout' : 'error';
      console.error(`[TradingAgents] LLM call ${errType}:`, err.message);

      // Return structured fallback instead of generic error string
      return `Analysis unavailable due to ${errType}: ${err.message}\n\nRATING: NEUTRAL | CONFIDENCE: 1`;
    }
  }

  // ── Response Parsing ──────────────────────────────────────────────────

  _parseSignal(response) {
    const signalMatch = response.match(/SIGNAL:\s*(BUY|SELL|HOLD)/i);
    const confMatch = response.match(/CONFIDENCE:\s*(\d+)/i);
    const summaryMatch = response.match(/SUMMARY:\s*(.+)/is);

    return {
      signal: signalMatch ? signalMatch[1].toUpperCase() : this._inferSignal(response),
      confidence: confMatch ? Math.min(10, Math.max(1, parseInt(confMatch[1], 10))) : 5,
      summary: summaryMatch ? summaryMatch[1].trim().split('\n')[0].slice(0, 500) : this._extractSummary(response),
    };
  }

  /**
   * Extract RATING from an analyst report with multiple fallback strategies.
   * This is the key fix for N/A issues — the regex matching is now much more forgiving.
   */
  _extractRating(report) {
    if (!report || typeof report !== 'string') {
      return { rating: 'NEUTRAL', confidence: 1 };
    }

    const text = report.trim();

    // Strategy 1: Exact format match (ideal case)
    const exactMatch = text.match(/RATING:\s*(BULLISH|BEARISH|NEUTRAL)\s*\|\s*CONFIDENCE:\s*(\d+)/i);
    if (exactMatch) {
      return {
        rating: exactMatch[1].toUpperCase(),
        confidence: Math.min(10, Math.max(1, parseInt(exactMatch[2], 10))),
      };
    }

    // Strategy 2: RATING line anywhere (may not have confidence on same line)
    const ratingMatch = text.match(/RATING:\s*(BULLISH|BEARISH|NEUTRAL)/i);
    const confMatch = text.match(/CONFIDENCE:\s*(\d+)/i);
    if (ratingMatch) {
      return {
        rating: ratingMatch[1].toUpperCase(),
        confidence: confMatch ? Math.min(10, Math.max(1, parseInt(confMatch[1], 10))) : 5,
      };
    }

    // Strategy 3: Look for "bullish", "bearish", "neutral" as standalone words near end
    const lastChunk = text.slice(-300).toLowerCase();
    if (/\bbullish\b/.test(lastChunk) && !/\bbearish\b/.test(lastChunk)) {
      const conf = confMatch ? Math.min(10, Math.max(1, parseInt(confMatch[1], 10))) : 5;
      return { rating: 'BULLISH', confidence: conf };
    }
    if (/\bbearish\b/.test(lastChunk) && !/\bbullish\b/.test(lastChunk)) {
      const conf = confMatch ? Math.min(10, Math.max(1, parseInt(confMatch[1], 10))) : 5;
      return { rating: 'BEARISH', confidence: conf };
    }
    if (/\bneutral\b/.test(lastChunk)) {
      const conf = confMatch ? Math.min(10, Math.max(1, parseInt(confMatch[1], 10))) : 5;
      return { rating: 'NEUTRAL', confidence: conf };
    }

    // Strategy 4: Count occurrences of bullish vs bearish throughout the text
    const fullLower = text.toLowerCase();
    const bullCount = (fullLower.match(/\bbullish\b/g) || []).length;
    const bearCount = (fullLower.match(/\bbearish\b/g) || []).length;
    if (bullCount > bearCount && bullCount > 0) {
      return { rating: 'BULLISH', confidence: confMatch ? parseInt(confMatch[1], 10) : 4 };
    }
    if (bearCount > bullCount && bearCount > 0) {
      return { rating: 'BEARISH', confidence: confMatch ? parseInt(confMatch[1], 10) : 4 };
    }

    // Strategy 5: Look for buy/sell/positive/negative sentiment words
    const buyWords = (fullLower.match(/\b(buy|upside|opportunity|undervalued|strong)\b/g) || []).length;
    const sellWords = (fullLower.match(/\b(sell|downside|overvalued|risk|weak|decline)\b/g) || []).length;
    if (buyWords > sellWords + 2) return { rating: 'BULLISH', confidence: 3 };
    if (sellWords > buyWords + 2) return { rating: 'BEARISH', confidence: 3 };

    return { rating: 'NEUTRAL', confidence: 3 };
  }

  /**
   * Extract VERDICT from a risk manager report with fallbacks.
   */
  _extractVerdict(review) {
    if (!review || typeof review !== 'string') {
      return { verdict: 'N/A', riskLevel: 'N/A' };
    }

    // Strategy 1: Exact format
    const exactMatch = review.match(/VERDICT:\s*(APPROVE|REJECT)\s*\|\s*RISK_LEVEL:\s*(LOW|MEDIUM|HIGH)/i);
    if (exactMatch) {
      return { verdict: exactMatch[1].toUpperCase(), riskLevel: exactMatch[2].toUpperCase() };
    }

    // Strategy 2: VERDICT line anywhere
    const verdictMatch = review.match(/VERDICT:\s*(APPROVE|REJECT)/i);
    const riskMatch = review.match(/RISK.?LEVEL:\s*(LOW|MEDIUM|HIGH)/i);
    if (verdictMatch) {
      return {
        verdict: verdictMatch[1].toUpperCase(),
        riskLevel: riskMatch ? riskMatch[1].toUpperCase() : 'MEDIUM',
      };
    }

    // Strategy 3: Look for approve/reject keywords
    const lower = review.toLowerCase();
    const lastPart = lower.slice(-200);
    if (/\bapprove\b/.test(lastPart) || /\bapproved\b/.test(lastPart)) {
      return { verdict: 'APPROVE', riskLevel: riskMatch ? riskMatch[1].toUpperCase() : 'MEDIUM' };
    }
    if (/\breject\b/.test(lastPart) || /\brejected\b/.test(lastPart)) {
      return { verdict: 'REJECT', riskLevel: riskMatch ? riskMatch[1].toUpperCase() : 'HIGH' };
    }

    // Strategy 4: Sentiment-based inference
    const approveWords = (lower.match(/\b(approve|acceptable|proceed|favorable|recommend)\b/g) || []).length;
    const rejectWords = (lower.match(/\b(reject|unacceptable|avoid|too risky|caution)\b/g) || []).length;
    if (approveWords > rejectWords) return { verdict: 'APPROVE', riskLevel: 'MEDIUM' };
    if (rejectWords > approveWords) return { verdict: 'REJECT', riskLevel: 'HIGH' };

    return { verdict: 'APPROVE', riskLevel: 'MEDIUM' }; // Default to approve if unclear
  }

  /** Infer signal from text when regex parsing fails */
  _inferSignal(text) {
    if (!text) return 'HOLD';
    const lower = text.toLowerCase();
    // Check for explicit decision words
    if (/\b(strong buy|buy signal|recommend buying)\b/.test(lower)) return 'BUY';
    if (/\b(strong sell|sell signal|recommend selling)\b/.test(lower)) return 'SELL';
    // Count sentiment
    const buyWords = (lower.match(/\b(buy|long|bullish|upside)\b/g) || []).length;
    const sellWords = (lower.match(/\b(sell|short|bearish|downside)\b/g) || []).length;
    if (buyWords > sellWords + 1) return 'BUY';
    if (sellWords > buyWords + 1) return 'SELL';
    return 'HOLD';
  }

  /** Extract a summary sentence from unstructured text */
  _extractSummary(text) {
    if (!text) return 'Analysis complete.';
    // Take the first substantive sentence
    const sentences = text.split(/[.!]\s+/).filter(s => s.length > 20 && !s.startsWith('SIGNAL') && !s.startsWith('CONFIDENCE'));
    return sentences.length > 0 ? sentences[0].trim().slice(0, 300) + '.' : text.slice(0, 300);
  }

  // ── Discord Formatting ────────────────────────────────────────────────

  formatForDiscord(result) {
    const emoji = { BUY: '🟢', SELL: '🔴', HOLD: '🟡' };
    const sig = result.signal || 'HOLD';
    const conf = result.confidence || 5;
    const confBar = '█'.repeat(conf) + '░'.repeat(10 - conf);

    const lines = [
      `${emoji[sig] || '🟡'} **TradingAgents Analysis: ${result.ticker}** ${emoji[sig] || '🟡'}`,
      '',
      `**Signal: ${sig}** | Confidence: ${conf}/10 [${confBar}]`,
      '',
      `> ${result.summary || 'Analysis complete.'}`,
      '',
    ];

    // Analyst ratings summary — use robust extraction
    lines.push('**Analyst Ratings:**');
    for (const [name, report] of Object.entries(result.analysts)) {
      const { rating, confidence } = this._extractRating(report);
      const rEmoji = { BULLISH: '🟢', BEARISH: '🔴', NEUTRAL: '🟡' };
      lines.push(`  ${rEmoji[rating] || '⚪'} **${name.charAt(0).toUpperCase() + name.slice(1)}:** ${rating} (${confidence}/10)`);
    }

    // Bull/Bear summary
    lines.push('');
    lines.push('**Debate:**');
    const bullSnippet = (result.debate.bull || '').split('\n').find(l => l.trim().length > 10) || result.debate.bull || '(no bull case)';
    const bearSnippet = (result.debate.bear || '').split('\n').find(l => l.trim().length > 10) || result.debate.bear || '(no bear case)';
    lines.push(`  🐂 Bull: ${bullSnippet.slice(0, 150)}${bullSnippet.length > 150 ? '...' : ''}`);
    lines.push(`  🐻 Bear: ${bearSnippet.slice(0, 150)}${bearSnippet.length > 150 ? '...' : ''}`);

    // Risk verdicts — use robust extraction
    lines.push('');
    lines.push('**Risk Committee:**');
    for (const [style, review] of Object.entries(result.risk)) {
      const { verdict, riskLevel } = this._extractVerdict(review);
      const vEmoji = verdict === 'APPROVE' ? '✅' : verdict === 'REJECT' ? '❌' : '❓';
      lines.push(`  ${vEmoji} **${style.charAt(0).toUpperCase() + style.slice(1)}:** ${verdict} (Risk: ${riskLevel})`);
    }

    // Data sources
    if (result.dataSources && result.dataSources.length > 0) {
      lines.push('');
      const sourceIcons = result.dataSources.map(s => {
        if (s.startsWith('ainvest')) return '📊';
        if (s === 'live-price') return '💹';
        return '📈';
      });
      lines.push(`_Data: ${result.dataSources.length} sources | ${[...new Set(sourceIcons)].join('')}_`);
    }

    lines.push('');
    lines.push(`_Multi-agent analysis via TradingAgents | ${new Date().toLocaleString()}_`);

    let output = lines.join('\n');
    if (output.length > 1950) {
      output = output.slice(0, 1950) + '\n...';
    }
    return output;
  }

  /**
   * Format a detailed report (for follow-up messages or file upload).
   */
  formatDetailedReport(result) {
    const sections = [
      `# TradingAgents Deep Analysis: ${result.ticker}`,
      `Signal: ${result.signal} | Confidence: ${result.confidence}/10`,
      `Generated: ${result.timestamp}`,
      `Data Sources: ${(result.dataSources || []).join(', ')}`,
      '',
      '## Summary',
      result.summary,
      '',
      '## Market/Technical Analysis',
      result.analysts.market,
      '',
      '## Fundamental Analysis',
      result.analysts.fundamentals,
      '',
      '## Sentiment Analysis',
      result.analysts.sentiment,
      '',
      '## News/Macro Analysis',
      result.analysts.news,
      '',
      '## Bull Case',
      result.debate.bull,
      '',
      '## Bear Case',
      result.debate.bear,
      '',
      '## Trader Decision',
      result.trader,
      '',
      '## Risk Management',
      '### Aggressive Risk Manager',
      result.risk.aggressive,
      '',
      '### Moderate Risk Manager',
      result.risk.moderate,
      '',
      '### Conservative Risk Manager',
      result.risk.conservative,
    ];

    return sections.join('\n');
  }
}

module.exports = new TradingAgents();
