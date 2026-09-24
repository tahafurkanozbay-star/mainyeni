export type NotificationTone = 'info' | 'success' | 'warning' | 'error';
export type NotificationPriority = 'normal' | 'urgent';

export interface NotificationAction {
  readonly id: string;
  readonly label: string;
}

export interface NotificationInput {
  readonly id: string;
  readonly title: string;
  readonly message?: string;
  readonly tone?: NotificationTone;
  readonly priority?: NotificationPriority;
  readonly category?: string;
  readonly dismissible?: boolean;
  readonly sticky?: boolean;
  readonly createdAt?: number;
  readonly expiresAt?: number | null;
  readonly dedupeKey?: string;
  readonly actions?: readonly NotificationAction[];
}

export interface NotificationItem {
  readonly id: string;
  readonly title: string;
  readonly message: string;
  readonly tone: NotificationTone;
  readonly priority: NotificationPriority;
  readonly category: string;
  readonly dismissible: boolean;
  readonly sticky: boolean;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly dedupeKey: string | null;
  readonly actions: readonly NotificationAction[];
  readonly read: boolean;
  readonly occurrenceCount: number;
}

export interface NotificationAnnouncement {
  readonly politeness: 'polite' | 'assertive';
  readonly text: string;
  readonly notificationId: string;
}

export interface NotificationCenterSnapshot {
  readonly items: readonly NotificationItem[];
  readonly unreadCount: number;
  readonly urgentUnreadCount: number;
  readonly categories: readonly string[];
  readonly announcement: NotificationAnnouncement | null;
  readonly revision: number;
}

export interface NotificationCenterModelOptions {
  readonly capacity?: number;
  readonly now?: () => number;
  readonly onObserverError?: (error: unknown) => void;
}

type Observer = (snapshot: NotificationCenterSnapshot) => void;

const DEFAULT_CAPACITY = 64;
const MAX_CAPACITY = 200;
const MAX_ACTIONS = 4;
const MAX_TEXT = 800;

const cleanText = (value: string, field: string): string => {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized.slice(0, MAX_TEXT);
};

const optionalText = (value: string | undefined): string => value?.trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT) ?? '';

const normalizeAction = (action: NotificationAction): NotificationAction => ({
  id: cleanText(action.id, 'Notification action id'),
  label: cleanText(action.label, 'Notification action label'),
});

const normalizeCapacity = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return DEFAULT_CAPACITY;
  return Math.max(1, Math.min(MAX_CAPACITY, Math.floor(value ?? DEFAULT_CAPACITY)));
};

const freezeItem = (item: NotificationItem): NotificationItem => Object.freeze({
  ...item,
  actions: Object.freeze([...item.actions]),
});

const announcementText = (item: NotificationItem): string => {
  const prefix = item.tone === 'error'
    ? 'Hata'
    : item.tone === 'warning'
      ? 'Uyarı'
      : item.tone === 'success'
        ? 'Başarılı'
        : 'Bilgi';
  const repeated = item.occurrenceCount > 1 ? ` ${item.occurrenceCount} kez tekrarlandı.` : '';
  return `${prefix}: ${item.title}${item.message ? `. ${item.message}` : ''}${repeated}`;
};

export class NotificationCenterModel {
  readonly #capacity: number;
  readonly #now: () => number;
  readonly #onObserverError: ((error: unknown) => void) | undefined;
  readonly #observers = new Set<Observer>();
  #items: NotificationItem[] = [];
  #revision = 0;
  #announcement: NotificationAnnouncement | null = null;

  constructor(options: NotificationCenterModelOptions = {}) {
    this.#capacity = normalizeCapacity(options.capacity);
    this.#now = options.now ?? Date.now;
    this.#onObserverError = options.onObserverError;
  }

