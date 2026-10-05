import { describe, expect, it } from 'vitest';
import {
  createDefaultFeedbackHistoryPreferenceEnvelope,
  createFeedbackHistoryPreferenceSnapshot,
  parseFeedbackHistoryPreferenceEnvelope,
  reduceFeedbackHistoryPreferences,
  serializeFeedbackHistoryPreferenceEnvelope,
  shouldAnnounceFeedbackHistoryItem,
} from './feedbackHistoryPreferences';

const NOW = 1_800_000_000_000;

describe('feedbackHistoryPreferences', () => {
  it('creates privacy-bounded session defaults', () => {
    const envelope = createDefaultFeedbackHistoryPreferenceEnvelope(NOW);
    expect(envelope).toEqual({
      version: 1,
      updatedAt: NOW,
      source: 'default',
      preferences: {
        filter: 'all',
        sort: 'newest',
        density: 'comfortable',
        announcementMode: 'important',
        autoMarkRead: false,
      },
    });
    expect(createFeedbackHistoryPreferenceSnapshot(envelope, { now: NOW })).toMatchObject({
      storageKey: 'kent-rehberi:feedback-history-preferences:v1',
      storage: 'session',
      maxSerializedBytes: 512,
      restorePolicy: 'bounded-session',
      targetSize: 44,
      motion: 'standard',
      contrast: 'standard',
    });
  });

  it('derives accessibility presentation without persisting device signals', () => {
    const envelope = createDefaultFeedbackHistoryPreferenceEnvelope(NOW);
    const snapshot = createFeedbackHistoryPreferenceSnapshot(envelope, {
      now: NOW,
      coarsePointer: true,
      reducedMotion: true,
      forcedColors: true,
    });
    expect(snapshot).toMatchObject({ targetSize: 48, motion: 'reduced', contrast: 'forced', announceChanges: true });
    expect(snapshot.envelope.preferences).not.toHaveProperty('coarsePointer');
    expect(snapshot.envelope.preferences).not.toHaveProperty('reducedMotion');
    expect(snapshot.envelope.preferences).not.toHaveProperty('forcedColors');
  });

  it('round-trips a valid bounded envelope', () => {
    let envelope = createDefaultFeedbackHistoryPreferenceEnvelope(NOW);
    envelope = reduceFeedbackHistoryPreferences(envelope, { type: 'set-filter', filter: 'unread' }, NOW + 1);
    envelope = reduceFeedbackHistoryPreferences(envelope, { type: 'set-sort', sort: 'oldest' }, NOW + 2);
    envelope = reduceFeedbackHistoryPreferences(envelope, { type: 'set-density', density: 'compact' }, NOW + 3);
    envelope = reduceFeedbackHistoryPreferences(envelope, { type: 'set-announcement-mode', mode: 'all' }, NOW + 4);
    envelope = reduceFeedbackHistoryPreferences(envelope, { type: 'set-auto-mark-read', enabled: true }, NOW + 5);
    const serialized = serializeFeedbackHistoryPreferenceEnvelope(envelope);
    expect(serialized).not.toBeNull();
    expect(parseFeedbackHistoryPreferenceEnvelope(serialized, { now: NOW + 10 })).toEqual(envelope);
  });

  it('fails closed for malformed, oversized, unknown-version and partial payloads', () => {
    const fallback = createDefaultFeedbackHistoryPreferenceEnvelope(NOW);
    expect(parseFeedbackHistoryPreferenceEnvelope('{', { now: NOW })).toEqual(fallback);
    expect(parseFeedbackHistoryPreferenceEnvelope('x'.repeat(513), { now: NOW })).toEqual(fallback);
    expect(parseFeedbackHistoryPreferenceEnvelope(JSON.stringify({ version: 2 }), { now: NOW })).toEqual(fallback);
    expect(parseFeedbackHistoryPreferenceEnvelope(JSON.stringify({ version: 1, source: 'session', preferences: {} }), { now: NOW })).toEqual(fallback);
  });

  it('rejects invalid enum and primitive shapes instead of coercing them', () => {
    const valid = {
      version: 1,
      updatedAt: NOW,
      source: 'session',
      preferences: { filter: 'all', sort: 'newest', density: 'comfortable', announcementMode: 'important', autoMarkRead: false },
    };
    for (const mutation of [
      { ...valid, source: 'remote' },
      { ...valid, preferences: { ...valid.preferences, filter: 'secret' } },
      { ...valid, preferences: { ...valid.preferences, sort: 'random' } },
      { ...valid, preferences: { ...valid.preferences, density: 'tiny' } },
      { ...valid, preferences: { ...valid.preferences, announcementMode: 'verbose' } },
      { ...valid, preferences: { ...valid.preferences, autoMarkRead: 'yes' } },
    ]) {
      expect(parseFeedbackHistoryPreferenceEnvelope(JSON.stringify(mutation), { now: NOW }).source).toBe('default');
    }
  });

  it('clamps future timestamps and repairs invalid timestamps', () => {
    const preferences = { filter: 'all', sort: 'newest', density: 'comfortable', announcementMode: 'important', autoMarkRead: false };
    expect(parseFeedbackHistoryPreferenceEnvelope(JSON.stringify({ version: 1, updatedAt: NOW + 99_999, source: 'session', preferences }), { now: NOW }).updatedAt).toBe(NOW);
    expect(parseFeedbackHistoryPreferenceEnvelope(JSON.stringify({ version: 1, updatedAt: -1, source: 'session', preferences }), { now: NOW }).updatedAt).toBe(NOW);
  });

  it('uses deterministic announcement governance', () => {
    expect(shouldAnnounceFeedbackHistoryItem('all', 'normal')).toBe(true);
    expect(shouldAnnounceFeedbackHistoryItem('important', 'normal')).toBe(false);
    expect(shouldAnnounceFeedbackHistoryItem('important', 'important')).toBe(true);
    expect(shouldAnnounceFeedbackHistoryItem('off', 'important')).toBe(false);
  });

  it('resets to bounded defaults and marks explicit changes as user sourced', () => {
    const initial = createDefaultFeedbackHistoryPreferenceEnvelope(NOW);
    const changed = reduceFeedbackHistoryPreferences(initial, { type: 'set-filter', filter: 'important' }, NOW + 1);
    expect(changed.source).toBe('user');
    expect(changed.preferences.filter).toBe('important');
    expect(reduceFeedbackHistoryPreferences(changed, { type: 'reset' }, NOW + 2)).toEqual(createDefaultFeedbackHistoryPreferenceEnvelope(NOW + 2));
  });
});
