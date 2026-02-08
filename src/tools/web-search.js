/**
 * Web Search — Live internet search via Serper Dev API.
 *
 * Serper (https://serper.dev) provides a Google Search API.
 * Free tier: 2,500 queries/month.
 *
 * Setup:
 *   1. Sign up at https://serper.dev and get your API key
 *   2. Add to your Railway environment variables:
 *        SERPER_API_KEY=your_serper_api_key_here
 *   3. Or add to your local .env file
 *
 * Usage from ai-engine.js or any other module:
 *   const { webSearch, searchAndSummarize } = require('./src/tools/web-search');
 *   const results = await webSearch('AAPL earnings 2026');
 */

const config = require('../config');

const SERPER_API_URL = 'https://google.serper.dev/search';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Simple in-memory cache to avoid duplicate API calls
const cache = new Map();

/**
 * Search the web using the Serper API.
 *
 * @param {string} query — The search query
 * @param {number} [numResults=3] — Number of results to return (max 10)
 * @returns {Promise<{ results: Array<{ title, link, snippet, position }>, query, timestamp } | { error, query }>}
 */
async function webSearch(query, numResults = 3) {
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return { error: 'Search query is required.', query };
  }

  const apiKey = config.serperApiKey;
  if (!apiKey) {
    return {
      error: 'SERPER_API_KEY is not configured. Add it to your environment variables. Get a free key at https://serper.dev',
      query,
    };
  }

  // Check cache first
  const cacheKey = `${query.trim().toLowerCase()}:${numResults}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const num = Math.min(Math.max(numResults, 1), 10);

  try {
    const response = await fetch(SERPER_API_URL, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query.trim(), num }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (response.status === 401 || response.status === 403) {
        return { error: 'Invalid SERPER_API_KEY. Check your key at https://serper.dev', query };
      }
      if (response.status === 429) {
        return { error: 'Serper rate limit exceeded. Free tier allows 2,500 queries/month.', query };
      }
      return { error: `Serper API error: ${response.status} ${response.statusText}${text ? ` — ${text}` : ''}`, query };
    }

    const data = await response.json();

    // Parse organic results
    const organic = data.organic || [];
    const results = organic.slice(0, num).map((item, i) => ({
      title: item.title || '',
      link: item.link || '',
      snippet: item.snippet || '',
      position: i + 1,
    }));

    // Include knowledge graph if available
    let knowledgeGraph = null;
    if (data.knowledgeGraph) {
      knowledgeGraph = {
        title: data.knowledgeGraph.title || '',
        type: data.knowledgeGraph.type || '',
        description: data.knowledgeGraph.description || '',
      };
    }

    const result = {
      results,
      knowledgeGraph,
      query: query.trim(),
      resultCount: results.length,
      timestamp: new Date().toISOString(),
    };

    // Cache the result
    cache.set(cacheKey, { data: result, timestamp: Date.now() });

    // Prune old cache entries
    if (cache.size > 100) {
      const now = Date.now();
      for (const [key, val] of cache) {
        if (now - val.timestamp > CACHE_TTL) cache.delete(key);
      }
    }

    return result;
  } catch (err) {
    // Network errors — connection refused, DNS failures, timeouts
    const msg = err.message || String(err);

    if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
      return { error: `Network error: cannot reach Serper API. Check your internet connection.`, query };
    }

    if (msg.includes('timeout') || msg.includes('AbortError')) {
      return { error: 'Serper API request timed out. Try again.', query };
    }

    return { error: `Web search failed: ${msg}`, query };
  }
}

/**
 * Format search results as a readable string for Discord or AI context.
 *
 * @param {{ results, knowledgeGraph, query }} searchResult
 * @returns {string}
 */
function formatResultsForDiscord(searchResult) {
  if (searchResult.error) {
    return `**Web Search Error:** ${searchResult.error}`;
  }

  const lines = [`**Web Search: "${searchResult.query}"**\n`];

  if (searchResult.knowledgeGraph) {
    const kg = searchResult.knowledgeGraph;
    lines.push(`> **${kg.title}** ${kg.type ? `(${kg.type})` : ''}`);
    if (kg.description) lines.push(`> ${kg.description}`);
    lines.push('');
  }

  if (searchResult.results.length === 0) {
    lines.push('No results found.');
  } else {
    for (const r of searchResult.results) {
      lines.push(`**${r.position}. [${r.title}](${r.link})**`);
      if (r.snippet) lines.push(`${r.snippet}`);
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

/**
 * Format search results as context for an AI prompt.
 *
 * @param {{ results, knowledgeGraph, query }} searchResult
 * @returns {string}
 */
function formatResultsForAI(searchResult) {
  if (searchResult.error) {
    return `Web search failed: ${searchResult.error}`;
  }

  const lines = [`Web search results for "${searchResult.query}":\n`];

  if (searchResult.knowledgeGraph) {
    const kg = searchResult.knowledgeGraph;
    lines.push(`Knowledge Graph: ${kg.title} ${kg.type ? `(${kg.type})` : ''}`);
    if (kg.description) lines.push(kg.description);
    lines.push('');
  }

  for (const r of searchResult.results) {
    lines.push(`[${r.position}] ${r.title}`);
    lines.push(`    URL: ${r.link}`);
    if (r.snippet) lines.push(`    ${r.snippet}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

module.exports = { webSearch, formatResultsForDiscord, formatResultsForAI };
