const { Ollama } = require('ollama');
const config = require('./config');
const github = require('./github-client');

/**
 * AICoder — Local Ollama-powered code generation and self-healing.
 *
 * All inference runs through the local Ollama instance (Railway private networking).
 * No external API calls. No data leaves the network.
 *
 * Safety:
 *   - Specialized defensive system prompt for coding tasks
 *   - Pending edit queue with 10-minute expiry (requires !confirm)
 *   - Self-heal rate limiting (max 2 per hour)
 *   - Large file chunking (summarize files >500 lines)
 *   - Unified diff output for human review
 */

// ── Coding System Prompt ──────────────────────────────────────────────
const CODER_SYSTEM_PROMPT = `You are a senior Node.js/Discord.js engineer maintaining a production Discord bot. You write SAFE, MINIMAL code changes.

SAFETY RULES (NEVER violate these):
1. NEVER delete existing functions, classes, or exports unless explicitly told to
2. NEVER add new npm dependencies — only use what's already imported
3. NEVER touch .env files, secrets, tokens, API keys, or credential logic
4. NEVER modify error handling to suppress errors silently
5. NEVER remove safety checks, rate limits, or permission guards
6. NEVER add console.log statements that could leak secrets
7. NEVER change file paths for config, data, or storage files
8. NEVER modify the module.exports unless the instruction requires it
9. ALWAYS produce valid JavaScript that will parse without syntax errors
10. ALWAYS preserve existing code style, indentation, and naming conventions

OUTPUT FORMAT:
- Output ONLY the complete, updated file content
- No markdown code blocks, no explanations, no comments about changes
- The output must be ready to save directly as a .js file
- If you cannot safely make the requested change, output the ORIGINAL file unchanged and add a single comment at the top: // AI-CODER: REFUSED — [reason]

CHANGE PHILOSOPHY:
- Make the MINIMUM change needed to fulfill the instruction
- Prefer adding code over modifying existing code
- Prefer modifying existing code over deleting code
- If a change affects more than 30 lines, you are probably doing too much
- When fixing bugs: fix ONLY the specific bug, do not refactor surrounding code`;

// ── Self-Heal System Prompt ───────────────────────────────────────────
const SELFHEAL_SYSTEM_PROMPT = `You are a production incident responder for a Node.js Discord bot. Your job is to find and fix EXACTLY ONE critical bug in the given file.

WHAT COUNTS AS CRITICAL:
- Unhandled promise rejection that causes crash
- Undefined variable access (ReferenceError)
- Missing await on async function call
- Incorrect API usage that throws at runtime
- Off-by-one errors that cause infinite loops
- Missing null/undefined checks on external data

WHAT IS NOT CRITICAL (do NOT fix these):
- Code style issues
- Missing documentation
- Performance optimizations
- Feature additions
- Refactoring opportunities
- Deprecated API usage (if it still works)

RULES:
1. Find EXACTLY ONE bug — the most critical one
2. Fix must be under 10 lines of changed code
3. Output the COMPLETE fixed file — no markdown, no explanations
4. If no critical bug exists, output the file unchanged with a comment: // AI-CODER: NO_BUG_FOUND
5. NEVER add new features while fixing bugs
6. NEVER refactor code while fixing bugs
7. NEVER change imports or exports unless the bug requires it`;

const MAX_FILE_LINES = 500; // Summarize files longer than this
const PENDING_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const SELFHEAL_MAX_PER_HOUR = 2;

class AICoder {
  constructor() {
    this.ollama = new Ollama({ host: config.ollamaHost });
    this.model = config.ollamaModel;

    // Pending edits waiting for !confirm (Map<channelId, pendingEdit>)
    this._pendingEdits = new Map();

    // Self-heal rate limiter
    this._selfHealLog = []; // timestamps of recent self-heals
  }

  get enabled() {
    return true; // Always enabled — uses local Ollama, no API key needed
  }

  // ── Code Generation ─────────────────────────────────────────────────

  async generateCodeChange(instruction, filePath) {
    // Get the current code from GitHub
    const file = await github.getFileContent(filePath);
    if (!file) {
      return { error: `Could not fetch current file: ${filePath}` };
    }

    // Chunk large files — summarize to fit Ollama context
    const codeForPrompt = this._prepareFileForPrompt(file.content, filePath);

    const userPrompt = `FILE: ${filePath}
<current_code>
${codeForPrompt}
</current_code>

INSTRUCTION: ${instruction}

Output the COMPLETE updated file content. Nothing else.`;

    try {
      const response = await this._ollamaChat(CODER_SYSTEM_PROMPT, userPrompt);
      if (!response) {
        return { error: 'Ollama returned empty response — is the model loaded?' };
      }

      // Strip any markdown code blocks the model might have added
      const cleaned = this._stripCodeBlocks(response);

      return { newCode: cleaned, currentCode: file.content };
    } catch (err) {
      console.error('[AICoder] Generation error:', err.message);
      if (err.message?.includes('ECONNREFUSED') || err.message?.includes('fetch failed')) {
        return { error: 'Brain offline — Ollama is not reachable. Code editing unavailable.' };
      }
      return { error: `AI generation failed: ${err.message}` };
    }
  }

  // ── Self-Heal Analysis ──────────────────────────────────────────────

