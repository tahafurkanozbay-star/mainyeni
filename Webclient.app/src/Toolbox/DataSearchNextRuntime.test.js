import {
    DataSearchRuntime,
    adaptGeocodingPayload,
    analyzeAddressQuery,
    buildCandidateIndex,
    buildSpatialIndex,
    candidateIndexDiagnostics,
    canonicalizeAddressText,
    classifyAddressToken,
    collectSpatialCandidatePositions,
    createAddressSuggestions,
    createPageInfo,
    createSpatialBounds,
    evaluateAddressEvidence,
    geocodeCandidateToRecordSource,
    geocodingPayloadDiagnostics,
    hashFingerprint,
    haversineDistanceMeters,
    isProjectedCoordinateCandidate,
    matchesFilter,
    mergeGeocodePages,
    nearest,
    normalizeCategoryKey,
    normalizeCoordinates,
    normalizeId,
    normalizeRecord,
    normalizeRecordCollection,
    normalizeSearchRequest,
    normalizeSearchText,
    normalizeText,
    normalizeUrl,
    parseAddressNumberToken,
    planCandidates,
    scoreAddressRecord,
    searchRadius,
    spatialIndexDiagnostics,
    tokenizeSearchText,
    validateCandidatePlan,
    validateSpatialIndex
} from './DataSearchNextRuntime';

const fixtures = [
    {
        OBJECTID: 0,
        ADI: 'Hoşdere Caddesi 10',
        KATEGORI: 'Belediye Hizmeti',
        TUR: 'Adres',
        ADRES: 'Hoşdere Caddesi No:10 Ayrancı Çankaya',
        ILCE_ADI: 'Çankaya',
        MAHALLE_ADI: 'Ayrancı',
        YOL_ADI: 'Hoşdere Caddesi',
        KAPI_NO: '10',
        POSTA_KODU: '06540',
        Y: 39.895,
        X: 32.847,
        level: 'door'
    },
    {
        OBJECTID: 1,
        ADI: 'Hoşdere Caddesi 12/A',
        KATEGORI: 'Belediye Hizmeti',
        TUR: 'Adres',
        ADRES: 'Hoşdere Caddesi No:12/A Ayrancı Çankaya',
        ILCE_ADI: 'Çankaya',
        MAHALLE_ADI: 'Ayrancı',
        YOL_ADI: 'Hoşdere Caddesi',
        KAPI_NO: '12A',
        POSTA_KODU: '06540',
        Y: 39.8952,
        X: 32.8472,
        level: 'door'
    },
    {
        OBJECTID: 2,
        ADI: 'Tunalı Hilmi Caddesi',
        KATEGORI: 'Cadde',
        TUR: 'Yol',
        ADRES: 'Tunalı Hilmi Caddesi Kavaklıdere Çankaya',
        ILCE_ADI: 'Çankaya',
        MAHALLE_ADI: 'Kavaklıdere',
        YOL_ADI: 'Tunalı Hilmi Caddesi',
        Y: 39.907,
        X: 32.862,
        level: 'street'
    },
    {
        OBJECTID: 3,
        ADI: 'Abidinpaşa Mahallesi',
        KATEGORI: 'Mahalle',
        TUR: 'İdari Birim',
        ADRES: 'Abidinpaşa Mamak Ankara',
        ILCE_ADI: 'Mamak',
        MAHALLE_ADI: 'Abidinpaşa',
        Y: 39.925,
        X: 32.91,
        level: 'neighborhood'
    },
    {
        OBJECTID: 4,
        ADI: '100. Yıl Bulvarı',
        KATEGORI: 'Bulvar',
        TUR: 'Yol',
        ADRES: '100. Yıl Bulvarı Çankaya',
        ILCE_ADI: 'Çankaya',
        MAHALLE_ADI: 'Balgat',
        YOL_ADI: '100. Yıl Bulvarı',
        Y: 39.905,
        X: 32.817,
        level: 'street'
    }
];

const normalizedFixtures = () => normalizeRecordCollection(fixtures).records;

