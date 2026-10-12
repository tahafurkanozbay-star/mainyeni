import { describe, expect, it } from 'vitest';
import { auditLayerListCatalog, summarizeLayerListCatalogAudit } from './layerListCatalogAudit';
import type { LayerListGroupInput } from './layerListExperienceModel';

const VALID: readonly LayerListGroupInput[] = [{
  id: 'base',
  title: 'Temel',
  layers: [
    { id: 'roads', title: 'Yollar', visible: true, opacity: 100 },
    { id: 'parks', title: 'Parklar', visible: false, opacity: 75 },
  ],
}];

describe('auditLayerListCatalog', () => {
  it('accepts a valid bounded catalog', () => {
    expect(auditLayerListCatalog(VALID)).toEqual({
      valid: true,
      findingCount: 0,
      errorCount: 0,
      warningCount: 0,
      findings: [],
    });
  });

  it('flags duplicate group ids as errors', () => {
    const result = auditLayerListCatalog([VALID[0]!, { ...VALID[0]!, title: 'Kopya' }]);
    expect(result.valid).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'duplicate-group-id',
      severity: 'error',
      groupId: 'base',
    }));
  });

  it('allows the same layer id in different groups', () => {
    const result = auditLayerListCatalog([
      VALID[0]!,
      { id: 'other', title: 'Diğer', layers: [{ id: 'roads', title: 'Yollar', visible: true, opacity: 100 }] },
    ]);
    expect(result.findings.some((item) => item.code === 'duplicate-layer-id')).toBe(false);
  });

  it('flags duplicate layer ids within a group', () => {
    const result = auditLayerListCatalog([{
      id: 'x',
      title: 'X',
      layers: [
        { id: 'dup', title: 'A', visible: true, opacity: 100 },
        { id: 'dup', title: 'B', visible: false, opacity: 80 },
      ],
    }]);
    expect(result.valid).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'duplicate-layer-id',
      groupId: 'x',
      layerId: 'dup',
    }));
  });

  it('reports empty group titles as warnings', () => {
    const result = auditLayerListCatalog([{ ...VALID[0]!, title: '   ' }]);
    expect(result.valid).toBe(true);
    expect(result.warningCount).toBe(1);
    expect(result.findings[0]?.code).toBe('empty-group-title');
  });

  it('reports empty layer titles as warnings', () => {
    const result = auditLayerListCatalog([{
      ...VALID[0]!,
      layers: [{ id: 'a', title: '', visible: true, opacity: 100 }],
    }]);
    expect(result.valid).toBe(true);
    expect(result.findings[0]?.code).toBe('empty-layer-title');
  });

  it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY])('reports invalid opacity %s', (opacity) => {
    const result = auditLayerListCatalog([{
      ...VALID[0]!,
      layers: [{ id: 'a', title: 'A', visible: true, opacity }],
    }]);
    expect(result.findings[0]?.code).toBe('invalid-opacity');
    expect(result.warningCount).toBe(1);
  });

  it('enforces the group budget', () => {
    const result = auditLayerListCatalog([
      VALID[0]!,
      { id: 'two', title: 'İki', layers: [] },
    ], { maxGroups: 1 });
    expect(result.valid).toBe(false);
    expect(result.findings.some((item) => item.code === 'group-budget-exceeded')).toBe(true);
  });

  it('enforces the total layer budget', () => {
    const result = auditLayerListCatalog(VALID, { maxLayers: 1 });
    expect(result.valid).toBe(false);
    expect(result.findings.some((item) => item.code === 'layer-budget-exceeded')).toBe(true);
  });

  it('clamps nonsensical budgets to bounded positive values', () => {
    const result = auditLayerListCatalog(VALID, { maxGroups: -20, maxLayers: -20 });
    expect(result.valid).toBe(false);
    expect(result.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
      'layer-budget-exceeded',
    ]));
  });

  it('returns frozen findings and result snapshots', () => {
    const result = auditLayerListCatalog(VALID);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.findings)).toBe(true);
  });

  it('does not include titles, URLs, tokens or arbitrary source payloads in findings', () => {
    const result = auditLayerListCatalog([{
      id: 'dup',
      title: '',
      layers: [
        { id: 'x', title: 'https://example.invalid?token=SECRET', visible: true, opacity: 200 },
        { id: 'x', title: 'SECRET', visible: true, opacity: 100 },
      ],
    }]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('https://');
  });

  it('summarizes findings as scalar codes for diagnostics', () => {
    const result = auditLayerListCatalog([{
      id: 'x',
      title: '',
      layers: [{ id: 'a', title: '', visible: true, opacity: 200 }],
    }]);
    expect(summarizeLayerListCatalogAudit(result)).toEqual({
      valid: true,
      findingCount: 3,
      errorCount: 0,
      warningCount: 3,
      codes: ['empty-group-title', 'empty-layer-title', 'invalid-opacity'],
    });
  });

  it('preserves deterministic finding order', () => {
    const input: readonly LayerListGroupInput[] = [{
      id: 'x',
      title: '',
      layers: [
        { id: 'a', title: '', visible: true, opacity: 200 },
        { id: 'a', title: 'B', visible: true, opacity: 50 },
      ],
    }];
    expect(auditLayerListCatalog(input).findings.map((item) => item.code)).toEqual([
      'empty-group-title',
      'empty-layer-title',
      'invalid-opacity',
      'duplicate-layer-id',
    ]);
  });
});
