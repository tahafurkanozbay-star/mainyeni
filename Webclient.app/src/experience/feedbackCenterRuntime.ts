import {
  FeedbackQueue,
  createFeedbackViewModel,
  type FeedbackInput,
  type FeedbackViewModel,
} from './feedbackExperience';
import {
  createFeedbackAccessibilitySnapshot,
  type FeedbackAccessibilitySnapshot,
  type FeedbackViewport,
} from './feedbackAccessibilityController';
import {
  createFeedbackHistoryAccessibilityModel,
  type FeedbackHistoryAccessibilityModel,
  type FeedbackHistoryViewport,
} from './feedbackHistoryAccessibility';
import {
  createFeedbackHistoryControlsSnapshot,
  type FeedbackHistoryControlsSnapshot,
  type FeedbackHistoryControlsViewport,
} from './feedbackHistoryControls';
import {
  createDefaultFeedbackHistoryPreferenceEnvelope,
  createFeedbackHistoryPreferenceSnapshot,
  parseFeedbackHistoryPreferenceEnvelope,
  reduceFeedbackHistoryPreferences,
  serializeFeedbackHistoryPreferenceEnvelope,
  shouldAnnounceFeedbackHistoryItem,
  type FeedbackHistoryPreferenceAction,
  type FeedbackHistoryPreferenceContext,
  type FeedbackHistoryPreferenceEnvelope,
  type FeedbackHistoryPreferenceSnapshot,
} from './feedbackHistoryPreferences';
import {
  createFeedbackHistorySessionState,
  createFeedbackHistorySessionView,
  reduceFeedbackHistorySession,
  type FeedbackHistorySessionCommand,
  type FeedbackHistorySessionEffect,
  type FeedbackHistorySessionState,
  type FeedbackHistorySessionView,
} from './feedbackHistorySession';

export type FeedbackCenterViewport = 'phone' | 'tablet' | 'desktop';

export interface FeedbackCenterEnvironment {
  readonly viewport: FeedbackCenterViewport;
  readonly coarsePointer?: boolean;
  readonly reducedMotion?: boolean;
  readonly forcedColors?: boolean;
  readonly keyboardModality?: boolean;
}

export interface FeedbackCenterPublication extends FeedbackInput {
  readonly occurredAt?: number;
}

export interface FeedbackCenterSnapshot {
  readonly revision: number;
  readonly visible: readonly FeedbackViewModel[];
  readonly history: FeedbackHistorySessionView;
  readonly accessibility: FeedbackAccessibilitySnapshot;
  readonly historyAccessibility: FeedbackHistoryAccessibilityModel;
  readonly controls: FeedbackHistoryControlsSnapshot;
  readonly preferences: FeedbackHistoryPreferenceSnapshot;
  readonly unreadCount: number;
  readonly importantCount: number;
  readonly triggerLabel: string;
  readonly triggerDescription: string;
  readonly lastEffect: FeedbackHistorySessionEffect;
  readonly lastAnnouncement: string;
}

export interface FeedbackCenterRuntimeOptions {
  readonly maxVisible?: number;
  readonly maxQueued?: number;
  readonly now?: () => number;
  readonly onObserverError?: (error: unknown) => void;
}

type FeedbackCenterSubscriber = () => void;

const DEFAULT_ENVIRONMENT: FeedbackCenterEnvironment = Object.freeze({
  viewport: 'desktop',
  coarsePointer: false,
  reducedMotion: false,
  forcedColors: false,
  keyboardModality: false,
});

const normalizedViewport = (value: FeedbackCenterViewport): FeedbackCenterViewport =>
  value === 'phone' || value === 'tablet' ? value : 'desktop';

const normalizeEnvironment = (
  environment: FeedbackCenterEnvironment = DEFAULT_ENVIRONMENT,
): FeedbackCenterEnvironment => Object.freeze({
  viewport: normalizedViewport(environment.viewport),
  coarsePointer: Boolean(environment.coarsePointer),
  reducedMotion: Boolean(environment.reducedMotion),
  forcedColors: Boolean(environment.forcedColors),
  keyboardModality: Boolean(environment.keyboardModality),
});

const safeNow = (clock: () => number): number => {
  const value = Number(clock());
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now();
};

const nextRevision = (revision: number): number =>
  Number.isSafeInteger(revision) && revision >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, revision + 1)
    : 1;

const triggerLabel = (unreadCount: number): string =>
  unreadCount > 0 ? `Bildirimler, ${unreadCount} okunmamış` : 'Bildirimler';

