const secretPattern = /authorization|cookie|token|secret|password|api[-_]?key|credential/i;

const redact = (value) => {
    if (value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(redact);
    return Object.keys(value).reduce((result, key) => {
        result[key] = secretPattern.test(key) ? '[REDACTED]' : redact(value[key]);
        return result;
    }, {});
};

const emit = (level, event, data) => {
    const payload = redact({ event, release: process.env.REACT_APP_VERSION || 'local', data });
    const target = console[level] || console.log;
    target.call(console, payload);
};

export const logger = {
    debug: (event, data) => emit('debug', event, data),
    info: (event, data) => emit('info', event, data),
    warn: (event, data) => emit('warn', event, data),
    error: (event, data) => emit('error', event, data)
};

export const redactSensitive = redact;
