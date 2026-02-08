require('dotenv').config();

const http = require('http');
const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
const AIEngine = require('./ai-engine');
const MemorySystem = require('./memory-system');
const AutonomousActions = require('./autonomous-actions');

// --- Initialize core systems ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

const ai = new AIEngine();
const memory = new MemorySystem();
const autonomous = new AutonomousActions(client, ai, memory);

const PREFIX = process.env.BOT_PREFIX || '!';

// --- Bot ready ---
client.once(Events.ClientReady, async () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);

  // Initialize database
  try {
    await memory.initialize();
  } catch (err) {
    console.error('[Bot] Database failed to initialize:', err.message);
    process.exit(1);
  }

  // Initialize AI engine (non-fatal — falls back to rule-based)
  try {
    await ai.initialize();
    console.log('[Bot] AI Engine initialized.');
  } catch (err) {
    console.error('[Bot] AI Engine failed to initialize:', err.message);
    console.log('[Bot] Bot will run with rule-based responses only.');
  }

  // Set the first text channel as the autonomous actions target
  const guild = client.guilds.cache.first();
  if (guild) {
    const channel = guild.channels.cache.find(
      ch => ch.isTextBased() && !ch.isVoiceBased() && ch.permissionsFor(guild.members.me)?.has('SendMessages')
    );
    if (channel) {
      autonomous.setTargetChannel(channel.id);
      autonomous.start();
    }
  }
});

// --- Message handler ---
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!memory.ready) return;

  const userId = message.author.id;
  const channelId = message.channel.id;
  const username = message.author.username;
  const content = message.content.trim();

  // Analyze sentiment (local NLP — always available once ai is ready)
  let sentimentScore = null;
  if (ai.ready) {
    try {
      const sentiment = ai.analyzeSentiment(content);
      sentimentScore = sentiment.raw;
    } catch {
      // Sentiment analysis failed silently
    }
  }

  // Store every message in memory
  try {
    await memory.addMessage(userId, channelId, 'user', content, sentimentScore?.toString());
    await memory.updateUserProfile(userId, username, sentimentScore);
  } catch (err) {
    console.error('[Bot] Memory write error:', err.message);
  }

  // Handle prefix commands
  if (content.startsWith(PREFIX)) {
    const args = content.slice(PREFIX.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();
    await handleCommand(message, command, args);
    return;
  }

  // Handle direct mentions
  if (message.mentions.has(client.user)) {
    await handleMention(message, content);
    return;
  }
});