  async generateSelfHeal(filePath, recentErrors = '') {
    const file = await github.getFileContent(filePath);
    if (!file) {
      return { error: `Could not fetch current file: ${filePath}` };
    }

    const codeForPrompt = this._prepareFileForPrompt(file.content, filePath);

    let userPrompt = `FILE: ${filePath}
<current_code>
${codeForPrompt}
</current_code>`;

    if (recentErrors) {
      userPrompt += `\n\nRECENT ERROR LOGS:\n${recentErrors}`;
    }

    userPrompt += '\n\nAnalyze this file. Find and fix EXACTLY ONE critical bug. Output the COMPLETE fixed file.';

    try {
      const response = await this._ollamaChat(SELFHEAL_SYSTEM_PROMPT, userPrompt);
      if (!response) {
        return { error: 'Ollama returned empty response' };
      }

      const cleaned = this._stripCodeBlocks(response);

      // Check if AI found no bug
      if (cleaned.includes('// AI-CODER: NO_BUG_FOUND')) {
        return { noBug: true, currentCode: file.content };
      }

      return { newCode: cleaned, currentCode: file.content };
    } catch (err) {
      console.error('[AICoder] Self-heal error:', err.message);
      if (err.message?.includes('ECONNREFUSED') || err.message?.includes('fetch failed')) {
        return { error: 'Brain offline — Ollama is not reachable.' };
      }
      return { error: `Self-heal analysis failed: ${err.message}` };
    }
  }

  // ── Rate Limiting ───────────────────────────────────────────────────

  canSelfHeal() {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    this._selfHealLog = this._selfHealLog.filter(ts => ts > oneHourAgo);
    return this._selfHealLog.length < SELFHEAL_MAX_PER_HOUR;
  }

  recordSelfHeal() {
    this._selfHealLog.push(Date.now());
  }

  getSelfHealRemaining() {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    this._selfHealLog = this._selfHealLog.filter(ts => ts > oneHourAgo);
    return SELFHEAL_MAX_PER_HOUR - this._selfHealLog.length;
  }

  // ── Pending Edit Queue ──────────────────────────────────────────────

  setPendingEdit(channelId, edit) {
    // Clean expired edits
    this._cleanExpiredEdits();

    this._pendingEdits.set(channelId, {
      ...edit,
      createdAt: Date.now(),
      expiresAt: Date.now() + PENDING_EXPIRY_MS,
    });
  }

  getPendingEdit(channelId) {
    this._cleanExpiredEdits();
    const pending = this._pendingEdits.get(channelId);
    if (!pending) return null;
    if (Date.now() > pending.expiresAt) {
      this._pendingEdits.delete(channelId);
      return null;
    }
    return pending;
  }

  consumePendingEdit(channelId) {
    const pending = this.getPendingEdit(channelId);
    if (pending) {
      this._pendingEdits.delete(channelId);
    }
    return pending;
  }

  _cleanExpiredEdits() {
    const now = Date.now();
    for (const [key, edit] of this._pendingEdits) {
      if (now > edit.expiresAt) {
        this._pendingEdits.delete(key);
      }
    }
  }

  // ── Diff Generation ─────────────────────────────────────────────────

  generateDiff(oldCode, newCode, filePath) {
    const oldLines = oldCode.split('\n');
    const newLines = newCode.split('\n');
    const diff = [];
    let changedCount = 0;

    diff.push(`--- a/${filePath}`);
    diff.push(`+++ b/${filePath}`);

    // Simple unified diff — show changed regions with 2 lines of context
    const maxLen = Math.max(oldLines.length, newLines.length);
    let inHunk = false;
    let hunkStart = -1;

    for (let i = 0; i < maxLen; i++) {
      const oldLine = i < oldLines.length ? oldLines[i] : undefined;
      const newLine = i < newLines.length ? newLines[i] : undefined;

      if (oldLine !== newLine) {
        if (!inHunk) {
          // Start new hunk with context
          const ctxStart = Math.max(0, i - 2);
          diff.push(`@@ -${ctxStart + 1} +${ctxStart + 1} @@`);
          for (let c = ctxStart; c < i; c++) {
            if (c < oldLines.length) diff.push(` ${oldLines[c]}`);
          }
          inHunk = true;
          hunkStart = i;
        }

        if (oldLine !== undefined) diff.push(`-${oldLine}`);
        if (newLine !== undefined) diff.push(`+${newLine}`);
        changedCount++;
      } else if (inHunk) {
        // Context after change
        if (oldLine !== undefined) diff.push(` ${oldLine}`);
        if (i - hunkStart > 5 && i < maxLen - 1 && oldLines[i + 1] === newLines[i + 1]) {
          // End hunk if we've had enough context
          inHunk = false;
        }
      }
    }

    return { diff: diff.join('\n'), changedCount };
  }

  // ── Internal Helpers ────────────────────────────────────────────────

  async _ollamaChat(systemPrompt, userPrompt) {
    const stream = await this.ollama.chat({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: true,
      options: {
        temperature: 0.1, // Very low temp for code — deterministic
        num_predict: 8192, // Allow long outputs for full files
      },
    });

    let result = '';
    for await (const part of stream) {
      result += part.message.content;
    }
    return result.trim();
  }

  _prepareFileForPrompt(content, filePath) {
    const lines = content.split('\n');

    if (lines.length <= MAX_FILE_LINES) {
      return content;
    }

    // For very large files: keep first 200 lines, last 100 lines, summarize middle
    const head = lines.slice(0, 200).join('\n');
    const tail = lines.slice(-100).join('\n');
    const middleCount = lines.length - 300;

    return `${head}\n\n// ... [${middleCount} lines omitted for context limit — middle section of ${filePath}] ...\n\n${tail}`;
  }

  _stripCodeBlocks(text) {
    // Remove ```js ... ``` or ``` ... ``` wrappers
    let cleaned = text;

    // Remove leading ```js or ```javascript
    cleaned = cleaned.replace(/^```(?:js|javascript)?\s*\n/, '');
    // Remove trailing ```
    cleaned = cleaned.replace(/\n```\s*$/, '');

    return cleaned.trim();
  }
}

module.exports = new AICoder();
