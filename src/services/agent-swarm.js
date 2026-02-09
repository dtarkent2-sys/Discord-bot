/**
 * Agent Swarm — Parallel multi-agent research pipeline.
 *
 * Takes a complex query, decomposes it into parallel sub-tasks,
 * runs independent research agents (each with web search), then
 * synthesizes everything into a single coherent response.
 *
 * Pipeline:
 *   1. Coordinator decomposes query → 2-6 sub-tasks
 *   2. Agents run in parallel (each can web-search independently)
 *   3. Synthesizer merges all findings into a final answer
 *
 * Uses Kimi API with $web_search when available, falls back to Ollama + SearXNG.
 */

const { Ollama } = require('ollama');
const config = require('../config');
const { webSearch, formatResultsForAI } = require('../tools/web-search');

const KIMI_TOOLS = [
  { type: 'builtin_function', function: { name: '$web_search' } },
];

class AgentSwarm {
  constructor() {
    this.kimiEnabled = !!config.kimiApiKey;

    // Ollama fallback
    const opts = { host: config.ollamaHost };
    if (config.ollamaApiKey) {
      opts.headers = { Authorization: `Bearer ${config.ollamaApiKey}` };
    }
    this.ollama = new Ollama(opts);
    this.model = config.ollamaModel;
  }

  /**
   * Run a full agent swarm research query.
   * @param {string} query — the user's research question
   * @param {function} [onProgress] — optional callback(message) for live status updates
   * @returns {string} — synthesized markdown response
   */
  async research(query, onProgress) {
    const progress = onProgress || (() => {});

    // Step 1: Decompose query into sub-tasks
    progress('Breaking down your query into research tasks...');
    const subtasks = await this._decompose(query);
    progress(`Spawned **${subtasks.length}** research agents in parallel...`);

    // Step 2: Run all agents in parallel (each with web search)
    const results = await this._runAgents(subtasks, progress);
    const successful = results.filter(r => !r.failed);
    progress(`${successful.length}/${subtasks.length} agents finished. Synthesizing findings...`);

    // Step 3: Synthesize into one coherent response
    const synthesis = await this._synthesize(query, results);
    return { synthesis, agents: results, taskCount: subtasks.length };
  }

  // ── Step 1: Decompose ────────────────────────────────────────────────

  async _decompose(query) {
    const prompt = `You are a research coordinator. Break this query into 2-6 specific, independent research sub-tasks that can run in parallel. Each agent will have web search access.

Query: "${query}"

Respond with ONLY a JSON array. No markdown, no explanation, just the array:
[
  {"role": "Role Name", "task": "Specific research task description"},
  {"role": "Role Name", "task": "Specific research task description"}
]

Make tasks specific and non-overlapping. Each should produce independently useful findings.`;

    const response = await this._llmCall(prompt, false);
    return this._parseSubtasks(response);
  }

  _parseSubtasks(response) {
    try {
      // Extract JSON array from response (may have extra text around it)
      const match = response.match(/\[[\s\S]*\]/);
      if (!match) throw new Error('No JSON array found');
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Empty array');

      // Validate and cap at 6
      return parsed
        .filter(t => t.role && t.task)
        .slice(0, 6)
        .map(t => ({ role: String(t.role), task: String(t.task) }));
    } catch (err) {
      console.error('[AgentSwarm] Failed to parse subtasks, using default split:', err.message);
      // Fallback: create 3 generic research angles
      return [
        { role: 'News Analyst', task: `Search for the latest news and developments related to: ${this._truncate(arguments[0] || 'the query', 200)}` },
        { role: 'Data Analyst', task: `Find specific data, statistics, and financial metrics related to: ${this._truncate(arguments[0] || 'the query', 200)}` },
        { role: 'Risk Analyst', task: `Assess risks, challenges, and contrarian viewpoints related to: ${this._truncate(arguments[0] || 'the query', 200)}` },
      ];
    }
  }

  // ── Step 2: Run agents in parallel ───────────────────────────────────

  async _runAgents(subtasks, progress) {
    const promises = subtasks.map(async (subtask, i) => {
      const label = `[${i + 1}/${subtasks.length}] ${subtask.role}`;
      try {
        progress(`${label}: researching...`);

        const agentPrompt = `You are a ${subtask.role}. Your specific research task:

${subtask.task}

Search the web thoroughly. Provide a detailed, factual report with:
- Specific data points, numbers, and dates
- Source attribution (mention where you found key facts)
- Key takeaways clearly highlighted

Be thorough but structured. Use bullet points for clarity.`;

        const result = await this._llmCall(agentPrompt, true);
        progress(`${label}: done.`);
        return { role: subtask.role, task: subtask.task, result, failed: false };
      } catch (err) {
        console.error(`[AgentSwarm] Agent "${subtask.role}" failed:`, err.message);
        progress(`${label}: failed (${err.message})`);
        return { role: subtask.role, task: subtask.task, result: `Research failed: ${err.message}`, failed: true };
      }
    });

    return Promise.all(promises);
  }

  // ── Step 3: Synthesize ───────────────────────────────────────────────

