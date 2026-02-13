/**
 * Databento Live — Real-Time OPRA Streaming via Raw TCP
 *
 * Connects to Databento's Live Subscription Gateway (LSG) over TCP,
 * authenticates via CRAM-SHA256, subscribes to OPRA data, and parses
 * DBN binary records into JavaScript objects.
 *
 * Protocol: Text-based control messages (pipe-delimited key=value\n)
 *           followed by binary DBN record stream.
 *
 * Emits events:
 *   'trade'      — TradeMsg (tick-level fills)
 *   'quote'      — Mbp1/Cmbp1/Cbbo quote updates
 *   'statistic'  — StatMsg (OI, settlement, session high/low)
 *   'definition'  — InstrumentDefMsg
 *   'ohlcv'      — OHLCV bar updates
 *   'error'      — ErrorMsg from gateway
 *   'system'     — SystemMsg (heartbeats, subscription acks)
 *   'connected'  — Successfully authenticated
 *   'disconnected' — Connection lost
 *
 * Usage:
 *   const live = require('./databento-live');
 *   live.connect();
 *   live.on('trade', (trade) => { ... });
 *
 * Docs: https://databento.com/docs/api-reference-live
 */

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const config = require('../config');

// ── Constants ──────────────────────────────────────────────────────────

const LSG_PORT = 13000;
const CONNECT_TIMEOUT = 10_000;   // 10s
const AUTH_TIMEOUT = 30_000;      // 30s
const RECONNECT_BASE_MS = 2_000;  // 2s initial backoff
const RECONNECT_MAX_MS = 60_000;  // 1min max backoff
const PRICE_SCALE = 1_000_000_000;
const LENGTH_MULTIPLIER = 4;

// DBN record types we care about
const RTYPE = {
  TRADE:       0x00, // MBP-0 / TradeMsg
  MBP1:        0x01, // Mbp1Msg (BBO + quote)
  MBP10:       0x0A,
  STATUS:      0x12,
  DEFINITION:  0x13, // InstrumentDefMsg
  IMBALANCE:   0x14,
  ERROR:       0x15, // ErrorMsg
  SYM_MAPPING: 0x16,
  SYSTEM:      0x17, // SystemMsg (heartbeats)
  STATISTICS:  0x18, // StatMsg (OI, settlement)
  OHLCV_1S:    0x20,
  OHLCV_1M:    0x21,
  OHLCV_1H:    0x22,
  OHLCV_1D:    0x23,
  OHLCV_EOD:   0x24,
  MBO:         0xA0,
  CMBP1:       0xB1, // Consolidated BBO
  CBBO_1S:     0xC0,
  CBBO_1M:     0xC1,
  TCBBO:       0xC2,
  BBO_1S:      0xC3,
  BBO_1M:      0xC4,
};

// Stat types
const STAT_OPEN_INTEREST = 9;
const STAT_SETTLEMENT = 3;
const STAT_CLEARED_VOLUME = 6;

// Sentinel values
const UNDEF_PRICE = 0x7FFFFFFFFFFFFFFFn;

// ── CRAM Authentication ────────────────────────────────────────────────

function computeCramResponse(challenge, apiKey) {
  const input = `${challenge}|${apiKey}`;
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  const bucketId = apiKey.slice(-5);
  return `${hash}-${bucketId}`;
}

// ── Price conversion ───────────────────────────────────────────────────

function toPrice(rawBigInt) {
  if (rawBigInt === UNDEF_PRICE) return null;
  return Number(rawBigInt) / PRICE_SCALE;
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
    side: String.fromCharCode(buf.readUInt8(off + 29)),
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

  // BidAskPair at offset 48
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
    type: 'ohlcv',
    ...hd,
    open: toPrice(buf.readBigInt64LE(off + 16)),
    high: toPrice(buf.readBigInt64LE(off + 24)),
    low: toPrice(buf.readBigInt64LE(off + 32)),
    close: toPrice(buf.readBigInt64LE(off + 40)),
    volume: Number(buf.readBigUInt64LE(off + 48)),
  };
}

