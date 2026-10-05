import type {
  NotificationCenterSnapshot,
  NotificationItem,
} from './notificationCenterModel';
import {
  createFeedbackViewModel,
  type FeedbackInput,
  type FeedbackPriority,
  type FeedbackTone,
  type FeedbackViewModel,
} from './feedbackExperience';
import {
  reduceFeedbackHistorySession,
  type FeedbackHistorySessionState,
} from './feedbackHistorySession';
import type { FeedbackHistoryInput } from './feedbackHistoryExperience';

const MAX_REPEAT_LABEL = 99;

const toneForNotification = (item: NotificationItem): FeedbackTone => {
  switch (item.tone) {
    case 'success': return 'success';
    case 'warning': return 'warning';
    case 'error': return 'danger';
    default: return 'neutral';
  }
};

const priorityForNotification = (item: NotificationItem): FeedbackPriority =>
  item.priority === 'urgent' || item.tone === 'error' ? 'assertive' : 'polite';

const repeatLabel = (count: number): string => {
  const safeCount = Math.max(1, Math.min(MAX_REPEAT_LABEL, Math.trunc(Number.isFinite(count) ? count : 1)));
  return safeCount > 1 ? `${safeCount} kez tekrarlandı.` : '';
};

const joinedMessage = (item: NotificationItem): string | null => {
  const pieces = [item.message.trim(), repeatLabel(item.occurrenceCount)].filter(Boolean);
  return pieces.length > 0 ? pieces.join(' ') : null;
};

export const notificationToFeedbackInput = (item: NotificationItem): FeedbackInput => Object.freeze({
  id: item.id,
  title: item.title,
  message: joinedMessage(item),
  tone: toneForNotification(item),
  priority: priorityForNotification(item),
  placement: item.priority === 'urgent' || item.tone === 'error' ? 'banner' : 'toast',
  dismissible: item.dismissible,
  actionLabel: item.actions[0]?.label ?? null,
  createdAt: item.createdAt,
  expiresAt: item.expiresAt,
});

export const notificationToFeedbackViewModel = (
  item: NotificationItem,
  now = Date.now(),
): FeedbackViewModel | null => createFeedbackViewModel(notificationToFeedbackInput(item), now);

export const notificationToFeedbackHistoryInput = (
  item: NotificationItem,
  now = Date.now(),
): FeedbackHistoryInput | null => {
  const feedback = notificationToFeedbackViewModel(item, now);
  if (!feedback) return null;
  return Object.freeze({
    feedback,
    occurredAt: item.createdAt,
    read: item.read,
  });
};

export interface FeedbackNotificationHistorySyncResult {
  readonly state: FeedbackHistorySessionState;
  readonly acceptedIds: readonly string[];
  readonly rejectedIds: readonly string[];
}

/**
 * Reconciles the NotificationCenter snapshot into bounded presentation history.
 * The source model remains authoritative for live read/dismiss state. History is
 * intentionally append-preserving so a dismissed toast can remain discoverable
 * until the bounded seven-day/50-item history policy expires it.
 */
export const synchronizeNotificationHistory = (
  state: FeedbackHistorySessionState,
  snapshot: NotificationCenterSnapshot,
  now = Date.now(),
): FeedbackNotificationHistorySyncResult => {
  let nextState = state;
  const acceptedIds: string[] = [];
  const rejectedIds: string[] = [];

  // NotificationCenter is newest-first. Replaying oldest-first makes the
  // reducer's bounded insertion policy deterministic when capacity is reached.
  for (let index = snapshot.items.length - 1; index >= 0; index -= 1) {
    const item = snapshot.items[index];
    if (!item) continue;
    const historyInput = notificationToFeedbackHistoryInput(item, now);
    if (!historyInput) {
      rejectedIds.push(item.id);
      continue;
    }
    nextState = reduceFeedbackHistorySession(nextState, {
      type: 'append',
      item: historyInput,
    }, now).state;
    acceptedIds.push(item.id);
  }

  return Object.freeze({
    state: nextState,
    acceptedIds: Object.freeze(acceptedIds),
    rejectedIds: Object.freeze(rejectedIds),
  });
};
