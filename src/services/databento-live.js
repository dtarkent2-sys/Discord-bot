/**
 * Databento Live — Real-Time OPRA Streaming via Raw TCP
 *
 * Full Node.js implementation of the Databento Live Subscription Gateway (LSG)
 * protocol. Connects via TCP, authenticates with CRAM-SHA256, subscribes to
 * OPRA options data, and parses DBN binary records into JavaScript objects.
 *
 * Built from official Databento protocol docs + Python/Rust/C++ client source:
 *   https://databento.com/docs/api-reference-live
 *   https://github.com/databento/databento-python
 *   https://github.com/databento/dbn
 *
 * HFT signal engine powered by techniques from:
 *   https://databento.com/blog/hft-sklearn-python
 *   https://databento.com/blog/liquidity-taking-strategy
 *   https://databento.com/blog/vwap-python
 *
 * Emits events:
 *   'trade'       — tick-level fills with aggressor side
 *   'quote'       — consolidated BBO updates (bid/ask/size/count)
 *   'statistic'   — OI, settlement, session high/low
 *   'definition'  — instrument definitions (strike, expiry, underlying)
 *   'ohlcv'       — OHLCV bar updates
 *   'sweep'       — detected intermarket sweep orders (institutional urgency)
 *   'signal'      — HFT signal (book imbalance, VWAP cross, aggression spike)
 *   'error'       — gateway ErrorMsg
 *   'system'      — SystemMsg (heartbeats)
 *   'connected'   — successfully authenticated + streaming
 *   'disconnected' — connection lost
 */

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const config = require('../config');

// ── Constants ──────────────────────────────────────────────────────────

const LSG_PORT = 13000;
const CONNECT_TIMEOUT = 10_000;          // 10s
const AUTH_TIMEOUT = 30_000;             // 30s
const HEARTBEAT_INTERVAL_S = 30;         // Request heartbeat every 30s
const HEARTBEAT_TIMEOUT_MARGIN_S = 10;   // Disconnect after 30+10=40s silence
const RECONNECT_BASE_MS = 2_000;         // 2s initial backoff
const RECONNECT_MAX_MS = 60_000;         // 1min max backoff
const SYMBOL_BATCH_SIZE = 500;           // Max symbols per subscription msg
const PRICE_SCALE = 1_000_000_000;       // Fixed-point 1e-9 scale
const LENGTH_MULTIPLIER = 4;             // Record length field * 4 = byte size
const SWEEP_WINDOW_MS = 100;             // Group trades within 100ms for sweep detection

// DBN record types
const RTYPE = {
  TRADE:       0x00, // MBP-0 / TradeMsg (tick-level fills)
  MBP1:        0x01, // Mbp1Msg (top-of-book + 1 BidAskPair)
  MBP10:       0x0A, // Mbp10Msg (10 levels of depth with order counts)
  STATUS:      0x12, // Trading status
  DEFINITION:  0x13, // InstrumentDefMsg (strikes, expiry, underlying)
  IMBALANCE:   0x14, // Auction imbalance
  ERROR:       0x15, // ErrorMsg (302-byte message + code)
  SYM_MAPPING: 0x16, // Symbol mapping update
  SYSTEM:      0x17, // SystemMsg (heartbeats, acks)
  STATISTICS:  0x18, // StatMsg (OI, settlement, session hi/lo)
  OHLCV_1S:    0x20, OHLCV_1M: 0x21, OHLCV_1H: 0x22, OHLCV_1D: 0x23, OHLCV_EOD: 0x24,
  MBO:         0xA0, // Market-by-order (individual orders)
  CMBP1:       0xB1, // Consolidated MBP-1
  CBBO_1S:     0xC0, CBBO_1M: 0xC1, TCBBO: 0xC2, BBO_1S: 0xC3, BBO_1M: 0xC4,
};

// Stat types (from Databento StatType enum)
const STAT_OPEN_INTEREST = 9;
const STAT_SETTLEMENT = 3;

// Sentinel values
const UNDEF_PRICE = 0x7FFFFFFFFFFFFFFFn;

// ── CRAM Authentication ────────────────────────────────────────────────
// Source: databento-python/databento/common/cram.py

function computeCramResponse(challenge, apiKey) {
  const hash = crypto.createHash('sha256').update(`${challenge}|${apiKey}`).digest('hex');
  return `${hash}-${apiKey.slice(-5)}`;
}

// ── Price conversion ───────────────────────────────────────────────────
// All prices are i64 fixed-point scaled by 1e-9 (1 unit = $0.000000001)

function toPrice(rawBigInt) {
  if (rawBigInt === UNDEF_PRICE) return null;
  return Number(rawBigInt) / PRICE_SCALE;
}

// ── OCC Symbol Parser ─────────────────────────────────────────────────
// OCC/OSI format: "SPY   260213C00605000" (padded to ~21 chars)
// [root][YYMMDD][C/P][strike*1000 zero-padded to 8 digits]

function parseOccSymbol(sym) {
  if (!sym || sym.length < 16) return null;
  // Find where the date digits start (after alpha root)
  let dateStart = 0;
  for (let i = 0; i < Math.min(sym.length, 6); i++) {
    if (sym[i] >= '0' && sym[i] <= '9') { dateStart = i; break; }
    dateStart = i + 1;
  }
  if (dateStart < 1 || sym.length < dateStart + 13) return null;

  const underlying = sym.slice(0, dateStart).trim();
  const dateStr = sym.slice(dateStart, dateStart + 6);
  const cpChar = sym.charAt(dateStart + 6);
  const strikeStr = sym.slice(dateStart + 7);

  const yy = parseInt(dateStr.slice(0, 2), 10);
  return {
    underlying,
    optionType: cpChar === 'C' ? 'call' : cpChar === 'P' ? 'put' : null,
    strikePrice: parseInt(strikeStr, 10) / 1000,
    expirationDate: `20${yy}-${dateStr.slice(2, 4)}-${dateStr.slice(4, 6)}`,
  };
}

// ── Null-terminated C string extraction ────────────────────────────────

