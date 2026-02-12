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
const { AttachmentBuilder, MessageFlags, PermissionsBitField } = require('discord.js');
const { getMarketContext, formatContextForAI } = require('../data/market');
const config = require('../config');
const { instrumentInteraction } = require('../utils/safe-send');

async function handleCommand(interaction) {
  instrumentInteraction(interaction);

  const { commandName } = interaction;
  stats.recordCommand();

  switch (commandName) {
    case 'ask':
      return handleAsk(interaction);
    case 'memory':
      // User has no stored memory yet — friendly nudge to start interacting
      const userId = interaction.user.id;
      const hasMemory = memory.getUser(userId);

      if (!hasMemory || hasMemory.interactionCount === 0) {
        return interaction.reply({
          content: `Welcome! I don't have any info about you yet. 👋\nStart chatting with me — ask a question, check your profile, or add a ticker to your watchlist.\nI'll remember our conversation as we go!`,
          flags: MessageFlags.Ephemeral,
        });
      }
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
    case 'options':
      return handleOptions(interaction);
    case 'brain':
      return handleBrain(interaction);
    case 'squeeze':
      return handleSqueeze(interaction);
    case 'yolo':
      return handleYolo(interaction);
    case 'github':
      return interaction.reply('Check out our GitHub: https://github.com/your-bot-repo', { flags: MessageFlags.Ephemeral });
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
    await interaction.editReply(`Error processing your question: ${err.message || 'An unexpected error occurred.'}`);
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
    await interaction.reply({ content: `Could not retrieve memory data: ${err.message}`, flags: MessageFlags.Ephemeral });
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

    await interaction.reply(`Switched AI model: **${oldModel}** → **${modelName}**`);
  } catch (err) {
    console.error('[Model] Error:', err);
    await interaction.reply({ content: 'Failed to switch model.', flags: MessageFlags.Ephemeral });
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
      `\n_This bot is self-aware and actively improves its own code autonomously. Check \`/brain\` to see reasoning and self-modification._`,
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
    await interaction.reply({ content: `Could not retrieve bot statistics: ${err.message}`, flags: MessageFlags.Ephemeral });
  }
}

async function handleAnalyze(interaction) {
  await interaction.deferReply();

  const ticker = yahoo.resolveTicker(interaction.options.getString('ticker'));

  if (!ticker) {
    await interaction.editReply('Invalid ticker symbol. Use 1-12 alphanumeric characters (e.g. AAPL, TSLA).');
    return;
  }

  try {
    const context = await getMarketContext(ticker);

    if (context.error) {
      await interaction.editReply(`Cannot analyze ${ticker}\n${context.message}`);
      return;
    }

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
    await interaction.editReply(`Error analyzing ${ticker}: ${err.message}`);
  }
}

