export type AnnouncementPriority = 'polite' | 'assertive';

export interface Announcement {
  readonly id: number;
  readonly message: string;
  readonly priority: AnnouncementPriority;
  readonly createdAt: number;
  readonly dedupeKey: string;
}

export interface LiveRegionOptions {
  readonly document: Document;
  readonly maxQueue?: number;
  readonly dedupeWindowMs?: number;
  readonly clearDelayMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface LiveRegionSnapshot {
  readonly queued: number;
  readonly delivered: number;
  readonly dropped: number;
  readonly disposed: boolean;
}

export interface LiveRegionRuntime {
  announce(message: string, options?: { readonly priority?: AnnouncementPriority; readonly dedupeKey?: string }): boolean;
  clear(): void;
  getSnapshot(): LiveRegionSnapshot;
  dispose(): void;
}

const visuallyHiddenStyle = [
  'position:absolute',
  'width:1px',
  'height:1px',
  'padding:0',
  'margin:-1px',
  'overflow:hidden',
  'clip:rect(0,0,0,0)',
  'white-space:nowrap',
  'border:0',
].join(';');

function createRegion(document: Document, priority: AnnouncementPriority): HTMLElement {
  const element = document.createElement('div');
  element.dataset.experienceLiveRegion = priority;
  element.setAttribute('role', priority === 'assertive' ? 'alert' : 'status');
  element.setAttribute('aria-live', priority);
  element.setAttribute('aria-atomic', 'true');
  element.setAttribute('style', visuallyHiddenStyle);
  return element;
}

export function createLiveRegionRuntime(options: LiveRegionOptions): LiveRegionRuntime {
  const maxQueue = options.maxQueue ?? 20;
  const dedupeWindowMs = options.dedupeWindowMs ?? 1500;
  const clearDelayMs = options.clearDelayMs ?? 4000;
  if (!Number.isInteger(maxQueue) || maxQueue < 1) throw new RangeError('maxQueue must be a positive integer');
  if (!Number.isFinite(dedupeWindowMs) || dedupeWindowMs < 0) throw new RangeError('dedupeWindowMs must be non-negative');
  if (!Number.isFinite(clearDelayMs) || clearDelayMs < 0) throw new RangeError('clearDelayMs must be non-negative');

  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const polite = createRegion(options.document, 'polite');
  const assertive = createRegion(options.document, 'assertive');
  const queue: Announcement[] = [];
  const dedupe = new Map<string, number>();
  let sequence = 0;
  let delivered = 0;
  let dropped = 0;
  let disposed = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let clearPoliteTimer: ReturnType<typeof setTimeout> | null = null;
  let clearAssertiveTimer: ReturnType<typeof setTimeout> | null = null;

  options.document.body.append(polite, assertive);

  const scheduleClear = (priority: AnnouncementPriority) => {
    const region = priority === 'assertive' ? assertive : polite;
    const existing = priority === 'assertive' ? clearAssertiveTimer : clearPoliteTimer;
    if (existing) clearTimer(existing);
    const timer = setTimer(() => {
      region.textContent = '';
      if (priority === 'assertive') clearAssertiveTimer = null;
      else clearPoliteTimer = null;
    }, clearDelayMs);
    if (priority === 'assertive') clearAssertiveTimer = timer;
    else clearPoliteTimer = timer;
  };

  const flush = () => {
    flushTimer = null;
    if (disposed) return;
    const item = queue.shift();
    if (!item) return;
    const region = item.priority === 'assertive' ? assertive : polite;
    region.textContent = '';
    region.textContent = item.message;
    delivered += 1;
    scheduleClear(item.priority);
    if (queue.length) flushTimer = setTimer(flush, 0);
  };

  const scheduleFlush = () => {
    if (!flushTimer) flushTimer = setTimer(flush, 0);
  };

  return {
    announce(message, announceOptions) {
      if (disposed) return false;
      const normalized = message.replace(/\s+/g, ' ').trim();
      if (!normalized) return false;
      const priority = announceOptions?.priority ?? 'polite';
      const dedupeKey = announceOptions?.dedupeKey ?? `${priority}:${normalized}`;
      const timestamp = now();
      const last = dedupe.get(dedupeKey);
      if (last != null && timestamp - last < dedupeWindowMs) {
        dropped += 1;
        return false;
      }
      dedupe.set(dedupeKey, timestamp);
      for (const [key, seenAt] of dedupe) {
        if (timestamp - seenAt > dedupeWindowMs * 2) dedupe.delete(key);
      }
      if (queue.length >= maxQueue) {
        const politeIndex = queue.findIndex((item) => item.priority === 'polite');
        if (politeIndex >= 0) queue.splice(politeIndex, 1);
        else queue.shift();
        dropped += 1;
      }
      queue.push({ id: ++sequence, message: normalized, priority, createdAt: timestamp, dedupeKey });
      scheduleFlush();
      return true;
    },
    clear() {
      queue.splice(0);
      polite.textContent = '';
      assertive.textContent = '';
      if (flushTimer) clearTimer(flushTimer);
      if (clearPoliteTimer) clearTimer(clearPoliteTimer);
      if (clearAssertiveTimer) clearTimer(clearAssertiveTimer);
      flushTimer = clearPoliteTimer = clearAssertiveTimer = null;
    },
    getSnapshot() {
      return { queued: queue.length, delivered, dropped, disposed };
    },
    dispose() {
      if (disposed) return;
      this.clear();
      disposed = true;
      dedupe.clear();
      polite.remove();
      assertive.remove();
    },
  };
}
