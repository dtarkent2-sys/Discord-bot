const https = require('https');

// Fix: Improved result block parsing in DuckDuckGo HTML response to avoid false matches from empty splits and add validation before processing extracted URLs and titles
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
    // Match on specific opening tag to avoid empty splits; allow attribute order and extra spaces
    const resultBlocks = html.split(/<div\s+class="result\s+result__block"/i);

    // Filter out empty blocks or look-like-empty-splits (e.g. leading empty string before first real block)
    const meaningfulBlocks = resultBlocks.filter(block => 
      block.trim().length > 0 && 
      block.startsWith('<div') && 
      !/^\s*<\/div>\s*$/.test(block.trim()) && // reject pure closing divs
      block.includes('result__a') && // ensure it contains a real result link
      block.includes('result__snippet')
    );

    for (const block of meaningfulBlocks) {
      const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/i);
      if (!urlMatch) continue;

      let link = urlMatch[1];
      const uddgMatch = link.match(/uddg=([^&]+)/);
      if (uddgMatch) link = decodeURIComponent(uddgMatch[1]);

      // Reject DuckDuckGo redirect domain or ad domains
      if (link.includes('duckduckgo.com') || link.includes('ad_domain') || !link.startsWith('http')) {
        continue;
      }

      const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</i);
      const title = titleMatch ? _decodeHtml(titleMatch[1].trim()) : '';

      // Validate that we got non-empty, non-corrupted title and link
      if (!title || title.length < 3 || !link || !/^https?:\/\//i.test(link)) {
        continue;
      }

      const snippetMatch = block.match(/class="result__snippet"[^>]*>([^<]*(?:<[^>]*>[^<]*)*)/i);
      let snippet = '';
      if (snippetMatch) {
        snippet = _decodeHtml(snippetMatch[1].replace(/<[^>]+>/g, '').trim());
      }

      // Only push if we have both title and valid link
      if (title && link && title.length > 2) {
        results.push({
          title,
          link,
          snippet,
          engine: 'duckduckgo',
          position: results.length + 1,
        });
      }

      if (results.length >= num) break;
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