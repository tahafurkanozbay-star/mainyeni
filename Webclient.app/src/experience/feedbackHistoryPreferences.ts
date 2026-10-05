import type { FeedbackHistoryFilter, FeedbackHistorySort } from './feedbackHistoryExperience';
import type { FeedbackHistoryControlsDensity } from './feedbackHistoryControls';

export type FeedbackHistoryPreferenceSource = 'default' | 'session' | 'user';
export type FeedbackHistoryAnnouncementMode = 'all' | 'important' | 'off';

export interface FeedbackHistoryPreferences {
  readonly filter: FeedbackHistoryFilter;
  readonly sort: FeedbackHistorySort;
  readonly density: FeedbackHistoryControlsDensity;
  readonly announcementMode: FeedbackHistoryAnnouncementMode;
  readonly autoMarkRead: boolean;
}

export interface FeedbackHistoryPreferenceEnvelope {
  readonly version: 1;
  readonly updatedAt: number;
  readonly source: FeedbackHistoryPreferenceSource;
  readonly preferences: FeedbackHistoryPreferences;
}

export interface FeedbackHistoryPreferenceContext {
  readonly now: number;
  readonly reducedMotion?: boolean;
  readonly coarsePointer?: boolean;
  readonly forcedColors?: boolean;
}

export interface FeedbackHistoryPreferenceSnapshot {
  readonly envelope: FeedbackHistoryPreferenceEnvelope;
  readonly storageKey: 'kent-rehberi:feedback-history-preferences:v1';
  readonly storage: 'session';
  readonly maxSerializedBytes: 512;
  readonly restorePolicy: 'bounded-session';
  readonly announceChanges: boolean;
  readonly targetSize: 44 | 48;
  readonly motion: 'reduced' | 'standard';
  readonly contrast: 'forced' | 'standard';
}

export type FeedbackHistoryPreferenceAction =
  | { readonly type: 'set-filter'; readonly filter: FeedbackHistoryFilter }
  | { readonly type: 'set-sort'; readonly sort: FeedbackHistorySort }
  | { readonly type: 'set-density'; readonly density: FeedbackHistoryControlsDensity }
  | { readonly type: 'set-announcement-mode'; readonly mode: FeedbackHistoryAnnouncementMode }
  | { readonly type: 'set-auto-mark-read'; readonly enabled: boolean }
  | { readonly type: 'reset' };

const STORAGE_KEY = 'kent-rehberi:feedback-history-preferences:v1' as const;
const MAX_SERIALIZED_BYTES = 512 as const;
const FILTERS = new Set<FeedbackHistoryFilter>(['all', 'unread', 'important']);
const SORTS = new Set<FeedbackHistorySort>(['newest', 'oldest']);
const DENSITIES = new Set<FeedbackHistoryControlsDensity>(['comfortable', 'compact']);
const ANNOUNCEMENT_MODES = new Set<FeedbackHistoryAnnouncementMode>(['all', 'important', 'off']);
const SOURCES = new Set<FeedbackHistoryPreferenceSource>(['default', 'session', 'user']);

const DEFAULTS: FeedbackHistoryPreferences = Object.freeze({
  filter: 'all',
  sort: 'newest',
  density: 'comfortable',
  announcementMode: 'important',
  autoMarkRead: false,
});

const finiteTimestamp = (value: unknown, now: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return now;
  return Math.min(Math.floor(value), now);
};

const objectLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const preferencesFromUnknown = (value: unknown): FeedbackHistoryPreferences | null => {
  if (!objectLike(value)) return null;
  const filter = value.filter;
  const sort = value.sort;
  const density = value.density;
  const announcementMode = value.announcementMode;
  const autoMarkRead = value.autoMarkRead;
  if (typeof filter !== 'string' || !FILTERS.has(filter as FeedbackHistoryFilter)) return null;
  if (typeof sort !== 'string' || !SORTS.has(sort as FeedbackHistorySort)) return null;
  if (typeof density !== 'string' || !DENSITIES.has(density as FeedbackHistoryControlsDensity)) return null;
  if (typeof announcementMode !== 'string' || !ANNOUNCEMENT_MODES.has(announcementMode as FeedbackHistoryAnnouncementMode)) return null;
  if (typeof autoMarkRead !== 'boolean') return null;
  return Object.freeze({
    filter: filter as FeedbackHistoryFilter,
    sort: sort as FeedbackHistorySort,
    density: density as FeedbackHistoryControlsDensity,
    announcementMode: announcementMode as FeedbackHistoryAnnouncementMode,
    autoMarkRead,
  });
};

