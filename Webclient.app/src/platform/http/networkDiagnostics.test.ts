import { vi as jest } from 'vitest';
import {
  DURATION_BUCKETS,
  NetworkDiagnostics,
  createDiagnosticsBridge,
  createNetworkDiagnostics,
  getDurationBucket,
  normalizeNetworkEventName,
  recordNetworkEvent,
  sanitizeNetworkDiagnosticMetadata,
  sanitizeNetworkDiagnosticValue
} from './networkDiagnostics';

const createClock = (values) => {
  const queue = [...values];
  let last = queue.length ? queue[0] : 0;
  return jest.fn(() => {
    if (queue.length) last = queue.shift();
    return last;
  });
};

describe('networkDiagnostics value redaction', () => {
  test.each([
    ['authorization', 'Bearer secret'],
    ['Authorization', 'Bearer secret'],
    ['cookie', 'session=secret'],
    ['password', 'secret'],
    ['passwd', 'secret'],
    ['token', 'secret'],
    ['accessToken', 'secret'],
    ['credential', 'secret'],
    ['api_key', 'secret'],
    ['api-key', 'secret'],
    ['clientKey', 'secret'],
    ['connectionString', 'Host=db;Password=x']
  ])('redacts sensitive key %s', (key, value) => {
    expect(sanitizeNetworkDiagnosticValue(key, value)).toBe('[redacted]');
  });

  test('keeps ordinary strings', () => {
    expect(sanitizeNetworkDiagnosticValue('method', 'GET')).toBe('GET');
  });

  test('truncates long ordinary strings', () => {
    const result = sanitizeNetworkDiagnosticValue('message', 'x'.repeat(500));
    expect(result.length).toBeLessThanOrEqual(240);
    expect(result.endsWith('…')).toBe(true);
  });

  test('strips query string from absolute URL', () => {
    expect(sanitizeNetworkDiagnosticValue(
      'url',
      'https://example.test/api/items?token=secret#fragment'
    )).toBe('/api/items');
  });

  test('strips query string from relative URL', () => {
    expect(sanitizeNetworkDiagnosticValue('endpoint', '/api/items?token=secret')).toBe('/api/items');
  });

  test('strips fragment from path values', () => {
    expect(sanitizeNetworkDiagnosticValue('path', '/map#private')).toBe('/map');
  });

  test('preserves finite numbers', () => {
    expect(sanitizeNetworkDiagnosticValue('status', 200)).toBe(200);
  });

  test.each([NaN, Infinity, -Infinity])('normalizes non-finite number %p', (value) => {
    expect(sanitizeNetworkDiagnosticValue('duration', value)).toBeNull();
  });

  test('preserves booleans', () => {
    expect(sanitizeNetworkDiagnosticValue('retryable', true)).toBe(true);
  });

  test('serializes bigint safely', () => {
    expect(sanitizeNetworkDiagnosticValue('count', BigInt(42))).toBe('42');
  });

  test('omits functions and symbols', () => {
    expect(sanitizeNetworkDiagnosticValue('handler', () => {})).toBeUndefined();
    expect(sanitizeNetworkDiagnosticValue('symbol', Symbol('x'))).toBeUndefined();
  });

  test('reduces Error object to safe fields', () => {
    const error = Object.assign(new Error('raw secret detail'), {
      code: 'SERVER_ERROR', status: 503, retryable: true
    });
    expect(sanitizeNetworkDiagnosticValue('error', error)).toEqual({
      name: 'Error', code: 'SERVER_ERROR', status: 503, retryable: true
    });
  });

  test('limits array item count', () => {
    const result = sanitizeNetworkDiagnosticValue(
      'items',
      Array.from({ length: 50 }, (_, index) => index)
    );
    expect(result).toHaveLength(30);
  });

  test('redacts nested sensitive fields', () => {
    expect(sanitizeNetworkDiagnosticValue('metadata', {
      request: { token: 'secret', method: 'get' }
    })).toEqual({
      request: { token: '[redacted]', method: 'get' }
    });
  });

  test('bounds nested object depth', () => {
    const input = { a: { b: { c: { d: { e: { value: 'deep' } } } } } };
    expect(sanitizeNetworkDiagnosticValue('metadata', input).a.b.c.d.e).toBe('[max-depth]');
  });

  test('limits object key count', () => {
    const input = {};
    for (let index = 0; index < 50; index += 1) input[`key${index}`] = index;
    expect(Object.keys(sanitizeNetworkDiagnosticValue('metadata', input))).toHaveLength(30);
  });
});

describe('networkDiagnostics metadata sanitization', () => {
  test('returns empty metadata for missing values', () => {
    expect(sanitizeNetworkDiagnosticMetadata()).toEqual({});
    expect(sanitizeNetworkDiagnosticMetadata(null)).toEqual({});
  });

  test('returns empty metadata for arrays', () => {
    expect(sanitizeNetworkDiagnosticMetadata(['bad'])).toEqual({});
  });

  test('preserves safe siblings while redacting secrets', () => {
    expect(sanitizeNetworkDiagnosticMetadata({
      method: 'get', token: 'secret', status: 200
    })).toEqual({
      method: 'get', token: '[redacted]', status: 200
    });
  });

  test('omits unsupported values', () => {
    expect(sanitizeNetworkDiagnosticMetadata({
      method: 'get', callback: () => {}, status: 200
    })).toEqual({ method: 'get', status: 200 });
  });
});