function readCStr(buf, off, len) {
  if (off + len > buf.length) return '';
  const slice = buf.subarray(off, off + len);
  const nullIdx = slice.indexOf(0);
  return slice.subarray(0, nullIdx >= 0 ? nullIdx : len).toString('ascii').trim();
}

// ── DBN Record Parsers ────────────────────────────────────────────────

function parseRecordHeader(buf, off) {
  return {
    recordSize: buf.readUInt8(off) * LENGTH_MULTIPLIER,
    rtype: buf.readUInt8(off + 1),
    publisherId: buf.readUInt16LE(off + 2),
    instrumentId: buf.readUInt32LE(off + 4),
    tsEvent: buf.readBigUInt64LE(off + 8),
  };
}

function parseTrade(buf, off) {
  const hd = parseRecordHeader(buf, off);
  return {
    type: 'trade',
    ...hd,
    price: toPrice(buf.readBigInt64LE(off + 16)),
    size: buf.readUInt32LE(off + 24),
    action: String.fromCharCode(buf.readUInt8(off + 28)),
    side: String.fromCharCode(buf.readUInt8(off + 29)),  // 'A'=ask aggressor, 'B'=bid aggressor, 'N'=none
    flags: buf.readUInt8(off + 30),
    depth: buf.readUInt8(off + 31),
    tsRecv: buf.readBigUInt64LE(off + 32),
    tsInDelta: buf.readInt32LE(off + 40),
    sequence: buf.readUInt32LE(off + 44),
  };
}

function parseBidAskPair(buf, off) {
  return {
    bidPx: toPrice(buf.readBigInt64LE(off)),
    askPx: toPrice(buf.readBigInt64LE(off + 8)),
    bidSz: buf.readUInt32LE(off + 16),
    askSz: buf.readUInt32LE(off + 20),
    bidCt: buf.readUInt32LE(off + 24),
    askCt: buf.readUInt32LE(off + 28),
  };
}

function parseQuote(buf, off) {
  const hd = parseRecordHeader(buf, off);
  const base = {
    type: 'quote',
    ...hd,
    price: toPrice(buf.readBigInt64LE(off + 16)),
    size: buf.readUInt32LE(off + 24),
    action: String.fromCharCode(buf.readUInt8(off + 28)),
    side: String.fromCharCode(buf.readUInt8(off + 29)),
    flags: buf.readUInt8(off + 30),
    depth: buf.readUInt8(off + 31),
    tsRecv: buf.readBigUInt64LE(off + 32),
    tsInDelta: buf.readInt32LE(off + 40),
    sequence: buf.readUInt32LE(off + 44),
  };
  if (hd.recordSize >= 80) {
    base.level = parseBidAskPair(buf, off + 48);
  }
  return base;
}

function parseStat(buf, off) {
  const hd = parseRecordHeader(buf, off);
  return {
    type: 'statistic',
    ...hd,
    tsRecv: buf.readBigUInt64LE(off + 16),
    tsRef: buf.readBigUInt64LE(off + 24),
    price: toPrice(buf.readBigInt64LE(off + 32)),
    quantity: buf.readBigInt64LE(off + 40),
    sequence: buf.readUInt32LE(off + 48),
    tsInDelta: buf.readInt32LE(off + 52),
    statType: buf.readUInt16LE(off + 56),
    channelId: buf.readUInt16LE(off + 58),
    updateAction: buf.readUInt8(off + 60),
    statFlags: buf.readUInt8(off + 61),
  };
}

function parseOhlcv(buf, off) {
  const hd = parseRecordHeader(buf, off);
  return {
    type: 'ohlcv', ...hd,
    open: toPrice(buf.readBigInt64LE(off + 16)),
    high: toPrice(buf.readBigInt64LE(off + 24)),
    low: toPrice(buf.readBigInt64LE(off + 32)),
    close: toPrice(buf.readBigInt64LE(off + 40)),
    volume: Number(buf.readBigUInt64LE(off + 48)),
  };
}

/**
 * Parse InstrumentDefMsg — handles both DBN v1 and v2+ layouts.
 *
 * The numeric prefix (offsets 0-111) is identical in both versions.
 * V1 has strike_price at offset 112 as an i64 (same fixed-point 1e-9 scale).
 * String fields diverge after the numeric block due to different
 * field sizes (currency 4→6 bytes, raw_symbol 22→71 bytes, etc).
 *
 * V1 layout (from dbn/src/compat.rs):
 *   offset 112: strike_price (i64)
 *   offset 164: contract_multiplier (i32)
 *   offset 202: raw_symbol (22 bytes, null-terminated)
 *   offset 302: underlying (21 bytes)
 *   offset 245: exchange (5 bytes)
 *   offset 327: instrument_class (1 byte)
 *
 * V2+ layout (from dbn/src/record.rs):
 *   offset 196: raw_symbol (71 bytes, null-terminated)
 *   offset 156: contract_multiplier (i32)
 */
function parseInstrumentDef(buf, off, recordSize, dbnVersion) {
  const hd = parseRecordHeader(buf, off);

  // Numeric fields before any divergence — identical in v1 and v2
  const result = {
    type: 'definition',
    ...hd,
    tsRecv: buf.readBigUInt64LE(off + 16),
    minPriceIncrement: toPrice(buf.readBigInt64LE(off + 24)),
    expiration: buf.readBigUInt64LE(off + 40),
  };

  if (dbnVersion === 1) {
    // V1-specific offsets (verified from dbn/src/compat.rs InstrumentDefMsgV1)
    if (recordSize >= 120) result.strikePrice = toPrice(buf.readBigInt64LE(off + 112));
    if (recordSize >= 168) result.contractMultiplier = buf.readInt32LE(off + 164);
    if (recordSize >= 224) result.rawSymbol = readCStr(buf, off + 202, 22);
    if (recordSize >= 323) result.underlying = readCStr(buf, off + 302, 21);
    if (recordSize >= 250) result.exchange = readCStr(buf, off + 245, 5);
    if (recordSize >= 328) result.instrumentClass = String.fromCharCode(buf.readUInt8(off + 327));
  } else {
    // V2+ offsets (from dbn/src/record.rs InstrumentDefMsg)
    if (recordSize >= 160) result.contractMultiplier = buf.readInt32LE(off + 156);
    if (recordSize >= 267) result.rawSymbol = readCStr(buf, off + 196, 71);
  }

  // Default contract multiplier for options
  if (!result.contractMultiplier) result.contractMultiplier = 100;

  // Parse OCC symbol for underlying, strike, type, expiration
  const occ = parseOccSymbol(result.rawSymbol);
  if (occ) {
    result.underlying = result.underlying || occ.underlying;
    result.optionType = occ.optionType;
    // OCC strike is more reliable than struct field for V1 offset ambiguity
    if (!result.strikePrice) result.strikePrice = occ.strikePrice;
    result.expirationDate = occ.expirationDate;
  }

  // Fallback: use expiration timestamp if OCC parse didn't yield a date
  if (!result.expirationDate && result.expiration && result.expiration !== 0xFFFFFFFFFFFFFFFFn) {
    result.expirationDate = new Date(Number(result.expiration / 1_000_000n)).toISOString().slice(0, 10);
  }

  return result;
}

