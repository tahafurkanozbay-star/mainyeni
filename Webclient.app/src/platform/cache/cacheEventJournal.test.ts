import { describe, expect, it } from 'vitest';
import { CacheEventJournal } from './cacheEventJournal';

describe('CacheEventJournal', () => {
  it('keeps only the newest bounded events', () => {
    let now = 0;
    const journal = new CacheEventJournal(2, { now: () => ++now });
    journal.record('first');
    journal.record('second');
    journal.record('third');

    expect(journal.entries()).toEqual([
      { sequence: 2, at: 2, kind: 'second' },
      { sequence: 3, at: 3, kind: 'third' },
    ]);
  });

  it('returns immutable event snapshots', () => {
    const journal = new CacheEventJournal(2, { now: () => 1 });
    journal.record('hit');
    const entries = journal.entries();

    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries[0])).toBe(true);
  });

  it('accepts a zero-sized journal without reading the clock', () => {
    const journal = new CacheEventJournal(0, {
      now: () => {
        throw new Error('clock should not be called');
      },
    });
    journal.record('ignored');
    expect(journal.entries()).toEqual([]);
  });

  it('rejects a regressing clock', () => {
    let now = 2;
    const journal = new CacheEventJournal(2, { now: () => now });
    journal.record('first');
    now = 1;
    expect(() => journal.record('second')).toThrow('monotonic');
  });

  it('rejects invalid clock values and event names', () => {
    const invalidClock = new CacheEventJournal(2, { now: () => Number.NaN });
    expect(() => invalidClock.record('event')).toThrow('invalid timestamp');

    const journal = new CacheEventJournal(2, { now: () => 1 });
    expect(() => journal.record('')).toThrow(RangeError);
    expect(() => journal.record('x'.repeat(65))).toThrow(RangeError);
  });

  it('validates journal capacity', () => {
    expect(() => new CacheEventJournal(-1)).toThrow(RangeError);
    expect(() => new CacheEventJournal(4097)).toThrow(RangeError);
  });
});
