/**
 * Shared minimal Redis client using native TCP/TLS + RESP protocol.
 * No npm dependency — uses only Node.js built-in `net` and `tls` modules.
 * Supports both redis:// (plain TCP) and rediss:// (TLS) URLs.
 *
 * IMPORTANT: The RESP parser works with Buffers (byte-level), NOT strings.
 * The RESP protocol's $N bulk-string prefix is a BYTE count, so we must
 * compare against Buffer.length (bytes), not String.length (characters).
 * Mixing these up causes hangs on any stored data with multi-byte UTF-8
 * (emoji, CJK, etc.) because the parser thinks it needs more data.
 */

const log = require('../logger')('RedisClient');

const CR = 0x0D; // \r
const LF = 0x0A; // \n
const PLUS  = 0x2B; // +
const MINUS = 0x2D; // -
const COLON = 0x3A; // :
const DOLLAR = 0x24; // $

/**
 * Find \r\n in a Buffer starting at `offset`.
 * Returns the index of \r, or -1 if not found.
 */
function findCRLF(buf, offset) {
  for (let i = offset; i < buf.length - 1; i++) {
    if (buf[i] === CR && buf[i + 1] === LF) return i;
  }
  return -1;
}

/**
 * Create a Redis client from a connection URL.
 * @param {string} redisUrl - e.g. redis://default:pass@host:6379 or rediss://...
 * @returns {Promise<{sendCommand: Function, quit: Function}>}
 */
function createRedisClient(redisUrl) {
  const url = new URL(redisUrl);
  const host = url.hostname || '127.0.0.1';
  const port = parseInt(url.port, 10) || 6379;
  const password = url.password ? decodeURIComponent(url.password) : null;
  const username = url.username ? decodeURIComponent(url.username) : null;
  const useTls = url.protocol === 'rediss:';

  log.info(`Connecting to ${host}:${port} (TLS: ${useTls})`);

  return new Promise((resolve, reject) => {
    let socket;
    if (useTls) {
      const tls = require('tls');
      socket = tls.connect({ host, port, rejectUnauthorized: false }, onConnect);
    } else {
      const net = require('net');
      socket = net.createConnection({ host, port }, onConnect);
    }

    function onConnect() {
      let buffer = Buffer.alloc(0);
      const pending = [];

      function rejectAll(err) {
        while (pending.length > 0) pending.shift().reject(err);
      }

      /**
       * Send a Redis command.  Accepts an optional trailing options object:
       *   sendCommand('GET', 'key', { timeout: 5000 })
       * Default timeout is 10 000 ms.
       */
      function sendCommand(...args) {
        // Pop options object if present
        let timeoutMs = 10_000;
        if (args.length > 0 && typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null && !Array.isArray(args[args.length - 1])) {
          const opts = args.pop();
          if (opts.timeout) timeoutMs = opts.timeout;
        }

        return new Promise((res, rej) => {
          // Build RESP command as Buffer (byte-accurate)
          const parts = [`*${args.length}\r\n`];
          for (const arg of args) {
            const str = String(arg);
            parts.push(`$${Buffer.byteLength(str)}\r\n${str}\r\n`);
          }
          const payload = Buffer.from(parts.join(''));

          // Per-command timeout so a stuck command can never block the boot chain.
          // IMPORTANT: on timeout we mark the entry dead but do NOT splice it from
          // the queue. Redis still sends its response, and the parser must consume
          // it in order. Splicing would offset every subsequent response by one,
          // permanently corrupting the connection.
          let settled = false;
          const entry = {
            dead: false,
            resolve: (val) => { if (!settled) { settled = true; clearTimeout(timer); res(val); } },
            reject: (err) => { if (!settled) { settled = true; clearTimeout(timer); rej(err); } },
          };
          const timer = setTimeout(() => {
            entry.dead = true;
            if (!settled) { settled = true; rej(new Error(`Redis command timeout (${timeoutMs / 1000}s)`)); }
          }, timeoutMs);
          pending.push(entry);
          socket.write(payload);
        });
      }

      // Consume the front pending entry. If it timed out (dead), discard the
      // response silently — do NOT loop to the next entry, as that would assign
      // this response to a different command and corrupt the RESP pipeline.
      function settle(val, isError) {
        if (pending.length === 0) return;
        const entry = pending.shift();
        if (entry.dead) return; // Response for a timed-out command — discard
        if (isError) entry.reject(val);
        else entry.resolve(val);
      }

      /**
       * Process as many complete RESP responses as possible from the buffer.
       * All length comparisons use Buffer.length (bytes), matching the RESP
       * protocol's $N byte-count semantics.
       */
      function processBuffer() {
        while (buffer.length > 0) {
          const nlIdx = findCRLF(buffer, 0);
          if (nlIdx === -1) break;

          const type = buffer[0];
          const line = buffer.slice(1, nlIdx).toString('utf-8');

          if (type === PLUS) {
            buffer = buffer.slice(nlIdx + 2);
            settle(line, false);
          } else if (type === MINUS) {
            buffer = buffer.slice(nlIdx + 2);
            settle(new Error(line), true);
          } else if (type === COLON) {
            buffer = buffer.slice(nlIdx + 2);
            settle(parseInt(line, 10), false);
          } else if (type === DOLLAR) {
            const len = parseInt(line, 10);
            if (len === -1) {
              buffer = buffer.slice(nlIdx + 2);
              settle(null, false);
            } else {
              // nlIdx + 2 = start of bulk data (bytes)
              // len = byte count of the bulk string
              // + 2 = trailing \r\n
              const totalNeeded = nlIdx + 2 + len + 2;
              if (buffer.length < totalNeeded) break; // Wait for more data (byte-accurate!)
              const val = buffer.slice(nlIdx + 2, nlIdx + 2 + len).toString('utf-8');
              buffer = buffer.slice(totalNeeded);
              settle(val, false);
            }
          } else {
            // Unknown type — skip this line
            buffer = buffer.slice(nlIdx + 2);
          }
        }
      }

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        processBuffer();
      });
      socket.on('error', (err) => rejectAll(err));
      socket.on('close', () => rejectAll(new Error('Redis connection closed')));

      const client = {
        sendCommand,
        quit() { try { socket.end(); } catch {} },
      };

      if (password) {
        const authArgs = username && username !== 'default'
          ? ['AUTH', username, password]
          : ['AUTH', password];
        sendCommand(...authArgs)
          .then(() => {
            log.info('AUTH successful');
            resolve(client);
          })
          .catch(reject);
      } else {
        resolve(client);
      }
    }

    socket.on('error', reject);
    setTimeout(() => reject(new Error('Redis connection timeout')), 5000);
  });
}

module.exports = { createRedisClient };
