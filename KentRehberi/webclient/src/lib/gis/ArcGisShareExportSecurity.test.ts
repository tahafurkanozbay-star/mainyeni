import { describe, expect, it } from 'vitest';
import { ArcGisExportJobCoordinator, type ArcGisExportPolicy } from './ArcGisExportJobCoordinator';
import { ArcGisShareStateCoordinator, type ArcGisSharePolicy } from './ArcGisShareStateCoordinator';

const exportPolicy: ArcGisExportPolicy = {
  maxJobs: 3,
  maxIdLength: 16,
  maxTitleLength: 24,
  maxResultTokenLength: 32,
  maxFailureCodeLength: 24,
  maxWidthPx: 2048,
  maxHeightPx: 2048,
  maxPixelCount: 2_000_000,
  minDpi: 72,
  maxDpi: 200,
  retentionMs: 500,
  maxClockSkewMs: 5,
};

const sharePolicy: ArcGisSharePolicy = {
  maxStates: 3,
  maxLayersPerState: 2,
  maxIdLength: 16,
  maxLayerKeyLength: 20,
  retentionMs: 500,
  maxClockSkewMs: 5,
};

const extent = {
  xmin: 0,
  ymin: 0,
  xmax: 10,
  ymax: 10,
  wkid: 4326,
} as const;

const camera = {
  x: 29,
  y: 41,
  z: null,
  heading: null,
  tilt: null,
  wkid: 4326,
} as const;

describe('ArcGIS share/export security boundaries', () => {
  it('does not accept null bytes in export title', () => {
    const coordinator = new ArcGisExportJobCoordinator(exportPolicy);
    expect(() => coordinator.create({
      id: 'safe',
      title: 'bad\0title',
      format: 'pdf',
      viewMode: '2d',
      extent,
      widthPx: 100,
      heightPx: 100,
      dpi: 96,
    }, 1)).toThrow(/bounds/);
  });

  it('does not accept null bytes in export result tokens', () => {
    const coordinator = new ArcGisExportJobCoordinator(exportPolicy);
    coordinator.create({ id: 'a', title: 'A', format: 'pdf', viewMode: '2d', extent, widthPx: 100, heightPx: 100, dpi: 96 }, 1);
    coordinator.transition('a', 'running', 2);
    expect(() => coordinator.transition('a', 'completed', 3, { resultToken: 'bad\0token' })).toThrow(/bounds/);
  });

  it('does not accept null bytes in failure diagnostics', () => {
    const coordinator = new ArcGisExportJobCoordinator(exportPolicy);
    coordinator.create({ id: 'a', title: 'A', format: 'pdf', viewMode: '2d', extent, widthPx: 100, heightPx: 100, dpi: 96 }, 1);
    coordinator.transition('a', 'running', 2);
    expect(() => coordinator.transition('a', 'failed', 3, { failureCode: 'bad\0code' })).toThrow(/bounds/);
  });

  it('rejects non-safe integer export dimensions', () => {
    const coordinator = new ArcGisExportJobCoordinator(exportPolicy);
    expect(() => coordinator.create({ id: 'a', title: 'A', format: 'png', viewMode: '2d', extent, widthPx: 10.5, heightPx: 100, dpi: 96 }, 1)).toThrow(/positive safe integer/);
  });

  it('rejects unsupported export format at runtime boundary', () => {
    const coordinator = new ArcGisExportJobCoordinator(exportPolicy);
    expect(() => coordinator.create({ id: 'a', title: 'A', format: 'svg' as 'pdf', viewMode: '2d', extent, widthPx: 100, heightPx: 100, dpi: 96 }, 1)).toThrow(/format/);
  });

  it('rejects unsupported view mode at runtime boundary', () => {
    const coordinator = new ArcGisExportJobCoordinator(exportPolicy);
    expect(() => coordinator.create({ id: 'a', title: 'A', format: 'pdf', viewMode: '4d' as '2d', extent, widthPx: 100, heightPx: 100, dpi: 96 }, 1)).toThrow(/view mode/);
  });

  it('does not accept null bytes in share layer keys', () => {
    const coordinator = new ArcGisShareStateCoordinator(sharePolicy);
    expect(() => coordinator.create({
      id: 'a',
      viewMode: '2d',
      camera,
      layers: [{ key: 'bad\0key', visible: true, opacity: 1 }],
    }, 1)).toThrow(/bounds/);
  });

  it('rejects NaN opacity from untrusted serialized state', () => {
    const coordinator = new ArcGisShareStateCoordinator(sharePolicy);
    expect(() => coordinator.create({
      id: 'a',
      viewMode: '2d',
      camera,
      layers: [{ key: 'roads', visible: true, opacity: Number.NaN }],
    }, 1)).toThrow(/opacity/);
  });

  it('rejects unsupported share mode at runtime boundary', () => {
    const coordinator = new ArcGisShareStateCoordinator(sharePolicy);
    expect(() => coordinator.create({
      id: 'a',
      viewMode: 'ar' as '2d',
      camera,
      layers: [],
    }, 1)).toThrow(/view mode/);
  });

  it('preserves numeric zero camera coordinates as valid data', () => {
    const coordinator = new ArcGisShareStateCoordinator(sharePolicy);
    const state = coordinator.create({
      id: 'zero',
      viewMode: '2d',
      camera: { ...camera, x: 0, y: 0 },
      layers: [],
    }, 1);
    expect(state.camera.x).toBe(0);
    expect(state.camera.y).toBe(0);
  });

  it('keeps typed selection tied to a normalized layer key', () => {
    const coordinator = new ArcGisShareStateCoordinator(sharePolicy);
    const state = coordinator.create({
      id: 'trimmed',
      viewMode: '2d',
      camera,
      layers: [{ key: ' roads ', visible: true, opacity: 1 }],
      selectedLayerKey: ' roads ',
    }, 1);
    expect(state.layers[0]?.key).toBe('roads');
    expect(state.selectedLayerKey).toBe('roads');
  });

  it('does not mutate prior share snapshots after update', () => {
    const coordinator = new ArcGisShareStateCoordinator(sharePolicy);
    coordinator.create({ id: 'a', viewMode: '2d', camera, layers: [] }, 1);
    const before = coordinator.snapshot(1);
    coordinator.update('a', { viewMode: '2d', camera: { ...camera, x: 30 }, layers: [] }, 2);
    expect(before.states[0]?.camera.x).toBe(29);
    expect(coordinator.snapshot(2).states[0]?.camera.x).toBe(30);
  });
});
