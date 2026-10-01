import { describe, expect, it, vi } from 'vitest';
import {
  ResponsiveDataTableProjectionModel,
  createResponsiveDataTableProjection,
  type ResponsiveDataTableColumnDefinition,
  type ResponsiveDataTableEnvironment,
} from './responsiveDataTableProjection';

const columns: readonly ResponsiveDataTableColumnDefinition[] = Object.freeze([
  { id: 'stopNo', label: 'Durak no', priority: 0, essential: true, minimumWidth: 96, preferredWidth: 120 },
  { id: 'stopName', label: 'Durak adı', priority: 1, essential: true, minimumWidth: 160, preferredWidth: 280 },
  { id: 'lineType', label: 'Tür', priority: 2, minimumWidth: 96, preferredWidth: 140 },
  { id: 'district', label: 'İlçe', priority: 3, minimumWidth: 110, preferredWidth: 160 },
  { id: 'address', label: 'Adres', priority: 4, hideOnPhone: true, minimumWidth: 180, preferredWidth: 300 },
]);

const environment = (
  containerWidth: number,
  viewportWidth = containerWidth,
  overrides: Partial<ResponsiveDataTableEnvironment> = {},
): ResponsiveDataTableEnvironment => ({
  containerWidth,
  viewportWidth,
  coarsePointer: false,
  reducedMotion: false,
  forcedColors: false,
  ...overrides,
});

