import { describe, expect, it } from 'vitest';
import {
  ArcGisFeatureSchemaRegistry,
  type ArcGisFeatureSchemaRegistryPolicy,
  type ArcGisFeatureSchemaSnapshot,
  type ArcGisFeatureFieldSnapshot,
} from './ArcGisFeatureSchemaRegistry';

const policy: ArcGisFeatureSchemaRegistryPolicy = {
  maxLayers: 3,
  maxFieldsPerLayer: 12,
  maxSubtypesPerLayer: 4,
  maxSubtypeDomains: 4,
  maxCodedValues: 8,
  maxServiceKeyLength: 64,
  maxRevisionLength: 40,
  maxFieldNameLength: 48,
  maxAliasLength: 80,
  maxDomainNameLength: 80,
  maxDomainValueLength: 80,
  maxStringFieldLength: 512,
  retentionMs: 10_000,
  maxClockSkewMs: 50,
};

const make = () => new ArcGisFeatureSchemaRegistry(policy);

const fields = (): ArcGisFeatureFieldSnapshot[] => [
  { name: 'OBJECTID', alias: 'Object ID', type: 'esriFieldTypeOID', length: null, editable: false, nullable: false, domain: null },
  { name: 'GlobalID', alias: 'Global ID', type: 'esriFieldTypeGlobalID', length: 38, editable: false, nullable: false, domain: null },
  { name: 'TYPE_ID', alias: 'Type', type: 'esriFieldTypeInteger', length: null, editable: true, nullable: false, domain: null },
  {
    name: 'STATUS',
    alias: 'Status',
    type: 'esriFieldTypeString',
    length: 40,
    editable: true,
    nullable: true,
    domain: { type: 'codedValue', name: 'Status domain', codedValues: [{ name: 'Open', code: 'OPEN' }, { name: 'Closed', code: 'CLOSED' }] },
  },
  { name: 'HEIGHT', alias: 'Height', type: 'esriFieldTypeDouble', length: null, editable: true, nullable: true, domain: { type: 'range', name: 'Height range', min: 0, max: 500 } },
];

const schema = (
  serviceKey: string,
  layerId = 0,
  observedAtMs = 100,
  overrides: Partial<ArcGisFeatureSchemaSnapshot> = {},
): ArcGisFeatureSchemaSnapshot => ({
  serviceKey,
  layerId,
  revision: 'rev-1',
  observedAtMs,
  objectIdField: 'OBJECTID',
  globalIdField: 'GlobalID',
  typeIdField: 'TYPE_ID',
  fields: fields(),
  subtypes: [
    { id: 1, name: 'Primary', domains: [{ fieldName: 'STATUS', domain: { type: 'codedValue', name: 'Primary status', codedValues: [{ name: 'Open', code: 'OPEN' }] } }] },
    { id: 2, name: 'Secondary', domains: [{ fieldName: 'STATUS', domain: { type: 'inherited' } }] },
  ],
  ...overrides,
});

