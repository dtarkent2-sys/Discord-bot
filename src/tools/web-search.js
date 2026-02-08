/**
 * Web Search — Live internet search via SearXNG.
 *
 * SearXNG (https://docs.searxng.org) is a free, open-source metasearch engine.
 * No API key required — just point to any SearXNG instance.
 *
 * Setup:
 *   1. Use a public instance (e.g. https://search.ononoki.org) or self-host one
 *   2. Add to your Railway environment variables:
 *        SEARXNG_URL=https://your-searxng-instance.com
 *   3. Or add to your local .env file
 *
 * Usage from ai-engine.js or any other module:
 *   const { webSearch, formatResultsForDiscord } = require('./src/tools/web-search');
 *   const results = await webSearch('AAPL earnings 2026');
 */

const config = require('../config');

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Simple in-memory cache to avoid duplicate queries
const cache = new Map();

/**
 * Search the web using a SearXNG instance.
 *
 * @param {string} query — The search query
 * @param {number} [numResults=3] — Number of results to return (max 10)
 * @returns {Promise<{ results: Array<{ title, link, snippet, position }>, query, timestamp } | { error, query }>}
 */
async function webSearch(query, numResults = 3) {
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return { error: 'Search query is required.', query };
  }

  const baseUrl = config.searxngUrl;
  if (!baseUrl) {
    return {
      error: 'SEARXNG_URL is not configured. Set it to a SearXNG instance URL (e.g. https://search.ononoki.org).',
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

  // Build the SearXNG search URL with JSON format
  const url = new URL('/search', baseUrl);
  url.searchParams.set('q', query.trim());
  url.searchParams.set('format', 'json');
  url.searchParams.set('categories', 'general');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (response.status === 429) {
        return { error: 'SearXNG rate limit hit. Try again in a moment.', query };
      }
      return { error: `SearXNG error: ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`, query };
    }

    const data = await response.json();

    // Parse organic results
    const rawResults = data.results || [];
    const results = rawResults.slice(0, num).map((item, i) => ({
      title: item.title || '',
      link: item.url || '',
      snippet: item.content || '',
      engine: item.engine || '',
      position: i + 1,
    }));

    // Include infobox if available (SearXNG equivalent of knowledge graph)
    let infobox = null;
    if (data.infoboxes && data.infoboxes.length > 0) {
      const ib = data.infoboxes[0];
      infobox = {
        title: ib.infobox || '',
        content: ib.content || '',
        urls: (ib.urls || []).map(u => ({ title: u.title, url: u.url })),
      };
    }

    const result = {
      results,
      infobox,
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
    const msg = err.message || String(err);

    if (err.name === 'AbortError' || msg.includes('abort')) {
      return { error: 'SearXNG request timed out (15s). The instance may be slow — try again or use a different instance.', query };
    }

    if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
      return { error: `Cannot reach SearXNG at ${baseUrl}. Check SEARXNG_URL and ensure the instance is running.`, query };
    }

    return { error: `Web search failed: ${msg}`, query };
  }
}

/**
 * Format search results as a readable string for Discord.
 *
 * @param {{ results, infobox, query }} searchResult
 * @returns {string}
 */
function formatResultsForDiscord(searchResult) {
  if (searchResult.error) {
    return `**Web Search Error:** ${searchResult.error}`;
  }

  const lines = [`**Web Search: "${searchResult.query}"**\n`];

  if (searchResult.infobox) {
    const ib = searchResult.infobox;
    lines.push(`> **${ib.title}**`);
    if (ib.content) lines.push(`> ${ib.content.slice(0, 300)}`);
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
 * @param {{ results, infobox, query }} searchResult
 * @returns {string}
 */
function formatResultsForAI(searchResult) {
  if (searchResult.error) {
    return `Web search failed: ${searchResult.error}`;
  }

  const lines = [`Web search results for "${searchResult.query}":\n`];

  if (searchResult.infobox) {
    const ib = searchResult.infobox;
    lines.push(`Infobox: ${ib.title}`);
    if (ib.content) lines.push(ib.content.slice(0, 500));
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