describe('createResponsiveDataTableProjection', () => {
  it('keeps essential identity columns visible on narrow phones', () => {
    const snapshot = createResponsiveDataTableProjection({
      columns,
      environment: environment(360),
    });
    expect(snapshot.viewport).toBe('phone');
    expect(snapshot.visibleColumnIds).toContain('stopNo');
    expect(snapshot.visibleColumnIds).toContain('stopName');
    expect(snapshot.visibleColumns.length).toBeLessThanOrEqual(3);
    expect(snapshot.hiddenColumnIds).toContain('address');
  });

  it('projects more columns as the container grows', () => {
    const phone = createResponsiveDataTableProjection({ columns, environment: environment(390) });
    const tablet = createResponsiveDataTableProjection({ columns, environment: environment(820) });
    const desktop = createResponsiveDataTableProjection({ columns, environment: environment(1440) });
    expect(tablet.visibleColumns.length).toBeGreaterThanOrEqual(phone.visibleColumns.length);
    expect(desktop.visibleColumns.length).toBeGreaterThanOrEqual(tablet.visibleColumns.length);
    expect(desktop.visibleColumnIds).toEqual(['stopNo', 'stopName', 'lineType', 'district', 'address']);
  });

  it('uses the smaller of viewport and container for projection class', () => {
    const snapshot = createResponsiveDataTableProjection({
      columns,
      environment: environment(1400, 600),
    });
    expect(snapshot.viewport).toBe('phone');
  });

  it('never allows user preferences to hide essential columns', () => {
    const snapshot = createResponsiveDataTableProjection({
      columns,
      environment: environment(1400),
      userHiddenColumnIds: ['stopNo', 'stopName', 'district'],
    });
    expect(snapshot.visibleColumnIds).toContain('stopNo');
    expect(snapshot.visibleColumnIds).toContain('stopName');
    expect(snapshot.userHiddenColumnIds).toEqual(['district']);
  });

  it('tracks user-hidden and automatically-hidden columns separately', () => {
    const snapshot = createResponsiveDataTableProjection({
      columns,
      environment: environment(360),
      userHiddenColumnIds: ['district'],
    });
    expect(snapshot.userHiddenColumnIds).toContain('district');
    expect(snapshot.hiddenColumnIds).toContain('district');
    expect(snapshot.automaticHiddenColumnIds).not.toContain('district');
    expect(snapshot.automaticHiddenColumnIds).toContain('address');
  });

  it('normalizes duplicate and malformed column identities', () => {
    const snapshot = createResponsiveDataTableProjection({
      columns: [
        { id: 'name', label: 'Ad' },
        { id: ' name ', label: 'Tekrar' },
        { id: '', label: 'Kimliksiz' },
        { id: 'empty', label: '   ' },
      ],
      environment: environment(1200),
    });
    expect(snapshot.visibleColumnIds).toEqual(['name']);
  });

  it('promotes the first valid column to essential when callers omit an anchor', () => {
    const snapshot = createResponsiveDataTableProjection({
      columns: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      environment: environment(120),
      userHiddenColumnIds: ['a', 'b'],
    });
    expect(snapshot.visibleColumnIds).toContain('a');
    expect(snapshot.userHiddenColumnIds).toEqual(['b']);
  });

  it('bounds hostile column cardinality', () => {
    const hostile = Array.from({ length: 300 }, (_, index) => ({
      id: `c-${index}`,
      label: `Kolon ${index}`,
      priority: index,
    }));
    const snapshot = createResponsiveDataTableProjection({
      columns: hostile,
      maxColumns: 12,
      environment: environment(100_000),
    });
    expect(snapshot.visibleColumns.length).toBeLessThanOrEqual(12);
  });

  it('allocates widths inside normalized minimum and maximum bounds', () => {
    const snapshot = createResponsiveDataTableProjection({
      columns: [
        { id: 'a', label: 'A', essential: true, minimumWidth: -99, preferredWidth: 999999 },
        { id: 'b', label: 'B', minimumWidth: 20, preferredWidth: 20 },
      ],
      environment: environment(2000),
    });
    expect(snapshot.visibleColumns[0]?.width).toBeGreaterThanOrEqual(88);
    expect(snapshot.visibleColumns[0]?.width).toBeLessThanOrEqual(420);
    expect(snapshot.visibleColumns[1]?.width).toBeGreaterThanOrEqual(88);
  });

  it('reports horizontal overflow when essential widths exceed the container', () => {
    const snapshot = createResponsiveDataTableProjection({
      columns: [
        { id: 'a', label: 'A', essential: true, minimumWidth: 180 },
        { id: 'b', label: 'B', essential: true, minimumWidth: 180 },
      ],
      environment: environment(220),
    });
    expect(snapshot.horizontalOverflow).toBe(true);
    expect(snapshot.tableWidth).toBeGreaterThan(snapshot.availableWidth);
  });

  it('supports compact density without violating minimum width', () => {
    const comfortable = createResponsiveDataTableProjection({
      columns,
      environment: environment(1200),
      density: 'comfortable',
    });
    const compact = createResponsiveDataTableProjection({
      columns,
      environment: environment(1200),
      density: 'compact',
    });
    expect(compact.compactRows).toBe(true);
    expect(compact.visibleColumns.every((column) => column.width >= 88)).toBe(true);
    expect(compact.tableWidth).toBeLessThanOrEqual(comfortable.tableWidth);
  });

  it('exposes coarse-pointer touch target facts', () => {
    const coarse = createResponsiveDataTableProjection({
      columns,
      environment: environment(800, 800, { coarsePointer: true }),
    });
    const fine = createResponsiveDataTableProjection({
      columns,
      environment: environment(800),
    });
    expect(coarse.touchTargetPx).toBe(48);
    expect(fine.touchTargetPx).toBe(44);
  });

  it('propagates reduced-motion and forced-colors presentation facts', () => {
    const snapshot = createResponsiveDataTableProjection({
      columns,
      environment: environment(800, 800, {
        reducedMotion: true,
        forcedColors: true,
      }),
    });
    expect(snapshot.reducedMotion).toBe(true);
    expect(snapshot.forcedColors).toBe(true);
  });

  it('preserves source column order after priority selection', () => {
    const snapshot = createResponsiveDataTableProjection({
      columns: [
        { id: 'identity', label: 'Kimlik', essential: true, priority: 0 },
        { id: 'late', label: 'Geç', priority: 50 },
        { id: 'early', label: 'Erken', priority: 1 },
      ],
      environment: environment(1000),
    });
    expect(snapshot.visibleColumnIds).toEqual(['identity', 'late', 'early']);
  });

  it('uses one-based projected column positions', () => {
    const snapshot = createResponsiveDataTableProjection({ columns, environment: environment(1400) });
    expect(snapshot.visibleColumns.map((column) => column.columnIndex)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns frozen public collections', () => {
    const snapshot = createResponsiveDataTableProjection({ columns, environment: environment(900) });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.visibleColumns)).toBe(true);
    expect(Object.isFrozen(snapshot.visibleColumnIds)).toBe(true);
    expect(Object.isFrozen(snapshot.hiddenColumnIds)).toBe(true);
  });

  it('announces responsive reduction without overstating hidden columns', () => {
    const snapshot = createResponsiveDataTableProjection({ columns, environment: environment(360) });
    expect(snapshot.announcement).toContain(`${snapshot.visibleColumns.length} sütun`);
    expect(snapshot.announcement).toContain(`${snapshot.hiddenColumnIds.length} sütun`);
  });
});

