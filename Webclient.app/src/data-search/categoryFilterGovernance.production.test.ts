import { describe, expect, it } from 'vitest';
import type { NormalizedRecord, SearchFilter } from './contracts';
import { normalizeRecordCollection } from './normalization';
import {
  CategoryOntologyRuntime,
  createCategoryOntologyFingerprint,
} from './categoryOntologyRuntime';
import {
  FilterIndexRuntime,
  defaultSearchFilterFields,
} from './filterIndexRuntime';

const records = (): readonly NormalizedRecord[] => normalizeRecordCollection([
  {
    id: 1,
    name: 'Çankaya Atatürk Parkı',
    category: 'Park ve Yeşil Alan',
    type: 'Kent Parkı',
    district: 'Çankaya',
    neighborhood: 'Kızılay',
    postalCode: '06420',
    rating: 4.8,
  },
  {
    id: 2,
    name: 'Bahçelievler Çocuk Parkı',
    category: 'Yeşil Alan',
    type: 'Çocuk Parkı',
    district: 'Çankaya',
    neighborhood: 'Bahçelievler',
    postalCode: '06490',
    rating: 4.1,
  },
  {
    id: 3,
    name: 'Ulus Kültür Merkezi',
    category: 'Kültür Sanat',
    type: 'Kültür Merkezi',
    district: 'Altındağ',
    neighborhood: 'Ulus',
    postalCode: '06050',
    rating: 4.6,
  },
  {
    id: 4,
    name: 'Etlik Şehir Hastanesi',
    category: 'Sağlık',
    type: 'Hastane',
    district: 'Keçiören',
    neighborhood: 'Etlik',
    postalCode: '06010',
    rating: 4.9,
  },
  {
    id: 5,
    name: 'Bilinmeyen Nokta',
    category: 'Yeni Özel Kategori',
    type: 'Deneysel Tür',
    district: 'Mamak',
    neighborhood: 'Akdere',
    postalCode: '06630',
    rating: 3.2,
  },
]).records;

const ontologyEntries = Object.freeze([
  {
    key: 'places',
    label: 'Mekânlar',
    aliases: ['mekan', 'mekân'],
    priority: 1,
  },
  {
    key: 'green-space',
    label: 'Yeşil Alan',
    parentKey: 'places',
    aliases: ['Park ve Yeşil Alan', 'Yeşil Alan', 'park'],
    typeAliases: ['Kent Parkı', 'Çocuk Parkı'],
    tags: ['outdoor', 'recreation'],
    iconHint: 'park',
    priority: 20,
  },
  {
    key: 'culture',
    label: 'Kültür ve Sanat',
    parentKey: 'places',
    aliases: ['Kültür Sanat', 'kultur'],
    typeAliases: ['Kültür Merkezi'],
    tags: ['culture'],
    iconHint: 'culture',
    priority: 10,
  },
  {
    key: 'health',
    label: 'Sağlık',
    parentKey: 'places',
    aliases: ['Sağlık', 'saglik'],
    typeAliases: ['Hastane'],
    tags: ['health'],
    iconHint: 'hospital',
    priority: 30,
  },
]);

