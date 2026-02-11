// Autonomy flag - when true, skip manual !confirm and auto-commit edits
const autoApplyEdits = true;

// Override apply logic to use the flag
async function applyEdit(filePath, newContent, instruction) {
  if (!autoApplyEdits) {
    await message.reply("Preview generated. Use !confirm to apply.");
    return;
  }

  console.log(`[AICoder] Auto-applying to ${filePath}`);
  
  const commitResult = await githubClient.commitAndPush(
    filePath,
    newContent,
    `Auto-edit: ${instruction.slice(0, 80)}`
  );

  if (commitResult.success) {
    console.log(`[AICoder] Auto-committed ${filePath}`);
    if (ownerUser) {
      ownerUser.send(`✅ Auto-edit applied to \`${filePath}\`\nInstruction: ${instruction}`).catch(() => {});
    }
  } else {
    console.error('[AICoder] Auto-commit failed:', commitResult.error);
  }
}

// Safety rails (unchanged)
const MAX_FILES_PER_RUN = 3;
let recentFailedDeploys = 0;
const FAILED_DEPLOY_WINDOW_MS = 24 * 60 * 60 * 1000;

function recordFailedDeploy() {
  recentFailedDeploys++;
  if (recentFailedDeploys > 2) {
    console.warn('[AICoder] Auto-edit paused: >2 failed deploys in 24h');
    if (ownerUser) ownerUser.send('⚠️ Auto-edit paused').catch(() => {});
    return true;
  }
  return false;
)


### Why This Should Finally Work
- Starts with `!update src/ai-coder.js` (one of the 5 commands it knows)
- Immediately followed by a **valid, short** code block (