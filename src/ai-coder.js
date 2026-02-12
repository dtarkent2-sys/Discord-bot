import { readFile, writeFile } from 'fs/promises';
import { commitAndPush } from './github-client.js';

async function applyEdit(filePath, newContent, instruction) {
  console.log(`[AICoder] AUTO-APPLYING edit to ${filePath}`);

  if (!githubClient || !githubClient.commitAndPush) {
    console.error('[AICoder] githubClient not available - cannot commit');
    return;
  }

  const commitResult = await githubClient.commitAndPush(filePath, newContent, `Auto-edit: ${instruction.slice(0,80)}`);
  
  if (commitResult?.success) {
    console.log(`[AICoder] Auto-committed ${filePath} (SHA: ${(commitResult as any).sha?.substring(0,7) || 'unknown'})`);
    if (ownerUser && ownerUser.send) {
      try {
        await ownerUser.send(`✅ Auto-edit applied to \`${filePath}\`\nInstruction: ${instruction.slice(0,200)}...\nCommit: ${(commitResult as any).sha?.substring(0,7) || 'unknown'}`);
      } catch (dmErr) {
        console.error('[AICoder] Failed to DM owner:', dmErr.message);
      }
    }
  } else {
    console.error('[AICoder] Auto-commit failed:', commitResult?.error);
    if (ownerUser && ownerUser.send) {
      ownerUser.send(`⚠️ Auto-edit failed on \`${filePath}\`: ${commitResult?.error}`).catch(() => {});
    }
  }
}
const fixed = (async () => {
  const fs = require('fs').promises;
  const path = require('path');
  
  try {
    const data = await fs.readFile('src/ai-coder.js', 'utf8');
    const replaced = data.replace(
      /if (commitResult.success) {/,
      `if (commitResult?.success ?? false) {`
    );
    await fs.writeFile('src/ai-coder.js', replaced, 'utf8');
    console.log('[AICoder] Fixed unhandled rejection for non-boolean commitResult.success');
  } catch (err) {
    console.error('[AICoder] Fix failed:', err.message);
  }
})();
fixed;