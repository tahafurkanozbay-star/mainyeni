import type { GeocodeCandidate } from './contracts';
import {
  createAddressHierarchyRuntime,
  createAddressResolutionSession,
  executeForwardGeocodingConsensus,
  executeReverseGeocodingConsensus,
  normalizeAddressResolutionRequest,
  normalizeRecordCollection,
  rankAddressCandidatesByConfidence,
  type GeocodingConsensusProvider,
} from './index';

const hierarchyRecords = normalizeRecordCollection([
  {
    id: 'cankaya-18',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Atatürk Bulvarı',
    building: 'Merkez Bina',
    door: '18',
    latitude: 39.9208,
    longitude: 32.8541,
  },
  {
    id: 'cankaya-20',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Atatürk Bulvarı',
    building: 'Merkez Bina',
    door: '20',
    latitude: 39.9209,
    longitude: 32.8542,
  },
  {
    id: 'altindag-5',
    district: 'Altındağ',
    neighborhood: 'Ulus',
    street: 'Anafartalar Caddesi',
    building: 'Tarihi Bina',
    door: '5',
    latitude: 39.9410,
    longitude: 32.8560,
  },
], { dedupe: false, keepInvalid: true }).records;

const hierarchy = () => createAddressHierarchyRuntime(hierarchyRecords, {
  buildingFieldAliases: ['building'],
});

const forwardPayload = (
  label: string,
  score = 95,
  longitude = 32.8541,
  latitude = 39.9208,
  attributes: Readonly<Record<string, unknown>> = {
    District: 'Çankaya',
    Neighborhood: 'Kızılay',
    Street: 'Atatürk Bulvarı',
    Building: 'Merkez Bina',
    AddNum: '18',
  },
) => ({
  candidates: [{ address: label, score, location: { x: longitude, y: latitude }, attributes }],
});

const provider = (
  id: string,
  label = 'Atatürk Bulvarı 18, Kızılay',
  score = 95,
): GeocodingConsensusProvider => ({
  id,
  forward: () => forwardPayload(label, score),
});

const candidateFromConsensus = async (
  providers: readonly GeocodingConsensusProvider[] = [provider('a'), provider('b')],
): Promise<GeocodeCandidate> => {
  const result = await executeForwardGeocodingConsensus(
    providers,
    { query: 'Atatürk Bulvarı 18' },
    { minimumAgreementProviders: Math.min(2, providers.length) },
  );
  const candidate = result.candidates[0]?.representative;
  if (!candidate) throw new Error('fixture consensus candidate missing');
  return candidate;
};

