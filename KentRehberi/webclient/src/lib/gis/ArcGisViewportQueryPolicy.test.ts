import { describe, expect, it } from 'vitest';
import { ArcGisViewportQueryPolicy, type ViewportQueryIntent } from './ArcGisViewportQueryPolicy';

const intent = (overrides: Partial<ViewportQueryIntent> = {}): ViewportQueryIntent => ({
  id: 'q-1',
  viewId: 'map-2d',
  revision: 1,
  priority: 'foreground',
  createdAt: 100,
  extentArea: 1000,
  estimatedFeatures: 100,
  estimatedBytes: 4096,
  ...overrides,
});

describe('ArcGisViewportQueryPolicy', () => {
  it('admits only current revisions and invalidates stale work on navigation', () => {
    const policy = new ArcGisViewportQueryPolicy();
    expect(policy.setRevision('map-2d', 1)).toBe(true);
    expect(policy.enqueue(intent(), 100)).toBe(true);
    expect(policy.startNext(101)?.id).toBe('q-1');
    expect(policy.setRevision('map-2d', 2)).toBe(true);
    expect(policy.snapshot()).toMatchObject({ running: 0, cancelled: 1 });
    expect(policy.enqueue(intent({ id: 'stale' }), 102)).toBe(false);
    expect(policy.enqueue(intent({ id: 'fresh', revision: 2 }), 102)).toBe(true);
  });

  it('schedules priority, age and id deterministically', () => {
    const policy = new ArcGisViewportQueryPolicy({ maxRunning: 4, maxRunningPerView: 4 });
    policy.setRevision('map-2d', 1);
    policy.enqueue(intent({ id: 'bg', priority: 'background', createdAt: 90 }), 100);
    policy.enqueue(intent({ id: 'fg', priority: 'foreground', createdAt: 80 }), 100);
    policy.enqueue(intent({ id: 'b', priority: 'interactive', createdAt: 70 }), 100);
    policy.enqueue(intent({ id: 'a', priority: 'interactive', createdAt: 70 }), 100);
    expect([0, 1, 2, 3].map(() => policy.startNext(101)?.id)).toEqual(['a', 'b', 'fg', 'bg']);
  });

  it('enforces global and per-view queue budgets', () => {
    const policy = new ArcGisViewportQueryPolicy({ maxQueued: 3, maxQueuedPerView: 2 });
    policy.setRevision('a', 1);
    policy.setRevision('b', 1);
    expect(policy.enqueue(intent({ id: 'a1', viewId: 'a' }), 100)).toBe(true);
    expect(policy.enqueue(intent({ id: 'a2', viewId: 'a' }), 100)).toBe(true);
    expect(policy.enqueue(intent({ id: 'a3', viewId: 'a' }), 100)).toBe(false);
    expect(policy.enqueue(intent({ id: 'b1', viewId: 'b' }), 100)).toBe(true);
    expect(policy.enqueue(intent({ id: 'b2', viewId: 'b' }), 100)).toBe(false);
  });

  it('enforces running concurrency independently per view', () => {
    const policy = new ArcGisViewportQueryPolicy({ maxRunning: 2, maxRunningPerView: 1 });
    policy.setRevision('a', 1);
    policy.setRevision('b', 1);
    policy.enqueue(intent({ id: 'a1', viewId: 'a' }), 100);
    policy.enqueue(intent({ id: 'a2', viewId: 'a' }), 100);
    policy.enqueue(intent({ id: 'b1', viewId: 'b' }), 100);
    expect(policy.startNext(101)?.id).toBe('a1');
    expect(policy.startNext(101)?.id).toBe('b1');
    expect(policy.startNext(101)).toBeNull();
  });

  it('rejects oversized extents, feature estimates and byte estimates', () => {
    const policy = new ArcGisViewportQueryPolicy({ maxExtentArea: 100, maxEstimatedFeatures: 10, maxEstimatedBytes: 1000 });
    policy.setRevision('map-2d', 1);
    expect(policy.enqueue(intent({ id: 'extent', extentArea: 101 }), 100)).toBe(false);
    expect(policy.enqueue(intent({ id: 'features', extentArea: 10, estimatedFeatures: 11 }), 100)).toBe(false);
    expect(policy.enqueue(intent({ id: 'bytes', extentArea: 10, estimatedFeatures: 1, estimatedBytes: 1001 }), 100)).toBe(false);
    expect(policy.snapshot().rejected).toBe(3);
  });

  it('rejects malformed identity and temporal input', () => {
    const policy = new ArcGisViewportQueryPolicy();
    policy.setRevision('map-2d', 1);
    expect(policy.enqueue(intent({ id: '' }), 100)).toBe(false);
    expect(policy.enqueue(intent({ id: 'bad\n' }), 100)).toBe(false);
    expect(policy.enqueue(intent({ id: 'future', createdAt: 101 }), 100)).toBe(false);
    expect(policy.enqueue(intent({ id: 'nan', extentArea: Number.NaN }), 100)).toBe(false);
    expect(policy.enqueue(intent({ id: 'negative', estimatedBytes: -1 }), 100)).toBe(false);
  });

  it('expires queued and running work without retaining payloads', () => {
    const policy = new ArcGisViewportQueryPolicy({ queueTtlMs: 10, runTtlMs: 20 });
    policy.setRevision('map-2d', 1);
    policy.enqueue(intent({ id: 'queued' }), 100);
    policy.sweep(111);
    expect(policy.snapshot()).toMatchObject({ queued: 0, expired: 1 });
    policy.enqueue(intent({ id: 'running', createdAt: 112 }), 112);
    expect(policy.startNext(112)?.id).toBe('running');
    policy.sweep(133);
    expect(policy.snapshot()).toMatchObject({ running: 0, expired: 2 });
  });

  it('reports completion only for an active current-revision lease', () => {
    const policy = new ArcGisViewportQueryPolicy();
    policy.setRevision('map-2d', 1);
    policy.enqueue(intent(), 100);
    policy.startNext(101);
    expect(policy.complete('missing', 102)).toBe(false);
    expect(policy.complete('q-1', 102)).toBe(true);
    expect(policy.complete('q-1', 103)).toBe(false);
  });

  it('bounds view cardinality and refuses revision rollback', () => {
    const policy = new ArcGisViewportQueryPolicy({ maxViews: 2 });
    expect(policy.setRevision('a', 3)).toBe(true);
    expect(policy.setRevision('b', 1)).toBe(true);
    expect(policy.setRevision('c', 1)).toBe(false);
    expect(policy.setRevision('a', 2)).toBe(false);
    expect(policy.setRevision('a', 4)).toBe(true);
  });

  it('cancels all work and revision state for a detached view', () => {
    const policy = new ArcGisViewportQueryPolicy({ maxRunningPerView: 2 });
    policy.setRevision('map-2d', 1);
    policy.enqueue(intent({ id: 'run' }), 100);
    policy.enqueue(intent({ id: 'queue' }), 100);
    policy.startNext(101);
    expect(policy.cancelView('map-2d')).toBe(2);
    expect(policy.snapshot()).toMatchObject({ queued: 0, running: 0, views: 0, cancelled: 2 });
  });

  it('returns detached immutable scalar diagnostics', () => {
    const policy = new ArcGisViewportQueryPolicy();
    policy.setRevision('map-2d', 1);
    const snapshot = policy.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toEqual({ queued: 0, running: 0, views: 1, accepted: 0, rejected: 0, expired: 0, cancelled: 0 });
  });

  it('disposal releases all bounded state and permanently closes admission', () => {
    const policy = new ArcGisViewportQueryPolicy();
    policy.setRevision('map-2d', 1);
    policy.enqueue(intent(), 100);
    policy.dispose();
    expect(policy.snapshot()).toMatchObject({ queued: 0, running: 0, views: 0 });
    expect(policy.setRevision('map-2d', 2)).toBe(false);
    expect(policy.enqueue(intent({ revision: 2 }), 101)).toBe(false);
    expect(policy.startNext(101)).toBeNull();
  });

  it('rejects duplicate ids across queued and running work', () => {
    const policy = new ArcGisViewportQueryPolicy();
    policy.setRevision('map-2d', 1);
    expect(policy.enqueue(intent(), 100)).toBe(true);
    expect(policy.enqueue(intent(), 100)).toBe(false);
    policy.startNext(101);
    expect(policy.enqueue(intent({ createdAt: 102 }), 102)).toBe(false);
  });
});
