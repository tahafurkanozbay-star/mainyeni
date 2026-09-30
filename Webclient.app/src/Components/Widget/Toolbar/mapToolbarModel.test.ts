import { describe, expect, it, vi } from 'vitest';
import {
  MAP_TOOLBAR_ACTIONS,
  MAP_TOOLBAR_FALLBACK_LOCATION,
  MAP_TOOLBAR_GROUP_LABELS,
  MapToolbarModel,
  auditMapToolbarCatalog,
  createMapToolbarSnapshot,
  findMapToolbarAction,
  normalizeMapToolbarPoint,
  type MapToolbarActionDefinition,
} from './mapToolbarModel';

describe('mapToolbarModel', () => {
  it('ships a deterministic catalog with unique actions and valid groups', () => {
    expect(auditMapToolbarCatalog()).toEqual([]);
    expect(MAP_TOOLBAR_ACTIONS.map((action) => action.id)).toEqual([
      'feedback',
      'basemap',
      'address',
      'location',
      'parcel',
      'measure',
      'streetview',
      'home',
    ]);
    expect(Object.keys(MAP_TOOLBAR_GROUP_LABELS)).toEqual([
      'municipal',
      'analysis',
      'navigation',
    ]);
  });

  it('detects duplicate ids without throwing away the remaining audit findings', () => {
    const duplicate = [
      ...MAP_TOOLBAR_ACTIONS,
      { ...MAP_TOOLBAR_ACTIONS[0] },
    ] as readonly MapToolbarActionDefinition[];
    const findings = auditMapToolbarCatalog(duplicate);
    expect(findings.some((finding) => finding.code === 'duplicate-action-id')).toBe(true);
  });

  it('detects empty labels', () => {
    const actions = MAP_TOOLBAR_ACTIONS.map((action) => (
      action.id === 'basemap' ? { ...action, label: '   ' } : action
    ));
    expect(auditMapToolbarCatalog(actions).some((finding) => (
      finding.code === 'empty-label' && finding.actionId === 'basemap'
    ))).toBe(true);
  });

  it('detects missing targets for target-based commands', () => {
    const actions = MAP_TOOLBAR_ACTIONS.map((action) => (
      action.id === 'feedback' ? { ...action, target: '' } : action
    ));
    expect(auditMapToolbarCatalog(actions).some((finding) => (
      finding.code === 'missing-target' && finding.actionId === 'feedback'
    ))).toBe(true);
  });

  it('detects invalid location cardinality', () => {
    const actions = MAP_TOOLBAR_ACTIONS.filter((action) => action.id !== 'location');
    expect(auditMapToolbarCatalog(actions).some((finding) => (
      finding.code === 'location-cardinality'
    ))).toBe(true);
  });

  it('detects invalid home cardinality', () => {
    const actions = MAP_TOOLBAR_ACTIONS.filter((action) => action.id !== 'home');
    expect(auditMapToolbarCatalog(actions).some((finding) => (
      finding.code === 'home-cardinality'
    ))).toBe(true);
  });

  it('finds known actions and fails closed for unknown ids', () => {
    expect(findMapToolbarAction('measure')?.target).toBe('measurement-widget');
    expect(findMapToolbarAction('does-not-exist')).toBeNull();
  });

  it('normalizes valid coordinates', () => {
    expect(normalizeMapToolbarPoint({ x: 32.8, y: 39.9 })).toEqual({ x: 32.8, y: 39.9 });
  });

  it('rejects non-finite and out-of-range coordinates', () => {
    expect(normalizeMapToolbarPoint({ x: Number.NaN, y: 39 })).toBeNull();
    expect(normalizeMapToolbarPoint({ x: 181, y: 39 })).toBeNull();
    expect(normalizeMapToolbarPoint({ x: 32, y: 91 })).toBeNull();
    expect(normalizeMapToolbarPoint(null)).toBeNull();
    expect(normalizeMapToolbarPoint([])).toBeNull();
  });

  it('exposes an immutable idle snapshot', () => {
    const snapshot = createMapToolbarSnapshot(7, 'idle');
    expect(snapshot.revision).toBe(7);
    expect(snapshot.locationPhase).toBe('idle');
    expect(snapshot.announcement).toBe('');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.actions)).toBe(true);
    expect(snapshot.actions.every((action) => Object.isFrozen(action))).toBe(true);
  });

  it('changes only the location action label and busy state while locating', () => {
    const snapshot = createMapToolbarSnapshot(1, 'locating');
    const location = snapshot.actions.find((action) => action.id === 'location');
    const basemap = snapshot.actions.find((action) => action.id === 'basemap');
    expect(location).toMatchObject({
      label: 'Konum bulunuyor',
      tooltip: 'Konum bulunuyor',
      busy: true,
      disabled: true,
    });
    expect(basemap).toMatchObject({
      label: 'Altlık Haritalar',
      busy: false,
      disabled: false,
    });
  });

  it('publishes a polite locating state before asking for browser location', async () => {
    const model = new MapToolbarModel();
    const phases: string[] = [];
    model.subscribe(() => phases.push(model.getSnapshot().locationPhase));
    let resolvePosition: ((value: { x: number; y: number }) => void) | undefined;
    const requestPosition = vi.fn(() => new Promise<{ x: number; y: number }>((resolve) => {
      resolvePosition = resolve;
    }));
    const pending = model.locate({
      requestPosition,
      showLocation: vi.fn(),
      showSidebar: vi.fn(),
    });
    expect(model.getSnapshot()).toMatchObject({
      locationPhase: 'locating',
      announcement: 'Konumunuz bulunuyor.',
    });
    expect(phases).toEqual(['locating']);
    resolvePosition?.({ x: 32.8, y: 39.9 });
    await pending;
  });

  it('renders the requested position and publishes success', async () => {
    const model = new MapToolbarModel();
    const showLocation = vi.fn(async () => undefined);
    const showSidebar = vi.fn();
    const result = await model.locate({
      requestPosition: async () => ({ x: 32.81, y: 39.95 }),
      showLocation,
      showSidebar,
    });
    expect(result).toBe('success');
    expect(showLocation).toHaveBeenCalledTimes(1);
    expect(showLocation).toHaveBeenCalledWith({ x: 32.81, y: 39.95 });
    expect(showSidebar).not.toHaveBeenCalled();
    expect(model.getSnapshot()).toMatchObject({
      locationPhase: 'success',
      announcement: 'Konumunuz haritada gösterildi.',
    });
  });

  it('uses the bounded Ankara fallback when geolocation rejects', async () => {
    const model = new MapToolbarModel();
    const showLocation = vi.fn(async () => undefined);
    const showSidebar = vi.fn();
    const onError = vi.fn();
    const sourceError = new Error('permission denied');
    const result = await model.locate({
      requestPosition: async () => { throw sourceError; },
      showLocation,
      showSidebar,
      onError,
    });
    expect(result).toBe('fallback');
    expect(showLocation).toHaveBeenCalledTimes(1);
    expect(showLocation).toHaveBeenCalledWith(MAP_TOOLBAR_FALLBACK_LOCATION);
    expect(showSidebar).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(sourceError);
    expect(model.getSnapshot()).toMatchObject({
      locationPhase: 'fallback',
      announcement: 'Konum alınamadı. Ankara merkez konumu gösterildi.',
    });
  });

  it('uses the fallback for invalid browser coordinates', async () => {
    const model = new MapToolbarModel();
    const showLocation = vi.fn(async () => undefined);
    const onError = vi.fn();
    const result = await model.locate({
      requestPosition: async () => ({ x: 999, y: 999 }),
      showLocation,
      showSidebar: vi.fn(),
      onError,
    });
    expect(result).toBe('fallback');
    expect(showLocation).toHaveBeenCalledWith(MAP_TOOLBAR_FALLBACK_LOCATION);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('publishes error when both requested and fallback rendering fail', async () => {
    const model = new MapToolbarModel();
    const errors: unknown[] = [];
    const result = await model.locate({
      requestPosition: async () => { throw new Error('geolocation blocked'); },
      showLocation: async () => { throw new Error('map unavailable'); },
      showSidebar: vi.fn(),
      onError: (error) => errors.push(error),
    });
    expect(result).toBe('error');
    expect(errors).toHaveLength(2);
    expect(model.getSnapshot()).toMatchObject({
      locationPhase: 'error',
      announcement: 'Konum gösterilemedi. Harita araçlarını kullanmaya devam edebilirsiniz.',
    });
  });

  it('does not turn a rendered fallback into an error when sidebar restoration fails', async () => {
    const model = new MapToolbarModel();
    const onError = vi.fn();
    const result = await model.locate({
      requestPosition: async () => { throw new Error('denied'); },
      showLocation: async () => undefined,
      showSidebar: () => { throw new Error('sidebar unavailable'); },
      onError,
    });
    expect(result).toBe('fallback');
    expect(model.getSnapshot().locationPhase).toBe('fallback');
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('isolates diagnostic reporter failures from fallback recovery', async () => {
    const model = new MapToolbarModel();
    const result = await model.locate({
      requestPosition: async () => { throw new Error('denied'); },
      showLocation: async () => undefined,
      showSidebar: vi.fn(),
      onError: () => { throw new Error('reporter failed'); },
    });
    expect(result).toBe('fallback');
    expect(model.getSnapshot().locationPhase).toBe('fallback');
  });

  it('coalesces a second locate request while one is active', async () => {
    const model = new MapToolbarModel();
    let resolvePosition: ((value: { x: number; y: number }) => void) | undefined;
    const requestPosition = vi.fn(() => new Promise<{ x: number; y: number }>((resolve) => {
      resolvePosition = resolve;
    }));
    const showLocation = vi.fn(async () => undefined);
    const dependencies = {
      requestPosition,
      showLocation,
      showSidebar: vi.fn(),
    };
    const first = model.locate(dependencies);
    const second = await model.locate(dependencies);
    expect(second).toBe('locating');
    expect(requestPosition).toHaveBeenCalledTimes(1);
    resolvePosition?.({ x: 32.8, y: 39.9 });
    expect(await first).toBe('success');
  });

  it('stops publishing stale async results after reset', async () => {
    const model = new MapToolbarModel();
    let resolvePosition: ((value: { x: number; y: number }) => void) | undefined;
    const pending = model.locate({
      requestPosition: () => new Promise<{ x: number; y: number }>((resolve) => {
        resolvePosition = resolve;
      }),
      showLocation: vi.fn(async () => undefined),
      showSidebar: vi.fn(),
    });
    model.resetLocation();
    const revisionAfterReset = model.getSnapshot().revision;
    resolvePosition?.({ x: 32.8, y: 39.9 });
    await pending;
    expect(model.getSnapshot()).toMatchObject({
      revision: revisionAfterReset,
      locationPhase: 'idle',
    });
  });

  it('stops publishing stale async results after disposal', async () => {
    const model = new MapToolbarModel();
    const listener = vi.fn();
    model.subscribe(listener);
    let resolvePosition: ((value: { x: number; y: number }) => void) | undefined;
    const pending = model.locate({
      requestPosition: () => new Promise<{ x: number; y: number }>((resolve) => {
        resolvePosition = resolve;
      }),
      showLocation: vi.fn(async () => undefined),
      showSidebar: vi.fn(),
    });
    expect(listener).toHaveBeenCalledTimes(1);
    model.dispose();
    resolvePosition?.({ x: 32.8, y: 39.9 });
    await pending;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(model.disposed()).toBe(true);
    expect(model.listenerCount()).toBe(0);
  });

  it('isolates one failing listener and continues notifying the rest', () => {
    const reporter = vi.fn();
    const model = new MapToolbarModel({ onListenerError: reporter });
    const healthy = vi.fn();
    model.subscribe(() => { throw new Error('observer failed'); });
    model.subscribe(healthy);
    model.resetLocation();
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('isolates a failing listener-error reporter', () => {
    const model = new MapToolbarModel({
      onListenerError: () => { throw new Error('reporter failed'); },
    });
    const healthy = vi.fn();
    model.subscribe(() => { throw new Error('observer failed'); });
    model.subscribe(healthy);
    expect(() => model.resetLocation()).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('enforces a bounded observer budget', () => {
    const model = new MapToolbarModel({ maxListeners: 2 });
    model.subscribe(() => undefined);
    model.subscribe(() => undefined);
    expect(() => model.subscribe(() => undefined)).toThrow(/listener limit exceeded/u);
  });

  it('allows a released observer slot to be reused', () => {
    const model = new MapToolbarModel({ maxListeners: 1 });
    const unsubscribe = model.subscribe(() => undefined);
    unsubscribe();
    expect(() => model.subscribe(() => undefined)).not.toThrow();
  });

  it('treats subscribe after disposal as a no-op', () => {
    const model = new MapToolbarModel();
    model.dispose();
    const listener = vi.fn();
    const unsubscribe = model.subscribe(listener);
    expect(() => unsubscribe()).not.toThrow();
    model.resetLocation();
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not start location work after disposal', async () => {
    const model = new MapToolbarModel();
    model.dispose();
    const requestPosition = vi.fn(async () => ({ x: 32.8, y: 39.9 }));
    const result = await model.locate({
      requestPosition,
      showLocation: vi.fn(),
      showSidebar: vi.fn(),
    });
    expect(requestPosition).not.toHaveBeenCalled();
    expect(result).toBe('idle');
  });

  it('increments revision only for published state transitions', async () => {
    const model = new MapToolbarModel();
    expect(model.getSnapshot().revision).toBe(0);
    await model.locate({
      requestPosition: async () => ({ x: 32.8, y: 39.9 }),
      showLocation: async () => undefined,
      showSidebar: vi.fn(),
    });
    expect(model.getSnapshot()).toMatchObject({ revision: 2, locationPhase: 'success' });
    model.resetLocation();
    expect(model.getSnapshot()).toMatchObject({ revision: 3, locationPhase: 'idle' });
  });
});
