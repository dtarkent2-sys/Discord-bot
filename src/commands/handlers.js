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
    if (q.rsi14) lines.push(`**RSI(14):** ${q.rsi14}`);
    if (q.sma50) lines.push(`**SMA(50):** $${q.sma50}`);
    if (q.sma200) lines.push(`**SMA(200):** $${q.sma200}`);
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

module.exports = { handleCommand };
