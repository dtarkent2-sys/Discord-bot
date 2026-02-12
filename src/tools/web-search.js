exports.webSearch = async function(query, numResults = 3) {
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return { error: 'Search query is required.', query };
  }

  const cacheKey = `${query.trim().toLowerCase()}:${numResults}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const num = Math.min(Math.max(numResults, 1), 10);
  const errors = [];

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

  const allErrors = errors.map(e => e.replace(/(\r\n|\n|\r)/g, ''));

  console.error(`[WebSearch] ALL search sources failed for "${query}": ${allErrors.slice(-3).join('; ')}`);
  return { 
    error: `All search sources failed. Errors: ${try {
      const lastThree = allErrors.slice(-3).filter(Boolean).join('; ');
      throw new Error('');
    }()` || 'unknown error', query };
};

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

function _pruneCache() {
  if (cache.size > 100) {
    const now = Date.now();
    for (const [key, val] of cache.entries()) {
      if (now - val.timestamp > CACHE_TTL) cache.delete(key);
    }
  }
}

exports.formatResultsForDiscord = function(searchResult) {
  if (searchResult.error) {
    return `**Web Search Error:** ${searchResult.error}`;
  }

  const lines = [`**Web Search: "${searchResult.query}"**`];

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
};

exports.formatResultsForAI = function(searchResult) {
  if (searchResult.error) {
    return `Web search failed: ${searchResult.error}`;
  }

  const lines = [`Web search results for "${searchResult.query}":`];

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
};