const { tryAInvestNews, tryInstance, tryDuckDuckGo, tryAlpacaNews, webSearch, formatResultsForDiscord, formatResultsForAI } = require('./web-search');

const BATCH_SIZE = 5;
const MAX_ATTEMPTS = 3;

// Wrap each individual service attempt in a promise and resolve all concurrently
const tryBatch = async (query, num) => {
  const attempts = [];

  // AInvest News - highest priority, synchronous attempt
  const ainvestAttempt = await tryAInvestNews(query, num);
  attempts.push(ainvestAttempt);

  // SearXNG instances in parallel
  const searxngPromises = configurations.searxngUrl
    ? [Promise.resolve(configurations.searxngUrl)]
    : FALLBACK_INSTANCES.map(url => tryInstance(url, query, num).then(r => ({ url, ...r })));
  attempts.push(...searxngPromises);

  // DuckDuckGo in parallel
  attempts.push(tryDuckDuckGo(query, num));

  // AlpaCa News in parallel as ultimate fallback
  attempts.push(tryAlpacaNews(query, num));

  const results = await Promise.allSettled(attempts);
  const resolved = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  const rejected = results.filter(r => r.status === 'rejected').map(r => r.reason);
  const allErrors = [...resolved.map(r => r.error || 'unknown'), ...rejected];

  // Return first successful result, or error if all failed
  for (const result of resolved) {
    if (result.ok) return result;
  }

  console.error(`[WebSearch] BATCH FAILED after ${MAX_ATTEMPTS} attempts: ${allErrors.join(' | ')}`);
  return { error: `All search sources failed. Errors: ${allErrors.join('; ')}`, query };
};

const search = async (query, num = BATCH_SIZE) => {
  if (!query || typeof query !== 'string') {
    return { error: 'Search query must be a non-empty string.', query };
  }

  if (num < 1) return { error: 'Search results count must be at least 1.', query };

  const cacheKey = `${query.trim().toLowerCase()}:${num}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  // Parallelize service attempts using Promise.all()
  const batchedResult = await tryBatch(query, Math.min(num, 10));
  const result = batchedResult;

  // Format and cache
  const formatted = result.ok ? formatResultsForDiscord(result) : result.error;
  const response = result.ok ? result : { error: result.error, query };

  cache.set(cacheKey, { data: response, timestamp: Date.now() });
  _pruneCache();

  return response;
};

module.exports = { webSearch: search, formatResultsForDiscord, formatResultsForAI };