import {
  RuntimeDiagnostics,
  sanitizeRuntimeDiagnosticText,
  sanitizeRuntimeDiagnosticValue,
} from './runtimeDiagnostics';

describe('runtime diagnostics privacy and retention', () => {
  test('redacts credential-bearing object keys including common composite names', () => {
    const sanitized = sanitizeRuntimeDiagnosticValue({
      authorization: 'Bearer secret',
      accessToken: 'token-value',
      clientSecret: 'secret-value',
      connectionString: 'Server=db;Password=secret',
      status: 503,
    });

    expect(sanitized).toEqual({
      authorization: '[redacted]',
      accessToken: '[redacted]',
      clientSecret: '[redacted]',
      connectionString: '[redacted]',
      status: 503,
    });
  });

  test('redacts personal location and search fields by default', () => {
    const sanitized = sanitizeRuntimeDiagnosticValue({
      address: 'Kızılay, Ankara',
      coordinates: [32.85, 39.92],
      latitude: 39.92,
      longitude: 32.85,
      search: 'home address',
      query: 'private query',
      email: 'person@example.test',
      phone: '+90 555 000 00 00',
      durationMs: 42,
    });

    expect(sanitized).toEqual({
      address: '[redacted]',
      coordinates: '[redacted]',
      latitude: '[redacted]',
      longitude: '[redacted]',
      search: '[redacted]',
      query: '[redacted]',
      email: '[redacted]',
      phone: '[redacted]',
      durationMs: 42,
    });
  });

  test('removes query strings and fragments from absolute URLs', () => {
    expect(sanitizeRuntimeDiagnosticText(
      'Request failed at https://kentrehberi.example/api/search?q=private&token=secret#fragment',
    )).toBe('Request failed at https://kentrehberi.example/api/search');
  });

  test('removes query strings from relative URL values', () => {
    expect(sanitizeRuntimeDiagnosticText('/api/search?q=private&token=secret#fragment'))
      .toBe('/api/search');
  });

  test('redacts authorization values embedded in free-form text', () => {
    expect(sanitizeRuntimeDiagnosticText('Authorization failed: Bearer abc.def.ghi'))
      .toBe('Authorization failed: Bearer [redacted]');
    expect(sanitizeRuntimeDiagnosticText('Proxy rejected Basic Zm9vOmJhcg=='))
      .toBe('Proxy rejected Basic [redacted]');
  });

  test('redacts sensitive query values even when the text is not a standalone URL', () => {
    expect(sanitizeRuntimeDiagnosticText('request /api?q=ok&token=secret returned 401'))
      .toBe('request /api?q=ok&token=[redacted] returned 401');
  });

  test('sanitizes Error message and stack before retention', () => {
    const error = new Error('GET https://example.test/api?address=private&token=secret failed');
    error.stack = 'Error: failed\n    at https://example.test/app.js?session=private#frame';

    const sanitized = sanitizeRuntimeDiagnosticValue(error);
    expect(sanitized).toMatchObject({ message: 'GET https://example.test/api failed' });
    if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
      throw new TypeError('expected sanitized error record');
    }
    const record = sanitized as Readonly<Record<string, unknown>>;
    expect(record.stack).not.toContain('private');
    expect(record.stack).not.toContain('session=');
  });

  test('normalizes non-finite numbers instead of storing invalid JSON values', () => {
    expect(sanitizeRuntimeDiagnosticValue({
      finite: 10,
      nan: Number.NaN,
      positiveInfinity: Number.POSITIVE_INFINITY,
    })).toEqual({
      finite: 10,
      nan: null,
      positiveInfinity: null,
    });
  });

  test('omits functions and symbols from retained objects', () => {
    expect(sanitizeRuntimeDiagnosticValue({
      ok: true,
      callback: () => undefined,
      marker: Symbol('private'),
    })).toEqual({ ok: true });
  });

  test('bounds arrays, object depth and free-form strings', () => {
    const values = Array.from({ length: 100 }, (_, index) => index);
    const nested = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } };
    const sanitizedValues = sanitizeRuntimeDiagnosticValue(values);
    const sanitizedNested = sanitizeRuntimeDiagnosticValue(nested);
    const longText = sanitizeRuntimeDiagnosticText('x'.repeat(2000), 50);

    expect(sanitizedValues).toHaveLength(50);
    expect(sanitizedNested).toMatchObject({ a: { b: { c: { d: { e: '[max-depth]' } } } } });
    expect(longText).not.toBeNull();
    if (longText === null) throw new TypeError('expected bounded diagnostic text');
    expect(longText.length).toBe(50);
    expect(longText.endsWith('…')).toBe(true);
  });

  test('retains only the configured bounded number of events', () => {
    let now = 100;
    const diagnostics = new RuntimeDiagnostics({ capacity: 10, now: () => ++now });
    for (let index = 0; index < 15; index += 1) {
      diagnostics.record('test.event', { index });
    }

    const snapshot = diagnostics.snapshot();
    expect(snapshot.size).toBe(10);
    expect(snapshot.dropped).toBe(5);
    expect(snapshot.events.at(0)?.details.index).toBe(5);
    expect(snapshot.events.at(9)?.details.index).toBe(14);
  });

  test('captures non-Error failures without leaking secret text', () => {
    const diagnostics = new RuntimeDiagnostics();
    diagnostics.captureError('Bearer abc.def.ghi request failed', {
      source: 'test',
      address: 'private address',
    });

    const event = diagnostics.snapshot().events.at(0);
    expect(event).toBeDefined();
    if (!event) throw new TypeError('expected captured runtime diagnostic event');
    expect(event.message).toBe('Bearer [redacted] request failed');
    expect(event.details.address).toBe('[redacted]');
    expect(JSON.stringify(event)).not.toContain('abc.def.ghi');
    expect(JSON.stringify(event)).not.toContain('private address');
  });

  test('keeps event ids monotonic when the buffer is cleared', () => {
    const diagnostics = new RuntimeDiagnostics();
    const first = diagnostics.record('first');
    diagnostics.clear();
    const second = diagnostics.record('second');

    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
    expect(diagnostics.snapshot().dropped).toBe(0);
  });
});
