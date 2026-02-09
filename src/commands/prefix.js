const config = require('../config');
const github = require('../github-client');
const aicoder = require('../ai-coder');
const selfHealModule = require('./self-heal');
const circuitBreaker = require('../services/circuit-breaker');

// Owner-only guard
function isOwner(message) {
  if (!config.botOwnerId) return false;
  return message.author.id === config.botOwnerId;
}

// ── !update <file_path> ```code``` ──────────────────────────────────
async function handleUpdate(message, args) {
  if (!isOwner(message)) {
    return message.reply('This command is restricted to the bot owner.');
  }
  if (!github.enabled) {
    return message.reply('GitHub integration is not configured. Set GITHUB_TOKEN in env vars.');
  }
  if (args.length < 1) {
    return message.reply('Usage: `!update <file_path>` with a code block.\nExample: `!update src/commands/test.js \\`\\`\\`js\\n// code\\n\\`\\`\\``');
  }

  const filePath = args[0];

  // Extract code from a Discord code block
  const codeBlock = message.content.match(/```(?:\w*\n)?([\s\S]*?)```/);
  if (!codeBlock) {
    return message.reply('Please wrap your new code in a code block (\\`\\`\\`js ... \\`\\`\\`).');
  }

  const newContent = codeBlock[1].trim();
  const commitMessage = `Manual update via Discord: ${filePath} by ${message.author.username}`;

  const workingMsg = await message.channel.send('Updating file on GitHub...');

  const result = await github.updateFile(filePath, newContent, commitMessage);

  if (result.success) {
    await workingMsg.edit(`Updated \`${filePath}\` successfully.\nCommit: ${result.url}`);
  } else {
    await workingMsg.edit(`Failed to update \`${filePath}\`: ${result.error}`);
  }
}

// ── !suggest <file_path> <instruction> ──────────────────────────────
async function handleSuggest(message, args) {
  if (!isOwner(message)) {
    return message.reply('This command is restricted to the bot owner.');
  }
  if (!aicoder.enabled) {
    return message.reply('AI coder is not configured. Set ANTHROPIC_API_KEY in env vars.');
  }
  if (!github.enabled) {
    return message.reply('GitHub integration is not configured. Set GITHUB_TOKEN in env vars.');
  }
  if (args.length < 2) {
    return message.reply('Usage: `!suggest <file_path> <instruction>`\nExample: `!suggest src/commands/handlers.js "Add a /ping command that shows latency"`');
  }

  const filePath = args[0];
  const instruction = args.slice(1).join(' ');

  const waitMsg = await message.channel.send('AI is thinking...');

  const result = await aicoder.generateCodeChange(instruction, filePath);
  if (result.error) {
    return waitMsg.edit(`Failed: ${result.error}`);
  }

  await waitMsg.edit(`**Suggestion for \`${filePath}\`**\n*Instruction: ${instruction}*\n\nTo apply this change, use: \`!update ${filePath}\` with the code below.`);

  // Send the new code — split if too long for Discord
  const codeOutput = `\`\`\`js\n${result.newCode}\n\`\`\``;
  if (codeOutput.length <= 2000) {
    await message.channel.send(codeOutput);
  } else {
    // Split into chunks
    const chunks = splitMessage(result.newCode, 1900);
    for (let i = 0; i < chunks.length; i++) {
      await message.channel.send(`\`\`\`js\n${chunks[i]}\n\`\`\``);
    }
  }
}

