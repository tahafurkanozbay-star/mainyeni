import { describe, expect, it } from 'vitest';
import { ArcGisLayerLifecycleRegistry } from './ArcGisLayerLifecycleRegistry';

const policy = {
  maxEntries: 3,
  maxFailuresBeforeCooldown: 2,
  failureCooldownMs: 100,
  staleEntryTtlMs: 50,
  maxDiagnosticLength: 16,
} as const;

describe('ArcGisLayerLifecycleRegistry', () => {
  it('moves a layer through load, ready and unload with monotonic generations', () => {
    const registry = new ArcGisLayerLifecycleRegistry(policy);
    const load = registry.beginLoad(' roads ', 10);
    expect(load.layerId).toBe('roads');
    expect(load.generation).toBe(1);
    expect(registry.markReady(load, 20)).toMatchObject({ phase: 'ready', generation: 1, failureCount: 0 });
    const unload = registry.beginUnload('roads', 30);
    expect(unload.generation).toBe(2);
    registry.finishUnload(unload);
    expect(registry.get('roads')).toBeNull();
  });

  it('rejects concurrent transitions and already-ready reloads', () => {
    const registry = new ArcGisLayerLifecycleRegistry(policy);
    const token = registry.beginLoad('buildings', 0);
    expect(() => registry.beginLoad('buildings', 1)).toThrow(/transitioning/);
    registry.markReady(token, 2);
    expect(() => registry.beginLoad('buildings', 3)).toThrow(/already ready/);
  });

  it('rejects stale completion tokens after a later generation starts', () => {
    const registry = new ArcGisLayerLifecycleRegistry(policy);
    const first = registry.beginLoad('parks', 0);
    registry.cancelLoad(first, 1);
    const second = registry.beginLoad('parks', 2);
    expect(second.generation).toBe(2);
    expect(() => registry.markReady(first, 3)).toThrow(/stale lifecycle token/);
    expect(registry.markReady(second, 4).phase).toBe('ready');
  });

  it('does not count caller cancellation as a service failure', () => {
    const registry = new ArcGisLayerLifecycleRegistry(policy);
    const token = registry.beginLoad('water', 0);
    const cancelled = registry.cancelLoad(token, 1);
    expect(cancelled).toMatchObject({ phase: 'idle', failureCount: 0, retryAfter: null });
    expect(token.signal.aborted).toBe(true);
  });

  it('applies cooldown only after the configured failure threshold', () => {
    const registry = new ArcGisLayerLifecycleRegistry(policy);
    const first = registry.beginLoad('terrain', 0);
    expect(registry.markFailed(first, 'network', 10).retryAfter).toBeNull();
    const second = registry.beginLoad('terrain', 11);
    expect(registry.markFailed(second, 'network', 20)).toMatchObject({ failureCount: 2, retryAfter: 120 });
    expect(() => registry.beginLoad('terrain', 119)).toThrow(/cooling down/);
    expect(registry.beginLoad('terrain', 120).generation).toBe(3);
  });

  it('resets failure history after a successful load', () => {
    const registry = new ArcGisLayerLifecycleRegistry(policy);
    const first = registry.beginLoad('poi', 0);
    registry.markFailed(first, 'temporary', 1);
    const retry = registry.beginLoad('poi', 2);
    expect(registry.markReady(retry, 3).failureCount).toBe(0);
  });

  it('bounds diagnostics without retaining untrusted oversized text', () => {
    const registry = new ArcGisLayerLifecycleRegistry(policy);
    const token = registry.beginLoad('poi', 0);
    const failed = registry.markFailed(token, 'x'.repeat(1000), 1);
    expect(failed.diagnostic).toBe('x'.repeat(16));
  });

  it('rejects blank diagnostics without mutating the loading state', () => {
    const registry = new ArcGisLayerLifecycleRegistry(policy);
    const token = registry.beginLoad('poi', 0);
    expect(() => registry.markFailed(token, '   ', 1)).toThrow(/blank/);
    expect(registry.get('poi')?.phase).toBe('loading');
  });

  it('prunes only stale non-resident entries', () => {
    const registry = new ArcGisLayerLifecycleRegistry(policy);
    const idle = registry.beginLoad('idle', 0);
    registry.cancelLoad(idle, 1);
    const ready = registry.beginLoad('ready', 0);
    registry.markReady(ready, 1);
    const loading = registry.beginLoad('loading', 0);
    expect(registry.prune(100)).toBe(1);
    expect(registry.get('idle')).toBeNull();
    expect(registry.get('ready')?.phase).toBe('ready');
    expect(registry.get('loading')?.phase).toBe('loading');
  });

  it('evicts the least recently touched idle or failed entry at capacity', () => {
    const registry = new ArcGisLayerLifecycleRegistry(policy);
    const a = registry.beginLoad('a', 0); registry.cancelLoad(a, 1);
    const b = registry.beginLoad('b', 2); registry.cancelLoad(b, 3);
    const c = registry.beginLoad('c', 4); registry.cancelLoad(c, 5);
    registry.touch('a', 10);
    registry.beginLoad('d', 11);
    expect(registry.get('b')).toBeNull();
    expect(registry.get('a')).not.toBeNull();
  });

  it('fails closed when capacity contains only resident or transitioning layers', () => {
    const registry = new ArcGisLayerLifecycleRegistry({ ...policy, maxEntries: 2 });
    const ready = registry.beginLoad('ready', 0); registry.markReady(ready, 1);
    registry.beginLoad('loading', 2);
    expect(() => registry.beginLoad('third', 3)).toThrow(/capacity exhausted/);
  });

  it('returns deterministic immutable snapshots', () => {
    const registry = new ArcGisLayerLifecycleRegistry(policy);
    const b = registry.beginLoad('b', 0); registry.cancelLoad(b, 1);
    const a = registry.beginLoad('a', 0); registry.cancelLoad(a, 1);
    const snapshots = registry.snapshot();
    expect(snapshots.map((item) => item.layerId)).toEqual(['a', 'b']);
    expect(Object.isFrozen(snapshots)).toBe(true);
    expect(Object.isFrozen(snapshots[0])).toBe(true);
  });

  it('aborts transition signals and clears state on dispose', () => {
    const registry = new ArcGisLayerLifecycleRegistry(policy);
    const token = registry.beginLoad('scene', 0);
    registry.dispose();
    expect(token.signal.aborted).toBe(true);
    expect(() => registry.snapshot()).toThrow(/disposed/);
    registry.dispose();
  });

  it('aborts unload token when unload finishes', () => {
    const registry = new ArcGisLayerLifecycleRegistry(policy);
    const load = registry.beginLoad('scene', 0); registry.markReady(load, 1);
    const unload = registry.beginUnload('scene', 2);
    registry.finishUnload(unload);
    expect(unload.signal.aborted).toBe(true);
  });

  it.each([
    ['', /layerId/],
    ['   ', /layerId/],
    ['x'.repeat(257), /layerId/],
  ])('rejects malformed layer id %j', (layerId, pattern) => {
    const registry = new ArcGisLayerLifecycleRegistry(policy);
    expect(() => registry.beginLoad(layerId, 0)).toThrow(pattern);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid clocks %s', (now) => {
    const registry = new ArcGisLayerLifecycleRegistry(policy);
    expect(() => registry.beginLoad('x', now)).toThrow(/now/);
  });

  it.each([
    ['maxEntries', 0], ['maxFailuresBeforeCooldown', 0], ['failureCooldownMs', 0], ['staleEntryTtlMs', 0], ['maxDiagnosticLength', 0],
  ] as const)('rejects invalid policy %s', (key, value) => {
    expect(() => new ArcGisLayerLifecycleRegistry({ ...policy, [key]: value })).toThrow();
  });

  it('allows failed and idle layers to unload deterministically', () => {
    const registry = new ArcGisLayerLifecycleRegistry(policy);
    const failedLoad = registry.beginLoad('failed', 0); registry.markFailed(failedLoad, 'error', 1);
    const idleLoad = registry.beginLoad('idle', 0); registry.cancelLoad(idleLoad, 1);
    const failedUnload = registry.beginUnload('failed', 2);
    const idleUnload = registry.beginUnload('idle', 2);
    expect(failedUnload.generation).toBe(2);
    expect(idleUnload.generation).toBe(2);
  });

  it('rejects unloading an unknown layer', () => {
    const registry = new ArcGisLayerLifecycleRegistry(policy);
    expect(() => registry.beginUnload('missing', 0)).toThrow(/not registered/);
  });
});
