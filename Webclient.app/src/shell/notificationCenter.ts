export type NotificationSeverity = 'error' | 'warning' | 'success' | 'info';

export interface NotificationInput {
  readonly id?: string;
  readonly message: string;
  readonly severity?: NotificationSeverity;
  readonly scope?: string;
  readonly ttlMs?: number | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface NotificationRecord {
  readonly id: string;
  readonly message: string;
  readonly severity: NotificationSeverity;
  readonly scope: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number | null;
  readonly occurrences: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface NotificationSnapshot {
  readonly capacity: number;
  readonly active: readonly NotificationRecord[];
  readonly totalPublished: number;
  readonly totalDismissed: number;
  readonly totalExpired: number;
  readonly totalDropped: number;
  readonly duplicateCollapses: number;
}

export interface NotificationEvent {
  readonly type: 'published' | 'updated' | 'dismissed' | 'expired' | 'dropped' | 'cleared';
  readonly notification: NotificationRecord | null;
  readonly timestamp: number;
}

export interface NotificationCenter {
  readonly publish: (input: NotificationInput) => NotificationRecord;
  readonly dismiss: (id: string) => boolean;
  readonly clear: () => number;
  readonly purgeExpired: () => number;
  readonly get: (id: string) => NotificationRecord | null;
  readonly snapshot: () => NotificationSnapshot;
  readonly subscribe: (listener: (event: NotificationEvent) => void) => () => boolean;
  readonly destroy: () => void;
}

export interface NotificationCenterOptions {
  readonly capacity?: number;
  readonly defaultTtlMs?: number | null;
  readonly dedupeWindowMs?: number;
  readonly now?: () => number;
}

const safeInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
};

const normalizeOptionalText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
};

const normalizeMessage = (value: unknown): string => {
  if (typeof value !== 'string') throw new TypeError('Notification message must be a string.');
  const normalized = value.trim();
  if (!normalized) throw new TypeError('Notification message cannot be empty.');
  if (normalized.length > 2_000) throw new RangeError('Notification message exceeds 2000 characters.');
  return normalized;
};

const normalizeSeverity = (value: unknown): NotificationSeverity =>
  value === 'error' || value === 'warning' || value === 'success' || value === 'info'
    ? value
    : 'info';

const normalizeMetadata = (
  value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> => {
  if (!value) return Object.freeze({});
  const entries = Object.entries(value).slice(0, 24);
  const safe: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    const normalizedKey = key.trim();
    if (!normalizedKey) continue;
    if (/(token|secret|password|authorization|cookie|credential)/iu.test(normalizedKey)) continue;
    if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') continue;
    safe[normalizedKey] = item;
  }
  return Object.freeze(safe);
};

const freezeRecord = (record: NotificationRecord): NotificationRecord =>
  Object.freeze({ ...record, metadata: Object.freeze({ ...record.metadata }) });