// ── !autoedit <file_path> <instruction> ─────────────────────────────
async function handleAutoedit(message, args) {
  if (!isOwner(message)) {
    return message.reply('This command is restricted to the bot owner.');
  }
  if (!aicoder.enabled) {
    return message.reply('AI coder is not configured. Set ANTHROPIC_API_KEY in env vars.');
  }
  if (!github.enabled) {
    return message.reply('GitHub integration is not configured. Set GITHUB_TOKEN in env vars.');
  }
  if (args.length < 2) {
    return message.reply('Usage: `!autoedit <file_path> <instruction>`');
  }

  const filePath = args[0];
  const instruction = args.slice(1).join(' ');

  const waitMsg = await message.channel.send('AI attempting safe auto-edit...');

  // Generate new code
  const aiResult = await aicoder.generateCodeChange(instruction, filePath);
  if (aiResult.error) {
    return waitMsg.edit(`AI failed: ${aiResult.error}`);
  }

  // Safety check
  const safety = github.isChangeSafe(filePath, aiResult.newCode, aiResult.currentCode);
  if (!safety.safe) {
    return waitMsg.edit(`Auto-edit blocked: ${safety.reason}\nUse \`!suggest\` to see the change first.`);
  }

  // Apply the change
  const commitMsg = `Auto-edit via Discord: ${instruction.substring(0, 50)}`;
  const result = await github.updateFile(filePath, aiResult.newCode, commitMsg);

  if (result.success) {
    await waitMsg.edit(`Automatically updated \`${filePath}\`.\nCommit: ${result.url}`);
  } else {
    await waitMsg.edit(`Update failed: ${result.error}`);
  }
}

// ── !rollback <file_path> ───────────────────────────────────────────
async function handleRollback(message, args) {
  if (!isOwner(message)) {
    return message.reply('This command is restricted to the bot owner.');
  }
  if (!github.enabled) {
    return message.reply('GitHub integration is not configured. Set GITHUB_TOKEN in env vars.');
  }
  if (args.length < 1) {
    return message.reply('Usage: `!rollback <file_path>` — reverts to the previous commit version.');
  }

  const filePath = args[0];
  const waitMsg = await message.channel.send(`Rolling back \`${filePath}\`...`);

  try {
    const { Octokit } = await import('@octokit/rest');
    const octokit = new Octokit({ auth: config.githubToken });

    // Get commit history for this file
    const commits = await octokit.repos.listCommits({
      owner: config.githubOwner,
      repo: config.githubRepo,
      path: filePath,
      sha: config.githubBranch,
      per_page: 2,
    });

    if (!commits.data || commits.data.length < 2) {
      return waitMsg.edit(`Cannot rollback \`${filePath}\`: no previous version found (only ${commits.data?.length || 0} commit(s)).`);
    }

    // Get the file content at the previous commit
    const previousSha = commits.data[1].sha;
    const previousFile = await octokit.repos.getContent({
      owner: config.githubOwner,
      repo: config.githubRepo,
      path: filePath,
      ref: previousSha,
    });

    const previousContent = Buffer.from(previousFile.data.content, 'base64').toString();
    const commitMsg = `Rollback via Discord: ${filePath} to ${previousSha.slice(0, 7)} by ${message.author.username}`;

    const result = await github.updateFile(filePath, previousContent, commitMsg);

    if (result.success) {
      await waitMsg.edit(`Rolled back \`${filePath}\` to previous version (commit ${previousSha.slice(0, 7)}).\nCommit: ${result.url}`);
    } else {
      await waitMsg.edit(`Rollback failed: ${result.error}`);
    }
  } catch (err) {
    console.error(`[Rollback] Error:`, err);
    await waitMsg.edit(`Rollback failed: ${err.message}`);
  }
}

// ── !selfheal <file_path> ──────────────────────────────────────────
async function handleSelfheal(message, args) {
  await selfHealModule.execute(message, args);
}

