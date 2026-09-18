import type {
  GuardrailReason,
  PayloadBoundaryResult,
  PayloadBudget,
  PayloadShapeStats,
} from './contracts';
import { estimateUtf8Bytes } from './textBoundary';

export const DEFAULT_PAYLOAD_BUDGET: PayloadBudget = Object.freeze({
  maxDepth: 16,
  maxObjectKeys: 256,
  maxArrayItems: 1_024,
  maxStringLength: 65_536,
  maxUtf8Bytes: 4 * 1024 * 1024,
  maxTotalNodes: 16_384,
});

const reason = (
  code: string,
  message: string,
  severity: GuardrailReason['severity'] = 'error',
  path?: string,
): GuardrailReason => Object.freeze({
  code,
  message,
  severity,
  ...(path ? { path } : {}),
});

const positiveInt = (value: number, fallback: number): number => {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
};

export const normalizePayloadBudget = (
  input: Partial<PayloadBudget> = {},
): PayloadBudget => Object.freeze({
  maxDepth: positiveInt(input.maxDepth ?? DEFAULT_PAYLOAD_BUDGET.maxDepth, DEFAULT_PAYLOAD_BUDGET.maxDepth),
  maxObjectKeys: positiveInt(input.maxObjectKeys ?? DEFAULT_PAYLOAD_BUDGET.maxObjectKeys, DEFAULT_PAYLOAD_BUDGET.maxObjectKeys),
  maxArrayItems: positiveInt(input.maxArrayItems ?? DEFAULT_PAYLOAD_BUDGET.maxArrayItems, DEFAULT_PAYLOAD_BUDGET.maxArrayItems),
  maxStringLength: positiveInt(input.maxStringLength ?? DEFAULT_PAYLOAD_BUDGET.maxStringLength, DEFAULT_PAYLOAD_BUDGET.maxStringLength),
  maxUtf8Bytes: positiveInt(input.maxUtf8Bytes ?? DEFAULT_PAYLOAD_BUDGET.maxUtf8Bytes, DEFAULT_PAYLOAD_BUDGET.maxUtf8Bytes),
  maxTotalNodes: positiveInt(input.maxTotalNodes ?? DEFAULT_PAYLOAD_BUDGET.maxTotalNodes, DEFAULT_PAYLOAD_BUDGET.maxTotalNodes),
});

interface MutableStats {
  depth: number;
  objectKeys: number;
  arrayItems: number;
  strings: number;
  utf8Bytes: number;
  nodes: number;
}

const freezeStats = (stats: MutableStats): PayloadShapeStats => Object.freeze({ ...stats });

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const addString = (
  value: string,
  stats: MutableStats,
  budget: PayloadBudget,
  reasons: GuardrailReason[],
  path: string,
): void => {
  stats.strings += 1;
  if (value.length > budget.maxStringLength) {
    reasons.push(reason('string-too-large', 'String exceeds the configured length budget.', 'error', path));
  }
  stats.utf8Bytes += estimateUtf8Bytes(value);
  if (stats.utf8Bytes > budget.maxUtf8Bytes) {
    reasons.push(reason('payload-too-large', 'Payload exceeds the configured byte budget.', 'error', path));
  }
};

export const evaluatePayloadBoundary = <T = unknown>(
  input: T,
  budgetInput: Partial<PayloadBudget> = {},
): PayloadBoundaryResult<T> => {
  const budget = normalizePayloadBudget(budgetInput);
  const reasons: GuardrailReason[] = [];
  const stats: MutableStats = {
    depth: 0,
    objectKeys: 0,
    arrayItems: 0,
    strings: 0,
    utf8Bytes: 0,
    nodes: 0,
  };
  const ancestors = new WeakSet<object>();

  const visit = (value: unknown, depth: number, path: string): unknown => {
    stats.nodes += 1;
    stats.depth = Math.max(stats.depth, depth);

    if (stats.nodes > budget.maxTotalNodes) {
      reasons.push(reason('payload-too-large', 'Payload node budget was exceeded.', 'error', path));
      return null;
    }

    if (depth > budget.maxDepth) {
      reasons.push(reason('payload-too-deep', 'Payload depth budget was exceeded.', 'error', path));
      return null;
    }

    if (value === null || typeof value === 'boolean') return value;

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        reasons.push(reason('unsupported-number', 'Non-finite numeric values are not accepted.', 'error', path));
        return null;
      }
      return value;
    }

    if (typeof value === 'string') {
      addString(value, stats, budget, reasons, path);
      return value;
    }

    if (typeof value === 'undefined') {
      reasons.push(reason('undefined-normalized', 'Undefined values are normalized to null.', 'warning', path));
      return null;
    }

    if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
      reasons.push(reason('unsupported-value', 'Unsupported runtime value was rejected.', 'error', path));
      return null;
    }

    if (value instanceof Date) {
      const normalized = Number.isFinite(value.getTime()) ? value.toISOString() : '';
      addString(normalized, stats, budget, reasons, path);
      return normalized;
    }

    if (value instanceof URL) {
      addString(value.href, stats, budget, reasons, path);
      return value.href;
    }

    if (typeof value === 'object' && value !== null) {
      if (ancestors.has(value)) {
        reasons.push(reason('cycle-detected', 'Cyclic payload references are not accepted.', 'error', path));
        return null;
      }

      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          stats.arrayItems += value.length;
          if (value.length > budget.maxArrayItems) {
            reasons.push(reason('array-too-large', 'Array exceeds the configured item budget.', 'error', path));
          }
          const limit = Math.min(value.length, budget.maxArrayItems);
          const output: unknown[] = [];
          for (let index = 0; index < limit; index += 1) {
            output.push(visit(value[index], depth + 1, path + '[' + String(index) + ']'));
          }
          return output;
        }

        if (isPlainRecord(value)) {
          const entries = Object.entries(value);
          stats.objectKeys += entries.length;
          if (entries.length > budget.maxObjectKeys) {
            reasons.push(reason('payload-too-wide', 'Object exceeds the configured key budget.', 'error', path));
          }
          const limit = Math.min(entries.length, budget.maxObjectKeys);
          const output: Record<string, unknown> = {};
          for (let index = 0; index < limit; index += 1) {
            const entry = entries[index];
            if (!entry) continue;
            const [key, child] = entry;
            addString(key, stats, budget, reasons, path + '.<key>');
            output[key] = visit(child, depth + 1, path + '.' + key);
          }
          return output;
        }

        reasons.push(reason('unsupported-object', 'Only plain objects and arrays are accepted.', 'error', path));
        return null;
      } finally {
        ancestors.delete(value);
      }
    }

    reasons.push(reason('unsupported-value', 'Unsupported payload value was rejected.', 'error', path));
    return null;
  };

  const normalized = visit(input, 0, '$') as T;
  const accepted = !reasons.some(
    (entry) => entry.severity === 'error' || entry.severity === 'critical',
  );

  return Object.freeze({
    accepted,
    value: accepted ? normalized : null,
    stats: freezeStats(stats),
    reasons: Object.freeze(reasons),
  });
};

export const estimatePayloadBytes = (
  input: unknown,
  budgetInput: Partial<PayloadBudget> = {},
): number => evaluatePayloadBoundary(input, budgetInput).stats.utf8Bytes;

export const isPayloadWithinBudget = (
  input: unknown,
  budgetInput: Partial<PayloadBudget> = {},
): boolean => evaluatePayloadBoundary(input, budgetInput).accepted;
