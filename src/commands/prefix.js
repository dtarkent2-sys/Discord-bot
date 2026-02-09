const config = require('../config');
const github = require('../github-client');
const aicoder = require('../ai-coder');
const selfHealModule = require('./self-heal');

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
  if (!github.enabled) {
    return message.reply('GitHub integration is not configured. Set GITHUB_TOKEN in env vars.');
  }
  if (args.length < 2) {
    return message.reply('Usage: `!suggest <file_path> <instruction>`\nExample: `!suggest src/commands/handlers.js "Add a /ping command that shows latency"`');
  }

  const filePath = args[0];
  const instruction = args.slice(1).join(' ');

  const waitMsg = await message.channel.send(`AI is thinking... _(local Ollama: ${aicoder.model})_`);

  const result = await aicoder.generateCodeChange(instruction, filePath);
  if (result.error) {
    return waitMsg.edit(`Failed: ${result.error}`);
  }

  // Show diff instead of full file
  const { diff, changedCount } = aicoder.generateDiff(result.currentCode, result.newCode, filePath);

  await waitMsg.edit(
    `**Suggestion for \`${filePath}\`** (${changedCount} lines changed)\n` +
    `_Instruction: ${instruction}_\n\n` +
    `To apply, use: \`!update ${filePath}\` with the full code, or use \`!autoedit\` instead.`
  );

  const diffOutput = `\`\`\`diff\n${diff}\n\`\`\``;
  if (diffOutput.length <= 2000) {
    await message.channel.send(diffOutput);
  } else {
    const chunks = splitMessage(diff, 1900);
    for (let i = 0; i < Math.min(chunks.length, 3); i++) {
      await message.channel.send(`\`\`\`diff\n${chunks[i]}\n\`\`\``);
    }
  }
}

// ── !autoedit <file_path> <instruction> ─────────────────────────────
async function handleAutoedit(message, args) {
  if (!isOwner(message)) {
    return message.reply('This command is restricted to the bot owner.');
  }
  if (!github.enabled) {
    return message.reply('GitHub integration is not configured. Set GITHUB_TOKEN in env vars.');
  }
  if (args.length < 2) {
    return message.reply('Usage: `!autoedit <file_path> <instruction>`');
  }

  const filePath = args[0];
  const instruction = args.slice(1).join(' ');

  const waitMsg = await message.channel.send(`AI generating edit... _(local Ollama: ${aicoder.model})_`);

  // Generate new code
  const aiResult = await aicoder.generateCodeChange(instruction, filePath);
  if (aiResult.error) {
    return waitMsg.edit(`AI failed: ${aiResult.error}`);
  }

  // Check if AI refused
  if (aiResult.newCode.includes('// AI-CODER: REFUSED')) {
    return waitMsg.edit(`AI refused the change. Reason embedded in output.\nUse \`!suggest\` to see details.`);
  }

  // Safety check
  const safety = github.isChangeSafe(filePath, aiResult.newCode, aiResult.currentCode);
  if (!safety.safe) {
    return waitMsg.edit(`Auto-edit blocked: ${safety.reason}\nUse \`!suggest\` to see the change first.`);
  }

  // Generate diff and queue for confirmation
  const { diff, changedCount } = aicoder.generateDiff(aiResult.currentCode, aiResult.newCode, filePath);

  aicoder.setPendingEdit(message.channel.id, {
    type: 'autoedit',
    filePath,
    newCode: aiResult.newCode,
    currentCode: aiResult.currentCode,
    instruction,
    linesChanged: changedCount,
    requestedBy: message.author.id,
  });

  await waitMsg.edit(
    `**Auto-Edit: ${filePath}** (${changedCount} lines changed)\n` +
    `_Instruction: ${instruction}_\n\n` +
    `Reply \`!confirm\` within 10 minutes to apply, or \`!cancel\` to discard.`
  );

  const diffOutput = `\`\`\`diff\n${diff}\n\`\`\``;
  if (diffOutput.length <= 2000) {
    await message.channel.send(diffOutput);
  } else {
    await message.channel.send(`\`\`\`diff\n${diff.slice(0, 1900)}\n...\n\`\`\``);
  }
}

// ── !confirm — Apply a pending edit ─────────────────────────────────
async function handleConfirm(message) {
  if (!isOwner(message)) {
    return message.reply('This command is restricted to the bot owner.');
  }

  const pending = aicoder.consumePendingEdit(message.channel.id);
  if (!pending) {
    return message.reply('No pending edit to confirm in this channel. Edits expire after 10 minutes.');
  }

  const commitMsg = pending.type === 'selfheal'
    ? `Self-heal fix for ${pending.filePath}`
    : `Auto-edit: ${(pending.instruction || '').substring(0, 50)}`;

  const workingMsg = await message.channel.send(`Applying ${pending.type} to \`${pending.filePath}\`...`);

  const result = await github.updateFile(pending.filePath, pending.newCode, commitMsg);

  if (result.success) {
    await workingMsg.edit(
      `**Committed \`${pending.filePath}\`** (${pending.linesChanged} lines changed)\n` +
      `Commit: ${result.url}\n` +
      `_Use \`!rollback ${pending.filePath}\` to revert if needed._`
    );
  } else {
    await workingMsg.edit(`Commit failed: ${result.error}`);
  }
}

// ── !cancel — Discard a pending edit ────────────────────────────────
async function handleCancel(message) {
  if (!isOwner(message)) {
    return message.reply('This command is restricted to the bot owner.');
  }

  const pending = aicoder.consumePendingEdit(message.channel.id);
  if (!pending) {
    return message.reply('No pending edit to cancel.');
  }

  await message.reply(`Discarded pending ${pending.type} for \`${pending.filePath}\`.`);
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

// ── !help ──────────────────────────────────────────────────────────
async function handleHelp(message) {
  const prefix = config.botPrefix;
  await message.reply([
    '**Slash Commands:**',
    '`/ask` — Chat | `/analyze` `/deepanalysis` — Stock analysis',
    '`/price` — Quote | `/technicals` — RSI, MACD, Bollinger',
    '`/macro` — Market regime | `/sectors` — Rotation | `/validea` — Guru scores',
    '`/gex` — Gamma | `/news` — News | `/reddit` — Reddit sentiment',
    '`/research` — Agent Swarm | `/screen` — Screener',
    '`/social` `/trending` — StockTwits | `/stream` — WebSocket',
    '`/watchlist` `/memory` `/profile` `/stats` `/model` `/topic`',
    '`/agent status|enable|disable|config|set|trade|logs|kill|reset`',
    '',
    '**Owner Commands** _(local Ollama — no external APIs)_**:**',
    `\`${prefix}suggest <file> <instruction>\` — AI code suggestion (diff preview)`,
    `\`${prefix}autoedit <file> <instruction>\` — AI edit + !confirm to apply`,
    `\`${prefix}selfheal <file>\` — AI bug-fix + !confirm to apply (max 2/hr)`,
    `\`${prefix}confirm\` — Apply pending edit | \`${prefix}cancel\` — Discard`,
    `\`${prefix}update <file>\` — Push code block directly to GitHub`,
    `\`${prefix}rollback <file>\` — Revert to previous version`,
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
  confirm: handleConfirm,
  cancel: handleCancel,
  rollback: handleRollback,
  selfheal: handleSelfheal,
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
