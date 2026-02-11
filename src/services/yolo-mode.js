/**
 * YOLO Mode — Autonomous Self-Improvement Engine
 *
 * The bot continuously analyzes its own codebase, identifies improvements,
 * generates code changes via AI, and deploys them automatically.
 *
 * Improvement sources:
 *   1. Error log analysis — finds recurring errors, adds missing handlers
 *   2. Reaction feedback — thumbs-down patterns reveal bad responses
 *   3. Code quality scan — identifies files with potential issues
 *   4. Performance hints — spots heavy loops, missing caching, etc.
 *
 * Safety rails:
 *   - Forbidden files list (config, secrets, this file, core infra)
 *   - Max 20 lines changed per commit (github-client enforced)
 *   - Max 2 improvements per cycle, max 5 per day
 *   - 1-hour cooldown per file (no rapid re-edits)
 *   - All changes logged to audit trail + journal
 *   - Owner DM notification for every commit
 *   - Emergency stop halts everything
 *   - Consecutive failure detection pauses YOLO mode
 */

const Storage = require('./storage');
const auditLog = require('./audit-log');
const reactions = require('./reactions');
const stats = require('./stats');
const ai = require('./ai');
const github = require('../github-client');
const selfAwareness = require('./self-awareness');
const config = require('../config');

// ── Constants ───────────────────────────────────────────────────────
const CYCLE_INTERVAL_MS = 30 * 60 * 1000;   // 30 min between cycles
const FILE_COOLDOWN_MS = 60 * 60 * 1000;    // 1 hour cooldown per file
const MAX_IMPROVEMENTS_PER_CYCLE = 2;
const MAX_IMPROVEMENTS_PER_DAY = 5;
const MAX_CONSECUTIVE_FAILURES = 3;          // pause after 3 failures

// Files the engine must NEVER touch
const FORBIDDEN_FILES = [
  '.env', 'config.json', 'package-lock.json', 'package.json',
  'src/config.js', 'src/github-client.js', 'src/ai-coder.js',
  'src/services/yolo-mode.js',  // don't modify yourself
  'src/services/circuit-breaker.js',
  'src/services/audit-log.js',
];

// Files worth scanning for improvements (high-traffic code)
const SCAN_TARGETS = [
  'src/commands/handlers.js',
  'src/services/ai.js',
  'src/services/mahoraga.js',
  'src/services/trading-agents.js',
  'src/services/technicals.js',
  'src/services/gamma.js',
  'src/services/gex-engine.js',
  'src/services/stocktwits.js',
  'src/services/reddit.js',
  'src/services/yahoo.js',
  'src/services/alpaca.js',
  'src/services/options-engine.js',
  'src/services/initiative.js',
  'src/services/autonomous.js',
  'src/services/memory.js',
  'src/services/mood.js',
  'src/tools/price-fetcher.js',
  'src/tools/web-search.js',
  'src/data/market.js',
  'index.js',
];

