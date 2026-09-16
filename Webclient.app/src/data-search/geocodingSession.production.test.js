import {
  createGeocodingRuntime,
  createSearchSession,
  createStaticGeocodingProvider,
} from './index';

const geocodePayload = label => ({
  candidates: [
    {
      address: label,
      score: 98,
      location: { x: 32.85, y: 39.92 },
      attributes: { City: 'Ankara' },
    },
  ],
});

describe('provider-neutral geocoding runtime', () => {
  test('requires injected providers and never invents a network endpoint', async () => {
    const runtime = createGeocodingRuntime();
    await expect(runtime.forward({ query: 'Kızılay' })).rejects.toThrow('No geocoding provider');
    expect(runtime.snapshot().providerCount).toBe(0);
  });

  test('selects explicit provider and adapts its payload', async () => {
    const runtime = createGeocodingRuntime();
    runtime.register({
      id: 'local-a',
      priority: 1,
      forward: request => geocodePayload(`A:${request.query}`),
    });
    runtime.register({
      id: 'local-b',
      priority: 10,
      forward: request => geocodePayload(`B:${request.query}`),
    });

    const automatic = await runtime.forward({ query: 'Kızılay' });
    const explicit = await runtime.forward({ query: 'Kızılay' }, { providerId: 'local-a', bypassCache: true });

    expect(automatic.providerId).toBe('local-b');
    expect(automatic.page.candidates[0].label).toBe('B:Kızılay');
    expect(explicit.providerId).toBe('local-a');
    expect(explicit.page.candidates[0].coordinates).toEqual({ latitude: 39.92, longitude: 32.85 });
  });

  test('caches normalized requests and exposes cache hits', async () => {
    const forward = jest.fn(request => geocodePayload(request.query));
    const runtime = createGeocodingRuntime({ cacheTtlMs: 10_000 });
    runtime.register({ id: 'local', forward });

    const first = await runtime.forward({ query: '  Kızılay  ', limit: 5 });
    const second = await runtime.forward({ query: 'Kızılay', limit: 5 });

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot()).toEqual(expect.objectContaining({ cacheHits: 1, cacheMisses: 1 }));
  });

  test('deduplicates concurrent identical requests', async () => {
    let resolveProvider;
    const forward = jest.fn(() => new Promise(resolve => { resolveProvider = resolve; }));
    const runtime = createGeocodingRuntime();
    runtime.register({ id: 'local', forward });

    const first = runtime.forward({ query: 'Ulus' });
    const second = runtime.forward({ query: 'Ulus' });
    expect(forward).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot().deduplicated).toBe(1);

    resolveProvider(geocodePayload('Ulus'));
    const [a, b] = await Promise.all([first, second]);
    expect(a.page.candidates[0].label).toBe('Ulus');
    expect(b.page.candidates[0].label).toBe('Ulus');
  });

  test('one cancelled subscriber does not cancel another subscriber', async () => {
    let resolveProvider;
    const runtime = createGeocodingRuntime();
    runtime.register({
      id: 'local',
      forward: () => new Promise(resolve => { resolveProvider = resolve; }),
    });
    const controller = new AbortController();
    const cancelled = runtime.forward({ query: 'Bahçelievler' }, { signal: controller.signal });
    const survivor = runtime.forward({ query: 'Bahçelievler' });

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    resolveProvider(geocodePayload('Bahçelievler'));
    await expect(survivor).resolves.toEqual(expect.objectContaining({ providerId: 'local' }));
  });

  test('normalizes reverse coordinates before provider invocation', async () => {
    const reverse = jest.fn(request => ({
      address: { Match_addr: `${request.coordinates.latitude},${request.coordinates.longitude}` },
      location: { x: request.coordinates.longitude, y: request.coordinates.latitude },
    }));
    const runtime = createGeocodingRuntime();
    runtime.register({ id: 'reverse-local', reverse });

    const result = await runtime.reverse({ coordinates: [32.85, 39.92] });
    expect(reverse).toHaveBeenCalledWith(
      expect.objectContaining({ coordinates: { latitude: 39.92, longitude: 32.85 } }),
      expect.objectContaining({ operation: 'reverse', providerId: 'reverse-local' }),
    );
    expect(result.page.candidates[0].coordinates).toEqual({ latitude: 39.92, longitude: 32.85 });
  });

  test('static provider wrapper remains local and deterministic', async () => {
    const provider = createStaticGeocodingProvider('fixture', {
      forward: request => geocodePayload(request.query),
    });
    const runtime = createGeocodingRuntime();
    runtime.register(provider);

    await expect(runtime.forward({ query: 'Anıtkabir' })).resolves.toEqual(
      expect.objectContaining({ providerId: 'fixture' }),
    );
  });
});

