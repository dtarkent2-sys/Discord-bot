/**
 * AInvest MCP Client — Lightweight Model Context Protocol client.
 *
 * Connects to https://docsmcp.ainvest.com via HTTP Streamable transport.
 * Discovers all available tools on startup and provides a callTool() interface.
 *
 * MCP Protocol (JSON-RPC 2.0 over HTTP):
 *   1. POST initialize → get session ID
 *   2. POST initialized (notification)
 *   3. POST tools/list → discover available tools
 *   4. POST tools/call → invoke a tool
 *
 * No external dependencies — uses native fetch.
 */

const config = require('../config');

const MCP_URL = 'https://docsmcp.ainvest.com';
const PROTOCOL_VERSION = '2025-03-26';

class AInvestMCP {
  constructor() {
    this._sessionId = null;
    this._tools = null;       // Map<name, { description, inputSchema }>
    this._toolsList = null;   // Raw array from server
    this._nextId = 1;
    this._initialized = false;
    this._initPromise = null;
  }

  get enabled() {
    return !!config.ainvestApiKey;
  }

  // ── JSON-RPC helpers ──────────────────────────────────────────────────

  _makeRequest(method, params) {
    const req = {
      jsonrpc: '2.0',
      id: this._nextId++,
      method,
    };
    if (params) req.params = params;
    return req;
  }

  _makeNotification(method, params) {
    return {
      jsonrpc: '2.0',
      method,
      ...(params ? { params } : {}),
    };
  }

