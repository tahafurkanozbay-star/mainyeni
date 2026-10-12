import { describe, expect, it } from 'vitest';
import type { UnknownRecord } from '../../../Business/contracts';
import {
  auditGeneralSearchResponseIntegrityV11,
  inspectGeneralSearchRecordSurfaceV11,
  summarizeGeneralSearchIntegrityV11,
} from './GenelAramaResponseIntegrityV11';

const record = (value: Record<string, unknown>): UnknownRecord => Object.freeze({ ...value });

describe('Genel Arama response integrity v11', () => {
  it('accepts ordinary general-search rows without traversing nested geometry/attribute graphs', () => {
    const nested = {
      deep: {
        intentionally: {
          not: {
            recursively: 'walked',
          },
        },
      },
    };
    const rows = [
      record({
        id: 1,
        title: 'Ankara Kalesi',
        address: 'Altındağ',
        attr: nested,
        geometry: { x: 32.864, y: 39.938 },
      }),
      record({
        id: 2,
        title: 'Gençlik Parkı',
        categories: ['park', 'recreation'],
      }),
    ];

    const report = auditGeneralSearchResponseIntegrityV11(rows);

    expect(report.accepted).toBe(true);
    expect(report.recordCount).toBe(2);
    expect(report.inspectedRecords).toBe(2);
    expect(report.totalKeys).toBe(8);
    expect(report.totalStringCharacters).toBeGreaterThan(0);
    expect(report.totalArrayItems).toBe(2);
    expect(report.violations).toEqual([]);
    expect(report.fingerprint).toMatch(/^[a-zA-Z0-9_-]+|^[0-9a-f]+$/);
  });

  it('counts only shallow string and array surfaces', () => {
    const row = record({
      title: 'abc',
      tags: ['a', 'b', 'c'],
      nested: {
        huge: 'x'.repeat(100_000),
        array: new Array(50_000).fill('hidden'),
      },
    });

    const report = auditGeneralSearchResponseIntegrityV11([row], {
      maximumStringCharacters: 10,
      maximumArrayItems: 10,
    });

    expect(report.accepted).toBe(true);
    expect(report.totalStringCharacters).toBe(3);
    expect(report.totalArrayItems).toBe(3);
  });

  it('rejects a record with excessive top-level key cardinality', () => {
    const row: Record<string, unknown> = {};
    for (let index = 0; index < 20; index += 1) {
      row[`field-${index}`] = index;
    }

    const report = auditGeneralSearchResponseIntegrityV11(
      [record(row)],
      { maximumKeysPerRecord: 8 },
    );

    expect(report.accepted).toBe(false);
    expect(report.violations).toEqual([
      expect.objectContaining({
        code: 'record-key-budget',
        recordIndex: 0,
        observed: 20,
        maximum: 8,
      }),
    ]);
    expect(summarizeGeneralSearchIntegrityV11(report)).toContain('record-key-budget');
  });

  it('rejects oversized top-level strings', () => {
    const report = auditGeneralSearchResponseIntegrityV11(
      [record({ title: 'x'.repeat(300), address: 'ok' })],
      { maximumStringCharacters: 256 },
    );

    expect(report.accepted).toBe(false);
    expect(report.violations[0]).toMatchObject({
      code: 'string-size-budget',
      recordIndex: 0,
      field: 'title',
      observed: 300,
      maximum: 256,
    });
  });

  it('rejects oversized top-level arrays without iterating their contents', () => {
    const tags = new Array(30).fill('value');
    const report = auditGeneralSearchResponseIntegrityV11(
      [record({ id: 1, tags })],
      { maximumArrayItems: 10 },
    );

    expect(report.accepted).toBe(false);
    expect(report.totalArrayItems).toBe(30);
    expect(report.violations).toEqual([
      expect.objectContaining({
        code: 'array-size-budget',
        field: 'tags',
        observed: 30,
        maximum: 10,
      }),
    ]);
  });

  it('enforces aggregate string budget across otherwise-valid records', () => {
    const rows = [
      record({ title: 'a'.repeat(600) }),
      record({ title: 'b'.repeat(600) }),
    ];
    const report = auditGeneralSearchResponseIntegrityV11(rows, {
      maximumStringCharacters: 1_000,
      maximumAggregateStringCharacters: 1_024,
    });

    expect(report.accepted).toBe(false);
    expect(report.totalStringCharacters).toBe(1_200);
    expect(report.violations).toContainEqual(expect.objectContaining({
      code: 'aggregate-string-budget',
      recordIndex: -1,
      observed: 1_200,
      maximum: 1_024,
    }));
  });

  it('enforces aggregate array-item budget across otherwise-valid records', () => {
    const rows = [
      record({ tags: new Array(6).fill('a') }),
      record({ tags: new Array(6).fill('b') }),
    ];
    const report = auditGeneralSearchResponseIntegrityV11(rows, {
      maximumArrayItems: 10,
      maximumAggregateArrayItems: 10,
    });

    expect(report.accepted).toBe(false);
    expect(report.totalArrayItems).toBe(12);
    expect(report.violations).toContainEqual(expect.objectContaining({
      code: 'aggregate-array-budget',
      observed: 12,
      maximum: 10,
    }));
  });

  it('bounds retained violation details even when many records are hostile', () => {
    const rows = Array.from({ length: 50 }, (_value, index) => record({
      id: index,
      title: 'x'.repeat(300),
      tags: new Array(20).fill('tag'),
    }));
    const report = auditGeneralSearchResponseIntegrityV11(rows, {
      maximumStringCharacters: 256,
      maximumArrayItems: 10,
      maximumViolations: 5,
    });

    expect(report.accepted).toBe(false);
    expect(report.violations).toHaveLength(5);
    expect(report.violationOverflow).toBe(true);
    expect(summarizeGeneralSearchIntegrityV11(report)).toContain('violation-overflow');
  });

  it('produces deterministic fingerprints for equivalent scalar integrity facts', () => {
    const rows = [
      record({ id: 1, title: 'Bir' }),
      record({ id: 2, title: 'İki' }),
    ];

    const first = auditGeneralSearchResponseIntegrityV11(rows);
    const second = auditGeneralSearchResponseIntegrityV11(rows);

    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('changes fingerprint when integrity facts change', () => {
    const first = auditGeneralSearchResponseIntegrityV11([
      record({ id: 1, title: 'Bir' }),
    ]);
    const second = auditGeneralSearchResponseIntegrityV11([
      record({ id: 1, title: 'Biraz daha uzun' }),
    ]);

    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it('exposes a reusable record-surface inspector for admission diagnostics', () => {
    const violations: Parameters<typeof inspectGeneralSearchRecordSurfaceV11>[3] = [];
    const inspection = inspectGeneralSearchRecordSurfaceV11(
      record({
        title: 'Müze',
        address: 'Ulus',
        tags: ['culture', 'history'],
      }),
      7,
      {
        maximumKeysPerRecord: 20,
        maximumStringCharacters: 100,
        maximumArrayItems: 10,
      },
      violations,
    );

    expect(inspection.surface).toEqual({
      recordIndex: 7,
      keyCount: 3,
      stringCharacters: 8,
      arrayItems: 2,
      oversizedStrings: 0,
      oversizedArrays: 0,
    });
    expect(inspection.overflowedViolationBudget).toBe(false);
    expect(violations).toEqual([]);
  });
});

describe('Genel Arama response integrity v11 boundary behavior', () => {
  it('accepts exactly-at-limit strings and arrays', () => {
    const report = auditGeneralSearchResponseIntegrityV11(
      [record({
        text: 'x'.repeat(256),
        items: new Array(10).fill(null),
      })],
      {
        maximumStringCharacters: 256,
        maximumArrayItems: 10,
        maximumAggregateStringCharacters: 1_000,
        maximumAggregateArrayItems: 100,
      },
    );

    expect(report.accepted).toBe(true);
  });

  it('rejects one-above-limit strings and arrays', () => {
    const report = auditGeneralSearchResponseIntegrityV11(
      [record({
        text: 'x'.repeat(257),
        items: new Array(11).fill(null),
      })],
      {
        maximumStringCharacters: 256,
        maximumArrayItems: 10,
      },
    );

    expect(report.accepted).toBe(false);
    expect(report.violations.map(item => item.code)).toEqual([
      'string-size-budget',
      'array-size-budget',
    ]);
  });

  it('does not retain original field values in violation diagnostics', () => {
    const secretLikeValue = 'token-like-sensitive-value'.repeat(20);
    const report = auditGeneralSearchResponseIntegrityV11(
      [record({ payload: secretLikeValue })],
      { maximumStringCharacters: 256 },
    );

    const serialized = JSON.stringify(report.violations);
    expect(serialized).not.toContain('token-like-sensitive-value');
    expect(serialized).toContain('"observed"');
    expect(serialized).toContain('"maximum"');
  });

  it('keeps field names bounded in record-level violations', () => {
    const longField = 'field'.repeat(100);
    const report = auditGeneralSearchResponseIntegrityV11(
      [record({ [longField]: 'x'.repeat(300) })],
      { maximumStringCharacters: 256 },
    );

    expect(report.violations[0]?.field.length).toBeLessThanOrEqual(160);
  });

  it('treats zero records as a healthy bounded response', () => {
    const report = auditGeneralSearchResponseIntegrityV11([]);
    expect(report).toMatchObject({
      accepted: true,
      recordCount: 0,
      inspectedRecords: 0,
      totalKeys: 0,
      totalStringCharacters: 0,
      totalArrayItems: 0,
      violationCount: 0,
      violationOverflow: false,
    });
  });

  it('stays deterministic at large but bounded record counts', () => {
    const rows = Array.from({ length: 5_000 }, (_value, index) => record({
      id: index,
      title: `Kayıt ${index}`,
      category: index % 2 === 0 ? 'A' : 'B',
    }));

    const first = auditGeneralSearchResponseIntegrityV11(rows);
    const second = auditGeneralSearchResponseIntegrityV11(rows);

    expect(first.accepted).toBe(true);
    expect(first.inspectedRecords).toBe(5_000);
    expect(first.fingerprint).toBe(second.fingerprint);
  });
});
