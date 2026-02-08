const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const github = require('./github-client');

class AICoder {
  constructor() {
    this.client = config.anthropicApiKey
      ? new Anthropic.default({ apiKey: config.anthropicApiKey })
      : null;

    if (!this.client) {
      console.warn('[AICoder] ANTHROPIC_API_KEY not set — !suggest and !autoedit will be disabled.');
    }
  }

  get enabled() {
    return !!this.client;
  }

  async generateCodeChange(instruction, filePath) {
    // Get the current code for context
    const file = await github.getFileContent(filePath);
    if (!file) {
      return { error: `Could not fetch current file: ${filePath}` };
    }

    const prompt = `You are an expert software engineer maintaining a Discord bot. Your task is to modify an existing file based on a user's instruction.

<current_file path="${filePath}">
${file.content}
</current_file>

<user_instruction>
${instruction}
</user_instruction>

Please generate the COMPLETE, updated content for the file. Your output must be the new file content ONLY, ready to be saved. Do not include explanations, comments about the changes, or markdown code blocks.`;

    try {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      });
      return { newCode: response.content[0].text.trim(), currentCode: file.content };
    } catch (error) {
      console.error('[AICoder] Generation error:', error.message);
      return { error: `AI generation failed: ${error.message}` };
    }
  }
}

module.exports = new AICoder();