  async _post(body) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${config.ainvestApiKey}`,
    };
    if (this._sessionId) {
      headers['Mcp-Session-Id'] = this._sessionId;
    }

    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });

    // Capture session ID from response
    const sessionId = res.headers.get('mcp-session-id');
    if (sessionId) this._sessionId = sessionId;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MCP ${res.status}: ${text.slice(0, 300)}`);
    }

    // Handle empty responses (e.g. 202 Accepted for notifications)
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (!text || !text.trim()) return null;

    // Handle SSE responses (server may stream)
    if (ct.includes('text/event-stream')) {
      return this._parseSSE(text);
    }

    // Standard JSON response
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`MCP JSON parse error: ${err.message} (body: ${text.slice(0, 200)})`);
    }
  }

  /** Parse SSE text and extract JSON-RPC messages */
  _parseSSE(text) {
    const messages = [];
    let currentData = '';

    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        currentData += line.slice(6);
      } else if (line === '' && currentData) {
        try {
          messages.push(JSON.parse(currentData));
        } catch { /* skip malformed */ }
        currentData = '';
      }
    }
    // Handle final data without trailing newline
    if (currentData) {
      try {
        messages.push(JSON.parse(currentData));
      } catch { /* skip */ }
    }

    if (messages.length === 0) return null;

    // Return the last JSON-RPC response (skip notifications)
    const responses = messages.filter(m => m.id !== undefined);
    return responses.length > 0 ? responses[responses.length - 1] : messages[messages.length - 1];
  }

  // ── Initialization ────────────────────────────────────────────────────

  async initialize() {
    if (this._initialized) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    if (!this.enabled) {
      throw new Error('AINVEST_API_KEY not configured');
    }

    try {
      // Step 1: Initialize handshake
      const initResp = await this._post(this._makeRequest('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: 'sprocket-discord-bot',
          version: '1.0.0',
        },
      }));

      if (initResp?.error) {
        throw new Error(`MCP init error: ${JSON.stringify(initResp.error)}`);
      }

      const serverName = initResp?.result?.serverInfo?.name || 'unknown';
      const serverVersion = initResp?.result?.serverInfo?.version || '';
      console.log(`[AInvest MCP] Initialized — server: ${serverName} ${serverVersion}`.trim());

      // Step 2: Send initialized notification (response may be empty — that's fine)
      try {
        await this._post(this._makeNotification('notifications/initialized'));
      } catch {
        // Notifications don't require responses — ignore errors
      }

      // Step 3: Discover tools
      const toolsResp = await this._post(this._makeRequest('tools/list'));

      if (toolsResp?.error) {
        throw new Error(`MCP tools/list error: ${JSON.stringify(toolsResp.error)}`);
      }

      this._toolsList = toolsResp?.result?.tools || [];
      this._tools = new Map();
      for (const tool of this._toolsList) {
        this._tools.set(tool.name, {
          description: tool.description || '',
          inputSchema: tool.inputSchema || {},
        });
      }

      this._initialized = true;
      console.log(`[AInvest MCP] Discovered ${this._tools.size} tools: ${[...this._tools.keys()].join(', ')}`);
    } catch (err) {
      this._initPromise = null; // Allow retry
      throw err;
    }
  }

  // ── Tool Discovery ────────────────────────────────────────────────────

  /** Get list of all available tool names */
  getToolNames() {
    if (!this._tools) return [];
    return [...this._tools.keys()];
  }

  /** Get tool schema by name */
  getToolSchema(name) {
    return this._tools?.get(name) || null;
  }

  /** Check if a specific tool is available */
  hasTool(name) {
    return !!this._tools?.has(name);
  }

  // ── Tool Calling ──────────────────────────────────────────────────────

  /**
   * Call an MCP tool by name.
   *
   * @param {string} name — Tool name (e.g. 'get_candles', 'get_news_wires')
   * @param {object} args — Tool arguments
   * @returns {*} Parsed tool result
   */
  async callTool(name, args = {}) {
    if (!this._initialized) {
      await this.initialize();
    }

    const resp = await this._post(this._makeRequest('tools/call', {
      name,
      arguments: args,
    }));

    if (resp?.error) {
      throw new Error(`MCP tool ${name} error: ${JSON.stringify(resp.error)}`);
    }

    const result = resp?.result;
    if (!result) return null;

    // MCP tools return { content: [{ type: 'text', text: '...' }] }
    if (result.content && Array.isArray(result.content)) {
      const textParts = result.content
        .filter(c => c.type === 'text')
        .map(c => c.text);

      const joined = textParts.join('\n');

      // Try to parse as JSON (most AInvest tools return JSON)
      try {
        return JSON.parse(joined);
      } catch {
        return joined;
      }
    }

    return result;
  }

  // ── Convenience wrappers (correct tool names from discovery) ──────────
  // Actual MCP tool names use hyphens: get-marketdata-candles, get-news-headlines, etc.

  async mcpGetCandles(ticker, { interval = 'day', step = 1, count = 20 } = {}) {
    const now = Date.now();
    const fromMs = interval === 'min'
      ? now - count * step * 60 * 1000
      : now - count * 1.5 * 24 * 60 * 60 * 1000;
    return this.callTool('get-marketdata-candles', {
      ticker: ticker.toUpperCase(),
      interval,
      step,
      from: Math.floor(fromMs),
      to: 0,
    });
  }

  async mcpGetNews({ tab = 'all', tickers = [], limit = 10 } = {}) {
    const args = { tab, size: Math.min(limit, 50) };
    if (tickers.length > 0) args.tickers = tickers.join(',');
    return this.callTool('get-news-headlines', args);
  }

  async mcpGetAnalystRatings(ticker) {
    return this.callTool('get-analyst-ratings', {
      ticker: ticker.toUpperCase(),
    });
  }

  async mcpGetAnalystRatingsHistory(ticker) {
    return this.callTool('get-analyst-ratings-history', {
      ticker: ticker.toUpperCase(),
    });
  }

  async mcpGetInsiderTrades(ticker) {
    return this.callTool('get-ownership-insider', {
      ticker: ticker.toUpperCase(),
    });
  }

  async mcpGetCongressTrades(ticker) {
    return this.callTool('get-ownership-congress', {
      ticker: ticker.toUpperCase(),
    });
  }

  async mcpGetTrades(ticker) {
    return this.callTool('get-marketdata-trades', {
      ticker: ticker.toUpperCase(),
    });
  }

  async mcpSearchSecurities(query) {
    return this.callTool('securities-search', { query });
  }

  async mcpGetEarningsCalendar(date) {
    const args = {};
    if (date) args.date = date;
    return this.callTool('get-calendar-earnings', args);
  }

  async mcpGetDividendsCalendar(date) {
    const args = {};
    if (date) args.date = date;
    return this.callTool('get-calendar-dividends', args);
  }
}

// Singleton
module.exports = new AInvestMCP();
