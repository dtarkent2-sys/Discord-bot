const ai = require('../services/ai');
const memory = require('../services/memory');
const mood = require('../services/mood');
const stats = require('../services/stats');
const reactions = require('../services/reactions');
const sentiment = require('../services/sentiment');
const yahoo = require('../services/yahoo');
const alpaca = require('../services/alpaca');
const tradingAgents = require('../services/trading-agents');
const agentSwarm = require('../services/agent-swarm');
const gamma = require('../services/gamma');
const GEXEngine = require('../services/gex-engine');
const GEXAlertService = require('../services/gex-alerts');
const technicals = require('../services/technicals');
const stocktwits = require('../services/stocktwits');
const mahoraga = require('../services/mahoraga');
const stream = require('../services/stream');
const kalshi = require('../services/kalshi');
const ainvest = require('../services/ainvest');
const reddit = require('../services/reddit');
const validea = require('../services/validea');
const macro = require('../services/macro');
const sectors = require('../services/sectors');
const policy = require('../services/policy');
const optionsEngine = require('../services/options-engine');
const initiative = require('../services/initiative');
const gammaSqueeze = require('../services/gamma-squeeze');
const gammaHeatmap = require('../services/gamma-heatmap');
const gammaSetups = require('../services/gamma-setups');
const yoloMode = require('../services/yolo-mode');
const channelHistory = require('../services/channel-history');
let algoTrading = null;
try { algoTrading = require('../services/algo-trading'); } catch { /* algo-trading not available */ }
const mlPredictor = require('../services/ml-predictor');
const mlPortfolio = require('../services/ml-portfolio');
const { AttachmentBuilder, MessageFlags, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getMarketContext, formatContextForAI } = require('../data/market');
const config = require('../config');
const { instrumentInteraction } = require('../utils/safe-send');

async function handleCommand(interaction) {
  // Instrument all outbound interaction methods (reply, editReply, followUp, deferReply)
  // with diagnostic logging so we can trace send failures.
  instrumentInteraction(interaction);

  const { commandName } = interaction;
  stats.recordCommand();

  switch (commandName) {
    case 'ask':
      return handleAsk(interaction);
    case 'memory':
      return handleMemory(interaction);
    case 'model':
      return handleModel(interaction);
    case 'stats':
      return handleStats(interaction);
    case 'analyze':
      return handleAnalyze(interaction);
    case 'price':
      return handlePrice(interaction);
    case 'screen':
      return handleScreen(interaction);
    case 'help':
      return handleHelp(interaction);
    case 'sentiment':
      return handleSentiment(interaction);
    case 'topic':
      return handleTopic(interaction);
    case 'watchlist':
      return handleWatchlist(interaction);
    case 'profile':
      return handleProfile(interaction);
    case 'deepanalysis':
      return handleDeepAnalysis(interaction);
    case 'research':
      return handleResearch(interaction);
    case 'gex':
      return handleGEX(interaction);
    case 'news':
      return handleNews(interaction);
    case 'technicals':
      return handleTechnicals(interaction);
    case 'social':
      return handleSocial(interaction);
    case 'trending':
      return handleTrending(interaction);
    case 'reddit':
      return handleReddit(interaction);
    case 'validea':
      return handleValidea(interaction);
    case 'macro':
      return handleMacro(interaction);
    case 'sectors':
      return handleSectors(interaction);
    case 'agent':
      return handleAgent(interaction);
    case 'stream':
      return handleStream(interaction);
    case 'predict':
      return handlePredict(interaction);
    case 'odds':
      return handleOdds(interaction);
    case 'bets':
      return handleBets(interaction);
    case 'flow':
      return handleFlow(interaction);
    case 'whales':
      return handleWhales(interaction);
    case 'options':
      return handleOptions(interaction);
    case 'brain':
      return handleBrain(interaction);
    case 'squeeze':
      return handleSqueeze(interaction);
    case 'yolo':
      return handleYolo(interaction);
    case 'ingest':
      return handleIngest(interaction);
    case 'algo':
      return handleAlgo(interaction);
    case 'mlpredict':
      return handleMLPredict(interaction);
    case 'mlportfolio':
      return handleMLPortfolio(interaction);
    case 'gammasetups':
      return handleGammaSetups(interaction);
    default:
      await interaction.reply({ content: 'Unknown command.', flags: MessageFlags.Ephemeral });
  }
}

async function handleAsk(interaction) {
  await interaction.deferReply();

  try {
    const question = interaction.options.getString('question');
    const userId = interaction.user.id;
    const username = interaction.user.username;

    const sentimentResult = sentiment.track(userId, question);
    const response = await ai.chat(userId, username, question, { sentiment: sentimentResult });

    await interaction.editReply(response);
  } catch (err) {
    console.error('[Ask] Error:', err);
    await interaction.editReply('Something went wrong processing your question. Try again in a moment.').catch(() => {});
  }
}

