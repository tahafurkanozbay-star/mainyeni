import {
  SearchCursorError,
  applyCursorToSearchRequest,
  createCursorPage,
  createIntegrityRecordKey,
  createSearchCursor,
  createSemanticIdentityKey,
  cursorRequestFingerprint,
  decodeSearchCursor,
  detectDuplicateIds,
  detectEncodingAnomalies,
  detectSemanticDuplicates,
  encodeSearchCursor,
  evaluateDataIntegrity,
  normalizeIntegrityPolicy,
  normalizeRecordCollection,
  validateSearchCursor,
} from './index';

const normalizedFixture = () => normalizeRecordCollection([
  {
    id: '1',
    title: 'Hoşdere Parkı',
    category: 'Park',
    district: 'Çankaya',
    neighborhood: 'Ayrancı',
    street: 'Hoşdere Caddesi',
    latitude: 39.895,
    longitude: 32.847,
  },
  {
    id: '2',
    title: 'Kavaklıdere Parkı',
    category: 'Park',
    district: 'Çankaya',
    neighborhood: 'Kavaklıdere',
    street: 'Tunalı Hilmi Caddesi',
    latitude: 39.909,
    longitude: 32.861,
  },
]).records;

describe('data integrity quarantine', () => {
  test('uses stable id identity when available and fingerprint otherwise', () => {
    const records = normalizeRecordCollection([
      { id: '42', title: 'A' },
      { title: 'B' },
    ], { dedupe: false }).records;

    expect(createIntegrityRecordKey(records[0])).toBe('id:42');
    expect(createIntegrityRecordKey(records[1])).toMatch(/^fingerprint:/);
    expect(createSemanticIdentityKey(records[0])).toEqual(expect.any(String));
  });

  test('detects conflicting duplicate ids without silently deleting records', () => {
    const records = normalizeRecordCollection([
      { id: '1', title: 'A', district: 'Çankaya' },
      { id: '1', title: 'B', district: 'Mamak' },
      { id: '2', title: 'C' },
    ], { dedupe: false }).records;
    const groups = detectDuplicateIds(records);

    expect(records).toHaveLength(3);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual(expect.objectContaining({
      key: '1',
      kind: 'id',
      positions: [0, 1],
      conflicting: true,
    }));
  });

  test('detects canonical semantic duplicates independently from ids', () => {
    const records = normalizeRecordCollection([
      { id: '1', title: 'Park', category: 'Yeşil Alan', district: 'Çankaya' },
      { id: '2', title: 'PARK', category: 'yesil alan', district: 'CANKAYA' },
    ], { dedupe: false }).records;
    const groups = detectSemanticDuplicates(records);

    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('semantic');
    expect(groups[0].recordKeys).toEqual(['id:1', 'id:2']);
  });

  test('finds replacement, control and whitespace anomalies', () => {
    const records = normalizeRecordCollection([
      { id: 1, title: 'Bozuk\uFFFDisim', address: 'A\u0000B' },
      { id: 2, title: 'Normal', address: 'A        B' },
    ], { dedupe: false, keepInvalid: true }).records;
    const anomalies = detectEncodingAnomalies(records);

    expect(anomalies.map(item => item.code)).toEqual(expect.arrayContaining([
      'replacement-character',
      'null-byte',
      'excessive-whitespace',
    ]));
  });

  test('quarantines duplicate ids under the default policy', () => {
    const result = evaluateDataIntegrity([
      { id: 1, title: 'A' },
      { id: 1, title: 'B' },
      { id: 2, title: 'C' },
    ]);

    expect(result.quarantined).toHaveLength(2);
    expect(result.accepted).toHaveLength(1);
    expect(result.report.duplicateIdGroups).toHaveLength(1);
    expect(result.report.issueCounts['duplicate-id']).toBe(2);
    expect(result.report.releaseReady).toBe(false);
  });

  test('policy can preserve duplicates as accepted but keeps diagnostics visible', () => {
    const result = evaluateDataIntegrity([
      { id: 1, title: 'A' },
      { id: 1, title: 'B' },
    ], {
      policy: {
        quarantineDuplicateIds: false,
        maxErrorRatio: 1,
        maxQuarantineRatio: 1,
      },
    });

    expect(result.accepted).toHaveLength(2);
    expect(result.quarantined).toHaveLength(0);
    expect(result.report.issueCounts['duplicate-id']).toBe(2);
  });

  test('clamps unsafe policy ratios and detail limits', () => {
    expect(normalizeIntegrityPolicy({
      maxErrorRatio: 10,
      maxQuarantineRatio: -1,
      maxIssueDetails: -5,
    })).toEqual(expect.objectContaining({
      maxErrorRatio: 1,
      maxQuarantineRatio: 0,
      maxIssueDetails: 0,
    }));
  });
});

