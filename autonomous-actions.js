const schedule = require('node-schedule');
const axios = require('axios');

// ─── Default schedule (cron format, all in EST via tz option) ────────────────
const DEFAULTS = {
  SCHEDULE_STOCK_ANALYSIS:  '0 7 * * 1-5',  // 7 AM EST weekdays
  SCHEDULE_DAILY_QUESTION:  '0 10 * * *',    // 10 AM EST daily
  SCHEDULE_DAILY_SUMMARY:   '0 22 * * *',    // 10 PM EST daily
  SCHEDULE_WEEKLY_INSIGHTS: '0 9 * * 1',     // Monday 9 AM EST
  SCHEDULE_RANDOM_ENGAGE:   '0 */2 * * *',   // every 2 hours
  SCHEDULE_CONVO_ANALYSIS:  '0 */4 * * *',   // every 4 hours
};

const TZ = process.env.SCHEDULE_TIMEZONE || 'America/New_York';

class AutonomousActions {
  constructor(client, ai, memory) {
    this.client = client;
    this.ai = ai;
    this.memory = memory;
    this.jobs = {};
    this.targetChannelId = null;

    // Running analysis state the bot accumulates over time
    this.insights = {
      peakHours: [],
      topTopics: [],
      avgSentiment: 0,
      totalAnalyzed: 0,
      quietChannels: [],
    };
  }

  // ─── Channel targeting ──────────────────────────────────────────────────────