// --- Command handler ---
async function handleCommand(message, command, args) {
  switch (command) {
    case 'ask': {
      if (!ai.ready) {
        await message.reply('AI is still initializing, please try again shortly.');
        return;
      }
      const question = args.join(' ');
      if (!question) {
        await message.reply(`Usage: \`${PREFIX}ask <your question>\``);
        return;
      }
      await message.channel.sendTyping();
      const context = await memory.buildContextString(message.channel.id);
      const response = await ai.generateResponse(question, context);
      await memory.addMessage(client.user.id, message.channel.id, 'assistant', response);
      await message.reply(response);
      break;
    }

    case 'sentiment': {
      if (!ai.ready) {
        await message.reply('AI is still initializing.');
        return;
      }
      const text = args.join(' ');
      if (!text) {
        await message.reply(`Usage: \`${PREFIX}sentiment <text>\``);
        return;
      }
      const result = ai.analyzeSentiment(text);
      await message.reply(`**${result.label}** (confidence: ${(result.score * 100).toFixed(1)}%)`);
      break;
    }

    case 'analyze': {
      if (!ai.ready) {
        await message.reply('AI is still initializing.');
        return;
      }
      const text = args.join(' ');
      if (!text) {
        await message.reply(`Usage: \`${PREFIX}analyze <text>\``);
        return;
      }
      const analysis = ai.analyzeText(text);
      const lines = [`**Text Analysis:**`];
      if (analysis.topics.length) lines.push(`Topics: ${analysis.topics.join(', ')}`);
      if (analysis.people.length) lines.push(`People: ${analysis.people.join(', ')}`);
      if (analysis.places.length) lines.push(`Places: ${analysis.places.join(', ')}`);
      lines.push(`Sentiment: ${analysis.sentiment.label} (${(analysis.sentiment.score * 100).toFixed(1)}%)`);
      lines.push(`Question: ${analysis.isQuestion ? 'Yes' : 'No'}`);
      await message.reply(lines.join('\n'));
      break;
    }

    case 'profile': {
      const targetUser = message.mentions.users.first() || message.author;
      const profile = await memory.getUserProfile(targetUser.id);
      if (!profile) {
        await message.reply('No data on that user yet.');
        return;
      }
      const mood = profile.avg_sentiment > 0.3 ? 'Positive' : profile.avg_sentiment < -0.3 ? 'Negative' : 'Neutral';
      await message.reply(
        `**${profile.username}**\nMessages: ${profile.message_count}\nOverall mood: ${mood}\nLast seen: ${profile.last_seen}`
      );
      break;
    }

    case 'setchannel': {
      if (!message.member.permissions.has('ManageGuild')) {
        await message.reply('You need the Manage Server permission to use this command.');
        return;
      }
      autonomous.setTargetChannel(message.channel.id);
      await message.reply('This channel is now set for autonomous bot activity.');
      break;
    }

    case 'topic': {
      if (!ai.ready) {
        await message.reply('AI is still initializing.');
        return;
      }
      await message.channel.sendTyping();
      const topic = await ai.generateTopic();
      await message.reply(`**Discussion prompt:** ${topic}`);
      break;
    }

    case 'help': {
      await message.reply([
        '**Available Commands:**',
        `\`${PREFIX}ask <question>\` - Ask the AI a question`,
        `\`${PREFIX}sentiment <text>\` - Analyze text sentiment`,
        `\`${PREFIX}analyze <text>\` - Full NLP text analysis`,
        `\`${PREFIX}profile [@user]\` - View user profile`,
        `\`${PREFIX}topic\` - Generate a discussion topic`,
        `\`${PREFIX}setchannel\` - Set autonomous activity channel (admin)`,
        `\`${PREFIX}help\` - Show this message`,
      ].join('\n'));
      break;
    }

    default:
      break;
  }
}

// --- Mention handler ---
async function handleMention(message, content) {
  if (!ai.ready) {
    await message.reply("I'm still warming up. Give me a moment!");
    return;
  }

  await message.channel.sendTyping();

  const cleanContent = content.replace(/<@!?\d+>/g, '').trim();
  if (!cleanContent) {
    await message.reply("You mentioned me but didn't say anything! Try asking me something.");
    return;
  }

  const context = await memory.buildContextString(message.channel.id);
  const response = await ai.generateResponse(cleanContent, context);
  await memory.addMessage(client.user.id, message.channel.id, 'assistant', response);
  await message.reply(response);
}

// --- Welcome new members ---
client.on(Events.GuildMemberAdd, async (member) => {
  if (!ai.ready) return;

  const guild = member.guild;
  const channel = guild.systemChannel || guild.channels.cache.find(
    ch => ch.isTextBased() && ch.permissionsFor(guild.members.me)?.has('SendMessages')
  );
  if (!channel) return;

  const welcomeMsg = await autonomous.welcomeUser(member);
  await channel.send(welcomeMsg);
});

// --- Graceful shutdown ---
async function shutdown(signal) {
  console.log(`[Bot] ${signal} received, shutting down...`);
  autonomous.stop();
  healthServer.close();
  await memory.close();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// --- Health check server for Railway ─────────────────────────────────────────
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT, 10) || process.env.PORT || 3000;
const startTime = Date.now();

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const status = {
      status: client.isReady() ? 'ok' : 'starting',
      uptime: uptimeSeconds,
      discord: client.isReady() ? 'connected' : 'connecting',
      ai: ai.ready ? (ai.ollamaAvailable ? 'ollama' : 'rule-based') : 'initializing',
      memory: memory.ready ? 'connected' : 'initializing',
      guilds: client.guilds?.cache?.size || 0,
      scheduled_jobs: Object.keys(autonomous.jobs).length,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

healthServer.listen(HEALTH_PORT, () => {
  console.log(`[Health] Listening on port ${HEALTH_PORT}`);
});

// --- Start ---
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('[Bot] DISCORD_TOKEN is not set. Check your environment variables.');
  process.exit(1);
}

client.login(token);
