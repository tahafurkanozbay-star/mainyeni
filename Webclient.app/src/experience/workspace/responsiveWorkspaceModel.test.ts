import { describe, expect, it, vi } from 'vitest';
import { createResponsiveWorkspaceModel, type WorkspaceSnapshot } from './responsiveWorkspaceModel';

describe('responsiveWorkspaceModel', () => {
  it('starts wide with persistent navigation and layers', () => {
    const model = createResponsiveWorkspaceModel({ width: 1440, height: 900 });
    const snapshot = model.snapshot();
    expect(snapshot.viewport).toBe('wide');
    expect(snapshot.panels.filter((panel) => panel.open).map((panel) => panel.id)).toEqual(['navigation', 'layers']);
    expect(snapshot.modalPanel).toBeNull();
    expect(snapshot.touchTargetPx).toBe(40);
  });

  it('classifies compact, medium and wide breakpoints deterministically', () => {
    const model = createResponsiveWorkspaceModel({ width: 719, height: 800 });
    expect(model.snapshot().viewport).toBe('compact');
    model.setViewport({ width: 720, height: 800 });
    expect(model.snapshot().viewport).toBe('medium');
    model.setViewport({ width: 1200, height: 800 });
    expect(model.snapshot().viewport).toBe('wide');
  });

  it('clamps invalid dimensions without exposing unsafe geometry', () => {
    const model = createResponsiveWorkspaceModel({ width: Number.POSITIVE_INFINITY, height: -1 });
    expect(model.snapshot()).toMatchObject({ width: 240, height: 240, viewport: 'compact' });
    model.setViewport({ width: 99_999, height: 99_999 });
    expect(model.snapshot()).toMatchObject({ width: 16_384, height: 16_384, viewport: 'wide' });
  });

  it('allows only one open panel on compact viewports', () => {
    const model = createResponsiveWorkspaceModel({ width: 390, height: 844 });
    model.openPanel('layers');
    expect(model.snapshot().modalPanel).toBe('layers');
    model.openPanel('details');
    expect(model.snapshot().panels.filter((panel) => panel.open).map((panel) => panel.id)).toEqual(['details']);
    expect(model.snapshot().modalPanel).toBe('details');
  });

  it('treats compact panels as overlays and closes them together', () => {
    const model = createResponsiveWorkspaceModel({ width: 430, height: 800 });
    model.openPanel('tools');
    expect(model.snapshot().modalPanel).toBe('tools');
    model.closeOverlays();
    expect(model.snapshot().modalPanel).toBeNull();
    expect(model.snapshot().panels.every((panel) => !panel.open)).toBe(true);
  });

  it('keeps navigation persistent on medium while auxiliary panels overlay', () => {
    const model = createResponsiveWorkspaceModel({ width: 900, height: 700 });
    model.openPanel('layers');
    const navigation = model.snapshot().panels.find((panel) => panel.id === 'navigation');
    const layers = model.snapshot().panels.find((panel) => panel.id === 'layers');
    expect(navigation).toMatchObject({ open: true, overlay: false });
    expect(layers).toMatchObject({ open: true, overlay: true });
    model.closeOverlays();
    expect(model.snapshot().panels.find((panel) => panel.id === 'navigation')?.open).toBe(true);
  });

  it('supports persistent pinning only when the panel is not an overlay', () => {
    const model = createResponsiveWorkspaceModel({ width: 1440, height: 900 });
    model.pinPanel('details', true);
    expect(model.snapshot().panels.find((panel) => panel.id === 'details')).toMatchObject({ open: true, pinned: true });
    model.setViewport({ width: 390, height: 800 });
    expect(model.snapshot().panels.find((panel) => panel.id === 'details')?.pinned).toBe(false);
    model.pinPanel('details', true);
    expect(model.snapshot().panels.find((panel) => panel.id === 'details')?.pinned).toBe(false);
  });

  it('restores core persistent panels when expanding to wide', () => {
    const model = createResponsiveWorkspaceModel({ width: 390, height: 800 });
    model.openPanel('tools');
    model.setViewport({ width: 1440, height: 900 });
    expect(model.snapshot().panels.filter((panel) => panel.open).map((panel) => panel.id)).toEqual(['navigation', 'layers', 'tools']);
  });

  it('uses larger touch targets for coarse pointers', () => {
    const model = createResponsiveWorkspaceModel({ width: 1440, height: 900, coarsePointer: true });
    expect(model.snapshot().touchTargetPx).toBe(48);
    model.setViewport({ width: 1440, height: 900, coarsePointer: false });
    expect(model.snapshot().touchTargetPx).toBe(40);
  });

  it('disables transition duration for reduced-motion users', () => {
    const model = createResponsiveWorkspaceModel({ width: 1440, height: 900, reducedMotion: true });
    expect(model.snapshot().transitionMs).toBe(0);
    model.setViewport({ width: 1440, height: 900, reducedMotion: false });
    expect(model.snapshot().transitionMs).toBe(180);
  });

  it('compacts map controls on short viewports', () => {
    const model = createResponsiveWorkspaceModel({ width: 1280, height: 500 });
    expect(model.snapshot().mapControlsCompact).toBe(true);
    model.setViewport({ width: 1280, height: 700 });
    expect(model.snapshot().mapControlsCompact).toBe(false);
  });

  it('tracks the active map or content surface', () => {
    const model = createResponsiveWorkspaceModel({ width: 1280, height: 800 });
    expect(model.snapshot().activeSurface).toBe('map');
    model.setActiveSurface('content');
    expect(model.snapshot().activeSurface).toBe('content');
  });

  it('does not publish no-op panel or surface transitions', () => {
    const model = createResponsiveWorkspaceModel({ width: 1280, height: 800 });
    const listener = vi.fn();
    model.subscribe(listener);
    model.openPanel('navigation');
    model.setActiveSurface('map');
    expect(listener).not.toHaveBeenCalled();
  });

  it('publishes immutable snapshots for observable transitions', () => {
    const model = createResponsiveWorkspaceModel({ width: 1280, height: 800 });
    let observed: WorkspaceSnapshot | undefined;
    model.subscribe((snapshot) => { observed = snapshot; });
    model.openPanel('details');
    expect(observed).toBeDefined();
    if (observed === undefined) throw new Error('Expected an observed workspace snapshot');
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed.panels)).toBe(true);
    expect(Object.isFrozen(observed.panels[0])).toBe(true);
  });

  it('isolates observer failures from workspace transitions', () => {
    const model = createResponsiveWorkspaceModel({ width: 1280, height: 800 });
    const observer = vi.fn();
    model.subscribe(() => { throw new Error('observer failure'); });
    model.subscribe(observer);
    expect(() => model.openPanel('details')).not.toThrow();
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes idempotently', () => {
    const model = createResponsiveWorkspaceModel({ width: 1280, height: 800 });
    const observer = vi.fn();
    const unsubscribe = model.subscribe(observer);
    unsubscribe();
    unsubscribe();
    model.openPanel('details');
    expect(observer).not.toHaveBeenCalled();
  });

  it('increments revisions only for observable mutations', () => {
    const model = createResponsiveWorkspaceModel({ width: 1280, height: 800 });
    expect(model.snapshot().revision).toBe(0);
    model.openPanel('details');
    expect(model.snapshot().revision).toBe(1);
    model.openPanel('details');
    expect(model.snapshot().revision).toBe(1);
    model.closePanel('details');
    expect(model.snapshot().revision).toBe(2);
  });

  it('toggles panels through the same responsive policy', () => {
    const model = createResponsiveWorkspaceModel({ width: 390, height: 800 });
    model.togglePanel('layers');
    expect(model.snapshot().modalPanel).toBe('layers');
    model.togglePanel('layers');
    expect(model.snapshot().modalPanel).toBeNull();
  });
});
