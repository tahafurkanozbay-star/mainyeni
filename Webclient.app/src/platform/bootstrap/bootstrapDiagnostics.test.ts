import { vi as jest } from 'vitest';
import {
  BootstrapDiagnostics,
  createBootstrapDiagnosticBridge,
  createBootstrapDiagnostics,
  sanitizeDiagnosticMetadata,
  sanitizeDiagnosticValue,
  summarizeBootstrapDiagnostics
} from './bootstrapDiagnostics';

const createClock = (values: readonly number[]) => {
  const queue = [...values];
  let last = queue[0] ?? 0;
  return jest.fn(() => {
    const next = queue.shift();
    if (next !== undefined) last = next;
    return last;
  });
};

describe('sanitizeDiagnosticValue', () => {
  test.each([
    ['authorization', 'Bearer abc'],
    ['Authorization', 'Bearer abc'],
    ['token', 'abc'],
    ['accessToken', 'abc'],
    ['password', 'abc'],
    ['clientSecret', 'abc'],
    ['connectionString', 'Host=db;Password=x'],
    ['apiKey', 'abc']
  ])('redacts sensitive key %s', (key, value) => {
    expect(sanitizeDiagnosticValue(key, value)).toBe('[redacted]');
  });

  test('retains ordinary bounded strings', () => {
    expect(sanitizeDiagnosticValue('stage', 'bootstrap-load')).toBe('bootstrap-load');
  });

  test('truncates oversized strings', () => {
    const value = 'x'.repeat(400);
    const sanitized = sanitizeDiagnosticValue('message', value);
    expect(typeof sanitized).toBe('string');
    if (typeof sanitized !== 'string') throw new TypeError('expected sanitized diagnostic text');
    expect(sanitized.length).toBeLessThanOrEqual(160);
    expect(sanitized.endsWith('…')).toBe(true);
  });

  test('strips query strings from absolute URLs', () => {
    expect(sanitizeDiagnosticValue(
      'url',
      'https://example.test/path/to/service?token=secret&x=1'
    )).toBe('/path/to/service');
  });

  test('strips query strings from relative endpoint values', () => {
    expect(sanitizeDiagnosticValue('endpoint', '/api/config?key=secret'))
      .toBe('/api/config');
  });

  test('strips fragments from URL-like values', () => {
    expect(sanitizeDiagnosticValue('href', '/app/map#private')).toBe('/app/map');
  });

  test('normalizes invalid absolute URLs safely', () => {
    expect(sanitizeDiagnosticValue('url', 'https://[invalid')).toBe('[invalid-url]');
  });

  test('preserves finite numbers', () => {
    expect(sanitizeDiagnosticValue('durationMs', 125)).toBe(125);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'normalizes non-finite number %p to null',
    (value) => {
      expect(sanitizeDiagnosticValue('value', value)).toBeNull();
    }
  );

  test('preserves booleans', () => {
    expect(sanitizeDiagnosticValue('retryable', true)).toBe(true);
    expect(sanitizeDiagnosticValue('retryable', false)).toBe(false);
  });

  test('converts bigint values to strings', () => {
    expect(sanitizeDiagnosticValue('count', BigInt(42))).toBe('42');
  });

  test('omits functions', () => {
    expect(sanitizeDiagnosticValue('handler', () => {})).toBeUndefined();
  });

  test('omits symbols', () => {
    expect(sanitizeDiagnosticValue('symbol', Symbol('x'))).toBeUndefined();
  });

  test('reduces Error objects to name and code', () => {
    const error = Object.assign(new Error('sensitive raw message'), { code: 'NETWORK' });
    expect(sanitizeDiagnosticValue('error', error)).toEqual({
      name: 'Error',
      code: 'NETWORK'
    });
  });

  test('limits diagnostic arrays', () => {
    const values = Array.from({ length: 40 }, (_, index) => index);
    expect(sanitizeDiagnosticValue('values', values)).toHaveLength(24);
  });

  test('redacts sensitive keys nested inside objects', () => {
    expect(sanitizeDiagnosticValue('metadata', {
      stage: 'load',
      nested: {
        password: 'secret',
        count: 2
      }
    })).toEqual({
      stage: 'load',
      nested: {
        password: '[redacted]',
        count: 2
      }
    });
  });

  test('cuts off deeply nested metadata', () => {
    const value = {
      a: {
        b: {
          c: {
            d: {
              e: 'too deep'
            }
          }
        }
      }
    };
    expect(sanitizeDiagnosticValue('metadata', value)).toMatchObject({
      a: { b: { c: { d: '[max-depth]' } } },
    });
  });
});

describe('sanitizeDiagnosticMetadata', () => {
  test('returns an empty object for missing metadata', () => {
    expect(sanitizeDiagnosticMetadata()).toEqual({});
    expect(sanitizeDiagnosticMetadata(null)).toEqual({});
  });

  test('returns an empty object for array metadata', () => {
    expect(sanitizeDiagnosticMetadata(['not', 'metadata'])).toEqual({});
  });

  test('keeps only the first bounded set of keys', () => {
    const metadata: Record<string, number> = {};
    for (let index = 0; index < 40; index += 1) {
      metadata[`key${index}`] = index;
    }
    expect(Object.keys(sanitizeDiagnosticMetadata(metadata))).toHaveLength(24);
  });

  test('omits unsupported values without dropping valid siblings', () => {
    expect(sanitizeDiagnosticMetadata({
      stage: 'load',
      callback: () => {},
      count: 3
    })).toEqual({ stage: 'load', count: 3 });
  });
});

describe('BootstrapDiagnostics', () => {
  test('records immutable event entries with monotonic ids', () => {
    const diagnostics = new BootstrapDiagnostics({
      clock: createClock([100, 120, 145])
    });

    const first = diagnostics.record('bootstrap.started', { stage: 'load' });
    const second = diagnostics.record('bootstrap.stage', { stage: 'validate' });

    expect(first).toMatchObject({
      id: 1,
      name: 'bootstrap.started',
      timestamp: 120,
      elapsedMs: 20
    });
    expect(second).toMatchObject({
      id: 2,
      name: 'bootstrap.stage',
      timestamp: 145,
      elapsedMs: 45
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.metadata)).toBe(true);
  });

  test('normalizes event names', () => {
    const diagnostics = createBootstrapDiagnostics();
    const event = diagnostics.record('  Bootstrap Stage / Load  ');
    expect(event.name).toBe('bootstrap-stage-load');
  });

  test('uses unknown for a blank event name', () => {
    const diagnostics = createBootstrapDiagnostics();
    expect(diagnostics.record('   ').name).toBe('unknown');
  });

  test('counts events independently', () => {
    const diagnostics = createBootstrapDiagnostics();
    diagnostics.record('bootstrap.stage');
    diagnostics.record('bootstrap.stage');
    diagnostics.record('bootstrap.completed');

    expect(diagnostics.count('bootstrap.stage')).toBe(2);
    expect(diagnostics.count('bootstrap.completed')).toBe(1);
    expect(diagnostics.count('bootstrap.failed')).toBe(0);
  });

  test('tracks the latest bootstrap stage', () => {
    const diagnostics = createBootstrapDiagnostics();
    diagnostics.record('bootstrap.stage', { stage: 'load' });
    diagnostics.record('bootstrap.stage', { stage: 'validate' });
    diagnostics.record('other.event', { stage: 'ignored' });
    expect(diagnostics.summary().lastStage).toBe('validate');
  });

  test('returns the latest event overall', () => {
    const diagnostics = createBootstrapDiagnostics();
    diagnostics.record('a');
    const latest = diagnostics.record('b');
    expect(diagnostics.latest()).toBe(latest);
  });

  test('returns the latest event matching a name', () => {
    const diagnostics = createBootstrapDiagnostics();
    diagnostics.record('bootstrap.stage', { stage: 'load' });
    diagnostics.record('other');
    const latestStage = diagnostics.record('bootstrap.stage', { stage: 'commit' });
    expect(diagnostics.latest('bootstrap.stage')).toBe(latestStage);
  });

  test('returns null when a named event has never occurred', () => {
    const diagnostics = createBootstrapDiagnostics();
    diagnostics.record('bootstrap.started');
    expect(diagnostics.latest('bootstrap.failed')).toBeNull();
  });

  test('bounds retained events to configured capacity', () => {
    const diagnostics = createBootstrapDiagnostics({ capacity: 10 });
    for (let index = 0; index < 18; index += 1) {
      diagnostics.record('event', { index });
    }

    const snapshot = diagnostics.snapshot();
    expect(snapshot).toHaveLength(10);
    expect(snapshot.at(0)?.metadata.index).toBe(8);
    expect(snapshot.at(9)?.metadata.index).toBe(17);
  });

  test('clamps very small capacities to ten events', () => {
    const diagnostics = createBootstrapDiagnostics({ capacity: 1 });
    for (let index = 0; index < 12; index += 1) diagnostics.record('event', { index });
    expect(diagnostics.snapshot()).toHaveLength(10);
  });

  test('clamps very large capacities to five hundred events', () => {
    const diagnostics = createBootstrapDiagnostics({ capacity: 10000 });
    for (let index = 0; index < 510; index += 1) diagnostics.record('event', { index });
    expect(diagnostics.snapshot()).toHaveLength(500);
  });

  test('snapshot can filter by event name', () => {
    const diagnostics = createBootstrapDiagnostics();
    diagnostics.record('a', { value: 1 });
    diagnostics.record('b', { value: 2 });
    diagnostics.record('a', { value: 3 });

    expect(diagnostics.snapshot({ eventName: 'a' }).map((event) => event.metadata.value))
      .toEqual([1, 3]);
  });

  test('snapshot can continue after a known event id', () => {
    const diagnostics = createBootstrapDiagnostics();
    diagnostics.record('a');
    diagnostics.record('b');
    diagnostics.record('c');

    expect(diagnostics.snapshot({ sinceId: 1 }).map((event) => event.name))
      .toEqual(['b', 'c']);
  });

  test('snapshot can restrict result count', () => {
    const diagnostics = createBootstrapDiagnostics();
    diagnostics.record('a');
    diagnostics.record('b');
    diagnostics.record('c');
    expect(diagnostics.snapshot({ limit: 2 }).map((event) => event.name))
      .toEqual(['b', 'c']);
  });

  test('snapshot results are immutable copies', () => {
    const diagnostics = createBootstrapDiagnostics();
    diagnostics.record('a', { value: 1 });
    const snapshot = diagnostics.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    const first = snapshot.at(0);
    expect(first).toBeDefined();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.metadata)).toBe(true);
  });

  test('summary reports retained and dropped event counts', () => {
    const diagnostics = createBootstrapDiagnostics({ capacity: 10 });
    for (let index = 0; index < 15; index += 1) diagnostics.record('event');
    expect(diagnostics.summary()).toMatchObject({
      eventCount: 10,
      totalRecorded: 15,
      droppedCount: 5
    });
  });

  test('summary exposes immutable sorted counters', () => {
    const diagnostics = createBootstrapDiagnostics();
    diagnostics.record('z-event');
    diagnostics.record('a-event');
    diagnostics.record('z-event');
    const summary = diagnostics.summary();
    expect(Object.keys(summary.counters)).toEqual(['a-event', 'z-event']);
    expect(summary.counters['z-event']).toBe(2);
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.counters)).toBe(true);
  });

  test('clear resets events, counters, sequence and stage', () => {
    const clock = createClock([100, 110, 120]);
    const diagnostics = createBootstrapDiagnostics({ clock });
    diagnostics.record('bootstrap.stage', { stage: 'load' });
    diagnostics.clear();

    expect(diagnostics.snapshot()).toEqual([]);
    expect(diagnostics.summary()).toMatchObject({
      eventCount: 0,
      totalRecorded: 0,
      droppedCount: 0,
      lastStage: null
    });
    expect(diagnostics.record('fresh').id).toBe(1);
  });

  test('never retains sensitive authentication metadata', () => {
    const diagnostics = createBootstrapDiagnostics();
    diagnostics.record('request', {
      authorization: 'Bearer secret',
      token: 'secret-token',
      endpoint: '/api/items?token=also-secret',
      status: 200
    });

    const serialized = JSON.stringify(diagnostics.snapshot());
    expect(serialized).not.toContain('Bearer secret');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('also-secret');
    expect(serialized).toContain('/api/items');
  });
});

