import { describe, expect, it } from 'vitest';
import { createRuntimeHealthJournal } from './runtimeHealthJournal';

describe('runtimeHealthJournal', () => {
  it('retains a bounded newest-first window without unbounded memory growth', () => {
    let clock = 10;
    const journal = createRuntimeHealthJournal({ capacity: 3 }, () => clock);
    for (let index = 0; index < 5; index += 1) {
      clock += 1;
      journal.record({ at: clock, kind: 'lifecycle', severity: 'info', code: `event-${index}` });
    }
    const snapshot = journal.snapshot();
    expect(snapshot.events.map((event) => event.code)).toEqual(['event-2', 'event-3', 'event-4']);
    expect(snapshot.summary).toMatchObject({ total: 5, retained: 3, dropped: 2 });
    journal.dispose();
  });

  it('prunes events outside the configured retention horizon', () => {
    let clock = 1_000;
    const journal = createRuntimeHealthJournal({ retentionMs: 100 }, () => clock);
    journal.record({ at: 900, kind: 'resource', severity: 'warning', code: 'old' });
    journal.record({ at: 950, kind: 'resource', severity: 'info', code: 'recent' });
    clock = 1_020;
    expect(journal.query().map((event) => event.code)).toEqual(['recent']);
    expect(journal.summary().pruned).toBe(1);
    journal.dispose();
  });

  it('computes bounded latency percentiles from duration-bearing events', () => {
    let clock = 0;
    const journal = createRuntimeHealthJournal({ latencyWindowSize: 4 }, () => clock);
    [10, 20, 30, 40, 50].forEach((durationMs, index) => {
      clock = index;
      journal.record({ at: clock, kind: 'latency', severity: 'info', code: 'request', durationMs });
    });
    const summary = journal.summary();
    expect(summary.p50LatencyMs).toBe(40);
    expect(summary.p95LatencyMs).toBe(50);
    expect(summary.p99LatencyMs).toBe(50);
    journal.dispose();
  });

  it('computes a bounded rolling failure rate', () => {
    const journal = createRuntimeHealthJournal({ failureWindowSize: 4 });
    journal.record({ at: 1, kind: 'failure', severity: 'error', code: 'f1' });
    journal.record({ at: 2, kind: 'latency', severity: 'info', code: 'ok1' });
    journal.record({ at: 3, kind: 'latency', severity: 'info', code: 'ok2' });
    journal.record({ at: 4, kind: 'failure', severity: 'critical', code: 'f2' });
    journal.record({ at: 5, kind: 'latency', severity: 'info', code: 'ok3' });
    expect(journal.summary()).toMatchObject({ failures: 1, failureRate: 0.25 });
    journal.dispose();
  });

  it('treats error severity as failure evidence even for non-failure kinds', () => {
    const journal = createRuntimeHealthJournal();
    journal.record({ at: 1, kind: 'resource', severity: 'error', code: 'oom-risk' });
    journal.record({ at: 2, kind: 'recovery', severity: 'info', code: 'recovered' });
    expect(journal.summary().failureRate).toBe(0.5);
    journal.dispose();
  });

  it('tracks retained counts by severity and kind', () => {
    let clock = 3;
    const journal = createRuntimeHealthJournal({}, () => clock);
    journal.record({ at: 1, kind: 'admission', severity: 'warning', code: 'queued' });
    journal.record({ at: 2, kind: 'admission', severity: 'error', code: 'shed' });
    journal.record({ at: 3, kind: 'pressure', severity: 'warning', code: 'high' });
    const summary = journal.summary();
    expect(summary.byKind.admission).toBe(2);
    expect(summary.byKind.pressure).toBe(1);
    expect(summary.bySeverity.warning).toBe(2);
    expect(summary.bySeverity.error).toBe(1);
    journal.dispose();
  });

  it('filters by time, kind, severity, code and lane', () => {
    let clock = 40;
    const journal = createRuntimeHealthJournal({}, () => clock);
    journal.record({ at: 10, kind: 'admission', severity: 'info', code: 'start', lane: 'foreground' });
    journal.record({ at: 20, kind: 'admission', severity: 'warning', code: 'queued', lane: 'background' });
    journal.record({ at: 30, kind: 'pressure', severity: 'warning', code: 'high', lane: 'background' });
    journal.record({ at: 40, kind: 'admission', severity: 'warning', code: 'queued', lane: 'background' });
    const events = journal.query({
      since: 15, until: 40, kinds: ['admission'], severities: ['warning'], codes: ['queued'], lane: 'background',
    });
    expect(events.map((event) => event.at)).toEqual([20, 40]);
    journal.dispose();
  });

  it('limits query results to the newest matching records', () => {
    let clock = 6;
    const journal = createRuntimeHealthJournal({}, () => clock);
    for (let index = 1; index <= 6; index += 1) {
      journal.record({ at: index, kind: 'pressure', severity: 'info', code: 'sample' });
    }
    expect(journal.query({ limit: 2 }).map((event) => event.at)).toEqual([5, 6]);
    journal.dispose();
  });

  it('normalizes malformed numeric fields without leaking NaN into summaries', () => {
    const journal = createRuntimeHealthJournal();
    const event = journal.record({
      at: Number.NaN, kind: 'latency', severity: 'info', code: 'nan', durationMs: Number.NaN, value: Number.POSITIVE_INFINITY,
    });
    expect(Number.isFinite(event.at)).toBe(true);
    expect(event.durationMs).toBeUndefined();
    expect(event.value).toBeUndefined();
    expect(journal.summary().p95LatencyMs).toBeNull();
    journal.dispose();
  });

  it('bounds messages and tag cardinality', () => {
    const journal = createRuntimeHealthJournal({ maxMessageLength: 5, maxTagsPerEvent: 2, maxTagLength: 4 });
    const event = journal.record({
      at: 1,
      kind: 'lifecycle',
      severity: 'info',
      code: 'very-long-code',
      message: 'abcdefgh',
      tags: { first: '123456', second: 'abcdef', third: 'ignored' },
    });
    expect(event.code).toBe('very');
    expect(event.message).toBe('abcde');
    expect(Object.keys(event.tags ?? {})).toHaveLength(2);
    expect(event.tags).toEqual({ firs: '1234', seco: 'abcd' });
    journal.dispose();
  });

  it('drops blank messages, lanes and tags during normalization', () => {
    const journal = createRuntimeHealthJournal();
    const event = journal.record({
      at: 1, kind: 'lifecycle', severity: 'debug', code: '  boot  ', message: ' ', lane: ' ', tags: { ' ': 'x', valid: ' ' },
    });
    expect(event.code).toBe('boot');
    expect(event.message).toBeUndefined();
    expect(event.lane).toBeUndefined();
    expect(event.tags).toBeUndefined();
    journal.dispose();
  });

  it('returns frozen snapshots that cannot mutate journal ownership', () => {
    const journal = createRuntimeHealthJournal();
    journal.record({ at: 1, kind: 'lifecycle', severity: 'info', code: 'boot' });
    const snapshot = journal.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.events)).toBe(true);
    expect(Object.isFrozen(snapshot.summary)).toBe(true);
    expect(Object.isFrozen(snapshot.events[0])).toBe(true);
    journal.dispose();
  });

  it('clear resets counters and rolling windows while keeping the journal reusable', () => {
    const journal = createRuntimeHealthJournal();
    journal.record({ at: 1, kind: 'failure', severity: 'error', code: 'failure', durationMs: 100 });
    journal.clear();
    expect(journal.summary()).toMatchObject({ total: 0, retained: 0, dropped: 0, pruned: 0, failures: 0, failureRate: 0 });
    expect(journal.summary().p95LatencyMs).toBeNull();
    journal.record({ at: 2, kind: 'recovery', severity: 'info', code: 'ready', durationMs: 5 });
    expect(journal.summary().p95LatencyMs).toBe(5);
    journal.dispose();
  });

  it('disposal is idempotent and rejects subsequent journal operations', () => {
    const journal = createRuntimeHealthJournal();
    journal.record({ at: 1, kind: 'lifecycle', severity: 'info', code: 'boot' });
    journal.dispose();
    journal.dispose();
    expect(() => journal.query()).toThrow('disposed');
    expect(() => journal.summary()).toThrow('disposed');
    expect(() => journal.record({ at: 2, kind: 'lifecycle', severity: 'info', code: 'late' })).toThrow('disposed');
  });
});