describe('ResponsiveDataTableProjectionModel', () => {
  it('publishes only meaningful environment changes', () => {
    const model = new ResponsiveDataTableProjectionModel({
      columns,
      initialEnvironment: environment(800),
    });
    const listener = vi.fn();
    model.subscribe(listener);
    model.setEnvironment({ containerWidth: 800 });
    expect(listener).not.toHaveBeenCalled();
    model.setEnvironment({ containerWidth: 500 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].viewport).toBe('phone');
  });

  it('toggles only optional columns', () => {
    const model = new ResponsiveDataTableProjectionModel({
      columns,
      initialEnvironment: environment(1400),
    });
    model.toggleColumn('district');
    expect(model.getSnapshot().userHiddenColumnIds).toEqual(['district']);
    model.toggleColumn('stopNo');
    expect(model.getSnapshot().visibleColumnIds).toContain('stopNo');
    model.toggleColumn('district');
    expect(model.getSnapshot().userHiddenColumnIds).toEqual([]);
  });

  it('resets manual visibility without changing responsive projection', () => {
    const model = new ResponsiveDataTableProjectionModel({
      columns,
      initialEnvironment: environment(360),
    });
    model.setColumnHidden('lineType', true);
    expect(model.getSnapshot().userHiddenColumnIds).toContain('lineType');
    model.resetColumnVisibility();
    expect(model.getSnapshot().userHiddenColumnIds).toEqual([]);
    expect(model.getSnapshot().hiddenColumnIds).toContain('address');
  });

  it('switches density with a stable public snapshot', () => {
    const model = new ResponsiveDataTableProjectionModel({ columns });
    model.setDensity('compact');
    expect(model.getSnapshot().density).toBe('compact');
    expect(model.getSnapshot().compactRows).toBe(true);
    model.setDensity('comfortable');
    expect(model.getSnapshot().density).toBe('comfortable');
  });

  it('bounds observer cardinality and records rejected observers', () => {
    const model = new ResponsiveDataTableProjectionModel({ columns, maxObservers: 2 });
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    model.subscribe(a);
    model.subscribe(b);
    model.subscribe(c);
    expect(model.getDiagnostics().observerCount).toBe(2);
    expect(model.getDiagnostics().rejectedObserverCount).toBe(1);
  });

  it('isolates failing observers and continues healthy observers', () => {
    const model = new ResponsiveDataTableProjectionModel({ columns });
    const healthy = vi.fn();
    model.subscribe(() => {
      throw new TypeError('observer failed');
    });
    model.subscribe(healthy);
    model.setDensity('compact');
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(model.getDiagnostics().failureCount).toBe(1);
    expect(model.getDiagnostics().lastFailureKind).toBe('TypeError');
  });

  it('treats duplicate listener subscriptions idempotently', () => {
    const model = new ResponsiveDataTableProjectionModel({ columns });
    const listener = vi.fn();
    const first = model.subscribe(listener);
    const second = model.subscribe(listener);
    expect(model.getDiagnostics().observerCount).toBe(1);
    first();
    expect(model.getDiagnostics().observerCount).toBe(0);
    second();
    expect(model.getDiagnostics().observerCount).toBe(0);
  });

  it('disposes deterministically and rejects later subscriptions', () => {
    const model = new ResponsiveDataTableProjectionModel({ columns });
    const listener = vi.fn();
    model.subscribe(listener);
    model.dispose();
    expect(model.getDiagnostics().disposed).toBe(true);
    expect(model.getDiagnostics().observerCount).toBe(0);
    model.setDensity('compact');
    expect(listener).not.toHaveBeenCalled();
    model.subscribe(vi.fn());
    expect(model.getDiagnostics().rejectedObserverCount).toBe(1);
  });

  it('increments revisions for published state changes', () => {
    const model = new ResponsiveDataTableProjectionModel({ columns });
    expect(model.getDiagnostics().revision).toBe(0);
    model.setDensity('compact');
    model.setEnvironment({ containerWidth: 500 });
    expect(model.getDiagnostics().revision).toBe(2);
  });
});