async function handleMemory(interaction) {
  try {
    const userId = interaction.user.id;
    const userData = memory.getUser(userId);
    const sentimentStats = sentiment.getStats(userId);
    const reactionStats = reactions.getUserStats(userId);

    const parts = [`**What I remember about you, ${interaction.user.username}:**\n`];

    if (userData.facts.length > 0) {
      parts.push(`**Facts:** ${userData.facts.join(', ')}`);
    } else {
      parts.push("I don't have any specific facts about you yet. Chat with me more!");
    }

    parts.push(`**Interactions:** ${userData.interactionCount}`);

    if (userData.firstSeen) {
      parts.push(`**First seen:** ${new Date(userData.firstSeen).toLocaleDateString()}`);
    }

    const frequentTickers = memory.getFrequentTickers(userId);
    if (frequentTickers.length > 0) {
      parts.push(`\n**Your favorite tickers:** ${frequentTickers.map(f => `${f.ticker} (${f.count}x)`).join(', ')}`);
    }
    const lastInteraction = memory.getLastInteraction(userId);
    if (lastInteraction && lastInteraction.tickers.length > 0) {
      parts.push(`**Last discussed:** ${lastInteraction.tickers.join(', ')}${lastInteraction.topic ? ` (${lastInteraction.topic})` : ''}`);
    }

    parts.push(`\n**Sentiment:** ${sentimentStats.label} (trend: ${sentimentStats.trend})`);
    parts.push(`**Feedback:** ${reactionStats.thumbsUp} 👍 / ${reactionStats.thumbsDown} 👎`);

    if (Object.keys(userData.preferences).length > 0) {
      const prefs = Object.entries(userData.preferences)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      parts.push(`**Preferences:** ${prefs}`);
    }

    await interaction.reply({ content: parts.join('\n'), flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error('[Memory] Error:', err);
    await interaction.reply({ content: 'Could not retrieve your memory data right now.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

async function handleModel(interaction) {
  try {
    const modelName = interaction.options.getString('name');
    const oldModel = ai.getModel();
    ai.setModel(modelName);
    tradingAgents.setModel(modelName);
    agentSwarm.setModel(modelName);
    kalshi.setModel(modelName);

    await interaction.reply(`Switched AI model: **${oldModel}** → **${modelName}** (chat + deep analysis + research + predictions)`);
  } catch (err) {
    console.error('[Model] Error:', err);
    await interaction.reply({ content: 'Failed to switch model.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

async function handleStats(interaction) {
  try {
    const summary = stats.getSummary();
    const reactionStats = reactions.getStats();

    const msg = [
      '**Bot Statistics**\n',
      `**Uptime:** ${summary.uptime}`,
      `**Servers:** ${summary.guilds}`,
      `**Messages processed:** ${summary.messagesProcessed}`,
      `**Commands run:** ${summary.commandsRun}`,
      `**Errors:** ${summary.errors}`,
      `**AI Model:** ${ai.getModel()}`,
      `**Mood:** ${mood.getMood()} (${mood.getSummary().score}/10)`,
      `**Market Data:** ${buildMarketDataLabel()}`,
      `\n**Memory Usage:**`,
      `  RSS: ${summary.memory.rss} MB`,
      `  Heap: ${summary.memory.heapUsed}/${summary.memory.heapTotal} MB`,
      `\n**Reaction Feedback:**`,
      `  Total: ${reactionStats.total} (${reactionStats.ratio}% positive)`,
      `  👍 ${reactionStats.positive} / 👎 ${reactionStats.negative}`,
    ];

    if (reactionStats.patterns.length > 0) {
      msg.push('\n**Top Successful Topics:**');
      for (const p of reactionStats.patterns.slice(0, 5)) {
        msg.push(`  • ${p.topic} (${p.ratio}% positive, ${p.count} interactions)`);
      }
    }

    await interaction.reply(msg.join('\n'));
  } catch (err) {
    console.error('[Stats] Error:', err);
    await interaction.reply({ content: 'Could not retrieve bot statistics.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

// ── /analyze — AI-powered analysis with live market data ─────────────
async function handleAnalyze(interaction) {
  await interaction.deferReply();

  const ticker = yahoo.resolveTicker(interaction.options.getString('ticker'));

  try {
    // Fetch real market data from the preferred provider
    const context = await getMarketContext(ticker);

    if (context.error) {
      await interaction.editReply(`**Cannot analyze ${ticker}**\n${context.message}`);
      return;
    }

    // Format the data and send to AI for analysis
    const liveData = formatContextForAI(context);

    const response = await ai.chat(
      interaction.user.id,
      interaction.user.username,
      `Analyze ${ticker} for me. Give me the key takeaways from this data, technical outlook, and whether it looks like a good setup. Include the actual numbers from the data.`,
      { liveData }
    );

    await interaction.editReply(response);
  } catch (err) {
    console.error(`[Analyze] Error for ${ticker}:`, err);
    await interaction.editReply(`**${ticker} — Analysis Failed**\n${err.message}`);
  }
}

// ── /price — Quick price + stats lookup ─────────────────────────────
async function handlePrice(interaction) {
  await interaction.deferReply();

  const ticker = yahoo.resolveTicker(interaction.options.getString('ticker'));

  try {
    const context = await getMarketContext(ticker);

    if (context.error) {
      await interaction.editReply(`Could not fetch data for **${ticker}**: ${context.message}`);
      return;
    }

    const q = context.quote || {};
    const s = context.snapshot || {};

    const lines = [`**${ticker}**${s.name ? ` — ${s.name}` : ''} — Quick Stats\n`];
    if (q.price) lines.push(`**Price:** $${q.price}`);
    if (q.volume) lines.push(`**Volume:** ${Number(q.volume).toLocaleString()}`);
    if (q.mktCap) lines.push(`**Market Cap:** $${(q.mktCap / 1e9).toFixed(2)}B`);
    if (q.pe) lines.push(`**P/E:** ${q.pe}`);
    if (s.forwardPE) lines.push(`**Forward P/E:** ${s.forwardPE}`);
    if (s.pb) lines.push(`**P/B:** ${s.pb}`);
    if (s.eps) lines.push(`**EPS:** $${s.eps}`);
    if (s.divYield) lines.push(`**Div Yield:** ${s.divYield.toFixed(2)}%`);
    if (s.roe) lines.push(`**ROE:** ${s.roe.toFixed(2)}%`);
    if (s.beta) lines.push(`**Beta:** ${s.beta}`);
    if (q.changePercent != null) lines.push(`**Daily Change:** ${q.changePercent > 0 ? '+' : ''}${q.changePercent.toFixed(2)}%`);
    if (q.rsi14) lines.push(`**RSI(14):** ${q.rsi14}`);
    if (q.sma50) lines.push(`**SMA(50):** $${q.sma50}`);
    if (q.sma200) lines.push(`**SMA(200):** $${q.sma200}`);
    if (s.fiftyTwoWeekHigh) lines.push(`**52W High:** $${s.fiftyTwoWeekHigh}`);
    if (s.fiftyTwoWeekLow) lines.push(`**52W Low:** $${s.fiftyTwoWeekLow}`);
    if (s.profitMargin) lines.push(`**Profit Margin:** ${s.profitMargin.toFixed(2)}%`);
    if (s.revenueGrowth) lines.push(`**Revenue Growth:** ${s.revenueGrowth.toFixed(2)}%`);

    if (context.missingFields) {
      lines.push(`\n_Some data unavailable: ${context.missingFields.map(m => m.field).join(', ')}_`);
    }

    lines.push(`\n_Data via ${context.source || 'FMP'} | ${new Date().toLocaleString()}_`);
    await interaction.editReply(lines.join('\n'));
  } catch (err) {
    console.error(`[Price] Error for ${ticker}:`, err);
    await interaction.editReply(`Error fetching data for **${ticker}**: ${err.message}`);
  }
}

// ── /screen — Run a stock screen (trending) ─────────────────────────
async function handleScreen(interaction) {
  await interaction.deferReply();

  const universe = interaction.options.getString('universe');
  const rulesStr = interaction.options.getString('rules');

  try {
    // Use FMP top gainers as a screen
    const quotes = await yahoo.screenByGainers();

    if (quotes.length === 0) {
      await interaction.editReply('No screen results available right now. Try again later.');
      return;
    }

    const formatted = yahoo.formatScreenForDiscord(quotes);
    await interaction.editReply(`**Screen: ${universe}**${rulesStr ? ` | Rules: ${rulesStr}` : ''}\n${formatted}\n\n_Top gainers via FMP_`);
  } catch (err) {
    console.error(`[Screen] Error:`, err);
    await interaction.editReply(`Screen failed: ${err.message}`);
  }
}

// ── /help — List all available commands ──────────────────────────────
async function handleHelp(interaction) {
  const lines = [
    '**Commands**',
    '`/ask` — Chat with AI | `/analyze` `/deepanalysis` — Stock analysis',
    '`/price` — Quick quote | `/technicals` — RSI, MACD, Bollinger',
    '`/macro` — Market regime | `/sectors` — Sector rotation | `/validea` — Guru scores',
    '`/gex` — Gamma exposure | `/gammasetups` — Find good gamma setups | `/news` — Market news',
    '`/research` — Agent Swarm research | `/screen` — Stock screener',
    '`/social` `/trending` — StockTwits | `/reddit` — Reddit sentiment',
    '`/watchlist` — Manage watchlist | `/sentiment` — Text analysis',
    '`/stream start|stop|list|status` — Live Alpaca WebSocket data',
    '`/memory` `/profile` `/stats` `/model` `/topic`',
    '',
    '**Prediction Markets (Kalshi)**',
    '`/predict <topic>` — Search markets + AI betting picks',
    '`/odds <ticker>` — Deep dive on a market with AI probability analysis',
    '`/bets [category]` — Browse trending/categorized prediction markets',
    '',
    '**Market Intelligence (AInvest)**',
    '`/flow <ticker>` — Smart money flow (insider + congress trades)',
    '`/whales <ticker>` — Full intelligence dashboard (analysts + fundamentals + insider + congress)',
    '',
    '**YOLO Mode (Self-Improvement)**',
    '`/yolo status` — See YOLO mode state | `/yolo enable|disable` — Toggle',
    '`/yolo run` — Manual improvement cycle | `/yolo history` `/yolo logs`',
    '',
    '**SHARK Agent**',
    '`/agent status` — Positions, risk, P/L',
    '`/agent config` — View settings | `/agent set` — Change settings',
    '`/agent dangerous` — Toggle aggressive trading mode',
    '`/agent enable|disable|kill|reset|logs`',
    '',
    '**Memory**',
    '`/ingest [#channel]` — Read channel history into long-term memory',
    '',
    '**Owner:** `!update` `!suggest` `!autoedit` `!rollback` `!selfheal`',
    'Mention me or DM me to chat! React 👍/👎 on replies so I learn.',
  ];

  await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
}

// ── /news — Alpaca news ──────────────────────────────────────────────
async function handleNews(interaction) {
  await interaction.deferReply();

  if (!alpaca.enabled) {
    await interaction.editReply('Alpaca news requires `ALPACA_API_KEY` and `ALPACA_API_SECRET` in your .env.');
    return;
  }

  const symbolsInput = interaction.options.getString('symbols');
  const limit = interaction.options.getInteger('limit') ?? 5;

  const symbols = symbolsInput
    ? symbolsInput.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : [];

  try {
    const news = await alpaca.getNews({ symbols, limit });

    if (!news || news.length === 0) {
      await interaction.editReply('No news articles found. Try a different symbol or check back later.');
      return;
    }

    const headerSymbols = symbols.length > 0 ? ` for ${symbols.join(', ')}` : '';
    const lines = [`**Market News${headerSymbols}**`];

    for (const item of news) {
      const headline = item.headline || item.title || 'Untitled';
      const source = item.source || 'Alpaca News';
      const createdAt = item.created_at || item.createdAt || item.time;
      const dateLabel = createdAt ? new Date(createdAt).toLocaleString() : 'Unknown time';
      const summary = item.summary || item.description || '';
      const shortSummary = summary.length > 220 ? `${summary.slice(0, 220)}...` : summary;
      const articleSymbols = Array.isArray(item.symbols) ? item.symbols.join(', ') : '';

      lines.push(`\n**${headline}**`);
      lines.push(`${source} — ${dateLabel}${articleSymbols ? ` — ${articleSymbols}` : ''}`);
      if (item.url) lines.push(`<${item.url}>`);
      if (shortSummary) lines.push(shortSummary);
    }

    lines.push(`\n_Data via Alpaca | ${new Date().toLocaleString()}_`);
    await interaction.editReply(lines.join('\n'));
  } catch (err) {
    console.error('[News] Error:', err);
    await interaction.editReply(`News lookup failed: ${err.message}`);
  }
}

// ── /sentiment — Analyze text sentiment ─────────────────────────────
async function handleSentiment(interaction) {
  try {
    const text = interaction.options.getString('text');
    const result = sentiment.analyze(text);

    const lines = [
      `**Sentiment Analysis**`,
      `**Text:** ${text.length > 200 ? text.slice(0, 200) + '...' : text}`,
      `**Result:** ${result.label}`,
      `**Score:** ${result.score} (comparative: ${result.comparative.toFixed(3)})`,
    ];
    if (result.positive.length > 0) {
      lines.push(`**Positive words:** ${result.positive.join(', ')}`);
    }
    if (result.negative.length > 0) {
      lines.push(`**Negative words:** ${result.negative.join(', ')}`);
    }

    await interaction.reply(lines.join('\n'));
  } catch (err) {
    console.error('[Sentiment] Error:', err);
    await interaction.reply({ content: 'Sentiment analysis failed.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

// ── /topic — Generate an AI discussion topic ────────────────────────
async function handleTopic(interaction) {
  await interaction.deferReply();

  try {
    const response = await ai.complete(
      'Generate a single interesting discussion topic for a stock trading Discord server. ' +
      'It can be about markets, trading strategies, economic trends, a specific sector, ' +
      'or a thought-provoking investing question. Keep it to 1-2 sentences. ' +
      'Just output the topic, no labels or prefixes.'
    );

    if (!response) {
      await interaction.editReply('Could not generate a topic right now. Try again later!');
      return;
    }

    await interaction.editReply(`**Discussion Topic:**\n${response}`);
  } catch (err) {
    console.error('[Topic] Error:', err);
    await interaction.editReply('Could not generate a topic right now. Try again later.');
  }
}

// ── /watchlist — Manage personal watchlist ───────────────────────────
async function handleWatchlist(interaction) {
  const action = interaction.options.getString('action') || 'show';
  const ticker = interaction.options.getString('ticker');
  const userId = interaction.user.id;

  if (action === 'add') {
    if (!ticker) {
      await interaction.reply({ content: 'Please provide a ticker to add. Example: `/watchlist add AAPL` or `/watchlist add BTC`', flags: MessageFlags.Ephemeral });
      return;
    }
    const resolved = yahoo.resolveTicker(ticker);
    const list = memory.addToWatchlist(userId, resolved);
    await interaction.reply(`Added **${resolved}** to your watchlist. (${list.length} total)`);
    return;
  }

  if (action === 'remove') {
    if (!ticker) {
      await interaction.reply({ content: 'Please provide a ticker to remove. Example: `/watchlist remove AAPL`', flags: MessageFlags.Ephemeral });
      return;
    }
    const resolved = yahoo.resolveTicker(ticker);
    const list = memory.removeFromWatchlist(userId, resolved);
    await interaction.reply(`Removed **${resolved}** from your watchlist. (${list.length} remaining)`);
    return;
  }

  // Show watchlist with live prices
  const list = memory.getWatchlist(userId);
  if (list.length === 0) {
    await interaction.reply({ content: 'Your watchlist is empty. Use `/watchlist add <ticker>` to add stocks.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();
  try {
    const contexts = await Promise.all(
      list.map(async (symbol) => {
        try {
          const context = await getMarketContext(symbol);
          return { symbol, context };
        } catch (err) {
          return { symbol, context: { error: true, message: err.message } };
        }
      })
    );

    const validQuotes = contexts.filter(({ context }) => context && !context.error && context.quote?.price != null);
    if (validQuotes.length > 0) {
      const lines = [`**Your Watchlist (${list.length} stocks)**\n`];
      const sources = new Set();

      for (const { symbol, context } of validQuotes) {
        const q = context.quote || {};
        const s = context.snapshot || {};
        const price = q.price != null ? `$${q.price.toFixed(2)}` : 'N/A';
        const pct = q.changePercent;
        const changeStr = pct != null ? ` (${pct > 0 ? '+' : ''}${pct.toFixed(2)}%)` : '';
        const name = s.name || '';
        lines.push(`**${symbol}** ${name ? `— ${name} ` : ''}— ${price}${changeStr}`);
        if (context.source) sources.add(context.source);
      }

      const fetched = new Set(validQuotes.map(({ symbol }) => symbol));
      const missed = list.filter(t => !fetched.has(t));
      if (missed.length > 0) {
        lines.push(`\n_Could not fetch: ${missed.join(', ')}_`);
      }

      const sourceLabel = sources.size > 0 ? [...sources].join(' + ') : 'Market data';
      lines.push(`\n_Data via ${sourceLabel} | ${new Date().toLocaleString()}_`);
      await interaction.editReply(lines.join('\n'));
      return;
    }
  } catch (err) {
    console.error('[Watchlist] Market data fetch error:', err.message);
  }
  // Fallback if fetch fails
  await interaction.editReply(`**Your Watchlist (${list.length} stocks)**\n${list.join(', ')}\n\n_Live prices unavailable._`);
}

// ── /profile — View user profile ────────────────────────────────────
async function handleProfile(interaction) {
  const targetUser = interaction.options.getUser('user') || interaction.user;
  const userId = targetUser.id;
  const userData = memory.getUser(userId);
  const sentimentStats = sentiment.getStats(userId);
  const reactionStats = reactions.getUserStats(userId);

  if (userData.interactionCount === 0) {
    await interaction.reply({ content: `No data on **${targetUser.username}** yet.`, flags: MessageFlags.Ephemeral });
    return;
  }

  const lines = [`**Profile: ${targetUser.username}**\n`];
  lines.push(`**Interactions:** ${userData.interactionCount}`);

  if (userData.firstSeen) {
    lines.push(`**First seen:** ${new Date(userData.firstSeen).toLocaleDateString()}`);
  }
  if (userData.lastSeen) {
    lines.push(`**Last active:** ${new Date(userData.lastSeen).toLocaleDateString()}`);
  }

  lines.push(`**Sentiment:** ${sentimentStats.label} (trend: ${sentimentStats.trend})`);
  lines.push(`**Feedback:** ${reactionStats.thumbsUp} :thumbsup: / ${reactionStats.thumbsDown} :thumbsdown:`);

  if (userData.facts.length > 0) {
    lines.push(`\n**Known facts:** ${userData.facts.slice(-10).join(', ')}`);
  }

  const frequentTickers = memory.getFrequentTickers(userId);
  if (frequentTickers.length > 0) {
    lines.push(`**Favorite tickers:** ${frequentTickers.map(f => `${f.ticker} (${f.count}x)`).join(', ')}`);
  }

  const watchlist = memory.getWatchlist(userId);
  if (watchlist.length > 0) {
    lines.push(`**Watchlist:** ${watchlist.join(', ')}`);
  }

  if (Object.keys(userData.preferences).length > 0) {
    const prefs = Object.entries(userData.preferences)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    lines.push(`**Preferences:** ${prefs}`);
  }

  await interaction.reply(lines.join('\n'));
}

// ── /deepanalysis — Multi-agent trading analysis (TradingAgents) ─────
async function handleDeepAnalysis(interaction) {
  await interaction.deferReply();

  const ticker = yahoo.resolveTicker(interaction.options.getString('ticker'));

  // Update progress via editing the deferred reply
  const updateProgress = async (stage, message) => {
    try {
      await interaction.editReply(`**TradingAgents — ${ticker}**\n⏳ ${message}`);
    } catch (e) {
      // Ignore edit errors during rapid updates
    }
  };

  try {
    const result = await tradingAgents.analyze(ticker, updateProgress);

    // Format the main summary for Discord
    const formatted = tradingAgents.formatForDiscord(result);
    await interaction.editReply(formatted);

    // Send detailed report as a follow-up if it fits
    const detailed = tradingAgents.formatDetailedReport(result);
    if (detailed.length <= 1950) {
      await interaction.followUp({ content: `\`\`\`md\n${detailed}\n\`\`\``, flags: MessageFlags.Ephemeral });
    } else {
      // Chunk it for the user as an ephemeral message
      const chunks = [];
      let remaining = detailed;
      while (remaining.length > 0) {
        chunks.push(remaining.slice(0, 1900));
        remaining = remaining.slice(1900);
      }
      for (let i = 0; i < Math.min(chunks.length, 3); i++) {
        await interaction.followUp({
          content: `\`\`\`md\n${chunks[i]}\n\`\`\``,
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  } catch (err) {
    console.error(`[DeepAnalysis] Error for ${ticker}:`, err);
    await interaction.editReply(`**TradingAgents — ${ticker}**\n❌ Analysis failed: ${err.message}`);
  }
}

// ── /research — Agent Swarm parallel research ────────────────────────
async function handleResearch(interaction) {
  await interaction.deferReply();

  const query = interaction.options.getString('query');

  const updateProgress = async (message) => {
    try {
      await interaction.editReply(`**Agent Swarm Research**\n⏳ ${message}`);
    } catch (e) {
      // Ignore edit errors during rapid updates
    }
  };

  try {
    const result = await agentSwarm.research(query, updateProgress);

    // Main synthesis
    const formatted = agentSwarm.formatForDiscord(result);
    await interaction.editReply(formatted);

    // Detailed report as ephemeral follow-up
    const detailed = agentSwarm.formatDetailedReport(result);
    if (detailed.length <= 1950) {
      await interaction.followUp({ content: `\`\`\`md\n${detailed}\n\`\`\``, flags: MessageFlags.Ephemeral });
    } else {
      const chunks = [];
      let remaining = detailed;
      while (remaining.length > 0) {
        chunks.push(remaining.slice(0, 1900));
        remaining = remaining.slice(1900);
      }
      for (let i = 0; i < Math.min(chunks.length, 5); i++) {
        await interaction.followUp({
          content: `\`\`\`md\n${chunks[i]}\n\`\`\``,
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  } catch (err) {
    console.error(`[Research] Error:`, err);
    await interaction.editReply(`**Agent Swarm Research**\n❌ Research failed: ${err.message}`);
  }
}

// ── /gex — Gamma Exposure analysis (chart, summary, alerts) ───────────

// Shared engine instances (lazy-initialized)
let _gexEngine = null;
let _gexAlerts = null;

function _getGEXEngine() {
  if (!_gexEngine) _gexEngine = new GEXEngine(gamma);
  return _gexEngine;
}

function _getGEXAlerts() {
  if (!_gexAlerts) _gexAlerts = new GEXAlertService();
  return _gexAlerts;
}

async function handleGEX(interaction) {
  await interaction.deferReply();

  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'chart':
      return handleGEXChart(interaction);
    case 'summary':
      return handleGEXSummary(interaction);
    case 'alerts':
      return handleGEXAlerts(interaction);
    case 'heatmap':
      return handleGEXHeatmap(interaction);
    default:
      return handleGEXChart(interaction);
  }
}

/**
 * /gex chart — Original single-expiry GEX chart (backward compatible)
 */
async function handleGEXChart(interaction) {
  const rawTicker = interaction.options.getString('ticker');
  const ticker = yahoo.sanitizeTicker(rawTicker);
  const expirationPref = interaction.options.getString('expiration') || '0dte';
  if (!ticker) {
    return interaction.editReply('Invalid ticker symbol. Use 1-12 alphanumeric characters (e.g. SPY, AAPL).');
  }

  if (!gamma.enabled) {
    return interaction.editReply('GEX analysis is currently unavailable.');
  }

  try {
    const expLabel = expirationPref === '0dte' ? '0DTE' : expirationPref === 'weekly' ? 'Weekly' : 'Monthly OPEX';
    await interaction.editReply(`**${ticker} — Gamma Exposure (${expLabel})**\n⏳ Fetching options chain & calculating GEX...`);

    const result = await gamma.analyze(ticker, expirationPref);
    const summary = gamma.formatForDiscord(result);

    if (result.chartBuffer) {
      const attachment = new AttachmentBuilder(result.chartBuffer, { name: `${ticker}-gex.png` });
      await interaction.editReply({
        content: summary,
        files: [attachment],
      });
    } else {
      await interaction.editReply(summary + '\n\n_Chart unavailable — canvas module not loaded._');
    }
  } catch (err) {
    console.error(`[GEX] Error for ${ticker}:`, err);
    await interaction.editReply(`**${ticker} — Gamma Exposure**\n❌ ${err.message || 'Unknown error'}`);
  }
}

/**
 * /gex summary — Multi-expiry aggregated GEX analysis
 */
async function handleGEXSummary(interaction) {
  const rawTicker = interaction.options.getString('ticker');
  const ticker = yahoo.sanitizeTicker(rawTicker);
  if (!ticker) {
    return interaction.editReply('Invalid ticker symbol. Use 1-12 alphanumeric characters (e.g. SPY, AAPL).');
  }

  if (!gamma.enabled) {
    return interaction.editReply('GEX analysis is currently unavailable.');
  }

  try {
    await interaction.editReply(`**${ticker} — Multi-Expiry GEX**\n⏳ Fetching 0DTE + weekly + monthly options data...`);

    const engine = _getGEXEngine();
    const result = await engine.analyze(ticker);
    const summary = engine.formatSummaryForDiscord(result);

    if (result.chartBuffer) {
      const attachment = new AttachmentBuilder(result.chartBuffer, { name: `${ticker}-gex-summary.png` });
      await interaction.editReply({
        content: summary,
        files: [attachment],
      });
    } else {
      await interaction.editReply(summary);
    }
  } catch (err) {
    console.error(`[GEX Summary] Error for ${ticker}:`, err);
    await interaction.editReply(`**${ticker} — GEX Summary**\n❌ ${err.message || 'Unknown error'}`);
  }
}

/**
 * /gex alerts — Check break-and-hold conditions on GEX levels
 */
async function handleGEXAlerts(interaction) {
  const rawTicker = interaction.options.getString('ticker');
  const ticker = yahoo.sanitizeTicker(rawTicker);
  if (!ticker) {
    return interaction.editReply('Invalid ticker symbol. Use 1-12 alphanumeric characters (e.g. SPY, AAPL).');
  }

  if (!gamma.enabled) {
    return interaction.editReply('GEX analysis is currently unavailable.');
  }

  try {
    await interaction.editReply(`**${ticker} — GEX Alert Check**\n⏳ Analyzing levels and recent price action...`);

    const engine = _getGEXEngine();
    const alertSvc = _getGEXAlerts();

    // Get GEX summary
    const gexSummary = await engine.analyze(ticker);

    // Fetch recent candles for break-and-hold evaluation
    let candles = [];
    try {
      const bars = await alpaca.getHistory(ticker, {
        timeframe: alertSvc.candleInterval,
        limit: 20,
      });
      candles = (bars || []).map(b => ({
        close: b.ClosePrice || b.close || b.c,
        volume: b.Volume || b.volume || b.v,
      }));
    } catch (err) {
      console.warn(`[GEX Alerts] Could not fetch candles for ${ticker}: ${err.message}`);
    }

    // Evaluate alerts
    const alerts = alertSvc.evaluate(ticker, candles, gexSummary);

    if (alerts.length > 0) {
      const lines = alerts.map(a => a.message);
      await interaction.editReply(lines.join('\n\n'));
    } else {
      const walls = gexSummary.walls;
      const callLvl = walls.callWalls[0] ? `$${walls.callWalls[0].strike}` : '—';
      const putLvl = walls.putWalls[0] ? `$${walls.putWalls[0].strike}` : '—';
      const flipLvl = gexSummary.gammaFlip ? `$${gexSummary.gammaFlip}` : '—';

      await interaction.editReply([
        `**${ticker} — GEX Alert Check**`,
        `No break-and-hold conditions triggered.`,
        ``,
        `Monitoring: Call wall ${callLvl} | Put wall ${putLvl} | Flip ${flipLvl}`,
        `Criteria: ${alertSvc.holdCandles} consecutive ${alertSvc.candleInterval} closes`,
        `Regime: ${gexSummary.regime.label} (${(gexSummary.regime.confidence * 100).toFixed(0)}%)`,
        ``,
        `_Alerts fire automatically when criteria are met (autonomous monitor)._`,
      ].join('\n'));
    }
  } catch (err) {
    console.error(`[GEX Alerts] Error for ${ticker}:`, err);
    await interaction.editReply(`**${ticker} — GEX Alerts**\n❌ ${err.message || 'Unknown error'}`);
  }
}

/**
 * /gex heatmap — Gamma heat map: GEX by strike × expiration with color intensity
 */
async function handleGEXHeatmap(interaction) {
  const rawTicker = interaction.options.getString('ticker');
  const ticker = yahoo.sanitizeTicker(rawTicker);
  const strikeRange = interaction.options.getInteger('range') || 20;
  if (!ticker) {
    return interaction.editReply('Invalid ticker symbol. Use 1-12 alphanumeric characters (e.g. SPY, AAPL).');
  }

  if (!gammaHeatmap.enabled) {
    return interaction.editReply('Gamma heat map is unavailable — canvas module not loaded.');
  }

  try {
    await interaction.editReply(`**${ticker} — Gamma Heat Map**\n⏳ Fetching options chains across expirations...`);

    const result = await gammaHeatmap.generate(ticker, { strikeRange });
    const summary = gammaHeatmap.formatForDiscord(ticker, result.spotPrice, result.expirations, result.source);

    const attachment = new AttachmentBuilder(result.buffer, { name: `${ticker}-gamma-heatmap.png` });

    // Build interactive dashboard URL
    const cfg = require('../config');
    const baseUrl = cfg.dashboardUrl;
    const replyPayload = { content: summary, files: [attachment] };

    if (baseUrl) {
      const dashUrl = `${baseUrl}/gex`;
      replyPayload.content += `\n🖥️ **[Open Interactive Dashboard](${dashUrl})** — real-time updates, toggle expirations, hover details`;

      // Add button row for opening dashboard
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Open Live Dashboard')
          .setStyle(ButtonStyle.Link)
          .setURL(dashUrl)
          .setEmoji('🖥️'),
        new ButtonBuilder()
          .setCustomId(`gex_refresh_${ticker}`)
          .setLabel('Refresh')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🔄'),
      );
      replyPayload.components = [row];
    }

    await interaction.editReply(replyPayload);
  } catch (err) {
    console.error(`[GEX Heatmap] Error for ${ticker}:`, err);
    await interaction.editReply(`**${ticker} — Gamma Heat Map**\n❌ ${err.message || 'Unknown error'}`);
  }
}

// ── /stream — Real-time Alpaca WebSocket market data ──────────────────
async function handleStream(interaction) {
  const action = interaction.options.getString('action');
  const symbolsInput = interaction.options.getString('symbols');
  const instance = stream.getInstance();

  if (!instance || !instance.enabled) {
    await interaction.reply({
      content: 'Real-time streaming requires `ALPACA_API_KEY` and `ALPACA_API_SECRET` in .env.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // ── status ──
  if (action === 'status') {
    const s = instance.getStatus();
    const lines = [
      '**WebSocket Stream Status**',
      `**Connected:** ${s.connected ? 'Yes' : 'No'}`,
      `**Feed:** ${s.feed.toUpperCase()}`,
      `**Symbols streaming:** ${s.symbols}`,
      `**Channels subscribed:** ${s.channels}`,
    ];
    await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
    return;
  }

  // ── list ──
  if (action === 'list') {
    const subs = instance.getSubscriptions(interaction.channelId);
    if (subs.length === 0) {
      await interaction.reply({
        content: 'No active stream subscriptions in this channel. Use `/stream start AAPL,TSLA` to begin.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const priceLines = subs.map(sym => {
      const latest = instance.getLatestPrice(sym);
      const bar = instance.getLatestBar(sym);
      if (latest) {
        const barInfo = bar ? ` | O:$${bar.open.toFixed(2)} H:$${bar.high.toFixed(2)} L:$${bar.low.toFixed(2)}` : '';
        return `**${sym}** — $${latest.price.toFixed(2)}${barInfo}`;
      }
      return `**${sym}** — awaiting data...`;
    });

    const lines = [
      `**Live Stream — ${subs.length} symbol(s)**`,
      ...priceLines,
      `\n_Real-time via Alpaca WebSocket (${instance.getStatus().feed.toUpperCase()})_`,
    ];
    await interaction.reply(lines.join('\n'));
    return;
  }

  // ── start / stop require symbols ──
  if (!symbolsInput) {
    await interaction.reply({
      content: `Please provide symbols. Example: \`/stream ${action} AAPL,TSLA,SPY\``,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const symbols = symbolsInput.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0) {
    await interaction.reply({ content: 'No valid symbols provided.', flags: MessageFlags.Ephemeral });
    return;
  }

  // ── start ──
  if (action === 'start') {
    const result = instance.subscribe(interaction.channelId, symbols);

    if (result.error) {
      await interaction.reply({ content: `Stream error: ${result.error}`, flags: MessageFlags.Ephemeral });
      return;
    }

    const parts = [];
    if (result.added.length > 0) parts.push(`Subscribed: **${result.added.join(', ')}**`);
    if (result.already.length > 0) parts.push(`Already streaming: ${result.already.join(', ')}`);
    parts.push(`\nBig-move alerts (>1.5% per minute bar) will be posted to this channel.`);
    parts.push(`_Use \`/stream list\` to see live prices._`);

    await interaction.reply(parts.join('\n'));
    return;
  }

  // ── stop ──
  if (action === 'stop') {
    const result = instance.unsubscribe(interaction.channelId, symbols);

    const parts = [];
    if (result.removed.length > 0) parts.push(`Unsubscribed: **${result.removed.join(', ')}**`);
    if (result.notFound.length > 0) parts.push(`Not found: ${result.notFound.join(', ')}`);

    const remaining = instance.getSubscriptions(interaction.channelId);
    if (remaining.length > 0) {
      parts.push(`Still streaming: ${remaining.join(', ')}`);
    } else {
      parts.push('No active subscriptions in this channel.');
    }

    await interaction.reply(parts.join('\n'));
    return;
  }
}

function buildMarketDataLabel() {
  const sources = [];
  if (alpaca.enabled) sources.push('Alpaca (IEX)');
  if (yahoo.enabled) sources.push('FMP');
  if (sources.length === 0) return 'Unavailable';
  if (sources.length === 1) return sources[0];
  return sources.join(' + ');
}

// ── /technicals — Technical analysis (RSI, MACD, Bollinger, etc.) ────
async function handleTechnicals(interaction) {
  await interaction.deferReply();

  const rawTicker = interaction.options.getString('ticker');
  const ticker = yahoo.sanitizeTicker(rawTicker);
  if (!ticker) {
    return interaction.editReply('Invalid ticker symbol. Use 1-12 alphanumeric characters (e.g. AAPL, TSLA).');
  }

  try {
    await interaction.editReply(`**${ticker} — Technical Analysis**\n⏳ Fetching 200+ days of price history & computing indicators...`);

    const result = await technicals.analyze(ticker);
    const formatted = technicals.formatForDiscord(result);

    await interaction.editReply(formatted);
  } catch (err) {
    console.error(`[Technicals] Error for ${ticker}:`, err);
    await interaction.editReply(`**${ticker} — Technical Analysis**\n❌ ${err.message}`);
  }
}

// ── /social — StockTwits social sentiment ────────────────────────────
async function handleSocial(interaction) {
  await interaction.deferReply();

  const rawTicker = interaction.options.getString('ticker');
  const ticker = yahoo.sanitizeTicker(rawTicker);
  if (!ticker) {
    return interaction.editReply('Invalid ticker symbol. Use 1-12 alphanumeric characters (e.g. AAPL, BTC).');
  }

  try {
    const result = await stocktwits.analyzeSymbol(ticker);
    const formatted = stocktwits.formatSentimentForDiscord(result);

    await interaction.editReply(formatted);
  } catch (err) {
    console.error(`[Social] Error for ${ticker}:`, err);
    await interaction.editReply(`**${ticker} — Social Sentiment**\n❌ ${err.message}`);
  }
}

// ── /trending — StockTwits trending tickers ──────────────────────────
async function handleTrending(interaction) {
  await interaction.deferReply();

  try {
    const trending = await stocktwits.getTrending();
    const formatted = stocktwits.formatTrendingForDiscord(trending);

    await interaction.editReply(formatted);
  } catch (err) {
    console.error(`[Trending] Error:`, err);
    await interaction.editReply(`**Trending Tickers**\n❌ ${err.message}`);
  }
}

// ── /reddit — Reddit social sentiment ─────────────────────────────
async function handleReddit(interaction) {
  await interaction.deferReply();

  const ticker = interaction.options.getString('ticker');

  try {
    if (ticker) {
      // Per-symbol analysis
      const upper = ticker.toUpperCase();
      await interaction.editReply(`**${upper} — Reddit Sentiment**\n⏳ Scanning r/wallstreetbets, r/stocks, r/investing, r/options...`);

      const result = await reddit.analyzeSymbol(upper);
      const formatted = reddit.formatSymbolForDiscord(result);
      await interaction.editReply(formatted);
    } else {
      // Trending tickers
      await interaction.editReply('**Reddit Trending**\n⏳ Scanning 4 subreddits for trending tickers...');

      const trending = await reddit.getTrendingTickers();
      const formatted = reddit.formatTrendingForDiscord(trending);

      if (formatted.length <= 2000) {
        await interaction.editReply(formatted);
      } else {
        await interaction.editReply(formatted.slice(0, 1990) + '...');
      }
    }
  } catch (err) {
    console.error('[Reddit] Error:', err);
    await interaction.editReply(`**Reddit Sentiment**\n❌ ${err.message}`);
  }
}

// ── /macro — Macro environment analysis ───────────────────────────
async function handleMacro(interaction) {
  await interaction.deferReply();

  try {
    await interaction.editReply('**Macro Environment**\n⏳ Analyzing market regime, benchmarks, sector breadth...');

    const result = await macro.analyze();
    const formatted = macro.formatForDiscord(result);

    // Check length — macro output can be long
    if (formatted.length <= 2000) {
      await interaction.editReply(formatted);
    } else {
      await interaction.editReply(formatted.slice(0, 1990) + '...');
    }

    // Unusual Whales enrichment — service not yet implemented
    // TODO: add uw (unusual-whales) service and re-enable
  } catch (err) {
    console.error('[Macro] Error:', err);
    await interaction.editReply(`**Macro Environment**\n❌ ${err.message}`);
  }
}

// ── /sectors — Sector rotation heatmap ────────────────────────────
async function handleSectors(interaction) {
  await interaction.deferReply();

  try {
    await interaction.editReply('**Sector Rotation**\n⏳ Fetching sector ETF performance data...');

    const performance = await sectors.getSectorPerformance();
    const formatted = sectors.formatForDiscord(performance);

    if (formatted.length <= 2000) {
      await interaction.editReply(formatted);
    } else {
      await interaction.editReply(formatted.slice(0, 1990) + '...');
    }
  } catch (err) {
    console.error('[Sectors] Error:', err);
    await interaction.editReply(`**Sector Rotation**\n❌ ${err.message}`);
  }
}

// ── /validea — Validea guru fundamental analysis ──────────────────
async function handleValidea(interaction) {
  await interaction.deferReply();

  const rawTicker = interaction.options.getString('ticker');
  const ticker = yahoo.sanitizeTicker(rawTicker);
  if (!ticker) {
    return interaction.editReply('Invalid ticker symbol. Use 1-12 alphanumeric characters (e.g. AAPL, MSFT).');
  }

  try {
    await interaction.editReply(`**${ticker} — Validea Guru Analysis**\n⏳ Fetching fundamental scores from Validea...`);

    const result = await validea.analyze(ticker);
    const formatted = validea.formatForDiscord(result);

    await interaction.editReply(formatted);
  } catch (err) {
    console.error(`[Validea] Error for ${ticker}:`, err);
    await interaction.editReply(`**${ticker} — Validea Guru Analysis**\n❌ ${err.message}`);
  }
}

// ── /agent — SHARK autonomous trading agent control ───────────────
async function handleAgent(interaction) {
  const action = interaction.options.getString('action');
  const hasAdminPerms = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
  const isOwner = config.botOwnerId && interaction.user.id === config.botOwnerId;
  const isAuthorized = isOwner || hasAdminPerms;

  // Fast permission + config checks BEFORE deferring (these are synchronous / instant)
  const privilegedActions = new Set(['enable', 'disable', 'kill', 'set', 'reset', 'trade', 'dangerous']);
  if (privilegedActions.has(action) && !isAuthorized) {
    const ownerHint = config.botOwnerId ? '' : ' (set BOT_OWNER_ID to grant owner access)';
    return interaction.reply({
      content: `This action is restricted to the bot owner or server administrators${ownerHint}.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (['enable', 'kill', 'trade'].includes(action) && !alpaca.enabled) {
    return interaction.reply({
      content: '**SHARK requires Alpaca.** Set `ALPACA_API_KEY` and `ALPACA_API_SECRET` in your `.env` file.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Defer IMMEDIATELY after fast checks — Discord gives only 3 seconds
  await interaction.deferReply();

  try {
    switch (action) {
      case 'status': {
        const status = await mahoraga.getStatus();
        await interaction.editReply(mahoraga.formatStatusForDiscord(status));
        break;
      }
      case 'enable': {
        mahoraga.enable();
        await interaction.editReply(`🟢 **SHARK agent enabled.** Autonomous trading is now active.\nMode: ${alpaca.isPaper ? '📄 Paper Trading' : '💵 LIVE Trading'}`);
        break;
      }
      case 'disable': {
        mahoraga.disable();
        await interaction.editReply('🔴 **SHARK agent disabled.** Autonomous trading stopped.');
        break;
      }
      case 'config': {
        const cfg = mahoraga.getConfig();
        await interaction.editReply(mahoraga.formatConfigForDiscord(cfg));
        break;
      }
      case 'set': {
        const key = interaction.options.getString('key');
        const value = interaction.options.getString('value');

        if (!key || !value) {
          const defaults = policy.getDefaultConfig();
          const { NUMERIC_KEYS, BOOLEAN_KEYS, LIST_KEYS } = policy.getConfigKeyInfo();
          const lines = [
            '**SHARK — Available Config Keys**\n',
            '**Numeric (use decimal for %):**',
            ...[...NUMERIC_KEYS].map(k => `  \`${k}\` — current: \`${defaults[k]}\``),
            '',
            '**Boolean (true/false):**',
            ...[...BOOLEAN_KEYS].map(k => `  \`${k}\` — current: \`${defaults[k]}\``),
            '',
            '**Lists (comma-separated tickers):**',
            ...[...LIST_KEYS].map(k => `  \`${k}\``),
            '',
            '_Example: `/agent set key:stop_loss_pct value:0.03`_',
          ];
          await interaction.editReply(lines.join('\n'));
          break;
        }

        const result = policy.setConfigKey(key, value);
        if (result.success) {
          const displayVal = Array.isArray(result.value)
            ? result.value.join(', ') || '(empty)'
            : String(result.value);
          await interaction.editReply(`**SHARK Config Updated**\n\`${result.key}\` → \`${displayVal}\`\n\n_Changes are saved and persist across restarts._`);
        } else {
          await interaction.editReply(`**Config Error**\n${result.error}`);
        }
        break;
      }
      case 'reset': {
        policy.resetConfig();
        await interaction.editReply('**SHARK Config Reset**\nAll settings restored to defaults.\n\n_Use `/agent config` to view current settings._');
        break;
      }
      case 'dangerous': {
        const cfg = policy.getConfig();
        if (cfg.dangerousMode) {
          const result = policy.disableDangerousMode();
          await interaction.editReply(
            '**SHARK — Dangerous Mode DISABLED**\n' +
            'Restored previous trading parameters.\n\n' +
            '_Use `/agent config` to verify settings._'
          );
        } else {
          const result = policy.enableDangerousMode();
          const lines = [
            '**SHARK — DANGEROUS MODE ENABLED**\n',
            'Aggressive trading parameters are now active:',
            '• Max positions: `10` | Max per trade: `$10,000`',
            '• Daily loss limit: `5%` | Position size: `40%` of cash',
            '• Stop loss: `8%` | Take profit: `15%`',
            '• Cooldown: `5 min` | Scan interval: `2 min`',
            '• Shorting: `enabled` | Crypto: `enabled`',
            '• Min sentiment: `0.1` | Min confidence: `0.4`',
            '• Options: `$1,000` premium, `5` positions, conviction `3/10`',
            '',
            '_Use `/agent dangerous` again to disable and restore previous settings._',
            '_Use `/agent config` to see full config._',
          ];
          await interaction.editReply(lines.join('\n'));
        }
        break;
      }
      case 'trade': {
        const ticker = interaction.options.getString('key');
        if (!ticker) {
          await interaction.editReply(
            '**SHARK Manual Trade**\n' +
            'Specify a ticker to evaluate and trade.\n\n' +
            '`/agent trade key:AAPL` — run full pipeline (sentiment + technicals + AI) then execute\n' +
            '`/agent trade key:AAPL value:force` — skip AI, buy directly (risk checks still apply)'
          );
          break;
        }

        const forceVal = interaction.options.getString('value');
        const force = forceVal?.toLowerCase() === 'force';

        await interaction.editReply(`**SHARK — Evaluating ${ticker.toUpperCase()}...**\n⏳ Running ${force ? 'forced trade' : 'full pipeline'}...`);

        const result = await mahoraga.manualTrade(ticker, { force });

        const lines = [];
        if (result.success) {
          lines.push(`**SHARK Trade Executed**`);
          lines.push(`${result.message}`);
        } else {
          lines.push(`**SHARK Trade — ${ticker.toUpperCase()}**`);
          lines.push(`❌ ${result.message}`);
        }

        if (result.details?.steps?.length > 0) {
          lines.push('');
          lines.push('__Pipeline Steps:__');
          for (const step of result.details.steps) {
            lines.push(`• ${step}`);
          }
        }

        lines.push(`\n_${alpaca.isPaper ? 'Paper trading' : 'LIVE trading'} mode_`);
        await interaction.editReply(lines.join('\n'));
        break;
      }
      case 'logs': {
        const logs = mahoraga.getLogs();
        await interaction.editReply(mahoraga.formatLogsForDiscord(logs));
        break;
      }
      case 'kill': {
        await mahoraga.kill();
        await interaction.editReply('🛑 **EMERGENCY KILL SWITCH ACTIVATED.** All orders cancelled, positions closed, agent halted.');
        break;
      }
    }
  } catch (err) {
    console.error(`[Agent] Error (${action}):`, err);
    await interaction.editReply(`**SHARK — ${action}**\n❌ ${err.message}`);
  }
}

// ── /flow — Smart money flow: insider + congress trades (AInvest) ────
async function handleFlow(interaction) {
  await interaction.deferReply();

  const ticker = interaction.options.getString('ticker').toUpperCase();

  try {
    if (!ainvest.enabled) {
      await interaction.editReply('**Smart Money Flow** requires an AInvest API key. Set `AINVEST_API_KEY` in your environment.');
      return;
    }

    await interaction.editReply(`**Smart Money Flow — ${ticker}**\n⏳ Fetching insider and congress trades...`);

    const [insiderResult, congressResult] = await Promise.allSettled([
      ainvest.getInsiderTrades(ticker),
      ainvest.getCongressTrades(ticker),
    ]);

    const formatted = ainvest.formatFlowForDiscord({
      insider: insiderResult.status === 'fulfilled' ? insiderResult.value : [],
      congress: congressResult.status === 'fulfilled' ? congressResult.value : [],
    }, ticker);

    await interaction.editReply(formatted);
  } catch (err) {
    console.error(`[Flow] Error for ${ticker}:`, err);
    await interaction.editReply(`**Smart Money Flow — ${ticker}**\n❌ ${err.message}`);
  }
}

// ── /whales — Market intelligence dashboard (AInvest) ────────────────
async function handleWhales(interaction) {
  await interaction.deferReply();

  const ticker = interaction.options.getString('ticker').toUpperCase();

  try {
    if (!ainvest.enabled) {
      await interaction.editReply('**Market Intelligence** requires an AInvest API key. Set `AINVEST_API_KEY` in your environment.');
      return;
    }

    await interaction.editReply(`**Market Intelligence — ${ticker}**\n⏳ Gathering analyst ratings, fundamentals, insider, and congress data...`);

    const [analysts, financials, earnings, insider, congress, news] = await Promise.allSettled([
      ainvest.getAnalystConsensus(ticker),
      ainvest.getFinancials(ticker),
      ainvest.getEarnings(ticker, 2),
      ainvest.getInsiderTrades(ticker),
      ainvest.getCongressTrades(ticker),
      ainvest.getNews({ tickers: [ticker], limit: 3 }),
    ]);

    const formatted = ainvest.formatIntelDashboard(ticker, {
      analysts: analysts.status === 'fulfilled' ? analysts.value : null,
      financials: financials.status === 'fulfilled' ? financials.value : null,
      earnings: earnings.status === 'fulfilled' ? earnings.value : null,
      insider: insider.status === 'fulfilled' ? insider.value : null,
      congress: congress.status === 'fulfilled' ? congress.value : null,
      news: news.status === 'fulfilled' ? news.value : null,
    });

    await interaction.editReply(formatted);
  } catch (err) {
    console.error(`[Whales] Error for ${ticker}:`, err);
    await interaction.editReply(`**Market Intelligence — ${ticker}**\n❌ ${err.message}`);
  }
}

// ── /predict — Search Kalshi prediction markets + AI high-conviction play ─
async function handlePredict(interaction) {
  await interaction.deferReply();

  const topic = interaction.options.getString('topic');

  try {
    await interaction.editReply(`**Prediction Markets — "${topic}"**\n⏳ Searching Kalshi markets & finding the best play...`);

    // Fetch more markets than we display so grouping works well
    const markets = await kalshi.searchMarkets(topic, 30);

    if (!markets || markets.length === 0) {
      await interaction.editReply(`**Prediction Markets — "${topic}"**\nNo open markets found for "${topic}". Try broader terms like "inflation", "bitcoin", "election", "recession".`);
      return;
    }

    // Show grouped markets (deduplicated by event) and kick off AI simultaneously
    const formatted = kalshi.formatMarketsForDiscord(markets, `Prediction Markets — "${topic}"`);
    const aiPromise = kalshi.analyzeBets(markets, topic);

    await interaction.editReply(formatted);

    // AI picks the best play
    const aiAnalysis = await aiPromise;

    if (aiAnalysis) {
      const output = aiAnalysis.length <= 1900 ? aiAnalysis : aiAnalysis.slice(0, 1900) + '...';
      await interaction.followUp(`${output}`);
    }
  } catch (err) {
    console.error('[Predict] Error:', err);
    await interaction.editReply(`**Prediction Markets — "${topic}"**\n❌ ${err.message}`);
  }
}

// ── /odds — Deep dive on a specific Kalshi market ────────────────────
async function handleOdds(interaction) {
  await interaction.deferReply();

  const rawInput = interaction.options.getString('market').toUpperCase();

  try {
    await interaction.editReply(`**${rawInput} — Market Deep Dive**\n⏳ Fetching market data & trades...`);

    let market = null;
    let trades = null;

    // Try direct ticker lookup first
    try {
      [market, trades] = await Promise.all([
        kalshi.getMarket(rawInput),
        kalshi.getTrades(rawInput, 20).catch(() => null),
      ]);
    } catch (fetchErr) {
      // If 404, this might be a topic/keyword, not a ticker — try searching
      if (fetchErr.message.includes('404') || fetchErr.message.includes('not_found')) {
        await interaction.editReply(`**${rawInput}**\n⏳ "${rawInput}" isn't a ticker — searching Kalshi markets...`);
        const results = await kalshi.searchMarkets(rawInput, 1);
        if (results && results.length > 0) {
          const bestMatch = results[0];
          [market, trades] = await Promise.all([
            kalshi.getMarket(bestMatch.ticker).catch(() => bestMatch),
            kalshi.getTrades(bestMatch.ticker, 20).catch(() => null),
          ]);
        }
      } else {
        throw fetchErr;
      }
    }

    if (!market || !market.ticker) {
      await interaction.editReply(`**${rawInput}**\n❌ No market found. Use \`/predict <topic>\` to search for markets, then copy the ticker (e.g. \`KXBTC-26FEB14-T98000\`).`);
      return;
    }

    const ticker = market.ticker;

    // Show market details immediately
    const formatted = kalshi.formatMarketDetailForDiscord(market, trades);
    await interaction.editReply(formatted);

    // Run AI deep analysis
    const aiAnalysis = await kalshi.analyzeMarket(market, trades);

    if (aiAnalysis) {
      const output = aiAnalysis.length <= 1900 ? aiAnalysis : aiAnalysis.slice(0, 1900) + '...';
      await interaction.followUp(`${output}`);
    }
  } catch (err) {
    console.error(`[Odds] Error for ${ticker}:`, err);
    await interaction.editReply(`**${ticker} — Market Deep Dive**\n❌ ${err.message}`);
  }
}

// ── /bets — Browse trending/categorized Kalshi markets + best play ────
async function handleBets(interaction) {
  await interaction.deferReply();

  const category = interaction.options.getString('category') || 'trending';

  try {
    let markets;
    let title;

    const labels = {
      trending: 'Trending',
      economics: 'Economics',
      crypto: 'Crypto',
      politics: 'Politics',
      tech: 'Tech',
      markets: 'Markets & Indices',
      sports: 'Sports',
    };
    const label = labels[category] || category;

    await interaction.editReply(`**Kalshi — ${label}**\n⏳ Finding the best plays...`);

    if (category === 'trending') {
      markets = await kalshi.getTrendingMarkets(30);
      title = `Kalshi — Trending Bets`;
    } else {
      markets = await kalshi.getMarketsByCategory(category, 30);
      title = `Kalshi — ${label} Bets`;
    }

    if (!markets || markets.length === 0) {
      await interaction.editReply(`**${title}**\nNo open markets found in this category.`);
      return;
    }

    // Show grouped markets and kick off AI simultaneously
    const formatted = kalshi.formatMarketsForDiscord(markets, title);
    const aiPromise = kalshi.analyzeBets(markets, category);

    await interaction.editReply(formatted);

    // AI picks the best play from the category
    const aiTake = await aiPromise;
    if (aiTake) {
      const output = aiTake.length <= 1900 ? aiTake : aiTake.slice(0, 1900) + '...';
      await interaction.followUp(`${output}`);
    }
  } catch (err) {
    console.error(`[Bets] Error for ${category}:`, err);
    await interaction.editReply(`**Kalshi — ${category}**\n❌ ${err.message}`);
  }
}

// ── /options — 0DTE Options Trading Engine ──────────────────────────

async function handleOptions(interaction) {
  const action = interaction.options.getString('action');
  const hasAdminPerms = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
  const isOwner = config.botOwnerId && interaction.user.id === config.botOwnerId;
  const isAuthorized = isOwner || hasAdminPerms;

  const privilegedActions = new Set(['trade', 'close']);
  if (privilegedActions.has(action) && !isAuthorized) {
    return interaction.reply({
      content: 'This action is restricted to the bot owner or server administrators.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (['trade'].includes(action) && !alpaca.enabled) {
    return interaction.reply({
      content: '**0DTE Options requires Alpaca.** Set `ALPACA_API_KEY` and `ALPACA_API_SECRET` in your `.env` file.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply();

  try {
    switch (action) {
      case 'status': {
        const status = await optionsEngine.getStatus();
        await interaction.editReply(optionsEngine.formatStatusForDiscord(status));
        break;
      }
      case 'trade': {
        const ticker = interaction.options.getString('ticker');
        if (!ticker) {
          await interaction.editReply(
            '**0DTE Options — Manual Trade**\n' +
            'Specify an underlying to run the full 0DTE scalp pipeline.\n\n' +
            '`/options trade ticker:SPY` — AI picks direction + contract\n' +
            '`/options trade ticker:QQQ direction:call` — force call direction\n' +
            '`/options trade ticker:SPY direction:put` — force put direction'
          );
          break;
        }

        const direction = interaction.options.getString('direction');
        const strategy = interaction.options.getString('strategy');

        await interaction.editReply(`**0DTE — Evaluating ${ticker.toUpperCase()}...**\n⏳ Running options pipeline...`);

        const result = await optionsEngine.manualTrade(ticker, { direction, strategy });

        const lines = [];
        if (result.success) {
          lines.push(`**0DTE Trade Executed**`);
          lines.push(result.message);
        } else {
          lines.push(`**0DTE Trade — ${ticker.toUpperCase()}**`);
          lines.push(`❌ ${result.message}`);
        }

        if (result.details?.steps?.length > 0) {
          lines.push('');
          lines.push('__Pipeline Steps:__');
          for (const step of result.details.steps) {
            lines.push(`• ${step}`);
          }
        }

        lines.push(`\n_${alpaca.isPaper ? 'Paper trading' : 'LIVE trading'} mode_`);
        await interaction.editReply(lines.join('\n'));
        break;
      }
      case 'close': {
        // Close all options positions
        const positions = await alpaca.getOptionsPositions();
        if (positions.length === 0) {
          await interaction.editReply('_No open options positions to close._');
          break;
        }

        const results = [];
        for (const pos of positions) {
          try {
            await alpaca.closeOptionsPosition(pos.symbol);
            const pnl = Number(pos.unrealized_pl || 0);
            policy.recordOptionsTradeResult(pnl);
            const parsed = alpaca._parseOccSymbol(pos.symbol);
            results.push(`✅ ${parsed.underlying} $${parsed.strike} ${parsed.type.toUpperCase()} — P/L: $${pnl.toFixed(2)}`);
          } catch (err) {
            results.push(`❌ ${pos.symbol}: ${err.message}`);
          }
        }

        await interaction.editReply(
          `**0DTE — Closing All Options Positions**\n\n${results.join('\n')}`
        );
        break;
      }
      case 'logs': {
        const logs = optionsEngine.getLogs();
        if (logs.length === 0) {
          await interaction.editReply('_No recent 0DTE options activity._');
          break;
        }
        const lines = [`**0DTE Options — Recent Activity**\n`];
        for (const log of logs.slice(-15).reverse()) {
          const time = new Date(log.timestamp).toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
          const emoji = log.type === 'trade' ? '💰' : log.type === 'blocked' ? '🚫' : log.type === 'error' ? '❌' : '📋';
          lines.push(`\`${time}\` ${emoji} ${log.message}`);
        }
        await interaction.editReply(lines.join('\n'));
        break;
      }
      default:
        await interaction.editReply('Unknown options action. Use: `status`, `trade`, `close`, `logs`');
    }
  } catch (err) {
    console.error(`[Options] Error (${action}):`, err);
    await interaction.editReply(`**0DTE Options — ${action}**\n❌ ${err.message}`);
  }
}

// ── /brain ─────────────────────────────────────────────────────────

async function handleBrain(interaction) {
  const action = interaction.options.getString('action');

  if (action === 'status') {
    const status = initiative.getStatus();
    const lines = [
      `**Initiative Engine (Autonomous Brain)**`,
      `Running: ${status.running ? '**YES**' : '**NO**'}`,
      `Journal entries: \`${status.journalEntries}\``,
      `Price tickers watched: \`${status.watchedPrices}\``,
      `Last macro regime: \`${status.lastRegime || 'N/A'}\``,
      ``,
      `**Last Actions:**`,
    ];
    for (const [action, ts] of Object.entries(status.lastActions)) {
      const ago = Math.round((Date.now() - ts) / 60000);
      lines.push(`• \`${action}\`: ${ago} min ago`);
    }
    if (Object.keys(status.lastActions).length === 0) {
      lines.push(`_No actions taken yet_`);
    }
    return interaction.reply(lines.join('\n'));
  }

  if (action === 'journal') {
    const entries = initiative.getJournal(15);
    if (entries.length === 0) {
      return interaction.reply('_No journal entries yet. The brain starts logging once it takes actions._');
    }
    const lines = [`**Initiative Journal** (last ${entries.length} entries)\n`];
    for (const e of entries.reverse()) {
      const time = new Date(e.timestamp).toLocaleTimeString('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit',
      });
      const typeEmoji = {
        observation: '👁️', action: '⚡', self_tune: '🧠', regime_change: '🔄',
        insight: '💡', watchlist: '🔍', thread: '🧵', daily_journal: '📓',
      }[e.type] || '📝';
      lines.push(`${typeEmoji} **${time} ET** [${e.type}] ${e.content.slice(0, 200)}`);
    }
    return interaction.reply(lines.join('\n').slice(0, 2000));
  }

  if (action === 'tuning') {
    const entries = initiative.getJournal(50);
    const tuning = entries.filter(e => e.type === 'self_tune');
    if (tuning.length === 0) {
      return interaction.reply('_No self-tuning events yet. The brain needs 5+ completed trades before it starts adjusting parameters._');
    }
    const lines = [`**Self-Tuning History** (${tuning.length} events)\n`];
    for (const e of tuning.slice(-10).reverse()) {
      const time = new Date(e.timestamp).toLocaleString('en-US', {
        timeZone: 'America/New_York', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
      lines.push(`🧠 **${time} ET**\n${e.content.slice(0, 300)}\n`);
    }
    return interaction.reply(lines.join('\n').slice(0, 2000));
  }

  return interaction.reply({ content: 'Unknown brain action.', flags: MessageFlags.Ephemeral });
}

async function handleSqueeze(interaction) {
  const action = interaction.options.getString('action');
  const ticker = interaction.options.getString('ticker');

  if (action === 'status') {
    const allStatus = gammaSqueeze.getSqueezeStatus(null);
    const formatted = gammaSqueeze.formatStatusForDiscord(allStatus);
    return interaction.reply(formatted.slice(0, 2000));
  }

  if (action === 'detail') {
    if (!ticker) {
      return interaction.reply({ content: 'Please provide a ticker for the detail view (e.g. `/squeeze detail ticker:SPY`).', flags: MessageFlags.Ephemeral });
    }
    const status = gammaSqueeze.getSqueezeStatus(ticker.toUpperCase());
    const formatted = gammaSqueeze.formatStatusForDiscord(status);
    return interaction.reply(formatted.slice(0, 2000));
  }

  if (action === 'sectors') {
    await interaction.deferReply();
    try {
      const sectorData = await gammaSqueeze.analyzeSectorGEX();
      const formatted = gammaSqueeze.formatSectorGEXForDiscord(sectorData);
      return interaction.editReply(formatted.slice(0, 2000));
    } catch (err) {
      return interaction.editReply(`Sector GEX analysis failed: ${err.message}`);
    }
  }

  return interaction.reply({ content: 'Unknown squeeze action.', flags: MessageFlags.Ephemeral });
}

// ── /gammasetups — Scan for stocks with good gamma setups ─────────────
async function handleGammaSetups(interaction) {
  const action = interaction.options.getString('action');
  const universe = interaction.options.getString('universe');
  const ticker = interaction.options.getString('ticker');
  const limit = interaction.options.getInteger('limit') || 10;

  if (action === 'detail') {
    if (!ticker) {
      return interaction.reply({
        content: 'Please provide a ticker for the detail view (e.g. `/gammasetups detail ticker:NVDA`).',
        flags: MessageFlags.Ephemeral,
      });
    }

    const sanitized = yahoo.sanitizeTicker(ticker);
    if (!sanitized) {
      return interaction.reply({ content: 'Invalid ticker symbol.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();
    try {
      await interaction.editReply(`**${sanitized} — Gamma Setup Analysis**\nFetching multi-expiry GEX data...`);
      const setup = await gammaSetups._analyzeSetup(sanitized);
      if (!setup) {
        return interaction.editReply(`**${sanitized}** — Insufficient options data to evaluate gamma setup.`);
      }
      const formatted = gammaSetups.formatDetailForDiscord(setup);
      return interaction.editReply(formatted.slice(0, 2000));
    } catch (err) {
      console.error(`[GammaSetups] Detail error for ${sanitized}:`, err);
      return interaction.editReply(`**${sanitized} — Gamma Setup**\nError: ${err.message || 'Unknown error'}`);
    }
  }

  if (action === 'scan') {
    await interaction.deferReply();
    try {
      const universeLabel = universe || 'default';
      await interaction.editReply(
        `**Gamma Setups Scanner**\nScanning \`${universeLabel}\` universe for stocks not too hedged by dealers...`
      );
      const result = await gammaSetups.scan({ universe: universe || 'default', limit });
      const formatted = gammaSetups.formatForDiscord(result);
      return interaction.editReply(formatted.slice(0, 2000));
    } catch (err) {
      console.error('[GammaSetups] Scan error:', err);
      return interaction.editReply(`**Gamma Setups Scanner**\nError: ${err.message || 'Unknown error'}`);
    }
  }

  return interaction.reply({ content: 'Unknown gammasetups action.', flags: MessageFlags.Ephemeral });
}

// ── /yolo — Autonomous self-improvement engine control ────────────────
async function handleYolo(interaction) {
  const action = interaction.options.getString('action');
  const hasAdminPerms = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
  const isOwner = config.botOwnerId && interaction.user.id === config.botOwnerId;
  const isAuthorized = isOwner || hasAdminPerms;

  // Privileged actions require owner/admin
  const privilegedActions = new Set(['enable', 'disable', 'run']);
  if (privilegedActions.has(action) && !isAuthorized) {
    return interaction.reply({
      content: 'YOLO mode control is restricted to the bot owner or server administrators.',
      flags: MessageFlags.Ephemeral,
    });
  }

  switch (action) {
    case 'status': {
      const s = yoloMode.getStatus();
      const lines = [
        '**YOLO Mode — Autonomous Self-Improvement**',
        '',
        `**Enabled:** ${s.enabled ? 'YES' : 'NO'}`,
        `**Running:** ${s.running ? 'YES' : 'NO'}`,
        `**GitHub:** ${s.githubEnabled ? 'Connected' : 'Not configured (need GITHUB_TOKEN)'}`,
        `**Cycle interval:** ${s.cycleIntervalMin} min`,
        '',
        `**Today:** ${s.dailyCount}/${s.dailyLimit} improvements`,
        `**Total improvements:** ${s.totalImprovements}`,
        `**Consecutive failures:** ${s.consecutiveFailures}/${s.failureThreshold}`,
        '',
        '_The bot scans its own code, finds issues, generates fixes, and deploys them autonomously._',
      ];
      return interaction.reply(lines.join('\n'));
    }

    case 'enable': {
      yoloMode.enable();
      return interaction.reply(
        '**YOLO Mode ENABLED**\n' +
        'The bot will now autonomously scan its own codebase, identify improvements, ' +
        'generate fixes, and deploy them via GitHub.\n\n' +
        'Safety: max 5 improvements/day, max 20 lines/commit, forbidden files protected, ' +
        'auto-pause after 3 consecutive failures.\n\n' +
        '_Use `/yolo status` to monitor, `/yolo disable` to stop._'
      );
    }

    case 'disable': {
      yoloMode.disable();
      return interaction.reply('**YOLO Mode DISABLED**\nAutonomous self-improvement stopped.');
    }

    case 'run': {
      await interaction.deferReply();
      await interaction.editReply('**YOLO Mode — Manual Cycle**\nRunning improvement scan now...');

      const result = await yoloMode.runNow();
      if (result.success) {
        await interaction.editReply('**YOLO Mode — Manual Cycle Complete**\nCheck `/yolo history` and `/yolo logs` for details.');
      } else {
        await interaction.editReply(`**YOLO Mode — Manual Cycle**\n${result.message}`);
      }
      break;
    }

    case 'history': {
      const history = yoloMode.getHistory(10);
      if (history.length === 0) {
        return interaction.reply({ content: '_No improvements yet. Enable YOLO mode to start._', flags: MessageFlags.Ephemeral });
      }

      const lines = ['**YOLO Mode — Recent Improvements**\n'];
      for (const h of history.slice().reverse()) {
        const time = new Date(h.timestamp).toLocaleString('en-US', { timeZone: 'America/New_York' });
        const emoji = h.source === 'error_pattern' ? '🔧' : '🔍';
        lines.push(`${emoji} **${time} ET**`);
        lines.push(`\`${h.file}\` — ${h.linesChanged} lines — ${h.source.replace('_', ' ')}`);
        lines.push(`${h.instruction.slice(0, 120)}`);
        if (h.commitUrl) lines.push(`<${h.commitUrl}>`);
        lines.push('');
      }
      return interaction.reply(lines.join('\n').slice(0, 2000));
    }

    case 'logs': {
      const journal = yoloMode.getJournal(15);
      if (journal.length === 0) {
        return interaction.reply({ content: '_No journal entries yet. The brain logs decisions once YOLO mode runs._', flags: MessageFlags.Ephemeral });
      }

      const lines = ['**YOLO Mode — Decision Journal**\n'];
      for (const e of journal.slice().reverse()) {
        const time = new Date(e.timestamp).toLocaleString('en-US', { timeZone: 'America/New_York' });
        const emoji = { improvement: '✅', blocked: '⛔', failed: '❌' }[e.type] || '📝';
        lines.push(`${emoji} \`${time}\` [${e.type}] \`${e.file}\``);
        lines.push(`  ${e.content.slice(0, 150)}`);
      }
      return interaction.reply(lines.join('\n').slice(0, 2000));
    }

    default:
      return interaction.reply({ content: 'Unknown YOLO action.', flags: MessageFlags.Ephemeral });
  }
}

// ── /ingest — Read channel history into memory ────────────────────────
async function handleIngest(interaction) {
  const hasAdminPerms = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
  const isOwner = config.botOwnerId && interaction.user.id === config.botOwnerId;
  const isAuthorized = isOwner || hasAdminPerms;

  if (!isAuthorized) {
    return interaction.reply({
      content: 'Channel ingestion is restricted to the bot owner or server administrators.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply();

  const targetChannel = interaction.options.getChannel('channel');
  const limit = interaction.options.getInteger('limit') || 2000;

  try {
    if (targetChannel) {
      // Single channel ingestion
      if (!targetChannel.isTextBased() || targetChannel.type === ChannelType.GuildVoice) {
        return interaction.editReply(`**${targetChannel.name}** is not a text channel.`);
      }

      await interaction.editReply(`**Channel Ingestion**\nReading #${targetChannel.name}... (up to ${limit} messages)\nThis may take a minute.`);

      const result = await channelHistory.ingest(targetChannel, {
        limit,
        onProgress: async (processed, total) => {
          if (processed % 200 === 0) {
            await interaction.editReply(
              `**Channel Ingestion**\nReading #${targetChannel.name}... ${processed}/${total} messages processed`
            ).catch(() => {});
          }
        },
      });

      if (result.error) {
        return interaction.editReply(`**Channel Ingestion Failed**\n${result.error}`);
      }

      await interaction.editReply(
        `**Channel Ingestion Complete**\n` +
        `Channel: #${targetChannel.name}\n` +
        `Messages read: **${result.messagesProcessed}**\n` +
        `Knowledge entries created: **${result.knowledgeEntries}**\n\n` +
        `_Billy now remembers what was discussed in this channel._`
      );
    } else {
      // All text channels
      const guild = interaction.guild;
      if (!guild) {
        return interaction.editReply('This command must be used in a server.');
      }

      const textChannels = guild.channels.cache.filter(
        ch => ch.isTextBased() && ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildCategory
      );

      await interaction.editReply(
        `**Channel Ingestion**\n` +
        `Reading ${textChannels.size} text channels... (up to ${limit} messages each)\n` +
        `This may take several minutes.`
      );

      let totalMessages = 0;
      let totalKnowledge = 0;
      const results = [];

      for (const [, channel] of textChannels) {
        try {
          // Check if bot can read the channel
          if (!channel.permissionsFor(interaction.guild.members.me)?.has('ViewChannel')) continue;

          const result = await channelHistory.ingest(channel, { limit });
          if (result.messagesProcessed > 0) {
            results.push({ name: channel.name, ...result });
            totalMessages += result.messagesProcessed;
            totalKnowledge += result.knowledgeEntries;
          }

          await interaction.editReply(
            `**Channel Ingestion**\n` +
            `Progress: ${results.length}/${textChannels.size} channels\n` +
            `Last: #${channel.name} (${result.messagesProcessed} messages)\n` +
            `Total: ${totalMessages} messages → ${totalKnowledge} knowledge entries`
          ).catch(() => {});
        } catch (err) {
          console.warn(`[Ingest] Error on #${channel.name}: ${err.message}`);
        }
      }

      const summary = results
        .filter(r => r.messagesProcessed > 0)
        .sort((a, b) => b.messagesProcessed - a.messagesProcessed)
        .slice(0, 10)
        .map(r => `• #${r.name}: ${r.messagesProcessed} msgs → ${r.knowledgeEntries} entries`)
        .join('\n');

      await interaction.editReply(
        `**Channel Ingestion Complete**\n` +
        `Channels processed: **${results.length}**\n` +
        `Total messages read: **${totalMessages}**\n` +
        `Knowledge entries created: **${totalKnowledge}**\n\n` +
        (summary ? `**Top channels:**\n${summary}\n\n` : '') +
        `_Billy now remembers what was discussed across the server._`
      );
    }
  } catch (err) {
    console.error('[Ingest] Error:', err);
    await interaction.editReply(`**Channel Ingestion Failed**\n${err.message}`);
  }
}

// ── Button Interaction Handler ─────────────────────────────────────────
async function handleButtonInteraction(interaction) {
  const id = interaction.customId;

  // GEX heatmap refresh: gex_refresh_<TICKER>
  if (id.startsWith('gex_refresh_')) {
    const ticker = id.replace('gex_refresh_', '').toUpperCase();
    await interaction.deferUpdate();

    try {
      const result = await gammaHeatmap.generate(ticker, { strikeRange: 20 });
      const summary = gammaHeatmap.formatForDiscord(ticker, result.spotPrice, result.expirations, result.source);

      const attachment = new AttachmentBuilder(result.buffer, { name: `${ticker}-gamma-heatmap.png` });

      const cfg = require('../config');
      const baseUrl = cfg.dashboardUrl;
      const replyPayload = { content: summary, files: [attachment] };

      if (baseUrl) {
        const dashUrl = `${baseUrl}/gex`;
        replyPayload.content += `\n🖥️ **[Open Interactive Dashboard](${dashUrl})** — real-time updates, toggle expirations, hover details`;

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel('Open Live Dashboard')
            .setStyle(ButtonStyle.Link)
            .setURL(dashUrl)
            .setEmoji('🖥️'),
          new ButtonBuilder()
            .setCustomId(`gex_refresh_${ticker}`)
            .setLabel('Refresh')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🔄'),
        );
        replyPayload.components = [row];
      }

      await interaction.editReply(replyPayload);
    } catch (err) {
      console.error(`[GEX Heatmap Refresh] Error for ${ticker}:`, err);
    }
    return;
  }
}

// ── /algo — Algo trading signals (Databento HFT suite) ───────────────

async function handleAlgo(interaction) {
  await interaction.deferReply();

  const sub = interaction.options.getSubcommand();

  try {
    if (!algoTrading) {
      await interaction.editReply('**Algo Trading** module is not available. Ensure `algo-trading.js` is present.');
      return;
    }

    if (sub === 'signals') {
      const ticker = interaction.options.getString('ticker').toUpperCase();
      await interaction.editReply(`**Algo Trading — ${ticker}**\n⏳ Computing signals...`);

      const formatted = algoTrading.formatForDiscord(ticker);
      await interaction.editReply(formatted);

    } else if (sub === 'pairs') {
      await interaction.editReply('**Pairs Trading**\n⏳ Loading pairs status...');

      const ticker = interaction.options.getString('ticker');
      if (ticker) {
        // Add pair: format TICKER1/TICKER2
        const parts = ticker.toUpperCase().split('/');
        if (parts.length === 2) {
          algoTrading.addPair(parts[0].trim(), parts[1].trim());
          const status = algoTrading.engine.pairs.getPairStatus(parts[0].trim(), parts[1].trim());
          await interaction.editReply(
            `**Pairs Trading — ${parts[0]}/${parts[1]}** — Pair registered!\n` +
            (status ? `Hedge β: ${status.hedgeRatio || 'pending'} | Corr: ${status.correlation || 'pending'}` : 'Waiting for price data...')
          );
        } else {
          await interaction.editReply(`**Pairs Trading** — Invalid format. Use \`TICKER1/TICKER2\` (e.g. SPY/QQQ)`);
        }
      } else {
        const formatted = algoTrading.formatPairsForDiscord();
        await interaction.editReply(formatted);
      }

    } else if (sub === 'vwap') {
      const ticker = interaction.options.getString('ticker').toUpperCase();
      await interaction.editReply(`**VWAP — ${ticker}**\n⏳ Computing...`);

      const formatted = algoTrading.formatVwapForDiscord(ticker);
      await interaction.editReply(formatted);

    } else if (sub === 'pnl') {
      const pnl = algoTrading.getPnl();
      const signals = algoTrading.getRecentSignals(15);

      const parts = ['**Algo Trading P&L**\n'];

      // Book skew P&L
      parts.push(`**Book Skew Strategy:**`);
      parts.push(`  Realized: $${pnl.bookSkew.realized} | Unrealized: $${pnl.bookSkew.unrealized} | Total: $${pnl.bookSkew.total}`);

      // Active positions
      const positions = pnl.positions;
      const posKeys = Object.keys(positions);
      if (posKeys.length > 0) {
        parts.push(`\n**Active Positions (${posKeys.length}):**`);
        for (const tk of posKeys) {
          const p = positions[tk];
          const dir = p.lots > 0 ? 'LONG' : p.lots < 0 ? 'SHORT' : 'FLAT';
          const total = p.realizedPnl + p.unrealizedPnl;
          const icon = total >= 0 ? '🟢' : '🔴';
          parts.push(`  ${icon} **${tk}** ${dir} ${Math.abs(p.lots)} @ $${p.avgEntry.toFixed(2)} — P&L: $${total.toFixed(2)} (${p.tradeCount} trades)`);
        }
      } else {
        parts.push('\n_No active positions_');
      }

      // Pairs P&L
      const pairsStatus = algoTrading.getPairsStatus();
      const activePairs = pairsStatus.filter(p => p.tradeCount > 0);
      if (activePairs.length > 0) {
        parts.push(`\n**Pairs Trading:**`);
        for (const p of activePairs) {
          const icon = p.pnl >= 0 ? '🟢' : '🔴';
          parts.push(`  ${icon} ${p.pair}: P&L ${p.pnl} | ${p.wins}W/${p.losses}L | Sharpe: ${p.sharpe}`);
        }
      }

      // Recent signals
      if (signals.length > 0) {
        parts.push(`\n**Recent Signals (${signals.length}):**`);
        for (const s of signals.slice(-10)) {
          const time = new Date(s.ts).toLocaleTimeString();
          parts.push(`  \`${time}\` ${s.type} — ${s.ticker || s.pair || '?'} ${s.direction || s.side || ''}`);
        }
      }

      await interaction.editReply(parts.join('\n'));

    } else {
      await interaction.editReply('Unknown subcommand. Use `/algo signals`, `/algo pairs`, `/algo vwap`, or `/algo pnl`.');
    }
  } catch (err) {
    console.error(`[Algo] Error:`, err);
    await interaction.editReply(`**Algo Trading**\n❌ ${err.message}`).catch(() => {});
  }
}

// ── ML Predictor ───────────────────────────────────────────────────────

async function handleMLPredict(interaction) {
  if (!mlPredictor.enabled) {
    return interaction.reply({ content: 'ML Predictor requires Python dependencies (`pip install -r ml/requirements.txt`).', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply();

  const ticker = interaction.options.getString('ticker');
  const forward = interaction.options.getInteger('forward') || 20;
  const modelType = interaction.options.getString('model') || 'both';
  const days = interaction.options.getInteger('days');
  const startDate = interaction.options.getString('start_date');
  const endDate = interaction.options.getString('end_date');

  const datePattern = /^\d{4}-\d{2}-\d{2}$/;

  try {
    const options = { forward, model: modelType };

    // Validate date formats
    if (startDate) {
      if (!datePattern.test(startDate)) return interaction.editReply('Invalid start_date format. Use YYYY-MM-DD.');
      options.startDate = startDate;
    }
    if (endDate) {
      if (!datePattern.test(endDate)) return interaction.editReply('Invalid end_date format. Use YYYY-MM-DD.');
      options.endDate = endDate;
    }
    if (startDate && endDate && startDate > endDate) {
      return interaction.editReply(`start_date (${startDate}) must be before end_date (${endDate}).`);
    }
    if (days) {
      options.days = days;
    }

    const result = await mlPredictor.runPrediction(ticker, options);
    const summary = mlPredictor.formatResults(result);

    const replyPayload = { content: summary };
    try {
      const chartBuffer = await mlPredictor.getChartBuffer(result);
      const attachment = new AttachmentBuilder(chartBuffer, { name: `ml-predict-${ticker}.png` });
      replyPayload.files = [attachment];
    } catch (chartErr) {
      console.warn('[ML-Predict] Chart not available:', chartErr.message);
      replyPayload.content += '\n\n*(Chart rendering unavailable)*';
    }

    await interaction.editReply(replyPayload);
  } catch (err) {
    console.error(`[ML-Predict] Error for ${ticker}:`, err);
    const msg = err.message.length > 500 ? err.message.slice(0, 500) + '...' : err.message;
    await interaction.editReply(`ML prediction failed for **${ticker}**: ${msg}`);
  }
}

// ── ML Portfolio Backtester ────────────────────────────────────────────

async function handleMLPortfolio(interaction) {
  if (!mlPortfolio.enabled) {
    return interaction.reply({ content: 'ML Portfolio requires Python dependencies (`pip install -r ml/requirements.txt`).', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply();

  const tickers = interaction.options.getString('tickers') || 'mega';
  const forward = interaction.options.getInteger('forward') || 20;
  const days = interaction.options.getInteger('days');
  const startDate = interaction.options.getString('start_date');
  const endDate = interaction.options.getString('end_date');
  const rebalance = interaction.options.getString('rebalance') || 'W-MON';
  const topK = interaction.options.getInteger('top_k') || 10;
  const bottomK = interaction.options.getInteger('bottom_k') || 0;
  const weighting = interaction.options.getString('weighting') || 'equal';
  const maxWeight = interaction.options.getNumber('max_weight') || 0.15;
  const maxLeverage = interaction.options.getNumber('max_leverage') || 1.0;
  const costBps = interaction.options.getInteger('cost_bps');
  const slippageBps = interaction.options.getInteger('slippage_bps');
  const seed = interaction.options.getInteger('seed') || 42;

  const datePattern = /^\d{4}-\d{2}-\d{2}$/;

  try {
    const options = {
      tickers, forward, rebalance, topK, bottomK,
      weighting, maxWeight, maxLeverage,
      costBps: costBps != null ? costBps : 10,
      slippageBps: slippageBps != null ? slippageBps : 0,
      seed,
    };

    if (startDate) {
      if (!datePattern.test(startDate)) return interaction.editReply('Invalid start_date format. Use YYYY-MM-DD.');
      options.startDate = startDate;
    }
    if (endDate) {
      if (!datePattern.test(endDate)) return interaction.editReply('Invalid end_date format. Use YYYY-MM-DD.');
      options.endDate = endDate;
    }
    if (startDate && endDate && startDate > endDate) {
      return interaction.editReply(`start_date (${startDate}) must be before end_date (${endDate}).`);
    }
    if (days) {
      options.days = days;
    }

    const result = await mlPortfolio.runBacktest(options);
    const summary = mlPortfolio.formatResults(result);

    const replyPayload = { content: summary };
    try {
      const chartBuffer = await mlPortfolio.getChartBuffer(result);
      const attachment = new AttachmentBuilder(chartBuffer, { name: `ml-portfolio-${seed}.png` });
      replyPayload.files = [attachment];
    } catch (chartErr) {
      console.warn('[ML-Portfolio] Chart not available:', chartErr.message);
      replyPayload.content += '\n\n*(Chart rendering unavailable)*';
    }

    await interaction.editReply(replyPayload);
  } catch (err) {
    console.error(`[ML-Portfolio] Error:`, err);
    const msg = err.message.length > 500 ? err.message.slice(0, 500) + '...' : err.message;
    await interaction.editReply(`ML portfolio backtest failed: ${msg}`);
  }
}

module.exports = { handleCommand, handleButtonInteraction };