/**
 * Parse InstrumentDefMsg. The struct layout differs between DBN v1 (22-byte
 * symbol strings) and v2+ (71-byte strings). The numeric prefix fields are at
 * identical offsets in both versions, so we read those safely, then extract
 * raw_symbol at offset 196 (same start in both) and derive all enrichment
 * fields from the OCC symbol format (underlying, strike, type, expiration).
 */
function parseInstrumentDef(buf, off, recordSize, dbnVersion) {
  const hd = parseRecordHeader(buf, off);

  // Numeric fields in the fixed prefix — same offset in v1 and v2
  const result = {
    type: 'definition',
    ...hd,
    tsRecv: buf.readBigUInt64LE(off + 16),
    minPriceIncrement: toPrice(buf.readBigInt64LE(off + 24)),
    expiration: buf.readBigUInt64LE(off + 40),
    contractMultiplier: recordSize >= 160 ? buf.readInt32LE(off + 156) : 100,
  };

  // raw_symbol starts at offset 196 in both v1 and v2 — only length differs
  const symLen = dbnVersion === 1 ? 22 : 71;
  if (recordSize >= 196 + symLen) {
    const rawSymBuf = buf.subarray(off + 196, off + 196 + symLen);
    const nullIdx = rawSymBuf.indexOf(0);
    result.rawSymbol = rawSymBuf.subarray(0, nullIdx >= 0 ? nullIdx : symLen).toString('ascii').trim();
  } else {
    result.rawSymbol = '';
  }

  // Parse OCC symbol format: "SPY   260213C00605000" (21 chars)
  // [0-5] underlying (space-padded), [6-11] YYMMDD, [12] C/P, [13-20] strike*1000
  if (result.rawSymbol.length >= 16) {
    const sym = result.rawSymbol;
    // Find where the date starts (first digit after the alpha padding)
    let dateStart = 0;
    for (let i = 0; i < Math.min(sym.length, 6); i++) {
      if (sym[i] >= '0' && sym[i] <= '9') { dateStart = i; break; }
      dateStart = i + 1;
    }
    result.underlying = sym.slice(0, dateStart).trim();

    if (sym.length >= dateStart + 13) {
      const dateStr = sym.slice(dateStart, dateStart + 6);
      const cpChar = sym.charAt(dateStart + 6);
      const strikeStr = sym.slice(dateStart + 7);

      result.optionType = cpChar === 'C' ? 'call' : cpChar === 'P' ? 'put' : null;
      result.strikePrice = parseInt(strikeStr, 10) / 1000;

      // YYMMDD → YYYY-MM-DD
      const yy = parseInt(dateStr.slice(0, 2), 10);
      const mm = dateStr.slice(2, 4);
      const dd = dateStr.slice(4, 6);
      result.expirationDate = `20${yy}-${mm}-${dd}`;
    }
  }

  // Fallback: use expiration timestamp if OCC parse didn't yield a date
  if (!result.expirationDate && result.expiration && result.expiration !== 0xFFFFFFFFFFFFFFFFn) {
    const ms = Number(result.expiration / 1_000_000n);
    result.expirationDate = new Date(ms).toISOString().slice(0, 10);
  }

  return result;
}

function parseError(buf, off) {
  const hd = parseRecordHeader(buf, off);
  const errBuf = buf.subarray(off + 16, off + 16 + 302);
  const nullIdx = errBuf.indexOf(0);
  return {
    type: 'error',
    ...hd,
    message: errBuf.subarray(0, nullIdx >= 0 ? nullIdx : 302).toString('ascii').trim(),
    code: buf.readUInt8(off + 318),
    isLast: buf.readUInt8(off + 319),
  };
}

function parseSystem(buf, off) {
  const hd = parseRecordHeader(buf, off);
  const msgBuf = buf.subarray(off + 16, off + 16 + 303);
  const nullIdx = msgBuf.indexOf(0);
  return {
    type: 'system',
    ...hd,
    message: msgBuf.subarray(0, nullIdx >= 0 ? nullIdx : 303).toString('ascii').trim(),
    code: buf.readUInt8(off + 319),
  };
}