  async _synthesize(originalQuery, agentResults) {
    const findings = agentResults.map(r =>
      `### ${r.role}\n**Task:** ${r.task}\n**Findings:**\n${r.result}`
    ).join('\n\n---\n\n');

    const prompt = `You are a senior research analyst. Multiple research agents have completed their parallel investigations. Synthesize all findings into one clear, well-structured response.

Original query: "${originalQuery}"

--- AGENT FINDINGS ---
${findings}
--- END FINDINGS ---

Write a comprehensive synthesis that:
1. Opens with a direct answer/overview (2-3 sentences)
2. Organizes key findings by theme (use **bold** headers)
3. Includes specific numbers, data points, and sources from the agents
4. Notes any conflicting information between agents
5. Ends with a clear conclusion or recommendation

Keep it under 1800 characters total (Discord limit). Use markdown formatting.`;

    return this._llmCall(prompt, false);
  }

  // ── LLM call (Kimi with web search → Ollama + SearXNG fallback) ─────

  async _llmCall(prompt, withWebSearch = false) {
    if (this.kimiEnabled) {
      return this._kimiCall(prompt, withWebSearch);
    }
    return this._ollamaCall(prompt, withWebSearch);
  }

  /**
   * Kimi API call with optional $web_search built-in tool.
   * Handles the tool-call loop (Moonshot executes search server-side).
   */
  async _kimiCall(prompt, withWebSearch) {
    const url = `${config.kimiBaseUrl}/chat/completions`;
    const headers = {
      'Authorization': `Bearer ${config.kimiApiKey}`,
      'Content-Type': 'application/json',
    };

    let messages = [{ role: 'user', content: prompt }];
    const maxIterations = 5;

    for (let i = 0; i < maxIterations; i++) {
      const body = {
        model: config.kimiModel,
        messages,
        temperature: 0.6,
        max_tokens: 4096,
      };
      if (withWebSearch) {
        body.tools = KIMI_TOOLS;
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => 'Unknown error');
        throw new Error(`Kimi API ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const choice = data.choices[0];

      if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
        messages.push(choice.message);

        for (const toolCall of choice.message.tool_calls) {
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: toolCall.function.arguments,
          });
        }
        continue;
      }

      return choice.message.content || '';
    }

    return 'Agent reached maximum search iterations without a final answer.';
  }

  /**
   * Ollama fallback. If web search is requested, runs SearXNG first
   * and injects results into the prompt.
   */
  async _ollamaCall(prompt, withWebSearch) {
    let enrichedPrompt = prompt;

    if (withWebSearch && config.searxngUrl) {
      try {
        // Extract a search query from the prompt (first 100 chars of the task)
        const queryMatch = prompt.match(/task[:\s]*\n?(.*?)(?:\n|$)/i);
        const searchQuery = queryMatch
          ? queryMatch[1].slice(0, 100)
          : prompt.slice(0, 100);

        const searchResult = await webSearch(searchQuery, 5);
        if (!searchResult.error && searchResult.results?.length > 0) {
          const formatted = formatResultsForAI(searchResult);
          enrichedPrompt = `${prompt}\n\nWEB SEARCH RESULTS (use these for your research):\n${formatted}`;
        }
      } catch (err) {
        console.error('[AgentSwarm] SearXNG search failed:', err.message);
      }
    }

    try {
      const stream = await this.ollama.chat({
        model: this.model,
        messages: [{ role: 'user', content: enrichedPrompt }],
        stream: true,
      });

      let result = '';
      for await (const part of stream) {
        result += part.message.content;
      }
      return result;
    } catch (err) {
      console.error('[AgentSwarm] Ollama call error:', err.message);
      throw err;
    }
  }

  // ── Discord formatting ───────────────────────────────────────────────

  formatForDiscord(result) {
    const lines = [
      `**Agent Swarm Research** _(${result.taskCount} parallel agents)_\n`,
      result.synthesis,
    ];

    // Agent status summary
    const statuses = result.agents.map(a => {
      const icon = a.failed ? '❌' : '✅';
      return `${icon} ${a.role}`;
    });
    lines.push(`\n_Agents: ${statuses.join(' | ')}_`);
    lines.push(`_${new Date().toLocaleString()}_`);

    let output = lines.join('\n');
    if (output.length > 1950) {
      output = output.slice(0, 1950) + '\n...';
    }
    return output;
  }

  formatDetailedReport(result) {
    const sections = [
      `# Agent Swarm Research Report`,
      `Query completed at: ${new Date().toISOString()}`,
      `Agents deployed: ${result.taskCount}`,
      '',
    ];

    for (const agent of result.agents) {
      sections.push(`## ${agent.role}`);
      sections.push(`**Task:** ${agent.task}`);
      sections.push(agent.failed ? `**Status:** FAILED` : agent.result);
      sections.push('');
    }

    sections.push('## Synthesized Findings');
    sections.push(result.synthesis);

    return sections.join('\n');
  }

  _truncate(str, len) {
    return str.length > len ? str.slice(0, len) + '...' : str;
  }
}

module.exports = new AgentSwarm();