describe('revision-safe cursor pagination', () => {
  const context = {
    datasetKey: 'places',
    datasetRevision: 3,
    datasetFingerprint: 'dataset-fingerprint',
    querySignature: 'query-fingerprint',
    now: 1000,
    maxAgeMs: 10_000,
  };

  test('round-trips deterministic cursor payload', () => {
    const token = createSearchCursor(context, 50, 25);
    const decoded = decodeSearchCursor(token);

    expect(decoded).toEqual({
      version: 1,
      datasetKey: 'places',
      datasetRevision: 3,
      datasetFingerprint: 'dataset-fingerprint',
      querySignature: 'query-fingerprint',
      offset: 50,
      limit: 25,
      issuedAt: 1000,
    });
    expect(validateSearchCursor(decoded, context)).toBe(decoded);
    expect(encodeSearchCursor(decoded)).toBe(token);
  });

  test('rejects tampering using deterministic corruption checksum', () => {
    const token = createSearchCursor(context, 50, 25);
    const tampered = `${token.slice(0, -1)}${token.endsWith('x') ? 'y' : 'x'}`;

    expect(() => decodeSearchCursor(tampered)).toThrow(SearchCursorError);
  });

  test('rejects stale dataset revision and fingerprint', () => {
    const cursor = decodeSearchCursor(createSearchCursor(context, 50, 25));

    expect(() => validateSearchCursor(cursor, { ...context, datasetRevision: 4 }))
      .toThrow('stale dataset revision');
    expect(() => validateSearchCursor(cursor, { ...context, datasetFingerprint: 'changed' }))
      .toThrow('fingerprint is stale');
  });

  test('rejects cursor reuse for another query', () => {
    const cursor = decodeSearchCursor(createSearchCursor(context, 50, 25));

    expect(() => validateSearchCursor(cursor, { ...context, querySignature: 'other-query' }))
      .toThrow('different query');
  });

  test('rejects expired cursors', () => {
    const cursor = decodeSearchCursor(createSearchCursor(context, 50, 25));

    expect(() => validateSearchCursor(cursor, { ...context, now: 20_000, maxAgeMs: 100 }))
      .toThrow('expired');
  });

  test('applies cursor offset and limit without mutating query semantics', () => {
    const token = createSearchCursor(context, 75, 25);
    const request = { query: 'park', district: 'Çankaya', limit: 10, offset: 0 };
    const applied = applyCursorToSearchRequest(request, token, context);

    expect(applied).toEqual(expect.objectContaining({
      query: 'park',
      district: 'Çankaya',
      offset: 75,
      limit: 25,
    }));
    expect(request.offset).toBe(0);
  });

  test('creates next and previous cursors from a search response', () => {
    const records = normalizedFixture();
    const response = {
      results: [{ record: records[0], score: 10, distanceMeters: null, reasons: ['text'] }],
      page: {
        offset: 25,
        limit: 25,
        count: 1,
        total: 100,
        hasMore: true,
        nextOffset: 50,
      },
      facets: {},
      diagnostics: {
        datasetKey: 'places',
        revision: 3,
        totalRecords: 100,
        candidateCount: 20,
        scoredCount: 10,
        filteredCount: 10,
        cacheHit: false,
        elapsedMs: 2,
        querySignature: 'runtime-signature',
        quality: {
          inputCount: 100,
          outputCount: 100,
          duplicateCount: 0,
          invalidCount: 0,
          missingIdCount: 0,
          invalidCoordinateCount: 0,
          issues: [],
        },
      },
    };
    const page = createCursorPage(response, context);

    expect(page.cursor).toEqual(expect.any(String));
    expect(page.previousCursor).toEqual(expect.any(String));
    expect(decodeSearchCursor(page.cursor).offset).toBe(50);
    expect(decodeSearchCursor(page.previousCursor).offset).toBe(0);
  });

  test('query fingerprint intentionally ignores pagination position', () => {
    const first = cursorRequestFingerprint('places', 3, {
      query: 'park',
      offset: 0,
      limit: 25,
      district: 'Çankaya',
    });
    const next = cursorRequestFingerprint('places', 3, {
      query: 'park',
      offset: 50,
      limit: 100,
      district: 'Çankaya',
    });

    expect(first).toBe(next);
  });
});
