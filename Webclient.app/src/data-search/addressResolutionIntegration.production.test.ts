import {
  createAddressHierarchyRuntime,
  createAddressResolutionSession,
  executeForwardGeocodingConsensus,
  normalizeRecordCollection,
  rankAddressCandidatesByConfidence,
  type GeocodingConsensusProvider,
} from './index';

const localRecords = normalizeRecordCollection([
  {
    id: 'ank-1',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Atatürk Bulvarı',
    door: '18',
    building: 'Merkez Bina',
    latitude: 39.9208,
    longitude: 32.8541,
  },
  {
    id: 'ank-2',
    district: 'Altındağ',
    neighborhood: 'Ulus',
    street: 'Anafartalar Caddesi',
    door: '5',
    latitude: 39.941,
    longitude: 32.856,
  },
], { dedupe: false, keepInvalid: true }).records;

const payload = (label: string, score = 96) => ({
  candidates: [{
    address: label,
    score,
    location: { x: 32.8541, y: 39.9208 },
    attributes: {
      District: 'Çankaya',
      Neighborhood: 'Kızılay',
      Street: 'Atatürk Bulvarı',
      Building: 'Merkez Bina',
      AddNum: '18',
    },
  }],
});

const createProviders = (): readonly GeocodingConsensusProvider[] => [
  { id: 'primary', weight: 2, forward: () => payload('Atatürk Bulvarı 18, Kızılay') },
  { id: 'secondary', weight: 1, forward: () => payload('Ataturk Bulvari 18 Kizilay', 92) },
];

describe('address resolution production integration', () => {
  test('composes provider consensus, local hierarchy and confidence into one trusted result', async () => {
    const hierarchy = createAddressHierarchyRuntime(localRecords, { buildingFieldAliases: ['building'] });
    const providers = createProviders();
    const session = createAddressResolutionSession(async (request, context) => {
      const consensus = await executeForwardGeocodingConsensus(
        providers,
        { query: request.query, limit: request.limit },
        { minimumAgreementProviders: 2 },
        { signal: context.signal, providerIds: request.providerIds },
      );
      const confidence = rankAddressCandidatesByConfidence(
        consensus.candidates.map(item => item.representative),
        hierarchy,
      );
      return { consensus, confidence };
    }, { debounceMs: 0 });

    const envelope = await session.resolveNow({
      query: 'Atatürk Bulvarı 18',
      district: 'Çankaya',
      providerIds: ['primary', 'secondary'],
    });

    expect(envelope.stale).toBe(false);
    expect(envelope.result.consensus.candidates).toHaveLength(1);
    expect(envelope.result.consensus.candidates[0]?.providerCount).toBe(2);
    expect(envelope.result.confidence.trustedCount).toBe(1);
    expect(envelope.result.confidence.evaluations[0]?.hierarchyMatch?.node.level).toBe('door');
  });

  test('reuses the race-safe session cache for canonically equivalent Turkish queries', async () => {
    const hierarchy = createAddressHierarchyRuntime(localRecords, { buildingFieldAliases: ['building'] });
    const providers = createProviders();
    const executor = vi.fn(async (request, context) => {
      const consensus = await executeForwardGeocodingConsensus(
        providers,
        { query: request.query },
        {},
        { signal: context.signal },
      );
      return rankAddressCandidatesByConfidence(
        consensus.candidates.map(item => item.representative),
        hierarchy,
      );
    });
    const session = createAddressResolutionSession(executor);

    const first = await session.resolveNow({ query: 'Atatürk Bulvarı 18' });
    const second = await session.resolveNow({ query: 'Ataturk Bulvari 18' });

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  test('does not promote a one-provider outlier when agreement quorum requires two providers', async () => {
    const hierarchy = createAddressHierarchyRuntime(localRecords, { buildingFieldAliases: ['building'] });
    const providers: readonly GeocodingConsensusProvider[] = [
      ...createProviders(),
      {
        id: 'outlier',
        forward: () => ({
          candidates: [{
            address: 'Unrelated Remote Address',
            score: 100,
            location: { x: 35, y: 41 },
          }],
        }),
      },
    ];
    const consensus = await executeForwardGeocodingConsensus(
      providers,
      { query: 'Atatürk Bulvarı 18' },
      { minimumAgreementProviders: 2 },
    );
    const confidence = rankAddressCandidatesByConfidence(
      consensus.candidates.map(item => item.representative),
      hierarchy,
    );

    expect(consensus.candidates).toHaveLength(1);
    expect(consensus.candidates[0]?.label).toContain('Atatürk');
    expect(confidence.rejectedCount).toBe(0);
  });

  test('propagates session cancellation through consensus providers without stale success', async () => {
    let release: (() => void) | undefined;
    const slowProviders: readonly GeocodingConsensusProvider[] = [{
      id: 'slow',
      forward: (_request, context) => new Promise((resolve, reject) => {
        release = () => context.signal.aborted
          ? reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          : resolve(payload('Atatürk Bulvarı 18'));
      }),
    }];
    const session = createAddressResolutionSession(async (request, context) =>
      executeForwardGeocodingConsensus(
        slowProviders,
        { query: request.query },
        { providerTimeoutMs: 5_000 },
        { signal: context.signal },
      ));

    const first = session.resolveNow({ query: 'first address' });
    const second = session.resolveNow({ query: 'second address' });
    release?.();

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    release?.();
    await expect(second).resolves.toEqual(expect.objectContaining({ stale: false }));
    expect(session.getState().status).toBe('success');
  });

  test('keeps the whole composed boundary endpoint-free and transport-injected', () => {
    const source = [
      createAddressHierarchyRuntime.toString(),
      executeForwardGeocodingConsensus.toString(),
      createAddressResolutionSession.toString(),
      rankAddressCandidatesByConfidence.toString(),
    ].join('\n');
    const directTransportCall = ['fe', 'tch('].join('');

    expect(source).not.toMatch(/https?:\/\//i);
    expect(source).not.toContain(directTransportCall);
    expect(source).not.toContain('XMLHttpRequest');
    expect(source).not.toContain('WebSocket');
  });
});
