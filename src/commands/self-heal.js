const config = require('../config');
const aicoder = require('../ai-coder.js');
const github = require('../github-client.js');
const { instrumentMessage } = require('../utils/safe-send');

// Cooldown: prevent selfheal recursion. Max 1 selfheal per file per 30 minutes.
const SELFHEAL_COOLDOWN_MS = 30 * 60 * 1000;
const selfhealCooldowns = new Map(); // filePath -> lastRunTimestamp

module.exports = {
    name: 'selfheal',
    description: 'Bot automatically finds and fixes bugs in a file. Usage: !selfheal <file_path>',
    async execute(message, args) {
        // Instrument all outbound sends/replies for diagnostics
        instrumentMessage(message);

        // 1. Owner check
        if (!config.botOwnerId || message.author.id !== config.botOwnerId) {
            return message.reply('Restricted to owner.');
        }

        if (!args[0]) {
            return message.reply('❌ Please specify a file. Example: `!selfheal ai-engine.js`');
        }

        const filePath = args[0];

        // Recursion guard: enforce cooldown per file
        const lastRun = selfhealCooldowns.get(filePath) || 0;
        const elapsed = Date.now() - lastRun;
        if (elapsed < SELFHEAL_COOLDOWN_MS) {
            const remaining = Math.ceil((SELFHEAL_COOLDOWN_MS - elapsed) / 60000);
            return message.reply(`⏳ Selfheal cooldown: \`${filePath}\` was healed recently. Try again in ${remaining} min.`);
        }
        const thinkingMsg = await message.channel.send(`🔍 **${this.name}** analyzing \`${filePath}\` for critical bugs...`);

        // 2. Get current code
        const fileData = await github.getFileContent(filePath);
        if (!fileData) {
            return thinkingMsg.edit(`Could not fetch \`${filePath}\`. Check the path.`);
        }
        const currentCode = fileData.content;

        // 3. AI Prompt for SELF-FIXING (not just suggesting)
        const selfFixPrompt = `
You are the bot itself. Analyze the following code file from your own codebase.
Find EXACTLY ONE critical, obvious bug or security issue that can be fixed in this single file.
Examples: unhandled promise rejection, undefined variable access, missing await, API key exposure in logs.

CRITERIA for the fix:
- Must be a CRITICAL bug (will cause a crash or security issue)
- Must be fixable by changing ONLY this file
- Fix must be under 10 lines of changed code
- Do NOT add new features
- Do NOT refactor working code

FILE: ${filePath}
\`\`\`javascript
${currentCode}
\`\`\`

INSTRUCTIONS:
1. Identify ONE critical bug.
2. Write the COMPLETE fixed file content.
3. Output ONLY the fixed code, no explanations.

Output the complete fixed file:
`;

        // 4. Generate the fixed code
        const aiResult = await aicoder.generateCodeChange(selfFixPrompt, filePath);
        if (aiResult.error) {
            return thinkingMsg.edit(`❌ AI failed: ${aiResult.error}`);
        }

        // 5. Safety check - More restrictive than !autoedit
        const safety = github.isChangeSafe(filePath, aiResult.newCode, currentCode);
        const linesChanged = github.diffLines(currentCode, aiResult.newCode);
        
        // Extra strict rules for self-healing
        const isSelfHealSafe = safety.safe && 
                              linesChanged < 15 && 
                              !aiResult.newCode.includes('GITHUB_TOKEN') &&
                              !aiResult.newCode.includes('apiKey') &&
                              !aiResult.newCode.includes('secret');

        if (!isSelfHealSafe) {
            await thinkingMsg.edit(`⛔ **Self-heal blocked.** Changes too large (${linesChanged} lines) or risky.\nUse \`!suggest\` to review first.`);
            // Still show the proposed fix
            return message.channel.send(`📝 Proposed fix:\n\`\`\`diff\n${aiResult.newCode}\n\`\`\``);
        }

        // 6. Commit the fix to a self-heal branch (never directly to main)
        const today = new Date().toISOString().slice(0, 10);
        const branchName = `self-heal/${today}`;
        const branch = await github.ensureBranch(branchName);
        if (!branch) {
            return thinkingMsg.edit('❌ Failed to create self-heal branch.');
        }

        const commitMsg = `🔧 SELF-HEAL: Critical fix for ${filePath}`;
        const updateResult = await github.updateFileOnBranch(filePath, aiResult.newCode, commitMsg, branchName);

        if (updateResult.success) {
            selfhealCooldowns.set(filePath, Date.now());

            // Create/find PR for review
            const pr = await github.ensurePullRequest(
              branchName,
              `Self-heal fixes ${today}`,
              `Automated critical fixes from \`!selfheal\` on ${today}.`
            );
            const prLink = pr ? `\nPR for review: ${pr.url}` : '';

            await thinkingMsg.edit(`✅ **Self-healed \`${filePath}\`!** Fix committed to branch \`${branchName}\`.\n${updateResult.url}${prLink}\n\n_Review & merge the PR when ready — main stays safe._`);
        } else {
            await thinkingMsg.edit(`❌ Commit failed: ${updateResult.error}`);
        }
    },
};