// ── DatabentoLive Client ──────────────────────────────────────────────

class DatabentoLive extends EventEmitter {
  constructor() {
    super();
    this._socket = null;
    this._state = 'disconnected'; // disconnected | greeting | challenge | authenticating | subscribing | streaming
    this._buffer = Buffer.alloc(0);
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._subscriptions = [];
    this._sessionId = null;
    this._lsgVersion = null;
    this._metadataParsed = false;
    this._metadataLength = 0;
    this._dbnVersion = 2;
    this._tsOut = false;
    this._symbolCstrLen = 71;

    // Instrument lookup (instrumentId → definition)
    this._instruments = new Map();

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
   * Add a subscription. Call before connect(), or call while connected
   * (will queue for next reconnect).
   *
   * @param {string} schema - e.g. 'trades', 'cbbo-1s', 'statistics', 'definition'
   * @param {string} stypeIn - e.g. 'parent', 'raw_symbol'
   * @param {string[]} symbols - e.g. ['SPY.OPT', 'QQQ.OPT']
   */
  subscribe(schema, stypeIn, symbols) {
    this._subscriptions.push({ schema, stypeIn, symbols });
    return this;
  }

  /**
   * Connect to the Databento Live Subscription Gateway.
   * @param {string} [dataset='OPRA.PILLAR'] - Dataset to connect to
   */
  connect(dataset = 'OPRA.PILLAR') {
    if (!config.databentoApiKey) {
      console.warn('[DatabentoLive] No API key configured — skipping live connection');
      return;
    }
    if (!config.databentoLive) {
      console.log('[DatabentoLive] Live streaming disabled (set DATABENTO_LIVE=true to enable)');
      return;
    }

    this._dataset = dataset;
    // Build hostname: OPRA.PILLAR → opra-pillar.lsg.databento.com
    this._hostname = dataset.toLowerCase().replace(/\./g, '-') + '.lsg.databento.com';

    console.log(`[DatabentoLive] Connecting to ${this._hostname}:${LSG_PORT}...`);
    this._doConnect();
  }

  disconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._state = 'disconnected';
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
    this._stats.connected = false;
    console.log('[DatabentoLive] Disconnected');
  }

  getStatus() {
    return {
      enabled: this.enabled,
      state: this._state,
      sessionId: this._sessionId,
      lsgVersion: this._lsgVersion,
      subscriptions: this._subscriptions.length,
      instruments: this._instruments.size,
      ...this._stats,
    };
  }

