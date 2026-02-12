const Alpaca = require('@alpacahq/alpaca-trade-api');
const config = require('../config');

const BIG_MOVE_PCT = 1.5;
const MAX_SUBS_PER_CHANNEL = 25;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

class AlpacaStream {
  constructor(discordClient) {
    this.discord = discordClient;
    this.alpaca = null;
    this.socket = null;
    this.connected = false;

    this.channelSubs = new Map();
    this.symbolChannels = new Map();

    this.latestBars = new Map();
    this.latestTrades = new Map();
    this.alertCooldowns = new Map();
  }

  get enabled() {
    return !!(config.alpacaApiKey && config.alpacaApiSecret);
  }

  connect() {
    if (!this.enabled) {
      console.warn('[Stream] Alpaca keys not set — WebSocket stream disabled.');
      return;
    }
    if (this.socket) return;

    this.alpaca = new Alpaca({
      keyId: config.alpacaApiKey,
      secretKey: config.alpacaApiSecret,
      feed: config.alpacaFeed || 'iex',
      paper: true,
    });

    this.socket = this.alpaca.data_stream_v2;

    this.socket.onConnect(() => {
      console.log('[Stream] Connected to Alpaca WebSocket.');
      this.connected = true;

      const allSymbols = [...this.symbolChannels.keys()];
      if (allSymbols.length > 0) {
        console.log(`[Stream] Re-subscribing to ${allSymbols.length} symbols...`);
        this.socket.subscribeForTrades(allSymbols);
        this.socket.subscribeForBars(allSymbols);
      }
    });

    this.socket.onDisconnect(() => {
      console.warn('[Stream] Disconnected from Alpaca WebSocket.');
      this.connected = false;
    });

    this.socket.onError((err) => {
      const msg = typeof err === 'string' ? err : err?.message || String(err);
      if (!msg.includes('connection limit') && !msg.includes('auth timeout')) {
        console.error('[Stream] WebSocket error:', msg);
      } else {
        console.warn(`[Stream] WebSocket: ${msg} (will retry)`);
      }
    });

    this.socket.onStateChange((state) => {
      console.log(`[Stream] State: ${state}`);
    });

    this.socket.onStockTrade((trade) => {
      this._handleTrade(trade);
    });

    this.socket.onStockBar((bar) => {
      this._handleBar(bar);
    });

    this.socket.connect();
    console.log('[Stream] Connecting to Alpaca WebSocket...');
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.connected = false;
      console.log('[Stream] WebSocket disconnected.');
    }
  }

  subscribe(channelId, symbols) {
    if (!this.enabled) {
      return { added: [], already: [], error: 'Alpaca keys not set.' };
    }
    if (!this.socket) {
      return { added: [], already: [], error: 'WebSocket not initialized.' };
    }

    const channelSet = this.channelSubs.get(channelId) || new Set();
    if (channelSet.size >= MAX_SUBS_PER_CHANNEL) {
      return { added: [], already: [], error: `Channel limit reached (${MAX_SUBS_PER_CHANNEL} symbols max).` };
    }

    const added = [];
    const already = [];
    const newToSocket = [];

    for (const raw of symbols) {
      const sym = raw.toUpperCase();
      if (channelSet.has(sym)) {
        already.push(sym);
        continue;
      }
      if (channelSet.size + added.length >= MAX_SUBS_PER_CHANNEL) break;

      channelSet.add(sym);
      added.push(sym);

      if (!this.symbolChannels.has(sym)) {
        this.symbolChannels.set(sym, new Set());
        newToSocket.push(sym);
      }
      this.symbolChannels.get(sym).add(channelId);
    }

    this.channelSubs.set(channelId, channelSet);

    if (newToSocket.length > 0) {
      this.socket.subscribeForTrades(newToSocket);
      this.socket.subscribeForBars(newToSocket);
      console.log(`[Stream] WS subscribed: ${newToSocket.join(', ')}`);
    }

    return { added, already };
  }

  unsubscribe(channelId, symbols) {
    const channelSet = this.channelSubs.get(channelId);
    if (!channelSet) {
      return { removed: [], notFound: symbols.map(s => s.toUpperCase()) };
    }

    const removed = [];
    const notFound = [];
    const removeFromSocket = [];

    for (const raw of symbols) {
      const sym = raw.toUpperCase();
      if (!channelSet.has(sym)) {
        notFound.push(sym);
        continue;
      }

      channelSet.delete(sym);
      removed.push(sym);

      const channels = this.symbolChannels.get(sym);
      if (channels) {
        channels.delete(channelId);
        if (channels.size === 0) {
          this.symbolChannels.delete(sym);
          removeFromSocket.push(sym);
        }
      }
    }

    if (channelSet.size === 0) {
      this.channelSubs.delete(channelId);
    }

    if (removeFromSocket.length > 0) {
      this.socket.unsubscribeFromTrades(removeFromSocket);
      this.socket.unsubscribeFromBars(removeFromSocket);
      console.log(`[Stream] WS unsubscribed: ${removeFromSocket.join(', ')}`);
    }

    return { removed, notFound };
  }

  getSubscriptions(channelId) {
    const set = this.channelSubs.get(channelId);
    return set ? [...set].sort() : [];
  }

  getLatestPrice(symbol) {
    return this.latestTrades.get(symbol.toUpperCase()) || null;
  }

  getLatestBar(symbol) {
    return this.latestBars.get(symbol.toUpperCase()) || null;
  }

  getStatus() {
    return {
      connected: this.connected,
      symbols: this.symbolChannels.size,
      channels: this.channelSubs.size,
      feed: config.alpacaFeed || 'iex',
    };
  }

  _handleTrade(trade) {
    const sym = trade.S;
    this.latestTrades.set(sym, {
      price: trade.p,
      size: trade.s,
      timestamp: trade.t,
    });
  }

  _handleBar(bar) {
    const sym = bar.S;
    const prev = this.latestBars.get(sym);
    const barData = {
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
      vwap: bar.vw,
      timestamp: bar.t,
    };
    this.latestBars.set(sym, barData);

    if (prev && prev.close > 0) {
      const pctChange = ((bar.c - prev.close) / prev.close) * 100;
      if (Math.abs(pctChange) >= BIG_MOVE_PCT) {
        this._maybeSendBigMoveAlert(sym, bar.c, prev.close, pctChange, bar.v);
      }
    }
  }

  async _maybeSendBigMoveAlert(symbol, price, prevClose, pctChange, volume) {
    const now = Date.now();
    const lastAlert = this.alertCooldowns.get(symbol) || 0;
    if (now - lastAlert < ALERT_COOLDOWN_MS) return;

    const channels = this.symbolChannels.get(symbol);
    if (!channels || channels.size === 0) return;

    this.alertCooldowns.set(symbol, now);

    const direction = pctChange > 0 ? 'up' : 'down';
    const emoji = pctChange > 0 ? '🟢' : '🔴';
    const vol = volume ? ` | Vol: ${Number(volume).toLocaleString()}` : '';

    const message = [
      `${emoji} **${symbol}** moved ${direction} **${Math.abs(pctChange).toFixed(2)}%** in the last minute`,
      `$${prevClose.toFixed(2)} → **$${price.toFixed(2)}**${vol}`,
    ].join('\n');

    const channelFetchPromises = Array.from(channels.keys()).map(channelId => {
      try {
        if (this.discord.channels.cache.has(channelId)) {
          const channel = this.discord.channels.cache.get(channelId);
          if (channel?.isTextBased()) {
            return channel.send(message);
          }
        }
      } catch (err) {
        console.warn(`[Stream] Failed to send alert to ${channelId}:`, err.message);
      }
      return Promise.resolve();
    });

    const results = await Promise.all(channelFetchPromises);
    results.forEach(r => {
      if (r && r.isSent && r.id) {
        // success handled implicitly
      } else if (r instanceof Error) {
        console.warn(`[Stream] Alert delivery error: ${r.message}`);
      }
    });
  }
}

let instance = null;

module.exports = {
  init(discordClient) {
    if (!instance) {
      instance = new AlpacaStream(discordClient);
    }
    return instance;
  },
  getInstance() {
    return instance;
  },
};