describe('race-safe search session', () => {
  const response = (query, offset = 0, hasMore = false) => ({
    results: [{ record: { id: query }, score: 1, distanceMeters: null, reasons: ['text'] }],
    page: {
      offset,
      limit: 1,
      count: 1,
      total: hasMore ? 2 : 1,
      hasMore,
      nextOffset: hasMore ? offset + 1 : null,
    },
    facets: {},
    diagnostics: {
      datasetKey: 'places',
      revision: 1,
      totalRecords: 2,
      candidateCount: 2,
      scoredCount: 1,
      filteredCount: 0,
      cacheHit: false,
      elapsedMs: 1,
      querySignature: query,
      quality: {
        inputCount: 2,
        outputCount: 2,
        duplicateCount: 0,
        invalidCount: 0,
        missingIdCount: 0,
        invalidCoordinateCount: 0,
        issues: [],
      },
    },
  });

  test('executes immediate search and exposes state', async () => {
    const executor = jest.fn((_dataset, request) => response(request.query));
    const session = createSearchSession(executor, { debounceMs: 0 });

    const envelope = await session.searchNow('places', { query: 'park' });
    expect(envelope.stale).toBe(false);
    expect(envelope.result.results).toHaveLength(1);
    expect(session.getState()).toEqual(expect.objectContaining({ status: 'success', datasetKey: 'places' }));
    expect(session.getHistory()[0].status).toBe('success');
  });

  test('new immediate search aborts an active superseded request', async () => {
    let releaseFirst;
    const executor = jest.fn((_dataset, request) => {
      if (request.query === 'first') {
        return new Promise((resolve, reject) => {
          releaseFirst = () => request.signal.aborted
            ? reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            : resolve(response('first'));
        });
      }
      return response('second');
    });
    const session = createSearchSession(executor);
    const first = session.searchNow('places', { query: 'first' });
    const second = session.searchNow('places', { query: 'second' });
    releaseFirst();

    await expect(second).resolves.toEqual(expect.objectContaining({ stale: false }));
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(session.getState().request.query).toBe('second');
  });

  test('scheduled search debounces and executes only after the delay', async () => {
    jest.useFakeTimers();
    const executor = jest.fn((_dataset, request) => response(request.query));
    const session = createSearchSession(executor, { debounceMs: 100 });
    const scheduled = session.schedule('places', { query: 'park' });

    expect(executor).not.toHaveBeenCalled();
    jest.advanceTimersByTime(99);
    await Promise.resolve();
    expect(executor).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await expect(scheduled).resolves.toEqual(expect.objectContaining({ stale: false }));
    expect(executor).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  test('superseding a scheduled request rejects the old promise', async () => {
    jest.useFakeTimers();
    const executor = jest.fn((_dataset, request) => response(request.query));
    const session = createSearchSession(executor, { debounceMs: 100 });
    const first = session.schedule('places', { query: 'a' });
    const second = session.schedule('places', { query: 'ab' });

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    jest.advanceTimersByTime(100);
    await expect(second).resolves.toEqual(expect.objectContaining({ stale: false }));
    expect(executor).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  test('loadMore advances using previous nextOffset', async () => {
    const executor = jest.fn((_dataset, request) => response(request.query, Number(request.offset) || 0, !request.offset));
    const session = createSearchSession(executor);
    await session.searchNow('places', { query: 'park', limit: 1 });
    const next = await session.loadMore();

    expect(next.request.offset).toBe(1);
    expect(executor).toHaveBeenLastCalledWith('places', expect.objectContaining({ offset: 1 }));
  });

  test('dispose aborts resources and rejects future searches', async () => {
    const session = createSearchSession((_dataset, request) => response(request.query));
    session.dispose();

    expect(session.getState().status).toBe('disposed');
    expect(() => session.searchNow('places', { query: 'x' })).toThrow('disposed');
  });
});