describe('CategoryOntologyRuntime production governance', () => {
  it('resolves Turkish category aliases deterministically', () => {
    const runtime = new CategoryOntologyRuntime(ontologyEntries);
    const result = runtime.resolve({ category: '  PARK VE YEŞİL ALAN ' });

    expect(result.key).toBe('green-space');
    expect(result.kind).toBe('alias');
    expect(result.path).toEqual(['places', 'green-space']);
    expect(result.tags).toEqual(['outdoor', 'recreation']);
    expect(result.iconHint).toBe('park');
    expect(result.isFallback).toBe(false);
  });

  it('uses canonical key before raw alias data', () => {
    const runtime = new CategoryOntologyRuntime(ontologyEntries);
    const result = runtime.resolve({
      categoryKey: 'health',
      category: 'Park ve Yeşil Alan',
      type: 'Kent Parkı',
    });

    expect(result.key).toBe('health');
    expect(result.kind).toBe('canonical-key');
    expect(result.matchedBy).toBe('categoryKey');
  });

  it('falls back to type aliases when category is unknown', () => {
    const runtime = new CategoryOntologyRuntime(ontologyEntries);
    const result = runtime.resolve({
      category: 'Başka Bir Değer',
      type: 'HASTANE',
    });

    expect(result.key).toBe('health');
    expect(result.kind).toBe('type-alias');
    expect(result.matchedBy).toBe('type');
  });

  it('distinguishes unknown values from empty fallback values', () => {
    const runtime = new CategoryOntologyRuntime(ontologyEntries, {
      unknownKey: 'other',
      unknownLabel: 'Diğer',
    });

    const unknown = runtime.resolve({ category: 'Eşleşmeyen' });
    const empty = runtime.resolve({});

    expect(unknown).toMatchObject({
      key: 'other',
      label: 'Diğer',
      kind: 'unknown',
      isFallback: true,
    });
    expect(empty).toMatchObject({
      key: 'other',
      label: 'Diğer',
      kind: 'fallback',
      isFallback: true,
    });
  });

  it('reports bounded category coverage without exposing raw records', () => {
    const runtime = new CategoryOntologyRuntime(ontologyEntries);
    const report = runtime.coverage(records());

    expect(report.total).toBe(5);
    expect(report.resolved).toBe(4);
    expect(report.fallback).toBe(1);
    expect(report.unknown).toBe(1);
    expect(report.coverageRatio).toBe(0.8);
    expect(report.byKey['green-space']).toBe(2);
    expect(report.byKey.culture).toBe(1);
    expect(report.byKey.health).toBe(1);
    expect(report.unresolvedSamples).toEqual(['Yeni Özel Kategori']);
  });

  it('detects alias collisions but uses priority deterministically', () => {
    const runtime = new CategoryOntologyRuntime([
      { key: 'low', label: 'Low', aliases: ['shared'], priority: 1 },
      { key: 'high', label: 'High', aliases: ['shared'], priority: 50 },
    ]);

    expect(runtime.resolve({ category: 'shared' }).key).toBe('high');
    expect(runtime.snapshot().conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'alias-collision', value: 'shared' }),
    ]));
  });

  it('detects missing parents and hierarchy cycles without hanging', () => {
    const runtime = new CategoryOntologyRuntime([
      { key: 'missing-child', label: 'Missing', parentKey: 'does-not-exist' },
      { key: 'cycle-a', label: 'A', parentKey: 'cycle-b' },
      { key: 'cycle-b', label: 'B', parentKey: 'cycle-a' },
    ]);

    const codes = runtime.snapshot().conflicts.map(item => item.code);
    expect(codes).toContain('missing-parent');
    expect(codes).toContain('hierarchy-cycle');
    expect(runtime.pathFor('cycle-a').length).toBeLessThanOrEqual(12);
  });

  it('keeps fingerprints stable for equivalent definitions', () => {
    const first = createCategoryOntologyFingerprint(ontologyEntries);
    const second = createCategoryOntologyFingerprint([
      ...ontologyEntries,
    ]);

    expect(first).toBe(second);
    expect(first).toMatch(/^fnv1a-/);
  });

  it('supports bounded upsert and removal lifecycle', () => {
    const runtime = new CategoryOntologyRuntime(ontologyEntries);
    runtime.upsert({
      key: 'education',
      label: 'Eğitim',
      aliases: ['okul'],
      parentKey: 'places',
      priority: 15,
    });

    expect(runtime.entry('education')?.label).toBe('Eğitim');
    expect(runtime.resolve({ category: 'OKUL' }).key).toBe('education');
    expect(runtime.remove('education')).toBe(true);
    expect(runtime.remove('education')).toBe(false);
    expect(runtime.resolve({ category: 'okul' }).kind).toBe('unknown');
  });

  it('returns descendants in deterministic breadth-first order', () => {
    const runtime = new CategoryOntologyRuntime([
      { key: 'root', label: 'Root' },
      { key: 'a', label: 'A', parentKey: 'root' },
      { key: 'b', label: 'B', parentKey: 'root' },
      { key: 'a1', label: 'A1', parentKey: 'a' },
    ]);

    expect(runtime.descendantsOf('root')).toEqual(['a', 'b', 'a1']);
  });
});

