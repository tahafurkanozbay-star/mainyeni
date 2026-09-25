import { describe, expect, it } from 'vitest';
import { RuntimeDependencyMaintenanceRegistry } from './runtimeDependencyMaintenanceRegistry';

const window = (overrides: Partial<Parameters<RuntimeDependencyMaintenanceRegistry['register']>[0]> = {}) => ({
  id: 'maintenance-1', service: 'map-shell', dependency: 'feature-catalog', startsAt: 100, endsAt: 200,
  mode: 'degraded' as const, reason: 'planned upgrade', ...overrides,
});

describe('RuntimeDependencyMaintenanceRegistry', () => {
  it('returns no maintenance mode outside registered windows', () => {
    const registry = new RuntimeDependencyMaintenanceRegistry();
    registry.register(window());
    expect(registry.evaluate('map-shell', 'feature-catalog', 99).mode).toBeUndefined();
    expect(registry.evaluate('map-shell', 'feature-catalog', 200).mode).toBeUndefined();
  });

  it('activates a window at its inclusive start boundary', () => {
    const registry = new RuntimeDependencyMaintenanceRegistry();
    registry.register(window());
    const decision = registry.evaluate('map-shell', 'feature-catalog', 100);
    expect(decision.mode).toBe('degraded');
    expect(decision.activeWindowIds).toEqual(['maintenance-1']);
    expect(decision.reasons).toEqual(['planned upgrade']);
  });

  it('chooses the strictest mode across overlapping windows', () => {
    const registry = new RuntimeDependencyMaintenanceRegistry();
    registry.register(window({ id: 'observe', mode: 'observe' }));
    registry.register(window({ id: 'block', mode: 'blocked', reason: 'schema migration' }));
    expect(registry.evaluate('map-shell', 'feature-catalog', 150).mode).toBe('blocked');
  });

  it('isolates maintenance windows by dependency', () => {
    const registry = new RuntimeDependencyMaintenanceRegistry();
    registry.register(window());
    expect(registry.evaluate('map-shell', 'address-index', 150).mode).toBeUndefined();
  });

  it('returns windows in deterministic id order', () => {
    const registry = new RuntimeDependencyMaintenanceRegistry();
    registry.register(window({ id: 'z' }));
    registry.register(window({ id: 'a' }));
    expect(registry.windows('map-shell').map((entry) => entry.id)).toEqual(['a', 'z']);
  });

  it('rejects non-monotonic evaluation per service', () => {
    const registry = new RuntimeDependencyMaintenanceRegistry();
    registry.evaluate('map-shell', 'feature-catalog', 100);
    expect(() => registry.evaluate('map-shell', 'feature-catalog', 99)).toThrow('monotonic');
  });

  it('allows independent clocks across services', () => {
    const registry = new RuntimeDependencyMaintenanceRegistry();
    registry.evaluate('map-shell', 'feature-catalog', 100);
    expect(() => registry.evaluate('search', 'address-index', 1)).not.toThrow();
  });

  it('enforces service capacity', () => {
    const registry = new RuntimeDependencyMaintenanceRegistry({ maxServices: 1 });
    registry.register(window());
    expect(() => registry.register(window({ id: 'other', service: 'search' }))).toThrow('service capacity');
  });

  it('enforces per-service window capacity', () => {
    const registry = new RuntimeDependencyMaintenanceRegistry({ maxWindowsPerService: 1 });
    registry.register(window());
    expect(() => registry.register(window({ id: 'other' }))).toThrow('window capacity');
  });

  it('rejects rebinding a window id to another dependency', () => {
    const registry = new RuntimeDependencyMaintenanceRegistry();
    registry.register(window());
    expect(() => registry.register(window({ dependency: 'address-index' }))).toThrow('cannot be rebound');
  });

  it('rejects rebinding a window id to another start time', () => {
    const registry = new RuntimeDependencyMaintenanceRegistry();
    registry.register(window());
    expect(() => registry.register(window({ startsAt: 101 }))).toThrow('cannot be rebound');
  });

  it('allows updating mutable window details while identity remains stable', () => {
    const registry = new RuntimeDependencyMaintenanceRegistry();
    registry.register(window());
    registry.register(window({ endsAt: 180, mode: 'blocked', reason: 'extended validation' }));
    expect(registry.evaluate('map-shell', 'feature-catalog', 150).mode).toBe('blocked');
  });

  it('removes windows and releases service capacity', () => {
    const registry = new RuntimeDependencyMaintenanceRegistry({ maxServices: 1 });
    registry.register(window());
    expect(registry.remove('map-shell', 'maintenance-1')).toBe(true);
    expect(registry.windows('map-shell')).toEqual([]);
    expect(() => registry.register(window({ service: 'search' }))).not.toThrow();
  });

  it('bounds decision history', () => {
    const registry = new RuntimeDependencyMaintenanceRegistry({ maxHistoryEntries: 2 });
    registry.evaluate('map-shell', 'feature-catalog', 1);
    registry.evaluate('map-shell', 'feature-catalog', 2);
    registry.evaluate('map-shell', 'feature-catalog', 3);
    expect(registry.history()).toHaveLength(2);
    expect(registry.history()[0]?.evaluatedAt).toBe(2);
  });

  it('returns defensive decision copies', () => {
    const registry = new RuntimeDependencyMaintenanceRegistry();
    registry.register(window());
    registry.evaluate('map-shell', 'feature-catalog', 150);
    const copy = [...registry.history()];
    expect(copy[0]?.activeWindowIds).toEqual(['maintenance-1']);
    registry.remove('map-shell', 'maintenance-1');
    expect(copy[0]?.activeWindowIds).toEqual(['maintenance-1']);
  });

  it('rejects invalid durations and excessive windows', () => {
    const registry = new RuntimeDependencyMaintenanceRegistry({ maxWindowDurationMs: 50 });
    expect(() => registry.register(window({ endsAt: 100 }))).toThrow('positive duration');
    expect(() => registry.register(window({ endsAt: 151 }))).toThrow('duration exceeded');
  });

  it('rejects invalid identifiers and timestamps', () => {
    const registry = new RuntimeDependencyMaintenanceRegistry();
    expect(() => registry.register(window({ id: '' }))).toThrow('id');
    expect(() => registry.register(window({ reason: ' ' }))).toThrow('reason');
    expect(() => registry.register(window({ startsAt: Number.NaN }))).toThrow('finite');
    expect(() => registry.evaluate('', 'feature-catalog', 1)).toThrow('service');
    expect(() => registry.evaluate('map-shell', '', 1)).toThrow('dependency');
  });

  it.each(['maxServices', 'maxWindowsPerService', 'maxHistoryEntries', 'maxWindowDurationMs'] as const)('rejects invalid policy %s', (key) => {
    expect(() => new RuntimeDependencyMaintenanceRegistry({ [key]: 0 })).toThrow(key);
  });
});
