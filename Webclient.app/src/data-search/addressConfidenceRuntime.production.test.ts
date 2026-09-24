import type { GeocodeCandidate } from './contracts';
import { createAddressHierarchyRuntime } from './addressHierarchyRuntime';
import {
  evaluateAddressCandidateConfidence,
  extractAddressCandidateFields,
  rankAddressCandidatesByConfidence,
} from './addressConfidenceRuntime';
import { adaptGeocodingPayload } from './geocodingAdapter';
import { normalizeRecordCollection } from './normalization';

const hierarchy = () => createAddressHierarchyRuntime(normalizeRecordCollection([
  {
    id: '1',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    street: 'Atatürk Bulvarı',
    door: '18',
    building: 'Merkez Bina',
    latitude: 39.9208,
    longitude: 32.8541,
  },
  {
    id: '2',
    district: 'Çankaya',
    neighborhood: 'Bahçelievler',
    street: '7. Cadde',
    door: '10A',
    building: 'Park Apartmanı',
    latitude: 39.925,
    longitude: 32.82,
  },
  {
    id: '3',
    district: 'Altındağ',
    neighborhood: 'Ulus',
    street: 'Anafartalar Caddesi',
    door: '5',
    latitude: 39.941,
    longitude: 32.856,
  },
], { dedupe: false, keepInvalid: true }).records, {
  buildingFieldAliases: ['building'],
});

const candidate = (
  label: string,
  attributes: Readonly<Record<string, unknown>> = {},
  coordinates = { latitude: 39.9208, longitude: 32.8541 },
  score = 98,
): GeocodeCandidate => adaptGeocodingPayload({
  candidates: [{
    address: label,
    score,
    location: { x: coordinates.longitude, y: coordinates.latitude },
    attributes,
  }],
}).candidates[0] as GeocodeCandidate;