describe('typed normalization contracts', () => {
    test('normalizes Turkish Unicode search text and deterministic category keys', () => {
        expect(normalizeSearchText('  İSTANBUL   Çığ  ')).toBe('istanbul cig');
        expect(normalizeCategoryKey('Açık / Yeşil Alan')).toBe('acik-yesil-alan');
        expect(tokenizeSearchText('Çankaya ÇANKAYA Hoşdere')).toEqual(['cankaya', 'hosdere']);
    });

    test('preserves numeric zero ids and reads ArcGIS aliases', () => {
        const record = normalizeRecord(fixtures[0], 0);
        expect(record).not.toBeNull();
        expect(record.id).toBe('0');
        expect(record.title).toBe('Hoşdere Caddesi 10');
        expect(record.district).toBe('Çankaya');
        expect(record.neighborhood).toBe('Ayrancı');
        expect(record.street).toBe('Hoşdere Caddesi');
        expect(record.door).toBe('10');
        expect(record.coordinates).toEqual({ latitude: 39.895, longitude: 32.847 });
    });

    test('normalizes nested attributes without mutating source', () => {
        const source = {
            attributes: {
                OBJECTID: 0,
                ADI: 'Çankaya Belediyesi',
                ILCE_ADI: 'Çankaya',
                Y: 39.92,
                X: 32.85
            }
        };
        const before = JSON.stringify(source);
        const record = normalizeRecord(source, 0);
        expect(record.id).toBe('0');
        expect(record.title).toBe('Çankaya Belediyesi');
        expect(record.coordinates).toEqual({ latitude: 39.92, longitude: 32.85 });
        expect(JSON.stringify(source)).toBe(before);
    });

    test('handles schema drift through custom aliases', () => {
        const result = normalizeRecord({
            primary_key: 'x-1',
            label_tr: 'Gençlik Merkezi',
            district_name: 'Keçiören'
        }, 0, {
            id: ['primary_key'],
            title: ['label_tr'],
            district: ['district_name']
        });
        expect(result.id).toBe('x-1');
        expect(result.title).toBe('Gençlik Merkezi');
        expect(result.district).toBe('Keçiören');
    });

    test('deduplicates deterministic records and reports data quality', () => {
        const result = normalizeRecordCollection([fixtures[0], fixtures[0], null, fixtures[1]]);
        expect(result.records).toHaveLength(2);
        expect(result.quality.inputCount).toBe(4);
        expect(result.quality.duplicateCount).toBe(1);
        expect(result.quality.invalidCount).toBe(1);
        expect(result.quality.issues.some(issue => issue.code === 'duplicate-record')).toBe(true);
        expect(result.quality.issues.some(issue => issue.code === 'record-not-object')).toBe(true);
    });

    test('detects malformed coordinates instead of accepting impossible values', () => {
        const result = normalizeRecordCollection([
            { id: 1, title: 'bad', latitude: 120, longitude: 220 },
            { id: 2, title: 'ok', latitude: 39.92, longitude: 32.85 }
        ]);
        expect(result.records[0].coordinates).toBeNull();
        expect(result.records[1].coordinates).toEqual({ latitude: 39.92, longitude: 32.85 });
        expect(result.quality.invalidCoordinateCount).toBe(1);
    });

    test('normalizes coordinates from array and object forms', () => {
        expect(normalizeCoordinates([32.85, 39.92])).toEqual({ latitude: 39.92, longitude: 32.85 });
        expect(normalizeCoordinates({ lat: 39.92, lng: 32.85 })).toEqual({ latitude: 39.92, longitude: 32.85 });
        expect(normalizeCoordinates({ y: 39.92, x: 32.85 })).toEqual({ latitude: 39.92, longitude: 32.85 });
        expect(normalizeCoordinates({ lat: 'bad', lng: 32.85 })).toBeNull();
    });

    test('normalizes ids, URL protocols and control characters safely', () => {
        expect(normalizeId(0)).toBe('0');
        expect(normalizeId(Number.NaN)).toBeNull();
        expect(normalizeText('A\u0000B\nC')).toBe('A B C');
        expect(normalizeUrl('javascript:alert(1)')).toBe('');
        expect(normalizeUrl('/Common/FileService.svc')).toBe('/Common/FileService.svc');
        expect(normalizeUrl('https://example.com/x?q=1')).toContain('https://example.com/x');
    });

    test('creates stable fingerprints independent of object key order', () => {
        expect(hashFingerprint({ a: 1, b: 2 })).toBe(hashFingerprint({ b: 2, a: 1 }));
        expect(hashFingerprint({ a: 1, b: 2 })).not.toBe(hashFingerprint({ a: 1, b: 3 }));
    });

    test('pagination never emits a non-progressing next offset', () => {
        expect(createPageInfo(10, 20, 0, 100)).toEqual(expect.objectContaining({
            hasMore: false,
            nextOffset: null
        }));
        expect(createPageInfo(10, 20, 20, 100)).toEqual(expect.objectContaining({
            hasMore: true,
            nextOffset: 30
        }));
    });
});