async function handlePrice(interaction) {
  await interaction.deferReply();

  const ticker = yahoo.resolveTicker(interaction.options.getString('ticker'));

  if (!ticker) {
    await interaction.editReply('Invalid ticker symbol. Use 1-12 alphanumeric characters (e.g. AAPL, TSLA).');
    return;
  }

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

// ── /screen — Run a stock screen ─────────────────────────────────────
async function handleScreen(interaction) {
  await interaction.deferReply();

  const universe = interaction.options.getString('universe');
  const rulesStr = interaction.options.getString('rules');

  try {
    let quotes;
    let screenLabel = 'Top Gainers';

    // Parse rules into screener filters if provided
    if (rulesStr) {
      const filters = _parseScreenRules(rulesStr, universe);
      quotes = await yahoo.screenStocks(filters);
      screenLabel = 'Screener';
    } else {
      // Default: use universe to pick screen type
      const lower = (universe || '').toLowerCase();
      if (lower.includes('loser') || lower.includes('drop')) {
        quotes = await yahoo.screenByLosers();
        screenLabel = 'Top Losers';
      } else if (lower.includes('active') || lower.includes('volume')) {
        quotes = await yahoo.screenByMostActive();
        screenLabel = 'Most Active';
      } else {
        quotes = await yahoo.screenByGainers();
        screenLabel = 'Top Gainers';
      }
    }

    if (!quotes || quotes.length === 0) {
      await interaction.editReply('No screen results available right now. Try again later.');
      return;
    }

    const formatted = yahoo.formatScreenForDiscord(quotes);
    await interaction.editReply(`**Screen: ${universe}** (${screenLabel})${rulesStr ? ` | Rules: ${rulesStr}` : ''}\n${formatted}\n\n_Data via FMP_`);
  } catch (err) {
    console.error(`[Screen] Error:`, err);
    await interaction.editReply(`Screen failed: ${err.message}`);
  }
}

/**
 * Parse user-provided screen rules into FMP screener filters.
 * Examples: "PE < 15, MktCap > 1e9", "volume > 5M, sector = tech"
 */
function _parseScreenRules(rulesStr, universe) {
  const filters = { country: 'US', isActivelyTrading: true };
  const rules = rulesStr.split(',').map(r => r.trim().toLowerCase());

  for (const rule of rules) {
    // Match patterns like "mktcap > 1e9", "pe < 15", "volume > 5M", "sector = tech"
    const match = rule.match(/^(\w+)\s*([<>=!]+)\s*(.+)$/);
    if (!match) continue;

    const [, key, op, rawVal] = match;
    const val = _parseNumericValue(rawVal.trim());

    switch (key) {
      case 'mktcap': case 'marketcap': case 'cap':
        if (op.includes('>')) filters.marketCapMin = val;
        else if (op.includes('<')) filters.marketCapMax = val;
        break;
      case 'volume': case 'vol':
        if (op.includes('>')) filters.volumeMin = val;
        else if (op.includes('<')) filters.volumeMax = val;
        break;
      case 'price':
        if (op.includes('>')) filters.priceMin = val;
        else if (op.includes('<')) filters.priceMax = val;
        break;
      case 'beta':
        if (op.includes('>')) filters.betaMin = val;
        else if (op.includes('<')) filters.betaMax = val;
        break;
      case 'dividend': case 'div': case 'yield':
        if (op.includes('>')) filters.dividendMin = val;
        else if (op.includes('<')) filters.dividendMax = val;
        break;
      case 'sector':
        filters.sector = _normalizeSector(rawVal.trim());
        break;
      case 'industry':
        filters.industry = rawVal.trim();
        break;
      case 'exchange':
        filters.exchange = rawVal.trim().toUpperCase();
        break;
    }
  }

  return filters;
}

function _parseNumericValue(str) {
  const lower = str.toLowerCase().replace(/,/g, '');
  if (lower.endsWith('t')) return parseFloat(lower) * 1e12;
  if (lower.endsWith('b')) return parseFloat(lower) * 1e9;
  if (lower.endsWith('m')) return parseFloat(lower) * 1e6;
  if (lower.endsWith('k')) return parseFloat(lower) * 1e3;
  if (lower.includes('e')) return Number(lower);
  return parseFloat(lower);
}

function _normalizeSector(raw) {
  const map = {
    tech: 'Technology', technology: 'Technology',
    health: 'Healthcare', healthcare: 'Healthcare',
    energy: 'Energy', finance: 'Financial Services',
    financial: 'Financial Services', consumer: 'Consumer Cyclical',
    industrial: 'Industrials', 'real estate': 'Real Estate',
    utilities: 'Utilities', materials: 'Basic Materials',
    communication: 'Communication Services',
  };
  return map[raw.toLowerCase()] || raw;
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
    '**Owner:** `!update` `!suggest` `!autoedit` `!rollback` `!selfheal`',
    'Mention me or DM me to chat! React 👍/👎 on replies so I learn.',
  ];

  await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
}

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
    await interaction.reply({ content: 'Sentiment analysis failed.', flags: MessageFlags.Ephemeral });
  }
}

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
      await interaction.reply({ content: 'Please provide a ticker to remove. Example: `/watchlist remove AAPL`' , flags: MessageFlags.Ephemeral });
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
        const changeStr = pct != null ? `(${pct > 0 ? '+' : ''}${pct.toFixed(2)}%)` : '';
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

  if (!ticker) {
    return interaction.editReply('Invalid ticker symbol. Use 1-12 alphanumeric characters (e.g. AAPL, TSLA).');
  }

  const updateProgress = async (stage, message) => {
    try {
      await interaction.editReply(`**TradingAgents — ${ticker}**\n⏳ ${message}`);
    } catch (e) {
      // Ignore edit errors during rapid updates
    }
  };

  try {
    const result = await tradingAgents.analyze(ticker, updateProgress);

    const formatted = tradingAgents.formatForDiscord(result);
    await interaction.editReply(formatted);

    const detailed = tradingAgents.formatDetailedReport(result);
    if (detailed.length <= 1950) {
      await interaction.followUp(`\`\`\`md\n${detailed}\n\`\`\``);
    } else {
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
  if (!query) {
    return interaction.reply({ content: 'Please provide a research query.', flags: MessageFlags.Ephemeral });
  }

  const updateProgress = async (message) => {
    try {
      await interaction.editReply(`**Agent Swarm Research**\n⏳ ${message}`);
    } catch (e) {
      // Ignore edit errors during rapid updates
    }
  };

  try {
    const result = await agentSwarm.research(query, updateProgress);

    const formatted = agentSwarm.formatForDiscord(result);
    await interaction.editReply(formatted);

    const detailed = agentSwarm.formatDetailedReport(result);
    if (detailed.length <= 1950) {
      await interaction.followUp(`\`\`\`md\n${detailed}\n\`\`\``);
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
    default:
      return handleGEXChart(interaction);
  }
}

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
    await interaction.editReply(`**${ticker} — Gamma Exposure (${expLabel})**\n⏳ Fetching options chain and calculating GEX...`);

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

    const gexSummary = await engine.analyze(ticker);
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

async function handleTechnicals(interaction) {
  await interaction.deferReply();

  const rawTicker = interaction.options.getString('ticker');
  const ticker = yahoo.sanitizeTicker(rawTicker);
  if (!ticker) {
    return interaction.editReply('Invalid ticker symbol. Use 1-12 alphanumeric characters (e.g. AAPL, TSLA).');
  }

  try {
    await interaction.editReply(`**${ticker} — Technical Analysis**\n⏳ Fetching 200+ days of price history and computing indicators...`);

    const result = await technicals.analyze(ticker);
    const formatted = technicals.formatForDiscord(result);

    await interaction.editReply(formatted);
  } catch (err) {
    console.error(`[Technicals] Error for ${ticker}:`, err);
    await interaction.editReply(`**${ticker} — Technical Analysis**\n❌ ${err.message}`);
  }
}

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

async function handleReddit(interaction) {
  await interaction.deferReply();

  const ticker = interaction.options.getString('ticker');

  try {
    if (ticker) {
      const upper = ticker.toUpperCase();
      await interaction.editReply(`**${upper} — Reddit Sentiment**\n⏳ Scanning r/wallstreetbets, r/stocks, r/investing, r/options...`);

      const result = await reddit.analyzeSymbol(upper);
      const formatted = reddit.formatSymbolForDiscord(result);
      await interaction.editReply(formatted);
    } else {
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

async function handleMacro(interaction) {
  await interaction.deferReply();

  try {
    await interaction.editReply('**Macro Environment**\n⏳ Analyzing market regime, benchmarks, sector breadth...');

    const result = await macro.analyze();
    const formatted = macro.formatForDiscord(result);

    if (formatted.length <= 2000) {
      await interaction.editReply(formatted);
    } else {
      await interaction.editReply(formatted.slice(0, 1990) + '...');
    }

    // Unusual Whales enrichment — TODO: add uw (unusual-whales) service and re-enable
  } catch (err) {
    console.error('[Macro] Error:', err);
    await interaction.editReply(`**Macro Environment**\n❌ ${err.message}`);
  }
}

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

  await interaction.deferReply();

  try {
    const updateProgress = async (stage, message) => {
      try {
        await interaction.editReply(`**SHARK — ${stage}**\n${message}`);
      } catch (e) {
        // Ignore edit errors during rapid updates
      }
    };

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
            '**SHARK — DANGEROUS MODE DISABLED**\n' +
            'Restored previous trading parameters.\n\n' +
            '_Use `/agent dangerous` again to disable and restore previous settings._'
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
          lines.push(result.message);
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

// ── /predict — Search Kalshi prediction markets + AI high-conviction play ───
async function handlePredict(interaction) {
  await interaction.deferReply();

  const topic = interaction.options.getString('topic');

  try {
    await interaction.editReply(`**Prediction Markets — "${topic}"**\n⏳ Searching Kalshi markets and finding the best play...`);

    const markets = await kalshi.searchMarkets(topic, 30);

    if (!markets || markets.length === 0) {
      await interaction.editReply(`**Prediction Markets — "${topic}"**\nNo open markets found for "${topic}". Try broader terms like "inflation", "bitcoin", "election", "recession".`);
      return;
    }

    const formatted = kalshi.formatMarketsForDiscord(markets, `Prediction Markets — "${topic}"`);
    await interaction.editReply(formatted);

    const aiAnalysis = await kalshi.analyzeBets(markets, topic);

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
    await interaction.editReply(`**${rawInput} — Market Deep Dive**\n⏳ Fetching market data and trades...`);

    let market = null;
    let trades = null;

    try {
      [market, trades] = await Promise.all([
        kalshi.getMarket(rawInput),
        kalshi.getTrades(rawInput, 20).catch(() => null),
      ]);
    } catch (fetchErr) {
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

    const formatted = kalshi.formatMarketDetailForDiscord(market, trades);
    await interaction.editReply(formatted);

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

    const formatted = kalshi.formatMarketsForDiscord(markets, title);
    await interaction.editReply(formatted);

    const aiTake = await kalshi.analyzeBets(markets, category);

    if (aiTake) {
      const output = aiTake.length <= 1900 ? aiTake : aiTake.slice(0, 1900) + '...';
      await interaction.followUp(`${output}`);
    }
  } catch (err) {
    console.error(`[Bets] Error for ${category}:`, err);
    await interaction.editReply(`**Kalshi — ${category}**\n❌ ${err.message}`);
  }
}

// ── /options — 0DTE Options Trading Engine ────────────────────────```
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
            'Specify an underlying to run the full options pipeline.\n\n' +
            '`/options trade ticker:SPY` — AI picks direction + contract\n' +
            '`/options trade ticker:QQQ direction:call` — force call direction\n' +
            '`/options trade ticker:SPY direction:put strategy:swing` — force put + swing strategy'
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
          const emoji = log.type === 'trade' ? '💰' : log.type === 'error' ? '❌' : '🚫';
          lines.push(`\`${time}\` ${emoji} ${log.message}`);
        }
        await interaction.editReply(lines.join('\n'));
        break;
      }
      default: {
        await interaction.editReply('Unknown options action. Use: `status`, `trade`, `close`, `logs`');
      }
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
    for (const [actionName, ts] of Object.entries(status.lastActions)) {
      const ago = Math.round((Date.now() - ts) / 60000);
      lines.push(`• \`${actionName}\`: ${ago} min ago`);
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
      const time = new Date(e.timestamp).toLocaleString('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit',
      });
      const typeEmoji = {
        observation: '👁️', action: '⚡', self_tune: '🧠', regime_change: '🔄',
        insight: '💡', watchlist: '🔍', thread: '🧵', daily_journal: '📓',
      }[e.type] || '📝';
      lines.push(`${typeEmoji} **${time} ET** [${e.type}] ${e.content.slice(0, 200)}`);
    }
    return interaction.reply(lines.join('\n'));
  }

  if (action === 'tuning') {
    const tuning = initiative.getJournal(50).filter(e => e.type === 'self_tune');
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
    return interaction.reply(lines.join('\n'));
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

async function handleYolo(interaction) {
  const action = interaction.options.getString('action');
  const hasAdminPerms = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
  const isOwner = config.botOwnerId && interaction.user.id === config.botOwnerId;
  const isAuthorized = isOwner || hasAdminPerms;

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
        '_The bot scans its own codebase, identifies improvements, ' +
        'generates fixes, and deploys them autonomously via GitHub._',
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

    default: {
      return interaction.reply({ content: 'Unknown YOLO action.', flags: MessageFlags.Ephemeral });
    }
  }
}

module.exports = { handleCommand };