function parseError(buf, off) {
  const hd = parseRecordHeader(buf, off);
  return {
    type: 'error', ...hd,
    message: readCStr(buf, off + 16, 302),
    code: buf.readUInt8(off + 318),
    isLast: buf.readUInt8(off + 319),
  };
}

function parseSystem(buf, off) {
  const hd = parseRecordHeader(buf, off);
  return {
    type: 'system', ...hd,
    message: readCStr(buf, off + 16, 303),
    code: buf.readUInt8(off + 319),
  };
}

// ── DatabentoLive Client ──────────────────────────────────────────────

class DatabentoLive extends EventEmitter {
  constructor() {
    super();
    this._socket = null;
    this._state = 'disconnected';
    this._buffer = Buffer.alloc(0);
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._heartbeatTimer = null;
    this._lastMessageAt = 0;
    this._subscriptions = [];
    this._sessionId = null;
    this._lsgVersion = null;
    this._metadataParsed = false;
    this._dbnVersion = 2;
    this._tsOut = false;
    this._symbolCstrLen = 71;

    // Instrument lookup (instrumentId → definition)
    this._instruments = new Map();

    // Live OI + quotes per instrument (for building live options chains)
    this._oi = new Map();           // instrumentId → OI number
    this._quotes = new Map();       // instrumentId → { bid, ask, bidSz, askSz }

    // Stats tracking
    this._stats = {
      connected: false,
      recordsReceived: 0,
      tradesReceived: 0,
      quotesReceived: 0,
      statsReceived: 0,
      defsReceived: 0,
      errorsReceived: 0,
      bytesReceived: 0,
      lastRecordAt: null,
      connectedAt: null,
    };
  }

  get enabled() {
    return !!(config.databentoApiKey && config.databentoLive);
  }

  get connected() {
    return this._state === 'streaming';
  }

  /**
   * Add a subscription. Call before connect().
   * Symbols are auto-batched in chunks of 500 per the LSG protocol.
   * @param {string} schema - e.g. 'trades', 'definition', 'statistics'
   * @param {string} stypeIn - e.g. 'parent'
   * @param {string[]} symbols - e.g. ['SPY.OPT']
   * @param {number} [start] - 0 = replay from session start (gets all accumulated data)
   */
  subscribe(schema, stypeIn, symbols, start) {
    this._subscriptions.push({ schema, stypeIn, symbols, start });
    return this;
  }

  connect(dataset = 'OPRA.PILLAR') {
    if (!config.databentoApiKey) {
      console.warn('[DatabentoLive] No API key configured — skipping');
      return;
    }
    if (!config.databentoLive) {
      console.log('[DatabentoLive] Live streaming disabled (set DATABENTO_LIVE=true to enable)');
      return;
    }
    this._dataset = dataset;
    this._hostname = dataset.toLowerCase().replace(/\./g, '-') + '.lsg.databento.com';
    console.log(`[DatabentoLive] Connecting to ${this._hostname}:${LSG_PORT}...`);
    this._doConnect();
  }

  disconnect() {
    this._stopHeartbeatMonitor();
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._state = 'disconnected';
    if (this._socket) { this._socket.destroy(); this._socket = null; }
    this._stats.connected = false;
    console.log('[DatabentoLive] Disconnected');
  }

  getStatus() {
    return {
      enabled: this.enabled,
      state: this._state,
      sessionId: this._sessionId,
      lsgVersion: this._lsgVersion,
      dbnVersion: this._dbnVersion,
      subscriptions: this._subscriptions.length,
      instruments: this._instruments.size,
      ...this._stats,
    };
  }

  getInstrument(instrumentId) {
    return this._instruments.get(instrumentId);
  }

  // ── Internal: TCP Connection ─────────────────────────────────────────