  push(input: NotificationInput): NotificationItem {
    const now = this.#now();
    const item = this.#normalizeInput(input, now);
    const duplicateIndex = item.dedupeKey
      ? this.#items.findIndex((candidate) => candidate.dedupeKey === item.dedupeKey)
      : -1;

    let stored: NotificationItem;
    if (duplicateIndex >= 0) {
      const previous = this.#items[duplicateIndex];
      if (!previous) throw new Error('Notification dedupe index became invalid.');
      stored = freezeItem({
        ...item,
        id: previous.id,
        createdAt: now,
        occurrenceCount: previous.occurrenceCount + 1,
        read: false,
      });
      this.#items.splice(duplicateIndex, 1);
    } else {
      if (this.#items.some((candidate) => candidate.id === item.id)) {
        throw new Error(`Notification "${item.id}" already exists.`);
      }
      stored = freezeItem(item);
    }

    this.#items.unshift(stored);
    this.#enforceCapacity();
    this.#announcement = Object.freeze({
      politeness: stored.priority === 'urgent' || stored.tone === 'error' ? 'assertive' : 'polite',
      text: announcementText(stored),
      notificationId: stored.id,
    });
    this.#changed();
    return stored;
  }

  markRead(id: string): boolean {
    return this.#update(id, (item) => item.read ? item : freezeItem({ ...item, read: true }));
  }

  markUnread(id: string): boolean {
    return this.#update(id, (item) => !item.read ? item : freezeItem({ ...item, read: false }));
  }

  markAllRead(): number {
    let changed = 0;
    this.#items = this.#items.map((item) => {
      if (item.read) return item;
      changed += 1;
      return freezeItem({ ...item, read: true });
    });
    if (changed > 0) this.#changed();
    return changed;
  }

  dismiss(id: string): boolean {
    const index = this.#items.findIndex((item) => item.id === id);
    const item = this.#items[index];
    if (index < 0 || !item || !item.dismissible) return false;
    this.#items.splice(index, 1);
    if (this.#announcement?.notificationId === id) this.#announcement = null;
    this.#changed();
    return true;
  }

  clearRead(): number {
    const previousLength = this.#items.length;
    this.#items = this.#items.filter((item) => !item.read || !item.dismissible);
    const removed = previousLength - this.#items.length;
    if (removed > 0) this.#changed();
    return removed;
  }

  pruneExpired(now = this.#now()): number {
    const previousLength = this.#items.length;
    const removedIds = new Set(
      this.#items
        .filter((item) => !item.sticky && item.expiresAt !== null && item.expiresAt <= now)
        .map((item) => item.id),
    );
    if (removedIds.size === 0) return 0;
    this.#items = this.#items.filter((item) => !removedIds.has(item.id));
    if (this.#announcement && removedIds.has(this.#announcement.notificationId)) this.#announcement = null;
    this.#changed();
    return previousLength - this.#items.length;
  }

  acknowledgeAnnouncement(notificationId?: string): boolean {
    if (!this.#announcement) return false;
    if (notificationId && this.#announcement.notificationId !== notificationId) return false;
    this.#announcement = null;
    this.#changed();
    return true;
  }

  snapshot(): NotificationCenterSnapshot {
    const items = Object.freeze(this.#items.map(freezeItem));
    const unread = items.filter((item) => !item.read);
    const categories = Object.freeze(Array.from(new Set(items.map((item) => item.category))).sort((a, b) => a.localeCompare(b, 'tr')));
    return Object.freeze({
      items,
      unreadCount: unread.length,
      urgentUnreadCount: unread.filter((item) => item.priority === 'urgent' || item.tone === 'error').length,
      categories,
      announcement: this.#announcement,
      revision: this.#revision,
    });
  }

  subscribe(observer: Observer): () => void {
    this.#observers.add(observer);
    this.#deliver(observer, this.snapshot());
    return () => this.#observers.delete(observer);
  }

  #normalizeInput(input: NotificationInput, now: number): NotificationItem {
    const actions = input.actions?.map(normalizeAction) ?? [];
    if (actions.length > MAX_ACTIONS) throw new Error(`Notification action capacity exceeded (${MAX_ACTIONS}).`);
    if (new Set(actions.map((action) => action.id)).size !== actions.length) {
      throw new Error('Notification action ids must be unique.');
    }
    const expiresAt = input.sticky ? null : input.expiresAt ?? null;
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt < 0)) {
      throw new Error('Notification expiresAt must be a finite non-negative timestamp or null.');
    }
    return freezeItem({
      id: cleanText(input.id, 'Notification id'),
      title: cleanText(input.title, 'Notification title'),
      message: optionalText(input.message),
      tone: input.tone ?? 'info',
      priority: input.priority ?? 'normal',
      category: optionalText(input.category) || 'general',
      dismissible: input.dismissible !== false,
      sticky: input.sticky === true,
      createdAt: input.createdAt ?? now,
      expiresAt,
      dedupeKey: input.dedupeKey ? cleanText(input.dedupeKey, 'Notification dedupe key') : null,
      actions,
      read: false,
      occurrenceCount: 1,
    });
  }

  #update(id: string, update: (item: NotificationItem) => NotificationItem): boolean {
    const normalized = id.trim();
    const index = this.#items.findIndex((item) => item.id === normalized);
    const current = this.#items[index];
    if (index < 0 || !current) return false;
    const next = update(current);
    if (next === current) return false;
    this.#items[index] = next;
    this.#changed();
    return true;
  }

  #enforceCapacity(): void {
    if (this.#items.length <= this.#capacity) return;
    const overflow = this.#items.length - this.#capacity;
    const removable = this.#items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !item.sticky)
      .sort((left, right) => right.index - left.index)
      .slice(0, overflow)
      .map(({ index }) => index);
    const removeIndexes = new Set(removable);
    this.#items = this.#items.filter((_item, index) => !removeIndexes.has(index));
    if (this.#items.length > this.#capacity) this.#items.length = this.#capacity;
  }

  #changed(): void {
    this.#revision += 1;
    const snapshot = this.snapshot();
    this.#observers.forEach((observer) => this.#deliver(observer, snapshot));
  }

  #deliver(observer: Observer, snapshot: NotificationCenterSnapshot): void {
    try {
      observer(snapshot);
    } catch (error) {
      const reporter = this.#onObserverError;
      if (!reporter) return;
      try {
        reporter(error);
      } catch (reporterError) {
        void reporterError;
      }
    }
  }
}
