/**
 * Shared minimal Redis client using native TCP/TLS + RESP protocol.
 * No npm dependency — uses only Node.js built-in `net` and `tls` modules.
 * Supports both redis:// (plain TCP) and rediss:// (TLS) URLs.
 */

const log = require('../logger')('RedisClient');

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
      let buffer = '';
      const pending = [];

      function rejectAll(err) {
        while (pending.length > 0) pending.shift().reject(err);
      }

      function sendCommand(...args) {
        return new Promise((res, rej) => {
          const parts = [`*${args.length}`];
          for (const arg of args) {
            const str = String(arg);
            parts.push(`$${Buffer.byteLength(str)}`, str);
          }
          // Per-command timeout so a stuck command can never block the boot chain
          const entry = {
            resolve: (val) => { clearTimeout(timer); res(val); },
            reject: (err) => { clearTimeout(timer); rej(err); },
          };
          const timer = setTimeout(() => {
            const idx = pending.indexOf(entry);
            if (idx !== -1) {
              pending.splice(idx, 1);
              rej(new Error('Redis command timeout (10s)'));
            }
          }, 10_000);
          pending.push(entry);
          socket.write(parts.join('\r\n') + '\r\n');
        });
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
            if (pending.length > 0) pending.shift().resolve(line);
          } else if (type === '-') {
            buffer = buffer.slice(nlIndex + 2);
            if (pending.length > 0) pending.shift().reject(new Error(line));
          } else if (type === ':') {
            buffer = buffer.slice(nlIndex + 2);
            if (pending.length > 0) pending.shift().resolve(parseInt(line, 10));
          } else if (type === '$') {
            const len = parseInt(line, 10);
            if (len === -1) {
              buffer = buffer.slice(nlIndex + 2);
              if (pending.length > 0) pending.shift().resolve(null);
            } else {
              const totalLen = nlIndex + 2 + len + 2;
              if (buffer.length < totalLen) break;
              const val = buffer.slice(nlIndex + 2, nlIndex + 2 + len);
              buffer = buffer.slice(totalLen);
              if (pending.length > 0) pending.shift().resolve(val);
            }
          } else {
            buffer = buffer.slice(nlIndex + 2);
          }
        }
      }

      socket.on('data', (data) => parseResponse(data.toString()));
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
