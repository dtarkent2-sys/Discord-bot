// ── Process-level error handlers (before any other imports) ─────────
// Log the error for diagnostics, then exit so Railway can restart the process.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  process.exit(1);
});

// ── Start health server IMMEDIATELY ─────────────────────────────────
// Railway's healthcheck begins as soon as the container launches.
// Bind the HTTP server before loading heavy modules (canvas, chartjs)
// so the /health endpoint is reachable even if later imports fail.
const { startDashboard, setDiscordClient } = require('./src/dashboard/server');
startDashboard();

// ── Load remaining modules ──────────────────────────────────────────
const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
const config = require('./src/config');
const log = require('./src/logger')('Bot');
const ai = require('./src/services/ai');
const memory = require('./src/services/memory');
const sentiment = require('./src/services/sentiment');
const reactions = require('./src/services/reactions');
const images = require('./src/services/images');
const stats = require('./src/services/stats');
const { handleCommand } = require('./src/commands/handlers');
const { registerCommands } = require('./src/commands/register');
const AutonomousBehaviorEngine = require('./src/services/autonomous');
const { handlePrefixCommand } = require('./src/commands/prefix');
const stream = require('./src/services/stream');
const { instrumentMessage } = require('./src/utils/safe-send');

// SPY 0DTE alert handler — loaded defensively so a failure here never crashes the bot
let spyAlerts = null;
try {
  spyAlerts = require('./src/services/spy-alerts');
} catch (err) {
  console.warn('[Bot] SPY alerts module failed to load (non-critical):', err.message);
}

// AInvest — priority data source (MCP + REST). Init MCP in background.
let ainvest = null;
try {
  ainvest = require('./src/services/ainvest');
  if (ainvest.enabled) {
    ainvest.initMCP().catch(err => {
      console.warn('[Bot] AInvest MCP init failed (REST fallback active):', err.message);
    });
  }
} catch (err) {
  console.warn('[Bot] AInvest module failed to load (non-critical):', err.message);
}

log.info('Health server started, all modules loaded');

// ── Discord Client Setup ─────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.Channel],
});

// ── Global Discord client error handler ──────────────────────────────
client.on('error', (err) => {
  console.error('[Discord Client Error]', err);
});

// Track recent bot replies so we can link reactions to original messages
const recentBotReplies = new Map(); // botMessageId -> { userMessage, botResponse, userId }

// ── Ready Event ──────────────────────────────────────────────────────
client.once(Events.ClientReady, async (c) => {
  log.info(`Logged in as ${c.user.tag}`);
  stats.setGuildCount(c.guilds.cache.size);

  // Test Ollama connection
  await ai.initialize();

  // Register slash commands
  await registerCommands();

  // Start autonomous scheduled behaviors
  const autonomousEngine = new AutonomousBehaviorEngine(client);
  autonomousEngine.startAllSchedules();

  // Store reference on client so prefix commands (!emergency) can access it
  client._autonomousEngine = autonomousEngine;

  // Initialize Alpaca stream (connects lazily on first /stream start)
  stream.init(client);

  // Register Discord client with dashboard server for HTTP webhook handling
  setDiscordClient(client);

  // Pre-warm Ollama alert model for faster first response (only if module loaded)
  if (spyAlerts) {
    spyAlerts.prewarmOllama().catch(() => {});
  }
});

// ── Slash Command Handler ────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    await handleCommand(interaction);
  } catch (err) {
    log.error('Command error:', err);
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
  // ── TradingView Webhook Alert Handler ──
  // Process webhook messages in the SPY 0DTE channel BEFORE the bot filter
  if (spyAlerts && message.webhookId && message.channel.id === config.spyChannelId) {
    spyAlerts.handleWebhookAlert(message).catch((err) => {
      log.error('Webhook alert handler error:', err);
    });
    return;
  }

  // Ignore bots and system messages
  if (message.author.bot) return;
  if (!message.content && message.attachments.size === 0) return;

  // Instrument all outbound sends/replies on this message for diagnostics
  instrumentMessage(message);

  // Check for prefix commands (!update, !suggest, !autoedit) first
  if (message.content.startsWith(config.botPrefix)) {
    const handled = await handlePrefixCommand(message);
    if (handled) return;
  }

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
    log.error('Message handling error:', err);
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

  log.debug(`Reaction feedback: ${isPositive ? '+1' : '-1'} from ${user.username}`);
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
  log.error('DISCORD_TOKEN is not set. Create a .env file with your bot token. See .env.example for reference.');
  process.exit(1);
}

client.login(config.token).catch((err) => {
  log.error('Discord login failed:', err.message);
  process.exit(1);
});
