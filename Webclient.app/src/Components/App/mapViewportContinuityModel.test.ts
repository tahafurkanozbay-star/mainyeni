import { describe, expect, it, vi } from 'vitest';
import { assessMapViewportContinuity, createMapViewportContinuityModel } from './mapViewportContinuityModel';

const BASE = Object.freeze({
  mode: '2d' as const,
  center: [32.85, 39.93] as const,
  zoom: 12,
  scale: 25000,
  heading: 0,
  tilt: 0,
  basemapId: 'osm',
  selectedLayerId: 'parks',
  selectedObjectId: 42,
  time: '2026-09-30T10:00:00.000Z',
});

const TARGET = Object.freeze({
  ...BASE,
  mode: '3d' as const,
  zoom: null,
  scale: 30000,
  heading: 15,
  tilt: 48,
});

describe('assessMapViewportContinuity', () => {
  it('reports preserved continuity when core context survives a 2B→3B transition', () => {
    const report = assessMapViewportContinuity(BASE, TARGET, '3d', 8, 7, 123);
    expect(report).toMatchObject({
      requestId: 7,
      sourceMode: '2d',
      targetMode: '3d',
      status: 'preserved',
      score: 100,
      assessedAtMs: 123,
    });
    expect(report.findings).toHaveLength(0);
  });

  it('flags a target mode mismatch', () => {
    const report = assessMapViewportContinuity(BASE, { ...TARGET, mode: '2d' }, '3d');
    expect(report.status).toBe('degraded');
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'mode-mismatch', severity: 'warning' }),
    ]));
  });

  it('flags a lost center as a warning', () => {
    const report = assessMapViewportContinuity(BASE, { ...TARGET, center: null }, '3d');
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'center-lost', severity: 'warning' }));
  });

  it('treats a newly introduced center as informational', () => {
    const report = assessMapViewportContinuity({ ...BASE, center: null }, TARGET, '3d');
    expect(report.status).toBe('preserved');
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'center-introduced', severity: 'info' }));
    expect(report.score).toBe(95);
  });

  it('flags a lost comparable scale', () => {
    const report = assessMapViewportContinuity(BASE, { ...TARGET, scale: null, zoom: null }, '3d');
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'scale-lost' }));
  });

  it('accepts moderate cross-mode scale changes', () => {
    const report = assessMapViewportContinuity(BASE, { ...TARGET, scale: 100000 }, '3d', 8);
    expect(report.findings.some((finding) => finding.code === 'scale-ratio-high')).toBe(false);
  });

  it('flags excessive scale ratio drift', () => {
    const report = assessMapViewportContinuity(BASE, { ...TARGET, scale: 1_000_000 }, '3d', 8);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'scale-ratio-high', severity: 'warning' }));
  });

  it('derives a comparable scale from zoom when scale is absent', () => {
    const source = { ...BASE, scale: null, zoom: 12 };
    const target = { ...TARGET, scale: null, zoom: 12 };
    const report = assessMapViewportContinuity(source, target, '3d', 2);
    expect(report.findings.some((finding) => finding.code.startsWith('scale-'))).toBe(false);
  });

  it('flags basemap changes', () => {
    const report = assessMapViewportContinuity(BASE, { ...TARGET, basemapId: 'satellite' }, '3d');
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'basemap-changed' }));
  });

  it('flags selected layer changes', () => {
    const report = assessMapViewportContinuity(BASE, { ...TARGET, selectedLayerId: 'roads' }, '3d');
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'selection-layer-changed' }));
  });

  it('flags selected object changes', () => {
    const report = assessMapViewportContinuity(BASE, { ...TARGET, selectedObjectId: 99 }, '3d');
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'selection-object-changed' }));
  });

  it('treats time changes as informational', () => {
    const report = assessMapViewportContinuity(BASE, { ...TARGET, time: '2026-10-01T00:00:00.000Z' }, '3d');
    expect(report.status).toBe('preserved');
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'time-changed', severity: 'info' }));
  });

  it('normalizes malformed state through the shared view-state authority', () => {
    const report = assessMapViewportContinuity(
      { mode: '2d', center: [Number.NaN, 2], scale: 'bad' as never },
      { mode: '3d', center: [1, 2], scale: 20 },
      '3d',
    );
    expect(report.source.center).toBeNull();
    expect(report.source.scale).toBeNull();
    expect(report.target.center).toEqual([1, 2]);
  });

  it('freezes reports, findings and normalized states', () => {
    const report = assessMapViewportContinuity(BASE, TARGET, '3d');
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.findings)).toBe(true);
    expect(Object.isFrozen(report.source)).toBe(true);
    expect(Object.isFrozen(report.target)).toBe(true);
  });
});

