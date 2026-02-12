const https = require('https');

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

    const results = [];
    const resultBlocks = html.split(/class="result\s/);

    for (let i = 1; i < resultBlocks.length && results.length < num; i++) {
      const block = resultBlocks[i];

      const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/);
      if (!urlMatch) continue;

      let link = urlMatch[1];
      const uddgMatch = link.match(/uddg=([^&]+)/);
      if (uddgMatch) link = decodeURIComponent(uddgMatch[1]);

      if (link.includes('duckduckgo.com') || link.includes('ad_domain')) continue;

      const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
      const title = titleMatch ? _decodeHtml(titleMatch[1].trim()) : '';

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
  } else {
    // Always return an object with `ok: true` or `ok: false`
  }
}

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

  async function tryAlpacaNews(query, num) {
    if (!alpacaClient || !alpacaClient.enabled) {
      return { ok: false, error: 'Alpaca not configured' };
    }

    try {
      // Extract potential ticker symbols from the query for targeted news
      const tickerMatch = query.match(/\b[A-Z]{1,5}\b/g) || [];
      const symbols = tickerMatch.filter(t => !['THE', 'FOR', 'AND', 'NOT', 'YOU', 'ALL', 'CAN', 'ARE',
        'HAS', 'HOW', 'NOW', 'NEW', 'WAS', 'WHO', 'DID', 'GET', 'SAY', 'TOO', 'TOP',
        'WHAT', 'WITH', 'THAT', 'THIS', 'WILL', 'FROM', 'HAVE', 'MANY', 'SOME',
        'BUY', 'SELL', 'HOLD', 'IPO', 'ETF', 'GDP', 'FED', 'SEC', 'DOW', 'TODAY'].includes(t));

      const articles = await alpacaClient.getNews({
        symbols: symbols.slice(0, 3),
        limit: Math.min(num, 10),
      });

      if (!articles || articles.length === 0) {
        return { ok: false, error: 'Alpaca News returned no articles' };
      }

      const results = articles.slice(0, num).map((article, i) => ({
        title: article.headline || article.title || '',
        link: article.url || '',
        snippet: (article.summary || '').slice(0, 300),
        engine: 'alpaca-news',
        position: i + 1,
      }));

      return { ok: true, data: { results, infobox: null } };
    } catch (err) {
      return { ok: false, error: `Alpaca News: ${err.message}` };
    }
  }

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
  const errors = [];

  // PRIORITY: AInvest News (paid API, best quality, most reliable)
  const ainvestAttempt = await tryAInvestNews(query, num);

  if (ainvestAttempt.ok) {
    const result = {
      ...ainvestAttempt.data,
      query: query.trim(),
      resultCount: ainvestAttempt.data.results.length,
      timestamp: new Date().toISOString(),
      instance: 'ainvest',
    };

    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    _pruneCache();
    console.log(`[WebSearch] AInvest returned ${result.resultCount} articles for "${query}"`);
    return result;
  }

  errors.push(ainvestAttempt.error);

  // Fallback: SearXNG instances (general web search)
  const instances = [];
  if (config.searxngUrl) instances.push(config.searxngUrl);
  for (const fb of FALLBACK_INSTANCES) {
    if (!instances.includes(fb)) instances.push(fb);
  }

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

  // Fallback: DuckDuckGo HTML
  console.log(`[WebSearch] AInvest + SearXNG failed, trying DuckDuckGo HTML...`);
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

  // Last resort: Alpaca News (only covers market/finance, but reliable from Railway)
  console.log(`[WebSearch] DuckDuckGo failed too, trying Alpaca News...`);
  const alpacaAttempt = await tryAlpacaNews(query, num);

  if (alpacaAttempt.ok) {
    const result = {
      ...alpacaAttempt.data,
      query: query.trim(),
      resultCount: alpacaAttempt.data.results.length,
      timestamp: new Date().toISOString(),
      instance: 'alpaca-news',
    };

    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    _pruneCache();
    console.log(`[WebSearch] Alpaca News returned ${result.resultCount} articles for "${query}"`);
    return result;
  }

  errors.push(alpacaAttempt.error);
  console.error(`[WebSearch] ALL search sources failed for "${query}": ${errors.join(' | ')}`);
  return { error: `All search sources failed. Errors: ${errors.slice(-3).join('; ')}`, query };
}

function _pruneCache() {
  if (cache.size > 100) {
    const now = Date.now();
    for (const [key, val] of cache) {
      if (now - val.timestamp > CACHE_TTL) cache.delete(key);
    }
  }
}

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

function generateFingerprint(item) {
  // Simple fingerprint using lowercased title + normalized link
  const titleNorm = item.title.trim().toLowerCase();
  const linkNorm = item.link.toLowerCase();
  return `${titleNorm}|${linkNorm}`;
}

function deduplicateResults(results, existingSet) {
  const uniqueResults = [];
  const newFingerprints = new Set();

  for (const item of existingSet) {
    if (!existingSet.has(item.fingerprint)) {
      existingSet.set(item.fingerprint, true);
      uniqueResults.push(item);
    }
  }

  // Filter out near-duplicates from new results
  for (const result of results) {
    const fp = generateFingerprint(result);
    if (!newFingerprints.has(fp)) {
      newFingerprints.add(fp);
      uniqueResults.push(result);
    }
  }

  return uniqueResults;
}

function webSearch(query, numResults = 3) {
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
  const errors = [];

  // PRIORITY: AInvest News (paid API, best quality, most reliable)
  const ainvestAttempt = await tryAInvestNews(query, num);

  if (ainvestAttempt.ok) {
    const result = {
      ...ainvestAttempt.data,
      query: query.trim(),
      resultCount: ainvestAttempt.data.results.length,
      timestamp: new Date().toISOString(),
      instance: 'ainvest',
    };

    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    _pruneCache();
    console.log(`[WebSearch] AInvest returned ${result.resultCount} articles for "${query}"`);
    return result;
  }

  errors.push(ainvestAttempt.error);

  // Fallback: SearXNG instances (general web search)
  const instances = [];
  if (config.searxngUrl) instances.push(config.searxngUrl);
  for (const fb of FALLBACK_INSTANCES) {
    if (!instances.includes(fb)) instances.push(fb);
  }

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

  // Fallback: DuckDuckGo HTML
  console.log(`[WebSearch] AInvest + SearXNG failed, trying DuckDuckGo HTML...`);
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

  // Last resort: Alpaca News (only covers market/finance, but reliable from Railway)
  console.log(`[WebSearch] DuckDuckGo failed too, trying Alpaca News...`);
  const alpacaAttempt = await tryAlpacaNews(query, num);

  if (alpacaAttempt.ok) {
    const result = {
      ...alpacaAttempt.data,
      query: query.trim(),
      resultCount: alpacaAttempt.data.results.length,
      timestamp: new Date().toISOString(),
      instance: 'alpaca-news',
    };

    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    _pruneCache();
    console.log(`[WebSearch] Alpaca News returned ${result.resultCount} articles for "${query}"`);
    return result;
  }

  errors.push(alpacaAttempt.error);
  console.error(`[WebSearch] ALL search sources failed for "${query}": ${errors.join(' | ')}`);
  return { error: `All search sources failed. Errors: ${errors.slice(-3).join('; ')}`, query };
}

   module.exports = { webSearch, formatResultsForDiscord, formatResultsForAI, deduplicateResults };