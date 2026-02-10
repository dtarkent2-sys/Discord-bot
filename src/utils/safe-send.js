/**
 * safe-send.js — Diagnostic wrappers for Discord.js send/reply/edit methods.
 *
 * Adds try/catch + logging around every outbound message so we can diagnose
 * "bot processes commands but nothing appears in the channel" issues.
 *
 * Known error codes handled:
 *   403  — Missing Permissions (bot can't send in that channel)
 *   429  — Rate Limited
 *   50006 — Cannot send an empty message
 */

const config = require('../config');

// ── Helpers ──────────────────────────────────────────────────────────

function contentPreview(content) {
  if (!content) return '(empty)';
  if (typeof content === 'string') return content.slice(0, 100);
  if (typeof content === 'object' && content.content) return String(content.content).slice(0, 100);
  return '(object/embed)';
}

function classifySendError(err) {
  const httpStatus = err.httpStatus || err.status;
  const code = err.code;

  if (httpStatus === 403 || code === 50013)
    return { type: 'FORBIDDEN_403', detail: 'Missing permissions to send in this channel' };
  if (httpStatus === 429)
    return { type: 'RATE_LIMITED_429', detail: `Rate limited (retry after ${err.retryAfter || '?'}ms)` };
  if (code === 50006)
    return { type: 'EMPTY_MESSAGE_50006', detail: 'Cannot send an empty message' };
  return null;
}

/**
 * Attempt to DM the bot owner about a send failure.
 * Best-effort — never throws.
 */
async function notifyOwner(client, errorInfo) {
  if (!config.botOwnerId || !client) return;
  try {
    const owner = await client.users.fetch(config.botOwnerId);
    if (owner) {
      await owner.send(`**[Send Diagnostic]** ${errorInfo}`).catch(() => {});
    }
  } catch {
    // Can't reach owner — nothing else we can do
  }
}

// ── Instrumentation ──────────────────────────────────────────────────

/**
 * Wrap an interaction's reply / editReply / followUp / deferReply methods
 * with diagnostic logging. Call once at the top of handleCommand.
 *
 * Existing error handling (.catch(() => {})) continues to work because
 * the wrapper re-throws after logging.
 */
function instrumentInteraction(interaction) {
  const client = interaction.client;
  const channelId = interaction.channel?.id || interaction.channelId || '?';

  for (const method of ['reply', 'editReply', 'followUp', 'deferReply']) {
    const original = interaction[method]?.bind(interaction);
    if (!original) continue;

    interaction[method] = async function wrappedInteraction(...args) {
      const preview = method === 'deferReply' ? '(deferred)' : contentPreview(args[0]);
      console.log(`[SafeSend] interaction.${method} channel:${channelId} content:${preview}`);
      try {
        return await original(...args);
      } catch (err) {
        const known = classifySendError(err);
        if (known) {
          console.error(`[SafeSend] ${known.type} on interaction.${method} channel:${channelId} — ${known.detail}`, err.message);
          await notifyOwner(client, `${known.type} on interaction.${method} in <#${channelId}>: ${known.detail}`);
        } else {
          console.error(`[SafeSend] interaction.${method} failed channel:${channelId}`, err.message);
        }
        throw err; // re-throw so existing catch handlers still fire
      }
    };
  }
}

/**
 * Wrap a message's reply method and its channel's send method with
 * diagnostic logging. Call once at the top of prefix command handling.
 */
function instrumentMessage(message) {
  const client = message.client;
  const channelId = message.channel?.id || '?';

  // Wrap message.reply
  const origReply = message.reply.bind(message);
  message.reply = async function wrappedReply(...args) {
    const preview = contentPreview(args[0]);
    console.log(`[SafeSend] message.reply channel:${channelId} content:${preview}`);
    try {
      return await origReply(...args);
    } catch (err) {
      const known = classifySendError(err);
      if (known) {
        console.error(`[SafeSend] ${known.type} on message.reply channel:${channelId} — ${known.detail}`, err.message);
        await notifyOwner(client, `${known.type} on message.reply in <#${channelId}>: ${known.detail}`);
      } else {
        console.error(`[SafeSend] message.reply failed channel:${channelId}`, err.message);
      }
      throw err;
    }
  };

  // Wrap message.channel.send
  const origSend = message.channel.send.bind(message.channel);
  message.channel.send = async function wrappedSend(...args) {
    const preview = contentPreview(args[0]);
    console.log(`[SafeSend] channel.send channel:${channelId} content:${preview}`);
    try {
      return await origSend(...args);
    } catch (err) {
      const known = classifySendError(err);
      if (known) {
        console.error(`[SafeSend] ${known.type} on channel.send channel:${channelId} — ${known.detail}`, err.message);
        await notifyOwner(client, `${known.type} on channel.send in <#${channelId}>: ${known.detail}`);
      } else {
        console.error(`[SafeSend] channel.send failed channel:${channelId}`, err.message);
      }
      throw err;
    }
  };
}

/**
 * Wrap a channel.send call with diagnostic logging (for autonomous posting).
 * Returns the sent message or null on failure.
 */
async function safeSend(channel, content, client) {
  const preview = contentPreview(content);
  console.log(`[SafeSend] channel.send channel:${channel?.id} content:${preview}`);
  try {
    return await channel.send(content);
  } catch (err) {
    const known = classifySendError(err);
    if (known) {
      console.error(`[SafeSend] ${known.type} on channel.send channel:${channel?.id} — ${known.detail}`, err.message);
      await notifyOwner(client, `${known.type} on channel.send in <#${channel?.id}>: ${known.detail}`);
    } else {
      console.error(`[SafeSend] channel.send failed channel:${channel?.id}`, err.message);
    }
    throw err; // re-throw so callers can still handle (e.g. 429 retry)
  }
}

module.exports = {
  instrumentInteraction,
  instrumentMessage,
  safeSend,
  notifyOwner,
  classifySendError,
  contentPreview,
};