describe('networkDiagnostics event naming', () => {
  test.each([
    ['network.request.started', 'network.request.started'],
    [' Network Request Started ', 'network-request-started'],
    ['NETWORK:RETRY', 'network:retry'],
    ['', 'network.unknown'],
    [null, 'network.unknown']
  ])('normalizes event name %p', (input, expected) => {
    expect(normalizeNetworkEventName(input)).toBe(expected);
  });

  test('bounds event name length', () => {
    expect(normalizeNetworkEventName('x'.repeat(200)).length).toBeLessThanOrEqual(96);
  });
});

describe('networkDiagnostics duration buckets', () => {
  test('publishes a stable bucket order', () => {
    expect(DURATION_BUCKETS).toEqual([
      'lt-100ms', '100-249ms', '250-499ms', '500-999ms',
      '1-2.9s', '3-9.9s', 'gte-10s'
    ]);
    expect(Object.isFrozen(DURATION_BUCKETS)).toBe(true);
  });

  test.each([
    [0, 'lt-100ms'], [99, 'lt-100ms'], [100, '100-249ms'], [249, '100-249ms'],
    [250, '250-499ms'], [499, '250-499ms'], [500, '500-999ms'], [999, '500-999ms'],
    [1000, '1-2.9s'], [2999, '1-2.9s'], [3000, '3-9.9s'], [9999, '3-9.9s'],
    [10000, 'gte-10s']
  ])('classifies %sms as %s', (duration, expected) => {
    expect(getDurationBucket(duration)).toBe(expected);
  });

  test('clamps negative duration into fastest bucket', () => {
    expect(getDurationBucket(-1)).toBe('lt-100ms');
  });

  test('handles invalid duration defensively', () => {
    expect(getDurationBucket('invalid')).toBe('lt-100ms');
  });
});

