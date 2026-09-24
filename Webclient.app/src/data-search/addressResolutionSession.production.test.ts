import {
  createAddressResolutionSession,
  normalizeAddressResolutionRequest,
} from './addressResolutionSession';

describe('address resolution session', () => {
  test('normalizes query, hierarchy filters, provider ids and stable fingerprints', () => {
    const first = normalizeAddressResolutionRequest({
      query: '  Atatürk Bulvarı 18 ',
      district: 'Çankaya',
      neighborhood: 'Kızılay',
      providerIds: ['B', 'a', 'b'],
      limit: 500,
    }, { maxLimit: 100 });
    const second = normalizeAddressResolutionRequest({
      query: 'Ataturk Bulvari 18',
      district: 'Cankaya',
      neighborhood: 'Kizilay',
      providerIds: ['a', 'b'],
      limit: 100,
    }, { maxLimit: 100 });

    expect(first.canonicalQuery).toBe(second.canonicalQuery);
    expect(first.district).toBe(second.district);
    expect(first.providerIds).toEqual(['a', 'b']);
    expect(first.limit).toBe(100);
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  test('requires either text or valid coordinates', () => {
    expect(() => normalizeAddressResolutionRequest({})).toThrow('requires a query or valid coordinates');
    expect(() => normalizeAddressResolutionRequest({ coordinates: [999, 999] })).toThrow('coordinates are invalid');
  });

  test('supports coordinate-only reverse resolution requests', () => {
    const request = normalizeAddressResolutionRequest({ coordinates: [32.85, 39.92] });
    expect(request.coordinates).toEqual({ latitude: 39.92, longitude: 32.85 });
    expect(request.query).toBe('');
  });

  test('executes an immediate request and exposes success state', async () => {
    const executor = vi.fn(request => ({ key: request.canonicalQuery }));
    const session = createAddressResolutionSession(executor, { debounceMs: 0 });

    const result = await session.resolveNow({ query: 'Kızılay' });
    expect(result.result).toEqual({ key: 'kizilay' });
    expect(result.cacheHit).toBe(false);
    expect(result.stale).toBe(false);
    expect(session.getState()).toEqual(expect.objectContaining({ status: 'success' }));
    expect(session.snapshot().executions).toBe(1);
  });

  test('caches successful normalized requests', async () => {
    const executor = vi.fn(request => request.fingerprint);
    const session = createAddressResolutionSession(executor, { cacheTtlMs: 10_000 });

    const first = await session.resolveNow({ query: 'Kızılay', district: 'Çankaya' });
    const second = await session.resolveNow({ query: 'Kizilay', district: 'Cankaya' });

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(session.snapshot()).toEqual(expect.objectContaining({ cacheHits: 1, cacheMisses: 1 }));
  });

  test('bypassCache forces a fresh execution without weakening key normalization', async () => {
    let sequence = 0;
    const session = createAddressResolutionSession(() => ++sequence);
    await session.resolveNow({ query: 'Ulus' });
    const cached = await session.resolveNow({ query: 'ulus' });
    const fresh = await session.resolveNow({ query: 'Ulus' }, { bypassCache: true });

    expect(cached.result).toBe(1);
    expect(cached.cacheHit).toBe(true);
    expect(fresh.result).toBe(2);
    expect(fresh.cacheHit).toBe(false);
  });

  test('new immediate work aborts a superseded active request', async () => {
    let releaseFirst: (() => void) | undefined;
    const executor = vi.fn((request, context) => {
      if (request.canonicalQuery === 'first') {
        return new Promise<string>((resolve, reject) => {
          releaseFirst = () => context.signal.aborted
            ? reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            : resolve('first');
        });
      }
      return 'second';
    });
    const session = createAddressResolutionSession(executor);
    const first = session.resolveNow({ query: 'first' });
    const second = session.resolveNow({ query: 'second' });
    releaseFirst?.();

    await expect(second).resolves.toEqual(expect.objectContaining({ result: 'second', stale: false }));
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(session.getState()).toEqual(expect.objectContaining({ status: 'success' }));
  });

  test('passes caller abort through to the executor', async () => {
    const controller = new AbortController();
    const executor = vi.fn((_request, context) => new Promise((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {
        name: 'AbortError',
      })), { once: true });
    }));
    const session = createAddressResolutionSession(executor);
    const pending = session.resolveNow({ query: 'Kızılay' }, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(session.snapshot().aborts).toBeGreaterThanOrEqual(1);
  });

  test('scheduled work waits for the debounce boundary', async () => {
    vi.useFakeTimers();
    const executor = vi.fn(request => request.canonicalQuery);
    const session = createAddressResolutionSession(executor, { debounceMs: 100 });
    const pending = session.schedule({ query: 'Kızılay' });

    expect(session.getState().status).toBe('scheduled');
    expect(executor).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    await Promise.resolve();
    expect(executor).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await expect(pending).resolves.toEqual(expect.objectContaining({ result: 'kizilay' }));
    vi.useRealTimers();
  });

  test('a newer scheduled request rejects the older promise', async () => {
    vi.useFakeTimers();
    const executor = vi.fn(request => request.canonicalQuery);
    const session = createAddressResolutionSession(executor, { debounceMs: 100 });
    const first = session.schedule({ query: 'a' });
    const second = session.schedule({ query: 'ab' });

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    vi.advanceTimersByTime(100);
    await expect(second).resolves.toEqual(expect.objectContaining({ result: 'ab' }));
    expect(executor).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  test('caller abort rejects scheduled work before execution', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const executor = vi.fn(() => 'never');
    const session = createAddressResolutionSession(executor, { debounceMs: 100 });
    const pending = session.schedule({ query: 'Kızılay' }, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    vi.advanceTimersByTime(100);
    expect(executor).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  test('records bounded redacted history without storing the raw query', async () => {
    const session = createAddressResolutionSession(request => request.canonicalQuery, { historySize: 2 });
    await session.resolveNow({ query: 'private query one' });
    await session.resolveNow({ query: 'private query two' });
    await session.resolveNow({ query: 'private query three' });

    expect(session.getHistory()).toHaveLength(2);
    const serialized = JSON.stringify(session.getHistory());
    expect(serialized).not.toContain('private query');
    expect(serialized).toContain('fingerprint');
  });

  test('records sanitized error names but never error messages', async () => {
    const session = createAddressResolutionSession(() => {
      throw Object.assign(new Error('secret provider endpoint and query'), { name: 'ProviderFailure' });
    });

    await expect(session.resolveNow({ query: 'private query' })).rejects.toThrow('secret provider');
    expect(session.getState().errorName).toBe('ProviderFailure');
    expect(JSON.stringify(session.getHistory())).not.toContain('secret provider');
    expect(JSON.stringify(session.getHistory())).not.toContain('private query');
  });

  test('keeps successful history even when a later request fails', async () => {
    const session = createAddressResolutionSession(request => {
      if (request.canonicalQuery === 'fail') throw new Error('fail');
      return request.canonicalQuery;
    });
    await session.resolveNow({ query: 'ok' });
    await expect(session.resolveNow({ query: 'fail' })).rejects.toThrow('fail');

    expect(session.getHistory().map(entry => entry.status)).toEqual(['success', 'error']);
    expect(session.snapshot().failures).toBe(1);
  });

  test('bounds LRU cache entries', async () => {
    const session = createAddressResolutionSession(request => request.canonicalQuery, { cacheSize: 2 });
    await session.resolveNow({ query: 'a' });
    await session.resolveNow({ query: 'b' });
    await session.resolveNow({ query: 'c' });

    expect(session.snapshot().cacheEntries).toBe(2);
    await session.resolveNow({ query: 'a' });
    expect(session.snapshot().executions).toBe(4);
  });

  test('expires cached results according to bounded TTL', async () => {
    let now = 1_000;
    let calls = 0;
    const session = createAddressResolutionSession(() => ++calls, {
      cacheTtlMs: 100,
      clock: () => now,
    });
    await session.resolveNow({ query: 'Kızılay' });
    now = 1_050;
    expect((await session.resolveNow({ query: 'Kızılay' })).cacheHit).toBe(true);
    now = 1_101;
    expect((await session.resolveNow({ query: 'Kızılay' })).cacheHit).toBe(false);
    expect(calls).toBe(2);
  });

  test('invalidating one fingerprint removes only that cache entry', async () => {
    const session = createAddressResolutionSession(request => request.canonicalQuery);
    const a = await session.resolveNow({ query: 'a' });
    await session.resolveNow({ query: 'b' });
    expect(session.invalidate(a.fingerprint)).toBe(1);
    expect(session.snapshot().cacheEntries).toBe(1);
    expect(session.invalidate(a.fingerprint)).toBe(0);
  });

  test('invalidating without a fingerprint clears the bounded cache', async () => {
    const session = createAddressResolutionSession(request => request.canonicalQuery);
    await session.resolveNow({ query: 'a' });
    await session.resolveNow({ query: 'b' });
    expect(session.invalidate()).toBe(2);
    expect(session.snapshot().cacheEntries).toBe(0);
  });

  test('dispose aborts active work and prevents new scheduling', async () => {
    let rejectActive: ((reason?: unknown) => void) | undefined;
    const session = createAddressResolutionSession((_request, context) => new Promise((_resolve, reject) => {
      rejectActive = reject;
      context.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {
        name: 'AbortError',
      })), { once: true });
    }));
    const pending = session.resolveNow({ query: 'Kızılay' });
    session.dispose();
    rejectActive?.(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(() => session.schedule({ query: 'Ulus' })).toThrow('disposed');
    expect(session.snapshot().cacheEntries).toBe(0);
  });

  test('debounce zero executes scheduled work immediately', async () => {
    const executor = vi.fn(request => request.canonicalQuery);
    const session = createAddressResolutionSession(executor, { debounceMs: 0 });
    await expect(session.schedule({ query: 'Ulus' })).resolves.toEqual(expect.objectContaining({ result: 'ulus' }));
    expect(executor).toHaveBeenCalledTimes(1);
  });

  test('normalizes provider order so equivalent requests reuse the cache', async () => {
    const executor = vi.fn(request => request.providerIds.join(','));
    const session = createAddressResolutionSession(executor);
    const first = await session.resolveNow({ query: 'Kızılay', providerIds: ['z', 'a'] });
    const second = await session.resolveNow({ query: 'Kizilay', providerIds: ['a', 'z'] });

    expect(first.result).toBe('a,z');
    expect(second.cacheHit).toBe(true);
    expect(executor).toHaveBeenCalledTimes(1);
  });
});
