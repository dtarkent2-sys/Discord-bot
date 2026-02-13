/**
 * Channel History Ingestion Service
 *
 * Fetches past Discord channel messages, digests them through AI into
 * compressed knowledge, and stores the result persistently so Billy
 * has long-term memory of what's been discussed in the server.
 *
 * How it works:
 *   1. Fetch messages from a channel (paginated, 100 at a time)
 *   2. Batch them into groups of ~50 messages
 *   3. Ask AI to extract: key facts, user personalities, inside jokes,
 *      trading discussions, server culture, recurring topics
 *   4. Store the digested knowledge in channel-knowledge.json
 *   5. Inject a compact summary into the AI system prompt
 *
 * Usage:
 *   /ingest #channel-name       — ingest a specific channel
 *   /ingest                      — ingest all text channels
 *
 * The knowledge is additive — re-ingesting a channel updates it.
 */

const Storage = require('./storage');
const auditLog = require('./audit-log');

const MAX_MESSAGES_PER_CHANNEL = 2000;  // Don't go crazy — 2k messages is plenty for context
const BATCH_SIZE = 50;                   // Messages per AI digest batch
const MAX_KNOWLEDGE_ENTRIES = 100;       // Max stored knowledge chunks per channel
const CONTEXT_MAX_CHARS = 1500;          // Max chars injected into system prompt

class ChannelHistoryService {
  constructor() {
    this._storage = new Storage('channel-knowledge.json');
    this._ingesting = false;
  }

  /**
   * Ingest a Discord channel — fetch messages and digest into knowledge.
   * @param {import('discord.js').TextChannel} channel
   * @param {object} [opts]
   * @param {number} [opts.limit] - Max messages to fetch (default 2000)
   * @param {function} [opts.onProgress] - Progress callback (messagesProcessed, totalFetched)
   * @returns {{ success: boolean, messagesProcessed: number, knowledgeEntries: number, error?: string }}
   */
  async ingest(channel, opts = {}) {
    if (this._ingesting) {
      return { success: false, messagesProcessed: 0, knowledgeEntries: 0, error: 'Already ingesting a channel. Wait for it to finish.' };
    }

    this._ingesting = true;
    try {
      const limit = opts.limit || MAX_MESSAGES_PER_CHANNEL;
      const onProgress = opts.onProgress || (() => {});

      // 1. Fetch messages (paginated)
      const messages = await this._fetchMessages(channel, limit);
      if (messages.length === 0) {
        return { success: true, messagesProcessed: 0, knowledgeEntries: 0 };
      }

      auditLog.log('channel_history', `Fetched ${messages.length} messages from #${channel.name}`);

      // 2. Batch and digest
      const batches = this._batchMessages(messages);
      const knowledge = [];
      let processed = 0;

      for (const batch of batches) {
        try {
          const digest = await this._digestBatch(batch, channel.name);
          if (digest) {
            knowledge.push(digest);
          }
        } catch (err) {
          console.warn(`[ChannelHistory] Digest error for batch: ${err.message}`);
        }
        processed += batch.length;
        onProgress(processed, messages.length);
      }

      // 3. Store
      const channelKey = `channel:${channel.id}`;
      const existing = this._storage.get(channelKey, { name: channel.name, knowledge: [], lastIngested: null });
      existing.name = channel.name;
      existing.knowledge = [...existing.knowledge, ...knowledge].slice(-MAX_KNOWLEDGE_ENTRIES);
      existing.lastIngested = new Date().toISOString();
      existing.messageCount = messages.length;
      this._storage.set(channelKey, existing);

      // 4. Rebuild the compact summary
      this._rebuildSummary();

      auditLog.log('channel_history', `Ingested #${channel.name}: ${messages.length} messages → ${knowledge.length} knowledge entries`);

      return {
        success: true,
        messagesProcessed: messages.length,
        knowledgeEntries: knowledge.length,
      };
    } finally {
      this._ingesting = false;
    }
  }

