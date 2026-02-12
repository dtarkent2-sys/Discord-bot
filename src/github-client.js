const config = require('./config');

class GitHubClient {
  constructor() {
    this._octokit = null;
    this._initFailed = false;

    if (!config.githubToken) {
      console.warn('[GitHub] GITHUB_TOKEN not set — self-edit commands will be disabled.');
      this._initFailed = true;
    }
  }

  // Lazy-load Octokit (ESM-only package)
  async _getOctokit() {
    if (this._octokit) return this._octokit;
    if (this._initFailed) return null;

    try {
      const { Octokit } = await import('@octokit/rest');
      this._octokit = new Octokit({ auth: config.githubToken });
      return this._octokit;
    } catch (err) {
      console.error('[GitHub] Failed to load Octokit:', err.message);
      this._initFailed = true;
      return null;
    }
  }

  get enabled() {
    return !!config.githubToken && !this._initFailed;
  }

  // Get current file content from the repo
  async getFileContent(filePath) {
    const octokit = await this._getOctokit();
    if (!octokit) return null;

    try {
      const response = await octokit.repos.getContent({
        owner: config.githubOwner,
        repo: config.githubRepo,
        path: filePath,
        ref: config.githubBranch,
      });
      return {
        content: Buffer.from(response.data.content, 'base64').toString(),
        sha: response.data.sha,
      };
    } catch (error) {
      console.error(`[GitHub] Failed to get file ${filePath}:`, error.message);
      return null;
    }
  }

