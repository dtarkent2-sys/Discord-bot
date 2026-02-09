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
 */

const { Ollama } = require('ollama');
const config = require('../config');
const yahoo = require('./yahoo');
const { getMarketContext, formatContextForAI } = require('../data/market');

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
   * @returns {{ signal, confidence, summary, analysts, debate, trader, risk, ticker, timestamp }}
   */
  async analyze(ticker, onProgress) {
    const upper = ticker.toUpperCase();
    const progress = onProgress || (() => {});

    // ── Stage 0: Fetch market data ──
    progress('data', `Fetching market data for ${upper}...`);
    const context = await getMarketContext(upper);
    if (context.error) {
      throw new Error(`Cannot fetch data for ${upper}: ${context.message}`);
    }
    const marketData = formatContextForAI(context);
    const snapshot = context.snapshot || {};

    // ── Stage 1: Four analysts in parallel ──
    progress('analysts', 'Running analyst agents (market, fundamentals, sentiment, news)...');
    const [marketReport, fundReport, sentimentReport, newsReport] = await Promise.all([
      this._marketAnalyst(upper, marketData, snapshot),
      this._fundamentalsAnalyst(upper, marketData, snapshot),
      this._sentimentAnalyst(upper, marketData, snapshot),
      this._newsAnalyst(upper, marketData, snapshot),
    ]);

    const analystReports = {
      market: marketReport,
      fundamentals: fundReport,
      sentiment: sentimentReport,
      news: newsReport,
    };

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
      timestamp: new Date().toISOString(),
    };
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

Provide a concise technical analysis report (150-200 words). End with a clear BULLISH, BEARISH, or NEUTRAL rating with a confidence score 1-10.

Format your final line exactly as: RATING: [BULLISH/BEARISH/NEUTRAL] | CONFIDENCE: [1-10]`;

    return this._llmCall(prompt);
  }

  async _fundamentalsAnalyst(ticker, marketData, snapshot) {
    const prompt = `You are a senior fundamentals analyst at a top investment firm. Analyze ${ticker} using ONLY the data provided below. Focus on:
- Valuation metrics (P/E, Forward P/E, P/B) — are they reasonable for the sector?
- Profitability (EPS, profit margins, ROE)
- Growth indicators (revenue growth)
- Dividend yield and income potential
- Beta and risk characteristics
- Market cap and company size implications

MARKET DATA:
${marketData}

Provide a concise fundamental analysis report (150-200 words). End with a clear BULLISH, BEARISH, or NEUTRAL rating with a confidence score 1-10.

Format your final line exactly as: RATING: [BULLISH/BEARISH/NEUTRAL] | CONFIDENCE: [1-10]`;

    return this._llmCall(prompt);
  }

  async _sentimentAnalyst(ticker, marketData, snapshot) {
    const changePercent = snapshot.changePercent;
    const volume = snapshot.volume;
    const rsi = snapshot.rsi14;
    const price = snapshot.price;
    const high52 = snapshot.fiftyTwoWeekHigh;
    const low52 = snapshot.fiftyTwoWeekLow;

    const prompt = `You are a market sentiment analyst specializing in reading market psychology. Analyze ${ticker} sentiment using the data below. Consider:
- Daily price change direction and magnitude as a sentiment signal
- RSI as a crowd sentiment indicator (extreme readings = extreme sentiment)
- How current price relates to 52-week range (near highs = optimism, near lows = fear)
- Volume as a conviction indicator
- Overall market mood implied by the data

MARKET DATA:
${marketData}

Provide a concise sentiment analysis report (150-200 words). Assess whether crowd sentiment is greedy, fearful, or balanced. End with a clear BULLISH, BEARISH, or NEUTRAL rating with a confidence score 1-10.

Format your final line exactly as: RATING: [BULLISH/BEARISH/NEUTRAL] | CONFIDENCE: [1-10]`;

    return this._llmCall(prompt);
  }

  async _newsAnalyst(ticker, marketData, snapshot) {
    const prompt = `You are a financial news analyst at a major trading desk. Using ONLY the live market data provided below, assess the macro environment and potential catalysts for ${ticker}. Consider:
- What the price action and data suggest about recent sentiment
- Macro-economic factors visible in the data (beta, volume trends, market cap changes)
- Sector positioning based on the available metrics
- Potential upcoming catalysts based on the company's profile
- Risk factors visible in the data

MARKET DATA:
${marketData}

