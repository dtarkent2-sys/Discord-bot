const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
const config = require('./src/config');
const ai = require('./src/services/ai');
const memory = require('./src/services/memory');
const sentiment = require('./src/services/sentiment');
const reactions = require('./src/services/reactions');
const images = require('./src/services/images');
const stats = require('./src/services/stats');
const { handleCommand } = require('./src/commands/handlers');
const { registerCommands } = require('./src/commands/register');
const { startDashboard } = require('./src/dashboard/server');
const AutonomousBehaviorEngine = require('./src/services/autonomous');

// ── Discord Client Setup ─────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Reaction],
});

// Track recent bot replies so we can link reactions to original messages
const recentBotReplies = new Map(); // botMessageId -> { userMessage, botResponse, userId }

// ── Ready Event ──────────────────────────────────────────────────────
client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  stats.setGuildCount(c.guilds.cache.size);

  // Test Ollama connection
  await ai.initialize();

  // Register slash commands
  await registerCommands();

  // Start web dashboard
  startDashboard();

  // Start autonomous scheduled behaviors
  const autonomousEngine = new AutonomousBehaviorEngine(client);
  autonomousEngine.startAllSchedules();
});

// ── Slash Command Handler ────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    await handleCommand(interaction);
  } catch (err) {
    console.error('Command error:', err);
    stats.recordError();
    const reply = { content: 'Something went wrong running that command.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
});

// ── Message Handler ──────────────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  // Ignore bots and system messages
  if (message.author.bot) return;
  if (!message.content && message.attachments.size === 0) return;

  // Only respond when mentioned or in DMs
  const isMentioned = message.mentions.has(client.user);
  const isDM = !message.guild;

  if (!isMentioned && !isDM) return;

  stats.recordMessage();

  try {
    // Strip the bot mention from the message
    let content = message.content
      .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
      .trim();

    // Analyze sentiment
    const sentimentResult = content ? sentiment.track(message.author.id, content) : null;

    // Check for images
    let imageDescription = null;
    const imageUrls = images.getImageUrls(message);
    if (imageUrls.length > 0) {
      await message.channel.sendTyping();
      imageDescription = await images.analyze(imageUrls[0]);
      if (!content) {
        content = 'What do you see in this image?';
      }
    }

    if (!content && !imageDescription) return;

    // Show typing indicator
    await message.channel.sendTyping();

    // Get AI response
    const response = await ai.chat(
      message.author.id,
      message.author.username,
      content,
      { sentiment: sentimentResult, imageDescription }
    );

    // Send reply and track for reaction learning
    const reply = await message.reply(response);
    recentBotReplies.set(reply.id, {
      userMessage: content,
      botResponse: response,
      userId: message.author.id,
    });

    // Clean up old tracked replies (keep last 100)
    if (recentBotReplies.size > 100) {
      const keys = [...recentBotReplies.keys()];
      for (let i = 0; i < keys.length - 100; i++) {
        recentBotReplies.delete(keys[i]);
      }
    }
  } catch (err) {
    console.error('Message handling error:', err);
    stats.recordError();
    await message.reply("Sorry, I ran into an error processing that.").catch(() => {});
  }
});

// ── Reaction Handler (Learning) ──────────────────────────────────────
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  // Ignore bot reactions
  if (user.bot) return;

  // Fetch partial reactions if needed
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return;
    }
  }

  // Only learn from reactions on our own messages
  if (reaction.message.author?.id !== client.user?.id) return;

  const emoji = reaction.emoji.name;
  if (emoji !== '👍' && emoji !== '👎') return;

  const tracked = recentBotReplies.get(reaction.message.id);
  if (!tracked) return;

  const isPositive = emoji === '👍';
  reactions.recordFeedback(tracked.userId, tracked.userMessage, tracked.botResponse, isPositive);

  console.log(`Reaction feedback: ${isPositive ? '👍' : '👎'} from ${user.username}`);
});

// ── Guild Join/Leave ─────────────────────────────────────────────────
client.on(Events.GuildCreate, () => {
  stats.setGuildCount(client.guilds.cache.size);
});

client.on(Events.GuildDelete, () => {
  stats.setGuildCount(client.guilds.cache.size);
});

// ── Start Bot ────────────────────────────────────────────────────────
if (!config.token) {
  console.error('ERROR: DISCORD_TOKEN is not set.');
  console.error('Create a .env file with your bot token. See .env.example for reference.');
  process.exit(1);
}

client.login(config.token);