const triggerDescription = (
  historyOpen: boolean,
  unreadCount: number,
  importantCount: number,
): string => {
  if (historyOpen) return 'Bildirim geçmişi açık.';
  if (unreadCount === 0) return 'Yeni bildirim yok.';
  if (importantCount > 0) return `${unreadCount} okunmamış, ${importantCount} önemli bildirim var.`;
  return `${unreadCount} okunmamış bildirim var.`;
};

const preferenceContext = (
  environment: FeedbackCenterEnvironment,
  now: number,
): FeedbackHistoryPreferenceContext => Object.freeze({
  now,
  coarsePointer: environment.coarsePointer,
  reducedMotion: environment.reducedMotion,
  forcedColors: environment.forcedColors,
});

const viewportForAccessibility = (viewport: FeedbackCenterViewport): FeedbackViewport => viewport;
const viewportForHistory = (viewport: FeedbackCenterViewport): FeedbackHistoryViewport => viewport;
const viewportForControls = (viewport: FeedbackCenterViewport): FeedbackHistoryControlsViewport => viewport;

export class FeedbackCenterRuntime {
  readonly #queue: FeedbackQueue;
  readonly #clock: () => number;
  readonly #onObserverError: ((error: unknown) => void) | null;
  readonly #subscribers = new Set<FeedbackCenterSubscriber>();
  #environment: FeedbackCenterEnvironment = DEFAULT_ENVIRONMENT;
  #history: FeedbackHistorySessionState;
  #preferences: FeedbackHistoryPreferenceEnvelope;
  #revision = 0;
  #lastEffect: FeedbackHistorySessionEffect = Object.freeze({ type: 'none' });
  #snapshot: FeedbackCenterSnapshot;

