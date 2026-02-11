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
const technicals = require('../services/technicals');
const stocktwits = require('../services/stocktwits');
const mahoraga = require('../services/mahoraga');
const stream = require('../services/stream');
const kalshi = require('../services/kalshi');
const reddit = require('../services/reddit');
const validea = require('../services/validea');
const macro = require('../services/macro');
const sectors = require('../services/sectors');
const policy = require('../services/policy');
const { AttachmentBuilder, MessageFlags, PermissionsBitField } = require('discord.js');
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
    '`/gex` — Gamma exposure | `/news` — Market news',
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
    '**SHARK Agent**',
    '`/agent status` — Positions, risk, P/L',
    '`/agent config` — View settings | `/agent set` — Change settings',
    '`/agent enable|disable|kill|reset|logs`',
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

// ── /gex — Gamma Exposure analysis with chart ─────────────────────────
async function handleGEX(interaction) {
  await interaction.deferReply();

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

    // Build the text summary
    const summary = gamma.formatForDiscord(result);

    // Attach the chart image if available
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
    const msg = err.message || 'Unknown error';
    await interaction.editReply(`**${ticker} — Gamma Exposure**\n❌ ${msg}`);
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
  const privilegedActions = new Set(['enable', 'disable', 'kill', 'set', 'reset', 'trade']);
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

// ── /predict — Search Kalshi prediction markets + AI betting recs ────
async function handlePredict(interaction) {
  await interaction.deferReply();

  const topic = interaction.options.getString('topic');

  try {
    await interaction.editReply(`**Prediction Markets — "${topic}"**\n⏳ Searching Kalshi markets...`);

    const markets = await kalshi.searchMarkets(topic, 8);

    if (!markets || markets.length === 0) {
      await interaction.editReply(`**Prediction Markets — "${topic}"**\nNo open markets found for "${topic}". Try broader terms like "inflation", "bitcoin", "election", "recession".`);
      return;
    }

    // Show the markets immediately
    const formatted = kalshi.formatMarketsForDiscord(markets, `Prediction Markets — "${topic}"`);
    await interaction.editReply(formatted);

    // Run AI analysis in the background and post as follow-up
    await interaction.followUp({ content: `⏳ AI is analyzing ${markets.length} markets for betting edge...`, flags: MessageFlags.Ephemeral });

    const aiAnalysis = await kalshi.analyzeBets(markets, topic);

    if (aiAnalysis) {
      // Chunk if needed
      if (aiAnalysis.length <= 1900) {
        await interaction.followUp(`**AI Betting Analysis — "${topic}"**\n\n${aiAnalysis}`);
      } else {
        const chunks = [];
        let remaining = aiAnalysis;
        while (remaining.length > 0) {
          chunks.push(remaining.slice(0, 1850));
          remaining = remaining.slice(1850);
        }
        await interaction.followUp(`**AI Betting Analysis — "${topic}"**\n\n${chunks[0]}${chunks.length > 1 ? '...' : ''}`);
        for (let i = 1; i < Math.min(chunks.length, 3); i++) {
          await interaction.followUp({ content: chunks[i], flags: MessageFlags.Ephemeral });
        }
      }
    }
  } catch (err) {
    console.error('[Predict] Error:', err);
    await interaction.editReply(`**Prediction Markets — "${topic}"**\n❌ ${err.message}`);
  }
}

// ── /odds — Deep dive on a specific Kalshi market ────────────────────
async function handleOdds(interaction) {
  await interaction.deferReply();

  const ticker = interaction.options.getString('market').toUpperCase();

  try {
    await interaction.editReply(`**${ticker} — Market Deep Dive**\n⏳ Fetching market data & trades...`);

    // Fetch market details and recent trades in parallel
    const [market, trades] = await Promise.all([
      kalshi.getMarket(ticker),
      kalshi.getTrades(ticker, 20).catch(() => null),
    ]);

    if (!market || !market.ticker) {
      await interaction.editReply(`**${ticker}**\n❌ Market not found. Use \`/predict <topic>\` to search for valid market tickers.`);
      return;
    }

    // Show market details immediately
    const formatted = kalshi.formatMarketDetailForDiscord(market, trades);
    await interaction.editReply(formatted);

    // Run AI deep analysis
    await interaction.followUp({ content: `⏳ AI is running deep probability analysis on **${market.title || ticker}**...`, flags: MessageFlags.Ephemeral });

    const aiAnalysis = await kalshi.analyzeMarket(market, trades);

    if (aiAnalysis) {
      if (aiAnalysis.length <= 1900) {
        await interaction.followUp(`**AI Analysis — ${market.title || ticker}**\n\n${aiAnalysis}`);
      } else {
        const chunks = [];
        let remaining = aiAnalysis;
        while (remaining.length > 0) {
          chunks.push(remaining.slice(0, 1850));
          remaining = remaining.slice(1850);
        }
        await interaction.followUp(`**AI Analysis — ${market.title || ticker}**\n\n${chunks[0]}${chunks.length > 1 ? '...' : ''}`);
        for (let i = 1; i < Math.min(chunks.length, 3); i++) {
          await interaction.followUp({ content: chunks[i], flags: MessageFlags.Ephemeral });
        }
      }
    }
  } catch (err) {
    console.error(`[Odds] Error for ${ticker}:`, err);
    await interaction.editReply(`**${ticker} — Market Deep Dive**\n❌ ${err.message}`);
  }
}

// ── /bets — Browse trending/categorized Kalshi markets ───────────────
async function handleBets(interaction) {
  await interaction.deferReply();

  const category = interaction.options.getString('category') || 'trending';

  try {
    let markets;
    let title;

    if (category === 'trending') {
      await interaction.editReply('**Kalshi — Trending Bets**\n⏳ Fetching hottest prediction markets...');
      markets = await kalshi.getTrendingMarkets(12);
      title = 'Kalshi — Trending Prediction Markets';
    } else {
      const labels = {
        economics: 'Economics',
        crypto: 'Crypto',
        politics: 'Politics',
        tech: 'Tech',
        markets: 'Markets & Indices',
        sports: 'Sports',
      };
      const label = labels[category] || category;
      await interaction.editReply(`**Kalshi — ${label} Markets**\n⏳ Searching...`);
      markets = await kalshi.getMarketsByCategory(category, 12);
      title = `Kalshi — ${label} Prediction Markets`;
    }

    if (!markets || markets.length === 0) {
      await interaction.editReply(`**${title}**\nNo open markets found in this category.`);
      return;
    }

    const formatted = kalshi.formatMarketsForDiscord(markets, title);
    await interaction.editReply(formatted);

    // Quick AI take on the category
    const aiTake = await kalshi.analyzeBets(markets.slice(0, 6), category);
    if (aiTake) {
      if (aiTake.length <= 1900) {
        await interaction.followUp(`**AI Quick Picks — ${category}**\n\n${aiTake}`);
      } else {
        await interaction.followUp(`**AI Quick Picks — ${category}**\n\n${aiTake.slice(0, 1900)}...`);
      }
    }
  } catch (err) {
    console.error(`[Bets] Error for ${category}:`, err);
    await interaction.editReply(`**Kalshi — ${category}**\n❌ ${err.message}`);
  }
}

module.exports = { handleCommand };
