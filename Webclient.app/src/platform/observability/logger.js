const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const DEFAULT_LEVEL = 'warn';

const getLevel = () => {
  if (typeof process !== 'undefined' && process.env) {
    const value = String(process.env.REACT_APP_LOG_LEVEL || DEFAULT_LEVEL).toLowerCase();
    return Object.prototype.hasOwnProperty.call(LEVELS, value) ? value : DEFAULT_LEVEL;
  }
  return DEFAULT_LEVEL;
};

const redact = (value, depth = 0) => {
  if (depth > 3) return '[depth-limited]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));

  const result = {};
  Object.keys(value).slice(0, 50).forEach((key) => {
    const normalized = key.toLowerCase();
    if (/(token|password|secret|api[-_]?key|authorization|cookie|credential)/i.test(normalized)) {
      result[key] = '[REDACTED]';
    } else if (/(geometry|features|records|items|data)/i.test(normalized) && Array.isArray(value[key]) && value[key].length > 10) {
      result[key] = `[${value[key].length} items]`;
    } else {
      result[key] = redact(value[key], depth + 1);
    }
  });
  return result;
};

const write = (level, message, context = {}) => {
  if (LEVELS[level] < LEVELS[getLevel()]) return;
  const payload = { timestamp: new Date().toISOString(), level, message, context: redact(context) };
  const output = JSON.stringify(payload);
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else if (level === 'info') console.info(output);
  else if (level === 'debug') console.debug(output);
};

export const logger = Object.freeze({
  debug: (message, context) => write('debug', message, context),
  info: (message, context) => write('info', message, context),
  warn: (message, context) => write('warn', message, context),
  error: (message, context) => write('error', message, context),
  child: (scope) => ({
    debug: (message, context = {}) => write('debug', message, { scope, ...context }),
    info: (message, context = {}) => write('info', message, { scope, ...context }),
    warn: (message, context = {}) => write('warn', message, { scope, ...context }),
    error: (message, context = {}) => write('error', message, { scope, ...context }),
  }),
});

export const sanitizeErrorForLog = (error) => ({
  name: error?.name,
  code: error?.code,
  status: error?.status,
  requestId: error?.requestId,
  message: error?.message,
});
