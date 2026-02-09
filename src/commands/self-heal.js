const config = require('../config');
const aicoder = require('../ai-coder.js');
const github = require('../github-client.js');

module.exports = {
    name: 'selfheal',
    description: 'Bot analyzes a file for critical bugs and proposes a fix. Usage: !selfheal <file_path>',
    async execute(message, args) {
        // 1. Owner check
        if (!config.botOwnerId || message.author.id !== config.botOwnerId) {
            return message.reply('Restricted to owner.');
        }

        if (!args[0]) {
            return message.reply('Usage: `!selfheal <file_path>`\nExample: `!selfheal src/services/ai.js`');
        }

        // 2. Rate limit check (max 2 per hour to prevent loops)
        if (!aicoder.canSelfHeal()) {
            const remaining = aicoder.getSelfHealRemaining();
            return message.reply(`Self-heal rate limited (${remaining} remaining this hour). Max 2 per hour to prevent edit loops.`);
        }

        const filePath = args[0];
        const thinkingMsg = await message.channel.send(`**Self-Heal** analyzing \`${filePath}\` for critical bugs...\n_Using local Ollama (${aicoder.model}) — no data leaves the network._`);

        // 3. Generate fix via local Ollama
        const aiResult = await aicoder.generateSelfHeal(filePath);
        if (aiResult.error) {
            return thinkingMsg.edit(`Self-heal failed: ${aiResult.error}`);
        }

        if (aiResult.noBug) {
            return thinkingMsg.edit(`**Self-Heal: ${filePath}**\nNo critical bugs found. File looks clean.`);
        }

        // 4. Safety check
        const safety = github.isChangeSafe(filePath, aiResult.newCode, aiResult.currentCode);
        const linesChanged = github.diffLines(aiResult.currentCode, aiResult.newCode);

        const isSelfHealSafe = safety.safe &&
                              linesChanged < 15 &&
                              !aiResult.newCode.includes('GITHUB_TOKEN') &&
                              !aiResult.newCode.includes('apiKey') &&
                              !aiResult.newCode.includes('secret');

        if (!isSelfHealSafe) {
            const reason = !safety.safe ? safety.reason : `${linesChanged} lines changed (max 15)`;
            await thinkingMsg.edit(`**Self-Heal blocked** for \`${filePath}\`: ${reason}\nProposed diff shown below — review manually.`);

            const { diff } = aicoder.generateDiff(aiResult.currentCode, aiResult.newCode, filePath);
            const diffOutput = `\`\`\`diff\n${diff}\n\`\`\``;
            if (diffOutput.length <= 2000) {
                await message.channel.send(diffOutput);
            } else {
                await message.channel.send(`\`\`\`diff\n${diff.slice(0, 1900)}\n...\n\`\`\``);
            }
            return;
        }

        // 5. Generate diff and queue for confirmation (don't auto-commit)
        const { diff, changedCount } = aicoder.generateDiff(aiResult.currentCode, aiResult.newCode, filePath);

        aicoder.recordSelfHeal();
        aicoder.setPendingEdit(message.channel.id, {
            type: 'selfheal',
            filePath,
            newCode: aiResult.newCode,
            currentCode: aiResult.currentCode,
            linesChanged: changedCount,
            requestedBy: message.author.id,
        });

        await thinkingMsg.edit(
            `**Self-Heal: ${filePath}** (${changedCount} lines changed)\n` +
            `_Remaining self-heals this hour: ${aicoder.getSelfHealRemaining()}_\n\n` +
            `Reply \`!confirm\` within 10 minutes to apply, or \`!cancel\` to discard.`
        );

        const diffOutput = `\`\`\`diff\n${diff}\n\`\`\``;
        if (diffOutput.length <= 2000) {
            await message.channel.send(diffOutput);
        } else {
            await message.channel.send(`\`\`\`diff\n${diff.slice(0, 1900)}\n...\n\`\`\``);
        }
    },
};
