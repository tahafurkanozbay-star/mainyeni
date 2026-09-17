import { describe, expect, test, vi } from 'vitest';
import { HealthRegistry } from './healthRegistry';

describe('HealthRegistry signal normalization', () => {
  test('normalizes health signals and bounds diagnostic details', () => {
    let now = 1000;
    const registry = new HealthRegistry({ now: () => now, defaultTtlMs: 5000 });
    const snapshot = registry.report({
      componentId: '  http-client ',
      status: 'healthy',
      message: ' ready ',
      source: ' probe ',
      details: {
        latencyMs: 25,
        cached: true,
        note: 'ok',
      },
    });

    expect(snapshot).toMatchObject({
      componentId: 'http-client',
      status: 'healthy',
      observedAt: 1000,
      expiresAt: 6000,
      message: 'ready',
      source: 'probe',
      stale: false,
      ageMs: 0,
    });
    expect(snapshot.details).toEqual({ latencyMs: 25, cached: true, note: 'ok' });

    now = 7000;
    expect(registry.get('http-client')).toMatchObject({ stale: true, ageMs: 6000 });
  });

  test('ttl zero produces a non-expiring signal', () => {
    const registry = new HealthRegistry({ now: () => 100 });
    registry.report({ componentId: 'offline-cache', status: 'healthy', ttlMs: 0 });
    expect(registry.get('offline-cache', 999999)).toMatchObject({ expiresAt: null, stale: false });
  });

  test('invalid unknown statuses normalize to unknown', () => {
    const registry = new HealthRegistry();
    const snapshot = registry.report({ componentId: 'provider', status: 'invalid' as never });
    expect(snapshot.status).toBe('unknown');
  });

  test('convenience reporters preserve optional message semantics', () => {
    const registry = new HealthRegistry({ now: () => 1 });
    expect(registry.healthy('a').status).toBe('healthy');
    expect(registry.degraded('b', 'slow').message).toBe('slow');
    expect(registry.unhealthy('c').status).toBe('unhealthy');
    expect(registry.disabled('d').expiresAt).toBeNull();
    expect(registry.unknown('e').status).toBe('unknown');
  });
});

describe('HealthRegistry readiness policy', () => {
  test('reports not-ready when required component has no signal', () => {
    const registry = new HealthRegistry({ readinessRequired: ['config', 'http'] });
    registry.healthy('config');
    const report = registry.readiness();
    expect(report.status).toBe('not-ready');
    expect(report.healthy).toEqual(['config']);
    expect(report.unknown).toEqual(['http']);
  });

  test('reports ready when all required components are fresh and healthy', () => {
    const registry = new HealthRegistry({ readinessRequired: ['config', 'http'] });
    registry.healthy('config');
    registry.healthy('http');
    expect(registry.readiness()).toMatchObject({
      status: 'ready',
      healthy: ['config', 'http'],
      unhealthy: [],
      unknown: [],
    });
  });

  test('degraded is readiness-degraded by default instead of hard blocked', () => {
    const registry = new HealthRegistry({ readinessRequired: ['search'] });
    registry.degraded('search', 'provider latency elevated');
    expect(registry.readiness().status).toBe('degraded');
  });

  test('policy can make degraded required components block readiness', () => {
    const registry = new HealthRegistry({
      readinessRequired: ['search'],
      degradedBlocksReadiness: true,
    });
    registry.degraded('search');
    expect(registry.readiness().status).toBe('not-ready');
  });

  test('stale required health blocks readiness by default', () => {
    let now = 100;
    const registry = new HealthRegistry({
      now: () => now,
      defaultTtlMs: 10,
      readinessRequired: ['http'],
    });
    registry.healthy('http');
    now = 111;
    const report = registry.readiness();
    expect(report.status).toBe('not-ready');
    expect(report.stale).toEqual(['http']);
  });

  test('stale can be tolerated while still surfacing degraded readiness', () => {
    let now = 100;
    const registry = new HealthRegistry({
      now: () => now,
      defaultTtlMs: 10,
      readinessRequired: ['http'],
      staleBlocksReadiness: false,
    });
    registry.healthy('http');
    now = 111;
    expect(registry.readiness().status).toBe('degraded');
  });

  test('disabled required components can be either degraded or blocked', () => {
    const degraded = new HealthRegistry({ readinessRequired: ['optional-shell'] });
    degraded.disabled('optional-shell');
    expect(degraded.readiness().status).toBe('degraded');

    const blocked = new HealthRegistry({
      readinessRequired: ['optional-shell'],
      disabledBlocksReadiness: true,
    });
    blocked.disabled('optional-shell');
    expect(blocked.readiness().status).toBe('not-ready');
  });

  test('changing required components increments revision and deduplicates ids', () => {
    const registry = new HealthRegistry();
    registry.setReadinessRequired(['b', 'a', 'a']);
    expect(registry.readiness().required).toEqual(['a', 'b']);
    const revision = registry.revision;
    registry.setReadinessRequired(['a', 'b']);
    expect(registry.revision).toBe(revision);
  });
});

describe('HealthRegistry lifecycle and observers', () => {
  test('observer failures never break health reporting', () => {
    const onChange = vi.fn(() => { throw new Error('metrics unavailable'); });
    const registry = new HealthRegistry({ onChange });
    expect(() => registry.healthy('http')).not.toThrow();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('subscriber failures are isolated from other subscribers', () => {
    const registry = new HealthRegistry();
    const good = vi.fn();
    registry.subscribe(() => { throw new Error('broken observer'); });
    registry.subscribe(good);
    registry.healthy('http');
    expect(good).toHaveBeenCalledTimes(1);
  });

  test('unsubscribe prevents future notifications', () => {
    const registry = new HealthRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    registry.healthy('a');
    unsubscribe();
    registry.healthy('b');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('remove and clear are observable mutations', () => {
    const registry = new HealthRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.healthy('a');
    registry.healthy('b');
    expect(registry.remove('a')).toBe(true);
    registry.clear();
    expect(registry.size).toBe(0);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  test('pruneExpired removes only expired ttl-backed entries', () => {
    let now = 10;
    const registry = new HealthRegistry({ now: () => now, defaultTtlMs: 5 });
    registry.healthy('ttl');
    registry.report({ componentId: 'persistent', status: 'healthy', ttlMs: 0 });
    now = 16;
    expect(registry.pruneExpired()).toEqual(['ttl']);
    expect(registry.get('ttl')).toBeNull();
    expect(registry.get('persistent')).not.toBeNull();
  });

  test('worstStatus treats stale signals as unknown', () => {
    let now = 0;
    const registry = new HealthRegistry({ now: () => now, defaultTtlMs: 10 });
    registry.healthy('a');
    registry.degraded('b', undefined, 0);
    expect(registry.worstStatus()).toBe('degraded');
    now = 11;
    expect(registry.worstStatus()).toBe('unknown');
  });

  test('snapshot is deterministic and includes readiness', () => {
    const registry = new HealthRegistry({ readinessRequired: ['a', 'b'], now: () => 100 });
    registry.healthy('b');
    registry.unhealthy('a');
    const snapshot = registry.snapshot();
    expect(snapshot.generatedAt).toBe(100);
    expect(snapshot.components.map((entry) => entry.componentId)).toEqual(['a', 'b']);
    expect(snapshot.readiness.status).toBe('not-ready');
    expect(snapshot.readiness.summary).toContain('1 unhealthy');
  });
});
