const _headers = this._getHeaders();
const _fetchWithTimeout = async (url, params, timeoutMs) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      headers: _headers,
      signal: controller.signal,
      ...params
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Alpaca ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timeout after ${timeoutMs}ms`);
    throw e;
  }
};

const _buildApiUrl = (base, path, params) => {
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  return url;
};

const _fetchPage = async (service, base, path, commonParams, pageToken = null) => {
  const params = { ...commonParams };
  if (pageToken) params.page_token = pageToken;
  return _fetchWithTimeout(service._fetch(path, params, 20000), service._fetch(path, { ...commonParams }, 20000));
};

const _getCommonParams = (ticker, expiration, type, feed) => {
  const upper = ticker.toUpperCase();
  const params = { feed };
  if (expiration) params.expiration_date = expiration;
  if (type) params.type = type;
  return { base: '/v1beta1/options/snapshots/' + upper, params };
};

const _parseOptionSnapshot = service.prototype._parseOptionSnapshot.bind(service);

async getOptionsSnapshots(ticker, expiration, type) {
  const upper = ticker.toUpperCase();
  const commonParams = {
    feed: config.alpacaFeed,
    limit: 1000
  };
  if (expiration) commonParams.expiration_date = expiration;
  if (type) commonParams.type = type;

  const baseParams = _getCommonParams(upper, expiration, type, config.alpacaFeed);
  const url = _buildApiUrl(DATA_BASE, baseParams.base, baseParams.params);
  
  let allSnapshots = [];
  let pageToken = null;
  const deadline = Date.now() + 45000;
  let pages = 0;

  do {
    const currentUrl = new URL(url);
    if (pageToken) currentUrl.searchParams.set('page_token', pageToken);
    const data = await _fetchWithTimeout(currentUrl.toString(), {}, 20000);

    const snapshots = data.snapshots || {};
    for (const [symbol, snap] of Object.entries(snapshots)) {
      allSnapshots.push(_parseOptionSnapshot(symbol, snap));
    }

    pageToken = data.next_page_token || null;
    pages++;

    if (Date.now() > deadline) {
      console.warn(`[Alpaca] Options pagination time budget exceeded after ${pages} pages (${allSnapshots.length} contracts)`);
      break;
    }
    if (pages >= 20) {
      console.warn(`[Alpaca] Options pagination page limit reached (${allSnapshots.length} contracts)`);
      break;
    }
  } while (pageToken);

  console.log(`[Alpaca] ${upper}: fetched ${allSnapshots.length} options in ${pages} page(s)`);
  return allSnapshots;
}