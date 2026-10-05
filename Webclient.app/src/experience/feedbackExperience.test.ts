import { describe, expect, it } from 'vitest';
import {
  createFeedbackViewModel,
  FeedbackQueue,
  resolveFeedbackKeyboardIntent,
} from './feedbackExperience';

describe('createFeedbackViewModel', () => {
  it('creates bounded polite status feedback by default', () => {
    const model = createFeedbackViewModel({ id: 'save-ok', title: 'Kaydedildi', message: ' Değişiklikler   kaydedildi. ' }, 100);
    expect(model).toMatchObject({
      id: 'save-ok',
      title: 'Kaydedildi',
      message: 'Değişiklikler kaydedildi.',
      role: 'status',
      ariaLive: 'polite',
      placement: 'toast',
      dismissible: true,
      semanticId: 'kr-feedback-save-ok',
      expired: false,
    });
  });

  it('uses assertive alert semantics for danger feedback', () => {
    expect(createFeedbackViewModel({ id: 'error', title: 'İşlem başarısız', tone: 'danger' }))
      .toMatchObject({ role: 'alert', ariaLive: 'assertive', tone: 'danger' });
  });

  it('honours explicit polite priority for non-interrupting errors', () => {
    expect(createFeedbackViewModel({ id: 'error', title: 'Tekrar deneyin', tone: 'danger', priority: 'polite' }))
      .toMatchObject({ role: 'status', ariaLive: 'polite' });
  });

  it('fails closed for missing identity or title', () => {
    expect(createFeedbackViewModel({ id: '', title: 'A' })).toBeNull();
    expect(createFeedbackViewModel({ id: 'a', title: '   ' })).toBeNull();
  });

  it('sanitizes hostile control characters and bounds text', () => {
    const model = createFeedbackViewModel({
      id: `id\u0000${'x'.repeat(200)}`,
      title: `Başlık\n${'x'.repeat(200)}`,
      message: `Mesaj\t${'y'.repeat(500)}`,
      actionLabel: ' Yeniden\n dene ',
    });
    expect(model?.id.length).toBeLessThanOrEqual(80);
    expect(model?.title.length).toBeLessThanOrEqual(120);
    expect(model?.message?.length).toBeLessThanOrEqual(320);
    expect(model?.actionLabel).toBe('Yeniden dene');
    expect(model?.title).not.toContain('\n');
  });

  it('marks finite expired feedback without trusting invalid timestamps', () => {
    expect(createFeedbackViewModel({ id: 'a', title: 'A', expiresAt: 99 }, 100)?.expired).toBe(true);
    expect(createFeedbackViewModel({ id: 'b', title: 'B', expiresAt: Number.NaN }, 100)?.expired).toBe(false);
  });
});

describe('FeedbackQueue', () => {
  it('keeps a bounded visible tail and bounded queue', () => {
    const queue = new FeedbackQueue({ maxVisible: 2, maxQueued: 3 });
    queue.push({ id: '1', title: 'Bir' });
    queue.push({ id: '2', title: 'İki' });
    queue.push({ id: '3', title: 'Üç' });
    queue.push({ id: '4', title: 'Dört' });
    expect(queue.size).toBe(3);
    expect(queue.snapshot().map((item) => item.id)).toEqual(['3', '4']);
  });

  it('deduplicates by id and moves updated feedback to the tail', () => {
    const queue = new FeedbackQueue({ maxVisible: 3 });
    queue.push({ id: 'a', title: 'Eski' });
    queue.push({ id: 'b', title: 'B' });
    queue.push({ id: 'a', title: 'Yeni' });
    expect(queue.snapshot().map((item) => [item.id, item.title])).toEqual([['b', 'B'], ['a', 'Yeni']]);
  });

  it('drops already expired feedback and prunes feedback that expires later', () => {
    const queue = new FeedbackQueue();
    queue.push({ id: 'old', title: 'Old', expiresAt: 1 });
    expect(queue.size).toBe(0);
    queue.push({ id: 'soon', title: 'Soon', expiresAt: Date.now() + 10_000 });
    expect(queue.snapshot(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(queue.size).toBe(0);
  });

  it('supports deterministic dismiss and clear', () => {
    const queue = new FeedbackQueue();
    queue.push({ id: 'a', title: 'A' });
    expect(queue.dismiss('a')).toBe(true);
    expect(queue.dismiss('a')).toBe(false);
    queue.push({ id: 'b', title: 'B' });
    queue.clear();
    expect(queue.size).toBe(0);
  });
});

describe('resolveFeedbackKeyboardIntent', () => {
  it('maps Escape and Shift+F6 to bounded feedback intents', () => {
    expect(resolveFeedbackKeyboardIntent({ key: 'Escape' })).toEqual({ type: 'dismiss-latest' });
    expect(resolveFeedbackKeyboardIntent({ key: 'F6', shiftKey: true })).toEqual({ type: 'focus-latest-action' });
  });

  it.each([
    { key: 'Escape', repeat: true },
    { key: 'Escape', isComposing: true },
    { key: 'Escape', defaultPrevented: true },
    { key: 'Escape', ctrlKey: true },
    { key: 'Escape', metaKey: true },
    { key: 'Escape', altKey: true },
    { key: 'Escape', target: { tagName: 'INPUT' } },
    { key: 'Escape', target: { tagName: 'TEXTAREA' } },
    { key: 'Escape', target: { isContentEditable: true } },
  ])('fails closed in unsafe keyboard context %#', (event) => {
    expect(resolveFeedbackKeyboardIntent(event)).toBeNull();
  });
});
