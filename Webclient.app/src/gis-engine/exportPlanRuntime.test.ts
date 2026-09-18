import { describe, expect, it } from 'vitest';

import { createGisExportRuntime } from './exportPlanRuntime';

describe('createGisExportRuntime', () => {
  it('plans default A4 PNG exports with bounded dimensions', () => {
    const runtime = createGisExportRuntime();

    const plan = runtime.plan({
      mode: '2d',
      format: 'png',
    });

    expect(plan).toMatchObject({
      format: 'png',
      mimeType: 'image/png',
      mode: '2d',
      strategy: 'map-screenshot',
      pageSize: 'a4',
      orientation: 'portrait',
      dpi: 150,
      jpegQuality: null,
      includeLegend: false,
      includeScaleBar: true,
      includeAttribution: true,
      transparentBackground: false,
    });
    expect(plan.widthPx).toBeGreaterThan(1000);
    expect(plan.heightPx).toBeGreaterThan(plan.widthPx);
    expect(plan.pixelCount).toBe(plan.widthPx * plan.heightPx);
    expect(plan.estimatedWorkingBytes).toBeGreaterThan(plan.pixelCount * 4);
    expect(plan.fingerprint).toBeTruthy();
  });

  it('uses SceneView screenshot strategy for 3D raster exports', () => {
    const runtime = createGisExportRuntime();

    const plan = runtime.plan({
      mode: '3d',
      format: 'jpeg',
      pageSize: 'custom',
      widthPx: 1920,
      heightPx: 1080,
    });

    expect(plan.strategy).toBe('scene-screenshot');
    expect(plan.mimeType).toBe('image/jpeg');
    expect(plan.jpegQuality).toBe(0.9);
  });

  it('uses composed-document strategy for PDF output without inventing a print endpoint', () => {
    const runtime = createGisExportRuntime();

    const plan = runtime.plan({
      mode: '2d',
      format: 'pdf',
      includeLegend: true,
    });

    expect(plan.strategy).toBe('composed-document');
    expect(plan.mimeType).toBe('application/pdf');
    expect(plan.jpegQuality).toBeNull();
    expect(plan.includeLegend).toBe(true);
    expect(JSON.stringify(plan)).not.toMatch(/https?:\/\//i);
  });

  it('warns when a 3D PDF requires raster scene composition', () => {
    const runtime = createGisExportRuntime();

    const plan = runtime.plan({
      mode: '3d',
      format: 'pdf',
    });

    expect(plan.warnings).toContain(
      '3D PDF output is composed from a raster scene snapshot plus document overlays.',
    );
  });

  it('resolves landscape page dimensions by swapping portrait dimensions', () => {
    const runtime = createGisExportRuntime();

    const portrait = runtime.plan({
      mode: '2d',
      format: 'png',
      pageSize: 'a4',
      orientation: 'portrait',
      dpi: 100,
    });
    const landscape = runtime.plan({
      mode: '2d',
      format: 'png',
      pageSize: 'a4',
      orientation: 'landscape',
      dpi: 100,
    });

    expect(landscape.widthPx).toBe(portrait.heightPx);
    expect(landscape.heightPx).toBe(portrait.widthPx);
  });

  it('supports A3 and letter page presets', () => {
    const runtime = createGisExportRuntime();

    const a3 = runtime.plan({
      mode: '2d',
      format: 'png',
      pageSize: 'a3',
      dpi: 100,
    });
    const letter = runtime.plan({
      mode: '2d',
      format: 'png',
      pageSize: 'letter',
      dpi: 100,
    });

    expect(a3.pixelCount).toBeGreaterThan(letter.pixelCount);
  });

  it('requires explicit positive dimensions for custom output', () => {
    const runtime = createGisExportRuntime();

    expect(() => runtime.plan({
      mode: '2d',
      format: 'png',
      pageSize: 'custom',
      widthPx: 0,
      heightPx: 100,
    })).toThrow(/dimensions must be positive/i);

    expect(() => runtime.plan({
      mode: '2d',
      format: 'png',
      pageSize: 'custom',
      heightPx: 100,
    })).toThrow(/width must be finite/i);
  });

  it('infers custom page size when pixel dimensions are supplied', () => {
    const runtime = createGisExportRuntime();

    const plan = runtime.plan({
      mode: '2d',
      format: 'png',
      widthPx: 800,
      heightPx: 600,
    });

    expect(plan.pageSize).toBe('custom');
    expect(plan.widthPx).toBe(800);
    expect(plan.heightPx).toBe(600);
  });

  it('clamps DPI to a configured safe range', () => {
    const runtime = createGisExportRuntime({
      maxDpi: 240,
    });

    const high = runtime.plan({
      mode: '2d',
      format: 'png',
      dpi: 1200,
    });
    const low = runtime.plan({
      mode: '2d',
      format: 'png',
      dpi: 1,
    });

    expect(high.dpi).toBe(240);
    expect(low.dpi).toBe(36);
  });

  it('adds a high-DPI performance warning', () => {
    const runtime = createGisExportRuntime();

    const plan = runtime.plan({
      mode: '2d',
      format: 'png',
      dpi: 250,
    });

    expect(plan.warnings).toContain(
      'High-DPI exports increase GPU readback and browser memory pressure.',
    );
  });

  it('enforces the maximum output dimension', () => {
    const runtime = createGisExportRuntime({
      maxDimensionPx: 1000,
      maxPixelCount: 10_000_000,
    });

    expect(() => runtime.plan({
      mode: '2d',
      format: 'png',
      pageSize: 'custom',
      widthPx: 1001,
      heightPx: 100,
    })).toThrow(/dimension exceeds/i);
  });

  it('enforces the pixel-count budget', () => {
    const runtime = createGisExportRuntime({
      maxDimensionPx: 10_000,
      maxPixelCount: 1_000_000,
    });

    expect(() => runtime.plan({
      mode: '2d',
      format: 'png',
      pageSize: 'custom',
      widthPx: 2000,
      heightPx: 1000,
    })).toThrow(/pixel budget exceeded/i);
  });

  it('enforces estimated working-memory budgets', () => {
    const runtime = createGisExportRuntime({
      maxDimensionPx: 10_000,
      maxPixelCount: 10_000_000,
      maxWorkingBytes: 1_000_000,
    });

    expect(() => runtime.plan({
      mode: '2d',
      format: 'png',
      pageSize: 'custom',
      widthPx: 1000,
      heightPx: 1000,
    })).toThrow(/working-memory budget/i);
  });

  it('estimates PDF working memory above raster JPEG memory for equal dimensions', () => {
    const runtime = createGisExportRuntime();

    const jpeg = runtime.estimateWorkingBytes(1000, 1000, 'jpeg');
    const png = runtime.estimateWorkingBytes(1000, 1000, 'png');
    const pdf = runtime.estimateWorkingBytes(1000, 1000, 'pdf');

    expect(png).toBeGreaterThan(jpeg);
    expect(pdf).toBeGreaterThan(png);
  });

  it('normalizes visible layers deterministically by order and id', () => {
    const runtime = createGisExportRuntime();

    const plan = runtime.plan({
      mode: '2d',
      format: 'png',
      layers: [
        {
          layerId: 'zeta',
          visible: true,
          opacity: 2,
          order: 4,
          title: 'Zeta',
        },
        {
          layerId: 'alpha',
          visible: false,
          opacity: -1,
          order: 1,
          title: 'Alpha',
        },
      ],
    });

    expect(plan.layers).toEqual([
      {
        layerId: 'alpha',
        visible: false,
        opacity: 0,
        order: 1,
        title: 'Alpha',
      },
      {
        layerId: 'zeta',
        visible: true,
        opacity: 1,
        order: 4,
        title: 'Zeta',
      },
    ]);
  });

  it('enforces layer-count budgets', () => {
    const runtime = createGisExportRuntime({
      maxLayers: 1,
    });

    expect(() => runtime.plan({
      mode: '2d',
      format: 'png',
      layers: [
        { layerId: 'one' },
        { layerId: 'two' },
      ],
    })).toThrow(/layer budget exceeded/i);
  });

  it('warns when visible layer counts are unusually high', () => {
    const runtime = createGisExportRuntime({
      maxLayers: 100,
    });

    const plan = runtime.plan({
      mode: '2d',
      format: 'png',
      layers: Array.from({ length: 65 }, (_, index) => ({
        layerId: `layer-${index}`,
        visible: true,
        order: index,
      })),
    });

    expect(plan.warnings).toContain(
      'Large visible-layer counts can materially increase export render time.',
    );
  });

  it('normalizes extent and preserves its spatial reference contract', () => {
    const runtime = createGisExportRuntime();

    const plan = runtime.plan({
      mode: '2d',
      format: 'png',
      extent: {
        xmin: 30,
        ymin: 39,
        xmax: 34,
        ymax: 41,
        spatialReferenceWkid: 4326,
      },
    });

    expect(plan.extent).toEqual({
      xmin: 30,
      ymin: 39,
      xmax: 34,
      ymax: 41,
      spatialReferenceWkid: 4326,
    });
  });

  it('rejects zero-area or inverted extents', () => {
    const runtime = createGisExportRuntime();

    expect(() => runtime.plan({
      mode: '2d',
      format: 'png',
      extent: {
        xmin: 10,
        ymin: 10,
        xmax: 10,
        ymax: 20,
        spatialReferenceWkid: 4326,
      },
    })).toThrow(/positive width and height/i);
  });

  it('rejects invalid extent spatial references', () => {
    const runtime = createGisExportRuntime();

    expect(() => runtime.plan({
      mode: '2d',
      format: 'png',
      extent: {
        xmin: 0,
        ymin: 0,
        xmax: 1,
        ymax: 1,
        spatialReferenceWkid: 0,
      },
    })).toThrow(/wkid/i);
  });

  it('requires a positive map scale when scale is persisted', () => {
    const runtime = createGisExportRuntime();

    expect(() => runtime.plan({
      mode: '2d',
      format: 'png',
      scale: 0,
    })).toThrow(/scale must be positive/i);
  });

  it('clamps JPEG quality to a safe codec range', () => {
    const runtime = createGisExportRuntime();

    expect(runtime.plan({
      mode: '2d',
      format: 'jpeg',
      jpegQuality: 5,
    }).jpegQuality).toBe(1);

    expect(runtime.plan({
      mode: '2d',
      format: 'jpeg',
      jpegQuality: 0,
    }).jpegQuality).toBe(0.1);
  });

  it('ignores JPEG quality for non-JPEG formats', () => {
    const runtime = createGisExportRuntime();

    expect(runtime.plan({
      mode: '2d',
      format: 'png',
      jpegQuality: 0.2,
    }).jpegQuality).toBeNull();
  });

  it('allows transparent background only for PNG output', () => {
    const runtime = createGisExportRuntime();

    expect(runtime.plan({
      mode: '2d',
      format: 'png',
      transparentBackground: true,
    }).transparentBackground).toBe(true);

    expect(runtime.plan({
      mode: '2d',
      format: 'jpeg',
      transparentBackground: true,
    }).transparentBackground).toBe(false);
  });

  it('warns when 3D transparent background support depends on renderer capabilities', () => {
    const runtime = createGisExportRuntime();

    const plan = runtime.plan({
      mode: '3d',
      format: 'png',
      transparentBackground: true,
    });

    expect(plan.warnings).toContain(
      '3D transparent background support depends on the active SceneView renderer.',
    );
  });

  it('truncates overly long titles according to configuration', () => {
    const runtime = createGisExportRuntime({
      maxTitleLength: 8,
    });

    const plan = runtime.plan({
      mode: '2d',
      format: 'png',
      title: '1234567890',
    });

    expect(plan.title).toBe('12345678');
  });

  it('generates stable fingerprints for semantically identical layer ordering', () => {
    const runtime = createGisExportRuntime();
    const layers = [
      { layerId: 'b', order: 2 },
      { layerId: 'a', order: 1 },
    ];

    const first = runtime.plan({
      mode: '2d',
      format: 'png',
      layers,
    });
    const second = runtime.plan({
      mode: '2d',
      format: 'png',
      layers: [...layers].reverse(),
    });

    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('changes the fingerprint when output dimensions change', () => {
    const runtime = createGisExportRuntime();

    const first = runtime.plan({
      mode: '2d',
      format: 'png',
      pageSize: 'custom',
      widthPx: 800,
      heightPx: 600,
    });
    const second = runtime.plan({
      mode: '2d',
      format: 'png',
      pageSize: 'custom',
      widthPx: 801,
      heightPx: 600,
    });

    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('rejects unsupported runtime format values', () => {
    const runtime = createGisExportRuntime();

    expect(() => runtime.plan({
      mode: '2d',
      format: 'tiff' as 'png',
    })).toThrow(/unsupported GIS export format/i);
  });

  it('rejects unsupported runtime page size values', () => {
    const runtime = createGisExportRuntime();

    expect(() => runtime.plan({
      mode: '2d',
      format: 'png',
      pageSize: 'poster' as 'a4',
    })).toThrow(/unsupported GIS export page size/i);
  });

  it('rejects unsupported runtime map modes', () => {
    const runtime = createGisExportRuntime();

    expect(() => runtime.plan({
      mode: '4d' as '2d',
      format: 'png',
    })).toThrow(/mode must be either 2d or 3d/i);
  });

  it('keeps attribution enabled by default for compliant exports', () => {
    const runtime = createGisExportRuntime();

    expect(runtime.plan({
      mode: '2d',
      format: 'png',
    }).includeAttribution).toBe(true);

    expect(runtime.plan({
      mode: '2d',
      format: 'png',
      includeAttribution: false,
    }).includeAttribution).toBe(false);
  });

  it('keeps scale bar enabled by default but lets callers opt out', () => {
    const runtime = createGisExportRuntime();

    expect(runtime.plan({
      mode: '2d',
      format: 'png',
    }).includeScaleBar).toBe(true);

    expect(runtime.plan({
      mode: '2d',
      format: 'png',
      includeScaleBar: false,
    }).includeScaleBar).toBe(false);
  });

  it('returns deeply immutable plan collections', () => {
    const runtime = createGisExportRuntime();

    const plan = runtime.plan({
      mode: '2d',
      format: 'png',
      layers: [{ layerId: 'one' }],
    });

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.layers)).toBe(true);
    expect(Object.isFrozen(plan.layers[0])).toBe(true);
    expect(Object.isFrozen(plan.warnings)).toBe(true);
  });
});