  _doConnect() {
    this._buffer = Buffer.alloc(0);
    this._metadataParsed = false;
    this._state = 'greeting';

    const socket = net.createConnection({
      host: this._hostname,
      port: LSG_PORT,
      timeout: CONNECT_TIMEOUT,
    });

    socket.on('connect', () => {
      console.log(`[DatabentoLive] TCP connected to ${this._hostname}:${LSG_PORT}`);
      socket.setTimeout(0);
    });

    socket.on('data', (chunk) => {
      this._stats.bytesReceived += chunk.length;
      this._lastMessageAt = Date.now();
      this._buffer = Buffer.concat([this._buffer, chunk]);
      this._processBuffer();
    });

    socket.on('error', (err) => {
      console.error(`[DatabentoLive] Socket error: ${err.message}`);
      this.emit('error', err);
    });

    socket.on('close', () => {
      const wasStreaming = this._state === 'streaming';
      this._state = 'disconnected';
      this._stats.connected = false;
      this._socket = null;
      this._stopHeartbeatMonitor();
      console.warn('[DatabentoLive] Connection closed');
      this.emit('disconnected');
      if (wasStreaming || this._reconnectAttempt > 0) {
        this._scheduleReconnect();
      }
    });

    socket.on('timeout', () => {
      console.error('[DatabentoLive] Connection timed out');
      socket.destroy();
    });

    this._socket = socket;
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectAttempt++;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempt - 1), RECONNECT_MAX_MS);
    console.log(`[DatabentoLive] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempt})...`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._doConnect();
    }, delay);
  }

  // ── Heartbeat Monitor ────────────────────────────────────────────────
  // Per Databento docs: disconnect if no message for heartbeat_interval + 10s

  _startHeartbeatMonitor() {
    this._stopHeartbeatMonitor();
    const timeoutMs = (HEARTBEAT_INTERVAL_S + HEARTBEAT_TIMEOUT_MARGIN_S) * 1000;
    this._heartbeatTimer = setInterval(() => {
      const gap = Date.now() - this._lastMessageAt;
      if (gap > timeoutMs) {
        console.error(`[DatabentoLive] Heartbeat timeout (${Math.round(gap / 1000)}s silence). Reconnecting...`);
        if (this._socket) this._socket.destroy();
      }
    }, 5000); // Check every 5s
  }

  _stopHeartbeatMonitor() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
  }

  // ── Internal: Buffer Processing ──────────────────────────────────────

  _processBuffer() {
    if (this._state !== 'streaming') {
      this._processControlMessages();
      return;
    }
    if (!this._metadataParsed) {
      this._processMetadata();
      return;
    }
    this._processRecords();
  }

  _processControlMessages() {
    while (true) {
      const nlIndex = this._buffer.indexOf(0x0A);
      if (nlIndex < 0) return;
      const line = this._buffer.subarray(0, nlIndex).toString('utf-8').trim();
      this._buffer = this._buffer.subarray(nlIndex + 1);
      if (!line) continue;

      const fields = {};
      for (const token of line.split('|')) {
        const eqIdx = token.indexOf('=');
        if (eqIdx >= 0) fields[token.slice(0, eqIdx)] = token.slice(eqIdx + 1);
        else fields[token] = '';
      }
      this._handleControlMessage(fields);
    }
  }

  _handleControlMessage(fields) {
    if (fields.lsg_version !== undefined) {
      this._lsgVersion = fields.lsg_version;
      this._state = 'challenge';
      console.log(`[DatabentoLive] Gateway version: ${this._lsgVersion}`);

    } else if (fields.cram !== undefined) {
      const cramResponse = computeCramResponse(fields.cram, config.databentoApiKey);
      // Include heartbeat_interval_s for reliable timeout detection
      const authMsg = [
        `auth=${cramResponse}`,
        `dataset=${this._dataset}`,
        `encoding=dbn`,
        `ts_out=0`,
        `heartbeat_interval_s=${HEARTBEAT_INTERVAL_S}`,
        `client=Billy/1.0 Node.js/${process.version}`,
      ].join('|') + '\n';
      this._state = 'authenticating';
      this._socket.write(authMsg);
      console.log('[DatabentoLive] Sent CRAM authentication (heartbeat=30s)');

    } else if (fields.success !== undefined) {
      if (fields.success === '1') {
        this._sessionId = fields.session_id;
        this._reconnectAttempt = 0;
        console.log(`[DatabentoLive] Authenticated! Session: ${this._sessionId}`);
        this._sendSubscriptions();
      } else {
        console.error(`[DatabentoLive] Auth failed: ${fields.error || 'Unknown'}`);
        this.emit('error', new Error(`Auth failed: ${fields.error}`));
        this._socket.destroy();
      }
    }
  }

  _sendSubscriptions() {
    if (this._subscriptions.length === 0) {
      // Default: subscribe to everything Billy needs for SPY + QQQ + IWM options
      // start=0 for definitions + statistics replays all data from session start
      // (gets full instrument universe + OI published pre-market before 9:30 ET)
      const syms = ['SPY.OPT', 'QQQ.OPT', 'IWM.OPT'];
      this._subscriptions = [
        { schema: 'trades', stypeIn: 'parent', symbols: syms },
        { schema: 'cbbo-1s', stypeIn: 'parent', symbols: syms },
        { schema: 'statistics', stypeIn: 'parent', symbols: syms, start: 0 },
        { schema: 'definition', stypeIn: 'parent', symbols: syms, start: 0 },
      ];
    }

    for (const sub of this._subscriptions) {
      const allSymbols = Array.isArray(sub.symbols) ? sub.symbols : [sub.symbols];

      // Batch symbols in chunks of 500 per Databento protocol
      for (let i = 0; i < allSymbols.length; i += SYMBOL_BATCH_SIZE) {
        const chunk = allSymbols.slice(i, i + SYMBOL_BATCH_SIZE);
        const isLast = (i + SYMBOL_BATCH_SIZE >= allSymbols.length) ? 1 : 0;
        let msg = `schema=${sub.schema}|stype_in=${sub.stypeIn}|symbols=${chunk.join(',')}`;
        // start=0 replays all data from the current session (definitions + OI history)
        if (sub.start !== undefined) msg += `|start=${sub.start}`;
        msg += `|is_last=${isLast}\n`;
        this._socket.write(msg);
      }
      console.log(`[DatabentoLive] Subscribed: ${sub.schema} → ${allSymbols.join(',')}`);
    }

    // Start session — switches from text to binary DBN stream
    this._socket.write('start_session\n');
    this._state = 'streaming';
    this._stats.connected = true;
    this._stats.connectedAt = new Date();
    this._lastMessageAt = Date.now();
    this._startHeartbeatMonitor();
    console.log('[DatabentoLive] Session started — streaming binary DBN data');
    this.emit('connected', { sessionId: this._sessionId });
  }

  _processMetadata() {
    if (this._buffer.length < 8) return;

    const magic = this._buffer.subarray(0, 3).toString('ascii');
    if (magic !== 'DBN') {
      console.error(`[DatabentoLive] Invalid DBN magic: ${magic}`);
      this._socket.destroy();
      return;
    }

    const version = this._buffer.readUInt8(3);
    const metadataLen = this._buffer.readUInt32LE(4);
    const totalMetaBytes = 8 + metadataLen;
    if (this._buffer.length < totalMetaBytes) return;

    const metaBuf = this._buffer.subarray(8, 8 + metadataLen);
    const dataset = metaBuf.subarray(0, 16).toString('ascii').replace(/\0/g, '').trim();

    let tsOut, symbolCstrLen;
    if (version === 1) {
      // V1: no symbol_cstr_len field; tsOut shifted by 8 bytes (record_count at 34)
      tsOut = metadataLen > 52 ? metaBuf.readUInt8(52) : 0;
      symbolCstrLen = 22;
    } else {
      tsOut = metadataLen > 44 ? metaBuf.readUInt8(44) : 0;
      symbolCstrLen = metadataLen > 46 ? metaBuf.readUInt16LE(45) : 71;
      if (symbolCstrLen === 0 || symbolCstrLen === 0xFFFF) symbolCstrLen = 71;
    }

    this._dbnVersion = version;
    this._tsOut = tsOut === 1;
    this._symbolCstrLen = symbolCstrLen;

    console.log(`[DatabentoLive] DBN v${version} metadata: dataset=${dataset}, symbolLen=${symbolCstrLen}, tsOut=${this._tsOut}`);

    this._buffer = this._buffer.subarray(totalMetaBytes);
    this._metadataParsed = true;
    this._processRecords();
  }

  _processRecords() {
    while (this._buffer.length >= 1) {
      const lengthWord = this._buffer.readUInt8(0);
      const recordSize = lengthWord * LENGTH_MULTIPLIER;

      if (recordSize < 16) {
        this._buffer = this._buffer.subarray(1);
        continue;
      }
      if (this._buffer.length < recordSize) return;

      const rtype = this._buffer.readUInt8(1);
      try {
        this._dispatchRecord(rtype, this._buffer, 0, recordSize);
      } catch (err) {
        console.error(`[DatabentoLive] Record parse error (rtype=0x${rtype.toString(16)}, size=${recordSize}): ${err.message}`);
      }

      this._buffer = this._buffer.subarray(recordSize);
      this._stats.recordsReceived++;
      this._stats.lastRecordAt = new Date();
    }
  }

  _dispatchRecord(rtype, buf, off, size) {
    switch (rtype) {
      case RTYPE.TRADE: {
        const trade = parseTrade(buf, off);
        this._stats.tradesReceived++;
        this.emit('trade', this._enrichWithInstrument(trade));
        break;
      }
      case RTYPE.MBP1: case RTYPE.CMBP1: case RTYPE.CBBO_1S:
      case RTYPE.CBBO_1M: case RTYPE.TCBBO: case RTYPE.BBO_1S: case RTYPE.BBO_1M: {
        const quote = parseQuote(buf, off);
        this._stats.quotesReceived++;
        // Track latest BBO per instrument for live chain building
        if (quote.level) {
          const { bidPx, askPx, bidSz, askSz } = quote.level;
          if (bidPx > 0 || askPx > 0) {
            this._quotes.set(quote.instrumentId, { bid: bidPx, ask: askPx, bidSz, askSz });
          }
        }
        this.emit('quote', this._enrichWithInstrument(quote));
        break;
      }
      case RTYPE.STATISTICS: {
        const stat = parseStat(buf, off);
        this._stats.statsReceived++;
        // Track OI per instrument for live chain building
        if (stat.statType === STAT_OPEN_INTEREST) {
          const oi = Number(stat.quantity);
          if (oi > 0) this._oi.set(stat.instrumentId, oi);
        }
        this.emit('statistic', this._enrichWithInstrument(stat));
        break;
      }
      case RTYPE.DEFINITION: {
        // V1 ~332 bytes, V2+ ~520 bytes — accept anything with raw_symbol
        if (size >= 220) {
          const def = parseInstrumentDef(buf, off, size, this._dbnVersion);
          this._stats.defsReceived++;
          this._instruments.set(def.instrumentId, def);
          this.emit('definition', def);
        }
        break;
      }
      case RTYPE.OHLCV_1S: case RTYPE.OHLCV_1M: case RTYPE.OHLCV_1H:
      case RTYPE.OHLCV_1D: case RTYPE.OHLCV_EOD: {
        this.emit('ohlcv', this._enrichWithInstrument(parseOhlcv(buf, off)));
        break;
      }
      case RTYPE.ERROR: {
        if (size >= 320) {
          const err = parseError(buf, off);
          this._stats.errorsReceived++;
          console.error(`[DatabentoLive] Gateway error: ${err.message} (code=${err.code})`);
          this.emit('error', err);
        }
        break;
      }
      case RTYPE.SYSTEM: {
        if (size >= 320) {
          const sys = parseSystem(buf, off);
          if (sys.message) console.log(`[DatabentoLive] System: ${sys.message} (code=${sys.code})`);
          this.emit('system', sys);
        }
        break;
      }
    }
  }

  _enrichWithInstrument(record) {
    const def = this._instruments.get(record.instrumentId);
    if (def) {
      record.rawSymbol = def.rawSymbol;
      record.underlying = def.underlying;
      record.strike = def.strikePrice;
      record.optionType = def.optionType;
      record.expirationDate = def.expirationDate;
      record.multiplier = def.contractMultiplier;
    }
    return record;
  }

  // ── Live Options Chain Builder ─────────────────────────────────────────
  // Build a complete options chain from accumulated live stream data.
  // Uses definitions, OI, and quotes collected during the session.

  /**
   * Get available expiration dates for a ticker from live instrument definitions.
   * @param {string} ticker
   * @returns {string[]} Sorted YYYY-MM-DD dates
   */
  getExpirations(ticker) {
    const upper = ticker.toUpperCase();
    const today = new Date().toISOString().slice(0, 10);
    const exps = new Set();
    for (const def of this._instruments.values()) {
      if (def.underlying === upper && def.expirationDate && def.expirationDate >= today) {
        exps.add(def.expirationDate);
      }
    }
    return [...exps].sort();
  }

  /**
   * Build a normalized options chain from live stream data.
   * Includes OI from stat events and mid-price from quotes.
   *
   * @param {string} ticker
   * @param {string} expirationDate - YYYY-MM-DD
   * @returns {object[]} Contracts with strike, type, OI, bid, ask, midPrice
   */
  getOptionsChain(ticker, expirationDate) {
    const upper = ticker.toUpperCase();
    const contracts = [];

    for (const [instrId, def] of this._instruments) {
      if (def.underlying !== upper) continue;
      if (def.expirationDate !== expirationDate) continue;
      if (!def.optionType || !def.strikePrice) continue;

      const oi = this._oi.get(instrId) || 0;
      const quote = this._quotes.get(instrId) || { bid: 0, ask: 0, bidSz: 0, askSz: 0 };
      const mid = quote.bid > 0 && quote.ask > 0 ? (quote.bid + quote.ask) / 2 : 0;

      contracts.push({
        symbol: def.rawSymbol,
        ticker: upper,
        strike: def.strikePrice,
        expiration: expirationDate,
        type: def.optionType,
        openInterest: oi,
        volume: 0,
        lastPrice: mid,
        bid: quote.bid,
        ask: quote.ask,
        bidSize: quote.bidSz,
        askSize: quote.askSz,
        // No greeks from OPRA — caller must compute via BS
        delta: 0, gamma: 0, theta: 0, vega: 0,
        impliedVolatility: 0,
        _source: 'databento-live',
      });
    }

    contracts.sort((a, b) => a.strike - b.strike);
    return contracts;
  }

  /**
   * Check if we have enough live data to build a meaningful chain.
   * With start=0 subscription, definitions + OI replay from session start,
   * so data accumulates quickly after connection.
   */
  hasDataFor(ticker) {
    if (!this.connected) return false;
    // Allow at least 10 seconds for the session replay to arrive
    const connectedAt = this._stats.connectedAt;
    if (connectedAt && (Date.now() - connectedAt.getTime()) < 10000) return false;

    const upper = ticker.toUpperCase();
    let defCount = 0;
    let oiCount = 0;
    for (const [instrId, def] of this._instruments) {
      if (def.underlying === upper) {
        defCount++;
        if (this._oi.has(instrId)) oiCount++;
      }
    }
    // With start=0 replay we get the full instrument universe quickly.
    // Need at least 20 definitions (some OI may be sparse during off-hours).
    // If we have definitions but no OI, still allow it — gamma can be estimated from quotes alone.
    return defCount >= 20 && (oiCount >= 5 || defCount >= 100);
  }
}