  /**
   * Look up an instrument definition by ID.
   */
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
      socket.setTimeout(0); // Remove connect timeout
    });

    socket.on('data', (chunk) => {
      this._stats.bytesReceived += chunk.length;
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
      console.warn('[DatabentoLive] Connection closed');
      this.emit('disconnected');

      // Auto-reconnect if we were streaming (not a manual disconnect)
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
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempt - 1),
      RECONNECT_MAX_MS
    );

    console.log(`[DatabentoLive] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempt})...`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._doConnect();
    }, delay);
  }

  // ── Internal: Buffer Processing ──────────────────────────────────────

  _processBuffer() {
    // During handshake, process text lines
    if (this._state !== 'streaming') {
      this._processControlMessages();
      return;
    }

    // During streaming, first handle metadata then records
    if (!this._metadataParsed) {
      this._processMetadata();
      return;
    }

    this._processRecords();
  }

  _processControlMessages() {
    // Control messages are text lines delimited by \n
    while (true) {
      const nlIndex = this._buffer.indexOf(0x0A); // \n
      if (nlIndex < 0) return; // Need more data

      const line = this._buffer.subarray(0, nlIndex).toString('utf-8').trim();
      this._buffer = this._buffer.subarray(nlIndex + 1);

      if (!line) continue;

      // Parse pipe-delimited key=value pairs
      const fields = {};
      for (const token of line.split('|')) {
        const eqIdx = token.indexOf('=');
        if (eqIdx >= 0) {
          fields[token.slice(0, eqIdx)] = token.slice(eqIdx + 1);
        } else {
          // Handle bare keys like "start_session"
          fields[token] = '';
        }
      }

      this._handleControlMessage(fields);
    }
  }

  _handleControlMessage(fields) {
    if (fields.lsg_version !== undefined) {
      // Greeting
      this._lsgVersion = fields.lsg_version;
      this._state = 'challenge';
      console.log(`[DatabentoLive] Gateway version: ${this._lsgVersion}`);
    } else if (fields.cram !== undefined) {
      // Challenge — compute and send auth response
      const challenge = fields.cram;
      const cramResponse = computeCramResponse(challenge, config.databentoApiKey);

      const authMsg = [
        `auth=${cramResponse}`,
        `dataset=${this._dataset}`,
        `encoding=dbn`,
        `ts_out=0`,
        `client=Billy/1.0 Node.js/${process.version}`,
      ].join('|') + '\n';

      this._state = 'authenticating';
      this._socket.write(authMsg);
      console.log('[DatabentoLive] Sent CRAM authentication');
    } else if (fields.success !== undefined) {
      // Auth response
      if (fields.success === '1') {
        this._sessionId = fields.session_id;
        this._reconnectAttempt = 0;
        console.log(`[DatabentoLive] Authenticated! Session: ${this._sessionId}`);

        // Send subscriptions
        this._sendSubscriptions();
      } else {
        const errMsg = fields.error || 'Unknown auth error';
        console.error(`[DatabentoLive] Authentication failed: ${errMsg}`);
        this.emit('error', new Error(`Auth failed: ${errMsg}`));
        this._socket.destroy();
      }
    }
  }

  _sendSubscriptions() {
    if (this._subscriptions.length === 0) {
      // Default subscriptions for Billy's use cases
      this._subscriptions = [
        { schema: 'trades', stypeIn: 'parent', symbols: ['SPY.OPT', 'QQQ.OPT'] },
        { schema: 'cbbo-1s', stypeIn: 'parent', symbols: ['SPY.OPT', 'QQQ.OPT'] },
        { schema: 'statistics', stypeIn: 'parent', symbols: ['SPY.OPT', 'QQQ.OPT'] },
        { schema: 'definition', stypeIn: 'parent', symbols: ['SPY.OPT', 'QQQ.OPT'] },
      ];
    }

    for (const sub of this._subscriptions) {
      const symbolStr = Array.isArray(sub.symbols) ? sub.symbols.join(',') : sub.symbols;
      const msg = `schema=${sub.schema}|stype_in=${sub.stypeIn}|symbols=${symbolStr}\n`;
      this._socket.write(msg);
      console.log(`[DatabentoLive] Subscribed: ${sub.schema} → ${symbolStr}`);
    }

    // Start the session — switches to binary DBN stream
    this._socket.write('start_session\n');
    this._state = 'streaming';
    this._stats.connected = true;
    this._stats.connectedAt = new Date();
    console.log('[DatabentoLive] Session started — streaming binary DBN data');
    this.emit('connected', { sessionId: this._sessionId });
  }

  _processMetadata() {
    // Need at least 8 bytes for the prelude
    if (this._buffer.length < 8) return;

    // Check magic bytes
    const magic = this._buffer.subarray(0, 3).toString('ascii');
    if (magic !== 'DBN') {
      console.error(`[DatabentoLive] Invalid DBN magic: ${magic}`);
      this._socket.destroy();
      return;
    }

    const version = this._buffer.readUInt8(3);
    const metadataLen = this._buffer.readUInt32LE(4);

    // Need full metadata
    const totalMetaBytes = 8 + metadataLen;
    if (this._buffer.length < totalMetaBytes) return;

    // Parse key metadata fields — layout differs between DBN v1 and v2+
    const metaBuf = this._buffer.subarray(8, 8 + metadataLen);
    const dataset = metaBuf.subarray(0, 16).toString('ascii').replace(/\0/g, '').trim();
    const schema = metaBuf.readUInt16LE(16);

    let tsOut, symbolCstrLen;
    if (version === 1) {
      // DBN v1: has 8-byte record_count at offset 34, shifts stype/tsOut down
      // tsOut is at offset 52, no symbol_cstr_len field (default 22)
      tsOut = metaBuf.readUInt8(52);
      symbolCstrLen = 22;
    } else {
      // DBN v2+: tsOut at offset 44, symbol_cstr_len at offset 45
      tsOut = metaBuf.readUInt8(44);
      symbolCstrLen = metaBuf.readUInt16LE(45);
      if (symbolCstrLen === 0 || symbolCstrLen === 0xFFFF) symbolCstrLen = 71;
    }

    this._dbnVersion = version;
    this._tsOut = tsOut === 1;
    this._symbolCstrLen = symbolCstrLen;

    console.log(`[DatabentoLive] DBN v${version} metadata: dataset=${dataset}, symbolLen=${this._symbolCstrLen}, tsOut=${this._tsOut}`);

    // Consume metadata from buffer
    this._buffer = this._buffer.subarray(totalMetaBytes);
    this._metadataParsed = true;

    // Now process any records already in the buffer
    this._processRecords();
  }

  _processRecords() {
    while (this._buffer.length >= 1) {
      const lengthWord = this._buffer.readUInt8(0);
      const recordSize = lengthWord * LENGTH_MULTIPLIER;

      if (recordSize < 16) {
        // Malformed — skip this byte
        this._buffer = this._buffer.subarray(1);
        continue;
      }

      if (this._buffer.length < recordSize) return; // Need more data

      const rtype = this._buffer.readUInt8(1);

      try {
        this._dispatchRecord(rtype, this._buffer, 0, recordSize);
      } catch (err) {
        console.error(`[DatabentoLive] Record parse error (rtype=0x${rtype.toString(16)}): ${err.message}`);
      }

      // Advance past this record
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

      case RTYPE.MBP1:
      case RTYPE.CMBP1:
      case RTYPE.CBBO_1S:
      case RTYPE.CBBO_1M:
      case RTYPE.TCBBO:
      case RTYPE.BBO_1S:
      case RTYPE.BBO_1M: {
        const quote = parseQuote(buf, off);
        this._stats.quotesReceived++;
        this.emit('quote', this._enrichWithInstrument(quote));
        break;
      }

      case RTYPE.STATISTICS: {
        const stat = parseStat(buf, off);
        this._stats.statsReceived++;
        this.emit('statistic', this._enrichWithInstrument(stat));
        break;
      }

      case RTYPE.DEFINITION: {
        // v1 InstrumentDef is ~332 bytes, v2+ is ~520 bytes
        if (size >= 220) {
          const def = parseInstrumentDef(buf, off, size, this._dbnVersion);
          this._stats.defsReceived++;
          this._instruments.set(def.instrumentId, def);
          this.emit('definition', def);
        }
        break;
      }

      case RTYPE.OHLCV_1S:
      case RTYPE.OHLCV_1M:
      case RTYPE.OHLCV_1H:
      case RTYPE.OHLCV_1D:
      case RTYPE.OHLCV_EOD: {
        const ohlcv = parseOhlcv(buf, off);
        this.emit('ohlcv', this._enrichWithInstrument(ohlcv));
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
          // Code 0 = heartbeat (suppress log noise)
          if (sys.code !== 0) {
            console.log(`[DatabentoLive] System: ${sys.message} (code=${sys.code})`);
          }
          this.emit('system', sys);
        }
        break;
      }

      // Ignore other types silently
    }
  }

  /**
   * Enrich a record with instrument metadata if available.
   */
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
}

