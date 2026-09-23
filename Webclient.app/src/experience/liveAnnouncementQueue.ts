export type AnnouncementPoliteness = 'polite' | 'assertive';

export interface LiveAnnouncementInput {
  readonly message: string;
  readonly politeness?: AnnouncementPoliteness;
  readonly dedupeKey?: string;
  readonly ttlMs?: number;
}

export interface LiveAnnouncement {
  readonly id: number;
  readonly message: string;
  readonly politeness: AnnouncementPoliteness;
  readonly dedupeKey: string | null;
  readonly createdAt: number;
  readonly expiresAt: number | null;
}

export interface LiveAnnouncementSnapshot {
  readonly current: LiveAnnouncement | null;
  readonly pending: readonly LiveAnnouncement[];
  readonly revision: number;
}

export interface LiveAnnouncementQueueOptions {
  readonly maxPending?: number;
  readonly defaultTtlMs?: number | null;
  readonly now?: () => number;
}

const DEFAULT_MAX_PENDING = 24;
const MAX_PENDING_LIMIT = 128;
const MAX_MESSAGE_LENGTH = 500;
const MAX_TTL_MS = 60_000;

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function normalizeMessage(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_LENGTH);
}

function normalizeTtl(value: number | null | undefined, fallback: number | null): number | null {
  const candidate = value === undefined ? fallback : value;
  if (candidate === null) return null;
  if (!Number.isFinite(candidate) || candidate <= 0) return null;
  return Math.min(MAX_TTL_MS, Math.floor(candidate));
}

/**
 * Framework-neutral live-region queue. It deliberately owns no timers or DOM
 * nodes: React surfaces decide when an announcement has actually been exposed
 * to assistive technology and acknowledge it. This keeps background work
 * bounded and makes screen-reader sequencing deterministic.
 */
export function createLiveAnnouncementQueue(options: LiveAnnouncementQueueOptions = {}) {
  const maxPending = boundedInteger(options.maxPending, DEFAULT_MAX_PENDING, MAX_PENDING_LIMIT);
  const defaultTtlMs = normalizeTtl(options.defaultTtlMs, null);
  const now = options.now ?? Date.now;

  let sequence = 0;
  let revision = 0;
  let current: LiveAnnouncement | null = null;
  let pending: LiveAnnouncement[] = [];
  const listeners = new Set<(snapshot: LiveAnnouncementSnapshot) => void>();

  const snapshot = (): LiveAnnouncementSnapshot => Object.freeze({
    current,
    pending: Object.freeze([...pending]),
    revision,
  });

  const emit = () => {
    revision += 1;
    const next = snapshot();
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // A presentation observer must never break the accessibility channel.
      }
    }
  };

  const isExpired = (item: LiveAnnouncement, at: number) =>
    item.expiresAt !== null && item.expiresAt <= at;

  const removeExpired = (at: number): boolean => {
    const before = pending.length;
    pending = pending.filter((item) => !isExpired(item, at));
    if (current && isExpired(current, at)) current = null;
    return before !== pending.length;
  };

  const promote = (at: number): boolean => {
    removeExpired(at);
    if (current) return false;
    const next = pending.shift() ?? null;
    if (!next) return false;
    current = next;
    return true;
  };

  const enqueue = (input: LiveAnnouncementInput): LiveAnnouncement | null => {
    const message = normalizeMessage(input.message);
    if (!message) return null;

    const at = now();
    removeExpired(at);
    const dedupeKey = input.dedupeKey?.trim() || null;
    const duplicate = dedupeKey !== null &&
      (current?.dedupeKey === dedupeKey || pending.some((item) => item.dedupeKey === dedupeKey));
    if (duplicate) return null;

    const ttlMs = normalizeTtl(input.ttlMs, defaultTtlMs);
    const item: LiveAnnouncement = Object.freeze({
      id: ++sequence,
      message,
      politeness: input.politeness ?? 'polite',
      dedupeKey,
      createdAt: at,
      expiresAt: ttlMs === null ? null : at + ttlMs,
    });

    if (item.politeness === 'assertive') {
      // Assertive feedback is promoted immediately, but the interrupted polite
      // item is preserved at the front so information is not silently lost.
      if (current?.politeness === 'polite') pending.unshift(current);
      current = item;
    } else if (!current) {
      current = item;
    } else {
      pending.push(item);
    }

    if (pending.length > maxPending) pending = pending.slice(0, maxPending);
    emit();
    return item;
  };

  const acknowledge = (id: number): boolean => {
    if (current?.id !== id) return false;
    current = null;
    promote(now());
    emit();
    return true;
  };

  const dismiss = (id: number): boolean => {
    if (current?.id === id) return acknowledge(id);
    const next = pending.filter((item) => item.id !== id);
    if (next.length === pending.length) return false;
    pending = next;
    emit();
    return true;
  };

  const sweep = (): boolean => {
    const at = now();
    const previousCurrent = current;
    const previousPending = pending.length;
    removeExpired(at);
    promote(at);
    const changed = previousCurrent !== current || previousPending !== pending.length;
    if (changed) emit();
    return changed;
  };

  const clear = () => {
    if (!current && pending.length === 0) return;
    current = null;
    pending = [];
    emit();
  };

  const subscribe = (listener: (snapshot: LiveAnnouncementSnapshot) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return Object.freeze({ enqueue, acknowledge, dismiss, sweep, clear, snapshot, subscribe });
}

export type LiveAnnouncementQueue = ReturnType<typeof createLiveAnnouncementQueue>;