// ── HFT Signal Engine ─────────────────────────────────────────────────
// Techniques from Databento's HFT blog series:
//   - Book skew (bid/ask size imbalance) — primary alpha signal
//   - VWAP tracking — reference price for directional conviction
//   - Trade aggression ratio — buyer vs seller initiated volume
//   - Intermarket sweep detection — institutional urgency indicator
//   - Volume anomaly detection — unusual activity flagging

class HftSignalEngine {
  constructor(liveClient) {
    this._live = liveClient;

    // Per-underlying state
    this._book = new Map();       // underlying → { bidSz, askSz, skew, midPx }
    this._vwap = new Map();       // underlying → { cumPV, cumVol, vwap }
    this._aggression = new Map(); // underlying → { buyVol, sellVol, ratio }

    // Sweep detection buffers (instrumentId → recent trades within window)
    this._sweepBuffer = new Map();
    this._sweepFlushTimer = null;

    // Wire events
    this._live.on('quote', (q) => this._onQuote(q));
    this._live.on('trade', (t) => this._onTradeSignal(t));
    this._live.on('connected', () => this._startSweepFlush());
    this._live.on('disconnected', () => this._stopSweepFlush());
  }

  // ── Book Skew Signal ──────────────────────────────────────────
  // log(bid_sz) - log(ask_sz) > 0 → more resting bids → upward pressure
  // From: https://databento.com/blog/hft-sklearn-python