describe('Turkish address query semantics', () => {
    test('canonicalizes common address aliases and diacritics', () => {
        expect(canonicalizeAddressText('Hoşdere Cd.')).toBe('hosdere cadde');
        expect(canonicalizeAddressText('Tunalı Hilmi Caddesi')).toBe('tunali hilmi cadde');
        expect(canonicalizeAddressText('Ayrancı Mh')).toBe('ayranci mahalle');
        expect(classifyAddressToken('cadde')).toBe('structural');
        expect(classifyAddressToken('06540')).toBe('postal-code');
        expect(classifyAddressToken('12a')).toBe('number');
    });

    test('parses door numbers deterministically', () => {
        expect(parseAddressNumberToken('12A')).toEqual(expect.objectContaining({ number: 12, suffix: 'a' }));
        expect(parseAddressNumberToken('10')).toEqual(expect.objectContaining({ number: 10, suffix: '' }));
        expect(parseAddressNumberToken('12/A')).toBeNull();
    });

    test('infers road and door intent while preserving strong terms', () => {
        const street = analyzeAddressQuery('Hoşdere Caddesi');
        expect(street.inferredLevel).toBe('street');
        expect(street.strongTokens).toContain('hosdere');
        expect(street.roadTokens).toContain('cadde');
        expect(street.weakOnly).toBe(false);

        const door = analyzeAddressQuery('Hoşdere Caddesi 10');
        expect(door.inferredLevel).toBe('door');
        expect(door.numericTokens).toContain('10');
        expect(door.hasDoorHint).toBe(true);
    });

    test('does not treat road designator alone as strong evidence for multi-token query', () => {
        const records = normalizedFixtures();
        const tunali = records.find(record => record.id === '2');
        const result = scoreAddressRecord(tunali, analyzeAddressQuery('Hoşdere Cadde'));
        expect(result.matchedStrongCount).toBe(0);
        expect(result.eligible).toBe(false);
        expect(result.score).toBe(0);
    });

    test('requires numeric evidence when query contains door number', () => {
        const records = normalizedFixtures();
        const door10 = records.find(record => record.id === '0');
        const door12 = records.find(record => record.id === '1');
        const query = analyzeAddressQuery('Hoşdere 10');
        expect(evaluateAddressEvidence(door10, query).numericSatisfied).toBe(true);
        expect(evaluateAddressEvidence(door12, query).numericSatisfied).toBe(false);
        expect(scoreAddressRecord(door10, query).score).toBeGreaterThan(0);
        expect(scoreAddressRecord(door12, query).score).toBe(0);
    });

    test('scores exact Turkish address above partial alternatives', () => {
        const records = normalizedFixtures();
        const door10 = records.find(record => record.id === '0');
        const exact = scoreAddressRecord(door10, 'Hoşdere Caddesi 10 Ayrancı Çankaya');
        const partial = scoreAddressRecord(door10, 'Hoşdere');
        expect(exact.score).toBeGreaterThan(partial.score);
    });

    test('builds useful suggestions without duplicate rows', () => {
        const suggestions = createAddressSuggestions(normalizedFixtures(), 'hosdere', 10);
        expect(suggestions.length).toBeGreaterThan(0);
        expect(new Set(suggestions.map(item => item.text)).size).toBe(suggestions.length);
        expect(suggestions.some(item => item.text.includes('Hoşdere'))).toBe(true);
    });
});

