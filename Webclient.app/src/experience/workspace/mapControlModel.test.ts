import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAP_CONTROLS, MapControlModel, type MapControlEnvironment } from './mapControlModel';

const environment = (overrides: Partial<MapControlEnvironment> = {}): MapControlEnvironment => ({
  width: 1440,
  height: 900,
  coarsePointer: false,
  reducedMotion: false,
  forcedColors: false,
  mode: '2d',
  geolocationAvailable: true,
  fullscreenAvailable: true,
  ...overrides,
});

describe('MapControlModel', () => {
  it('exposes a deterministic enterprise GIS control order', () => {
    const model = new MapControlModel(environment());
    expect(model.getSnapshot().controls.map(({ id }) => id)).toEqual([
      'home', 'zoom-in', 'zoom-out', 'locate', 'layers', 'legend', 'measure', 'mode-toggle', 'fullscreen',
    ]);
  });

  it('uses a single roving tab stop', () => {
    const model = new MapControlModel(environment());
    expect(model.getSnapshot().controls.filter(({ tabIndex }) => tabIndex === 0)).toHaveLength(1);
    expect(model.getSnapshot().rovingFocusId).toBe('home');
  });

  it('moves keyboard focus and wraps in both directions', () => {
    const model = new MapControlModel(environment());
    expect(model.moveFocus(-1)).toBe('fullscreen');
    expect(model.moveFocus(1)).toBe('home');
    expect(model.moveFocus(1)).toBe('zoom-in');
  });

  it('supports Home and End style focus movement', () => {
    const model = new MapControlModel(environment());
    expect(model.focusLast()).toBe('fullscreen');
    expect(model.focusFirst()).toBe('home');
  });

  it('does not focus a disabled control', () => {
    const model = new MapControlModel(environment());
    model.setDisabled('zoom-in', true);
    expect(model.focus('zoom-in')).toBe(false);
    expect(model.getSnapshot().rovingFocusId).toBe('home');
  });

  it('repairs focus when the current control becomes disabled', () => {
    const model = new MapControlModel(environment());
    expect(model.focus('zoom-in')).toBe(true);
    model.setDisabled('zoom-in', true);
    expect(model.getSnapshot().rovingFocusId).toBe('home');
  });

  it('disables locate when geolocation is unavailable without hiding the affordance', () => {
    const model = new MapControlModel(environment({ geolocationAvailable: false }));
    const locate = model.getSnapshot().controls.find(({ id }) => id === 'locate');
    expect(locate).toMatchObject({ disabled: true, hidden: false });
  });

  it('hides fullscreen when the platform cannot provide it', () => {
    const model = new MapControlModel(environment({ fullscreenAvailable: false }));
    expect(model.getSnapshot().controls.find(({ id }) => id === 'fullscreen')?.hidden).toBe(true);
  });

  it('uses 48px targets for coarse pointers', () => {
    const model = new MapControlModel(environment({ coarsePointer: true }));
    expect(model.getSnapshot()).toMatchObject({ targetSize: 48, gap: 8 });
  });

  it('suppresses transition duration for reduced motion', () => {
    const model = new MapControlModel(environment({ reducedMotion: true }));
    expect(model.getSnapshot().transitionMs).toBe(0);
  });

  it('preserves forced-colors as a presentation contract', () => {
    const model = new MapControlModel(environment({ forcedColors: true }));
    expect(model.getSnapshot().forcedColors).toBe(true);
  });

  it('switches to compact density for short map viewports', () => {
    const model = new MapControlModel(environment({ height: 480 }));
    expect(model.getSnapshot()).toMatchObject({ density: 'compact', gap: 4 });
  });

  it('uses horizontal controls for narrow map viewports', () => {
    const model = new MapControlModel(environment({ width: 520 }));
    expect(model.getSnapshot().orientation).toBe('horizontal');
  });

  it('keeps the 2D/3D mode toggle discoverable in compact mode', () => {
    const model = new MapControlModel(environment({ width: 520 }));
    expect(model.getSnapshot().controls.find(({ id }) => id === 'mode-toggle')?.hidden).toBe(false);
  });

  it('expands a compact group to reveal its lower-priority controls', () => {
    const model = new MapControlModel(environment({ width: 520 }));
    expect(model.getSnapshot().controls.find(({ id }) => id === 'fullscreen')?.hidden).toBe(true);
    model.toggleGroup('view');
    expect(model.getSnapshot().controls.find(({ id }) => id === 'fullscreen')?.hidden).toBe(false);
    expect(model.getSnapshot().expandedGroup).toBe('view');
  });

  it('collapses an already expanded group', () => {
    const model = new MapControlModel(environment({ width: 520 }));
    model.toggleGroup('view');
    model.toggleGroup('view');
    expect(model.getSnapshot().expandedGroup).toBeNull();
  });

  it('marks active content and tool controls with aria-pressed semantics', () => {
    const model = new MapControlModel(environment());
    model.setActiveTool('layers');
    expect(model.getSnapshot().controls.find(({ id }) => id === 'layers')).toMatchObject({ active: true, ariaPressed: true });
    expect(model.getSnapshot().controls.find(({ id }) => id === 'home')?.ariaPressed).toBeUndefined();
  });

  it('ignores unknown active ids at runtime', () => {
    const model = new MapControlModel(environment());
    model.setActiveTool('unknown' as never);
    expect(model.getSnapshot().controls.every(({ active }) => !active)).toBe(true);
  });

  it('emits immutable snapshots to subscribers', () => {
    const model = new MapControlModel(environment());
    const snapshots = [] as ReturnType<MapControlModel['getSnapshot']>[];
    const unsubscribe = model.subscribe((snapshot) => snapshots.push(snapshot));
    model.setActiveTool('measure');
    unsubscribe();
    model.setActiveTool(null);
    expect(snapshots).toHaveLength(2);
    expect(Object.isFrozen(snapshots[0])).toBe(true);
    expect(Object.isFrozen(snapshots[0]?.controls)).toBe(true);
  });

  it('isolates observer failures and reports them', () => {
    const onObserverError = vi.fn();
    const healthy = vi.fn();
    const model = new MapControlModel(environment(), { onObserverError });
    model.subscribe(() => { throw new Error('observer failed'); });
    model.subscribe(healthy);
    model.setActiveTool('measure');
    expect(onObserverError).toHaveBeenCalled();
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  it('isolates failures in the observer error reporter', () => {
    const model = new MapControlModel(environment(), { onObserverError: () => { throw new Error('reporter failed'); } });
    model.subscribe(() => { throw new Error('observer failed'); });
    expect(() => model.setActiveTool('measure')).not.toThrow();
  });

  it('rejects duplicate control identifiers', () => {
    expect(() => new MapControlModel(environment(), { controls: [DEFAULT_MAP_CONTROLS[0]!, DEFAULT_MAP_CONTROLS[0]!] })).toThrow(/Duplicate/);
  });

  it('rejects empty control catalogs', () => {
    expect(() => new MapControlModel(environment(), { controls: [] })).toThrow(/At least one/);
  });

  it('rejects blank accessible labels', () => {
    expect(() => new MapControlModel(environment(), { controls: [{ id: 'home', group: 'navigation', label: ' ', priority: 1 }] })).toThrow(/label/);
  });

  it('rejects non-finite priorities', () => {
    expect(() => new MapControlModel(environment(), { controls: [{ id: 'home', group: 'navigation', label: 'Home', priority: Number.NaN }] })).toThrow(/finite/);
  });

  it('recomputes environment-dependent presentation without losing active state', () => {
    const model = new MapControlModel(environment());
    model.setActiveTool('measure');
    model.setEnvironment(environment({ width: 500, coarsePointer: true, reducedMotion: true }));
    expect(model.getSnapshot()).toMatchObject({ density: 'compact', targetSize: 48, transitionMs: 0 });
    expect(model.getSnapshot().controls.find(({ id }) => id === 'measure')?.active).toBe(true);
  });
});
