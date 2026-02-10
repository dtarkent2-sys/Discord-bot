/**
 * Web Search — Multi-source search with automatic fallback.
 *
 * Source priority:
 *   1. SearXNG instances (configured primary + public fallbacks)
 *   2. DuckDuckGo HTML (scrapes lite.duckduckgo.com — no API key)
 *
 * Setup (optional — works out of the box with fallbacks):
 *   1. Add SEARXNG_URL=https://your-instance.com to .env for a custom instance
 *   2. Or just use it — public SearXNG instances and DuckDuckGo are tried automatically
 */

const config = require('../config');

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const cache = new Map();

// ── Fallback SearXNG instances (tried in order if primary fails) ─────────
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
  const timeout = setTimeout(() => controller.abort(), 10000);

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
 * Fallback: Search via DuckDuckGo HTML (lite.duckduckgo.com).
 * Parses the lightweight HTML response to extract result links and snippets.
 * No API key needed — works from datacenter IPs.
 * @returns {{ ok: true, data: object } | { ok: false, error: string }}
 */
async function tryDuckDuckGo(query, num) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.trim())}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DiscordBot/1.0)',
        'Accept': 'text/html',
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return { ok: false, error: `DuckDuckGo ${response.status} ${response.statusText}` };
    }

    const html = await response.text();

    // Parse results from DuckDuckGo HTML
    // Each result is in a <div class="result"> with:
    //   <a class="result__a" href="...">Title</a>
    //   <a class="result__snippet">Snippet text</a>
    const results = [];
    const resultBlocks = html.split(/class="result\s/);

    for (let i = 1; i < resultBlocks.length && results.length < num; i++) {
      const block = resultBlocks[i];

      // Extract URL from result__a href
      const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/);
      if (!urlMatch) continue;

      let link = urlMatch[1];
      // DuckDuckGo wraps URLs in a redirect — extract the actual URL
      const uddgMatch = link.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        link = decodeURIComponent(uddgMatch[1]);
      }

      // Skip ad/tracking links
      if (link.includes('duckduckgo.com') || link.includes('ad_domain')) continue;

      // Extract title text
      const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
      const title = titleMatch ? _decodeHtml(titleMatch[1].trim()) : '';

      // Extract snippet
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([^<]*(?:<[^>]*>[^<]*)*)/);
      let snippet = '';
      if (snippetMatch) {
        snippet = _decodeHtml(snippetMatch[1].replace(/<[^>]+>/g, '').trim());
      }

      if (title && link) {
        results.push({
          title,
          link,
          snippet,
          engine: 'duckduckgo',
          position: results.length + 1,
        });
      }
    }

    if (results.length === 0) {
      return { ok: false, error: 'DuckDuckGo returned no parseable results' };
    }

    return { ok: true, data: { results, infobox: null } };
  } catch (err) {
    clearTimeout(timeout);
    const msg = err.name === 'AbortError' ? 'timeout' : (err.message || String(err));
    return { ok: false, error: `DuckDuckGo: ${msg}` };
  }
}

/** Decode basic HTML entities. */
function _decodeHtml(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ');
}

/**
 * Search the web using multiple sources with automatic fallback.
 * Tries SearXNG instances first, then DuckDuckGo HTML.
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

  // Build ordered list of SearXNG instances to try
  const instances = [];
  if (config.searxngUrl) instances.push(config.searxngUrl);
  for (const fb of FALLBACK_INSTANCES) {
    if (!instances.includes(fb)) instances.push(fb);
  }

  // Try each SearXNG instance in order
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

      cache.set(cacheKey, { data: result, timestamp: Date.now() });
      _pruneCache();
      return result;
    }

    errors.push(`${instanceUrl}: ${attempt.error}`);
    console.warn(`[WebSearch] SearXNG failed: ${instanceUrl} — ${attempt.error}`);
  }

  // All SearXNG instances failed — try DuckDuckGo HTML as last resort
  console.log(`[WebSearch] All SearXNG instances failed, trying DuckDuckGo HTML...`);
  const ddgAttempt = await tryDuckDuckGo(query, num);

  if (ddgAttempt.ok) {
    const result = {
      ...ddgAttempt.data,
      query: query.trim(),
      resultCount: ddgAttempt.data.results.length,
      timestamp: new Date().toISOString(),
      instance: 'duckduckgo-html',
    };

    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    _pruneCache();
    console.log(`[WebSearch] DuckDuckGo returned ${result.resultCount} results for "${query}"`);
    return result;
  }

  errors.push(ddgAttempt.error);
  console.error(`[WebSearch] ALL search sources failed for "${query}": ${errors.join(' | ')}`);
  return { error: `All search sources failed. Errors: ${errors.slice(-2).join('; ')}`, query };
}

function _pruneCache() {
  if (cache.size > 100) {
    const now = Date.now();
    for (const [key, val] of cache) {
      if (now - val.timestamp > CACHE_TTL) cache.delete(key);
    }
  }
}

/**
 * Format search results as a readable string for Discord.
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
