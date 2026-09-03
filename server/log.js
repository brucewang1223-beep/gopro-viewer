/**
 * Small leveled logger. Output: ISO timestamp, level, module tag, message, optional JSON context.
 * Level is taken from LOG_LEVEL (debug | info | warn | error), default info.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
let currentLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

export function setLogLevel(level) {
  if (LEVELS[level] == null) throw new Error(`Unknown log level: ${level}`);
  currentLevel = LEVELS[level];
}

function fmt(ctx) {
  if (ctx === undefined) return '';
  if (ctx instanceof Error) return ` ${ctx.stack || ctx.message}`;
  try { return ' ' + JSON.stringify(ctx); } catch { return ' ' + String(ctx); }
}

export function createLogger(tag) {
  const emit = (level, msg, ctx) => {
    if (LEVELS[level] < currentLevel) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}${fmt(ctx)}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
  };
}