describe('address resolution adversarial regression matrix', () => {
  test('canonical request identity ignores Turkish diacritics but keeps hierarchy filters', () => {
    const first = normalizeAddressResolutionRequest({
      query: 'Atatürk Bulvarı 18',
      district: 'Çankaya',
      neighborhood: 'Kızılay',
      street: 'Atatürk Bulvarı',
    });
    const second = normalizeAddressResolutionRequest({
      query: 'Ataturk Bulvari 18',
      district: 'Cankaya',
      neighborhood: 'Kizilay',
      street: 'Ataturk Bulvari',
    });

    expect(second.fingerprint).toBe(first.fingerprint);
  });

  test('request identity changes when a hierarchy constraint changes', () => {
    const first = normalizeAddressResolutionRequest({ query: 'Merkez', district: 'Çankaya' });
    const second = normalizeAddressResolutionRequest({ query: 'Merkez', district: 'Altındağ' });
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  test('request identity normalizes provider set ordering and duplicates', () => {
    const first = normalizeAddressResolutionRequest({ query: 'Kızılay', providerIds: ['z', 'a', 'z'] });
    const second = normalizeAddressResolutionRequest({ query: 'Kizilay', providerIds: ['a', 'z'] });
    expect(first.providerIds).toEqual(['a', 'z']);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  test('request identity retains page limit semantics', () => {
    const first = normalizeAddressResolutionRequest({ query: 'Kızılay', limit: 5 });
    const second = normalizeAddressResolutionRequest({ query: 'Kızılay', limit: 10 });
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  test('consensus collapses canonical-equivalent Turkish labels', async () => {
    const result = await executeForwardGeocodingConsensus([
      provider('a', 'Atatürk Bulvarı 18, Kızılay'),
      provider('b', 'Ataturk Bulvari 18 Kizilay'),
      provider('c', 'ATATÜRK BULVARI 18 KIZILAY'),
    ], { query: 'Atatürk Bulvarı 18' }, { minimumAgreementProviders: 3 });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.providerCount).toBe(3);
    expect(result.candidates[0]?.agreementScore).toBe(100);
  });

  test('consensus does not let duplicate rows from one provider fake quorum', async () => {
    const noisy: GeocodingConsensusProvider = {
      id: 'noisy',
      forward: () => ({
        candidates: Array.from({ length: 10 }, (_, index) => ({
          address: 'Atatürk Bulvarı 18',
          score: 100 - index,
          location: { x: 32.8541, y: 39.9208 },
        })),
      }),
    };
    const result = await executeForwardGeocodingConsensus([
      noisy,
      provider('peer'),
    ], { query: 'Atatürk Bulvarı 18' }, { minimumAgreementProviders: 2 });

    expect(result.candidates[0]?.providerCount).toBe(2);
    expect(result.candidates[0]?.evidence).toHaveLength(2);
  });

  test('consensus keeps distinct addresses separate even when provider scores are equal', async () => {
    const result = await executeForwardGeocodingConsensus([
      provider('a', 'Atatürk Bulvarı 18'),
      provider('b', 'Anafartalar Caddesi 5'),
    ], { query: 'adres' });

    expect(result.candidates).toHaveLength(2);
    expect(new Set(result.candidates.map(item => item.canonicalLabel)).size).toBe(2);
  });

  test('provider errors are represented only by redacted failure metadata', async () => {
    const result = await executeForwardGeocodingConsensus([
      provider('ok'),
      {
        id: 'private',
        forward: () => { throw new Error('sensitive-address https://internal.invalid/token'); },
      },
    ], { query: 'sensitive-address' }, { allowPartial: true });

    const diagnostics = JSON.stringify(result.diagnostics);
    expect(diagnostics).toContain('provider-error');
    expect(diagnostics).not.toContain('sensitive-address');
    expect(diagnostics).not.toContain('internal.invalid');
  });

  test('minimum successful provider quorum fails closed', async () => {
    await expect(executeForwardGeocodingConsensus([
      provider('ok'),
      { id: 'broken', forward: () => { throw new Error('boom'); } },
    ], { query: 'Kızılay' }, { minimumSuccessfulProviders: 2 }))
      .rejects.toThrow('requires 2 successful provider');
  });

  test('strict partial policy fails closed when one provider fails', async () => {
    await expect(executeForwardGeocodingConsensus([
      provider('ok'),
      { id: 'broken', forward: () => { throw new Error('boom'); } },
    ], { query: 'Kızılay' }, { allowPartial: false }))
      .rejects.toThrow('rejected partial');
  });

  test('coordinate divergence lowers consensus coordinate score', async () => {
    const result = await executeForwardGeocodingConsensus([
      { id: 'near', forward: () => forwardPayload('Atatürk Bulvarı 18', 99, 32.8541, 39.9208) },
      { id: 'far', forward: () => forwardPayload('Atatürk Bulvarı 18', 99, 34.5, 41.0) },
    ], { query: 'Atatürk Bulvarı 18' }, { coordinateToleranceMeters: 100 });

    expect(result.candidates[0]?.coordinateConflict).toBe(true);
    expect(result.candidates[0]?.coordinateScore).toBeLessThan(50);
  });

  test('confidence trusts a consensus candidate consistent with local hierarchy', async () => {
    const batch = rankAddressCandidatesByConfidence([await candidateFromConsensus()], hierarchy());
    expect(batch.trustedCount).toBe(1);
    expect(batch.evaluations[0]?.status).toBe('trusted');
    expect(batch.evaluations[0]?.mismatchedFieldCount).toBe(0);
  });

  test('confidence rejects a geographically remote high-score candidate', async () => {
    const remote = await candidateFromConsensus([
      {
        id: 'remote',
        forward: () => forwardPayload('Atatürk Bulvarı 18', 100, 35.5, 42.0),
      },
    ]);
    const batch = rankAddressCandidatesByConfidence([remote], hierarchy(), {
      maxCoordinateDistanceMeters: 1_000,
    });

    expect(batch.rejectedCount).toBe(1);
    expect(batch.coordinateConflictCount).toBe(1);
  });

  test('confidence does not trust a wrong district merely because provider score is high', async () => {
    const wrong = await candidateFromConsensus([
      {
        id: 'wrong',
        forward: () => forwardPayload('Atatürk Bulvarı 18', 100, 32.8541, 39.9208, {
          District: 'Altındağ',
          Neighborhood: 'Ulus',
          Street: 'Atatürk Bulvarı',
          AddNum: '18',
        }),
      },
    ]);
    const batch = rankAddressCandidatesByConfidence([wrong], hierarchy());

    expect(batch.evaluations[0]?.status).not.toBe('trusted');
    expect(batch.evaluations[0]?.mismatchedFieldCount).toBeGreaterThan(0);
  });

  test('confidence result ordering is stable for equal provider scores', async () => {
    const first = await candidateFromConsensus([provider('one', 'Atatürk Bulvarı 18')]);
    const second = await candidateFromConsensus([provider('two', 'Anafartalar Caddesi 5')]);
    const runtime = hierarchy();
    const a = rankAddressCandidatesByConfidence([first, second], runtime);
    const b = rankAddressCandidatesByConfidence([second, first], runtime);

    expect(a.evaluations.map(item => item.fingerprint)).toEqual(b.evaluations.map(item => item.fingerprint));
  });

  test('session LRU promotion keeps a recently-read entry', async () => {
    let executions = 0;
    const session = createAddressResolutionSession(request => ({ query: request.canonicalQuery, executions: ++executions }), {
      cacheSize: 2,
    });
    await session.resolveNow({ query: 'a' });
    await session.resolveNow({ query: 'b' });
    expect((await session.resolveNow({ query: 'a' })).cacheHit).toBe(true);
    await session.resolveNow({ query: 'c' });
    expect((await session.resolveNow({ query: 'a' })).cacheHit).toBe(true);
    expect((await session.resolveNow({ query: 'b' })).cacheHit).toBe(false);
  });

  test('session TTL prunes multiple expired entries before adding a fresh result', async () => {
    let now = 1_000;
    const session = createAddressResolutionSession(request => request.canonicalQuery, {
      cacheSize: 10,
      cacheTtlMs: 10,
      clock: () => now,
    });
    await session.resolveNow({ query: 'a' });
    await session.resolveNow({ query: 'b' });
    await session.resolveNow({ query: 'c' });
    expect(session.snapshot().cacheEntries).toBe(3);
    now = 1_020;
    await session.resolveNow({ query: 'd' });
    expect(session.snapshot().cacheEntries).toBe(1);
  });

  test('session never persists raw query text in history', async () => {
    const secret = 'citizen-private-address-987';
    const session = createAddressResolutionSession(request => request.canonicalQuery);
    await session.resolveNow({ query: secret });
    const history = JSON.stringify(session.getHistory());

    expect(history).not.toContain(secret);
    expect(history).toContain('fingerprint');
  });

  test('session never persists provider error messages in history', async () => {
    const session = createAddressResolutionSession(() => {
      throw Object.assign(new Error('private provider payload'), { name: 'ProviderError' });
    });
    await expect(session.resolveNow({ query: 'Kızılay' })).rejects.toThrow('private provider payload');
    const history = JSON.stringify(session.getHistory());

    expect(history).toContain('ProviderError');
    expect(history).not.toContain('private provider payload');
  });

  test('session supersession aborts stale work and retains the latest success', async () => {
    const releases = new Map<string, () => void>();
    const session = createAddressResolutionSession((request, context) => new Promise<string>((resolve, reject) => {
      releases.set(request.canonicalQuery, () => context.signal.aborted
        ? reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        : resolve(request.canonicalQuery));
    }));
    const first = session.resolveNow({ query: 'first' });
    const second = session.resolveNow({ query: 'second' });
    releases.get('first')?.();
    releases.get('second')?.();

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).resolves.toEqual(expect.objectContaining({ result: 'second', stale: false }));
    expect(session.getState().status).toBe('success');
  });

  test('session caller cancellation is reflected as AbortError, not a generic failure', async () => {
    const controller = new AbortController();
    const session = createAddressResolutionSession((_request, context) => new Promise((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }));
    const pending = session.resolveNow({ query: 'Kızılay' }, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(session.getState().status).toBe('aborted');
    expect(session.snapshot().failures).toBe(0);
  });

  test('history remains bounded across mixed success and failure outcomes', async () => {
    const session = createAddressResolutionSession(request => {
      if (request.canonicalQuery.includes('fail')) throw new Error('failed');
      return request.canonicalQuery;
    }, { historySize: 3 });
    await session.resolveNow({ query: 'one' });
    await expect(session.resolveNow({ query: 'fail-one' })).rejects.toThrow();
    await session.resolveNow({ query: 'two' });
    await expect(session.resolveNow({ query: 'fail-two' })).rejects.toThrow();

    expect(session.getHistory()).toHaveLength(3);
    expect(session.getHistory().map(item => item.status)).toEqual(['error', 'success', 'error']);
  });

  test('reverse consensus preserves normalized coordinates across providers', async () => {
    const reverseProvider = (id: string): GeocodingConsensusProvider => ({
      id,
      reverse: request => ({
        address: { Match_addr: 'Kızılay' },
        location: { x: request.coordinates.longitude, y: request.coordinates.latitude },
      }),
    });
    const result = await executeReverseGeocodingConsensus([
      reverseProvider('a'),
      reverseProvider('b'),
    ], { coordinates: [32.8541, 39.9208] }, { minimumAgreementProviders: 2 });

    expect(result.candidates[0]?.coordinates).toEqual({ latitude: 39.9208, longitude: 32.8541 });
    expect(result.candidates[0]?.providerCount).toBe(2);
  });

  test('reverse consensus fails closed on invalid provider result quorum', async () => {
    await expect(executeReverseGeocodingConsensus([
      { id: 'empty-a', reverse: () => ({ candidates: [] }) },
      { id: 'empty-b', reverse: () => ({ candidates: [] }) },
    ], { coordinates: [32.8541, 39.9208] }, { minimumSuccessfulProviders: 1 }))
      .rejects.toThrow('requires 1 successful provider');
  });

  test('provider selection remains explicit when a subset is requested', async () => {
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

  test('provider budget applies after priority sorting', async () => {
    const low = vi.fn(() => forwardPayload('low'));
    const high = vi.fn(() => forwardPayload('high'));
    const result = await executeForwardGeocodingConsensus([
      { id: 'low', priority: 1, forward: low },
      { id: 'high', priority: 100, forward: high },
    ], { query: 'x' }, { maxProviders: 1 });

    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
    expect(result.candidates[0]?.label).toBe('high');
  });

  test('bounded evidence prevents noisy providers from growing diagnostics without limit', async () => {
    const noisy: GeocodingConsensusProvider = {
      id: 'noisy',
      forward: () => ({
        candidates: Array.from({ length: 100 }, (_, index) => ({
          address: `candidate-${index}`,
          score: 90,
          location: { x: 32.8 + index / 100_000, y: 39.9 },
        })),
      }),
    };
    const result = await executeForwardGeocodingConsensus([noisy], { query: 'candidate' }, {
      maxCandidatesPerProvider: 100,
      maxEvidenceItems: 12,
      maxConsensusCandidates: 100,
    });

    expect(result.diagnostics.evidenceTruncated).toBe(true);
    expect(result.candidates.reduce((sum, item) => sum + item.evidence.length, 0)).toBe(12);
  });

  test('bounded final output truncates deterministic low-ranked candidates', async () => {
    const noisy: GeocodingConsensusProvider = {
      id: 'noisy',
      forward: () => ({
        candidates: Array.from({ length: 20 }, (_, index) => ({
          address: `result-${index}`,
          score: 100 - index,
          location: { x: 32.85, y: 39.92 },
        })),
      }),
    };
    const result = await executeForwardGeocodingConsensus([noisy], { query: 'result' }, {
      maxCandidatesPerProvider: 20,
      maxConsensusCandidates: 5,
    });

    expect(result.candidates).toHaveLength(5);
    expect(result.diagnostics.candidateTruncated).toBe(true);
    expect(result.candidates.map(item => item.representative.score)).toEqual([100, 99, 98, 97, 96]);
  });

  test('composed hierarchy and session fingerprints remain deterministic across reruns', async () => {
    const runtime = hierarchy();
    const session = createAddressResolutionSession(async request => {
      const consensus = await executeForwardGeocodingConsensus([
        provider('a'),
        provider('b'),
      ], { query: request.query }, { minimumAgreementProviders: 2 });
      return rankAddressCandidatesByConfidence(consensus.candidates.map(item => item.representative), runtime);
    });
    const first = await session.resolveNow({ query: 'Atatürk Bulvarı 18' });
    const second = await session.resolveNow({ query: 'Ataturk Bulvari 18' }, { bypassCache: true });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.result.fingerprint).toBe(second.result.fingerprint);
  });
});
