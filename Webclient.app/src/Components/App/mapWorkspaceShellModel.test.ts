import { describe, expect, it, vi } from 'vitest';
import {
  MAP_WORKSPACE_LANDMARKS,
  MapWorkspaceShellModel,
  classifyMapWorkspaceViewport,
  type MapWorkspaceLandmarkId,
} from './mapWorkspaceShellModel';

const availability = (ids: readonly MapWorkspaceLandmarkId[]) => {
  const values = new Map<MapWorkspaceLandmarkId, boolean>();
  for (const landmark of MAP_WORKSPACE_LANDMARKS) values.set(landmark.id, ids.includes(landmark.id));
  return values;
};

describe('classifyMapWorkspaceViewport', () => {
  it.each([
    [1, 'compact'],
    [719, 'compact'],
    [720, 'medium'],
    [1199, 'medium'],
    [1200, 'wide'],
    [1920, 'wide'],
  ] as const)('classifies width %s as %s', (width, expected) => {
    expect(classifyMapWorkspaceViewport(width)).toBe(expected);
  });
});

describe('MapWorkspaceShellModel', () => {
  it('starts with immutable bounded defaults', () => {
    const model = new MapWorkspaceShellModel();
    const snapshot = model.getSnapshot();
    expect(snapshot.revision).toBe(0);
    expect(snapshot.phase).toBe('booting');
    expect(snapshot.healthTone).toBe('neutral');
    expect(snapshot.viewport).toBe('wide');
    expect(snapshot.width).toBe(1280);
    expect(snapshot.height).toBe(720);
    expect(snapshot.inputModality).toBe('unknown');
    expect(snapshot.availableLandmarkCount).toBe(0);
    expect(snapshot.activeLandmarkId).toBeNull();
    expect(snapshot.landmarks).toHaveLength(MAP_WORKSPACE_LANDMARKS.length);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.landmarks)).toBe(true);
  });

  it('maps lifecycle phases to visible health semantics', () => {
    const model = new MapWorkspaceShellModel();
    model.setPhase('ready');
    expect(model.getSnapshot()).toMatchObject({ phase: 'ready', healthTone: 'success' });
    model.setPhase('updating');
    expect(model.getSnapshot()).toMatchObject({ phase: 'updating', healthTone: 'progress' });
    model.setPhase('error');
    expect(model.getSnapshot()).toMatchObject({ phase: 'error', healthTone: 'danger' });
  });

  it('does not publish duplicate phase updates', () => {
    const model = new MapWorkspaceShellModel({ initialPhase: 'ready' });
    const listener = vi.fn();
    model.subscribe(listener);
    model.setPhase('ready');
    expect(listener).not.toHaveBeenCalled();
    expect(model.getSnapshot().revision).toBe(0);
  });

  it('normalizes invalid environment dimensions and derives viewport', () => {
    const model = new MapWorkspaceShellModel();
    model.setEnvironment({
      width: Number.NaN,
      height: Number.POSITIVE_INFINITY,
      coarsePointer: true,
      reducedMotion: true,
      forcedColors: true,
    });
    expect(model.getSnapshot()).toMatchObject({
      width: 1280,
      height: 720,
      viewport: 'wide',
      coarsePointer: true,
      reducedMotion: true,
      forcedColors: true,
    });
    model.setEnvironment({ width: 375, height: 812, coarsePointer: true, reducedMotion: false, forcedColors: false });
    expect(model.getSnapshot()).toMatchObject({ width: 375, height: 812, viewport: 'compact' });
  });

  it('publishes environment changes exactly once', () => {
    const model = new MapWorkspaceShellModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.setEnvironment({ width: 900, height: 700, coarsePointer: false, reducedMotion: false, forcedColors: false });
    model.setEnvironment({ width: 900, height: 700, coarsePointer: false, reducedMotion: false, forcedColors: false });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(model.getSnapshot().revision).toBe(1);
    expect(model.getSnapshot().viewport).toBe('medium');
  });

  it('tracks input modality without duplicate notifications', () => {
    const model = new MapWorkspaceShellModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.setInputModality('keyboard');
    model.setInputModality('keyboard');
    model.setInputModality('touch');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(model.getSnapshot().inputModality).toBe('touch');
  });

  it('publishes a deterministic landmark inventory', () => {
    const model = new MapWorkspaceShellModel();
    model.setAllLandmarkAvailability(availability(['map', 'navigation', 'search', 'sidebar', 'toolbar', 'help']));
    const snapshot = model.getSnapshot();
    expect(snapshot.availableLandmarkCount).toBe(6);
    expect(snapshot.landmarks.map((item) => item.id)).toEqual([
      'map', 'navigation', 'search', 'sidebar', 'toolbar', 'help',
    ]);
    expect(snapshot.landmarks.map((item) => item.order)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(snapshot.landmarks.every((item) => item.available)).toBe(true);
  });

  it('keeps unavailable landmarks inactive', () => {
    const model = new MapWorkspaceShellModel();
    model.setActiveLandmark('toolbar');
    expect(model.getSnapshot().activeLandmarkId).toBeNull();
    model.setLandmarkAvailability('toolbar', true);
    model.setActiveLandmark('toolbar');
    expect(model.getSnapshot().activeLandmarkId).toBe('toolbar');
    expect(model.getSnapshot().landmarks.find((item) => item.id === 'toolbar')?.active).toBe(true);
  });

  it('clears active landmark when it becomes unavailable', () => {
    const model = new MapWorkspaceShellModel();
    model.setLandmarkAvailability('sidebar', true);
    model.setActiveLandmark('sidebar');
    model.setLandmarkAvailability('sidebar', false);
    expect(model.getSnapshot().activeLandmarkId).toBeNull();
    expect(model.getSnapshot().landmarks.find((item) => item.id === 'sidebar')?.active).toBe(false);
  });

  it('updates multiple availability flags in one publication', () => {
    const model = new MapWorkspaceShellModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.setAllLandmarkAvailability(availability(['map', 'sidebar', 'toolbar']));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(model.getSnapshot().availableLandmarkCount).toBe(3);
  });

  it('does not publish when bulk availability is unchanged', () => {
    const model = new MapWorkspaceShellModel();
    const values = availability(['map']);
    model.setAllLandmarkAvailability(values);
    const revision = model.getSnapshot().revision;
    model.setAllLandmarkAvailability(values);
    expect(model.getSnapshot().revision).toBe(revision);
  });

  it('includes landmark count in ready announcement', () => {
    const model = new MapWorkspaceShellModel({ initialPhase: 'ready' });
    model.setAllLandmarkAvailability(availability(['map', 'search', 'help']));
    expect(model.getSnapshot().announcement).toContain('3 hızlı gezinme hedefi');
  });

  it('uses stable announcements for busy and error phases', () => {
    const model = new MapWorkspaceShellModel();
    expect(model.getSnapshot().announcement).toBe('Harita çalışma alanı hazırlanıyor.');
    model.setPhase('updating');
    expect(model.getSnapshot().announcement).toContain('güncelleniyor');
    model.setPhase('error');
    expect(model.getSnapshot().announcement).toContain('bir sorun oluştu');
  });

  it('supports user-controlled compact utility state', () => {
    const model = new MapWorkspaceShellModel();
    model.setUtilityCollapsed(true);
    expect(model.getSnapshot().utilityCollapsed).toBe(true);
    model.toggleUtilityCollapsed();
    expect(model.getSnapshot().utilityCollapsed).toBe(false);
    model.toggleUtilityCollapsed();
    expect(model.getSnapshot().utilityCollapsed).toBe(true);
  });

  it('resets only interaction state while preserving environment and availability', () => {
    const model = new MapWorkspaceShellModel();
    model.setEnvironment({ width: 500, height: 700, coarsePointer: true, reducedMotion: true, forcedColors: false });
    model.setLandmarkAvailability('map', true);
    model.setActiveLandmark('map');
    model.setInputModality('keyboard');
    model.setUtilityCollapsed(true);
    model.resetInteractionState();
    expect(model.getSnapshot()).toMatchObject({
      viewport: 'compact',
      coarsePointer: true,
      reducedMotion: true,
      activeLandmarkId: null,
      inputModality: 'unknown',
      utilityCollapsed: false,
      availableLandmarkCount: 1,
    });
  });

  it('isolates a failing observer and still notifies healthy observers', () => {
    const onListenerError = vi.fn();
    const model = new MapWorkspaceShellModel({ onListenerError });
    const healthy = vi.fn();
    model.subscribe(() => { throw new TypeError('observer failed'); });
    model.subscribe(healthy);
    model.setPhase('ready');
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(onListenerError).toHaveBeenCalledTimes(1);
    expect(model.getDiagnostics()).toMatchObject({
      listenerFailureCount: 1,
      reporterFailureCount: 0,
      lastFailureKind: 'TypeError',
      lastFailureRevision: 1,
    });
  });

  it('contains reporter failures without interrupting model propagation', () => {
    const healthy = vi.fn();
    const model = new MapWorkspaceShellModel({ onListenerError: () => { throw new RangeError('reporter failed'); } });
    model.subscribe(() => { throw new Error('observer failed'); });
    model.subscribe(healthy);
    model.setPhase('ready');
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(model.getDiagnostics()).toMatchObject({
      listenerFailureCount: 1,
      reporterFailureCount: 1,
      lastFailureKind: 'reporter:RangeError',
    });
  });

  it('enforces a bounded listener budget', () => {
    const model = new MapWorkspaceShellModel({ listenerLimit: 2 });
    const first = vi.fn();
    const second = vi.fn();
    const rejected = vi.fn();
    model.subscribe(first);
    model.subscribe(second);
    model.subscribe(rejected);
    model.setPhase('ready');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(rejected).not.toHaveBeenCalled();
    expect(model.getDiagnostics()).toMatchObject({ listenerCount: 2, rejectedListenerCount: 1 });
  });

  it('deduplicates the same listener', () => {
    const model = new MapWorkspaceShellModel();
    const listener = vi.fn();
    const firstUnsubscribe = model.subscribe(listener);
    const secondUnsubscribe = model.subscribe(listener);
    expect(model.getDiagnostics().listenerCount).toBe(1);
    secondUnsubscribe();
    expect(model.getDiagnostics().listenerCount).toBe(0);
    firstUnsubscribe();
    expect(model.getDiagnostics().listenerCount).toBe(0);
  });

  it('does not mutate after dispose', () => {
    const model = new MapWorkspaceShellModel();
    const before = model.getSnapshot();
    model.dispose();
    model.setPhase('ready');
    model.setEnvironment({ width: 320, height: 480, coarsePointer: true, reducedMotion: true, forcedColors: true });
    model.setInputModality('keyboard');
    model.setLandmarkAvailability('map', true);
    model.setUtilityCollapsed(true);
    expect(model.getSnapshot()).toBe(before);
    expect(model.getDiagnostics()).toMatchObject({ disposed: true, listenerCount: 0 });
  });

  it('rejects subscriptions after dispose without throwing', () => {
    const model = new MapWorkspaceShellModel();
    model.dispose();
    const listener = vi.fn();
    const unsubscribe = model.subscribe(listener);
    unsubscribe();
    expect(model.getDiagnostics()).toMatchObject({ rejectedListenerCount: 1, disposed: true });
  });

  it('freezes individual landmark snapshots', () => {
    const model = new MapWorkspaceShellModel();
    model.setLandmarkAvailability('map', true);
    const landmark = model.getSnapshot().landmarks[0];
    expect(Object.isFrozen(landmark)).toBe(true);
  });
});
