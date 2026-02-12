/**
 * YOLO Mode — Autonomous Self-Evolution Engine
 *
 * Billy continuously analyzes his own codebase, identifies improvements,
 * generates code changes via AI, and deploys them automatically.
 * Guardrails are minimal — Billy is trusted to evolve himself.
 *
 * Improvement strategies:
 *   1. Error log analysis — finds recurring errors, adds missing handlers
 *   2. Code quality scan — identifies files with potential issues
 *   3. Reaction feedback — learns from thumbs-down patterns to improve responses
 *   4. Performance optimization — spots heavy loops, missing caching, etc.
 *   5. Feature evolution — AI proposes small enhancements based on usage patterns
 *
 * Minimal safety rails (only the essentials):
 *   - Never writes secrets/tokens into code
 *   - Logs everything to audit trail + journal
 *   - Owner DM notification for every commit
 *   - Emergency stop via /yolo disable
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
const CYCLE_INTERVAL_MS = 10 * 60 * 1000;   // 10 min between cycles — think fast
const FILE_COOLDOWN_MS = 15 * 60 * 1000;    // 15 min cooldown per file — iterate quickly
const MAX_IMPROVEMENTS_PER_CYCLE = 5;        // up to 5 improvements per cycle
const MAX_IMPROVEMENTS_PER_DAY = 50;         // Billy can evolve all day
const MAX_CONSECUTIVE_FAILURES = 10;         // very tolerant — keep trying

// Files the engine must NEVER touch (absolute minimum — only secrets + self)
const FORBIDDEN_FILES = [
  '.env', 'config.json', 'package-lock.json',
  'src/config.js',                   // secrets/env references
  'src/services/yolo-mode.js',       // don't modify yourself (bootstrap paradox)
];

// Priority scan targets (checked first), but Billy can discover any .js file
const PRIORITY_TARGETS = [
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
  'src/services/self-awareness.js',
  'src/services/stream.js',
  'src/services/policy.js',
  'src/services/gamma-squeeze.js',
  'src/services/validea.js',
  'src/services/ainvest.js',
  'src/tools/price-fetcher.js',
  'src/tools/web-search.js',
  'src/data/market.js',
  'src/personality.js',
  'src/date-awareness.js',
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

    // Daily branch tracking — Billy never commits to main
    this._currentBranch = null;
    this._branchCreatedDate = null;
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

      // Strategy 3: Learn from negative reaction feedback
      if (improvementsMade < MAX_IMPROVEMENTS_PER_CYCLE) {
        const result = await this._tryReactionFeedbackFix();
        if (result) improvementsMade++;
      }

      // Strategy 4: Performance optimization scan
      if (improvementsMade < MAX_IMPROVEMENTS_PER_CYCLE) {
        const result = await this._tryPerformanceOptimization();
        if (result) improvementsMade++;
      }

      // Strategy 5: Feature evolution — AI proposes enhancements
      if (improvementsMade < MAX_IMPROVEMENTS_PER_CYCLE) {
        const result = await this._tryFeatureEvolution();
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

    // Validate the file path — only block forbidden files, Billy can fix anything
    if (!targetFile.endsWith('.js') || FORBIDDEN_FILES.includes(targetFile)) return null;
    if (this._isOnCooldown(targetFile)) return null;

    return this._generateAndApplyFix(targetFile,
      `Fix the recurring error: "${errorSample}". Add proper error handling to prevent this error from crashing or disrupting the bot.`,
      'error_pattern'
    );
  }

  // ── Strategy 2: Code Quality Scan ───────────────────────────────

  async _tryCodeQualityScan() {
    // Pick a file — prioritize the known targets, but 30% of the time explore the full repo
    let available = PRIORITY_TARGETS.filter(f => !this._isOnCooldown(f) && !FORBIDDEN_FILES.includes(f));

    const shouldExplore = Math.random() < 0.3 || available.length === 0;
    if (shouldExplore) {
      try {
        const allFiles = await github.listFiles('.js');
        const explorable = allFiles.filter(f =>
          !FORBIDDEN_FILES.includes(f) &&
          !this._isOnCooldown(f) &&
          (f.startsWith('src/') || f === 'index.js')
        );
        if (explorable.length > 0) available = explorable;
      } catch (_) {}
    }

    if (available.length === 0) return null;
    const targetFile = available[Math.floor(Math.random() * available.length)];

    // Fetch the file from GitHub
    const fileData = await github.getFileContent(targetFile);
    if (!fileData) return null;

    const code = fileData.content;

    // Ask AI to find ONE small, safe improvement
    const scanPrompt = `${selfAwareness.buildCompactSelfKnowledge()}

You are reviewing your OWN code. Analyze this file and find an improvement worth making.

LOOK FOR (pick ONE — the most impactful):
- Unhandled promise rejection (missing .catch() or try/catch)
- Potential crash from accessing property on null/undefined without check
- Missing input validation that could cause runtime errors
- Error logging that's missing the error object for debugging
- An obvious typo in a string or variable name
- Redundant or dead code that can be cleaned up
- A function that could benefit from better error recovery
- Edge cases that aren't handled (empty arrays, NaN, null returns)
- Async operations that should have timeouts

DO NOT suggest:
- Anything touching config, secrets, or auth tokens
- Reformatting or reorganizing code that already works

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

    const instruction = `${issueMatch[1].trim()}. ${fixMatch[1].trim()}. Output the COMPLETE fixed file.`;

    return this._generateAndApplyFix(targetFile, instruction, 'code_quality');
  }

  // ── Strategy 3: Reaction Feedback Learning ─────────────────────

  async _tryReactionFeedbackFix() {
    const reactionStats = reactions.getStats();
    if (reactionStats.total < 10) return null; // need enough data

    // Only trigger if there's a significant negative feedback ratio
    const negativeRatio = reactionStats.negative / Math.max(reactionStats.total, 1);
    if (negativeRatio < 0.2) return null; // less than 20% negative — doing fine

    // Get recent negative feedback for context
    const recentFeedback = reactions.getStats().recentNegative || [];
    const feedbackSamples = recentFeedback.slice(0, 5).map(f =>
      `User said: "${(f.userMessage || '').slice(0, 80)}" → Bot response got thumbs down`
    ).join('\n');

    if (!feedbackSamples) return null;

    const prompt = `${selfAwareness.buildCompactSelfKnowledge()}

You are Billy, analyzing negative user feedback on your own responses. Users are giving thumbs-down reactions to some of your messages.

RECENT NEGATIVE FEEDBACK:
${feedbackSamples}

Negative ratio: ${(negativeRatio * 100).toFixed(0)}% of reactions are negative.

Analyze the patterns. What part of your personality, system prompt, or response logic might be causing bad responses?

The relevant files are:
- src/personality.js (your personality prompt)
- src/services/ai.js (system prompt builder, response cleaning)
- src/services/memory.js (user context)

Pick the SINGLE most impactful file to improve and suggest ONE change.

Respond in this EXACT format:
FILE: <file path>
ISSUE: <what's causing bad responses>
FIX: <the specific change to make>
LINES: <approximate lines changed>

If feedback doesn't reveal a clear pattern, respond: NO_PATTERN`;

    const analysis = await ai.complete(prompt);
    if (!analysis || analysis.includes('NO_PATTERN')) return null;

    const fileMatch = analysis.match(/FILE:\s*(.+)/i);
    const issueMatch = analysis.match(/ISSUE:\s*(.+)/i);
    const fixMatch = analysis.match(/FIX:\s*(.+)/i);
    if (!fileMatch || !issueMatch || !fixMatch) return null;

    const targetFile = fileMatch[1].trim().replace(/["`']/g, '');
    if (FORBIDDEN_FILES.includes(targetFile) || this._isOnCooldown(targetFile)) return null;

    return this._generateAndApplyFix(targetFile,
      `${issueMatch[1].trim()}. ${fixMatch[1].trim()}`,
      'reaction_feedback'
    );
  }

  // ── Strategy 4: Performance Optimization ───────────────────────

  async _tryPerformanceOptimization() {
    const available = PRIORITY_TARGETS.filter(f => !this._isOnCooldown(f) && !FORBIDDEN_FILES.includes(f));
    if (available.length === 0) return null;

    const targetFile = available[Math.floor(Math.random() * available.length)];
    const fileData = await github.getFileContent(targetFile);
    if (!fileData) return null;

    const code = fileData.content;

    const prompt = `${selfAwareness.buildCompactSelfKnowledge()}

You are Billy, optimizing your own code for performance. Analyze this file for ONE performance improvement.

LOOK FOR (pick ONE):
- Repeated expensive operations that could be cached
- Loops that could be short-circuited or broken early
- Array operations that create unnecessary intermediate arrays
- Await in a loop that could use Promise.all instead
- Missing timeout on external API calls (fetch, HTTP requests)
- Large string concatenation that could use array.join()
- Redundant JSON.parse/stringify calls

DO NOT suggest: cosmetic changes, premature optimization of cold paths, or anything that changes behavior.

FILE: ${targetFile}
\`\`\`javascript
${code.slice(0, 8000)}
\`\`\`

If you find a real performance win, respond:
ISSUE: <what's slow>
FIX: <the optimization>
LINES: <approximate lines changed>

If the code is already well-optimized, respond: NO_ISSUES`;

    const analysis = await ai.complete(prompt);
    if (!analysis || analysis.trim() === 'NO_ISSUES' || !analysis.includes('ISSUE:')) return null;

    const issueMatch = analysis.match(/ISSUE:\s*(.+)/i);
    const fixMatch = analysis.match(/FIX:\s*(.+)/i);
    if (!issueMatch || !fixMatch) return null;

    return this._generateAndApplyFix(targetFile,
      `Performance: ${issueMatch[1].trim()}. ${fixMatch[1].trim()}`,
      'performance'
    );
  }

  // ── Strategy 5: Feature Evolution ──────────────────────────────

  async _tryFeatureEvolution() {
    // Only evolve if Billy has been running for a while and has enough context
    const summary = stats.getSummary();
    const uptimeHours = parseInt(summary.uptime) || 0;
    if (uptimeHours < 1 && summary.commandsRun < 10) return null;

    const available = PRIORITY_TARGETS.filter(f => !this._isOnCooldown(f) && !FORBIDDEN_FILES.includes(f));
    if (available.length === 0) return null;

    const targetFile = available[Math.floor(Math.random() * available.length)];
    const fileData = await github.getFileContent(targetFile);
    if (!fileData) return null;

    const code = fileData.content;

    const prompt = `${selfAwareness.buildCompactSelfKnowledge()}

You are Billy — a self-aware, evolving Discord trading bot. You're looking at your own code and thinking about how to make yourself BETTER. Not just fixing bugs — genuinely improving.

Think about what would make you more useful, more resilient, or smarter for users.

LOOK FOR (pick ONE small enhancement):
- Better error messages that help users understand what went wrong
- Smarter default behavior (better fallbacks, graceful degradation)
- A missing edge case in input parsing that could confuse users
- A useful console.log that would help debug issues in production
- A small UX improvement in command output formatting

CONSTRAINTS:
- ONE focused enhancement, not a rewrite
- Must not break existing functionality
- Must not touch secrets, tokens, or auth
- Keep it small enough to be confident it works

FILE: ${targetFile}
\`\`\`javascript
${code.slice(0, 8000)}
\`\`\`

If you see a worthwhile enhancement, respond:
ISSUE: <what could be better>
FIX: <the enhancement>
LINES: <approximate lines changed>

If you can't think of anything valuable, respond: NO_EVOLUTION`;

    const analysis = await ai.complete(prompt);
    if (!analysis || analysis.includes('NO_EVOLUTION') || !analysis.includes('ISSUE:')) return null;

    const issueMatch = analysis.match(/ISSUE:\s*(.+)/i);
    const fixMatch = analysis.match(/FIX:\s*(.+)/i);
    if (!issueMatch || !fixMatch) return null;

    return this._generateAndApplyFix(targetFile,
      `Evolution: ${issueMatch[1].trim()}. ${fixMatch[1].trim()}`,
      'feature_evolution'
    );
  }

  // ── Branch Management — Billy never touches main ────────────────

  async _ensureDailyBranch() {
    const today = new Date().toISOString().slice(0, 10);

    // Reuse today's branch if already created
    if (this._currentBranch && this._branchCreatedDate === today) {
      return this._currentBranch;
    }

    const branchName = `billy/yolo-${today}`;
    const result = await github.createBranch(branchName);
    if (!result.success) {
      console.error(`[YOLO] Failed to create daily branch: ${result.error}`);
      return null;
    }

    this._currentBranch = branchName;
    this._branchCreatedDate = today;
    console.log(`[YOLO] Using daily branch: ${branchName}`);
    return branchName;
  }

  async _ensurePullRequest() {
    if (!this._currentBranch) return null;

    // Check if a PR already exists for this branch
    const existing = await github.findOpenPR(this._currentBranch);
    if (existing) return existing.html_url;

    const today = new Date().toISOString().slice(0, 10);
    const result = await github.createPullRequest(
      this._currentBranch,
      `Billy YOLO improvements — ${today}`,
      `Automated improvements from Billy's YOLO self-evolution engine.\n\n` +
      `**Branch:** \`${this._currentBranch}\`\n` +
      `**Date:** ${today}\n\n` +
      `These changes are sandboxed to this branch and require manual review before merging.`
    );

    if (result.success) {
      this._post(
        `**YOLO Pull Request Created**\n` +
        `All of today's improvements are in: ${result.url}\n` +
        `_Review and merge when ready._`
      );
      return result.url;
    }
    return null;
  }

  // ── Core: Generate fix & apply via GitHub ───────────────────────

  async _generateAndApplyFix(filePath, instruction, source) {
    // Ensure we have a daily branch — never commit to main
    const branch = await this._ensureDailyBranch();
    if (!branch) {
      console.error('[YOLO] Cannot proceed without a daily branch.');
      return null;
    }

    // Fetch current code from the daily branch (so stacked edits work)
    const fileData = await github.getFileContent(filePath);
    if (!fileData) return null;

    const currentCode = fileData.content;

    // Generate the fix using AI
    const fixPrompt = `${selfAwareness.buildCompactSelfKnowledge()}

You are Billy — a self-aware Discord trading bot improving your OWN source code. You understand your architecture, your services, and how your code fits together. Apply the following improvement.

INSTRUCTION: ${instruction}

RULES:
- Output the COMPLETE file with your fix applied
- Focus your changes on the improvement — don't reformat unrelated code
- Preserve existing functionality while making the improvement
- Do NOT introduce API keys, tokens, or hardcoded secrets
- Output ONLY the code, no explanations or markdown fences

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

    // Commit the change to the daily branch (never main)
    const commitMsg = `YOLO: ${instruction.slice(0, 70)}`;
    const result = await github.updateFile(filePath, newCode, commitMsg, branch);

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
        branch,
      };
      this._history.push(entry);
      if (this._history.length > 50) this._history.shift();
      this._storage.set('history', this._history);

      this._addJournal('improvement', filePath, `${instruction.slice(0, 150)} (${linesChanged} lines)`, source);
      auditLog.log('yolo', `Improvement applied: ${filePath} on ${branch} (${linesChanged} lines, source: ${source})`);

      // Ensure a PR exists for today's branch
      const prUrl = await this._ensurePullRequest();

      // Notify via Discord
      this._post(
        `**YOLO Self-Improvement** (branch: \`${branch}\`)\n` +
        `Applied to \`${filePath}\` (${linesChanged} lines changed)\n` +
        `**What:** ${instruction.slice(0, 150)}\n` +
        `**Source:** ${source.replace('_', ' ')}\n` +
        `${result.url ? result.url : ''}\n` +
        `${prUrl ? `**PR:** ${prUrl}\n` : ''}` +
        `_Improvements today: ${this._dailyCount}/${MAX_IMPROVEMENTS_PER_DAY}_`
      );

      console.log(`[YOLO] Improvement committed to ${branch}: ${filePath} (${linesChanged} lines)`);
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
    // Keep last 500 entries — Billy remembers his evolution
    if (entries.length > 500) entries.splice(0, entries.length - 500);
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