describe('candidate planner', () => {
    const records = normalizedFixtures();
    const index = buildCandidateIndex(records);

    test('builds bounded exact and prefix postings', () => {
        const diagnostics = candidateIndexDiagnostics(index);
        expect(diagnostics.recordCount).toBe(records.length);
        expect(diagnostics.tokenCount).toBeGreaterThan(0);
        expect(diagnostics.prefixCount).toBeGreaterThan(0);
        expect(diagnostics.largestTokenPosting).toBeLessThanOrEqual(records.length);
    });

    test('intersects strong address token postings', () => {
        const analysis = analyzeAddressQuery('Hoşdere 10');
        const plan = planCandidates(index, { address: analysis });
        expect(plan.strategy).toBe('intersection');
        expect(plan.candidatePositions).toEqual([0]);
        expect(validateCandidatePlan(plan, records.length)).toEqual([]);
    });

    test('uses prefix postings without scanning whole dataset', () => {
        const plan = planCandidates(index, { query: 'hosd' });
        expect(plan.candidatePositions).toEqual(expect.arrayContaining([0, 1]));
        expect(plan.candidatePositions.length).toBeLessThan(records.length);
    });

    test('returns all positions for an intentionally empty query', () => {
        const plan = planCandidates(index, { query: '' });
        expect(plan.strategy).toBe('all');
        expect(plan.candidatePositions).toHaveLength(records.length);
    });

    test('honors already aborted requests', () => {
        const controller = new AbortController();
        controller.abort();
        expect(() => planCandidates(index, { query: 'hosdere', signal: controller.signal }))
            .toThrow(expect.objectContaining({ name: 'AbortError' }));
    });
});

describe('spatial index', () => {
    const records = normalizedFixtures();
    const index = buildSpatialIndex(records, { cellSizeMeters: 250 });

    test('indexes only valid geocoded records', () => {
        expect(index.geocodedCount).toBe(records.length);
        expect(index.skippedCount).toBe(0);
        expect(index.buckets.size).toBeGreaterThan(0);
        expect(validateSpatialIndex(index)).toEqual([]);
    });

    test('computes haversine distance in realistic range', () => {
        const distance = haversineDistanceMeters(
            { latitude: 39.895, longitude: 32.847 },
            { latitude: 39.905, longitude: 32.847 }
        );
        expect(distance).toBeGreaterThan(1000);
        expect(distance).toBeLessThan(1200);
    });

    test('creates bounded radius candidates and exact distance results', () => {
        const center = { latitude: 39.895, longitude: 32.847 };
        const bounds = createSpatialBounds(center, 200);
        const candidates = collectSpatialCandidatePositions(index, bounds);
        expect(candidates.positions).toEqual(expect.arrayContaining([0, 1]));
        const page = searchRadius(index, center, { radiusMeters: 200, limit: 10 });
        expect(page.items.map(item => item.record.id)).toEqual(expect.arrayContaining(['0', '1']));
        expect(page.items.some(item => item.record.id === '2')).toBe(false);
    });

    test('nearest results are sorted by exact distance', () => {
        const hits = nearest(index, { latitude: 39.895, longitude: 32.847 }, { limit: 3 });
        expect(hits[0].record.id).toBe('0');
        for (let indexValue = 1; indexValue < hits.length; indexValue += 1) {
            expect(hits[indexValue].distanceMeters).toBeGreaterThanOrEqual(hits[indexValue - 1].distanceMeters);
        }
    });

    test('diagnostics remain bounded and explain bucket shape', () => {
        const diagnostics = spatialIndexDiagnostics(index);
        expect(diagnostics.recordCount).toBe(records.length);
        expect(diagnostics.geocodedCount).toBe(records.length);
        expect(diagnostics.bucketCount).toBeGreaterThan(0);
        expect(diagnostics.largestBucket).toBeGreaterThan(0);
    });
});