  _onQuote(quote) {
    if (!quote.underlying || !quote.level) return;
    const { bidSz, askSz, bidPx, askPx } = quote.level;
    if (!bidSz || !askSz || !bidPx || !askPx) return;

    const ticker = quote.underlying;
    const skew = Math.log(bidSz) - Math.log(askSz);
    const midPx = (bidPx + askPx) / 2;

    const prev = this._book.get(ticker);
    this._book.set(ticker, { bidSz, askSz, bidPx, askPx, skew, midPx, ts: Date.now() });

    // Emit signal on significant skew change (threshold from Databento HFT example: 1.7)
    if (prev && Math.abs(skew) > 1.0 && Math.sign(skew) !== Math.sign(prev.skew || 0)) {
      this._live.emit('signal', {
        type: 'book_skew_flip',
        ticker,
        skew: +skew.toFixed(3),
        direction: skew > 0 ? 'BULLISH' : 'BEARISH',
        bidSz, askSz, midPx,
        time: Date.now(),
      });
    }
  }

  // ── VWAP + Aggression Tracking ──────────────────────────────────
  // Running VWAP: cumulative(price * volume) / cumulative(volume)
  // Trade aggression: 'A' = buyer crosses spread, 'B' = seller crosses

  _onTradeSignal(trade) {
    if (!trade.underlying || !trade.price || !trade.size) return;
    const ticker = trade.underlying;

    // VWAP update
    let v = this._vwap.get(ticker);
    if (!v) { v = { cumPV: 0, cumVol: 0, vwap: 0 }; this._vwap.set(ticker, v); }
    v.cumPV += trade.price * trade.size;
    v.cumVol += trade.size;
    v.vwap = v.cumPV / v.cumVol;

    // Aggression tracking
    let agg = this._aggression.get(ticker);
    if (!agg) { agg = { buyVol: 0, sellVol: 0, ratio: 0.5 }; this._aggression.set(ticker, agg); }
    if (trade.side === 'A') agg.buyVol += trade.size;
    else if (trade.side === 'B') agg.sellVol += trade.size;
    const totalVol = agg.buyVol + agg.sellVol;
    agg.ratio = totalVol > 0 ? agg.buyVol / totalVol : 0.5;

    // Sweep detection: buffer trades by instrumentId
    const instId = trade.instrumentId;
    let buf = this._sweepBuffer.get(instId);
    if (!buf) { buf = []; this._sweepBuffer.set(instId, buf); }
    buf.push({
      publisherId: trade.publisherId,
      price: trade.price,
      size: trade.size,
      side: trade.side,
      time: Date.now(),
      underlying: ticker,
      strike: trade.strike,
      optionType: trade.optionType,
      expirationDate: trade.expirationDate,
    });
  }

