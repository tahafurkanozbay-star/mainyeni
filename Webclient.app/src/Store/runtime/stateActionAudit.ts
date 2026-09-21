import {
  normalizeStoreRuntimeLimits,
  readActionType,
  type StoreRuntimeLimits,
} from './contracts';

export type StoreActionPayloadKind =
  | 'none'
  | 'primitive'
  | 'array'
  | 'object'
  | 'function'
  | 'other';

export interface StoreActionAudit {
  readonly actionType: string;
  readonly payloadKind: StoreActionPayloadKind;
  readonly estimatedEntries: number;
  readonly maxDepthObserved: number;
  readonly hasSensitiveKeys: boolean;
  readonly hasFunctions: boolean;
  readonly truncated: boolean;
}

const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|passwd|secret|token|api[-_]?key|session)/i;

const payloadKind = (value: unknown): StoreActionPayloadKind => {
  if (value === undefined) return 'none';
  if (value === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof value)) {
    return 'primitive';
  }
  if (typeof value === 'function') return 'function';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return 'other';
};

export const auditStoreAction = (
  action: unknown,
  limitsInput: Partial<StoreRuntimeLimits> | StoreRuntimeLimits = {},
): StoreActionAudit => {
  const limits = normalizeStoreRuntimeLimits(limitsInput);
  const actionType = readActionType(action);
  const record = action && typeof action === 'object'
    ? action as Readonly<Record<string, unknown>>
    : null;
  const payload = record?.payload;
  const kind = payloadKind(payload);
  let estimatedEntries = 0;
  let maxDepthObserved = 0;
  let hasSensitiveKeys = false;
  let hasFunctions = kind === 'function';
  let truncated = false;
  const seen = new WeakSet<object>();

  const visit = (value: unknown, depth: number): void => {
    maxDepthObserved = Math.max(maxDepthObserved, depth);
    if (estimatedEntries >= limits.maxProjectionEntries) {
      truncated = true;
      return;
    }
    if (depth > limits.maxProjectionDepth) {
      truncated = true;
      return;
    }
    if (typeof value === 'function') {
      hasFunctions = true;
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) {
      truncated = true;
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        estimatedEntries += 1;
        visit(item, depth + 1);
        if (truncated && estimatedEntries >= limits.maxProjectionEntries) break;
      }
      return;
    }

    for (const [key, child] of Object.entries(value as Readonly<Record<string, unknown>>)) {
      estimatedEntries += 1;
      if (SENSITIVE_KEY.test(key)) hasSensitiveKeys = true;
      visit(child, depth + 1);
      if (truncated && estimatedEntries >= limits.maxProjectionEntries) break;
    }
  };

  if (payload !== undefined) visit(payload, 0);

  return Object.freeze({
    actionType,
    payloadKind: kind,
    estimatedEntries,
    maxDepthObserved,
    hasSensitiveKeys,
    hasFunctions,
    truncated,
  });
};
