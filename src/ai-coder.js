const config = require('./config');
const github = require('./github-client');

class AICoder {
  constructor() {
    this._client = null;
    this._initFailed = false;

    if (!config.anthropicApiKey) {
      console.warn('[AICoder] ANTHROPIC_API_KEY not set — !suggest and !autoedit will be disabled.');
      this._initFailed = true;
    }
  }

  // Lazy-load Anthropic SDK (may be ESM-only)
  async _getClient() {
    if (this._client) return this._client;
    if (this._initFailed) return null;

    try {
      const mod = await import('@anthropic-ai/sdk');
      const Anthropic = mod.default || mod.Anthropic;
      this._client = new Anthropic({ apiKey: config.anthropicApiKey });
      return this._client;
    } catch (err) {
      console.error('[AICoder] Failed to load Anthropic SDK:', err.message);
      this._initFailed = true;
      return null;
    }
  }

  get enabled() {
    return !!config.anthropicApiKey && !this._initFailed;
  }

  async generateCodeChange(instruction, filePath) {
    const client = await this._getClient();
    if (!client) return { error: 'Anthropic API client not available' };

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
      const response = await client.messages.create({
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