  constructor(options: FeedbackCenterRuntimeOptions = {}) {
    this.#clock = typeof options.now === 'function' ? options.now : () => Date.now();
    this.#onObserverError = typeof options.onObserverError === 'function' ? options.onObserverError : null;
    this.#queue = new FeedbackQueue({
      maxVisible: options.maxVisible,
      maxQueued: options.maxQueued,
    });
    const now = safeNow(this.#clock);
    this.#history = createFeedbackHistorySessionState(now);
    this.#preferences = createDefaultFeedbackHistoryPreferenceEnvelope(now);
    this.#snapshot = this.#buildSnapshot(now);
  }

  #buildSnapshot(now = safeNow(this.#clock)): FeedbackCenterSnapshot {
    const visible = Object.freeze(this.#queue.snapshot(now));
    const history = createFeedbackHistorySessionView(this.#history);
    const historySnapshot = history.history;
    const prefs = createFeedbackHistoryPreferenceSnapshot(
      this.#preferences,
      preferenceContext(this.#environment, now),
    );
    const accessibility = createFeedbackAccessibilitySnapshot({
      items: visible,
      viewport: viewportForAccessibility(this.#environment.viewport),
      coarsePointer: this.#environment.coarsePointer,
      reducedMotion: this.#environment.reducedMotion,
      forcedColors: this.#environment.forcedColors,
      keyboardModality: this.#environment.keyboardModality,
      returnFocusId: 'experience-feedback-trigger',
    });
    const historyAccessibility = createFeedbackHistoryAccessibilityModel({
      snapshot: historySnapshot,
      filter: this.#history.history.filter,
      sort: this.#history.history.sort,
      viewport: viewportForHistory(this.#environment.viewport),
      open: this.#history.open,
      coarsePointer: this.#environment.coarsePointer,
      reducedMotion: this.#environment.reducedMotion,
      forcedColors: this.#environment.forcedColors,
      callerId: this.#history.callerId,
    });
    const controls = createFeedbackHistoryControlsSnapshot({
      history: historySnapshot,
      filter: this.#history.history.filter,
      sort: this.#history.history.sort,
      viewport: viewportForControls(this.#environment.viewport),
      coarsePointer: this.#environment.coarsePointer,
      reducedMotion: this.#environment.reducedMotion,
      forcedColors: this.#environment.forcedColors,
    });
    return Object.freeze({
      revision: this.#revision,
      visible,
      history,
      accessibility,
      historyAccessibility,
      controls,
      preferences: prefs,
      unreadCount: historySnapshot.unreadCount,
      importantCount: historySnapshot.importantCount,
      triggerLabel: triggerLabel(historySnapshot.unreadCount),
      triggerDescription: triggerDescription(
        this.#history.open,
        historySnapshot.unreadCount,
        historySnapshot.importantCount,
      ),
      lastEffect: this.#lastEffect,
      lastAnnouncement: this.#history.lastAnnouncement,
    });
  }

  #emit(): void {
    this.#revision = nextRevision(this.#revision);
    this.#snapshot = this.#buildSnapshot();
    const subscribers = [...this.#subscribers];
    for (const subscriber of subscribers) {
      try {
        subscriber();
      } catch (error) {
        try {
          this.#onObserverError?.(error);
        } catch {
          // Observer reporting must never break the feedback surface.
        }
      }
    }
  }

  #applyHistory(command: FeedbackHistorySessionCommand, now = safeNow(this.#clock)): void {
    const transition = reduceFeedbackHistorySession(this.#history, command, now);
    this.#history = transition.state;
    this.#lastEffect = transition.effect;
  }

  snapshot(): FeedbackCenterSnapshot {
    return this.#snapshot;
  }

  subscribe(subscriber: FeedbackCenterSubscriber): () => void {
    if (typeof subscriber !== 'function') return () => undefined;
    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  publish(publication: FeedbackCenterPublication): FeedbackViewModel | null {
    const now = Number.isFinite(publication.occurredAt)
      ? Math.max(0, Math.trunc(Number(publication.occurredAt)))
      : safeNow(this.#clock);
    const model = createFeedbackViewModel(publication, now);
    if (!model || model.expired) return null;
    this.#queue.push(publication);
    this.#applyHistory({
      type: 'append',
      item: Object.freeze({
        feedback: model,
        occurredAt: now,
        read: false,
      }),
    }, now);
    const importance = model.priority === 'assertive' || model.tone === 'warning' || model.tone === 'danger'
      ? 'important'
      : 'normal';
    if (!shouldAnnounceFeedbackHistoryItem(this.#preferences.preferences.announcementMode, importance)) {
      this.#lastEffect = Object.freeze({ type: 'none' });
    }
    this.#emit();
    return model;
  }

  dismiss(id: string): boolean {
    const removed = this.#queue.dismiss(id);
    if (!removed) return false;
    this.#emit();
    return true;
  }

  openHistory(callerId = 'experience-feedback-trigger'): void {
    this.#applyHistory({ type: 'open', callerId });
    if (this.#preferences.preferences.autoMarkRead) {
      this.#applyHistory({ type: 'mark-all-read' });
    }
    this.#emit();
  }

  closeHistory(): void {
    this.#applyHistory({ type: 'close' });
    this.#emit();
  }

  historyCommand(command: Exclude<FeedbackHistorySessionCommand, { readonly type: 'append' }>): void {
    this.#applyHistory(command);
    this.#emit();
  }

  setEnvironment(environment: FeedbackCenterEnvironment): void {
    const next = normalizeEnvironment(environment);
    const current = this.#environment;
    if (
      next.viewport === current.viewport
      && next.coarsePointer === current.coarsePointer
      && next.reducedMotion === current.reducedMotion
      && next.forcedColors === current.forcedColors
      && next.keyboardModality === current.keyboardModality
    ) return;
    this.#environment = next;
    this.#emit();
  }

  setPreferences(action: FeedbackHistoryPreferenceAction): void {
    this.#preferences = reduceFeedbackHistoryPreferences(
      this.#preferences,
      action,
      safeNow(this.#clock),
    );
    if (action.type === 'set-filter') this.#applyHistory({ type: 'filter', filter: action.filter });
    if (action.type === 'set-sort') this.#applyHistory({ type: 'sort', sort: action.sort });
    this.#emit();
  }

  restorePreferences(serialized: string | null | undefined): void {
    this.#preferences = parseFeedbackHistoryPreferenceEnvelope(
      serialized,
      preferenceContext(this.#environment, safeNow(this.#clock)),
    );
    this.#applyHistory({ type: 'filter', filter: this.#preferences.preferences.filter });
    this.#applyHistory({ type: 'sort', sort: this.#preferences.preferences.sort });
    this.#emit();
  }

  serializePreferences(): string | null {
    return serializeFeedbackHistoryPreferenceEnvelope(this.#preferences);
  }

  clear(): void {
    this.#queue.clear();
    this.#history = createFeedbackHistorySessionState(safeNow(this.#clock));
    this.#lastEffect = Object.freeze({ type: 'none' });
    this.#emit();
  }

  dispose(): void {
    this.#subscribers.clear();
    this.#queue.clear();
  }
}

export const createFeedbackCenterRuntime = (
  options: FeedbackCenterRuntimeOptions = {},
): FeedbackCenterRuntime => new FeedbackCenterRuntime(options);

let sharedRuntime: FeedbackCenterRuntime | null = null;

export const getExperienceFeedbackCenterRuntime = (): FeedbackCenterRuntime => {
  sharedRuntime ??= createFeedbackCenterRuntime();
  return sharedRuntime;
};

export const publishExperienceFeedback = (
  publication: FeedbackCenterPublication,
): FeedbackViewModel | null => getExperienceFeedbackCenterRuntime().publish(publication);
