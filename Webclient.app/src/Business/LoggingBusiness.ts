import { apiClient } from '../platform/http/httpClient';
import { isRecord } from './contracts';

const MAX_LOG_TYPE_LENGTH = 80;
const MAX_STRING_LENGTH = 2_048;
const MAX_ARRAY_ITEMS = 40;
const MAX_OBJECT_KEYS = 60;
const MAX_DEPTH = 5;
const SENSITIVE_KEY_PATTERN = /password|passwd|secret|token|authorization|cookie|session|connectionstring|apikey|api_key/iu;

const redactLogValue = (
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>(),
): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.slice(0, MAX_STRING_LENGTH);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);

  if (depth >= MAX_DEPTH) return '[MaxDepth]';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((entry) => redactLogValue(entry, depth + 1, seen));
  }

  if (value instanceof Error) {
    return Object.freeze({
      name: value.name.slice(0, 120),
      message: value.message.slice(0, MAX_STRING_LENGTH),
    });
  }

  if (!isRecord(value)) return String(value).slice(0, MAX_STRING_LENGTH);

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? '[REDACTED]'
      : redactLogValue(nested, depth + 1, seen);
  }
  return result;
};

export const serializeClientLog = (description: unknown): string => {
  try {
    return JSON.stringify(redactLogValue(description));
  } catch {
    return JSON.stringify('[Unserializable]');
  }
};

export const LoggingBusiness = Object.freeze({
  CreateClientLog: async (
    logType: unknown,
    description: unknown,
  ): Promise<unknown> => {
    const data = new FormData();
    data.append('logType', String(logType ?? '').trim().slice(0, MAX_LOG_TYPE_LENGTH));
    data.append('description', serializeClientLog(description));
    return apiClient.post('/cl/c', data);
  },
});
