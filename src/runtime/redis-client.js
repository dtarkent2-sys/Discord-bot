/**
 * Shared minimal Redis client using native TCP/TLS + RESP protocol.
 * No npm dependency — uses only Node.js built-in `net` and `tls` modules.
 * Supports both redis:// (plain TCP) and rediss:// (TLS) URLs.
 *
 * Includes automatic reconnection on disconnect and a `connected` flag
 * so callers can skip commands instead of queuing on a dead socket.
 */

const log = require('../logger')('RedisClient');

/**
 * Create a Redis client from a connection URL.
 * @param {string} redisUrl - e.g. redis://default:pass@host:6379 or rediss://...
 * @returns {Promise<{sendCommand: Function, quit: Function, connected: boolean}>}
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
    let settled = false; // guards the initial connection promise

    const client = {
      connected: false,
      sendCommand: null,
      quit: null,
      _socket: null,
      _pending: [],
      _reconnectTimer: null,
      _intentionalClose: false,
    };

    function connect() {
      let socket;
      if (useTls) {
        const tls = require('tls');
        socket = tls.connect({ host, port, rejectUnauthorized: false }, () => onConnect(socket));
      } else {
        const net = require('net');
        socket = net.createConnection({ host, port }, () => onConnect(socket));
      }

      client._socket = socket;

      // Connection-phase error: only reject the initial promise if not yet settled
      socket.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(new Error(`Redis connection failed: ${err.message}`));
        }
      });

      // Connection-phase timeout (only for initial connect)
      if (!settled) {
        const connTimeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            socket.destroy();
            reject(new Error('Redis connection timeout'));
          }
        }, 5000);
        // Clear timeout once connected (inside onConnect)
        socket._connTimeout = connTimeout;
      }
    }

    function onConnect(socket) {
      // Clear the connection timeout
      if (socket._connTimeout) {
        clearTimeout(socket._connTimeout);
        socket._connTimeout = null;
      }

      let buffer = '';
      const pending = client._pending;

      client.connected = true;
      client._socket = socket;

      function rejectAll(err) {
        client.connected = false;
        while (pending.length > 0) pending.shift().reject(err);
      }

      function sendCommand(...args) {
        if (!client.connected) {
          return Promise.reject(new Error('Redis not connected'));
        }
        return new Promise((res, rej) => {
          const parts = [`*${args.length}`];
          for (const arg of args) {
            const str = String(arg);
            parts.push(`$${Buffer.byteLength(str)}`, str);
          }
          // Per-command timeout so a stuck command can never block the boot chain.
          // IMPORTANT: on timeout we mark the entry dead but do NOT splice it from
          // the queue. Redis still sends its response, and the parser must consume
          // it in order. Splicing would offset every subsequent response by one,
          // permanently corrupting the connection.
          let cmdSettled = false;
          const entry = {
            dead: false,
            resolve: (val) => { if (!cmdSettled) { cmdSettled = true; clearTimeout(timer); res(val); } },
            reject: (err) => { if (!cmdSettled) { cmdSettled = true; clearTimeout(timer); rej(err); } },
          };
          const timer = setTimeout(() => {
            entry.dead = true;
            if (!cmdSettled) { cmdSettled = true; rej(new Error('Redis command timeout (10s)')); }
          }, 10_000);
          pending.push(entry);
          socket.write(parts.join('\r\n') + '\r\n');
        });
      }

      // Consume the front pending entry. If it timed out (dead), discard silently.
      function settle(val, isError) {
        while (pending.length > 0) {
          const entry = pending.shift();
          if (entry.dead) continue; // Response for a timed-out command — discard
          if (isError) entry.reject(val);
          else entry.resolve(val);
          return;
        }
      }

      function parseResponse(data) {
        buffer += data;
        while (buffer.length > 0) {
          const nlIndex = buffer.indexOf('\r\n');
          if (nlIndex === -1) break;

          const type = buffer[0];
          const line = buffer.slice(1, nlIndex);

          if (type === '+') {
            buffer = buffer.slice(nlIndex + 2);
            settle(line, false);
          } else if (type === '-') {
            buffer = buffer.slice(nlIndex + 2);
            settle(new Error(line), true);
          } else if (type === ':') {
            buffer = buffer.slice(nlIndex + 2);
            settle(parseInt(line, 10), false);
          } else if (type === '$') {
            const len = parseInt(line, 10);
            if (len === -1) {
              buffer = buffer.slice(nlIndex + 2);
              settle(null, false);
            } else {
              const totalLen = nlIndex + 2 + len + 2;
              if (buffer.length < totalLen) break;
              const val = buffer.slice(nlIndex + 2, nlIndex + 2 + len);
              buffer = buffer.slice(totalLen);
              settle(val, false);
            }
          } else {
            buffer = buffer.slice(nlIndex + 2);
          }
        }
      }

      socket.on('data', (data) => parseResponse(data.toString()));

      socket.on('error', (err) => {
        log.error(`Redis socket error: ${err.message}`);
        rejectAll(err);
      });

      socket.on('close', () => {
        rejectAll(new Error('Redis connection closed'));
        if (!client._intentionalClose) {
          scheduleReconnect();
        }
      });

      client.sendCommand = sendCommand;
      client.quit = function quit() {
        client._intentionalClose = true;
        client.connected = false;
        if (client._reconnectTimer) {
          clearTimeout(client._reconnectTimer);
          client._reconnectTimer = null;
        }
        try { socket.end(); } catch {}
      };

      // Auth if needed, then resolve the initial promise
      if (password) {
        const authArgs = username && username !== 'default'
          ? ['AUTH', username, password]
          : ['AUTH', password];
        sendCommand(...authArgs)
          .then(() => {
            log.info('AUTH successful');
            if (!settled) { settled = true; resolve(client); }
          })
          .catch((err) => {
            if (!settled) { settled = true; reject(err); }
          });
      } else {
        if (!settled) { settled = true; resolve(client); }
      }
    }

    function scheduleReconnect() {
      if (client._intentionalClose) return;
      const delay = 3000;
      log.info(`Redis disconnected — reconnecting in ${delay / 1000}s...`);
      client._reconnectTimer = setTimeout(() => {
        client._reconnectTimer = null;
        if (client._intentionalClose) return;
        log.info('Attempting Redis reconnection...');

        let socket;
        if (useTls) {
          const tls = require('tls');
          socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
            log.info('Redis reconnected');
            onConnect(socket);
          });
        } else {
          const net = require('net');
          socket = net.createConnection({ host, port }, () => {
            log.info('Redis reconnected');
            onConnect(socket);
          });
        }

        socket.on('error', (err) => {
          log.error(`Redis reconnection failed: ${err.message}`);
          client.connected = false;
          scheduleReconnect();
        });
      }, delay);
    }

    connect();
  });
}

module.exports = { createRedisClient };
