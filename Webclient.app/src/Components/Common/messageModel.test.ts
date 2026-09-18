import { describe, expect, it } from 'vitest';
import { createMessageViewModel, formatMessageClock, normalizeMessageSeverity } from './messageModel';

describe('messageModel', () => {
  it.each([
    ['error', 'error'], ['danger', 'error'], ['warning', 'warning'], ['warn', 'warning'],
    ['success', 'success'], ['ok', 'success'], ['info', 'info'], ['unknown', 'info'], [null, 'info'],
  ] as const)('normalizes %s severity', (input, expected) => {
    expect(normalizeMessageSeverity(input)).toBe(expected);
  });

  it('does not mutate the caller message record', () => {
    const input = Object.freeze({ id: 'm-1', messageText: 'Merhaba', messageType: 'danger', createdAt: 1_000 });
    const model = createMessageViewModel(input);
    expect(model).toMatchObject({ id: 'm-1', message: 'Merhaba', severity: 'error', variant: 'danger', heading: 'Hata', createdAt: 1_000 });
    expect(Object.isFrozen(model)).toBe(true);
  });

  it('uses an injected deterministic clock', () => {
    const model = createMessageViewModel({ message: 'test' }, { now: () => new Date(2_000) });
    expect(model.createdAt).toBe(2_000);
  });

  it('does not stringify arbitrary objects into the UI', () => {
    expect(createMessageViewModel({ message: { unsafe: true } }, { now: () => new Date(0) }).message).toBe('Mesaj içeriği bulunamadı.');
  });

  it('formats timestamp parts with zero padding', () => {
    expect(formatMessageClock({ hours: 1, minutes: 2, seconds: 3 })).toBe('01:02:03');
  });

  it('rejects invalid timestamps', () => {
    expect(() => createMessageViewModel({ message: 'x', createdAt: 'not-a-date' })).toThrow(/valid/i);
  });
});
