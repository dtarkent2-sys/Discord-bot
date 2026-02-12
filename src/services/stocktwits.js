const upper = symbol.toUpperCase();
const cachedKey = upper;
if (this._cache.has(cachedKey)) {
  const cached = this._cache.get(cachedKey);
  if (Date.now() < cached.expiry) {
    return cached.data;
  }
}
const res = await fetch(`${STOCKTWITS_BASE}/streams/symbol/${upper}.json?limit=${limit}`, {
  signal: AbortSignal.timeout(10000),
});
if (!res.ok) {
  if (res.status === 404) return [];
  throw new Error(`StockTwits API error for ${upper}: ${res.status}`);
}
const data = await res.json();
const messages = (data.messages || []).map(msg => ({
  id: msg.id,
  body: msg.body,
  createdAt: msg.created_at,
  username: msg.user?.username || 'unknown',
  followers: msg.user?.followers || 0,
  sentiment: msg.entities?.sentiment?.basic || null,
  symbols: (msg.symbols || []).map(s => s.symbol),
}));
this._cache.set(cachedKey, { data: messages, expiry: Date.now() + 2 * 60 * 1000 });
return messages;