IMPORTANT: Base your analysis ONLY on the data above and general industry knowledge. Do NOT cite specific news articles, events, or dates unless they appear in the data. Provide a concise news/macro analysis report (150-200 words). End with a clear BULLISH, BEARISH, or NEUTRAL rating with a confidence score 1-10.

Format your final line exactly as: RATING: [BULLISH/BEARISH/NEUTRAL] | CONFIDENCE: [1-10]`;

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

Present your bull case in 150-200 words. Cite specific data points. Acknowledge risks but explain why the opportunity outweighs them. Be persuasive and specific.`;

    const bullCase = await this._llmCall(bullPrompt);

    // Bear makes the case
    const bearPrompt = `You are a BEAR advocate in a trading firm debate about ${ticker}. You must argue AGAINST buying this stock.

Review these analyst reports and the market data, then make the STRONGEST possible bear case:

${analystSummary}

MARKET DATA:
${marketData}

The bull argued:
${bullCase}

Present your bear case in 150-200 words. Counter the bull's arguments with specific data. Highlight risks, overvaluation concerns, and warning signs. Be persuasive and specific.`;

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
DECISION: [BUY/SELL/HOLD] | CONFIDENCE: [1-10] | TIMEFRAME: [short-term/medium-term/long-term]`;

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

Keep your review to 100-150 words. End with:
VERDICT: [APPROVE/REJECT] | RISK_LEVEL: [LOW/MEDIUM/HIGH]`;

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
SIGNAL: [BUY/SELL/HOLD]
CONFIDENCE: [1-10]
SUMMARY: [2-3 sentence summary of the rationale]`;

    const response = await this._llmCall(prompt);

    // Parse the structured response
    return this._parseSignal(response);
  }

  // ── LLM Call Helper ───────────────────────────────────────────────────

  async _llmCall(prompt) {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const systemMsg = `Today is ${today}. Your training data cuts off around mid-2024 — the current date is REAL and may be well beyond that. You are analyzing LIVE market data provided in the prompt. Use ONLY the data given — do not reference outdated prices, events, or conditions from your training data. All prices, metrics, and market conditions in the prompt are current as of today. Never mention "knowledge cutoff" — just use the live data.`;

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
        result += part.message.content;
      }
      return result;
    } catch (err) {
      console.error('[TradingAgents] LLM call error:', err.message);
      return `Analysis unavailable: ${err.message}`;
    }
  }

  // ── Response Parsing ──────────────────────────────────────────────────

  _parseSignal(response) {
    const signalMatch = response.match(/SIGNAL:\s*(BUY|SELL|HOLD)/i);
    const confMatch = response.match(/CONFIDENCE:\s*(\d+)/i);
    const summaryMatch = response.match(/SUMMARY:\s*(.+)/is);

    return {
      signal: signalMatch ? signalMatch[1].toUpperCase() : 'HOLD',
      confidence: confMatch ? parseInt(confMatch[1], 10) : 5,
      summary: summaryMatch ? summaryMatch[1].trim() : response.trim(),
    };
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
      `> ${result.summary}`,
      '',
    ];

    // Analyst ratings summary
    lines.push('**Analyst Ratings:**');
    for (const [name, report] of Object.entries(result.analysts)) {
      const ratingMatch = report.match(/RATING:\s*(BULLISH|BEARISH|NEUTRAL)/i);
      const rating = ratingMatch ? ratingMatch[1] : 'N/A';
      const rEmoji = { BULLISH: '🟢', BEARISH: '🔴', NEUTRAL: '🟡' };
      lines.push(`  ${rEmoji[rating] || '⚪'} **${name.charAt(0).toUpperCase() + name.slice(1)}:** ${rating}`);
    }

    // Bull/Bear summary
    lines.push('');
    lines.push('**Debate:**');
    const bullSnippet = result.debate.bull.split('\n')[0].slice(0, 120);
    const bearSnippet = result.debate.bear.split('\n')[0].slice(0, 120);
    lines.push(`  🐂 Bull: ${bullSnippet}...`);
    lines.push(`  🐻 Bear: ${bearSnippet}...`);

    // Risk verdicts
    lines.push('');
    lines.push('**Risk Committee:**');
    for (const [style, review] of Object.entries(result.risk)) {
      const verdictMatch = review.match(/VERDICT:\s*(APPROVE|REJECT)/i);
      const verdict = verdictMatch ? verdictMatch[1] : 'N/A';
      const vEmoji = verdict === 'APPROVE' ? '✅' : verdict === 'REJECT' ? '❌' : '❓';
      lines.push(`  ${vEmoji} **${style.charAt(0).toUpperCase() + style.slice(1)}:** ${verdict}`);
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