  // Update a file (creates a commit)
  // GUARD: Automated commits (YOLO, SELF-HEAL) are blocked from the default branch.
  // Use updateFileOnBranch() for automated changes.
  async updateFile(filePath, newContent, commitMessage) {
    // Hard block: never let automated commits land on main/default branch
    const autoPatterns = ['YOLO:', 'SELF-HEAL:', 'AUTO:'];
    const isAutomated = autoPatterns.some(p => commitMessage.startsWith(p) || commitMessage.startsWith(`🔧 ${p}`));
    if (isAutomated) {
      console.error(`[GitHub] BLOCKED: Automated commit "${commitMessage.slice(0, 60)}" tried to push to ${config.githubBranch}. Use updateFileOnBranch() instead.`);
      return { success: false, error: `Automated commits to ${config.githubBranch} are blocked. Route through a branch.` };
    }

    const octokit = await this._getOctokit();
    if (!octokit) return { success: false, error: 'GitHub client not available' };

    try {
      // Get the file's current SHA (required by GitHub API)
      const currentFile = await octokit.repos.getContent({
        owner: config.githubOwner,
        repo: config.githubRepo,
        path: filePath,
        ref: config.githubBranch,
      });

      const response = await octokit.repos.createOrUpdateFileContents({
        owner: config.githubOwner,
        repo: config.githubRepo,
        path: filePath,
        message: commitMessage,
        content: Buffer.from(newContent).toString('base64'),
        sha: currentFile.data.sha,
        branch: config.githubBranch,
      });

      console.log(`[GitHub] File ${filePath} updated successfully.`);
      return { success: true, url: response.data.commit.html_url };
    } catch (error) {
      console.error(`[GitHub] Failed to update file ${filePath}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  // List all files in the repo (recursive), filtered by extension
  async listFiles(extension = '.js') {
    const octokit = await this._getOctokit();
    if (!octokit) return [];

    try {
      const { data } = await octokit.git.getTree({
        owner: config.githubOwner,
        repo: config.githubRepo,
        tree_sha: config.githubBranch || 'main',
        recursive: 'true',
      });
      return (data.tree || [])
        .filter(item => item.type === 'blob' && item.path.endsWith(extension))
        .map(item => item.path);
    } catch (err) {
      console.error(`[GitHub] listFiles error: ${err.message}`);
      return [];
    }
  }

  // ── Branch Management (for YOLO sandboxing) ──────────────────

  /**
   * Ensure a branch exists. Creates it from the base branch if it doesn't.
   * Returns the branch name on success, null on failure.
   */
  async ensureBranch(branchName, baseBranch) {
    const octokit = await this._getOctokit();
    if (!octokit) return null;

    baseBranch = baseBranch || config.githubBranch || 'main';

    try {
      // Check if branch already exists
      await octokit.git.getRef({
        owner: config.githubOwner,
        repo: config.githubRepo,
        ref: `heads/${branchName}`,
      });
      return branchName; // already exists
    } catch (err) {
      if (err.status !== 404) {
        console.error(`[GitHub] Error checking branch ${branchName}:`, err.message);
        return null;
      }
    }

    try {
      // Get the SHA of the base branch
      const { data: baseRef } = await octokit.git.getRef({
        owner: config.githubOwner,
        repo: config.githubRepo,
        ref: `heads/${baseBranch}`,
      });

      // Create the new branch
      await octokit.git.createRef({
        owner: config.githubOwner,
        repo: config.githubRepo,
        ref: `refs/heads/${branchName}`,
        sha: baseRef.object.sha,
      });

      console.log(`[GitHub] Created branch ${branchName} from ${baseBranch}`);
      return branchName;
    } catch (err) {
      console.error(`[GitHub] Failed to create branch ${branchName}:`, err.message);
      return null;
    }
  }

  /**
   * Commit a file change to a specific branch (not the default branch).
   */
  async updateFileOnBranch(filePath, newContent, commitMessage, branch) {
    const octokit = await this._getOctokit();
    if (!octokit) return { success: false, error: 'GitHub client not available' };

    try {
      // Get the file's current SHA on the target branch
      const currentFile = await octokit.repos.getContent({
        owner: config.githubOwner,
        repo: config.githubRepo,
        path: filePath,
        ref: branch,
      });

      const response = await octokit.repos.createOrUpdateFileContents({
        owner: config.githubOwner,
        repo: config.githubRepo,
        path: filePath,
        message: commitMessage,
        content: Buffer.from(newContent).toString('base64'),
        sha: currentFile.data.sha,
        branch,
      });

      console.log(`[GitHub] File ${filePath} updated on branch ${branch}.`);
      return { success: true, url: response.data.commit.html_url };
    } catch (error) {
      console.error(`[GitHub] Failed to update ${filePath} on ${branch}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Create a pull request, or return the existing open PR for this branch.
   */
  async ensurePullRequest(branchName, title, body) {
    const octokit = await this._getOctokit();
    if (!octokit) return null;

    const baseBranch = config.githubBranch || 'main';

    try {
      // Check for existing open PR from this branch
      const { data: existing } = await octokit.pulls.list({
        owner: config.githubOwner,
        repo: config.githubRepo,
        head: `${config.githubOwner}:${branchName}`,
        base: baseBranch,
        state: 'open',
      });

      if (existing.length > 0) {
        return { url: existing[0].html_url, number: existing[0].number, created: false };
      }

      // Create new PR
      const { data: pr } = await octokit.pulls.create({
        owner: config.githubOwner,
        repo: config.githubRepo,
        title,
        body,
        head: branchName,
        base: baseBranch,
      });

      console.log(`[GitHub] Created PR #${pr.number}: ${title}`);
      return { url: pr.html_url, number: pr.number, created: true };
    } catch (err) {
      console.error(`[GitHub] Failed to create/find PR for ${branchName}:`, err.message);
      return null;
    }
  }

  // Safety check: is this change safe for auto-edit?
  isChangeSafe(filePath, newContent, currentContent) {
    // Rule 1: Never touch files with secrets or core infra
    const forbiddenFiles = ['.env', 'config.json', 'package-lock.json'];
    if (forbiddenFiles.some(f => filePath.includes(f))) {
      return { safe: false, reason: 'File is forbidden for auto-edit.' };
    }

    // Rule 2: Only allow certain file types
    const allowedExtensions = ['.js', '.json', '.md', '.txt'];
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    if (!allowedExtensions.includes(ext)) {
      return { safe: false, reason: `File type "${ext}" not allowed for auto-edit.` };
    }

    return { safe: true };
  }

  // Public alias for self-heal module
  diffLines(oldText, newText) {
    return this._diffLineCount(oldText, newText);
  }

  // Simple line difference counter
  _diffLineCount(oldText, newText) {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    // Use LCS (Longest Common Subsequence) to count actual insertions/deletions/changes.
    // The naive positional comparison breaks when a single line is added/removed,
    // causing every subsequent line to look "changed."
    const m = oldLines.length;
    const n = newLines.length;

    // For very large files, use a space-optimized LCS (two-row DP)
    let prev = new Uint16Array(n + 1);
    let curr = new Uint16Array(n + 1);

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (oldLines[i - 1] === newLines[j - 1]) {
          curr[j] = prev[j - 1] + 1;
        } else {
          curr[j] = Math.max(prev[j], curr[j - 1]);
        }
      }
      // Swap rows
      [prev, curr] = [curr, prev];
      curr.fill(0);
    }

    const lcsLength = prev[n];
    // Lines changed = lines removed + lines added
    // removed = old lines not in LCS, added = new lines not in LCS
    return (m - lcsLength) + (n - lcsLength);
  }
}

module.exports = new GitHubClient();
