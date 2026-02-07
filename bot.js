require('dotenv').config();

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

  try {
    await ai.initialize();
    console.log('[Bot] AI Engine initialized.');
  } catch (err) {
    console.error('[Bot] AI Engine failed to initialize:', err.message);
    console.log('[Bot] Bot will run without AI capabilities.');
  }

  // Set the first text channel as the autonomous actions target
  const guild = client.guilds.cache.first();
  if (guild) {
    const channel = guild.channels.cache.find(
      ch => ch.isTextBased() && !ch.isVoiceBased() && ch.permissionsFor(guild.members.me)?.has('SendMessages')
    );
    if (channel) {
      autonomous.setTargetChannel(channel.id);
      autonomous.startAll();
    }
  }
});

// --- Message handler ---
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const userId = message.author.id;
  const channelId = message.channel.id;
  const username = message.author.username;
  const content = message.content.trim();

  // Store every message in memory
  let sentimentScore = null;
  if (ai.ready) {
    try {
      const sentiment = await ai.analyzeSentiment(content);
      sentimentScore = sentiment.label === 'POSITIVE' ? sentiment.score : -sentiment.score;
    } catch {
      // Sentiment analysis failed silently
    }
  }

  memory.addMessage(userId, channelId, 'user', content, sentimentScore?.toString());
  memory.updateUserProfile(userId, username, sentimentScore);

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
        await message.reply('AI models are still loading, please try again shortly.');
        return;
      }
      const question = args.join(' ');
      if (!question) {
        await message.reply(`Usage: \`${PREFIX}ask <your question>\``);
        return;
      }
      await message.channel.sendTyping();
      const context = memory.buildContextString(message.channel.id);
      const response = await ai.generateResponse(question, context);
      memory.addMessage(client.user.id, message.channel.id, 'assistant', response);
      await message.reply(response);
      break;
    }

    case 'sentiment': {
      if (!ai.ready) {
        await message.reply('AI models are still loading.');
        return;
      }
      const text = args.join(' ');
      if (!text) {
        await message.reply(`Usage: \`${PREFIX}sentiment <text>\``);
        return;
      }
      const result = await ai.analyzeSentiment(text);
      await message.reply(`**${result.label}** (confidence: ${(result.score * 100).toFixed(1)}%)`);
      break;
    }

    case 'profile': {
      const targetUser = message.mentions.users.first() || message.author;
      const profile = memory.getUserProfile(targetUser.id);
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
        await message.reply('AI models are still loading.');
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
    await message.reply("I'm still warming up my AI models. Give me a moment!");
    return;
  }

  await message.channel.sendTyping();

  // Strip the mention from the message
  const cleanContent = content.replace(/<@!?\d+>/g, '').trim();
  if (!cleanContent) {
    await message.reply("You mentioned me but didn't say anything! Try asking me something.");
    return;
  }

  const context = memory.buildContextString(message.channel.id);
  const response = await ai.generateResponse(cleanContent, context);
  memory.addMessage(client.user.id, message.channel.id, 'assistant', response);
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
process.on('SIGINT', () => {
  console.log('[Bot] Shutting down...');
  autonomous.stopAll();
  memory.close();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[Bot] Received SIGTERM, shutting down...');
  autonomous.stopAll();
  memory.close();
  client.destroy();
  process.exit(0);
});

// --- Start ---
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('[Bot] DISCORD_TOKEN is not set. Check your environment variables.');
  process.exit(1);
}

client.login(token);