// ── Singleton + Flow Tracker ──────────────────────────────────────────

/**
 * Real-time order flow tracker.
 * Aggregates trades from the live stream into rolling flow metrics
 * that the rest of Billy's pipeline can query.
 */
class LiveFlowTracker {
  constructor(liveClient) {
    this._live = liveClient;
    this._flows = new Map(); // ticker → flow state

    // Rolling window config
    this._windowMs = 15 * 60 * 1000; // 15 minutes

    // Wire up trade events
    this._live.on('trade', (trade) => this._onTrade(trade));
    this._live.on('statistic', (stat) => this._onStat(stat));
  }

  _onTrade(trade) {
    if (!trade.underlying || !trade.price || !trade.size) return;

    const ticker = trade.underlying;
    let flow = this._flows.get(ticker);
    if (!flow) {
      flow = this._emptyFlow(ticker);
      this._flows.set(ticker, flow);
    }

    const premium = trade.price * trade.size * (trade.multiplier || 100);
    const isBuy = trade.side === 'A'; // 'A' = at ask = buyer-initiated
    const isSell = trade.side === 'B'; // 'B' = at bid = seller-initiated
    const signedPremium = isBuy ? premium : isSell ? -premium : 0;

    // Track running totals
    flow.tradeCount++;

    if (trade.optionType === 'call') {
      flow.callVolume += trade.size;
      flow.callPremium += signedPremium;
    } else if (trade.optionType === 'put') {
      flow.putVolume += trade.size;
      flow.putPremium += signedPremium;
    }

    // Track large blocks ($50K+ notional)
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
      // Cap stored blocks
      if (flow.largeBlocks.length > 100) {
        flow.largeBlocks = flow.largeBlocks.slice(-100);
      }
    }

