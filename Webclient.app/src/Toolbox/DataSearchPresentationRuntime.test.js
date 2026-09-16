import {
    createIconCoverageReport,
    createRecordPresentation,
    createSearchHitPresentation,
    createSearchPresentations,
    normalizeRecord
} from './DataSearchNextRuntime';

const record = (overrides = {}) => normalizeRecord({
    id: overrides.id ?? '1',
    title: overrides.title ?? 'Örnek Nesne',
    category: overrides.category ?? '',
    type: overrides.type ?? '',
    address: overrides.address ?? 'Çankaya Ankara',
    ...overrides
}, 0);

describe('typed search presentation uses the single shared icon authority', () => {
    test('category matching resolves through existing icon registry', () => {
        const pharmacy = createRecordPresentation(record({
            category: 'Eczaneler',
            type: 'eczane',
            title: 'Merkez Eczanesi'
        }));
        expect(pharmacy.icon.key).toBe('eczane');
        expect(pharmacy.iconKey).toBe('eczane');
        expect(pharmacy.icon.src).toContain('eczane');
        expect(pharmacy.marker2d.url).toBe(pharmacy.icon.src);
        expect(pharmacy.graphic3d.iconKey).toBe(pharmacy.iconKey);
        expect(pharmacy.graphic3d.billboard).toBe(pharmacy.icon.src);
        expect(pharmacy.icon.isFallback).toBe(false);
    });

    test('alias, case and Turkish diacritic variants map deterministically', () => {
        const canonical = createRecordPresentation(record({
            category: 'Kütüphaneler',
            type: 'kütüphane'
        }));
        const asciiAlias = createRecordPresentation(record({
            category: 'KUTUPHANELER',
            type: 'kutuphane'
        }));
        expect(canonical.iconKey).toBe('kutuphane');
        expect(asciiAlias.iconKey).toBe('kutuphane');
        expect(asciiAlias.icon.src).toBe(canonical.icon.src);
    });

    test('well-known road and municipal aliases reuse existing registry keys', () => {
        const park = createRecordPresentation(record({
            category: 'Yeşil Alanlar',
            type: 'park'
        }));
        const wifi = createRecordPresentation(record({
            category: 'WiFi',
            type: 'wi-fi'
        }));
        const bus = createRecordPresentation(record({
            category: 'EGO',
            type: 'otobüs durağı'
        }));
        expect(['park', 'parklar']).toContain(park.iconKey);
        expect(wifi.iconKey).toBe('wifi');
        expect(bus.iconKey).toBe('otobus');
    });

    test('unknown categories use shared fallback instead of inventing a second mapping', () => {
        const unknown = createRecordPresentation(record({
            category: 'Tamamen Bilinmeyen Yeni Kategori',
            type: 'Tanımsız Tip'
        }));
        expect(unknown.icon.isFallback).toBe(true);
        expect(unknown.iconKey).toBe('default');
        expect(unknown.icon.src).toContain('pictureMarker');
        expect(unknown.graphic3d.isFallback).toBe(true);
    });

    test('coverage report quantifies resolved and fallback records', () => {
        const records = [
            record({ id: '1', category: 'Eczaneler', type: 'eczane' }),
            record({ id: '2', category: 'Kütüphaneler', type: 'kütüphane' }),
            record({ id: '3', category: 'Bilinmeyen', type: 'Bilinmeyen' })
        ];
        const report = createIconCoverageReport(records);
        expect(report.total).toBe(3);
        expect(report.resolved).toBe(2);
        expect(report.fallback).toBe(1);
        expect(report.fallbackRatio).toBeCloseTo(1 / 3, 8);
        expect(report.keys.eczane).toBe(1);
        expect(report.keys.kutuphane).toBe(1);
        expect(report.keys.default).toBe(1);
    });

    test('search hit presentation preserves scoring metadata and 2D/3D icon parity', () => {
        const source = record({
            id: '10',
            title: 'Ankara Kütüphanesi',
            category: 'Kütüphaneler',
            type: 'kütüphane'
        });
        const presentation = createSearchHitPresentation({
            record: source,
            score: 777,
            distanceMeters: 125.5,
            reasons: ['text', 'spatial']
        });
        expect(presentation.id).toBe('10');
        expect(presentation.score).toBe(777);
        expect(presentation.distanceMeters).toBe(125.5);
        expect(presentation.reasons).toEqual(['text', 'spatial']);
        expect(presentation.iconKey).toBe('kutuphane');
        expect(presentation.marker2d.url).toBe(presentation.icon.src);
        expect(presentation.graphic3d.billboard).toBe(presentation.icon.src);
    });

    test('batch presentation remains stable and non-mutating', () => {
        const first = record({ id: '1', category: 'Eczaneler', type: 'eczane' });
        const second = record({ id: '2', category: 'WiFi', type: 'wifi erişim noktası' });
        const hits = [
            { record: first, score: 10, distanceMeters: null, reasons: ['text'] },
            { record: second, score: 9, distanceMeters: 15, reasons: ['spatial'] }
        ];
        const before = JSON.stringify(hits.map(hit => hit.record.source));
        const presentations = createSearchPresentations(hits);
        expect(presentations).toHaveLength(2);
        expect(presentations[0].iconKey).toBe('eczane');
        expect(presentations[1].iconKey).toBe('wifi');
        expect(JSON.stringify(hits.map(hit => hit.record.source))).toBe(before);
    });
});
