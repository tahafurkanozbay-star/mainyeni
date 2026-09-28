import { describe, expect, it } from 'vitest';
import type { ArcGisFeatureFieldSnapshot } from './ArcGisFeatureSchemaRegistry';
import { ArcGisQueryProjectionPlanner, type ArcGisQueryProjectionPolicy } from './ArcGisQueryProjectionPlanner';

const policy: ArcGisQueryProjectionPolicy = {
  maxFields: 16,
  maxPopupFields: 8,
  maxSortFields: 4,
  maxStatistics: 6,
  maxGroupByFields: 4,
  maxFieldNameLength: 64,
  maxOutputFieldNameLength: 64,
  maxEstimatedAttributeBytes: 2_000_000,
  maxEstimatedGeometryBytes: 4_000_000,
  maxEstimatedTotalBytes: 5_000_000,
  defaultVariableFieldBytes: 256,
  defaultGeometryBytesPerFeature: 512,
};

const fields: ArcGisFeatureFieldSnapshot[] = [
  { name: 'OBJECTID', alias: 'Object ID', type: 'esriFieldTypeOID', length: null, editable: false, nullable: false, domain: null },
  { name: 'NAME', alias: 'Name', type: 'esriFieldTypeString', length: 100, editable: true, nullable: true, domain: null },
  { name: 'CATEGORY', alias: 'Category', type: 'esriFieldTypeString', length: 30, editable: true, nullable: true, domain: null },
  { name: 'VALUE', alias: 'Value', type: 'esriFieldTypeDouble', length: null, editable: true, nullable: true, domain: null },
  { name: 'COUNT', alias: 'Count', type: 'esriFieldTypeInteger', length: null, editable: true, nullable: true, domain: null },
  { name: 'WHEN', alias: 'When', type: 'esriFieldTypeDate', length: null, editable: true, nullable: true, domain: null },
];

const planner = () => new ArcGisQueryProjectionPlanner(policy);

const base = () => ({
  objectIdField: 'OBJECTID',
  availableFields: fields,
  requestedFields: ['NAME'],
  popupFields: ['CATEGORY'],
  sortFields: [{ fieldName: 'VALUE', direction: 'DESC' as const }],
  statistics: [],
  groupByFields: [],
  returnGeometry: false,
  estimatedRecordCount: 100,
});