    // Track per-strike volume
    if (trade.strike) {
      const key = trade.strike;
      const sv = flow.strikeVolume.get(key) || { calls: 0, puts: 0, premium: 0 };
      if (trade.optionType === 'call') sv.calls += trade.size;
      else if (trade.optionType === 'put') sv.puts += trade.size;
      sv.premium += Math.abs(premium);
      flow.strikeVolume.set(key, sv);
    }

    flow.lastUpdate = Date.now();
  }

  _onStat(stat) {
    if (stat.statType !== STAT_OPEN_INTEREST) return;
    if (!stat.underlying) return;

    const ticker = stat.underlying;
    let flow = this._flows.get(ticker);
    if (!flow) {
      flow = this._emptyFlow(ticker);
      this._flows.set(ticker, flow);
    }

    // Update OI for this instrument
    flow.oiUpdates.set(stat.instrumentId, Number(stat.quantity));
    flow.lastUpdate = Date.now();
  }

  _emptyFlow(ticker) {
    return {
      ticker,
      tradeCount: 0,
      callVolume: 0,
      putVolume: 0,
      callPremium: 0,
      putPremium: 0,
      largeBlocks: [],
      strikeVolume: new Map(),
      oiUpdates: new Map(),
      lastUpdate: Date.now(),
    };
  }

  /**
   * Get current flow metrics for a ticker.
   * Compatible format with databento.js getOrderFlow().
   */
  getFlow(ticker) {
    const flow = this._flows.get(ticker.toUpperCase());
    if (!flow) return null;

    const netFlow = Math.round(flow.callPremium + flow.putPremium);

    // Top strikes by volume
    const topStrikes = [...flow.strikeVolume.entries()]
      .sort((a, b) => (b[1].calls + b[1].puts) - (a[1].calls + a[1].puts))
      .slice(0, 10)
      .map(([strike, data]) => ({ strike, ...data }));

    // Recent large blocks (last 15min)
    const cutoff = Date.now() - this._windowMs;
    const recentBlocks = flow.largeBlocks.filter(b => b.time >= cutoff);

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
      _source: 'databento-live',
      _live: true,
    };
  }

  /**
   * Reset flow counters for a ticker (e.g. at market open).
   */
  reset(ticker) {
    if (ticker) {
      this._flows.delete(ticker.toUpperCase());
    } else {
      this._flows.clear();
    }
  }
}

// ── Module Export (Singleton) ──────────────────────────────────────────

const liveClient = new DatabentoLive();
const flowTracker = new LiveFlowTracker(liveClient);

module.exports = {
  client: liveClient,
  flow: flowTracker,
  connect: () => liveClient.connect(),
  disconnect: () => liveClient.disconnect(),
  subscribe: (schema, stypeIn, symbols) => liveClient.subscribe(schema, stypeIn, symbols),
  getStatus: () => liveClient.getStatus(),
  getFlow: (ticker) => flowTracker.getFlow(ticker),
};
