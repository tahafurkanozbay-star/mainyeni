import { RequestTelemetry, sanitizeTelemetryPath } from './requestTelemetry';

describe('sanitizeTelemetryPath', () => {
  test('removes query and fragment', () => {
    expect(sanitizeTelemetryPath('/api/search?q=secret#details')).toBe('/api/search');
  });

  test('redacts numeric identifiers', () => {
    expect(sanitizeTelemetryPath('/api/parcels/123456/details'))
      .toBe('/api/parcels/{id}/details');
  });

  test('redacts UUID identifiers', () => {
    expect(sanitizeTelemetryPath('/api/items/550e8400-e29b-41d4-a716-446655440000'))
      .toBe('/api/items/{id}');
  });

  test('redacts long opaque segments', () => {
    expect(sanitizeTelemetryPath('/api/items/abcdefghijklmnopqrstuvwxzy0123456789'))
      .toBe('/api/items/{id}');
  });

  test('redacts oversized arbitrary segment', () => {
    const longValue = 'x'.repeat(65);
    expect(sanitizeTelemetryPath(`/api/search/${longValue}`))
      .toBe('/api/search/{value}');
  });

  test('normalizes missing leading slash', () => {
    expect(sanitizeTelemetryPath('api/items')).toBe('/api/items');
  });

  test('bounds total path length', () => {
    const value = sanitizeTelemetryPath(`/api/${'segment/'.repeat(40)}`);
    expect(value.length).toBeLessThanOrEqual(188);
  });
});

describe('RequestTelemetry lifecycle', () => {
  let clock;
  let telemetry;

  beforeEach(() => {
    clock = 1000;
    telemetry = new RequestTelemetry({
      capacity: 100,
      windowMs: 60000,
      now: () => clock
    });
  });

  test('records request lifecycle without query values', () => {
    const context = telemetry.start({ method: 'get', url: '/api/search?q=person-name' });
    clock += 250;
    telemetry.complete(context, { status: 200, attempts: 1 });

    const events = telemetry.snapshot();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'request-started',
      method: 'GET',
      path: '/api/search'
    });
    expect(events[1]).toMatchObject({
      type: 'request-completed',
      method: 'GET',
      path: '/api/search',
      statusClass: '2xx',
      durationBucket: '100-300ms',
      durationMs: 250,
      attempts: 1
    });
    expect(JSON.stringify(events)).not.toContain('person-name');
  });

  test('records failed request with safe error code only', () => {
    const context = telemetry.start({ method: 'post', url: '/api/items/1234' });
    clock += 20;
    telemetry.fail(context, {
      status: 503,
      errorCode: 'SERVER_ERROR',
      attempts: 2
    });

    expect(telemetry.snapshot()[1]).toMatchObject({
      type: 'request-failed',
      method: 'POST',
      path: '/api/items/{id}',
      statusClass: '5xx',
      errorCode: 'SERVER_ERROR',
      attempts: 2
    });
  });

  test('records abort separately from operational failure', () => {
    const context = telemetry.start({ method: 'get', url: '/api/slow' });
    telemetry.fail(context, {
      aborted: true,
      errorCode: 'ABORTED',
      attempts: 1
    });

    expect(telemetry.snapshot()[1].type).toBe('request-aborted');
  });

  test('records retry without closing active request', () => {
    const context = telemetry.start({ method: 'get', url: '/api/items' });
    clock += 100;
    telemetry.retry(context, { attempt: 1, delayMs: 500, status: 503 });
    expect(telemetry.summary().activeRequests).toBe(1);
    clock += 500;
    telemetry.complete(context, { status: 200, attempts: 2 });

    const events = telemetry.snapshot();
    expect(events[1]).toMatchObject({
      type: 'request-retry',
      attempt: 1,
      delayBucket: '300ms-1s',
      statusClass: '5xx'
    });
    expect(telemetry.summary().activeRequests).toBe(0);
  });

  test('records cache hit without creating active request', () => {
    telemetry.cacheHit({ method: 'get', url: '/api/items?token=secret' });
    expect(telemetry.snapshot()[0]).toMatchObject({
      type: 'cache-hit',
      method: 'GET',
      path: '/api/items'
    });
    expect(telemetry.summary().activeRequests).toBe(0);
  });

  test('records dedupe hit without duplicating request lifecycle', () => {
    telemetry.dedupeHit({ method: 'get', url: '/api/items' });
    expect(telemetry.snapshot()[0].type).toBe('dedupe-hit');
  });

  test('ignores duplicate completion for already closed context', () => {
    const context = telemetry.start({ method: 'get', url: '/api/items' });
    expect(telemetry.complete(context, { status: 200 })).not.toBeNull();
    expect(telemetry.complete(context, { status: 200 })).toBeNull();
    expect(telemetry.snapshot().filter((event) => event.type === 'request-completed'))
      .toHaveLength(1);
  });

  test('ignores duplicate failure for already closed context', () => {
    const context = telemetry.start({ method: 'get', url: '/api/items' });
    telemetry.complete(context, { status: 200 });
    expect(telemetry.fail(context, { status: 500 })).toBeNull();
  });

  test('normalizes unknown method to OTHER', () => {
    const context = telemetry.start({ method: 'custom', url: '/api/items' });
    expect(context.method).toBe('OTHER');
  });

  test('sanitizes unexpected error code', () => {
    const context = telemetry.start({ method: 'get', url: '/api/items' });
    telemetry.fail(context, { errorCode: 'bad code with spaces' });
    expect(telemetry.snapshot()[1].errorCode).toBe('UNKNOWN');
  });
});

