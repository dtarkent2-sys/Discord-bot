const ai = require('../services/ai');
const memory = require('../services/memory');
const mood = require('../services/mood');
const stats = require('../services/stats');
const reactions = require('../services/reactions');
const sentiment = require('../services/sentiment');
const p123 = require('../services/p123');
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
    `**P123 API:** ${p123.enabled ? 'Connected' : 'Not configured'}`,
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

// ── /analyze — AI-powered analysis with live P123 data ──────────────
async function handleAnalyze(interaction) {
  await interaction.deferReply();

  const ticker = interaction.options.getString('ticker').toUpperCase();

  // Fetch real market data from P123
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

  const ticker = interaction.options.getString('ticker').toUpperCase();

  if (!p123.enabled) {
    await interaction.editReply('Portfolio123 API is not configured. Set P123_API_ID and P123_API_KEY.');
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

    const lines = [`**${ticker}** — Quick Stats\n`];
    if (q.price) lines.push(`**Price:** $${q.price}`);
    if (q.volume) lines.push(`**Volume:** ${Number(q.volume).toLocaleString()}`);
    if (q.mktCap) lines.push(`**Market Cap:** $${(q.mktCap / 1e9).toFixed(2)}B`);
    if (q.pe) lines.push(`**P/E:** ${q.pe}`);
    if (s.PB) lines.push(`**P/B:** ${s.PB}`);
    if (s.EPS) lines.push(`**EPS:** $${s.EPS}`);
    if (s.DivYield) lines.push(`**Div Yield:** ${s.DivYield}%`);
    if (s.ROE) lines.push(`**ROE:** ${s.ROE}%`);
    if (q.changePercent != null) lines.push(`**Daily Change:** ${q.changePercent > 0 ? '+' : ''}${q.changePercent.toFixed(2)}%`);
    if (q.rsi14) lines.push(`**RSI(14):** ${q.rsi14}`);
    if (q.sma50) lines.push(`**SMA(50):** $${q.sma50}`);
    if (q.sma200) lines.push(`**SMA(200):** $${q.sma200}`);
    if (s['1dReturn']) lines.push(`**1-Day:** ${((s['1dReturn'] - 1) * 100).toFixed(2)}%`);
    if (s['1wkReturn']) lines.push(`**1-Week:** ${((s['1wkReturn'] - 1) * 100).toFixed(2)}%`);
    if (s['1moReturn']) lines.push(`**1-Month:** ${((s['1moReturn'] - 1) * 100).toFixed(2)}%`);

    if (context.missingFields) {
      lines.push(`\n_Some data unavailable: ${context.missingFields.map(m => m.field).join(', ')}_`);
    }

    lines.push(`\n_Data via Portfolio123 | ${new Date().toLocaleString()}_`);
    await interaction.editReply(lines.join('\n'));
  } catch (err) {
    console.error(`[Price] Error for ${ticker}:`, err);
    await interaction.editReply(`Error fetching data for **${ticker}**: ${err.message}`);
  }
}

// ── /screen — Run a stock screen ────────────────────────────────────
async function handleScreen(interaction) {
  await interaction.deferReply();

  const universe = interaction.options.getString('universe');
  const rulesStr = interaction.options.getString('rules');

  if (!p123.enabled) {
    await interaction.editReply('Portfolio123 API is not configured. Set P123_API_ID and P123_API_KEY.');
    return;
  }

  try {
    const rules = rulesStr
      ? rulesStr.split(',').map(r => ({ formula: r.trim(), type: 'common' }))
      : undefined;

    const results = await p123.quickScreen(universe, { rules, maxResults: 20 });
    const formatted = p123.formatScreenForDiscord(results);

    await interaction.editReply(`**Screen: ${universe}**${rulesStr ? ` | Rules: ${rulesStr}` : ''}\n${formatted}`);
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
    '`/analyze <ticker>` — AI-powered stock analysis with live data',
    '`/price <ticker>` — Quick price + key stats lookup',
    '`/screen <universe> [rules]` — Run a stock screen',
    '`/watchlist [action] [ticker]` — Manage your stock watchlist',
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
      await interaction.reply({ content: 'Please provide a ticker to add. Example: `/watchlist add AAPL`', ephemeral: true });
      return;
    }
    const list = memory.addToWatchlist(userId, ticker);
    await interaction.reply(`Added **${ticker.toUpperCase()}** to your watchlist. (${list.length} stocks total)`);
    return;
  }

  if (action === 'remove') {
    if (!ticker) {
      await interaction.reply({ content: 'Please provide a ticker to remove. Example: `/watchlist remove AAPL`', ephemeral: true });
      return;
    }
    const list = memory.removeFromWatchlist(userId, ticker);
    await interaction.reply(`Removed **${ticker.toUpperCase()}** from your watchlist. (${list.length} stocks remaining)`);
    return;
  }

  // Show watchlist
  const list = memory.getWatchlist(userId);
  if (list.length === 0) {
    await interaction.reply({ content: 'Your watchlist is empty. Use `/watchlist add <ticker>` to add stocks.', ephemeral: true });
    return;
  }

  // If P123 is available, fetch live prices
  if (p123.enabled) {
    await interaction.deferReply();
    try {
      const data = await p123.getData(list, ['Close(0)', 'Close(0)/Close(-1)-1'], {
        precision: 2,
        includeNames: true,
      });

      if (data && data.rows && data.rows.length > 0) {
        const lines = [`**Your Watchlist (${list.length} stocks)**\n`];
        for (let i = 0; i < data.rows.length; i++) {
          const row = data.rows[i];
          const name = data.names ? data.names[i] : list[i];
          const price = row[0];
          const change = row[1];
          const changeStr = change != null ? ` (${change > 0 ? '+' : ''}${(change * 100).toFixed(2)}%)` : '';
          lines.push(`**${name || list[i]}** — $${price}${changeStr}`);
        }
        lines.push(`\n_Data via Portfolio123 | ${new Date().toLocaleString()}_`);
        await interaction.editReply(lines.join('\n'));
        return;
      }
    } catch (err) {
      console.error('[Watchlist] P123 fetch error:', err.message);
    }
    // Fallback if P123 fetch fails
    await interaction.editReply(`**Your Watchlist (${list.length} stocks)**\n${list.join(', ')}\n\n_Live prices unavailable._`);
  } else {
    await interaction.reply(`**Your Watchlist (${list.length} stocks)**\n${list.join(', ')}\n\n_Configure P123 API for live prices._`);
  }
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

module.exports = { handleCommand };