export const createDefaultFeedbackHistoryPreferenceEnvelope = (now: number): FeedbackHistoryPreferenceEnvelope =>
  Object.freeze({
    version: 1,
    updatedAt: Math.max(0, Math.floor(Number.isFinite(now) ? now : 0)),
    source: 'default',
    preferences: DEFAULTS,
  });

export const parseFeedbackHistoryPreferenceEnvelope = (
  serialized: string | null | undefined,
  context: FeedbackHistoryPreferenceContext,
): FeedbackHistoryPreferenceEnvelope => {
  const fallback = createDefaultFeedbackHistoryPreferenceEnvelope(context.now);
  if (!serialized || byteLength(serialized) > MAX_SERIALIZED_BYTES) return fallback;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!objectLike(parsed) || parsed.version !== 1) return fallback;
    const source = parsed.source;
    if (typeof source !== 'string' || !SOURCES.has(source as FeedbackHistoryPreferenceSource)) return fallback;
    const preferences = preferencesFromUnknown(parsed.preferences);
    if (!preferences) return fallback;
    return Object.freeze({
      version: 1,
      updatedAt: finiteTimestamp(parsed.updatedAt, context.now),
      source: source as FeedbackHistoryPreferenceSource,
      preferences,
    });
  } catch {
    return fallback;
  }
};

export const serializeFeedbackHistoryPreferenceEnvelope = (envelope: FeedbackHistoryPreferenceEnvelope): string | null => {
  const serialized = JSON.stringify(envelope);
  return byteLength(serialized) <= MAX_SERIALIZED_BYTES ? serialized : null;
};

export const reduceFeedbackHistoryPreferences = (
  envelope: FeedbackHistoryPreferenceEnvelope,
  action: FeedbackHistoryPreferenceAction,
  now: number,
): FeedbackHistoryPreferenceEnvelope => {
  if (action.type === 'reset') return createDefaultFeedbackHistoryPreferenceEnvelope(now);
  const current = envelope.preferences;
  const preferences: FeedbackHistoryPreferences = action.type === 'set-filter'
    ? { ...current, filter: action.filter }
    : action.type === 'set-sort'
      ? { ...current, sort: action.sort }
      : action.type === 'set-density'
        ? { ...current, density: action.density }
        : action.type === 'set-announcement-mode'
          ? { ...current, announcementMode: action.mode }
          : { ...current, autoMarkRead: action.enabled };
  return Object.freeze({
    version: 1,
    updatedAt: Math.max(0, Math.floor(Number.isFinite(now) ? now : envelope.updatedAt)),
    source: 'user',
    preferences: Object.freeze(preferences),
  });
};

export const createFeedbackHistoryPreferenceSnapshot = (
  envelope: FeedbackHistoryPreferenceEnvelope,
  context: FeedbackHistoryPreferenceContext,
): FeedbackHistoryPreferenceSnapshot => Object.freeze({
  envelope,
  storageKey: STORAGE_KEY,
  storage: 'session',
  maxSerializedBytes: MAX_SERIALIZED_BYTES,
  restorePolicy: 'bounded-session',
  announceChanges: envelope.preferences.announcementMode !== 'off',
  targetSize: context.coarsePointer ? 48 : 44,
  motion: context.reducedMotion ? 'reduced' : 'standard',
  contrast: context.forcedColors ? 'forced' : 'standard',
});

export const shouldAnnounceFeedbackHistoryItem = (
  mode: FeedbackHistoryAnnouncementMode,
  importance: 'normal' | 'important',
): boolean => mode === 'all' || (mode === 'important' && importance === 'important');
