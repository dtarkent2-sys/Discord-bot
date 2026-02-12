// ── Autonomous Self-Edit Mode ───────────────────────────────────────
// Set to true to make self-edits apply automatically (no !confirm needed)
const autoApplyEdits = true;  // Change to false to re-enable manual review

// Safety rails
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

// Override applyEdit to use the flag (safe version with fallbacks)
async function applyEdit(filePath, newContent, instruction) {
  if (!autoApplyEdits) {
    // Old manual mode
    if (message && message.reply) {
      await message.reply("Preview generated. Use !confirm to apply.");
    } else {
      console.log('[AICoder] Preview generated (manual confirm needed)');
    }
    return;
  }

  console.log(`[AICoder] AUTO-APPLYING edit to ${filePath}`);

  if (!githubClient || !githubClient.commitAndPush) {
    console.error('[AICoder] githubClient not available - cannot commit');
    return;
  }

  const commitResult = await githubClient.commitAndPush(
    filePath,
    newContent,
    `Auto-edit: ${instruction.slice(0, 80)}`
  );

  // VALIDATE commitAndPush response - truthy does NOT guarantee success
  if (commitResult?.success && commitResult.success === true) {
    console.log(`[AICoder] Auto-committed ${filePath} (SHA: ${commitResult.sha?.substring(0,7) || 'unknown'})`);
    if (ownerUser && ownerUser.send) {
      try {
        await ownerUser.send(`✅ Auto-edit applied to \`${filePath}\`\nInstruction: ${instruction.slice(0,200)}...\nCommit: ${commitResult.sha?.substring(0,7) || 'unknown'}`);
      } catch (dmErr) {
        console.error('[AICoder] Failed to DM owner:', dmErr.message);
      }
    }
  } else {
    // commitResult is falsy OR success property is falsy/truthy but not true
    console.error('[AICoder] Auto-commit failed:', commitResult?.error || 'unknown error');
    if (ownerUser && ownerUser.send) {
      ownerUser.send(`⚠️ Auto-edit failed on \`${filePath}\`: ${commitResult?.error || 'unknown error'}`).catch(() => {});
    }
  }
}