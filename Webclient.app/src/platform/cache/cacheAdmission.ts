import type { CacheBudgetLimits } from './cacheBudgetLimits';

export type CacheAdmissionReason =
  | 'entry-too-large'
  | 'namespace-limit'
  | 'entry-capacity'
  | 'byte-capacity'
  | 'namespace-entry-capacity'
  | 'namespace-byte-capacity';

export interface CacheUsage {
  readonly entries: number;
  readonly bytes: number;
  readonly namespaces: number;
}

export interface CacheAdmissionProbe {
  readonly byteSize: number;
  readonly namespaceExists: boolean;
  readonly replacing: boolean;
  readonly replacedByteSize?: number;
  readonly global: CacheUsage;
  readonly namespace: Omit<CacheUsage, 'namespaces'>;
}

export const cacheAdmissionReason = (
  limits: CacheBudgetLimits,
  probe: CacheAdmissionProbe,
): CacheAdmissionReason | undefined => {
  if (!Number.isSafeInteger(probe.byteSize) || probe.byteSize <= 0) {
    throw new RangeError('cache byte size must be a positive safe integer');
  }
  if (probe.byteSize > limits.maxEntryBytes) return 'entry-too-large';
  if (!probe.namespaceExists && probe.global.namespaces >= limits.maxNamespaces) {
    return 'namespace-limit';
  }

  const oldEntries = probe.replacing ? 1 : 0;
  const oldBytes = probe.replacing ? (probe.replacedByteSize ?? 0) : 0;
  if (probe.global.entries - oldEntries + 1 > limits.maxEntries) return 'entry-capacity';
  if (probe.global.bytes - oldBytes + probe.byteSize > limits.maxBytes) return 'byte-capacity';
  if (probe.namespace.entries - oldEntries + 1 > limits.maxEntriesPerNamespace) {
    return 'namespace-entry-capacity';
  }
  if (probe.namespace.bytes - oldBytes + probe.byteSize > limits.maxBytesPerNamespace) {
    return 'namespace-byte-capacity';
  }
  return undefined;
};