// ── !emergency ──────────────────────────────────────────────────────
// Kills the autonomous loop, activates kill switch, closes all positions,
// and writes a post-mortem log. Owner-only.
async function handleEmergency(message) {
  if (!isOwner(message)) {
    return message.reply('This command is restricted to the bot owner.');
  }

  const waitMsg = await message.channel.send('🚨 **INITIATING EMERGENCY STOP...**');

  // The autonomous engine is stored on the client by index.js
  const autonomousEngine = message.client._autonomousEngine;
  if (!autonomousEngine) {
    // Fallback: at least kill the trading engine directly
    const mahoraga = require('../services/mahoraga');
    await mahoraga.kill();
    return waitMsg.edit('🚨 Emergency stop: Kill switch activated, but autonomous engine reference not found. Schedules may still be running — restart the bot to fully stop.');
  }

  try {
    const result = await autonomousEngine.emergencyStop();
    await waitMsg.edit([
      '🚨 **EMERGENCY STOP COMPLETE**',
      '',
      result.message,
      result.postMortemPath ? `Post-mortem: \`${result.postMortemPath}\`` : '',
      '',
      '_All autonomous behaviors halted. Use `/agent enable` after restart to resume._',
    ].filter(Boolean).join('\n'));
  } catch (err) {
    await waitMsg.edit(`🚨 Emergency stop error: ${err.message}`).catch(() => {});
  }
}

// ── !cbreset ────────────────────────────────────────────────────────
// Manually reset the circuit breaker after operator review. Owner-only.
async function handleCbReset(message) {
  if (!isOwner(message)) {
    return message.reply('This command is restricted to the bot owner.');
  }

  const status = circuitBreaker.getStatus();
  if (!status.paused) {
    return message.reply('Circuit breaker is not currently tripped.');
  }

  circuitBreaker.manualReset();
  return message.reply('Circuit breaker reset. Trading can resume on next cycle.');
}

// ── !help ──────────────────────────────────────────────────────────
async function handleHelp(message) {
  const prefix = config.botPrefix;
  await message.reply([
    '**Slash Commands:**',
    '`/ask <question>` — Ask the AI a question',
    '`/analyze <ticker>` — AI-powered stock analysis',
    '`/price <ticker>` — Quick price + key stats',
    '`/screen <universe> [rules]` — Run a stock screen',
    '`/watchlist [action] [ticker]` — Manage your watchlist',
    '`/sentiment <text>` — Analyze text sentiment',
    '`/topic` — Generate a discussion topic',
    '`/profile [@user]` — View user profile',
    '`/memory` — See what the bot remembers about you',
    '`/model <name>` — Switch the AI model',
    '`/stats` — View bot statistics',
    '`/help` — Show all commands',
    '',
    '**Prefix Commands (owner only):**',
    `\`${prefix}update <file>\` — Push code to GitHub`,
    `\`${prefix}suggest <file> <instruction>\` — AI code suggestion`,
    `\`${prefix}autoedit <file> <instruction>\` — Auto-apply safe changes`,
    `\`${prefix}rollback <file>\` — Revert a file to its previous version`,
    `\`${prefix}selfheal <file>\` — AI auto-fix critical bugs`,
    `\`${prefix}emergency\` — **EMERGENCY STOP** — kill all trading + schedules`,
    `\`${prefix}cbreset\` — Reset circuit breaker after review`,
    `\`${prefix}help\` — Show this message`,
  ].join('\n'));
}

// Helper: split a string into chunks
function splitMessage(text, maxLen) {
  const lines = text.split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 1 > maxLen) {
      chunks.push(current);
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Command router
const commands = {
  update: handleUpdate,
  suggest: handleSuggest,
  autoedit: handleAutoedit,
  rollback: handleRollback,
  selfheal: handleSelfheal,
  emergency: handleEmergency,
  cbreset: handleCbReset,
  help: handleHelp,
};

async function handlePrefixCommand(message) {
  const prefix = config.botPrefix;
  if (!message.content.startsWith(prefix)) return false;

  const content = message.content.slice(prefix.length).trim();
  const parts = content.split(/\s+/);
  const commandName = parts[0]?.toLowerCase();
  const args = parts.slice(1);

  const handler = commands[commandName];
  if (!handler) return false;

  try {
    await handler(message, args);
  } catch (err) {
    console.error(`[Prefix] Error in !${commandName}:`, err);
    await message.reply(`Something went wrong running !${commandName}: ${err.message}`).catch(() => {});
  }

  return true; // command was handled
}

module.exports = { handlePrefixCommand };
