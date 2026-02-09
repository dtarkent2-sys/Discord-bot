/**
 * Alpaca Real-Time Market Data Stream
 *
 * Uses the Alpaca WebSocket v2 to stream live trades, quotes, and
 * minute bars into Discord channels.  Discord users manage subscriptions
 * via /stream start|stop|list.
 *
 * Features:
 *   - Per-channel symbol subscriptions (multiple channels can watch the same symbol)
 *   - Big-move alerts: fires when a symbol moves ≥ threshold % within a minute bar
 *   - Periodic live-price summaries posted to subscribed channels
 *   - Auto-reconnect handled by the Alpaca SDK
 *
 * Requires: ALPACA_API_KEY + ALPACA_API_SECRET in .env
 */

const Alpaca = require('@alpacahq/alpaca-trade-api');
const config = require('../config');

// How large a 1-min bar % move must be to trigger an alert
const BIG_MOVE_PCT = 1.5;
// Maximum symbols a single channel can subscribe to
const MAX_SUBS_PER_CHANNEL = 25;
// Cooldown between big-move alerts for the same symbol (ms)
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 min

class AlpacaStream {
  constructor(discordClient) {
    this.discord = discordClient;
    this.alpaca = null;
    this.socket = null;
    this.connected = false;

    // channelId → Set<symbol>
    this.channelSubs = new Map();
    // symbol → Set<channelId>  (reverse index for fast dispatch)
    this.symbolChannels = new Map();

    // symbol → { open, high, low, close, volume, timestamp }
    this.latestBars = new Map();
    // symbol → { price, timestamp }
    this.latestTrades = new Map();
    // symbol → timestamp of last big-move alert
    this.alertCooldowns = new Map();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  get enabled() {
    return !!(config.alpacaApiKey && config.alpacaApiSecret);
  }

  /**
   * Connect to the Alpaca WebSocket.
   * Called lazily on first /stream start to avoid wasting the free-tier connection slot.
   */
  connect() {
    if (!this.enabled) {
      console.warn('[Stream] Alpaca keys not set — WebSocket stream disabled.');
      return;
    }
    if (this.socket) return; // already connected or connecting

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

      // Re-subscribe any symbols that were active before a reconnect
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
      // Only log unexpected errors — connection limit and auth issues are handled by reconnect
      if (!msg.includes('connection limit') && !msg.includes('auth timeout')) {
        console.error('[Stream] WebSocket error:', msg);
      } else {
        console.warn(`[Stream] WebSocket: ${msg} (will retry)`);
      }
    });

    this.socket.onStateChange((state) => {
      console.log(`[Stream] State: ${state}`);
    });

    // ── Data handlers ────────────────────────────────────────────────

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

  // ── Subscription management ────────────────────────────────────────

  /**
   * Subscribe a Discord channel to one or more symbols.
   * @param {string} channelId
   * @param {string[]} symbols
   * @returns {{ added: string[], already: string[], error?: string }}
   */
  subscribe(channelId, symbols) {
    // Lazy-connect: start WebSocket on first subscription
    if (!this.socket && this.enabled) {
      this.connect();
      // Give it a moment to connect — subscriptions will be queued by the SDK
    }
    if (!this.socket) {
      return { added: [], already: [], error: 'WebSocket not available — check Alpaca API keys.' };
    }

    const channelSet = this.channelSubs.get(channelId) || new Set();
    if (channelSet.size >= MAX_SUBS_PER_CHANNEL) {
      return { added: [], already: [], error: `Channel limit reached (${MAX_SUBS_PER_CHANNEL} symbols max).` };
    }

    const added = [];
    const already = [];
    const newToSocket = []; // symbols not yet subscribed at the WS level

    for (const raw of symbols) {
      const sym = raw.toUpperCase();
      if (channelSet.has(sym)) {
        already.push(sym);
        continue;
      }
      if (channelSet.size + added.length >= MAX_SUBS_PER_CHANNEL) break;

      channelSet.add(sym);
      added.push(sym);

      // Update reverse index
      if (!this.symbolChannels.has(sym)) {
        this.symbolChannels.set(sym, new Set());
        newToSocket.push(sym);
      }
      this.symbolChannels.get(sym).add(channelId);
    }

    this.channelSubs.set(channelId, channelSet);

    // Subscribe new symbols at the WebSocket level
    if (newToSocket.length > 0) {
      this.socket.subscribeForTrades(newToSocket);
      this.socket.subscribeForBars(newToSocket);
      console.log(`[Stream] WS subscribed: ${newToSocket.join(', ')}`);
    }

    return { added, already };
  }

  /**
   * Unsubscribe a Discord channel from one or more symbols.
   * @param {string} channelId
   * @param {string[]} symbols
   * @returns {{ removed: string[], notFound: string[] }}
   */
  unsubscribe(channelId, symbols) {
    const channelSet = this.channelSubs.get(channelId);
    if (!channelSet) return { removed: [], notFound: symbols.map(s => s.toUpperCase()) };

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

      // Update reverse index
      const channels = this.symbolChannels.get(sym);
      if (channels) {
        channels.delete(channelId);
        if (channels.size === 0) {
          this.symbolChannels.delete(sym);
          removeFromSocket.push(sym);
        }
      }
    }

    if (channelSet.size === 0) this.channelSubs.delete(channelId);

    // Unsubscribe symbols no longer watched by any channel
    if (removeFromSocket.length > 0) {
      this.socket.unsubscribeFromTrades(removeFromSocket);
      this.socket.unsubscribeFromBars(removeFromSocket);
      console.log(`[Stream] WS unsubscribed: ${removeFromSocket.join(', ')}`);
    }

    return { removed, notFound };
  }

  /**
   * Get all symbols a channel is subscribed to.
   * @param {string} channelId
   * @returns {string[]}
   */
  getSubscriptions(channelId) {
    const set = this.channelSubs.get(channelId);
    return set ? [...set].sort() : [];
  }

  /**
   * Get the latest price snapshot for a symbol (from stream data).
   * @param {string} symbol
   * @returns {{ price: number, timestamp: string } | null}
   */
  getLatestPrice(symbol) {
    return this.latestTrades.get(symbol.toUpperCase()) || null;
  }

  /**
   * Get the latest minute bar for a symbol.
   * @param {string} symbol
   * @returns {object|null}
   */
  getLatestBar(symbol) {
    return this.latestBars.get(symbol.toUpperCase()) || null;
  }

  // ── Status ─────────────────────────────────────────────────────────

  getStatus() {
    return {
      connected: this.connected,
      symbols: this.symbolChannels.size,
      channels: this.channelSubs.size,
      feed: config.alpacaFeed || 'iex',
    };
  }

  // ── Internal event handlers ────────────────────────────────────────

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

    // Check for big move
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

    for (const channelId of channels) {
      try {
        const channel = await this.discord.channels.fetch(channelId);
        if (channel?.isTextBased()) {
          await channel.send(message);
        }
      } catch (err) {
        console.warn(`[Stream] Failed to send alert to ${channelId}:`, err.message);
      }
    }
  }
}

// Export singleton (instantiated with Discord client later via .init())
let instance = null;

module.exports = {
  /**
   * Initialize the stream with a Discord client.  Call once on bot ready.
   * @param {import('discord.js').Client} discordClient
   * @returns {AlpacaStream}
   */
  init(discordClient) {
    if (!instance) {
      instance = new AlpacaStream(discordClient);
    }
    return instance;
  },

  /** @returns {AlpacaStream|null} */
  getInstance() {
    return instance;
  },
};
