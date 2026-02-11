// ── Autonomous Self-Edit Mode ───────────────────────────────────────
// Set to true to make self-edits apply automatically (no !confirm needed)
const autoApplyEdits = true;  // Change to false to re-enable manual review

// Override applyEdit to use the flag
async function applyEdit(filePath, newContent, instruction) {
  if (!autoApplyEdits) {
    // Old manual mode (if flag false)
    await message.reply("Preview generated. Use !confirm to apply.");
    return;
  }

  console.log(`[AICoder] AUTO-APPLYING edit to ${filePath}`);
  
  const commitResult = await githubClient.commitAndPush(
    filePath,
    newContent,
    `Auto-edit: ${instruction.slice(0, 80)}`
  );

  if (commitResult.success) {
    console.log(`[AICoder] Auto-committed ${filePath} (SHA: ${commitResult.sha?.substring(0,7) || 'unknown'})`);
    if (ownerUser) {
      try {
        await ownerUser.send(`✅ Auto-edit applied to \`${filePath}\`\nInstruction: ${instruction.slice(0,200)}...\nCommit: ${commitResult.sha?.substring(0,7) || 'unknown'}`);
      } catch (dmErr) {
        console.error('[AICoder] Failed to DM owner:', dmErr.message);
      }
    }
  } else {
    console.error('[AICoder] Auto-commit failed:', commitResult.error);
    if (ownerUser) {
      ownerUser.send(`⚠️ Auto-edit failed on \`${filePath}\`: ${commitResult.error}`).catch(() => {});
    }
  }
}

// Safety rails (keep these!)
const MAX_FILES_PER_RUN = 3;
let recentFailedDeploys = 0;
const FAILED_DEPLOY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function recordFailedDeploy() {
  recentFailedDeploys++;
  if (recentFailedDeploys > 2) {
    console.warn('[AICoder] Auto-edit paused: >2 failed deploys in 24h');
    if (ownerUser) {
      ownerUser.send('⚠️ Auto-edit paused due to multiple failed deploys. Use !enable-autoedit to resume.').catch(() => {});
    }
    return true; // paused
  }
  return false;
}

// Emergency disable command (add to messageCreate handler if not already there)
if (message.content === '!disable-autoedit' && message.author.id === BOT_OWNER_ID) {
  autoApplyEdits = false;
  message.reply('Autonomous self-edits disabled. Use !enable-autoedit to re-enable.');
}