describe('ArcGisFeatureSchemaRegistry', () => {
  it('normalizes fields, coded values and subtypes deterministically', () => {
    const registry = make();
    const input = schema('parcels', 2, 100, {
      fields: [...fields()].reverse(),
      subtypes: [
        { id: 2, name: 'Secondary', domains: [{ fieldName: 'STATUS', domain: { type: 'inherited' } }] },
        { id: 1, name: 'Primary', domains: [{ fieldName: 'STATUS', domain: { type: 'codedValue', name: 'Primary status', codedValues: [{ name: 'Open', code: 'OPEN' }] } }] },
      ],
    });
    const result = registry.observe(input);
    expect(result.status).toBe('inserted');
    expect(result.entry.schema.fields.map((field) => field.name)).toEqual(['GlobalID', 'HEIGHT', 'OBJECTID', 'STATUS', 'TYPE_ID']);
    expect(result.entry.schema.subtypes.map((subtype) => subtype.id)).toEqual([1, 2]);
    expect(Object.isFrozen(result.entry.schema.fields)).toBe(true);
    expect(Object.isFrozen(result.entry.schema.fields[0])).toBe(true);
  });

  it('refreshes unchanged schema observations without advancing schema sequence', () => {
    const registry = make();
    const first = registry.observe(schema('roads', 0, 100));
    const second = registry.observe(schema('roads', 0, 150));
    expect(second.status).toBe('unchanged');
    expect(second.entry.sequence).toBe(first.entry.sequence);
    expect(second.entry.schema.observedAtMs).toBe(150);
  });

  it('detects removed fields and changed field types as breaking schema drift', () => {
    const registry = make();
    registry.observe(schema('roads', 0, 100));
    const changedFields = fields().filter((field) => field.name !== 'HEIGHT').map((field) => field.name === 'STATUS' ? { ...field, type: 'esriFieldTypeInteger' as const, length: null } : field);
    const result = registry.observe(schema('roads', 0, 200, { revision: 'rev-2', fields: changedFields }));
    expect(result.compatible).toBe(false);
    expect(result.breakingChanges).toContain('field-removed:HEIGHT');
    expect(result.breakingChanges).toContain('field-type-changed:STATUS');
  });

  it('detects nullability tightening, editing disablement and string length shrink', () => {
    const registry = make();
    registry.observe(schema('roads'));
    const changed = fields().map((field) => field.name === 'STATUS' ? { ...field, nullable: false, editable: false, length: 20 } : field);
    const result = registry.observe(schema('roads', 0, 200, { revision: 'rev-2', fields: changed }));
    expect(result.breakingChanges).toEqual(expect.arrayContaining([
      'nullable-tightened:STATUS',
      'editable-disabled:STATUS',
      'field-length-decreased:STATUS',
    ]));
  });

  it('treats field-domain changes as conservative breaking drift', () => {
    const registry = make();
    registry.observe(schema('roads'));
    const changed = fields().map((field) => field.name === 'HEIGHT' ? { ...field, domain: { type: 'range' as const, name: 'Height range', min: 0, max: 100 } } : field);
    const result = registry.observe(schema('roads', 0, 200, { revision: 'rev-2', fields: changed }));
    expect(result.breakingChanges).toContain('domain-changed:HEIGHT');
  });

  it('detects special identity field changes and subtype removal', () => {
    const registry = make();
    const baseFields = fields();
    registry.observe(schema('assets'));
    const alternateFields: ArcGisFeatureFieldSnapshot[] = [
      ...baseFields,
      { name: 'OBJECTID2', alias: 'Object ID 2', type: 'esriFieldTypeOID', length: null, editable: false, nullable: false, domain: null },
      { name: 'GlobalID2', alias: 'Global ID 2', type: 'esriFieldTypeGlobalID', length: 38, editable: false, nullable: false, domain: null },
      { name: 'TYPE_ID2', alias: 'Type 2', type: 'esriFieldTypeInteger', length: null, editable: true, nullable: false, domain: null },
    ];
    const result = registry.observe(schema('assets', 0, 200, {
      revision: 'rev-2',
      objectIdField: 'OBJECTID2',
      globalIdField: 'GlobalID2',
      typeIdField: 'TYPE_ID2',
      fields: alternateFields,
      subtypes: [{ id: 1, name: 'Primary', domains: [] }],
    }));
    expect(result.breakingChanges).toEqual(expect.arrayContaining([
      'object-id-field-changed',
      'global-id-field-changed',
      'type-id-field-changed',
      'subtype-removed:n:2',
    ]));
  });

  it('accepts additive fields and subtypes as compatible schema expansion', () => {
    const registry = make();
    registry.observe(schema('assets'));
    const result = registry.observe(schema('assets', 0, 200, {
      revision: 'rev-2',
      fields: [...fields(), { name: 'COMMENT', alias: 'Comment', type: 'esriFieldTypeString', length: 100, editable: true, nullable: true, domain: null }],
      subtypes: [...schema('assets').subtypes, { id: 3, name: 'Tertiary', domains: [] }],
    }));
    expect(result.compatible).toBe(true);
    expect(result.breakingChanges).toEqual([]);
  });

  it('validates ArcGIS object ID and global ID field contracts', () => {
    const registry = make();
    expect(() => registry.observe(schema('bad-oid', 0, 100, { objectIdField: 'STATUS' }))).toThrow('object ID field is missing or has wrong type');
    expect(() => registry.observe(schema('bad-global', 0, 100, { globalIdField: 'STATUS' }))).toThrow('global ID field is missing or has wrong type');
  });

  it('requires subtype typeIdField to exist in the layer schema', () => {
    const registry = make();
    expect(() => registry.observe(schema('missing-type', 0, 100, { typeIdField: 'NOT_THERE' }))).toThrow('type ID field is missing from schema');
    expect(() => registry.observe(schema('missing-type', 0, 100, { typeIdField: null }))).toThrow('subtypes require type ID field');
  });

  it('rejects duplicate field names and duplicate subtype IDs', () => {
    const registry = make();
    expect(() => registry.observe(schema('fields', 0, 100, { fields: [...fields(), fields()[0]!] }))).toThrow('duplicate feature field');
    expect(() => registry.observe(schema('subtypes', 0, 100, { subtypes: [...schema('x').subtypes, { id: 1, name: 'Duplicate', domains: [] }] }))).toThrow('duplicate subtype ID');
  });

  it('rejects subtype domains that reference unknown or duplicate fields', () => {
    const registry = make();
    expect(() => registry.observe(schema('unknown', 0, 100, { subtypes: [{ id: 1, name: 'A', domains: [{ fieldName: 'MISSING', domain: null }] }] }))).toThrow('subtype domain references unknown field');
    expect(() => registry.observe(schema('duplicate', 0, 100, { subtypes: [{ id: 1, name: 'A', domains: [{ fieldName: 'STATUS', domain: null }, { fieldName: 'STATUS', domain: { type: 'inherited' } }] }] }))).toThrow('duplicate subtype field domain');
  });

  it('normalizes and validates coded-value domains with typed code identity', () => {
    const registry = make();
    const duplicateDomain = { type: 'codedValue' as const, name: 'Codes', codedValues: [{ name: 'Numeric', code: 1 }, { name: 'Duplicate', code: 1 }] };
    const bad = fields().map((field) => field.name === 'STATUS' ? { ...field, domain: duplicateDomain } : field);
    expect(() => registry.observe(schema('duplicate-code', 0, 100, { fields: bad }))).toThrow('duplicate coded domain value');

    const typedDomain = { type: 'codedValue' as const, name: 'Codes', codedValues: [{ name: 'Numeric', code: 1 }, { name: 'String', code: '1' }] };
    const good = fields().map((field) => field.name === 'STATUS' ? { ...field, domain: typedDomain } : field);
    expect(registry.observe(schema('typed-code', 0, 100, { fields: good })).entry.schema.fields.find((field) => field.name === 'STATUS')?.domain).toMatchObject({ type: 'codedValue' });
  });

  it('rejects inverted or mixed-type range domains', () => {
    const registry = make();
    const inverted = fields().map((field) => field.name === 'HEIGHT' ? { ...field, domain: { type: 'range' as const, name: 'Bad', min: 10, max: 1 } } : field);
    expect(() => registry.observe(schema('inverted', 0, 100, { fields: inverted }))).toThrow('range domain minimum exceeds maximum');
    const mixed = fields().map((field) => field.name === 'HEIGHT' ? { ...field, domain: { type: 'range' as const, name: 'Mixed', min: 1, max: '9' } } : field);
    expect(() => registry.observe(schema('mixed', 0, 100, { fields: mixed }))).toThrow('range domain value types must match');
  });

  it('supports current ArcGIS temporal and large integer field types', () => {
    const registry = make();
    const modern: ArcGisFeatureFieldSnapshot[] = [
      ...fields(),
      { name: 'BIG_ID', alias: 'Big ID', type: 'esriFieldTypeBigInteger', length: null, editable: false, nullable: true, domain: null },
      { name: 'DATE_ONLY', alias: 'Date Only', type: 'esriFieldTypeDateOnly', length: null, editable: true, nullable: true, domain: null },
      { name: 'TIME_ONLY', alias: 'Time Only', type: 'esriFieldTypeTimeOnly', length: null, editable: true, nullable: true, domain: null },
      { name: 'STAMP_OFFSET', alias: 'Timestamp Offset', type: 'esriFieldTypeTimestampOffset', length: null, editable: true, nullable: true, domain: null },
    ];
    expect(registry.observe(schema('modern', 0, 100, { fields: modern })).entry.schema.fields).toHaveLength(9);
  });

  it('rejects unsupported field types and malformed field strings', () => {
    const registry = make();
    const unsupported = fields().map((field) => field.name === 'STATUS' ? { ...field, type: 'esriFieldTypeUnknown' as never } : field);
    expect(() => registry.observe(schema('unsupported', 0, 100, { fields: unsupported }))).toThrow('unsupported ArcGIS field type');
    const nullByte = fields().map((field) => field.name === 'STATUS' ? { ...field, name: 'BAD\0FIELD' } : field);
    expect(() => registry.observe(schema('null-byte', 0, 100, { fields: nullByte }))).toThrow();
  });

  it('enforces string field length and collection budgets', () => {
    const registry = new ArcGisFeatureSchemaRegistry({ ...policy, maxFieldsPerLayer: 5, maxSubtypesPerLayer: 1, maxCodedValues: 1, maxStringFieldLength: 20 });
    expect(() => registry.observe(schema('too-many-subtypes'))).toThrow('subtype count outside registry policy');
    const longString = fields().map((field) => field.name === 'STATUS' ? { ...field, length: 21 } : field);
    expect(() => registry.observe(schema('long-string', 0, 100, { fields: longString, subtypes: [] }))).toThrow('string field length outside registry policy');
    const coded = fields().map((field) => field.name === 'STATUS' ? { ...field, domain: { type: 'codedValue' as const, name: 'Codes', codedValues: [{ name: 'A', code: 'A' }, { name: 'B', code: 'B' }] } } : field);
    expect(() => registry.observe(schema('codes', 0, 100, { fields: coded, subtypes: [] }))).toThrow('coded value count outside registry policy');
  });

  it('rejects stale observations for the same service/layer identity', () => {
    const registry = make();
    registry.observe(schema('roads', 3, 200));
    expect(() => registry.observe(schema('roads', 3, 199, { revision: 'rev-2' }))).toThrow('stale feature schema observation');
  });

  it('bounds layer capacity with deterministic least-recently-accessed eviction', () => {
    const registry = make();
    registry.observe(schema('svc', 1, 100));
    registry.observe(schema('svc', 2, 100));
    registry.observe(schema('svc', 3, 100));
    expect(registry.get('svc', 1, 120)).not.toBeNull();
    registry.observe(schema('svc', 4, 130));
    expect(registry.get('svc', 2, 130)).toBeNull();
    expect(registry.snapshot(130).entries.map((entry) => entry.schema.layerId)).toEqual([1, 3, 4]);
  });

  it('invalidates one layer or all layers for a service deterministically', () => {
    const registry = make();
    registry.observe(schema('a', 1, 100));
    registry.observe(schema('a', 2, 100));
    registry.observe(schema('b', 1, 100));
    expect(registry.invalidate('a', 1)).toBe(1);
    expect(registry.get('a', 2, 100)).not.toBeNull();
    expect(registry.invalidate('a')).toBe(1);
    expect(registry.get('b', 1, 100)).not.toBeNull();
  });

  it('prunes schemas only after the configured retention horizon', () => {
    const registry = make();
    registry.observe(schema('a', 0, 100));
    expect(registry.prune(10_100)).toBe(0);
    expect(registry.prune(10_101)).toBe(1);
  });

  it('restores valid schema snapshots atomically', () => {
    const source = make();
    source.observe(schema('z', 2, 100));
    source.observe(schema('a', 1, 110));
    const snapshot = source.snapshot(120);
    const target = make();
    target.restore(snapshot, 120);
    expect(target.snapshot(120).entries.map((entry) => `${entry.schema.serviceKey}:${entry.schema.layerId}`)).toEqual(['a:1', 'z:2']);
  });

  it('rejects duplicate restore identities without mutating current state', () => {
    const registry = make();
    registry.observe(schema('safe', 1, 100));
    const before = registry.snapshot(100);
    const entry = before.entries[0]!;
    expect(() => registry.restore({ entries: [entry, entry] }, 100)).toThrow('duplicate feature schema entry');
    expect(registry.snapshot(100).entries).toEqual(before.entries);
  });

  it('rejects future and inverted restore chronology', () => {
    const source = make();
    source.observe(schema('future', 0, 200));
    const future = source.snapshot(200).entries[0]!;
    expect(() => make().restore({ entries: [future] }, 100)).toThrow('future feature schema timestamp');

    const normal = make();
    normal.observe(schema('normal', 0, 100));
    const entry = normal.snapshot(100).entries[0]!;
    expect(() => make().restore({ entries: [{ ...entry, lastAccessedAtMs: 99 }] }, 100)).toThrow('invalid feature schema chronology');
  });

  it('does not retain caller-owned field or domain arrays', () => {
    const registry = make();
    const callerFields = fields();
    const callerSubtypes = [...schema('x').subtypes];
    registry.observe(schema('safe', 0, 100, { fields: callerFields, subtypes: callerSubtypes }));
    callerFields.push({ name: 'LEAK', alias: 'Leak', type: 'esriFieldTypeString', length: 5, editable: true, nullable: true, domain: null });
    callerSubtypes.push({ id: 99, name: 'Leak', domains: [] });
    expect(registry.get('safe', 0, 100)?.schema.fields.some((field) => field.name === 'LEAK')).toBe(false);
    expect(registry.get('safe', 0, 100)?.schema.subtypes.some((subtype) => subtype.id === 99)).toBe(false);
  });

  it('rejects stale global registry clocks', () => {
    const registry = make();
    registry.observe(schema('clock', 0, 200));
    expect(() => registry.snapshot(100)).toThrow('stale feature schema clock');
  });

  it('disposes idempotently and rejects later use', () => {
    const registry = make();
    registry.observe(schema('a'));
    registry.dispose();
    registry.dispose();
    expect(() => registry.snapshot(100)).toThrow('disposed');
  });
});
