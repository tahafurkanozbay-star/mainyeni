import type { FeedbackViewModel } from './feedbackExperience';

export type FeedbackViewport = 'phone' | 'tablet' | 'desktop';
export type FeedbackFocusTarget = 'none' | 'region' | 'latest-action' | 'return-target';

export interface FeedbackAccessibilityInput {
  items: readonly FeedbackViewModel[];
  viewport: FeedbackViewport;
  coarsePointer?: boolean;
  reducedMotion?: boolean;
  forcedColors?: boolean;
  keyboardModality?: boolean;
  activeFeedbackId?: string | null;
  returnFocusId?: string | null;
}

export interface FeedbackAccessibilityItem {
  id: string;
  semanticId: string;
  titleId: string;
  messageId: string | null;
  actionId: string | null;
  dismissId: string | null;
  role: 'status' | 'alert';
  ariaLive: 'polite' | 'assertive';
  ariaAtomic: true;
  ariaLabelledBy: string;
  ariaDescribedBy: string | null;
  actionTabIndex: 0 | -1;
  dismissTabIndex: 0 | -1;
}

export interface FeedbackAccessibilitySnapshot {
  regionId: string;
  regionRole: 'region';
  regionLabel: string;
  placement: 'bottom-sheet' | 'floating-stack';
  targetSize: 44 | 48;
  motion: 'reduced' | 'standard';
  contrast: 'forced' | 'standard';
  items: readonly FeedbackAccessibilityItem[];
  activeFeedbackId: string | null;
  focusTarget: FeedbackFocusTarget;
  focusId: string | null;
  announcement: string | null;
}

const MAX_ITEMS = 5;
const MAX_ANNOUNCEMENT = 240;
const safeId = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96);
const stripControls = (value: string): string => Array.from(value, (character) => {
  const code = character.charCodeAt(0);
  return code <= 31 || code === 127 ? ' ' : character;
}).join('');
const bounded = (value: string): string => stripControls(value).replace(/\s+/g, ' ').trim().slice(0, MAX_ANNOUNCEMENT);

const resolveActive = (items: readonly FeedbackViewModel[], requested?: string | null): string | null => {
  if (requested && items.some((item) => item.id === requested)) return requested;
  const actionable = [...items].reverse().find((item) => item.actionLabel || item.dismissible);
  return actionable?.id ?? items.at(-1)?.id ?? null;
};

export const createFeedbackAccessibilitySnapshot = (input: FeedbackAccessibilityInput): FeedbackAccessibilitySnapshot => {
  const items = input.items.slice(-MAX_ITEMS);
  const activeFeedbackId = resolveActive(items, input.activeFeedbackId);
  const models: FeedbackAccessibilityItem[] = items.map((item) => {
    const base = safeId(item.semanticId);
    const titleId = `${base}-title`;
    const messageId = item.message ? `${base}-message` : null;
    const actionId = item.actionLabel ? `${base}-action` : null;
    const dismissId = item.dismissible ? `${base}-dismiss` : null;
    const active = item.id === activeFeedbackId;
    return {
      id: item.id, semanticId: base, titleId, messageId, actionId, dismissId,
      role: item.role, ariaLive: item.ariaLive, ariaAtomic: true,
      ariaLabelledBy: titleId, ariaDescribedBy: messageId,
      actionTabIndex: active && actionId !== null ? 0 : -1,
      dismissTabIndex: active && actionId === null && dismissId !== null ? 0 : -1,
    };
  });
  const latest = items.at(-1);
  const announcement = latest ? bounded(`${latest.title}${latest.message ? `. ${latest.message}` : ''}`) || null : null;
  return {
    regionId: 'kr-feedback-region', regionRole: 'region', regionLabel: 'Bildirimler',
    placement: input.viewport === 'phone' ? 'bottom-sheet' : 'floating-stack',
    targetSize: input.coarsePointer ? 48 : 44,
    motion: input.reducedMotion ? 'reduced' : 'standard',
    contrast: input.forcedColors ? 'forced' : 'standard',
    items: models, activeFeedbackId, focusTarget: 'none', focusId: null, announcement,
  };
};

