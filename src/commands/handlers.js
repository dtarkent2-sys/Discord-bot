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
const { AttachmentBuilder } = require('discord.js');
const { getMarketContext, formatContextForAI } = require('../data/market');

async function handleCommand(interaction) {
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
    default:
      await interaction.reply({ content: 'Unknown command.', ephemeral: true });
  }
}

async function handleAsk(interaction) {
  await interaction.deferReply();

  const question = interaction.options.getString('question');
  const userId = interaction.user.id;
  const username = interaction.user.username;

  const sentimentResult = sentiment.track(userId, question);
  const response = await ai.chat(userId, username, question, { sentiment: sentimentResult });

  await interaction.editReply(response);
}

async function handleMemory(interaction) {
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

  await interaction.reply({ content: parts.join('\n'), ephemeral: true });
}

async function handleModel(interaction) {
  const modelName = interaction.options.getString('name');
  const oldModel = ai.getModel();
  ai.setModel(modelName);

  await interaction.reply(`Switched AI model: **${oldModel}** → **${modelName}**`);
}

async function handleStats(interaction) {
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
    '**Slash Commands:**',
    '`/ask <question>` — Ask the AI a question',
    '`/analyze <ticker>` — AI-powered stock/crypto analysis with live data (e.g. AAPL, BTC, ETH)',
    '`/deepanalysis <ticker>` — Multi-agent deep analysis — BUY/SELL/HOLD signal (stocks & crypto)',
    '`/research <query>` — Agent Swarm — parallel AI agents research any complex topic',
    '`/price <ticker>` — Quick price + key stats lookup (stocks & crypto)',
    '`/news [symbols] [limit]` — Latest market news (Alpaca)',
    '`/screen <universe> [rules]` — Run a stock screen',
    '`/watchlist [action] [ticker]` — Manage your stock/crypto watchlist',
    '`/sentiment <text>` — Analyze text sentiment',
    '`/topic` — Generate an AI discussion topic',
    '`/profile [@user]` — View user profile and activity',
    '`/memory` — See what the bot remembers about you',
    '`/model <name>` — Switch the AI model',
    '`/stats` — View bot statistics',
    '`/help` — Show this message',
    '',
    '**Prefix Commands (owner only):**',
    '`!update <file>` — Push code to GitHub',
    '`!suggest <file> <instruction>` — AI code suggestion',
    '`!autoedit <file> <instruction>` — Auto-apply safe code changes',
    '`!rollback <file>` — Revert a file to its previous version',
    '`!selfheal <file>` — AI auto-fix critical bugs in a file',
    '',
    '**Other:**',
    'Mention me or DM me to chat anytime!',
    'React with :thumbsup: or :thumbsdown: on my replies so I can learn.',
  ];

  await interaction.reply({ content: lines.join('\n'), ephemeral: true });
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
      await interaction.reply({ content: 'Please provide a ticker to add. Example: `/watchlist add AAPL` or `/watchlist add BTC`', ephemeral: true });
      return;
    }
    const resolved = yahoo.resolveTicker(ticker);
    const list = memory.addToWatchlist(userId, resolved);
    await interaction.reply(`Added **${resolved}** to your watchlist. (${list.length} total)`);
    return;
  }

  if (action === 'remove') {
    if (!ticker) {
      await interaction.reply({ content: 'Please provide a ticker to remove. Example: `/watchlist remove AAPL`', ephemeral: true });
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
    await interaction.reply({ content: 'Your watchlist is empty. Use `/watchlist add <ticker>` to add stocks.', ephemeral: true });
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
    await interaction.reply({ content: `No data on **${targetUser.username}** yet.`, ephemeral: true });
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
      await interaction.followUp({ content: `\`\`\`md\n${detailed}\n\`\`\``, ephemeral: true });
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
          ephemeral: true,
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
      await interaction.followUp({ content: `\`\`\`md\n${detailed}\n\`\`\``, ephemeral: true });
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
          ephemeral: true,
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

  const ticker = interaction.options.getString('ticker').toUpperCase();

  if (!gamma.enabled) {
    return interaction.editReply('GEX analysis is currently unavailable.');
  }

  try {
    await interaction.editReply(`**${ticker} — Gamma Exposure**\n⏳ Fetching options chain & calculating GEX...`);

    const result = await gamma.analyze(ticker);

    // Build the text summary
    const summary = gamma.formatForDiscord(result);

    // Attach the chart image
    const attachment = new AttachmentBuilder(result.chartBuffer, { name: `${ticker}-gex.png` });

    await interaction.editReply({
      content: summary,
      files: [attachment],
    });
  } catch (err) {
    console.error(`[GEX] Error for ${ticker}:`, err);
    const msg = err.message || 'Unknown error';
    await interaction.editReply(`**${ticker} — Gamma Exposure**\n❌ ${msg}`);
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

module.exports = { handleCommand };
