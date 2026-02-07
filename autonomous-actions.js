const cron = require('node-cron');

class AutonomousActions {
  constructor(client, aiEngine, memory) {
    this.client = client;
    this.ai = aiEngine;
    this.memory = memory;
    this.scheduledJobs = [];
    this.targetChannelId = null;
  }

  setTargetChannel(channelId) {
    this.targetChannelId = channelId;
    console.log(`[Autonomous] Target channel set: ${channelId}`);
  }

  startAll() {
    this._scheduleTopicStarter();
    this._scheduleMoodCheck();
    this._scheduleActivitySummary();
    console.log('[Autonomous] All scheduled actions started.');
  }

  stopAll() {
    this.scheduledJobs.forEach(job => job.stop());
    this.scheduledJobs = [];
    console.log('[Autonomous] All scheduled actions stopped.');
  }

  // Post a conversation starter at configured intervals
  _scheduleTopicStarter() {
    const minutes = process.env.AUTONOMOUS_INTERVAL_MINUTES || 30;
    const job = cron.schedule(`*/${minutes} * * * *`, async () => {
      try {
        if (!this.targetChannelId) return;
        const channel = await this.client.channels.fetch(this.targetChannelId);
        if (!channel) return;

        const topic = await this.ai.generateTopic();
        await channel.send(`**Discussion prompt:** ${topic}`);
        console.log('[Autonomous] Posted conversation starter.');
      } catch (err) {
        console.error('[Autonomous] Topic starter error:', err.message);
      }
    });

    this.scheduledJobs.push(job);
  }

  // Check channel mood every 2 hours
  _scheduleMoodCheck() {
    const job = cron.schedule('0 */2 * * *', async () => {
      try {
        if (!this.targetChannelId) return;
        const channel = await this.client.channels.fetch(this.targetChannelId);
        if (!channel) return;

        const recent = this.memory.getRecentConversation(this.targetChannelId, 20);
        if (recent.length === 0) return;

        let positiveCount = 0;
        let negativeCount = 0;

        for (const msg of recent) {
          if (msg.role === 'user') {
            const sentiment = await this.ai.analyzeSentiment(msg.content);
            if (sentiment.label === 'POSITIVE') positiveCount++;
            else negativeCount++;
          }
        }

        const total = positiveCount + negativeCount;
        if (total === 0) return;

        const positiveRatio = positiveCount / total;

        if (positiveRatio < 0.3 && total >= 5) {
          const encouragement = await this.ai.generateResponse(
            'The chat seems a bit down. Generate a short encouraging or uplifting message.'
          );
          await channel.send(encouragement);
          console.log('[Autonomous] Sent mood boost message.');
        }
      } catch (err) {
        console.error('[Autonomous] Mood check error:', err.message);
      }
    });

    this.scheduledJobs.push(job);
  }

  // Post daily activity summary at midnight
  _scheduleActivitySummary() {
    const job = cron.schedule('0 0 * * *', async () => {
      try {
        if (!this.targetChannelId) return;
        const channel = await this.client.channels.fetch(this.targetChannelId);
        if (!channel) return;

        const activeUsers = this.memory.getActiveUsers(24);
        if (activeUsers.length === 0) return;

        const lines = [
          '**Daily Activity Summary**',
          `Active members today: ${activeUsers.length}`,
          '',
          'Most active:',
        ];

        const top = activeUsers
          .sort((a, b) => b.message_count - a.message_count)
          .slice(0, 5);

        for (const user of top) {
          const mood = user.avg_sentiment > 0.5 ? 'positive' : user.avg_sentiment < -0.5 ? 'negative' : 'neutral';
          lines.push(`- **${user.username}**: ${user.message_count} messages (mood: ${mood})`);
        }

        await channel.send(lines.join('\n'));
        console.log('[Autonomous] Posted daily summary.');
      } catch (err) {
        console.error('[Autonomous] Activity summary error:', err.message);
      }
    });

    this.scheduledJobs.push(job);
  }

  // One-off reactive action: welcome new member
  async welcomeUser(member) {
    try {
      const welcome = await this.ai.generateResponse(
        `Generate a short, friendly welcome message for a new server member named ${member.displayName}.`
      );
      return welcome;
    } catch (err) {
      console.error('[Autonomous] Welcome generation error:', err.message);
      return `Welcome to the server, ${member.displayName}!`;
    }
  }
}

module.exports = AutonomousActions;