describe('address confidence runtime', () => {
  test('extracts hierarchy fields from verified provider attributes', () => {
    const fields = extractAddressCandidateFields(candidate('Adres', {
      ILCE: 'Çankaya',
      MAHALLE: 'Kızılay',
      Street: 'Atatürk Bulvarı',
      Building: 'Merkez Bina',
      AddNum: '18',
    }));

    expect(fields).toEqual({
      district: 'Çankaya',
      neighborhood: 'Kızılay',
      street: 'Atatürk Bulvarı',
      building: 'Merkez Bina',
      door: '18',
    });
  });

  test('trusts a high-provider-score candidate that agrees with the full hierarchy and coordinates', () => {
    const result = evaluateAddressCandidateConfidence(candidate('Atatürk Bulvarı 18', {
      District: 'Çankaya',
      Neighborhood: 'Kızılay',
      Street: 'Atatürk Bulvarı',
      Building: 'Merkez Bina',
      AddNum: '18',
    }), hierarchy());

    expect(result.status).toBe('trusted');
    expect(result.confidence).toBeGreaterThanOrEqual(80);
    expect(result.matchedFieldCount).toBe(5);
    expect(result.mismatchedFieldCount).toBe(0);
    expect(result.coordinateConflict).toBe(false);
    expect(result.hierarchyMatch?.node.level).toBe('door');
    expect(result.hierarchyPath.map(node => node.level)).toEqual([
      'district', 'neighborhood', 'street', 'building', 'door',
    ]);
  });

  test('canonical Turkish aliases do not reduce hierarchy confidence', () => {
    const result = evaluateAddressCandidateConfidence(candidate('Ataturk Bulvari 18', {
      ILCE: 'Cankaya',
      MAHALLE: 'Kizilay',
      Street: 'Ataturk Bulvari',
      Building: 'Merkez Bina',
      AddNum: '18',
    }), hierarchy());

    expect(result.mismatchedFieldCount).toBe(0);
    expect(result.hierarchyMatch).not.toBeNull();
    expect(result.status).toBe('trusted');
  });

  test('marks a candidate ambiguous when provider confidence is weaker but hierarchy remains consistent', () => {
    const result = evaluateAddressCandidateConfidence(candidate('Atatürk Bulvarı', {
      District: 'Çankaya',
      Neighborhood: 'Kızılay',
      Street: 'Atatürk Bulvarı',
    }, { latitude: 39.9208, longitude: 32.8541 }, 45), hierarchy(), {
      trustedThreshold: 90,
      ambiguousThreshold: 50,
    });

    expect(result.status).toBe('ambiguous');
    expect(result.hierarchyMatch?.node.level).toBe('street');
    expect(result.coordinateConflict).toBe(false);
  });

  test('rejects a far-away coordinate conflict even when the provider score is high', () => {
    const result = evaluateAddressCandidateConfidence(candidate('Atatürk Bulvarı 18', {
      District: 'Çankaya',
      Neighborhood: 'Kızılay',
      Street: 'Atatürk Bulvarı',
      Building: 'Merkez Bina',
      AddNum: '18',
    }, { latitude: 40.5, longitude: 33.5 }, 100), hierarchy(), {
      coordinateToleranceMeters: 50,
      maxCoordinateDistanceMeters: 1_000,
    });

    expect(result.coordinateConflict).toBe(true);
    expect(result.status).toBe('rejected');
    expect(result.reasons).toContain('coordinate-conflict');
  });

  test('reports hierarchy field mismatches instead of silently accepting a wrong locality', () => {
    const result = evaluateAddressCandidateConfidence(candidate('Atatürk Bulvarı 18', {
      District: 'Altındağ',
      Neighborhood: 'Ulus',
      Street: 'Atatürk Bulvarı',
      AddNum: '18',
    }), hierarchy());

    expect(result.mismatchedFieldCount).toBeGreaterThan(0);
    expect(result.status).not.toBe('trusted');
    expect(result.reasons.some(reason => reason.startsWith('field-mismatch:'))).toBe(true);
  });

  test('keeps provider-only candidates below trusted status by default', () => {
    const result = evaluateAddressCandidateConfidence(candidate('Unknown Address', {}, {
      latitude: 39.92,
      longitude: 32.85,
    }, 100), hierarchy());

    expect(result.hierarchyMatch).toBeNull();
    expect(result.status).not.toBe('trusted');
    expect(result.reasons).toContain('hierarchy-miss');
  });

  test('can explicitly allow provider-only trusted candidates through policy', () => {
    const result = evaluateAddressCandidateConfidence(candidate('Unknown Address', {}, {
      latitude: 39.92,
      longitude: 32.85,
    }, 100), hierarchy(), {
      requireHierarchyForTrusted: false,
      providerWeight: 1,
      hierarchyWeight: 0,
      fieldWeight: 0,
      coordinateWeight: 0,
      trustedThreshold: 90,
    });

    expect(result.confidence).toBe(100);
    expect(result.status).toBe('trusted');
  });

  test('uses hierarchy coordinates when a candidate has no coordinate', () => {
    const page = adaptGeocodingPayload({
      candidates: [{
        address: 'Atatürk Bulvarı',
        score: 90,
        attributes: {
          District: 'Çankaya',
          Neighborhood: 'Kızılay',
          Street: 'Atatürk Bulvarı',
        },
      }],
    });
    const result = evaluateAddressCandidateConfidence(page.candidates[0] as GeocodeCandidate, hierarchy());

    expect(result.hierarchyMatch).not.toBeNull();
    expect(result.distanceMeters).toBeNull();
    expect(result.coordinateScore).toBe(40);
    expect(result.coordinateConflict).toBe(false);
  });

  test('ranks trusted candidates ahead of ambiguous and rejected candidates', () => {
    const batch = rankAddressCandidatesByConfidence([
      candidate('Unknown', {}, { latitude: 40.7, longitude: 34 }, 10),
      candidate('Atatürk Bulvarı', {
        District: 'Çankaya', Neighborhood: 'Kızılay', Street: 'Atatürk Bulvarı',
      }, { latitude: 39.9208, longitude: 32.8541 }, 50),
      candidate('Atatürk Bulvarı 18', {
        District: 'Çankaya', Neighborhood: 'Kızılay', Street: 'Atatürk Bulvarı', AddNum: '18',
      }, { latitude: 39.9208, longitude: 32.8541 }, 100),
    ], hierarchy(), { trustedThreshold: 78, ambiguousThreshold: 40 });

    expect(batch.evaluations[0]?.status).toBe('trusted');
    expect(batch.evaluations.at(-1)?.status).toBe('rejected');
    expect(batch.trustedCount).toBe(1);
    expect(batch.rejectedCount).toBeGreaterThanOrEqual(1);
  });

  test('deduplicates candidates that resolve to the same hierarchy node', () => {
    const batch = rankAddressCandidatesByConfidence([
      candidate('Atatürk Bulvarı 18', {
        District: 'Çankaya', Neighborhood: 'Kızılay', Street: 'Atatürk Bulvarı', AddNum: '18',
      }, { latitude: 39.9208, longitude: 32.8541 }, 90),
      candidate('Ataturk Bulvari 18', {
        District: 'Cankaya', Neighborhood: 'Kizilay', Street: 'Ataturk Bulvari', AddNum: '18',
      }, { latitude: 39.9208, longitude: 32.8541 }, 99),
    ], hierarchy());

    expect(batch.evaluations).toHaveLength(1);
    expect(batch.evaluations[0]?.providerScore).toBe(99);
  });

  test('bounds candidate evaluation work', () => {
    const candidates = Array.from({ length: 20 }, (_, index) => candidate(
      `Unknown ${index}`,
      {},
      { latitude: 39.9 + index / 10_000, longitude: 32.8 },
      50,
    ));
    const batch = rankAddressCandidatesByConfidence(candidates, hierarchy(), { maxCandidates: 5 });

    expect(batch.truncated).toBe(true);
    expect(batch.evaluations.length).toBeLessThanOrEqual(5);
  });

  test('counts coordinate conflicts and hierarchy misses in bounded batch diagnostics', () => {
    const batch = rankAddressCandidatesByConfidence([
      candidate('Unknown', {}, { latitude: 39.9, longitude: 32.8 }, 90),
      candidate('Atatürk Bulvarı 18', {
        District: 'Çankaya', Neighborhood: 'Kızılay', Street: 'Atatürk Bulvarı', AddNum: '18',
      }, { latitude: 41, longitude: 35 }, 100),
    ], hierarchy(), {
      maxCoordinateDistanceMeters: 1_000,
    });

    expect(batch.hierarchyMissCount).toBe(1);
    expect(batch.coordinateConflictCount).toBe(1);
  });

  test('produces deterministic evaluation fingerprints', () => {
    const input = candidate('Atatürk Bulvarı 18', {
      District: 'Çankaya', Neighborhood: 'Kızılay', Street: 'Atatürk Bulvarı', AddNum: '18',
    });
    const runtime = hierarchy();
    const first = evaluateAddressCandidateConfidence(input, runtime);
    const second = evaluateAddressCandidateConfidence(input, runtime);

    expect(first.fingerprint).toBe(second.fingerprint);
  });

  test('produces deterministic batch fingerprints independent of duplicate candidate ordering', () => {
    const firstCandidate = candidate('Atatürk Bulvarı 18', {
      District: 'Çankaya', Neighborhood: 'Kızılay', Street: 'Atatürk Bulvarı', AddNum: '18',
    }, { latitude: 39.9208, longitude: 32.8541 }, 98);
    const secondCandidate = candidate('Ataturk Bulvari 18', {
      District: 'Cankaya', Neighborhood: 'Kizilay', Street: 'Ataturk Bulvari', AddNum: '18',
    }, { latitude: 39.9208, longitude: 32.8541 }, 95);
    const runtime = hierarchy();
    const first = rankAddressCandidatesByConfidence([firstCandidate, secondCandidate], runtime);
    const second = rankAddressCandidatesByConfidence([secondCandidate, firstCandidate], runtime);

    expect(first.evaluations[0]?.fingerprint).toBe(second.evaluations[0]?.fingerprint);
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  test('never copies provider labels or attributes into reason strings', () => {
    const secret = 'private-user-query-token-123';
    const result = evaluateAddressCandidateConfidence(candidate(secret, {
      District: secret,
    }, { latitude: 39.9, longitude: 32.8 }, 20), hierarchy());

    expect(JSON.stringify(result.reasons)).not.toContain(secret);
  });
});
