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

  // Update a file on a specific branch (creates a commit)
  async updateFile(filePath, newContent, commitMessage, branch) {
    const targetBranch = branch || config.githubBranch;
    const octokit = await this._getOctokit();
    if (!octokit) return { success: false, error: 'GitHub client not available' };

    try {
      // Get the file's current SHA from the target branch
      const currentFile = await octokit.repos.getContent({
        owner: config.githubOwner,
        repo: config.githubRepo,
        path: filePath,
        ref: targetBranch,
      });

      const response = await octokit.repos.createOrUpdateFileContents({
        owner: config.githubOwner,
        repo: config.githubRepo,
        path: filePath,
        message: commitMessage,
        content: Buffer.from(newContent).toString('base64'),
        sha: currentFile.data.sha,
        branch: targetBranch,
      });

      console.log(`[GitHub] File ${filePath} updated on ${targetBranch}.`);
      return { success: true, url: response.data.commit.html_url };
    } catch (error) {
      console.error(`[GitHub] Failed to update file ${filePath}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  // Create a new branch from the base branch (e.g. main)
  async createBranch(branchName) {
    const octokit = await this._getOctokit();
    if (!octokit) return { success: false, error: 'GitHub client not available' };

    try {
      // Get the SHA of the base branch head
      const { data: ref } = await octokit.git.getRef({
        owner: config.githubOwner,
        repo: config.githubRepo,
        ref: `heads/${config.githubBranch}`,
      });

      // Create the new branch pointing at the same SHA
      await octokit.git.createRef({
        owner: config.githubOwner,
        repo: config.githubRepo,
        ref: `refs/heads/${branchName}`,
        sha: ref.object.sha,
      });

      console.log(`[GitHub] Branch "${branchName}" created from ${config.githubBranch}.`);
      return { success: true };
    } catch (error) {
      // 422 = branch already exists, which is fine
      if (error.status === 422) {
        console.log(`[GitHub] Branch "${branchName}" already exists.`);
        return { success: true, existed: true };
      }
      console.error(`[GitHub] Failed to create branch "${branchName}":`, error.message);
      return { success: false, error: error.message };
    }
  }

  // Create a pull request from a branch into the base branch
  async createPullRequest(branchName, title, body) {
    const octokit = await this._getOctokit();
    if (!octokit) return { success: false, error: 'GitHub client not available' };

    try {
      const { data: pr } = await octokit.pulls.create({
        owner: config.githubOwner,
        repo: config.githubRepo,
        head: branchName,
        base: config.githubBranch,
        title,
        body,
      });

      console.log(`[GitHub] PR #${pr.number} created: ${pr.html_url}`);
      return { success: true, url: pr.html_url, number: pr.number };
    } catch (error) {
      console.error(`[GitHub] Failed to create PR:`, error.message);
      return { success: false, error: error.message };
    }
  }

  // Find an existing open PR from a branch
  async findOpenPR(branchName) {
    const octokit = await this._getOctokit();
    if (!octokit) return null;

    try {
      const { data: prs } = await octokit.pulls.list({
        owner: config.githubOwner,
        repo: config.githubRepo,
        head: `${config.githubOwner}:${branchName}`,
        base: config.githubBranch,
        state: 'open',
      });
      return prs.length > 0 ? prs[0] : null;
    } catch (error) {
      console.error(`[GitHub] Failed to find PR for ${branchName}:`, error.message);
      return null;
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
    let prev = new Uint16Array(n + 1).fill(0);
    let curr = new Uint16Array(n + 1).fill(0);

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
    return (m - lcsLength) + (n - lcsLength);
  }
}

module.exports = new GitHubClient();