describe('RequestTelemetry retention', () => {
  test('bounds event capacity', () => {
    let now = 0;
    const telemetry = new RequestTelemetry({
      capacity: 20,
      windowMs: 60000,
      now: () => now
    });

    for (let index = 0; index < 40; index += 1) {
      now += 1;
      telemetry.cacheHit({ method: 'get', url: `/api/items/${index}` });
    }

    const events = telemetry.snapshot();
    expect(events).toHaveLength(20);
    expect(events[0].timestamp).toBe(21);
    expect(events[19].timestamp).toBe(40);
  });

  test('prunes events outside rolling window', () => {
    let now = 1000;
    const telemetry = new RequestTelemetry({
      capacity: 100,
      windowMs: 1000,
      now: () => now
    });
    telemetry.cacheHit({ method: 'get', url: '/api/old' });
    now = 2501;
    telemetry.cacheHit({ method: 'get', url: '/api/new' });

    expect(telemetry.snapshot()).toHaveLength(1);
    expect(telemetry.snapshot()[0].path).toBe('/api/new');
  });

  test('clear removes events and active state', () => {
    const telemetry = new RequestTelemetry({ now: () => 1 });
    telemetry.start({ method: 'get', url: '/api/items' });
    telemetry.cacheHit({ method: 'get', url: '/api/items' });
    telemetry.clear();
    expect(telemetry.snapshot()).toEqual([]);
    expect(telemetry.summary().activeRequests).toBe(0);
  });
});

describe('RequestTelemetry summary', () => {
  test('aggregates outcomes, retry/cache/dedupe and path latency', () => {
    let now = 100;
    const telemetry = new RequestTelemetry({ now: () => now, windowMs: 60000 });

    const first = telemetry.start({ method: 'get', url: '/api/items/100' });
    now = 200;
    telemetry.complete(first, { status: 200 });

    const second = telemetry.start({ method: 'get', url: '/api/items/200' });
    now = 500;
    telemetry.retry(second, { attempt: 1, delayMs: 100, status: 503 });
    now = 700;
    telemetry.complete(second, { status: 200, attempts: 2 });

    const failed = telemetry.start({ method: 'post', url: '/api/items' });
    telemetry.fail(failed, { status: 422, errorCode: 'VALIDATION_ERROR' });

    const aborted = telemetry.start({ method: 'get', url: '/api/slow' });
    telemetry.fail(aborted, { aborted: true, errorCode: 'ABORTED' });

    telemetry.cacheHit({ method: 'get', url: '/api/items' });
    telemetry.dedupeHit({ method: 'get', url: '/api/items' });

    const summary = telemetry.summary();
    expect(summary.completedRequests).toBe(2);
    expect(summary.failedRequests).toBe(1);
    expect(summary.abortedRequests).toBe(1);
    expect(summary.retryCount).toBe(1);
    expect(summary.cacheHits).toBe(1);
    expect(summary.dedupeHits).toBe(1);
    expect(summary.byStatusClass).toEqual({ '2xx': 2, '4xx': 1 });
    expect(summary.byPath['/api/items/{id}']).toEqual({
      count: 2,
      maxDurationMs: 500,
      averageDurationMs: 300
    });
  });

  test('empty summary is stable', () => {
    const telemetry = new RequestTelemetry({ now: () => 0 });
    expect(telemetry.summary()).toMatchObject({
      activeRequests: 0,
      completedRequests: 0,
      failedRequests: 0,
      abortedRequests: 0,
      retryCount: 0,
      cacheHits: 0,
      dedupeHits: 0,
      averageDurationMs: 0,
      byStatusClass: {},
      byPath: {}
    });
  });
});
