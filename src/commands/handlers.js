const ai = require('../services/ai');
const memory = require('../services/memory');
const stats = require('../services/stats');
const reactions = require('../services/reactions');
const sentiment = require('../services/sentiment');

async function handleCommand(interaction) {
  const { commandName, user } = interaction;
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

module.exports = { handleCommand };
