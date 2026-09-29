import { describe, expect, it } from 'vitest';
import { planArcGisExport, type ArcGisExportRequest } from './ArcGisExportPolicy';

const request = (overrides: Partial<ArcGisExportRequest> = {}): ArcGisExportRequest => ({
  expectedRevision: 7,
  mode: '2d',
  format: 'png',
  width: 1200,
  height: 800,
  pixelRatio: 2,
  mapScale: 10_000,
  includeLegend: true,
  includeAttribution: true,
  layers: [{ id: 'roads', revision: 7, visible: true, exportable: true, priority: 1 }],
  ...overrides,
});

describe('planArcGisExport', () => {
  it('builds an immutable deterministic export plan', () => {
    const first = planArcGisExport(request());
    const second = planArcGisExport(request());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.plan.fingerprint).toBe(second.plan.fingerprint);
    expect(first.plan.outputPixels).toBe(3_840_000);
    expect(Object.isFrozen(first.plan)).toBe(true);
    expect(Object.isFrozen(first.plan.layerIds)).toBe(true);
  });

  it('orders layers by priority then id', () => {
    const decision = planArcGisExport(request({ layers: [
      { id: 'z', revision: 7, visible: true, exportable: true, priority: 2 },
      { id: 'a', revision: 7, visible: true, exportable: true, priority: 2 },
      { id: 'b', revision: 7, visible: true, exportable: true, priority: 1 },
    ] }));
    expect(decision.ok && decision.plan.layerIds).toEqual(['a', 'z', 'b']);
  });

  it.each([
    [{ expectedRevision: -1 }, 'invalid-revision'],
    [{ mapScale: 0 }, 'invalid-map-scale'],
    [{ width: 0 }, 'width-budget-exceeded'],
    [{ height: 0 }, 'height-budget-exceeded'],
    [{ pixelRatio: 0 }, 'pixel-ratio-budget-exceeded'],
    [{ pixelRatio: 5 }, 'pixel-ratio-budget-exceeded'],
  ] as const)('rejects invalid request boundary %#', (override, reason) => {
    expect(planArcGisExport(request(override))).toEqual({ ok: false, reason });
  });

  it('rejects stale revisions before export', () => {
    expect(planArcGisExport(request({ layers: [{ id: 'roads', revision: 6, visible: true, exportable: true }] })))
      .toEqual({ ok: false, reason: 'stale-layer-revision' });
  });

  it('rejects duplicate normalized ids', () => {
    expect(planArcGisExport(request({ layers: [
      { id: 'roads', revision: 7, visible: true, exportable: true },
      { id: ' roads ', revision: 7, visible: true, exportable: true },
    ] }))).toEqual({ ok: false, reason: 'duplicate-layer' });
  });

  it('filters hidden, non-exportable and scale-ineligible layers', () => {
    expect(planArcGisExport(request({ layers: [
      { id: 'hidden', revision: 7, visible: false, exportable: true },
      { id: 'locked', revision: 7, visible: true, exportable: false },
      { id: 'scale', revision: 7, visible: true, exportable: true, minScale: 5_000 },
    ] }))).toEqual({ ok: false, reason: 'no-exportable-layers' });
  });

  it('fails closed on output pixel budget', () => {
    expect(planArcGisExport(request({ width: 5000, height: 5000, pixelRatio: 2 })))
      .toEqual({ ok: false, reason: 'pixel-budget-exceeded' });
  });

  it('fails closed on estimated byte budget', () => {
    expect(planArcGisExport(request({ width: 100, height: 100, pixelRatio: 1 }), {
      maxLayers: 2, maxWidth: 1000, maxHeight: 1000, maxPixelRatio: 2,
      maxOutputPixels: 100_000, maxEstimatedBytes: 20_000, estimatedBytesPerPixel: 4,
    })).toEqual({ ok: false, reason: 'byte-budget-exceeded' });
  });

  it('changes fingerprint when output semantics change', () => {
    const first = planArcGisExport(request());
    const second = planArcGisExport(request({ format: 'pdf' }));
    expect(first.ok && second.ok && first.plan.fingerprint).not.toBe(second.ok && second.plan.fingerprint);
  });

  it('does not mutate caller-owned layer order', () => {
    const layers = [
      { id: 'b', revision: 7, visible: true, exportable: true, priority: 1 },
      { id: 'a', revision: 7, visible: true, exportable: true, priority: 2 },
    ];
    planArcGisExport(request({ layers }));
    expect(layers.map(({ id }) => id)).toEqual(['b', 'a']);
  });
});