describe('createBootstrapDiagnosticBridge', () => {
  test('forwards records into the diagnostics collector', () => {
    const diagnostics = createBootstrapDiagnostics();
    const bridge = createBootstrapDiagnosticBridge(diagnostics);
    const event = bridge.record('bootstrap.started', { count: 1 });
    expect(event.name).toBe('bootstrap.started');
    expect(diagnostics.count('bootstrap.started')).toBe(1);
  });

  test('invokes an optional observer with the sanitized event', () => {
    const diagnostics = createBootstrapDiagnostics();
    const observer = jest.fn();
    const bridge = createBootstrapDiagnosticBridge(diagnostics, observer);
    bridge.record('request', { password: 'secret', count: 2 });

    expect(observer).toHaveBeenCalledWith(expect.objectContaining({
      name: 'request',
      metadata: {
        password: '[redacted]',
        count: 2
      }
    }));
  });

  test('rejects a collector without record capability', () => {
    expect(() => createBootstrapDiagnosticBridge({} as never)).toThrow(TypeError);
  });
});

describe('summarizeBootstrapDiagnostics', () => {
  test('returns a stable empty summary for missing diagnostics', () => {
    expect(summarizeBootstrapDiagnostics(null)).toEqual({
      eventCount: 0,
      totalRecorded: 0,
      droppedCount: 0,
      lastStage: null,
      counters: {}
    });
  });

  test('delegates to a real diagnostics collector', () => {
    const diagnostics = createBootstrapDiagnostics();
    diagnostics.record('bootstrap.started');
    expect(summarizeBootstrapDiagnostics(diagnostics).totalRecorded).toBe(1);
  });
});
