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

// ── Fallback SearXNG instances (tried in order if primary fails) ─────────
// Public instances rotate — update this list if one goes down permanently.
const FALLBACK_INSTANCES = [
  'https://search.ononoki.org',
  'https://search.sapti.me',
  'https://searxng.site',
  'https://search.bus-hit.me',
];

/**
 * Attempt a search against a single SearXNG instance.
 * @returns {{ ok: true, data: object } | { ok: false, error: string }}
 */
async function tryInstance(instanceUrl, query, num) {
  const url = new URL('/search', instanceUrl);
  url.searchParams.set('q', query.trim());
  url.searchParams.set('format', 'json');
  url.searchParams.set('categories', 'general');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s per instance

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, error: `${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 100)}` : ''}` };
    }

    const data = await response.json();
    const rawResults = data.results || [];

    // If zero results, this instance might be broken — try the next one
    if (rawResults.length === 0 && !data.infoboxes?.length) {
      return { ok: false, error: 'Zero results returned' };
    }

    const results = rawResults.slice(0, num).map((item, i) => ({
      title: item.title || '',
      link: item.url || '',
      snippet: item.content || '',
      engine: item.engine || '',
      position: i + 1,
    }));

    let infobox = null;
    if (data.infoboxes && data.infoboxes.length > 0) {
      const ib = data.infoboxes[0];
      infobox = {
        title: ib.infobox || '',
        content: ib.content || '',
        urls: (ib.urls || []).map(u => ({ title: u.title, url: u.url })),
      };
    }

    return { ok: true, data: { results, infobox } };
  } catch (err) {
    clearTimeout(timeout);
    const msg = err.name === 'AbortError' ? 'timeout' : (err.message || String(err));
    return { ok: false, error: msg };
  }
}

/**
 * Search the web using a SearXNG instance.
 * Tries the configured primary instance first, then falls back to public instances.
 *
 * @param {string} query — The search query
 * @param {number} [numResults=3] — Number of results to return (max 10)
 * @returns {Promise<{ results: Array<{ title, link, snippet, position }>, query, timestamp } | { error, query }>}
 */
async function webSearch(query, numResults = 3) {
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return { error: 'Search query is required.', query };
  }

  // Check cache first
  const cacheKey = `${query.trim().toLowerCase()}:${numResults}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const num = Math.min(Math.max(numResults, 1), 10);

  // Build ordered list of instances to try: configured primary + fallbacks
  const instances = [];
  if (config.searxngUrl) instances.push(config.searxngUrl);
  for (const fb of FALLBACK_INSTANCES) {
    if (!instances.includes(fb)) instances.push(fb);
  }

  if (instances.length === 0) {
    return { error: 'No SearXNG instances available. Set SEARXNG_URL in your .env.', query };
  }

  // Try each instance in order until one succeeds
  const errors = [];
  for (const instanceUrl of instances) {
    const attempt = await tryInstance(instanceUrl, query, num);

    if (attempt.ok) {
      const result = {
        ...attempt.data,
        query: query.trim(),
        resultCount: attempt.data.results.length,
        timestamp: new Date().toISOString(),
        instance: instanceUrl,
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
    }

    errors.push(`${instanceUrl}: ${attempt.error}`);
    console.warn(`[WebSearch] Instance failed: ${instanceUrl} — ${attempt.error}`);
  }

  // All instances failed
  console.error(`[WebSearch] All ${instances.length} SearXNG instances failed for "${query}": ${errors.join(' | ')}`);
  return { error: `All SearXNG instances failed. Last errors: ${errors.slice(-2).join('; ')}`, query };
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