describe('NetworkDiagnostics bounded collector', () => {
  test('records immutable events with elapsed time', () => {
    const diagnostics = new NetworkDiagnostics({ clock: createClock([100, 125]) });
    const event = diagnostics.record('network.request.started', { method: 'get' });
    expect(event).toEqual({
      id: 1,
      name: 'network.request.started',
      timestamp: 125,
      elapsedMs: 25,
      metadata: { method: 'get' }
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.metadata)).toBe(true);
  });

  test('clamps capacity to minimum ten', () => {
    const diagnostics = createNetworkDiagnostics({ capacity: 1 });
    for (let index = 0; index < 15; index += 1) diagnostics.record('event', { index });
    expect(diagnostics.snapshot()).toHaveLength(10);
  });

  test('clamps capacity to maximum one thousand', () => {
    const diagnostics = createNetworkDiagnostics({ capacity: 5000 });
    for (let index = 0; index < 1010; index += 1) diagnostics.record('event', { index });
    expect(diagnostics.snapshot()).toHaveLength(1000);
  });

  test('drops oldest events when capacity is exceeded', () => {
    const diagnostics = createNetworkDiagnostics({ capacity: 10 });
    for (let index = 0; index < 14; index += 1) diagnostics.record('event', { index });
    const snapshot = diagnostics.snapshot();
    expect(snapshot[0].metadata.index).toBe(4);
    expect(snapshot[9].metadata.index).toBe(13);
  });

  test('counts events by normalized name', () => {
    const diagnostics = createNetworkDiagnostics();
    diagnostics.record('network.retry');
    diagnostics.record('NETWORK.RETRY');
    diagnostics.record('network.completed');
    expect(diagnostics.count('network.retry')).toBe(2);
    expect(diagnostics.count('network.completed')).toBe(1);
  });

  test('returns latest event overall', () => {
    const diagnostics = createNetworkDiagnostics();
    diagnostics.record('a');
    const expected = diagnostics.record('b');
    expect(diagnostics.latest()).toBe(expected);
  });

  test('returns latest event by name', () => {
    const diagnostics = createNetworkDiagnostics();
    diagnostics.record('a', { value: 1 });
    diagnostics.record('b', { value: 2 });
    const expected = diagnostics.record('a', { value: 3 });
    expect(diagnostics.latest('a')).toBe(expected);
  });

  test('returns null for missing named event', () => {
    const diagnostics = createNetworkDiagnostics();
    diagnostics.record('a');
    expect(diagnostics.latest('missing')).toBeNull();
  });

  test('filters snapshots by name', () => {
    const diagnostics = createNetworkDiagnostics();
    diagnostics.record('a', { value: 1 });
    diagnostics.record('b', { value: 2 });
    diagnostics.record('a', { value: 3 });
    expect(diagnostics.snapshot({ eventName: 'a' }).map((item) => item.metadata.value))
      .toEqual([1, 3]);
  });

  test('filters snapshots after id', () => {
    const diagnostics = createNetworkDiagnostics();
    diagnostics.record('a');
    diagnostics.record('b');
    diagnostics.record('c');
    expect(diagnostics.snapshot({ sinceId: 1 }).map((item) => item.name)).toEqual(['b', 'c']);
  });

  test('limits snapshot result count', () => {
    const diagnostics = createNetworkDiagnostics();
    diagnostics.record('a');
    diagnostics.record('b');
    diagnostics.record('c');
    expect(diagnostics.snapshot({ limit: 2 }).map((item) => item.name)).toEqual(['b', 'c']);
  });

  test('returns immutable snapshot copies', () => {
    const diagnostics = createNetworkDiagnostics();
    diagnostics.record('a', { value: 1 });
    const snapshot = diagnostics.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(Object.isFrozen(snapshot[0].metadata)).toBe(true);
  });

  test('counts status codes from metadata', () => {
    const diagnostics = createNetworkDiagnostics();
    diagnostics.record('done', { status: 200 });
    diagnostics.record('done', { status: 200 });
    diagnostics.record('failed', { status: 503 });
    expect(diagnostics.summary().statusCounters).toEqual({ '200': 2, '503': 1 });
  });

  test('counts duration buckets from metadata', () => {
    const diagnostics = createNetworkDiagnostics();
    diagnostics.record('done', { durationMs: 50 });
    diagnostics.record('done', { durationMs: 150 });
    diagnostics.record('done', { durationMs: 150 });
    diagnostics.record('done', { durationMs: 12000 });
    expect(diagnostics.summary().durationBuckets).toEqual({
      'lt-100ms': 1,
      '100-249ms': 2,
      'gte-10s': 1
    });
  });

  test('summary reports retained and dropped counts', () => {
    const diagnostics = createNetworkDiagnostics({ capacity: 10 });
    for (let index = 0; index < 15; index += 1) diagnostics.record('event');
    expect(diagnostics.summary()).toMatchObject({
      retainedEvents: 10,
      totalRecorded: 15,
      droppedEvents: 5
    });
  });

  test('summary objects are immutable', () => {
    const diagnostics = createNetworkDiagnostics();
    diagnostics.record('a', { status: 200, durationMs: 20 });
    const summary = diagnostics.summary();
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.counters)).toBe(true);
    expect(Object.isFrozen(summary.statusCounters)).toBe(true);
    expect(Object.isFrozen(summary.durationBuckets)).toBe(true);
  });

  test('clear resets all state and sequence', () => {
    const clock = createClock([100, 110, 120, 130]);
    const diagnostics = createNetworkDiagnostics({ clock });
    diagnostics.record('a', { status: 200, durationMs: 20 });
    diagnostics.clear();
    expect(diagnostics.summary()).toMatchObject({
      retainedEvents: 0,
      totalRecorded: 0,
      droppedEvents: 0,
      counters: {},
      statusCounters: {},
      durationBuckets: {}
    });
    expect(diagnostics.record('fresh').id).toBe(1);
  });

  test('never retains URL query secrets', () => {
    const diagnostics = createNetworkDiagnostics();
    diagnostics.record('request', {
      url: '/api/items?token=secret&district=1',
      authorization: 'Bearer raw-secret'
    });
    const serialized = JSON.stringify(diagnostics.snapshot());
    expect(serialized).toContain('/api/items');
    expect(serialized).not.toContain('token=secret');
    expect(serialized).not.toContain('raw-secret');
  });
});

describe('networkDiagnostics bridge helpers', () => {
  test('creates default diagnostics instance', () => {
    expect(createNetworkDiagnostics()).toBeInstanceOf(NetworkDiagnostics);
  });

  test('bridge forwards sanitized event to observer', () => {
    const diagnostics = createNetworkDiagnostics();
    const observer = jest.fn();
    const bridge = createDiagnosticsBridge(diagnostics, observer);
    bridge.record('request', { token: 'secret', method: 'get' });
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({
      name: 'request',
      metadata: { token: '[redacted]', method: 'get' }
    }));
  });

  test('bridge still records without observer', () => {
    const diagnostics = createNetworkDiagnostics();
    const bridge = createDiagnosticsBridge(diagnostics);
    bridge.record('request');
    expect(diagnostics.count('request')).toBe(1);
  });

  test('bridge rejects invalid diagnostics collector', () => {
    expect(() => createDiagnosticsBridge({})).toThrow(TypeError);
  });

  test('recordNetworkEvent tolerates missing diagnostics', () => {
    expect(recordNetworkEvent(null, 'event')).toBeNull();
  });

  test('recordNetworkEvent delegates to collector', () => {
    const diagnostics = createNetworkDiagnostics();
    const event = recordNetworkEvent(diagnostics, 'event', { status: 200 });
    expect(event.name).toBe('event');
    expect(diagnostics.count('event')).toBe(1);
  });
});
