/**
 * Zoyava LTV — Centralised Logger
 * All log output goes through here so every line has:
 *   - ISO timestamp
 *   - Log level (INFO / WARN / ERROR / DEBUG)
 *   - Module tag (e.g. [LTV Webhook], [RechargeAPI])
 *   - Message + optional JSON data
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

function timestamp() {
  return new Date().toISOString(); // e.g. 2026-06-28T05:23:11.042Z
}

function format(level, tag, message, data) {
  const ts    = timestamp();
  const label = level.toUpperCase().padEnd(5);
  const base  = `[${ts}] ${label} ${tag} ${message}`;
  if (data !== undefined) {
    try {
      return base + '\n         ' + JSON.stringify(data, null, 2);
    } catch {
      return base + ' ' + String(data);
    }
  }
  return base;
}

export const logger = {
  debug: (tag, message, data) => {
    if (CURRENT_LEVEL <= LEVELS.debug)
      console.debug(format('debug', tag, message, data));
  },

  info: (tag, message, data) => {
    if (CURRENT_LEVEL <= LEVELS.info)
      console.log(format('info', tag, message, data));
  },

  warn: (tag, message, data) => {
    if (CURRENT_LEVEL <= LEVELS.warn)
      console.warn(format('warn', tag, '⚠ ' + message, data));
  },

  error: (tag, message, data) => {
    if (CURRENT_LEVEL <= LEVELS.error)
      console.error(format('error', tag, '✗ ' + message, data));
  },

  /** Prints a clear visual separator block — great for webhook arrival logs */
  section: (tag, title) => {
    const line = '─'.repeat(52);
    console.log(`\n${line}`);
    console.log(`[${timestamp()}] INFO  ${tag} ${title}`);
    console.log(line);
  },
};
