import { describe, expect, it } from 'vitest';
import {
  MissingBusinessServiceError,
  createBusinessDiagnostics,
  createServiceRegistry,
} from './index';

describe('bounded Business diagnostics', () => {
  it('records lifecycle timing with bounded capacity', () => {
    let now = 100;
    const diagnostics = createBusinessDiagnostics({
      capacity: 2,
      now: () => now,
    });

    const first = diagnostics.begin('first', { serviceKey: 'A' });
    now = 120;
    first.finish('success', { featureCount: 2 });

    const second = diagnostics.begin('second');
    now = 150;
    second.finish('empty');

    const third = diagnostics.begin('third');
    now = 180;
    third.finish('failure', { code: 'FAIL' });

    const snapshot = diagnostics.snapshot();
    expect(snapshot.capacity).toBe(2);
    expect(snapshot.events).toHaveLength(2);
    expect(snapshot.events.map(event => event.operation)).toEqual(['third', 'third']);
    expect(snapshot.counts.started).toBe(1);
    expect(snapshot.counts.failure).toBe(1);
  });

  it('captures duration and immutable metadata', () => {
    let now = 10;
    const diagnostics = createBusinessDiagnostics({ now: () => now });
    const handle = diagnostics.begin('query', {
      serviceKey: 'Layer',
      metadata: { key: 'value' },
    });
    now = 25;
    const event = handle.finish('success', {
      featureCount: 3,
      metadata: { source: 'test' },
    });

    expect(event.startedAt).toBe(10);
    expect(event.completedAt).toBe(25);
    expect(event.durationMs).toBe(15);
    expect(event.featureCount).toBe(3);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.metadata)).toBe(true);
  });

  it('keeps duplicate finish calls observable instead of silently mutating state', () => {
    let now = 1;
    const diagnostics = createBusinessDiagnostics({ now: () => now });
    const handle = diagnostics.begin('query');
    now = 2;
    handle.finish('success');
    now = 3;
    const duplicate = handle.finish('failure');

    expect(duplicate.code).toBe('DUPLICATE_FINISH');
    expect(diagnostics.snapshot().events).toHaveLength(3);
  });

  it('returns and clears a deterministic snapshot', () => {
    const diagnostics = createBusinessDiagnostics({ capacity: 5 });
    diagnostics.record('a', 'success');
    diagnostics.record('b', 'failure');
    expect(diagnostics.snapshot().counts.success).toBe(1);
    expect(diagnostics.snapshot().counts.failure).toBe(1);
    expect(diagnostics.clear()).toBe(2);
    expect(diagnostics.snapshot().events).toEqual([]);
  });
});

describe('Business service registry', () => {
  it('normalizes valid services and ignores non-record values', () => {
    const registry = createServiceRegistry({
      listServices: () => [
        { title: 'A', url: '/a' },
        null,
        'bad',
        { Title: 'B', Url: '/b' },
      ],
    });

    expect(registry.list()).toHaveLength(2);
    expect(registry.find('A')).toMatchObject({ title: 'A' });
    expect(registry.find('B')).toMatchObject({ Title: 'B' });
    expect(registry.find('missing')).toBeNull();
  });

  it('requires configured services with typed failure metadata', () => {
    const registry = createServiceRegistry({ listServices: () => [] });
    expect(() => registry.require('Missing')).toThrow(MissingBusinessServiceError);
    expect(() => registry.requireUrl('Missing')).toThrowError(
      'Servis bulunamadı (Missing)',
    );
  });

  it('resolves legacy URL property variants', () => {
    const registry = createServiceRegistry({
      listServices: () => [
        { title: 'a', eg: '/eg' },
        { title: 'b', Eg: '/Eg' },
        { title: 'c', url: '/url' },
        { title: 'd', Url: '/Url' },
      ],
    });
    expect(registry.requireUrl('a')).toBe('/eg');
    expect(registry.requireUrl('b')).toBe('/Eg');
    expect(registry.requireUrl('c')).toBe('/url');
    expect(registry.requireUrl('d')).toBe('/Url');
  });

  it('returns immutable stable service snapshots', () => {
    const registry = createServiceRegistry({
      listServices: () => [
        { title: 'A', url: '/a' },
        { Title: 'B', Url: '/b' },
      ],
    });
    const snapshot = registry.snapshot();
    expect(snapshot).toEqual([
      { key: 'A', url: '/a', index: 0 },
      { key: 'B', url: '/b', index: 1 },
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
  });

  it('reads a fresh service list on every operation to preserve runtime config updates', () => {
    let services = [{ title: 'A', url: '/a' }];
    const registry = createServiceRegistry({ listServices: () => services });
    expect(registry.requireUrl('A')).toBe('/a');

    services = [{ title: 'A', url: '/a-v2' }];
    expect(registry.requireUrl('A')).toBe('/a-v2');
  });
});