describe('geocoding adapter', () => {
    test('adapts ArcGIS candidate payload and preserves zero id', () => {
        const page = adaptGeocodingPayload({
            candidates: [
                {
                    address: 'Hoşdere Caddesi 10',
                    score: 99,
                    location: { x: 32.847, y: 39.895 },
                    attributes: { OBJECTID: 0, Match_addr: 'Hoşdere Caddesi 10' }
                }
            ]
        });
        expect(page.candidates).toHaveLength(1);
        expect(page.candidates[0].id).toBe('0');
        expect(page.candidates[0].coordinates).toEqual({ latitude: 39.895, longitude: 32.847 });
        expect(page.candidates[0].sourceKind).toBe('arcgis-candidate');
    });

    test('adapts ArcGIS feature sets and generic rows', () => {
        const features = adaptGeocodingPayload({
            features: [
                {
                    attributes: { OBJECTID: 7, ADI: 'Kızılay' },
                    geometry: { x: 32.854, y: 39.92 }
                }
            ]
        });
        expect(features.candidates[0].id).toBe('7');
        expect(features.candidates[0].label).toBe('Kızılay');

        const generic = adaptGeocodingPayload([
            { id: 8, title: 'Ulus', lat: 39.941, lng: 32.854 }
        ]);
        expect(generic.candidates[0].label).toBe('Ulus');
    });

    test('adapts reverse geocode response', () => {
        const page = adaptGeocodingPayload({
            address: {
                Match_addr: 'Ayrancı, Çankaya, Ankara',
                LongLabel: 'Ayrancı, Çankaya, Ankara, Türkiye'
            },
            location: { x: 32.846, y: 39.893 }
        });
        expect(page.candidates).toHaveLength(1);
        expect(page.candidates[0].label).toContain('Ayrancı');
        expect(page.candidates[0].score).toBe(100);
    });

    test('deduplicates identical candidate records', () => {
        const candidate = {
            address: 'Hoşdere Caddesi 10',
            score: 99,
            location: { x: 32.847, y: 39.895 },
            attributes: { OBJECTID: 0 }
        };
        const page = adaptGeocodingPayload({ candidates: [candidate, candidate] });
        expect(page.candidates).toHaveLength(1);
        expect(page.diagnostics.duplicateCount).toBe(1);
    });

    test('transfer limit never produces next offset when page made no progress', () => {
        const page = adaptGeocodingPayload({ candidates: [], exceededTransferLimit: true }, { offset: 100, limit: 50 });
        expect(page.page.hasMore).toBe(false);
        expect(page.page.nextOffset).toBeNull();
    });

    test('flags projected coordinates but never guesses reprojection', () => {
        const payload = {
            candidates: [
                { address: 'Projected', score: 90, location: { x: 3650000, y: 4970000 } }
            ]
        };
        const page = adaptGeocodingPayload(payload);
        expect(page.candidates[0].coordinates).toBeNull();
        expect(page.diagnostics.invalidCoordinateCount).toBe(1);
        expect(isProjectedCoordinateCandidate({ x: 3650000, y: 4970000 })).toBe(true);
        expect(geocodingPayloadDiagnostics(payload).projectedCoordinateCount).toBe(1);
    });

    test('merges pages deterministically and emits record source without network behavior', () => {
        const first = adaptGeocodingPayload([
            { id: 1, title: 'A', lat: 39.9, lng: 32.8 },
            { id: 2, title: 'B', lat: 39.91, lng: 32.81 }
        ]);
        const second = adaptGeocodingPayload([
            { id: 2, title: 'B', lat: 39.91, lng: 32.81 },
            { id: 3, title: 'C', lat: 39.92, lng: 32.82 }
        ]);
        const merged = mergeGeocodePages([first, second]);
        expect(merged.map(item => item.id)).toEqual(['1', '2', '3']);
        expect(geocodeCandidateToRecordSource(merged[0])).toEqual(expect.objectContaining({
            id: '1', title: 'A', latitude: 39.9, longitude: 32.8
        }));
    });
});

