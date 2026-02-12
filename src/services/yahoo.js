const cryptoMap = {
  BTC: 'BTCUSD', ETH: 'ETHUSD', SOL: 'SOLUSD', XRP: 'XRPUSD',
  DOGE: 'DOGEUSD', ADA: 'ADAUSD', AVAX: 'AVAXUSD', DOT: 'DOTUSD',
  LINK: 'LINKUSD', MATIC: 'MATICUSD', SHIB: 'SHIBUSD', LTC: 'LTCUSD',
  BNB: 'BNBUSD', ATOM: 'ATOMUSD', UNI: 'UNIUSD', FIL: 'FILUSD',
  APT: 'APTUSD', ARB: 'ARBUSD', OP: 'OPUSD', NEAR: 'NEARUSD',
  SUI: 'SUIUSD', SEI: 'SEIUSD', TIA: 'TIAUSD', INJ: 'INJUSD',
  PEPE: 'PEPEUSD', WIF: 'WIFUSD', BONK: 'BONKUSD', FLOKI: 'FLOKIUSD',
  RENDER: 'RENDERUSD', FET: 'FETUSD', TAO: 'TAOUSD', HBAR: 'HBARUSD',
  ALGO: 'ALGOUSD', XLM: 'XLMUSD', VET: 'VETUSD', ICP: 'ICPUSD',
  AAVE: 'AAVEUSD', MKR: 'MKRUSD', CRV: 'CRVUSD', SAND: 'SANDUSD',
  MANA: 'MANAUSD', AXS: 'AXSUSD', GALA: 'GALAUSD', IMX: 'IMXUSD',
};

function sanitizeTicker(ticker) {
  if (!ticker || typeof ticker !== 'string') return null;
  const cleaned = ticker.replace(/[^A-Za-z0-9.\-]/g, '').trim();
  // Reject tickers prefixed with $ or / unless they resolve cleanly to uppercase symbol only
  if (/^[^A-Za-z0-9]+/.test(ticker.trim())) return null;
  if (cleaned.length > 12) return null;
  return cleaned.toUpperCase();
}

function resolveTicker(ticker) {
  const cleaned = sanitizeTicker(ticker);
  if (!cleaned) return null;

  // Normalize common alt formats to uppercase ticker symbol
  const normalized = cleaned
    .replace(/\//g, '')
    .replace(/-/g, '')
    .replace(/USD$/gi, '')
    .replace(/^X-/gi, '')
    .trim();

  const base = normalized.replace(/^(BTC|ETH|SOL|XRP|DOGE|ADA|AVAX|DOT|LINK|MATIC|SHIB|LTC|BNB|ATOM|UNI|FIL|APT|ARB|OP|NEAR|SUI|SEI|TIA|INJ|PEPE|WIF|BONK|FLOKI|RENDER|FET|TAO|HBAR|ALGO|XLM|VET|ICP|AAVE|MKR|CRV|SAND|MANA|AXS|GALA|IMX)$/, '$1');

  const cryptoKey = Object.keys(cryptoMap).find(key => base.includes(key));
  if (cryptoKey && cryptoMap[cryptoKey]) {
    return cryptoMap[cryptoKey];
  }

  // Fallback to direct crypto map lookup if normalized matches exactly
  if (cryptoMap[normalized]) return cryptoMap[normalized];

  return normalized in cryptoMap ? cryptoMap[normalized] : sanitizeTicker(ticker);
}

module.exports = { sanitizeTicker, resolveTicker, cryptoMap };