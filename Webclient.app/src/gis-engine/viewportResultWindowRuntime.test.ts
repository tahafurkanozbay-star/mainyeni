import { describe, expect, it } from 'vitest';
import {
  ViewportResultWindowError,
  createViewportResultWindowRuntime,
} from './viewportResultWindowRuntime';

describe('viewportResultWindowRuntime', () => {
  it('commits pages and preserves deterministic feature order', () => {
    let now = 1;
    const runtime = createViewportResultWindowRuntime({}, () => now);
    runtime.begin('roads', 1);
    runtime.commitPage({
      windowKey: 'roads',
      generation: 1,
      pageIndex: 0,
      features: [
        { id: 2, payload: { name: 'two' }, estimatedBytes: 10 },
        { id: 1, payload: { name: 'one' }, estimatedBytes: 10 },
      ],
    });
    expect(runtime.read('roads', 1).map((feature) => feature.id)).toEqual([2, 1]);
    expect(runtime.snapshot()).toMatchObject({ windows: 1, totalFeatures: 2, totalEstimatedBytes: 20 });
    now += 1;
  });

  it('deduplicates typed feature identities while preserving number versus string', () => {
    const runtime = createViewportResultWindowRuntime();
    runtime.commitPage({
      windowKey: 'typed',
      generation: 1,
      pageIndex: 0,
      features: [
        { id: 1, payload: 'number', estimatedBytes: 5 },
        { id: '1', payload: 'string', estimatedBytes: 6 },
        { id: 1, payload: 'replacement', estimatedBytes: 7 },
      ],
    });
    const values = runtime.read('typed');
    expect(values).toHaveLength(2);
    expect(values.find((feature) => feature.id === 1)?.payload).toBe('replacement');
    expect(runtime.snapshot()).toMatchObject({ acceptedFeatures: 2 });
  });

  it('replaces features across pages without increasing cardinality', () => {
    const runtime = createViewportResultWindowRuntime();
    runtime.commitPage({
      windowKey: 'roads',
      generation: 1,
      pageIndex: 0,
      features: [{ id: 1, payload: 'old', estimatedBytes: 10 }],
    });
    const commit = runtime.commitPage({
      windowKey: 'roads',
      generation: 1,
      pageIndex: 1,
      features: [{ id: 1, payload: 'new', estimatedBytes: 20 }],
    });
    expect(commit).toMatchObject({ accepted: 0, replaced: 1, featureCount: 1, estimatedBytes: 20 });
    expect(runtime.read('roads')[0]?.payload).toBe('new');
  });

  it('treats already committed page indexes as idempotent duplicates', () => {
    const runtime = createViewportResultWindowRuntime();
    const page = {
      windowKey: 'roads',
      generation: 1,
      pageIndex: 0,
      features: [{ id: 1, payload: 'first', estimatedBytes: 10 }],
    };
    runtime.commitPage(page);
    const duplicate = runtime.commitPage({
      ...page,
      features: [{ id: 2, payload: 'ignored', estimatedBytes: 10 }],
    });
    expect(duplicate.duplicatePage).toBe(true);
    expect(runtime.read('roads').map((feature) => feature.id)).toEqual([1]);
    expect(runtime.snapshot().duplicatePages).toBe(1);
  });

  it('rejects stale generations without mutating the current window', () => {
    const runtime = createViewportResultWindowRuntime();
    runtime.commitPage({
      windowKey: 'roads',
      generation: 5,
      pageIndex: 0,
      features: [{ id: 1, payload: 'current', estimatedBytes: 10 }],
    });
    const stale = runtime.commitPage({
      windowKey: 'roads',
      generation: 4,
      pageIndex: 0,
      features: [{ id: 2, payload: 'stale', estimatedBytes: 10 }],
    });
    expect(stale.stale).toBe(true);
    expect(runtime.read('roads').map((feature) => feature.id)).toEqual([1]);
    expect(runtime.snapshot().staleCommits).toBe(1);
  });

  it('resets a window when a newer generation arrives', () => {
    const runtime = createViewportResultWindowRuntime();
    runtime.commitPage({
      windowKey: 'roads',
      generation: 1,
      pageIndex: 0,
      features: [{ id: 1, payload: 'old', estimatedBytes: 10 }],
    });
    runtime.commitPage({
      windowKey: 'roads',
      generation: 2,
      pageIndex: 0,
      features: [{ id: 2, payload: 'new', estimatedBytes: 10 }],
    });
    expect(runtime.read('roads', 1)).toEqual([]);
    expect(runtime.read('roads', 2).map((feature) => feature.id)).toEqual([2]);
    expect(runtime.snapshot().windowsSnapshot[0]?.generation).toBe(2);
  });

  it('enforces per-window feature budgets transactionally', () => {
    const runtime = createViewportResultWindowRuntime({
      maximumFeaturesPerWindow: 2,
      maximumTotalFeatures: 10,
    });
    runtime.commitPage({
      windowKey: 'roads',
      generation: 1,
      pageIndex: 0,
      features: [{ id: 1, payload: 1 }, { id: 2, payload: 2 }],
    });
    expect(() => runtime.commitPage({
      windowKey: 'roads',
      generation: 1,
      pageIndex: 1,
      features: [{ id: 3, payload: 3 }],
    })).toThrow(ViewportResultWindowError);
    expect(runtime.read('roads').map((feature) => feature.id)).toEqual([1, 2]);
  });

  it('enforces per-window byte budgets transactionally', () => {
    const runtime = createViewportResultWindowRuntime({
      maximumBytesPerWindow: 20,
      maximumTotalBytes: 100,
    });
    runtime.commitPage({
      windowKey: 'roads',
      generation: 1,
      pageIndex: 0,
      features: [{ id: 1, payload: 'a', estimatedBytes: 10 }],
    });
    expect(() => runtime.commitPage({
      windowKey: 'roads',
      generation: 1,
      pageIndex: 1,
      features: [{ id: 2, payload: 'b', estimatedBytes: 11 }],
    })).toThrow('byte budget');
    expect(runtime.snapshot().totalEstimatedBytes).toBe(10);
  });

  it('enforces page budgets before mutation', () => {
    const runtime = createViewportResultWindowRuntime({ maximumPagesPerWindow: 1 });
    runtime.commitPage({ windowKey: 'roads', generation: 1, pageIndex: 0, features: [] });
    expect(() => runtime.commitPage({
      windowKey: 'roads',
      generation: 1,
      pageIndex: 1,
      features: [],
    })).toThrow('page budget');
  });

  it('evicts least-recently-used unpinned windows under cardinality pressure', () => {
    let now = 1;
    const runtime = createViewportResultWindowRuntime({ maximumWindows: 2 }, () => now);
    runtime.begin('a', 1);
    now = 2;
    runtime.begin('b', 1);
    now = 3;
    runtime.read('b');
    now = 4;
    runtime.begin('c', 1);
    expect(runtime.snapshot().windowsSnapshot.map((window) => window.key).sort()).toEqual(['b', 'c']);
    expect(runtime.snapshot().evictions).toBe(1);
  });

  it('preserves pinned windows during global eviction', () => {
    let now = 1;
    const runtime = createViewportResultWindowRuntime({ maximumWindows: 2 }, () => now);
    runtime.begin('a', 1, { pinned: true });
    now = 2;
    runtime.begin('b', 1);
    now = 3;
    runtime.begin('c', 1);
    expect(runtime.snapshot().windowsSnapshot.map((window) => window.key).sort()).toEqual(['a', 'c']);
  });

  it('fails closed when all over-budget windows are protected or pinned', () => {
    const runtime = createViewportResultWindowRuntime({ maximumWindows: 1 });
    runtime.begin('a', 1, { pinned: true });
    expect(() => runtime.begin('b', 1, { pinned: true })).toThrow('global result-window budget');
  });

  it('expires idle unpinned windows without background timers', () => {
    let now = 0;
    const runtime = createViewportResultWindowRuntime({ maximumWindowAgeMs: 100 }, () => now);
    runtime.begin('old', 1);
    now = 101;
    expect(runtime.snapshot().windows).toBe(0);
    expect(runtime.snapshot().evictions).toBe(1);
  });

  it('does not age out pinned windows', () => {
    let now = 0;
    const runtime = createViewportResultWindowRuntime({ maximumWindowAgeMs: 100 }, () => now);
    runtime.begin('active', 1, { pinned: true });
    now = 1000;
    expect(runtime.snapshot().windowsSnapshot[0]?.key).toBe('active');
  });

  it('supports explicit unpinning before later eviction', () => {
    const runtime = createViewportResultWindowRuntime();
    runtime.begin('active', 1, { pinned: true });
    expect(runtime.pin('active', false)).toBe(true);
    expect(runtime.snapshot().windowsSnapshot[0]?.pinned).toBe(false);
  });

  it('marks windows complete without discarding earlier pages', () => {
    const runtime = createViewportResultWindowRuntime();
    runtime.commitPage({ windowKey: 'roads', generation: 1, pageIndex: 0, features: [] });
    const commit = runtime.commitPage({
      windowKey: 'roads',
      generation: 1,
      pageIndex: 1,
      features: [],
      complete: true,
    });
    expect(commit.complete).toBe(true);
    expect(runtime.snapshot().windowsSnapshot[0]).toMatchObject({ pages: 2, complete: true });
  });

  it('drops only the requested generation', () => {
    const runtime = createViewportResultWindowRuntime();
    runtime.begin('roads', 2);
    expect(runtime.drop('roads', 1)).toBe(false);
    expect(runtime.drop('roads', 2)).toBe(true);
    expect(runtime.snapshot().windows).toBe(0);
  });

  it('reports cleared window count', () => {
    const runtime = createViewportResultWindowRuntime();
    runtime.begin('a', 1);
    runtime.begin('b', 1);
    expect(runtime.clear()).toBe(2);
    expect(runtime.clear()).toBe(0);
  });

  it('estimates payload bytes when callers do not supply estimates', () => {
    const runtime = createViewportResultWindowRuntime();
    runtime.commitPage({
      windowKey: 'roads',
      generation: 1,
      pageIndex: 0,
      features: [{ id: 1, payload: { name: 'road' } }],
    });
    expect(runtime.snapshot().totalEstimatedBytes).toBeGreaterThan(0);
  });

  it('rejects malformed feature identities and byte estimates', () => {
    const runtime = createViewportResultWindowRuntime();
    expect(() => runtime.commitPage({
      windowKey: 'roads',
      generation: 1,
      pageIndex: 0,
      features: [{ id: Number.NaN, payload: null }],
    })).toThrow('feature id');
    expect(() => runtime.commitPage({
      windowKey: 'roads',
      generation: 1,
      pageIndex: 0,
      features: [{ id: 1, payload: null, estimatedBytes: -1 }],
    })).toThrow('estimatedBytes');
  });

  it('rejects malformed configuration eagerly', () => {
    expect(() => createViewportResultWindowRuntime({ maximumWindows: 0 })).toThrow('maximumWindows');
    expect(() => createViewportResultWindowRuntime({
      maximumFeaturesPerWindow: 20,
      maximumTotalFeatures: 10,
    })).toThrow('maximumFeaturesPerWindow');
    expect(() => createViewportResultWindowRuntime({
      maximumBytesPerWindow: 20,
      maximumTotalBytes: 10,
    })).toThrow('maximumBytesPerWindow');
  });

  it('freezes snapshots and read feature wrappers', () => {
    const runtime = createViewportResultWindowRuntime();
    runtime.commitPage({
      windowKey: 'roads',
      generation: 1,
      pageIndex: 0,
      features: [{ id: 1, payload: 'a' }],
    });
    const snapshot = runtime.snapshot();
    const values = runtime.read('roads');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.windowsSnapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.windowsSnapshot[0])).toBe(true);
    expect(Object.isFrozen(values)).toBe(true);
    expect(Object.isFrozen(values[0])).toBe(true);
  });

  it('rejects use after deterministic disposal', () => {
    const runtime = createViewportResultWindowRuntime();
    runtime.dispose();
    expect(() => runtime.snapshot()).toThrow('disposed');
    expect(() => runtime.begin('roads', 1)).toThrow('disposed');
  });

  it('makes disposal idempotent', () => {
    const runtime = createViewportResultWindowRuntime();
    expect(() => {
      runtime.dispose();
      runtime.dispose();
    }).not.toThrow();
  });
});
