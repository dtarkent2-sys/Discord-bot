/**
 * Lightweight structured logger.
 * Wraps console methods with consistent prefixed formatting and level filtering.
 *
 * Usage:
 *   const log = require('./logger')('ModuleName');
 *   log.info('Server started');       // [ModuleName] Server started
 *   log.warn('Slow query');           // [ModuleName] WARN: Slow query
 *   log.error('Failed', err);         // [ModuleName] ERROR: Failed <err>
 *
 * Set LOG_LEVEL env var to 'debug', 'info', 'warn', or 'error' (default: 'info').
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function createLogger(prefix) {
  const tag = `[${prefix}]`;

  return {
    debug(...args) {
      if (currentLevel <= LEVELS.debug) console.log(tag, ...args);
    },
    info(...args) {
      if (currentLevel <= LEVELS.info) console.log(tag, ...args);
    },
    warn(...args) {
      if (currentLevel <= LEVELS.warn) console.warn(tag, 'WARN:', ...args);
    },
    error(...args) {
      if (currentLevel <= LEVELS.error) console.error(tag, 'ERROR:', ...args);
    },
  };
}

module.exports = createLogger;