class YoloMode {
  constructor() {
    this._storage = new Storage('yolo-mode.json');
    this._journal = new Storage('yolo-journal.json');
    this._interval = null;
    this._client = null;
    this._postToChannel = null;
    this._stopped = false;
    this._enabled = this._storage.get('enabled', false);

    // Track file cooldowns: filePath → timestamp
    this._fileCooldowns = new Map();
    const savedCooldowns = this._storage.get('fileCooldowns', {});
    for (const [k, v] of Object.entries(savedCooldowns)) {
      this._fileCooldowns.set(k, v);
    }

    // Daily counter
    this._dailyCount = this._storage.get('dailyCount', 0);
    this._dailyDate = this._storage.get('dailyDate', '');
    this._consecutiveFailures = this._storage.get('consecutiveFailures', 0);

    // History of improvements made
    this._history = this._storage.get('history', []);
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  init(client, postToChannel) {
    this._client = client;
    this._postToChannel = postToChannel;
  }

  start() {
    if (this._interval) return;
    this._stopped = false;

    if (!this._enabled) {
      console.log('[YOLO] Mode is disabled. Use /yolo enable to activate.');
      return;
    }

    if (!github.enabled) {
      console.log('[YOLO] GitHub not configured — cannot start. Set GITHUB_TOKEN.');
      return;
    }

    this._interval = setInterval(() => this._runCycle(), CYCLE_INTERVAL_MS);
    console.log(`[YOLO] Autonomous self-improvement active — cycle every ${CYCLE_INTERVAL_MS / 60000} min`);
    auditLog.log('yolo', 'YOLO mode started');
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._stopped = true;
    console.log('[YOLO] Autonomous self-improvement stopped.');
    auditLog.log('yolo', 'YOLO mode stopped');
  }

  enable() {
    this._enabled = true;
    this._consecutiveFailures = 0;
    this._storage.set('enabled', true);
    this._storage.set('consecutiveFailures', 0);
    this.start();
    auditLog.log('yolo', 'YOLO mode enabled by user');
  }

  disable() {
    this._enabled = false;
    this._storage.set('enabled', false);
    this.stop();
    auditLog.log('yolo', 'YOLO mode disabled by user');
  }

  get enabled() {
    return this._enabled;
  }

  // ── Main Improvement Cycle ──────────────────────────────────────

  async _runCycle() {
    if (this._stopped || !this._enabled) return;

    // Reset daily counter at midnight
    const today = new Date().toISOString().slice(0, 10);
    if (this._dailyDate !== today) {
      this._dailyCount = 0;
      this._dailyDate = today;
      this._storage.set('dailyCount', 0);
      this._storage.set('dailyDate', today);
    }

    // Check daily limit
    if (this._dailyCount >= MAX_IMPROVEMENTS_PER_DAY) {
      console.log('[YOLO] Daily improvement limit reached. Waiting for tomorrow.');
      return;
    }

    // Check consecutive failures (auto-pause)
    if (this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.log('[YOLO] Paused due to consecutive failures. Run /yolo enable to reset.');
      this._enabled = false;
      this._storage.set('enabled', false);
      this.stop();
      this._post('**YOLO Mode Auto-Paused**\nToo many consecutive failures. Use `/yolo enable` to reset and restart.');
      return;
    }

    auditLog.log('yolo', 'Starting improvement cycle');

    try {
      let improvementsMade = 0;

      // Strategy 1: Analyze error patterns from audit log
      if (improvementsMade < MAX_IMPROVEMENTS_PER_CYCLE) {
        const result = await this._tryErrorPatternFix();
        if (result) improvementsMade++;
      }

      // Strategy 2: Scan a random target file for quality issues
      if (improvementsMade < MAX_IMPROVEMENTS_PER_CYCLE) {
        const result = await this._tryCodeQualityScan();
        if (result) improvementsMade++;
      }

      if (improvementsMade > 0) {
        this._consecutiveFailures = 0;
        this._storage.set('consecutiveFailures', 0);
      }

      auditLog.log('yolo', `Cycle complete: ${improvementsMade} improvement(s) applied`);
    } catch (err) {
      console.error('[YOLO] Cycle error:', err.message);
      this._consecutiveFailures++;
      this._storage.set('consecutiveFailures', this._consecutiveFailures);
      auditLog.log('yolo', `Cycle error: ${err.message}`);
    }
  }

  // ── Strategy 1: Error Pattern Analysis ──────────────────────────

  async _tryErrorPatternFix() {
    const recentErrors = auditLog.getRecent(50, 'error');
    if (recentErrors.length < 3) return null; // not enough data

    // Group errors by message pattern
    const patterns = {};
    for (const entry of recentErrors) {
      const msg = (entry.message || '').slice(0, 100);
      const key = msg.replace(/[0-9]+/g, 'N').replace(/\s+/g, ' ').trim();
      if (!patterns[key]) patterns[key] = { count: 0, sample: msg };
      patterns[key].count++;
    }

    // Find the most recurring error pattern
    const sorted = Object.entries(patterns)
      .sort((a, b) => b[1].count - a[1].count);

    if (sorted.length === 0 || sorted[0][1].count < 3) return null;

    const topPattern = sorted[0];
    const errorSample = topPattern[1].sample;

    // Ask AI to identify which file likely causes this error and how to fix it
    const analysisPrompt = `You are analyzing a Discord bot's error logs. The most recurring error pattern is:

"${errorSample}" (occurred ${topPattern[1].count} times recently)

The bot's main source files are in: src/commands/, src/services/, src/tools/, src/data/
Entry point: index.js

Based on this error pattern, which source file MOST LIKELY contains the bug?
Respond with ONLY the file path (e.g. "src/services/ai.js") and nothing else.
If you cannot determine the file, respond with "UNKNOWN".`;

    const fileGuess = await ai.complete(analysisPrompt);
    if (!fileGuess || fileGuess.trim() === 'UNKNOWN') return null;

    const targetFile = fileGuess.trim().replace(/["`']/g, '');

    // Validate the file path
    if (!targetFile.endsWith('.js') || FORBIDDEN_FILES.includes(targetFile)) return null;
    if (!SCAN_TARGETS.some(t => targetFile.includes(t.replace('src/', '')))) return null;
    if (this._isOnCooldown(targetFile)) return null;

    return this._generateAndApplyFix(targetFile,
      `Fix the recurring error: "${errorSample}". Add proper error handling to prevent this error from crashing or disrupting the bot. Fix should be minimal — under 10 lines changed.`,
      'error_pattern'
    );
  }

  // ── Strategy 2: Code Quality Scan ───────────────────────────────

  async _tryCodeQualityScan() {
    // Pick a random file from scan targets that isn't on cooldown
    const available = SCAN_TARGETS.filter(f => !this._isOnCooldown(f) && !FORBIDDEN_FILES.includes(f));
    if (available.length === 0) return null;

    const targetFile = available[Math.floor(Math.random() * available.length)];

    // Fetch the file from GitHub
    const fileData = await github.getFileContent(targetFile);
    if (!fileData) return null;

    const code = fileData.content;

    // Ask AI to find ONE small, safe improvement
    const scanPrompt = `${selfAwareness.buildCompactSelfKnowledge()}

You are reviewing your OWN code. Analyze this file for ONE small, safe improvement.

LOOK FOR (pick exactly ONE):
- Unhandled promise rejection (missing .catch() or try/catch)
- Potential crash from accessing property on null/undefined without check
- Missing input validation that could cause runtime errors
- A console.error that should also include the error object for debugging
- An obvious typo in a string or variable name

DO NOT suggest:
- New features or capabilities
- Refactoring or code style changes
- Adding comments or documentation
- Changing logic that works correctly
- Anything touching config, secrets, or auth
- Changes that affect more than 10 lines of code
- Reformatting, restructuring, or reorganizing existing code

FILE: ${targetFile}
\`\`\`javascript
${code.slice(0, 8000)}
\`\`\`

If you find a genuine improvement, respond in this EXACT format:
ISSUE: <one-line description>
FIX: <one-line description of the fix>
LINES: <approximate number of lines that change>

If the code looks solid and you find NOTHING worth fixing, respond with exactly: NO_ISSUES`;

    const analysis = await ai.complete(scanPrompt);
    if (!analysis || analysis.trim() === 'NO_ISSUES' || !analysis.includes('ISSUE:')) return null;

    // Parse the analysis
    const issueMatch = analysis.match(/ISSUE:\s*(.+)/i);
    const fixMatch = analysis.match(/FIX:\s*(.+)/i);
    const linesMatch = analysis.match(/LINES:\s*(\d+)/i);

    if (!issueMatch || !fixMatch) return null;

    const linesEstimate = linesMatch ? parseInt(linesMatch[1]) : 5;
    if (linesEstimate > 15) return null; // too big

    const instruction = `${issueMatch[1].trim()}. ${fixMatch[1].trim()}. Change ONLY what's necessary — under ${Math.min(linesEstimate + 5, 15)} lines. Output the COMPLETE fixed file.`;

    return this._generateAndApplyFix(targetFile, instruction, 'code_quality');
  }

  // ── Core: Generate fix & apply via GitHub ───────────────────────

  async _generateAndApplyFix(filePath, instruction, source) {
    // Fetch current code
    const fileData = await github.getFileContent(filePath);
    if (!fileData) return null;

    const currentCode = fileData.content;

    // Generate the fix using AI
    const fixPrompt = `You are improving your OWN source code (you are a self-aware Discord trading bot called Sprocket). Apply the following improvement to this file.

INSTRUCTION: ${instruction}

CRITICAL RULES:
- Output the COMPLETE file with your fix applied
- Make a SURGICAL change — touch ONLY the lines needed for this ONE fix
- NEVER reformat, restyle, reorganize, or restructure any other code
- NEVER change whitespace, indentation, or line breaks on lines you aren't fixing
- NEVER add comments, documentation, or logging unrelated to the fix
- NEVER add new features or refactor existing working code
- The file should be IDENTICAL to the original except for your specific fix (aim for under 10 lines different)
- Do NOT add any API keys, tokens, or secrets
- Output ONLY the fixed code, no explanations or markdown fences

FILE: ${filePath}
${currentCode}`;

    const fixedCode = await ai.complete(fixPrompt);
    if (!fixedCode || !fixedCode.trim()) return null;

    // Clean up AI output (strip markdown fences if present)
    let newCode = fixedCode.trim();
    if (newCode.startsWith('```')) {
      newCode = newCode.replace(/^```(?:javascript|js)?\n?/, '').replace(/\n?```$/, '');
    }

    // Safety checks
    const safety = github.isChangeSafe(filePath, newCode, currentCode);
    if (!safety.safe) {
      console.log(`[YOLO] Safety blocked for ${filePath}: ${safety.reason}`);
      this._addJournal('blocked', filePath, `Safety check failed: ${safety.reason}`, source);
      return null;
    }

    const linesChanged = github.diffLines(currentCode, newCode);
    if (linesChanged === 0) {
      console.log(`[YOLO] No actual changes for ${filePath}`);
      return null;
    }
    if (linesChanged > 20) {
      console.log(`[YOLO] Too many lines changed (${linesChanged}) for ${filePath}`);
      this._addJournal('blocked', filePath, `Change too large: ${linesChanged} lines`, source);
      return null;
    }

    // Extra safety: no secrets in new code
    const secretPatterns = ['GITHUB_TOKEN', 'DISCORD_TOKEN', 'apiKey', 'api_key', 'secret', 'password'];
    for (const pattern of secretPatterns) {
      // Only flag if the pattern is NEW (not in original code)
      if (newCode.includes(pattern) && !currentCode.includes(pattern)) {
        console.log(`[YOLO] Blocked: new code contains "${pattern}"`);
        this._addJournal('blocked', filePath, `Secret pattern detected: ${pattern}`, source);
        return null;
      }
    }

    // Commit the change
    const commitMsg = `YOLO: ${instruction.slice(0, 70)}`;
    const result = await github.updateFile(filePath, newCode, commitMsg);

    if (result.success) {
      this._dailyCount++;
      this._storage.set('dailyCount', this._dailyCount);
      this._recordCooldown(filePath);

      const entry = {
        timestamp: Date.now(),
        file: filePath,
        source,
        instruction: instruction.slice(0, 200),
        linesChanged,
        commitUrl: result.url || null,
      };
      this._history.push(entry);
      if (this._history.length > 50) this._history.shift();
      this._storage.set('history', this._history);

      this._addJournal('improvement', filePath, `${instruction.slice(0, 150)} (${linesChanged} lines)`, source);
      auditLog.log('yolo', `Improvement applied: ${filePath} (${linesChanged} lines, source: ${source})`);

      // Notify via Discord
      this._post(
        `**YOLO Self-Improvement**\n` +
        `Applied to \`${filePath}\` (${linesChanged} lines changed)\n` +
        `**What:** ${instruction.slice(0, 150)}\n` +
        `**Source:** ${source.replace('_', ' ')}\n` +
        `${result.url ? result.url : ''}\n` +
        `_Improvements today: ${this._dailyCount}/${MAX_IMPROVEMENTS_PER_DAY}_`
      );

      console.log(`[YOLO] Improvement committed: ${filePath} (${linesChanged} lines)`);
      return entry;
    } else {
      console.error(`[YOLO] Commit failed for ${filePath}:`, result.error);
      this._consecutiveFailures++;
      this._storage.set('consecutiveFailures', this._consecutiveFailures);
      this._addJournal('failed', filePath, `Commit failed: ${result.error}`, source);
      return null;
    }
  }

  // ── Cooldown Management ─────────────────────────────────────────

  _isOnCooldown(filePath) {
    const last = this._fileCooldowns.get(filePath) || 0;
    return (Date.now() - last) < FILE_COOLDOWN_MS;
  }

  _recordCooldown(filePath) {
    this._fileCooldowns.set(filePath, Date.now());
    // Persist cooldowns
    const obj = {};
    for (const [k, v] of this._fileCooldowns) obj[k] = v;
    this._storage.set('fileCooldowns', obj);
  }

  // ── Journal ─────────────────────────────────────────────────────

  _addJournal(type, file, content, source) {
    const entries = this._journal.get('entries', []);
    entries.push({
      timestamp: Date.now(),
      type,
      file,
      content,
      source,
    });
    // Keep last 100 entries
    if (entries.length > 100) entries.splice(0, entries.length - 100);
    this._journal.set('entries', entries);
  }

  getJournal(count = 20) {
    const entries = this._journal.get('entries', []);
    return entries.slice(-count);
  }

  // ── Status & History ────────────────────────────────────────────

  getStatus() {
    const today = new Date().toISOString().slice(0, 10);
    return {
      enabled: this._enabled,
      running: !!this._interval,
      dailyCount: this._dailyDate === today ? this._dailyCount : 0,
      dailyLimit: MAX_IMPROVEMENTS_PER_DAY,
      consecutiveFailures: this._consecutiveFailures,
      failureThreshold: MAX_CONSECUTIVE_FAILURES,
      cycleIntervalMin: CYCLE_INTERVAL_MS / 60000,
      totalImprovements: this._history.length,
      githubEnabled: github.enabled,
    };
  }

  getHistory(count = 10) {
    return this._history.slice(-count);
  }

  // ── Discord Posting ─────────────────────────────────────────────

  _post(content) {
    if (this._postToChannel) {
      this._postToChannel(content).catch(err => {
        console.error('[YOLO] Post failed:', err.message);
      });
    }
  }

  // ── Manual Trigger ──────────────────────────────────────────────

  async runNow() {
    if (!github.enabled) {
      return { success: false, message: 'GitHub not configured. Set GITHUB_TOKEN.' };
    }
    try {
      await this._runCycle();
      return { success: true, message: 'YOLO cycle completed.' };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }
}

module.exports = new YoloMode();