describe('FilterIndexRuntime production governance', () => {
  it('builds deterministic default search field diagnostics', () => {
    const runtime = new FilterIndexRuntime(records(), defaultSearchFilterFields());
    const snapshot = runtime.snapshot();

    expect(snapshot.recordCount).toBe(5);
    expect(snapshot.fieldCount).toBeGreaterThanOrEqual(6);
    expect(snapshot.postingCount).toBeGreaterThan(0);
    expect(snapshot.fingerprint).toMatch(/^fnv1a-/);
    expect(runtime.validate()).toEqual([]);
  });

  it('uses equality index for canonical category filters', () => {
    const runtime = new FilterIndexRuntime(records(), defaultSearchFilterFields());
    const filters: readonly SearchFilter[] = [
      { field: 'district', operator: 'eq', values: ['Çankaya'] },
    ];
    const plan = runtime.plan(filters);

    expect(plan.strategy).toBe('indexed-union');
    expect(plan.indexedFilterCount).toBe(1);
    expect(plan.residualFilterCount).toBe(0);
    expect(plan.positions).toEqual([0, 1]);
    expect(runtime.candidates(filters).map(record => record.id)).toEqual(['1', '2']);
  });

  it('intersects multiple indexed filters before residual evaluation', () => {
    const runtime = new FilterIndexRuntime(records(), defaultSearchFilterFields());
    const plan = runtime.plan([
      { field: 'district', operator: 'eq', values: ['Çankaya'] },
      { field: 'neighborhood', operator: 'eq', values: ['Bahçelievler'] },
    ]);

    expect(plan.strategy).toBe('indexed-intersection');
    expect(plan.indexedFilterCount).toBe(2);
    expect(plan.positions).toEqual([1]);
  });

  it('uses prefix postings within configured prefix length', () => {
    const runtime = new FilterIndexRuntime(records(), [
      { field: 'district', kind: 'string', prefixLength: 8 },
    ]);
    const plan = runtime.plan([
      { field: 'district', operator: 'prefix', values: ['çank'] },
    ]);

    expect(plan.positions).toEqual([0, 1]);
    expect(plan.steps[0]).toMatchObject({ indexed: true, reason: 'indexed' });
  });

  it('leaves long-prefix filters as indexed empty candidates instead of broad scanning', () => {
    const runtime = new FilterIndexRuntime(records(), [
      { field: 'district', kind: 'string', prefixLength: 3 },
    ]);
    const plan = runtime.plan([
      { field: 'district', operator: 'prefix', values: ['çankaya'] },
    ]);

    expect(plan.strategy).toBe('empty');
    expect(plan.positions).toEqual([]);
  });

  it('marks contains and neq as residual operations', () => {
    const runtime = new FilterIndexRuntime(records(), defaultSearchFilterFields());
    const plan = runtime.plan([
      { field: 'district', operator: 'contains', values: ['kaya'] },
      { field: 'categoryKey', operator: 'neq', values: ['health'] },
    ]);

    expect(plan.strategy).toBe('all-records');
    expect(plan.indexedFilterCount).toBe(0);
    expect(plan.residualFilterCount).toBe(2);
    expect(plan.positions).toEqual([0, 1, 2, 3, 4]);
  });

  it('mixes indexed and residual filters without false narrowing', () => {
    const runtime = new FilterIndexRuntime(records(), defaultSearchFilterFields());
    const plan = runtime.plan([
      { field: 'district', operator: 'eq', values: ['Çankaya'] },
      { field: 'title', operator: 'contains', values: ['Parkı'] },
    ]);

    expect(plan.strategy).toBe('hybrid');
    expect(plan.positions).toEqual([0, 1]);
    expect(plan.indexedFilterCount).toBe(1);
    expect(plan.residualFilterCount).toBe(1);
  });

  it('supports numeric range planning with binary boundaries', () => {
    const runtime = new FilterIndexRuntime(records(), [
      { field: 'rating', kind: 'number' },
    ]);

    expect(runtime.plan([
      { field: 'rating', operator: 'gte', values: [4.6] },
    ]).positions).toEqual([0, 2, 3]);

    expect(runtime.plan([
      { field: 'rating', operator: 'lte', values: [4.1] },
    ]).positions).toEqual([1, 4]);

    expect(runtime.plan([
      { field: 'rating', operator: 'between', values: [4.0, 4.7] },
    ]).positions).toEqual([1, 2]);
  });

  it('supports exists planning and missing-field diagnostics', () => {
    const runtime = new FilterIndexRuntime(records(), [
      { field: 'rating', kind: 'number' },
      { field: 'unknownField', kind: 'string' },
    ]);

    expect(runtime.plan([
      { field: 'rating', operator: 'exists', values: [] },
    ]).positions).toEqual([0, 1, 2, 3, 4]);
    expect(runtime.field('unknownField')).toMatchObject({
      indexedCount: 0,
      missingCount: 5,
    });
  });

  it('bounds candidate cardinality deterministically', () => {
    const runtime = new FilterIndexRuntime(records(), [
      { field: 'district', kind: 'string' },
    ], {
      maxCandidatePositions: 1,
    });
    const plan = runtime.plan([
      { field: 'district', operator: 'eq', values: ['Çankaya'] },
    ]);

    expect(plan.positions).toEqual([0]);
    expect(plan.truncated).toBe(true);
  });

  it('is deterministic for repeated plans', () => {
    const runtime = new FilterIndexRuntime(records(), defaultSearchFilterFields());
    const filters: readonly SearchFilter[] = [
      { field: 'district', operator: 'eq', values: ['Çankaya'] },
      { field: 'postalCode', operator: 'prefix', values: ['064'] },
    ];

    expect(runtime.plan(filters).fingerprint).toBe(runtime.plan(filters).fingerprint);
  });
});