describe('ArcGisQueryProjectionPlanner', () => {
  it('builds a deterministic minimal outFields projection including OBJECTID', () => {
    const plan = planner().plan(base());
    expect(plan.outFields).toEqual(['CATEGORY', 'NAME', 'OBJECTID', 'VALUE']);
    expect(plan.orderByFields).toEqual(['VALUE DESC']);
    expect(plan.returnGeometry).toBe(false);
  });

  it('never needs wildcard outFields to preserve identity', () => {
    const plan = planner().plan({ ...base(), requestedFields: [], popupFields: [], sortFields: [] });
    expect(plan.outFields).toEqual(['OBJECTID']);
    expect(plan.outFields).not.toContain('*');
  });

  it('rejects wildcard fields explicitly', () => {
    expect(() => planner().plan({ ...base(), requestedFields: ['*'] })).toThrow('requested field outside configured bounds');
  });

  it('adds groupBy fields to the attribute projection', () => {
    const plan = planner().plan({ ...base(), groupByFields: ['CATEGORY'] });
    expect(plan.groupByFields).toEqual(['CATEGORY']);
    expect(plan.outFields).toContain('CATEGORY');
  });

  it('adds sort fields and preserves explicit ASC or DESC direction', () => {
    const plan = planner().plan({ ...base(), sortFields: [{ fieldName: 'WHEN', direction: 'ASC' }, { fieldName: 'VALUE', direction: 'DESC' }] });
    expect(plan.orderByFields).toEqual(['WHEN ASC', 'VALUE DESC']);
    expect(plan.outFields).toEqual(expect.arrayContaining(['WHEN', 'VALUE']));
  });

  it('accepts numeric statistics with bounded output names', () => {
    const plan = planner().plan({
      ...base(),
      statistics: [
        { fieldName: 'VALUE', statisticType: 'avg', outputFieldName: 'avg_value' },
        { fieldName: 'COUNT', statisticType: 'sum', outputFieldName: 'sum_count' },
      ],
    });
    expect(plan.statistics).toEqual([
      { fieldName: 'VALUE', statisticType: 'avg', outputFieldName: 'avg_value' },
      { fieldName: 'COUNT', statisticType: 'sum', outputFieldName: 'sum_count' },
    ]);
  });

  it('allows count statistics on non-numeric fields but rejects numeric statistics on strings', () => {
    expect(planner().plan({ ...base(), statistics: [{ fieldName: 'NAME', statisticType: 'count', outputFieldName: 'name_count' }] }).statistics).toHaveLength(1);
    expect(() => planner().plan({ ...base(), statistics: [{ fieldName: 'NAME', statisticType: 'sum', outputFieldName: 'name_sum' }] })).toThrow('numeric statistic requires numeric field');
  });

  it('rejects duplicate requested, popup, sort and groupBy identities', () => {
    const p = planner();
    expect(() => p.plan({ ...base(), requestedFields: ['NAME', 'NAME'] })).toThrow('duplicate requested field');
    expect(() => p.plan({ ...base(), popupFields: ['CATEGORY', 'CATEGORY'] })).toThrow('duplicate popup field');
    expect(() => p.plan({ ...base(), sortFields: [{ fieldName: 'VALUE', direction: 'ASC' }, { fieldName: 'VALUE', direction: 'DESC' }] })).toThrow('duplicate sort field');
    expect(() => p.plan({ ...base(), groupByFields: ['CATEGORY', 'CATEGORY'] })).toThrow('duplicate groupBy field');
  });

  it('rejects duplicate statistic output fields', () => {
    expect(() => planner().plan({ ...base(), statistics: [
      { fieldName: 'VALUE', statisticType: 'avg', outputFieldName: 'metric' },
      { fieldName: 'COUNT', statisticType: 'sum', outputFieldName: 'metric' },
    ] })).toThrow('duplicate statistic output field');
  });

  it('rejects projection references that are not present in the layer schema', () => {
    const p = planner();
    expect(() => p.plan({ ...base(), requestedFields: ['MISSING'] })).toThrow('requested field is not present in layer schema');
    expect(() => p.plan({ ...base(), popupFields: ['MISSING'] })).toThrow('popup field is not present in layer schema');
    expect(() => p.plan({ ...base(), groupByFields: ['MISSING'] })).toThrow('groupBy field is not present in layer schema');
  });

  it('requires the configured objectIdField to reference an OID field', () => {
    expect(() => planner().plan({ ...base(), objectIdField: 'NAME' })).toThrow('objectIdField must reference an OID field');
    expect(() => planner().plan({ ...base(), objectIdField: 'MISSING' })).toThrow('objectIdField is not present in layer schema');
  });

  it('estimates attribute payload from selected field types', () => {
    const plan = planner().plan({ ...base(), requestedFields: ['NAME', 'COUNT', 'WHEN'], popupFields: [], sortFields: [], estimatedRecordCount: 10 });
    // OID 8 + NAME 100 + COUNT 4 + date 16 = 128 bytes/record.
    expect(plan.estimatedAttributeBytes).toBe(1_280);
    expect(plan.estimatedGeometryBytes).toBe(0);
  });

  it('adds geometry budget only when returnGeometry is explicitly true', () => {
    const without = planner().plan({ ...base(), requestedFields: [], popupFields: [], sortFields: [], estimatedRecordCount: 10, returnGeometry: false });
    const withGeometry = planner().plan({ ...base(), requestedFields: [], popupFields: [], sortFields: [], estimatedRecordCount: 10, returnGeometry: true });
    expect(without.estimatedGeometryBytes).toBe(0);
    expect(withGeometry.estimatedGeometryBytes).toBe(5_120);
    expect(withGeometry.estimatedTotalBytes).toBe(withGeometry.estimatedAttributeBytes + 5_120);
  });

  it('rejects estimated attribute payload over policy before issuing a query', () => {
    const constrained = new ArcGisQueryProjectionPlanner({ ...policy, maxEstimatedAttributeBytes: 100 });
    expect(() => constrained.plan({ ...base(), estimatedRecordCount: 10 })).toThrow('estimated attribute payload exceeds policy');
  });

  it('rejects estimated geometry payload over policy before issuing a query', () => {
    const constrained = new ArcGisQueryProjectionPlanner({ ...policy, maxEstimatedGeometryBytes: 1_000 });
    expect(() => constrained.plan({ ...base(), requestedFields: [], popupFields: [], sortFields: [], returnGeometry: true, estimatedRecordCount: 2 })).toThrow('estimated geometry payload exceeds policy');
  });

  it('rejects combined payload over the total byte budget', () => {
    const constrained = new ArcGisQueryProjectionPlanner({ ...policy, maxEstimatedTotalBytes: 600 });
    expect(() => constrained.plan({ ...base(), requestedFields: [], popupFields: [], sortFields: [], returnGeometry: true, estimatedRecordCount: 2 })).toThrow('estimated query payload exceeds policy');
  });

  it('enforces requested, popup, sort, statistic and groupBy cardinality budgets', () => {
    const constrained = new ArcGisQueryProjectionPlanner({ ...policy, maxPopupFields: 1, maxSortFields: 1, maxStatistics: 1, maxGroupByFields: 1 });
    expect(() => constrained.plan({ ...base(), popupFields: ['NAME', 'CATEGORY'] })).toThrow('popup field count outside configured bounds');
    expect(() => constrained.plan({ ...base(), sortFields: [{ fieldName: 'VALUE', direction: 'ASC' }, { fieldName: 'COUNT', direction: 'DESC' }] })).toThrow('sort field count outside configured bounds');
    expect(() => constrained.plan({ ...base(), statistics: [{ fieldName: 'VALUE', statisticType: 'sum', outputFieldName: 'a' }, { fieldName: 'COUNT', statisticType: 'sum', outputFieldName: 'b' }] })).toThrow('statistics count outside configured bounds');
    expect(() => constrained.plan({ ...base(), groupByFields: ['NAME', 'CATEGORY'] })).toThrow('groupBy field count outside configured bounds');
  });

  it('rejects invalid sort directions and unsupported statistic types', () => {
    expect(() => planner().plan({ ...base(), sortFields: [{ fieldName: 'VALUE', direction: 'SIDEWAYS' as never }] })).toThrow('invalid sort direction');
    expect(() => planner().plan({ ...base(), statistics: [{ fieldName: 'VALUE', statisticType: 'median' as never, outputFieldName: 'median_value' }] })).toThrow('unsupported statistic type');
  });

  it('rejects duplicate available fields before creating a projection', () => {
    expect(() => planner().plan({ ...base(), availableFields: [...fields, fields[0]!] })).toThrow('duplicate available field');
  });

  it('rejects unsafe record counts and malformed returnGeometry flags', () => {
    expect(() => planner().plan({ ...base(), estimatedRecordCount: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => planner().plan({ ...base(), returnGeometry: 'yes' as never })).toThrow('returnGeometry must be boolean');
  });

  it('returns immutable projection arrays', () => {
    const plan = planner().plan(base());
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.outFields)).toBe(true);
    expect(Object.isFrozen(plan.orderByFields)).toBe(true);
    expect(Object.isFrozen(plan.statistics)).toBe(true);
    expect(Object.isFrozen(plan.groupByFields)).toBe(true);
  });
});