  // ── Sweep Detection ─────────────────────────────────────────────
  // Intermarket sweep: same options series trades across multiple
  // exchanges within 100ms. Indicates institutional urgency.
  // Source: https://databento.com/blog/opra-data

  _startSweepFlush() {
    this._stopSweepFlush();
    this._sweepFlushTimer = setInterval(() => this._flushSweeps(), 200);
  }

  _stopSweepFlush() {
    if (this._sweepFlushTimer) { clearInterval(this._sweepFlushTimer); this._sweepFlushTimer = null; }
  }

  _flushSweeps() {
    const now = Date.now();
    const cutoff = now - SWEEP_WINDOW_MS;

    for (const [instId, trades] of this._sweepBuffer) {
      // Remove stale trades
      while (trades.length > 0 && trades[0].time < cutoff) trades.shift();
      if (trades.length === 0) { this._sweepBuffer.delete(instId); continue; }

      // Check for sweep: 3+ trades from 2+ different publishers within the window
      if (trades.length >= 3) {
        const publishers = new Set(trades.map(t => t.publisherId));
        if (publishers.size >= 2) {
          const totalSize = trades.reduce((s, t) => s + t.size, 0);
          const totalPremium = trades.reduce((s, t) => s + t.price * t.size * 100, 0);
          const sample = trades[0];

          // Only emit if premium is meaningful ($25K+)
          if (totalPremium >= 25_000) {
            this._live.emit('sweep', {
              instrumentId: instId,
              underlying: sample.underlying,
              strike: sample.strike,
              optionType: sample.optionType,
              expirationDate: sample.expirationDate,
              legs: trades.length,
              exchanges: publishers.size,
              totalSize,
              totalPremium: Math.round(totalPremium),
              side: trades.filter(t => t.side === 'A').length > trades.length / 2 ? 'buy' : 'sell',
              time: now,
            });
          }

          // Clear buffer after emission to avoid double-counting
          trades.length = 0;
        }
      }
    }
  }

  // ── Query Methods ───────────────────────────────────────────────

  getBookState(ticker) {
    return this._book.get(ticker.toUpperCase()) || null;
  }

  getVwap(ticker) {
    const v = this._vwap.get(ticker.toUpperCase());
    return v ? v.vwap : null;
  }

  getAggression(ticker) {
    return this._aggression.get(ticker.toUpperCase()) || null;
  }

  /**
   * Get a composite signal summary for a ticker.
   * Combines book skew + VWAP position + aggression into a single conviction score.
   */
  getSignal(ticker) {
    const tk = ticker.toUpperCase();
    const book = this._book.get(tk);
    const vwap = this._vwap.get(tk);
    const agg = this._aggression.get(tk);

    if (!book && !vwap && !agg) return null;

    let bullScore = 0, bearScore = 0;

    // Book skew contribution (-2 to +2)
    if (book && book.skew) {
      const clamped = Math.max(-2, Math.min(2, book.skew));
      if (clamped > 0) bullScore += clamped;
      else bearScore += Math.abs(clamped);
    }

    // VWAP position contribution (-1 to +1)
    if (book && vwap && vwap.vwap > 0 && book.midPx > 0) {
      const vwapDelta = (book.midPx - vwap.vwap) / vwap.vwap;
      if (vwapDelta > 0.001) bullScore += Math.min(1, vwapDelta * 100);
      else if (vwapDelta < -0.001) bearScore += Math.min(1, Math.abs(vwapDelta) * 100);
    }

    // Aggression contribution (-1 to +1)
    if (agg) {
      const aggressorBias = (agg.ratio - 0.5) * 2; // -1 to +1
      if (aggressorBias > 0.1) bullScore += Math.min(1, aggressorBias);
      else if (aggressorBias < -0.1) bearScore += Math.min(1, Math.abs(aggressorBias));
    }

    const netScore = bullScore - bearScore;
    return {
      ticker: tk,
      bookSkew: book ? +book.skew.toFixed(3) : null,
      vwap: vwap ? +vwap.vwap.toFixed(4) : null,
      midPx: book ? +book.midPx.toFixed(4) : null,
      aggressionRatio: agg ? +agg.ratio.toFixed(3) : null,
      buyVolume: agg ? agg.buyVol : 0,
      sellVolume: agg ? agg.sellVol : 0,
      bullScore: +bullScore.toFixed(2),
      bearScore: +bearScore.toFixed(2),
      netScore: +netScore.toFixed(2),
      direction: Math.abs(netScore) < 0.3 ? 'NEUTRAL' : netScore > 0 ? 'BULLISH' : 'BEARISH',
      confidence: Math.min(1, Math.abs(netScore) / 3).toFixed(2),
    };
  }

  /**
   * Reset all signal state (e.g. at market open).
   */
  reset() {
    this._book.clear();
    this._vwap.clear();
    this._aggression.clear();
    this._sweepBuffer.clear();
  }
}

// ── LiveFlowTracker ───────────────────────────────────────────────────
// Aggregates trades into rolling flow metrics compatible with
// databento.js getOrderFlow() for the rest of Billy's pipeline.

class LiveFlowTracker {
  constructor(liveClient, signalEngine) {
    this._live = liveClient;
    this._signals = signalEngine;
    this._flows = new Map();
    this._sweeps = [];           // Recent sweeps across all tickers
    this._windowMs = 15 * 60 * 1000;

    this._live.on('trade', (t) => this._onTrade(t));
    this._live.on('statistic', (s) => this._onStat(s));
    this._live.on('sweep', (sw) => this._onSweep(sw));
  }