describe('MapViewportContinuityModel', () => {
  it('starts unknown with no reports', () => {
    const model = createMapViewportContinuityModel();
    expect(model.getSnapshot()).toMatchObject({
      revision: 0,
      status: 'unknown',
      latestReport: null,
      preservedCount: 0,
      degradedCount: 0,
    });
  });

  it('publishes preserved assessments', () => {
    const model = createMapViewportContinuityModel({ now: () => 777 });
    const report = model.assess(1, BASE, TARGET, '3d');
    expect(report?.assessedAtMs).toBe(777);
    expect(model.getSnapshot()).toMatchObject({ status: 'preserved', preservedCount: 1, degradedCount: 0 });
    expect(model.getSnapshot().announcement).toContain('korundu');
  });

  it('publishes degraded assessments with warning count', () => {
    const model = createMapViewportContinuityModel();
    model.assess(2, BASE, { ...TARGET, center: null, basemapId: 'other' }, '3d');
    expect(model.getSnapshot()).toMatchObject({ status: 'degraded', preservedCount: 0, degradedCount: 1 });
    expect(model.getSnapshot().announcement).toContain('2 konum veya bağlam farkı');
  });

  it('keeps a bounded recent report history', () => {
    const model = createMapViewportContinuityModel({ maxReports: 2 });
    model.assess(1, BASE, TARGET, '3d');
    model.assess(2, TARGET, { ...BASE, mode: '2d' }, '2d');
    model.assess(3, BASE, TARGET, '3d');
    expect(model.getSnapshot().recentReports.map((report) => report.requestId)).toEqual([2, 3]);
    expect(model.getDiagnostics()).toMatchObject({ assessmentCount: 3, boundedReportCount: 1 });
  });

  it('notifies healthy listeners on assessment', () => {
    const model = createMapViewportContinuityModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.assess(1, BASE, TARGET, '3d');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('isolates listener failures', () => {
    const model = createMapViewportContinuityModel();
    const healthy = vi.fn();
    model.subscribe(() => { throw new TypeError('bad listener'); });
    model.subscribe(healthy);
    model.assess(1, BASE, TARGET, '3d');
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(model.getDiagnostics().listenerFailureCount).toBe(1);
  });

  it('bounds listeners', () => {
    const model = createMapViewportContinuityModel({ maxListeners: 1 });
    const first = vi.fn();
    const second = vi.fn();
    model.subscribe(first);
    model.subscribe(second);
    expect(model.getDiagnostics()).toMatchObject({ listenerCount: 1, rejectedListenerCount: 1 });
  });

  it('unsubscribes idempotently', () => {
    const model = createMapViewportContinuityModel();
    const unsubscribe = model.subscribe(vi.fn());
    expect(model.getDiagnostics().listenerCount).toBe(1);
    unsubscribe();
    unsubscribe();
    expect(model.getDiagnostics().listenerCount).toBe(0);
  });

  it('resets public assessment state while retaining diagnostics', () => {
    const model = createMapViewportContinuityModel();
    model.assess(1, BASE, TARGET, '3d');
    const assessments = model.getDiagnostics().assessmentCount;
    model.reset();
    expect(model.getSnapshot()).toMatchObject({ status: 'unknown', latestReport: null, preservedCount: 0, degradedCount: 0 });
    expect(model.getDiagnostics().assessmentCount).toBe(assessments);
  });

  it('disposes safely', () => {
    const model = createMapViewportContinuityModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.dispose();
    expect(model.getDiagnostics()).toMatchObject({ disposed: true, listenerCount: 0 });
    expect(model.assess(1, BASE, TARGET, '3d')).toBeNull();
    model.reset();
    expect(listener).not.toHaveBeenCalled();
  });

  it('records rejected subscriptions after dispose', () => {
    const model = createMapViewportContinuityModel();
    model.dispose();
    model.subscribe(vi.fn());
    expect(model.getDiagnostics().rejectedListenerCount).toBe(1);
  });

  it('uses finite fallback time when a custom clock is invalid', () => {
    const model = createMapViewportContinuityModel({ now: () => Number.NaN });
    const report = model.assess(1, BASE, TARGET, '3d');
    expect(Number.isFinite(report?.assessedAtMs)).toBe(true);
  });

  it('keeps snapshots and report history immutable', () => {
    const model = createMapViewportContinuityModel();
    model.assess(1, BASE, TARGET, '3d');
    expect(Object.isFrozen(model.getSnapshot())).toBe(true);
    expect(Object.isFrozen(model.getSnapshot().recentReports)).toBe(true);
  });
});