export const createNotificationCenter = (
  options: NotificationCenterOptions = {},
): NotificationCenter => {
  const capacity = safeInteger(options.capacity, 50, 1, 500);
  const dedupeWindowMs = safeInteger(options.dedupeWindowMs, 1_500, 0, 60_000);
  const defaultTtlMs = options.defaultTtlMs === null
    ? null
    : safeInteger(options.defaultTtlMs, 5_000, 250, 86_400_000);
  const now = options.now ?? (() => Date.now());

  let sequence = 0;
  let destroyed = false;
  let active: NotificationRecord[] = [];
  let totalPublished = 0;
  let totalDismissed = 0;
  let totalExpired = 0;
  let totalDropped = 0;
  let duplicateCollapses = 0;
  const listeners = new Set<(event: NotificationEvent) => void>();

  const timestamp = (): number => {
    const value = Number(now());
    if (!Number.isFinite(value)) throw new TypeError('Notification clock must return a finite timestamp.');
    return value;
  };

  const assertActive = (): void => {
    if (destroyed) throw new Error('Notification center is destroyed.');
  };

  const emit = (type: NotificationEvent['type'], notification: NotificationRecord | null): void => {
    const event = Object.freeze({ type, notification, timestamp: timestamp() });
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // Observers are best-effort and must never replace the business outcome.
      }
    }
  };

  const expirationFor = (ttlMs: number | null | undefined, at: number): number | null => {
    if (ttlMs === null) return null;
    const normalized = ttlMs === undefined
      ? defaultTtlMs
      : safeInteger(ttlMs, defaultTtlMs ?? 5_000, 250, 86_400_000);
    return normalized === null ? null : at + normalized;
  };

  const purgeExpired = (): number => {
    assertActive();
    const at = timestamp();
    const expired = active.filter((item) => item.expiresAt !== null && item.expiresAt <= at);
    if (!expired.length) return 0;
    const ids = new Set(expired.map((item) => item.id));
    active = active.filter((item) => !ids.has(item.id));
    totalExpired += expired.length;
    for (const item of expired) emit('expired', item);
    return expired.length;
  };

  const publish = (input: NotificationInput): NotificationRecord => {
    assertActive();
    purgeExpired();
    const at = timestamp();
    const message = normalizeMessage(input.message);
    const severity = normalizeSeverity(input.severity);
    const scope = normalizeOptionalText(input.scope);
    const explicitId = normalizeOptionalText(input.id);
    const metadata = normalizeMetadata(input.metadata);
    const fingerprint = [severity, scope ?? '', message].join('\u0000');

    const duplicateIndex = [...active].reverse().findIndex((item) =>
      [item.severity, item.scope ?? '', item.message].join('\u0000') === fingerprint
      && at - item.updatedAt <= dedupeWindowMs);
    if (duplicateIndex >= 0) {
      const actualIndex = active.length - 1 - duplicateIndex;
      const existing = active[actualIndex];
      if (!existing) throw new Error('Notification dedupe index drifted.');
      const updated = freezeRecord({
        ...existing,
        updatedAt: at,
        expiresAt: expirationFor(input.ttlMs, at),
        occurrences: existing.occurrences + 1,
        metadata,
      });
      active = [...active.slice(0, actualIndex), ...active.slice(actualIndex + 1), updated];
      totalPublished += 1;
      duplicateCollapses += 1;
      emit('updated', updated);
      return updated;
    }

    const id = explicitId ?? `notification-${++sequence}`;
    if (active.some((item) => item.id === id)) {
      throw new Error(`Notification id already exists: ${id}`);
    }

    const record = freezeRecord({
      id,
      message,
      severity,
      scope,
      createdAt: at,
      updatedAt: at,
      expiresAt: expirationFor(input.ttlMs, at),
      occurrences: 1,
      metadata,
    });
    active = [...active, record];
    totalPublished += 1;
    emit('published', record);

    while (active.length > capacity) {
      const dropped = active[0];
      if (!dropped) break;
      active = active.slice(1);
      totalDropped += 1;
      emit('dropped', dropped);
    }
    return record;
  };

  const dismiss = (idInput: string): boolean => {
    assertActive();
    const id = normalizeOptionalText(idInput);
    if (!id) return false;
    const index = active.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const [removed] = active.splice(index, 1);
    active = [...active];
    totalDismissed += 1;
    emit('dismissed', removed ?? null);
    return true;
  };

  const clear = (): number => {
    assertActive();
    const count = active.length;
    active = [];
    if (count > 0) emit('cleared', null);
    return count;
  };

  const snapshot = (): NotificationSnapshot => {
    assertActive();
    purgeExpired();
    return Object.freeze({
      capacity,
      active: Object.freeze([...active]),
      totalPublished,
      totalDismissed,
      totalExpired,
      totalDropped,
      duplicateCollapses,
    });
  };

  const get = (id: string): NotificationRecord | null => {
    assertActive();
    purgeExpired();
    return active.find((item) => item.id === id) ?? null;
  };

  const subscribe = (listener: (event: NotificationEvent) => void): (() => boolean) => {
    assertActive();
    if (typeof listener !== 'function') throw new TypeError('Notification listener must be a function.');
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const destroy = (): void => {
    if (destroyed) return;
    active = [];
    listeners.clear();
    destroyed = true;
  };

  return Object.freeze({ publish, dismiss, clear, purgeExpired, get, snapshot, subscribe, destroy });
};