export type FeedbackAccessibilityIntent =
  | { type: 'move'; direction: 'next' | 'previous' | 'first' | 'last' }
  | { type: 'invoke-action'; feedbackId: string }
  | { type: 'dismiss'; feedbackId: string }
  | { type: 'restore-focus' }
  | null;

export interface FeedbackAccessibilityKeyEvent {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}

const editable = (target: FeedbackAccessibilityKeyEvent['target']): boolean => {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
};

export const resolveFeedbackAccessibilityIntent = (
  event: FeedbackAccessibilityKeyEvent,
  snapshot: FeedbackAccessibilitySnapshot,
): FeedbackAccessibilityIntent => {
  if (event.defaultPrevented || event.isComposing || event.repeat || editable(event.target) || event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.key === 'Escape') return snapshot.activeFeedbackId ? { type: 'dismiss', feedbackId: snapshot.activeFeedbackId } : { type: 'restore-focus' };
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') return { type: 'move', direction: 'next' };
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') return { type: 'move', direction: 'previous' };
  if (event.key === 'Home') return { type: 'move', direction: 'first' };
  if (event.key === 'End') return { type: 'move', direction: 'last' };
  if ((event.key === 'Enter' || event.key === ' ') && snapshot.activeFeedbackId) return { type: 'invoke-action', feedbackId: snapshot.activeFeedbackId };
  return null;
};

export const moveFeedbackAccessibilityFocus = (
  snapshot: FeedbackAccessibilitySnapshot,
  direction: 'next' | 'previous' | 'first' | 'last',
): FeedbackAccessibilitySnapshot => {
  const actionable = snapshot.items.filter((item) => item.actionId || item.dismissId);
  if (!actionable.length) return { ...snapshot, activeFeedbackId: null, focusTarget: 'region', focusId: snapshot.regionId };
  const current = actionable.findIndex((item) => item.id === snapshot.activeFeedbackId);
  let index = current < 0 ? 0 : current;
  if (direction === 'first') index = 0;
  else if (direction === 'last') index = actionable.length - 1;
  else if (direction === 'next') index = (index + 1) % actionable.length;
  else index = (index - 1 + actionable.length) % actionable.length;
  const active = actionable[index];
  if (!active) return { ...snapshot, activeFeedbackId: null, focusTarget: 'region', focusId: snapshot.regionId };
  const focusId = active.actionId ?? active.dismissId;
  return {
    ...snapshot, activeFeedbackId: active.id,
    focusTarget: active.actionId ? 'latest-action' : 'region', focusId,
    items: snapshot.items.map((item) => ({
      ...item,
      actionTabIndex: item.id === active.id && item.actionId !== null ? 0 : -1,
      dismissTabIndex: item.id === active.id && item.actionId === null && item.dismissId !== null ? 0 : -1,
    })),
  };
};

export const reconcileFeedbackAccessibility = (
  previous: FeedbackAccessibilitySnapshot,
  input: FeedbackAccessibilityInput,
): FeedbackAccessibilitySnapshot => {
  const next = createFeedbackAccessibilitySnapshot({ ...input, activeFeedbackId: previous.activeFeedbackId });
  if (!next.items.length && previous.items.length) {
    return { ...next, focusTarget: 'return-target', focusId: input.returnFocusId ? safeId(input.returnFocusId) : null, announcement: 'Bildirimler kapatıldı.' };
  }
  if (previous.activeFeedbackId && !next.items.some((item) => item.id === previous.activeFeedbackId)) {
    const active = next.items.find((item) => item.id === next.activeFeedbackId);
    return { ...next, focusTarget: active?.actionId ? 'latest-action' : 'region', focusId: active?.actionId ?? active?.dismissId ?? next.regionId };
  }
  return next;
};