  _onTrade(trade) {
    if (!trade.underlying || !trade.price || !trade.size) return;

    const ticker = trade.underlying;
    let flow = this._flows.get(ticker);
    if (!flow) { flow = this._emptyFlow(ticker); this._flows.set(ticker, flow); }

    const premium = trade.price * trade.size * (trade.multiplier || 100);
    const isBuy = trade.side === 'A';
    const isSell = trade.side === 'B';
    const signedPremium = isBuy ? premium : isSell ? -premium : 0;

    flow.tradeCount++;

    if (trade.optionType === 'call') {
      flow.callVolume += trade.size;
      flow.callPremium += signedPremium;
    } else if (trade.optionType === 'put') {
      flow.putVolume += trade.size;
      flow.putPremium += signedPremium;
    }

    // Large blocks ($50K+ notional)
    if (Math.abs(premium) >= 50_000) {
      flow.largeBlocks.push({
        strike: trade.strike,
        type: trade.optionType,
        expiration: trade.expirationDate,
        size: trade.size,
        price: trade.price,
        premium: Math.round(premium),
        side: isBuy ? 'buy' : isSell ? 'sell' : 'unknown',
        time: Date.now(),
      });
      if (flow.largeBlocks.length > 100) flow.largeBlocks = flow.largeBlocks.slice(-100);
    }

    // Per-strike volume
    if (trade.strike) {
      const sv = flow.strikeVolume.get(trade.strike) || { calls: 0, puts: 0, premium: 0 };
      if (trade.optionType === 'call') sv.calls += trade.size;
      else if (trade.optionType === 'put') sv.puts += trade.size;
      sv.premium += Math.abs(premium);
      flow.strikeVolume.set(trade.strike, sv);
    }

    flow.lastUpdate = Date.now();
  }

  _onStat(stat) {
    if (stat.statType !== STAT_OPEN_INTEREST || !stat.underlying) return;
    let flow = this._flows.get(stat.underlying);
    if (!flow) { flow = this._emptyFlow(stat.underlying); this._flows.set(stat.underlying, flow); }
    flow.oiUpdates.set(stat.instrumentId, Number(stat.quantity));
    flow.lastUpdate = Date.now();
  }

  _onSweep(sweep) {
    this._sweeps.push(sweep);
    if (this._sweeps.length > 200) this._sweeps = this._sweeps.slice(-200);

    // Also track in flow state
    if (sweep.underlying) {
      let flow = this._flows.get(sweep.underlying);
      if (!flow) { flow = this._emptyFlow(sweep.underlying); this._flows.set(sweep.underlying, flow); }
      flow.sweeps.push(sweep);
      if (flow.sweeps.length > 50) flow.sweeps = flow.sweeps.slice(-50);
    }
  }

  _emptyFlow(ticker) {
    return {
      ticker, tradeCount: 0,
      callVolume: 0, putVolume: 0, callPremium: 0, putPremium: 0,
      largeBlocks: [], sweeps: [],
      strikeVolume: new Map(), oiUpdates: new Map(),
      lastUpdate: Date.now(),
    };
  }

  /**
   * Get flow metrics + HFT signals for a ticker.
   * Drop-in compatible with databento.js getOrderFlow() output format.
   */
  getFlow(ticker) {
    const tk = ticker.toUpperCase();
    const flow = this._flows.get(tk);
    if (!flow) return null;

    const netFlow = Math.round(flow.callPremium + flow.putPremium);
    const cutoff = Date.now() - this._windowMs;

    // Top strikes by volume
    const topStrikes = [...flow.strikeVolume.entries()]
      .sort((a, b) => (b[1].calls + b[1].puts) - (a[1].calls + a[1].puts))
      .slice(0, 10)
      .map(([strike, data]) => ({ strike, ...data }));

    const recentBlocks = flow.largeBlocks.filter(b => b.time >= cutoff);
    const recentSweeps = flow.sweeps.filter(s => s.time >= cutoff);

    // Get HFT signal state
    const signal = this._signals.getSignal(tk);

    return {
      ticker: flow.ticker,
      lookbackMinutes: Math.round(this._windowMs / 60_000),
      tradeCount: flow.tradeCount,
      callVolume: flow.callVolume,
      putVolume: flow.putVolume,
      callPremium: Math.round(flow.callPremium),
      putPremium: Math.round(flow.putPremium),
      netFlow,
      flowDirection: netFlow > 0 ? 'BULLISH' : 'BEARISH',
      pcVolumeRatio: flow.callVolume > 0 ? (flow.putVolume / flow.callVolume).toFixed(2) : 'N/A',
      largeBlocks: recentBlocks.slice(-20),
      topStrikes,

      // HFT signals (from Databento blog techniques)
      sweeps: recentSweeps.slice(-10),
      sweepCount: recentSweeps.length,
      bookSkew: signal?.bookSkew ?? null,
      vwap: signal?.vwap ?? null,
      aggressionRatio: signal?.aggressionRatio ?? null,
      hftDirection: signal?.direction ?? null,
      hftConfidence: signal?.confidence ?? null,
      hftScore: signal?.netScore ?? null,

      _source: 'databento-live',
      _live: true,
    };
  }

  /**
   * Get recent sweeps across all tickers (for institutional flow dashboard).
   */
  getRecentSweeps(limit = 20) {
    const cutoff = Date.now() - this._windowMs;
    return this._sweeps.filter(s => s.time >= cutoff).slice(-limit);
  }

  reset(ticker) {
    if (ticker) {
      this._flows.delete(ticker.toUpperCase());
      this._signals.reset();
    } else {
      this._flows.clear();
      this._signals.reset();
    }
  }
}

// ── Module Export (Singleton) ──────────────────────────────────────────

const liveClient = new DatabentoLive();
const signalEngine = new HftSignalEngine(liveClient);
const flowTracker = new LiveFlowTracker(liveClient, signalEngine);

module.exports = {
  client: liveClient,
  signals: signalEngine,
  flow: flowTracker,
  connect: () => liveClient.connect(),
  disconnect: () => liveClient.disconnect(),
  subscribe: (schema, stypeIn, symbols, start) => liveClient.subscribe(schema, stypeIn, symbols, start),
  getStatus: () => liveClient.getStatus(),
  getFlow: (ticker) => flowTracker.getFlow(ticker),
  getSignal: (ticker) => signalEngine.getSignal(ticker),
  getSweeps: (limit) => flowTracker.getRecentSweeps(limit),
  // Live options chain builder
  getExpirations: (ticker) => liveClient.getExpirations(ticker),
  getOptionsChain: (ticker, exp) => liveClient.getOptionsChain(ticker, exp),
  hasDataFor: (ticker) => liveClient.hasDataFor(ticker),
};
