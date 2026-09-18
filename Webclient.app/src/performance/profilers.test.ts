import { describe, expect, it, vi } from 'vitest';
import { createPerformanceHistory } from './history';
import { createOperationProfiler } from './operationProfiler';
import { createStartupProfiler } from './startupProfiler';

describe('operation profiler', () => {
  it('profiles successful operations and classifies p95 budget pressure', async () => {
    let now = 0;
    const profiler = createOperationProfiler({
      warningMs: 50,
      blockMs: 100,
      sampleCapacity: 10,
    });

    const result = await profiler.measure('search', async () => {
      now = 120;
      return 42;
    }, { now: () => now });

    expect(result).toBe(42);
    const profile = profiler.snapshot()[0];
    expect(profile?.count).toBe(1);
    expect(profile?.level).toBe('block');
    expect(profile?.failures).toBe(0);
  });

  it('records failures without swallowing them', async () => {
    let now = 0;
    const profiler = createOperationProfiler();
    await expect(profiler.measure('failure', async () => {
      now = 20;
      throw new Error('boom');
    }, { now: () => now })).rejects.toThrow('boom');

    expect(profiler.snapshot()[0]?.failures).toBe(1);
  });

  it('rejects already aborted work and records cancellation', async () => {
    const profiler = createOperationProfiler();
    const controller = new AbortController();
    controller.abort('cancelled');

    await expect(profiler.measure('cancel', async () => 1, {
      signal: controller.signal,
      now: () => 0,
    })).rejects.toBe('cancelled');

    expect(profiler.snapshot()[0]?.cancellations).toBe(1);
  });

  it('bounds samples per operation', () => {
    const profiler = createOperationProfiler({ sampleCapacity: 2 });
    profiler.record('query', 10);
    profiler.record('query', 20);
    profiler.record('query', 30);
    const profile = profiler.snapshot()[0];
    expect(profile?.count).toBe(2);
    expect(profile?.duration.minimum).toBe(20);
    expect(profile?.duration.maximum).toBe(30);
  });
});

describe('startup profiler', () => {
  it('measures named startup phases deterministically', () => {
    const profiler = createStartupProfiler(4, () => 100);
    expect(profiler.begin('bootstrap', 10)).toBe(true);
    expect(profiler.begin('bootstrap', 12)).toBe(false);
    expect(profiler.end('bootstrap', 60)).toEqual({
      name: 'bootstrap',
      startedAtMs: 10,
      completedAtMs: 60,
      durationMs: 50,
    });
  });

  it('adds direct duration marks and sorts by start time', () => {
    let now = 100;
    const profiler = createStartupProfiler(4, () => now);
    profiler.mark('late', 10);
    now = 50;
    profiler.mark('early', 20);
    expect(profiler.snapshot().map(item => item.name)).toEqual(['early', 'late']);
  });

  it('evicts oldest phase identities when capacity is reached', () => {
    const profiler = createStartupProfiler(2, () => 10);
    profiler.begin('a');
    profiler.begin('b');
    profiler.begin('c');
    expect(profiler.snapshot().map(item => item.name)).toEqual(['b', 'c']);
  });
});

describe('performance history', () => {
  it('keeps bounded runtime snapshots and aggregates status', () => {
    const history = createPerformanceHistory(2);
    const create = (level: 'pass' | 'warning' | 'block', fingerprint: string) => ({
      report: {
        ready: level !== 'block',
        level,
        fingerprint,
      } as never,
      baseline: null,
      comparison: null,
    });

    history.add(create('pass', 'a'));
    history.add(create('warning', 'b'));
    history.add(create('block', 'c'));

    expect(history.values()).toHaveLength(2);
    expect(history.latest()?.report.fingerprint).toBe('c');
    expect(history.summary()).toMatchObject({
      size: 2,
      readyCount: 1,
      blockedCount: 1,
      warningCount: 1,
      latestFingerprint: 'c',
    });
    expect(history.clear()).toBe(2);
  });
});
