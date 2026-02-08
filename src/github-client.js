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
  async updateFile(filePath, newContent, commitMessage) {
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

  // Safety check: is this change safe for auto-edit?
  isChangeSafe(filePath, newContent, currentContent) {
    // Rule 1: Never touch files with secrets or core infra
    const forbiddenFiles = ['.env', 'config.json', 'github-client.js', 'ai-coder.js', 'package-lock.json'];
    if (forbiddenFiles.some(f => filePath.includes(f))) {
      return { safe: false, reason: 'File is forbidden for auto-edit.' };
    }

    // Rule 2: Only allow certain file types
    const allowedExtensions = ['.js', '.json', '.md', '.txt'];
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    if (!allowedExtensions.includes(ext)) {
      return { safe: false, reason: `File type "${ext}" not allowed for auto-edit.` };
    }

    // Rule 3: Reject large changes
    const linesChanged = this._diffLineCount(currentContent, newContent);
    if (linesChanged > 20) {
      return { safe: false, reason: `Change too large (${linesChanged} lines changed). Requires manual review.` };
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
    let diff = 0;
    for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
      if (oldLines[i] !== newLines[i]) diff++;
    }
    return diff;
  }
}

module.exports = new GitHubClient();
