import {
  executeForwardGeocodingConsensus,
  executeReverseGeocodingConsensus,
  type GeocodingConsensusProvider,
} from './geocodingConsensusRuntime';

const forwardPayload = (
  label: string,
  score = 90,
  longitude = 32.8541,
  latitude = 39.9208,
) => ({
  candidates: [{
    address: label,
    score,
    location: { x: longitude, y: latitude },
  }],
});

const provider = (
  id: string,
  label: string,
  options: Partial<GeocodingConsensusProvider> = {},
): GeocodingConsensusProvider => ({
  id,
  forward: () => forwardPayload(label),
  ...options,
});

const waitForMicrotaskCondition = async (
  predicate: () => boolean,
  message: string,
): Promise<void> => {
  for (let turn = 0; turn < 40; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(message);
};

describe('geocoding consensus runtime', () => {
  test('merges equivalent canonical labels across independent providers', async () => {
    const result = await executeForwardGeocodingConsensus([
      provider('a', 'Atatürk Bulvarı 18, Kızılay'),
      provider('b', 'Ataturk Bulvari 18 Kizilay'),
    ], { query: 'Atatürk Bulvarı 18' });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.providerIds).toEqual(['a', 'b']);
    expect(result.candidates[0]?.agreementCount).toBe(2);
    expect(result.candidates[0]?.confidence).toBeGreaterThan(80);
    expect(result.diagnostics.successfulProviders).toBe(2);
  });

  test('uses provider weight when selecting a representative candidate', async () => {
    const result = await executeForwardGeocodingConsensus([
      provider('low', 'Kızılay', {
        weight: 0.5,
        forward: () => forwardPayload('Kızılay', 100),
      }),
      provider('high', 'Kızılay', {
        weight: 3,
        forward: () => forwardPayload('Kızılay', 80),
      }),
    ], { query: 'Kızılay' });

    expect(result.candidates[0]?.representative.score).toBe(80);
    expect(result.candidates[0]?.weightedProviderScore).toBeGreaterThan(80);
  });

  test('keeps a provider from contributing more than one evidence item per canonical candidate', async () => {
    const noisy: GeocodingConsensusProvider = {
      id: 'noisy',
      forward: () => ({
        candidates: [
          { address: 'Kızılay', score: 70, location: { x: 32.85, y: 39.92 } },
          { address: 'Kızılay', score: 95, location: { x: 32.85, y: 39.92 } },
        ],
      }),
    };
    const result = await executeForwardGeocodingConsensus([
      noisy,
      provider('peer', 'Kızılay'),
    ], { query: 'Kızılay' });

    expect(result.candidates[0]?.evidence).toHaveLength(2);
    expect(result.candidates[0]?.providerIds).toEqual(['noisy', 'peer']);
    expect(result.candidates[0]?.evidence.find(item => item.providerId === 'noisy')?.candidate.score).toBe(95);
  });

  test('reports coordinate divergence instead of silently collapsing conflicting locations', async () => {
    const result = await executeForwardGeocodingConsensus([
      provider('near', 'Cumhuriyet Meydanı', {
        forward: () => forwardPayload('Cumhuriyet Meydanı', 95, 32.85, 39.92),
      }),
      provider('far', 'Cumhuriyet Meydanı', {
        forward: () => forwardPayload('Cumhuriyet Meydanı', 95, 33.2, 40.1),
      }),
    ], { query: 'Cumhuriyet Meydanı' }, { coordinateToleranceMeters: 100 });

    expect(result.candidates[0]?.coordinateConflict).toBe(true);
    expect(result.candidates[0]?.coordinateSpreadMeters).toBeGreaterThan(100);
    expect(result.candidates[0]?.coordinateScore).toBeLessThan(60);
  });

  test('supports partial success with bounded timeout diagnostics', async () => {
    const never: GeocodingConsensusProvider = {
      id: 'slow',
      timeoutMs: 20,
      forward: () => new Promise(() => {}),
    };
    const result = await executeForwardGeocodingConsensus([
      provider('fast', 'Ulus'),
      never,
    ], { query: 'Ulus' }, {
      providerTimeoutMs: 25,
      minimumSuccessfulProviders: 1,
      allowPartial: true,
    });

    expect(result.partial).toBe(true);
    expect(result.diagnostics.successfulProviders).toBe(1);
    expect(result.diagnostics.timedOutProviders).toBe(1);
    expect(result.diagnostics.failures).toEqual([
      expect.objectContaining({ providerId: 'slow', kind: 'timeout' }),
    ]);
  });

  test('can reject partial provider results when strict consensus is requested', async () => {
    await expect(executeForwardGeocodingConsensus([
      provider('ok', 'Ulus'),
      { id: 'broken', forward: () => { throw new Error('secret upstream body'); } },
    ], { query: 'Ulus' }, {
      minimumSuccessfulProviders: 1,
      allowPartial: false,
    })).rejects.toThrow('rejected partial');
  });

  test('fails closed when the minimum successful provider quorum is not met', async () => {
    await expect(executeForwardGeocodingConsensus([
      provider('ok', 'Ulus'),
      { id: 'broken', forward: () => { throw new Error('boom'); } },
    ], { query: 'Ulus' }, {
      minimumSuccessfulProviders: 2,
    })).rejects.toThrow('requires 2 successful provider');
  });

  test('fails closed when minimum agreement cannot be reached', async () => {
    const result = await executeForwardGeocodingConsensus([
      provider('a', 'Kızılay'),
      provider('b', 'Ulus'),
    ], { query: 'merkez' }, {
      minimumAgreementProviders: 2,
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.diagnostics.inputCandidates).toBe(2);
  });

  test('bounds concurrent provider execution', async () => {
    let active = 0;
    let peak = 0;
    let released = 0;
    const resolvers: Array<() => void> = [];
    const providers: GeocodingConsensusProvider[] = Array.from({ length: 5 }, (_, index) => ({
      id: `p-${index}`,
      forward: () => new Promise(resolve => {
        active += 1;
        peak = Math.max(peak, active);
        resolvers.push(() => {
          active -= 1;
          resolve(forwardPayload('Kızılay'));
        });
      }),
    }));

    const pending = executeForwardGeocodingConsensus(providers, { query: 'Kızılay' }, {
      maxConcurrentProviders: 2,
      providerTimeoutMs: 5_000,
    });
    await waitForMicrotaskCondition(
      () => resolvers.length === 2,
      'expected the first two bounded consensus providers to start',
    );
    expect(peak).toBe(2);

    while (released < providers.length) {
      await waitForMicrotaskCondition(
        () => resolvers.length > 0,
        'expected another bounded consensus provider to start',
      );
      const current = resolvers.splice(0, Math.min(2, providers.length - released));
      released += current.length;
      current.forEach(resolve => resolve());
    }

    await pending;
    expect(peak).toBeLessThanOrEqual(2);
  });

  test('aborts the whole consensus request through the caller signal', async () => {
    const controller = new AbortController();
    const providers: GeocodingConsensusProvider[] = [{
      id: 'slow',
      forward: (_request, context) => new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {
          name: 'AbortError',
        })), { once: true });
      }),
    }];

    const pending = executeForwardGeocodingConsensus(
      providers,
      { query: 'Kızılay' },
      { providerTimeoutMs: 5_000 },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('filters execution to explicitly requested provider ids', async () => {
    const a = vi.fn(() => forwardPayload('A'));
    const b = vi.fn(() => forwardPayload('B'));
    const result = await executeForwardGeocodingConsensus([
      { id: 'a', forward: a },
      { id: 'b', forward: b },
    ], { query: 'x' }, {}, { providerIds: ['b'] });

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(result.candidates[0]?.label).toBe('B');
  });

  test('does not report unsupported providers as eligible providers', async () => {
    const reverseOnly: GeocodingConsensusProvider = {
      id: 'reverse-only',
      reverse: () => ({ address: { Match_addr: 'Kızılay' }, location: { x: 32.85, y: 39.92 } }),
    };
    const result = await executeForwardGeocodingConsensus([
      reverseOnly,
      provider('forward', 'Kızılay'),
    ], { query: 'Kızılay' });

    expect(result.diagnostics.eligibleProviders).toBe(1);
    expect(result.diagnostics.successfulProviders).toBe(1);
  });

  test('adapts reverse-geocoding payloads through the same consensus boundary', async () => {
    const reverse = (id: string, label: string): GeocodingConsensusProvider => ({
      id,
      reverse: request => ({
        address: { Match_addr: label },
        location: {
          x: request.coordinates.longitude,
          y: request.coordinates.latitude,
        },
      }),
    });
    const result = await executeReverseGeocodingConsensus([
      reverse('a', 'Kızılay'),
      reverse('b', 'Kızılay'),
    ], { coordinates: { latitude: 39.92, longitude: 32.85 } });

    expect(result.operation).toBe('reverse');
    expect(result.candidates[0]?.providerCount).toBe(2);
    expect(result.candidates[0]?.coordinates).toEqual({ latitude: 39.92, longitude: 32.85 });
  });

  test('keeps provider failures redacted to provider id and failure kind', async () => {
    const result = await executeForwardGeocodingConsensus([
      provider('ok', 'Kızılay'),
      {
        id: 'private-provider',
        forward: () => { throw new Error('https://secret.example/token?q=sensitive'); },
      },
    ], { query: 'sensitive user query' }, {
      allowPartial: true,
    });

    expect(result.diagnostics.failures).toEqual([
      { providerId: 'private-provider', kind: 'provider-error' },
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain('secret.example');
    expect(JSON.stringify(result.diagnostics)).not.toContain('sensitive user query');
  });

  test('bounds evidence growth under noisy providers', async () => {
    const many = (prefix: string) => ({
      candidates: Array.from({ length: 20 }, (_, index) => ({
        address: `${prefix}-${index}`,
        score: 80,
        location: { x: 32.85 + index / 10_000, y: 39.92 },
      })),
    });
    const result = await executeForwardGeocodingConsensus([
      { id: 'a', forward: () => many('a') },
      { id: 'b', forward: () => many('b') },
    ], { query: 'x' }, {
      maxCandidatesPerProvider: 20,
      maxEvidenceItems: 7,
      maxConsensusCandidates: 100,
    });

    expect(result.diagnostics.evidenceTruncated).toBe(true);
    expect(result.candidates.reduce((sum, candidate) => sum + candidate.evidence.length, 0)).toBe(7);
  });

  test('bounds final candidate output and reports truncation', async () => {
    const payload = {
      candidates: Array.from({ length: 10 }, (_, index) => ({
        address: `Result ${index}`,
        score: 100 - index,
        location: { x: 32.85, y: 39.92 },
      })),
    };
    const result = await executeForwardGeocodingConsensus([
      { id: 'a', forward: () => payload },
    ], { query: 'result' }, {
      maxConsensusCandidates: 3,
      maxCandidatesPerProvider: 10,
    });

    expect(result.candidates).toHaveLength(3);
    expect(result.diagnostics.candidateTruncated).toBe(true);
  });

  test('limits provider count before execution', async () => {
    const calls = Array.from({ length: 6 }, () => vi.fn(() => forwardPayload('Kızılay')));
    const providers = calls.map((forward, index) => ({ id: `p-${index}`, forward }));
    const result = await executeForwardGeocodingConsensus(providers, { query: 'Kızılay' }, {
      maxProviders: 3,
    });

    expect(result.diagnostics.requestedProviders).toBe(3);
    expect(calls.reduce((sum, call) => sum + call.mock.calls.length, 0)).toBe(3);
  });

  test('uses deterministic priority ordering when provider budget is smaller than input', async () => {
    const selected = vi.fn(() => forwardPayload('selected'));
    const ignored = vi.fn(() => forwardPayload('ignored'));
    const result = await executeForwardGeocodingConsensus([
      { id: 'low', priority: 1, forward: ignored },
      { id: 'high', priority: 100, forward: selected },
    ], { query: 'x' }, { maxProviders: 1 });

    expect(selected).toHaveBeenCalledTimes(1);
    expect(ignored).not.toHaveBeenCalled();
    expect(result.candidates[0]?.label).toBe('selected');
  });

  test('produces stable fingerprints for equivalent deterministic provider results', async () => {
    const providers = [
      provider('a', 'Kızılay'),
      provider('b', 'Kızılay'),
    ];
    const first = await executeForwardGeocodingConsensus(providers, { query: 'Kızılay' });
    const second = await executeForwardGeocodingConsensus(providers, { query: 'Kızılay' });

    expect(second.requestFingerprint).toBe(first.requestFingerprint);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.candidates[0]?.fingerprint).toBe(first.candidates[0]?.fingerprint);
  });

  test('keeps operation request fingerprint provider-order stable after priority sorting', async () => {
    const a = provider('a', 'Kızılay', { priority: 10 });
    const b = provider('b', 'Kızılay', { priority: 5 });
    const first = await executeForwardGeocodingConsensus([a, b], { query: 'Kızılay' });
    const second = await executeForwardGeocodingConsensus([b, a], { query: 'Kızılay' });

    expect(first.requestFingerprint).toBe(second.requestFingerprint);
  });

  test('rejects a forward operation when no injected provider supports it', async () => {
    await expect(executeForwardGeocodingConsensus([
      { id: 'reverse-only', reverse: () => ({}) },
    ], { query: 'Kızılay' })).rejects.toThrow('No geocoding consensus provider');
  });
});