  /**
   * Fetch messages from a channel, paginated backwards.
   * Discord API returns 100 messages max per call.
   */
  async _fetchMessages(channel, limit) {
    const allMessages = [];
    let lastId = null;

    while (allMessages.length < limit) {
      const fetchLimit = Math.min(100, limit - allMessages.length);
      const options = { limit: fetchLimit };
      if (lastId) options.before = lastId;

      let fetched;
      try {
        fetched = await channel.messages.fetch(options);
      } catch (err) {
        console.warn(`[ChannelHistory] Fetch error in #${channel.name}: ${err.message}`);
        break;
      }

      if (fetched.size === 0) break;

      for (const msg of fetched.values()) {
        // Skip bot messages and empty messages
        if (msg.author.bot) continue;
        if (!msg.content && msg.attachments.size === 0) continue;

        allMessages.push({
          author: msg.author.username,
          content: msg.content?.slice(0, 500) || '[attachment]',
          timestamp: msg.createdAt.toISOString(),
        });
      }

      lastId = fetched.last()?.id;
      if (fetched.size < fetchLimit) break; // No more messages

      // Small delay to be kind to Discord rate limits
      await new Promise(r => setTimeout(r, 300));
    }

    // Sort oldest first
    allMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return allMessages;
  }

  /**
   * Split messages into batches for digestion.
   */
  _batchMessages(messages) {
    const batches = [];
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      batches.push(messages.slice(i, i + BATCH_SIZE));
    }
    return batches;
  }

  /**
   * Use AI to digest a batch of messages into a knowledge chunk.
   */
  async _digestBatch(messages, channelName) {
    // Lazy-require to avoid circular deps
    const ai = require('./ai');

    const transcript = messages.map(m =>
      `[${m.author}] ${m.content}`
    ).join('\n');

    const dateRange = `${messages[0].timestamp.slice(0, 10)} to ${messages[messages.length - 1].timestamp.slice(0, 10)}`;
    const authors = [...new Set(messages.map(m => m.author))];

    const prompt = `You are analyzing Discord chat history from #${channelName} (${dateRange}, ${messages.length} messages from: ${authors.join(', ')}).

Extract the MOST IMPORTANT information from this conversation. Be concise — each point should be 1 short sentence max.

Focus on:
1. KEY FACTS: What tickers/trades were discussed? Any specific positions, entries, exits?
2. USER PERSONALITIES: How do these people talk? What are they interested in? Any nicknames or inside jokes?
3. TRADING CONTEXT: Any wins, losses, strategies discussed? What's the group's trading style?
4. NOTABLE EVENTS: Anything memorable that happened? Arguments, celebrations, big calls?
5. SERVER CULTURE: Recurring jokes, memes, slang, or traditions?

Respond with ONLY valid JSON (no markdown):
{"facts": ["fact1", "fact2"], "people": {"username": "brief personality note"}, "culture": ["inside joke or vibe note"], "trades": ["notable trade discussion"]}

If the batch is mostly noise/spam with nothing useful, respond: {"facts": [], "people": {}, "culture": [], "trades": []}

TRANSCRIPT:
${transcript}`;

    try {
      const response = await ai.complete(prompt);
      if (!response) return null;

      // Extract JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      const hasContent = (parsed.facts?.length > 0) ||
                         (Object.keys(parsed.people || {}).length > 0) ||
                         (parsed.culture?.length > 0) ||
                         (parsed.trades?.length > 0);

      if (!hasContent) return null;

      return {
        dateRange,
        channelName,
        authors,
        ...parsed,
        digestedAt: new Date().toISOString(),
      };
    } catch (err) {
      console.warn(`[ChannelHistory] AI digest error: ${err.message}`);
      return null;
    }
  }

  /**
   * Rebuild the compact summary from all channel knowledge.
   * This is what gets injected into the system prompt.
   */
  _rebuildSummary() {
    const allData = this._storage.getAll();
    const channelKeys = Object.keys(allData).filter(k => k.startsWith('channel:'));

    const people = {};  // username → merged personality notes
    const facts = [];
    const culture = [];
    const trades = [];

    for (const key of channelKeys) {
      const ch = allData[key];
      for (const entry of (ch.knowledge || [])) {
        // Merge people
        for (const [user, note] of Object.entries(entry.people || {})) {
          if (!people[user]) people[user] = [];
          if (!people[user].includes(note)) people[user].push(note);
        }
        // Collect facts (deduplicate)
        for (const f of (entry.facts || [])) {
          if (!facts.includes(f)) facts.push(f);
        }
        // Collect culture
        for (const c of (entry.culture || [])) {
          if (!culture.includes(c)) culture.push(c);
        }
        // Collect trades
        for (const t of (entry.trades || [])) {
          if (!trades.includes(t)) trades.push(t);
        }
      }
    }

    // Cap everything to fit in context
    const summary = {
      people: Object.fromEntries(
        Object.entries(people).slice(0, 20).map(([u, notes]) => [u, notes.slice(0, 3).join('; ')])
      ),
      facts: facts.slice(-30),
      culture: culture.slice(-15),
      trades: trades.slice(-20),
      channels: channelKeys.map(k => allData[k].name).filter(Boolean),
      lastUpdated: new Date().toISOString(),
    };

    this._storage.set('_summary', summary);
  }

  /**
   * Build the channel knowledge context string for the AI system prompt.
   * Returns empty string if no knowledge exists.
   */
  buildContext() {
    const summary = this._storage.get('_summary', null);
    if (!summary) return '';

    const hasPeople = Object.keys(summary.people || {}).length > 0;
    const hasFacts = (summary.facts || []).length > 0;
    const hasCulture = (summary.culture || []).length > 0;
    const hasTrades = (summary.trades || []).length > 0;

    if (!hasPeople && !hasFacts && !hasCulture && !hasTrades) return '';

    const parts = ['SERVER MEMORY (from past conversations):'];

    if (hasPeople) {
      const peopleLines = Object.entries(summary.people)
        .map(([user, note]) => `  ${user}: ${note}`)
        .join('\n');
      parts.push(`People I know:\n${peopleLines}`);
    }

    if (hasCulture) {
      parts.push(`Server vibes: ${summary.culture.join('; ')}`);
    }

    if (hasFacts) {
      parts.push(`Key things discussed: ${summary.facts.slice(-15).join('; ')}`);
    }

    if (hasTrades) {
      parts.push(`Recent trades/calls: ${summary.trades.slice(-10).join('; ')}`);
    }

    // Enforce character limit
    let result = parts.join('\n');
    if (result.length > CONTEXT_MAX_CHARS) {
      result = result.slice(0, CONTEXT_MAX_CHARS) + '...';
    }

    return result;
  }

  /**
   * Get ingestion status for all channels.
   */
  getStatus() {
    const allData = this._storage.getAll();
    const channels = [];
    for (const [key, val] of Object.entries(allData)) {
      if (!key.startsWith('channel:')) continue;
      channels.push({
        name: val.name,
        messageCount: val.messageCount || 0,
        knowledgeEntries: (val.knowledge || []).length,
        lastIngested: val.lastIngested,
      });
    }
    return {
      ingesting: this._ingesting,
      channels,
      hasSummary: !!this._storage.get('_summary', null),
    };
  }

  /**
   * Clear all stored knowledge.
   */
  clear() {
    const allData = this._storage.getAll();
    for (const key of Object.keys(allData)) {
      this._storage.set(key, undefined);
    }
    // Re-initialize with empty state
    this._storage.data = {};
    this._storage.save();
    auditLog.log('channel_history', 'All channel knowledge cleared');
  }
}

module.exports = new ChannelHistoryService();