  setTargetChannel(channelId) {
    this.targetChannelId = channelId;
    console.log(`[Autonomous] Target channel set: ${channelId}`);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  start() {
    this._schedule('stockAnalysis',   this._env('SCHEDULE_STOCK_ANALYSIS'),  () => this._guard('Stock Analysis',   () => this.postStockAnalysis()));
    this._schedule('dailyQuestion',   this._env('SCHEDULE_DAILY_QUESTION'),  () => this._guard('Daily Question',   () => this.postDailyQuestion()));
    this._schedule('dailySummary',    this._env('SCHEDULE_DAILY_SUMMARY'),   () => this._guard('Daily Summary',    () => this.postDailySummary()));
    this._schedule('weeklyInsights',  this._env('SCHEDULE_WEEKLY_INSIGHTS'), () => this._guard('Weekly Insights',  () => this.postWeeklyInsights()));
    this._schedule('randomEngage',    this._env('SCHEDULE_RANDOM_ENGAGE'),   () => this._guard('Random Engage',    () => this.randomEngagement()));
    this._schedule('convoAnalysis',   this._env('SCHEDULE_CONVO_ANALYSIS'),  () => this._guard('Convo Analysis',   () => this.analyzeConversations()));

    const names = Object.keys(this.jobs);
    console.log(`[Autonomous] Started ${names.length} jobs: ${names.join(', ')} (tz: ${TZ})`);
  }

  stop() {
    for (const [name, job] of Object.entries(this.jobs)) {
      job.cancel();
      console.log(`[Autonomous] Cancelled job: ${name}`);
    }
    this.jobs = {};
  }

  // ─── 1. Pre-market stock analysis (7 AM EST weekdays) ──────────────────────

  async postStockAnalysis() {
    const channel = await this._getTargetChannel();
    if (!channel) return;

    const prompt = [
      'Give a brief pre-market stock analysis for today. Cover:',
      '1. Key index futures (S&P 500, NASDAQ, Dow)',
      '2. Major overnight news affecting markets',
      '3. Key earnings or economic data releases today',
      '4. Overall market sentiment (bullish/bearish/neutral)',
      'Keep it under 250 words. Use bullet points. Do NOT give financial advice.',
    ].join('\n');

    const analysis = await this.ai.generateResponse(prompt);
    const header = `**Pre-Market Analysis — ${this._dateStr()}**`;

    await channel.send(`${header}\n\n${analysis}\n\n*This is AI-generated commentary, not financial advice.*`);
    console.log('[Autonomous] Posted stock analysis.');
  }

  // ─── 2. Daily discussion question (10 AM EST) ─────────────────────────────

  async postDailyQuestion() {
    const channel = await this._getTargetChannel();
    if (!channel) return;

    // Pull recent topics from memory to avoid repeats
    const recentContext = await this.memory.buildContextString(channel.id, 15);
    const topicHints = this.insights.topTopics.length > 0
      ? `\nRecently popular topics in the server: ${this.insights.topTopics.join(', ')}.`
      : '';

    const prompt = [
      'Generate one engaging discussion question for a Discord server.',
      'Make it thought-provoking and open-ended so many people can participate.',
      'Vary the category — could be tech, philosophy, gaming, pop culture, science, hypotheticals, etc.',
      topicHints,
      recentContext ? `\nAvoid repeating anything from these recent messages:\n${recentContext}` : '',
      'Return ONLY the question, nothing else.',
    ].filter(Boolean).join('\n');

    const question = await this.ai.generateResponse(prompt);

    const dayEmojis = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const day = dayEmojis[new Date().getDay()] || '';

    await channel.send(`**Daily Question (${day})**\n\n${question}`);
    console.log('[Autonomous] Posted daily question.');
  }

  // ─── 3. Daily summary (10 PM EST) ─────────────────────────────────────────

  async postDailySummary() {
    const channel = await this._getTargetChannel();
    if (!channel) return;

    const activeUsers = await this.memory.getActiveUsers(24);
    if (activeUsers.length === 0) {
      await channel.send("**Daily Summary**\n\nQuiet day today — no activity recorded. Let's change that tomorrow!");
      return;
    }

    // Sort by message count for leaderboard
    const sorted = [...activeUsers].sort((a, b) => b.message_count - a.message_count);
    const top5 = sorted.slice(0, 5);

    // Aggregate sentiment
    const totalSentiment = activeUsers.reduce((sum, u) => sum + (u.avg_sentiment || 0), 0);
    const avgSentiment = totalSentiment / activeUsers.length;
    const moodLabel = avgSentiment > 0.2 ? 'Positive' : avgSentiment < -0.2 ? 'Negative' : 'Neutral';
    const moodBar = this._sentimentBar(avgSentiment);

    // Total messages today (approximate from profile counts)
    const totalMessages = activeUsers.reduce((sum, u) => sum + u.message_count, 0);

    const lines = [
      `**Daily Summary — ${this._dateStr()}**`,
      '',
      `Active members: **${activeUsers.length}** | Messages today: **${totalMessages}**`,
      `Server mood: ${moodBar} ${moodLabel}`,
      '',
      '**Most active:**',
    ];

    for (let i = 0; i < top5.length; i++) {
      const u = top5[i];
      const medal = ['1.', '2.', '3.', '4.', '5.'][i];
      const userMood = u.avg_sentiment > 0.2 ? 'positive' : u.avg_sentiment < -0.2 ? 'negative' : 'neutral';
      lines.push(`${medal} **${u.username}** — ${u.message_count} msgs (${userMood})`);
    }

    // Ask AI for a closing remark if available
    if (this.ai.ready && this.ai.ollamaAvailable) {
      const closingPrompt = `The Discord server had ${activeUsers.length} active members today with a ${moodLabel.toLowerCase()} mood. Write one short, friendly closing sentence for the daily summary. Just the sentence.`;
      try {
        const closing = await this.ai.generateResponse(closingPrompt);
        lines.push('', `*${closing}*`);
      } catch {
        // skip closing remark
      }
    }

    await channel.send(lines.join('\n'));
    console.log('[Autonomous] Posted daily summary.');
  }

  // ─── 4. Weekly insights (Monday 9 AM EST) ─────────────────────────────────

  async postWeeklyInsights() {
    const channel = await this._getTargetChannel();
    if (!channel) return;

    // Gather 7-day data
    const weekUsers = await this.memory.getActiveUsers(168);
    if (weekUsers.length === 0) {
      await channel.send("**Weekly Insights**\n\nNo activity this past week. Let's kick things off!");
      return;
    }

    const totalMessages = weekUsers.reduce((sum, u) => sum + u.message_count, 0);
    const avgSentiment = weekUsers.reduce((sum, u) => sum + (u.avg_sentiment || 0), 0) / weekUsers.length;
    const moodLabel = avgSentiment > 0.2 ? 'positive' : avgSentiment < -0.2 ? 'negative' : 'neutral';

    // Top contributors
    const topContributors = [...weekUsers]
      .sort((a, b) => b.message_count - a.message_count)
      .slice(0, 3)
      .map(u => `**${u.username}** (${u.message_count} msgs)`)
      .join(', ');

    // Most positive / most negative users
    const mostPositive = [...weekUsers].sort((a, b) => b.avg_sentiment - a.avg_sentiment)[0];
    const mostNegative = [...weekUsers].sort((a, b) => a.avg_sentiment - b.avg_sentiment)[0];

    const lines = [
      `**Weekly Insights — Week of ${this._dateStr()}**`,
      '',
      `**Overview:**`,
      `- Total active members: ${weekUsers.length}`,
      `- Total messages: ${totalMessages}`,
      `- Average daily messages: ~${Math.round(totalMessages / 7)}`,
      `- Overall mood: ${moodLabel} (${avgSentiment.toFixed(2)})`,
      '',
      `**Top contributors:** ${topContributors}`,
    ];

    if (mostPositive) {
      lines.push(`**Most positive vibes:** ${mostPositive.username}`);
    }

    // Trending topics from analysis cache
    if (this.insights.topTopics.length > 0) {
      lines.push('', `**Trending topics:** ${this.insights.topTopics.join(', ')}`);
    }

    // Peak activity hours
    if (this.insights.peakHours.length > 0) {
      const peakStr = this.insights.peakHours.slice(0, 3).map(h => `${h}:00`).join(', ');
      lines.push(`**Peak hours (EST):** ${peakStr}`);
    }

    // AI-generated weekly insight
    if (this.ai.ready && this.ai.ollamaAvailable) {
      const insightPrompt = [
        `A Discord server had ${weekUsers.length} active members this week, ${totalMessages} total messages, and a ${moodLabel} overall mood.`,
        `Top contributors: ${topContributors}.`,
        this.insights.topTopics.length > 0 ? `Trending topics: ${this.insights.topTopics.join(', ')}.` : '',
        'Write 2-3 sentences of insight about the community health and a suggestion for next week. Be specific and encouraging.',
      ].filter(Boolean).join(' ');

      try {
        const insight = await this.ai.generateResponse(insightPrompt);
        lines.push('', `**AI Insight:**`, insight);
      } catch {
        // skip
      }
    }

    await channel.send(lines.join('\n'));
    console.log('[Autonomous] Posted weekly insights.');
  }

  // ─── 5. Random engagement — find quiet channels (every 2h) ────────────────

  async randomEngagement() {
    const guild = this.client.guilds.cache.first();
    if (!guild) return;

    // Find text channels the bot can write to
    const textChannels = guild.channels.cache.filter(
      ch => ch.isTextBased() &&
            !ch.isVoiceBased() &&
            !ch.isThread() &&
            ch.permissionsFor(guild.members.me)?.has('SendMessages')
    );

    if (textChannels.size === 0) return;

    // Score each channel by how recently someone posted (prefer quiet ones)
    const scored = [];
    for (const [, ch] of textChannels) {
      try {
        const messages = await ch.messages.fetch({ limit: 5 });
        const botMessages = messages.filter(m => m.author.id === this.client.user.id);

        // Skip if the bot's last message here was < 1 hour ago
        if (botMessages.size > 0) {
          const lastBotMsg = botMessages.first();
          const hoursSince = (Date.now() - lastBotMsg.createdTimestamp) / (1000 * 60 * 60);
          if (hoursSince < 1) continue;
        }

        const lastMsg = messages.first();
        const quietMinutes = lastMsg
          ? (Date.now() - lastMsg.createdTimestamp) / (1000 * 60)
          : 9999;

        // Sweet spot: channels that have been quiet 30 min – 6 hours
        if (quietMinutes >= 30 && quietMinutes <= 360) {
          scored.push({ channel: ch, quietMinutes });
        }
      } catch {
        // can't read messages, skip
      }
    }

    if (scored.length === 0) return;

    // Pick the quietest channel
    scored.sort((a, b) => b.quietMinutes - a.quietMinutes);
    const target = scored[0];

    // Decide what to say based on context
    const recent = await this.memory.buildContextString(target.channel.id, 5);

    const engagementStyles = [
      'Ask a fun "would you rather" question related to recent conversation.',
      'Share an interesting fact and ask if anyone knew about it.',
      'Start a lighthearted debate with a hot take.',
      'Ask what everyone is working on or playing today.',
      'Pose a creative hypothetical scenario.',
      'Share a quick brain teaser or riddle.',
    ];
    const style = engagementStyles[Math.floor(Math.random() * engagementStyles.length)];

    const prompt = [
      `You're a friendly Discord bot dropping into a quiet channel to spark conversation.`,
      `Style: ${style}`,
      recent ? `Recent conversation context:\n${recent}` : 'The channel has been quiet — start something fresh.',
      'Keep it short (1-3 sentences). Be casual and inviting. Do NOT say you are an AI or bot.',
    ].join('\n');

    const message = await this.ai.generateResponse(prompt);
    await target.channel.send(message);

    console.log(`[Autonomous] Random engagement in #${target.channel.name} (quiet ${Math.round(target.quietMinutes)}m).`);
  }

  // ─── 6. Conversation analysis (every 4h) ──────────────────────────────────

  async analyzeConversations() {
    const guild = this.client.guilds.cache.first();
    if (!guild) return;

    const textChannels = guild.channels.cache.filter(
      ch => ch.isTextBased() && !ch.isVoiceBased() && !ch.isThread()
    );

    let allSentiments = [];
    const hourBuckets = {};
    const topicCounts = {};

    for (const [, ch] of textChannels) {
      try {
        const recent = await this.memory.getRecentConversation(ch.id, 50);

        for (const msg of recent) {
          if (msg.role !== 'user') continue;

          // Sentiment tracking
          const sentiment = this.ai.analyzeSentiment(msg.content);
          allSentiments.push(sentiment.raw);

          // Hour tracking for peak activity
          const hour = new Date(msg.created_at).getHours();
          hourBuckets[hour] = (hourBuckets[hour] || 0) + 1;

          // Topic extraction
          const keywords = this.ai.extractKeywords(msg.content);
          for (const kw of keywords) {
            topicCounts[kw] = (topicCounts[kw] || 0) + 1;
          }

          // Feed brain.js training data
          this.ai.addTrainingExample(
            { sentiment: sentiment.raw, length: Math.min(msg.content.length / 500, 1) },
            { engaging: sentiment.label === 'POSITIVE' ? 1 : 0 }
          );
        }
      } catch {
        // channel read failed, skip
      }
    }

    // Update insights
    if (allSentiments.length > 0) {
      this.insights.avgSentiment = allSentiments.reduce((a, b) => a + b, 0) / allSentiments.length;
      this.insights.totalAnalyzed = allSentiments.length;
    }

    // Peak hours (sorted by activity)
    const sortedHours = Object.entries(hourBuckets)
      .sort(([, a], [, b]) => b - a)
      .map(([hour]) => parseInt(hour, 10));
    this.insights.peakHours = sortedHours.slice(0, 5);

    // Top topics (sorted by frequency, filter out common stop words)
    const stopWords = new Set(['the', 'a', 'an', 'is', 'it', 'to', 'in', 'for', 'on', 'and', 'of', 'i', 'me', 'my', 'you', 'we', 'just', 'so', 'do', 'that', 'this', 'but']);
    const sortedTopics = Object.entries(topicCounts)
      .filter(([word]) => !stopWords.has(word) && word.length > 2)
      .sort(([, a], [, b]) => b - a)
      .map(([word]) => word);
    this.insights.topTopics = sortedTopics.slice(0, 10);

    // Identify quiet channels (for randomEngagement to target)
    const quietChannels = [];
    for (const [, ch] of textChannels) {
      try {
        const recent = await this.memory.getRecentConversation(ch.id, 1);
        if (recent.length === 0) {
          quietChannels.push(ch.id);
        } else {
          const lastMsgTime = new Date(recent[0].created_at).getTime();
          const hoursSilent = (Date.now() - lastMsgTime) / (1000 * 60 * 60);
          if (hoursSilent > 2) quietChannels.push(ch.id);
        }
      } catch {
        // skip
      }
    }
    this.insights.quietChannels = quietChannels;

    console.log(`[Autonomous] Conversation analysis complete — ${allSentiments.length} messages, ${this.insights.topTopics.length} topics, ${this.insights.peakHours.length} peak hours tracked.`);
  }

  // ─── Reactive: welcome new member ─────────────────────────────────────────

  async welcomeUser(member) {
    try {
      const guildName = member.guild.name;
      const memberCount = member.guild.memberCount;
      const prompt = [
        `Generate a short, warm welcome message for a new Discord server member.`,
        `Their name is ${member.displayName}.`,
        `The server is called "${guildName}" and now has ${memberCount} members.`,
        `Be friendly and make them feel at home. Mention they can use !help to see commands.`,
        `Keep it to 2-3 sentences.`,
      ].join(' ');

      return await this.ai.generateResponse(prompt);
    } catch (err) {
      console.error('[Autonomous] Welcome generation error:', err.message);
      return `Welcome to the server, ${member.displayName}! Type \`!help\` to see what I can do.`;
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  _env(key) {
    return process.env[key] || DEFAULTS[key];
  }

  _schedule(name, cronExpr, fn) {
    const job = schedule.scheduleJob({ rule: cronExpr, tz: TZ }, fn);
    if (job) {
      this.jobs[name] = job;
    } else {
      console.error(`[Autonomous] Failed to schedule job "${name}" with cron: ${cronExpr}`);
    }
  }

  async _guard(label, fn) {
    try {
      if (!this.ai.ready) {
        console.log(`[Autonomous] Skipping "${label}" — AI not ready.`);
        return;
      }
      await fn();
    } catch (err) {
      console.error(`[Autonomous] ${label} error:`, err.message);
    }
  }

  async _getTargetChannel() {
    if (!this.targetChannelId) {
      console.log('[Autonomous] No target channel set, skipping.');
      return null;
    }
    try {
      return await this.client.channels.fetch(this.targetChannelId);
    } catch (err) {
      console.error('[Autonomous] Failed to fetch target channel:', err.message);
      return null;
    }
  }

  _dateStr() {
    return new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: TZ,
    });
  }

  _sentimentBar(score) {
    // -1 to +1 mapped to a 10-char bar
    const normalized = Math.max(0, Math.min(10, Math.round((score + 1) * 5)));
    const filled = '|'.repeat(normalized);
    const empty = '-'.repeat(10 - normalized);
    return `[${filled}${empty}]`;
  }
}

module.exports = AutonomousActions;
