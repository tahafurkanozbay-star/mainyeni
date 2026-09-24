import { describe, expect, it, vi } from 'vitest';
import { createPanelLayoutModel } from './panelLayoutModel';

describe('panelLayoutModel', () => {
  it('starts wide with navigation and tools docked', () => {
    const model = createPanelLayoutModel({ viewportWidth: 1440, viewportHeight: 900 });
    const snapshot = model.snapshot();
    expect(snapshot.workspaceSize).toBe('wide');
    expect(snapshot.panels.navigation).toMatchObject({ open: true, presentation: 'docked', resizable: true });
    expect(snapshot.panels.tools).toMatchObject({ open: true, presentation: 'docked', resizable: true });
    expect(snapshot.panels.details).toMatchObject({ open: false, presentation: 'hidden' });
    expect(snapshot.mapInset).toEqual({ left: 320, right: 360, bottom: 0 });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('uses a persistent navigation panel and overlay tools at medium width', () => {
    const model = createPanelLayoutModel({ viewportWidth: 900, viewportHeight: 800 });
    const snapshot = model.snapshot();
    expect(snapshot.workspaceSize).toBe('medium');
    expect(snapshot.panels.navigation.presentation).toBe('docked');
    expect(snapshot.panels.tools.presentation).toBe('overlay');
    expect(snapshot.panels.tools.resizable).toBe(false);
    expect(snapshot.mapInset).toEqual({ left: 320, right: 0, bottom: 0 });
  });

  it('allows only one open panel at compact width', () => {
    const model = createPanelLayoutModel({ viewportWidth: 500, viewportHeight: 800 });
    expect(model.snapshot().panels.navigation.open).toBe(true);
    expect(model.snapshot().panels.tools.open).toBe(false);
    model.open('tools');
    expect(model.snapshot().panels.navigation.open).toBe(false);
    expect(model.snapshot().panels.tools).toMatchObject({ open: true, presentation: 'overlay' });
    model.open('details');
    expect(model.snapshot().panels.tools.open).toBe(false);
    expect(model.snapshot().panels.details).toMatchObject({ open: true, presentation: 'bottom-sheet' });
  });

  it('collapses extra panels when the viewport becomes compact', () => {
    const model = createPanelLayoutModel({ viewportWidth: 1400, viewportHeight: 900 });
    model.open('details');
    expect(Object.values(model.snapshot().panels).filter((panel) => panel.open)).toHaveLength(3);
    model.setViewport(600, 900);
    expect(Object.values(model.snapshot().panels).filter((panel) => panel.open)).toHaveLength(1);
  });

  it('clamps viewport dimensions to safe limits', () => {
    const model = createPanelLayoutModel({ viewportWidth: 10, viewportHeight: 100_000 });
    expect(model.snapshot()).toMatchObject({ viewportWidth: 240, viewportHeight: 16384 });
    model.setViewport(Number.NaN, Number.POSITIVE_INFINITY);
    expect(model.snapshot()).toMatchObject({ viewportWidth: 240, viewportHeight: 16384 });
  });

  it('opens, closes, and toggles panels deterministically', () => {
    const model = createPanelLayoutModel();
    model.close('navigation');
    expect(model.snapshot().panels.navigation.open).toBe(false);
    model.open('navigation');
    expect(model.snapshot().panels.navigation.open).toBe(true);
    model.toggle('tools');
    expect(model.snapshot().panels.tools.open).toBe(false);
    model.toggle('tools');
    expect(model.snapshot().panels.tools.open).toBe(true);
  });

  it('resizes docked panels within explicit bounds', () => {
    const model = createPanelLayoutModel({ viewportWidth: 1500 });
    expect(model.resize('navigation', 100)).toBe(true);
    expect(model.snapshot().panels.navigation.sizePx).toBe(420);
    expect(model.resize('navigation', 10_000)).toBe(true);
    expect(model.snapshot().panels.navigation.sizePx).toBe(480);
    expect(model.resize('navigation', 1)).toBe(false);
    expect(model.resize('navigation', -10_000)).toBe(true);
    expect(model.snapshot().panels.navigation.sizePx).toBe(260);
  });

  it('does not resize overlay or hidden panels', () => {
    const model = createPanelLayoutModel({ viewportWidth: 900 });
    expect(model.resize('tools', 40)).toBe(false);
    expect(model.resize('details', 40)).toBe(false);
    model.setViewport(600, 800);
    expect(model.resize('navigation', 40)).toBe(false);
  });

  it('sets and resets explicit panel sizes', () => {
    const model = createPanelLayoutModel();
    expect(model.setSize('tools', 500)).toBe(true);
    expect(model.snapshot().panels.tools.sizePx).toBe(500);
    model.resetSize('tools');
    expect(model.snapshot().panels.tools.sizePx).toBe(360);
    model.resetSize('tools');
    expect(model.snapshot().panels.tools.sizePx).toBe(360);
  });

  it('ignores non-finite resize values', () => {
    const model = createPanelLayoutModel();
    expect(model.resize('tools', Number.NaN)).toBe(false);
    expect(model.setSize('tools', Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('uses horizontal separator semantics for details panel', () => {
    const model = createPanelLayoutModel();
    model.open('details');
    expect(model.snapshot().panels.details).toMatchObject({
      presentation: 'docked',
      separatorOrientation: 'horizontal',
      resizable: true,
    });
    expect(model.snapshot().mapInset.bottom).toBe(320);
  });

  it('exposes coarse-pointer and reduced-motion presentation facts', () => {
    const model = createPanelLayoutModel();
    model.setPreferences({ coarsePointer: true, reducedMotion: true });
    expect(model.snapshot()).toMatchObject({ coarsePointer: true, reducedMotion: true, minimumTargetPx: 48 });
    model.setPreferences({ coarsePointer: false });
    expect(model.snapshot().minimumTargetPx).toBe(44);
  });

  it('does not revise state when preferences are unchanged', () => {
    const model = createPanelLayoutModel({ coarsePointer: true });
    const revision = model.snapshot().revision;
    model.setPreferences({ coarsePointer: true });
    expect(model.snapshot().revision).toBe(revision);
  });

  it('notifies subscribers and allows deterministic unsubscribe', () => {
    const observer = vi.fn();
    const model = createPanelLayoutModel();
    const unsubscribe = model.subscribe(observer);
    expect(observer).toHaveBeenCalledTimes(1);
    model.close('tools');
    expect(observer).toHaveBeenCalledTimes(2);
    expect(observer.mock.calls.at(-1)?.[0]).toMatchObject({ revision: 1 });
    unsubscribe();
    model.open('tools');
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it('isolates observer failures through the diagnostic channel', () => {
    const reporter = vi.fn();
    const model = createPanelLayoutModel({ onObserverError: reporter });
    model.subscribe(() => { throw new Error('observer failed'); });
    expect(() => model.close('tools')).not.toThrow();
    expect(reporter).toHaveBeenCalled();
    expect(model.snapshot().panels.tools.open).toBe(false);
  });

  it('survives diagnostic reporter failures', () => {
    const model = createPanelLayoutModel({ onObserverError: () => { throw new Error('reporter failed'); } });
    model.subscribe(() => { throw new Error('observer failed'); });
    expect(() => model.close('navigation')).not.toThrow();
    expect(model.snapshot().panels.navigation.open).toBe(false);
  });
});