describe('DataSearchRuntime end-to-end', () => {
    test('registers, normalizes, indexes and searches a dataset', () => {
        const runtime = new DataSearchRuntime({ cacheSize: 8 });
        const snapshot = runtime.register('Adresler', fixtures);
        expect(snapshot.key).toBe('adresler');
        expect(snapshot.revision).toBe(1);
        expect(snapshot.records).toHaveLength(fixtures.length);
        expect(snapshot.candidateIndex.tokenCount).toBeGreaterThan(0);
        expect(snapshot.spatialIndex.geocodedCount).toBe(fixtures.length);

        const response = runtime.search('Adresler', { query: 'Hoşdere' });
        expect(response.results.length).toBeGreaterThan(0);
        expect(response.results[0].record.street).toContain('Hoşdere');
        expect(response.diagnostics.datasetKey).toBe('adresler');
        expect(response.diagnostics.cacheHit).toBe(false);
    });

    test('uses cache only for non-cancellable requests', () => {
        const runtime = new DataSearchRuntime({ cacheSize: 4 });
        runtime.register('x', fixtures);
        const first = runtime.search('x', { query: 'Hoşdere' });
        const second = runtime.search('x', { query: 'Hoşdere' });
        expect(first.diagnostics.cacheHit).toBe(false);
        expect(second.diagnostics.cacheHit).toBe(true);

        const controller = new AbortController();
        const cancellable = runtime.search('x', { query: 'Hoşdere', signal: controller.signal });
        expect(cancellable.diagnostics.cacheHit).toBe(false);
    });

    test('invalidates result cache when dataset revision changes', () => {
        const runtime = new DataSearchRuntime();
        runtime.register('x', fixtures);
        runtime.search('x', { query: 'Hoşdere' });
        expect(runtime.search('x', { query: 'Hoşdere' }).diagnostics.cacheHit).toBe(true);
        const next = runtime.register('x', [...fixtures, {
            id: 99,
            title: 'Hoşdere Ek Kayıt',
            street: 'Hoşdere Caddesi',
            district: 'Çankaya'
        }]);
        expect(next.revision).toBe(2);
        expect(runtime.search('x', { query: 'Hoşdere' }).diagnostics.cacheHit).toBe(false);
    });

    test('supports hierarchy, filter and facets in a single request', () => {
        const runtime = new DataSearchRuntime();
        runtime.register('x', fixtures);
        const response = runtime.search('x', {
            query: 'Hoşdere',
            district: 'Çankaya',
            filters: [
                { field: 'categoryKey', operator: 'eq', values: ['belediye-hizmeti'] }
            ],
            facetFields: ['district', 'category']
        });
        expect(response.results).toHaveLength(2);
        expect(response.results.every(item => item.record.district === 'Çankaya')).toBe(true);
        expect(response.facets.district).toEqual([
            { value: 'Çankaya', count: 2 }
        ]);
    });

    test('supports numeric filters without locale coercion', () => {
        const record = normalizedFixtures()[0];
        expect(matchesFilter(record, { field: 'sourceIndex', operator: 'gte', values: [0] })).toBe(true);
        expect(matchesFilter(record, { field: 'sourceIndex', operator: 'between', values: [0, 0] })).toBe(true);
        expect(matchesFilter(record, { field: 'sourceIndex', operator: 'lte', values: [-1] })).toBe(false);
    });

    test('combines text search and exact radius filtering', () => {
        const runtime = new DataSearchRuntime();
        runtime.register('x', fixtures);
        const response = runtime.search('x', {
            query: 'Hoşdere',
            center: { latitude: 39.895, longitude: 32.847 },
            radiusMeters: 250,
            sort: 'distance'
        });
        expect(response.results.map(item => item.record.id)).toEqual(expect.arrayContaining(['0', '1']));
        expect(response.results.some(item => item.record.id === '2')).toBe(false);
        expect(response.results[0].distanceMeters).toBe(0);
    });

    test('paginates deterministically with progress-safe metadata', () => {
        const runtime = new DataSearchRuntime();
        runtime.register('x', fixtures);
        const first = runtime.search('x', { query: '', limit: 2, offset: 0, sort: 'source-order' });
        expect(first.results).toHaveLength(2);
        expect(first.page.hasMore).toBe(true);
        expect(first.page.nextOffset).toBe(2);
        const second = runtime.search('x', { query: '', limit: 2, offset: first.page.nextOffset, sort: 'source-order' });
        expect(second.results[0].record.sourceIndex).toBe(2);
    });

    test('aborted request fails before expensive scoring and increments diagnostics', () => {
        const runtime = new DataSearchRuntime();
        runtime.register('x', fixtures);
        const controller = new AbortController();
        controller.abort();
        expect(() => runtime.search('x', { query: 'Hoşdere', signal: controller.signal }))
            .toThrow(expect.objectContaining({ name: 'AbortError' }));
        expect(runtime.snapshot().aborts).toBe(1);
    });

    test('bounded dataset lifecycle evicts oldest dataset', () => {
        const runtime = new DataSearchRuntime({ maxDatasets: 2 });
        runtime.register('a', fixtures);
        runtime.register('b', fixtures);
        runtime.register('c', fixtures);
        expect(runtime.get('a')).toBeNull();
        expect(runtime.get('b')).not.toBeNull();
        expect(runtime.get('c')).not.toBeNull();
        expect(runtime.snapshot().evictions).toBe(1);
    });

    test('normalizes unsafe limit values back to bounded defaults', () => {
        const normalized = normalizeSearchRequest({ limit: -1, offset: -5 });
        expect(normalized.limit).toBeGreaterThan(0);
        expect(normalized.offset).toBe(0);
    });

    test('never mutates input records across searches', () => {
        const source = JSON.parse(JSON.stringify(fixtures));
        const before = JSON.stringify(source);
        const runtime = new DataSearchRuntime();
        runtime.register('x', source);
        runtime.search('x', { query: 'Hoşdere', facetFields: ['category'] });
        runtime.search('x', { query: 'Çankaya', sort: 'title' });
        expect(JSON.stringify(source)).toBe(before);
    });
});
