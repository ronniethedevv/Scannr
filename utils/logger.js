/**
 * Scannr — Logger Utility
 *
 * Centralized logging with level control. In production, set LOG_LEVEL
 * to 'warn' or 'error' to suppress noisy debug output.
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLevel = LOG_LEVELS.info;

const PREFIX = '[Scannr]';

export const logger = {
  setLevel(level) {
    if (LOG_LEVELS[level] !== undefined) {
      currentLevel = LOG_LEVELS[level];
    }
  },

  debug(...args) {
    if (currentLevel <= LOG_LEVELS.debug) {
      console.debug(PREFIX, ...args);
    }
  },

  info(...args) {
    if (currentLevel <= LOG_LEVELS.info) {
      console.info(PREFIX, ...args);
    }
  },

  warn(...args) {
    if (currentLevel <= LOG_LEVELS.warn) {
      console.warn(PREFIX, ...args);
    }
  },

  error(...args) {
    if (currentLevel <= LOG_LEVELS.error) {
      console.error(PREFIX, ...args);
    }
  },
};
