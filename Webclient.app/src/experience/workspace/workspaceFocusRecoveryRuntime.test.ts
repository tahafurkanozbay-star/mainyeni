import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceLandmarkInventory, type WorkspaceLandmarkObservation } from './workspaceLandmarkInventoryModel';
import { WorkspaceFocusRecoveryRuntime } from './workspaceFocusRecoveryRuntime';

const observation = (
  id: WorkspaceLandmarkObservation['id'],
  patch: Partial<Omit<WorkspaceLandmarkObservation, 'id'>> = {},
): WorkspaceLandmarkObservation => ({ id, present: true, visible: true, focusable: true, labelled: true, disabled: false, ...patch });

const inventory = createWorkspaceLandmarkInventory([
  observation('map'), observation('navigation'), observation('search'), observation('sidebar'), observation('toolbar'), observation('workspace'),
]);

describe('WorkspaceFocusRecoveryRuntime', () => {
  afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

  it('focuses the requested workspace zone and exposes a deterministic result', () => {
    document.body.innerHTML = '<main id="experience-workspace-controls" tabindex="0">Workspace</main>';
    const runtime = new WorkspaceFocusRecoveryRuntime({ document });
    const result = runtime.focusZone('workspace', 'keyboard');
    expect(result).toEqual(expect.objectContaining({ ok: true, zone: 'workspace', reason: 'focused', usedFallback: false }));
    expect(document.activeElement).toBe(document.getElementById('experience-workspace-controls'));
    expect(document.activeElement).toHaveAttribute('data-workspace-focus-visible', 'true');
    runtime.dispose();
  });

  it('uses keyboard-only focus-ring reflection', () => {
    document.body.innerHTML = '<div id="esri-map-container" tabindex="0">Map</div>';
    const runtime = new WorkspaceFocusRecoveryRuntime({ document });
    expect(runtime.focusZone('map', 'pointer').ok).toBe(true);
    expect(document.getElementById('esri-map-container')).not.toHaveAttribute('data-workspace-focus-visible');
    expect(runtime.focusZone('map', 'keyboard').ok).toBe(true);
    expect(document.getElementById('esri-map-container')).toHaveAttribute('data-workspace-focus-visible', 'true');
    runtime.dispose();
  });

  it('falls back from a missing preferred selector', () => {
    document.body.innerHTML = '<main tabindex="0">Fallback</main>';
    const runtime = new WorkspaceFocusRecoveryRuntime({ document });
    const result = runtime.focusZone('map', 'keyboard');
    expect(result.ok).toBe(true); expect(result.usedFallback).toBe(true); expect(result.selector).toBe('main');
    expect(document.activeElement).toBe(document.querySelector('main')); runtime.dispose();
  });

  it('rejects missing zones without throwing', () => {
    const runtime = new WorkspaceFocusRecoveryRuntime({ document });
    expect(runtime.focusZone('map')).toEqual(expect.objectContaining({ ok: false, reason: 'target-missing' }));
    expect(runtime.focusZone('unknown')).toEqual(expect.objectContaining({ ok: false, reason: 'target-missing' })); runtime.dispose();
  });

  it('skips hidden selector matches and uses a later visible match', () => {
    document.body.innerHTML = '<div id="sidebar" hidden tabindex="0">Old</div><div data-workspace-tools tabindex="0">New</div>';
    const runtime = new WorkspaceFocusRecoveryRuntime({ document }); const result = runtime.focusZone('tools');
    expect(result.ok).toBe(true); expect(document.activeElement).toBe(document.querySelector('[data-workspace-tools]')); runtime.dispose();
  });

  it('skips aria-disabled selector matches', () => {
    document.body.innerHTML = '<div id="sidebar" aria-disabled="true" tabindex="0">Disabled</div><div data-workspace-tools tabindex="0">Enabled</div>';
    const runtime = new WorkspaceFocusRecoveryRuntime({ document }); expect(runtime.focusZone('tools').ok).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('[data-workspace-tools]')); runtime.dispose();
  });

  it('prefers a real focusable descendant when a container is not naturally tabbable', () => {
    document.body.innerHTML = '<aside id="sidebar"><button type="button">Katmanlar</button></aside>';
    const runtime = new WorkspaceFocusRecoveryRuntime({ document }); const result = runtime.focusZone('tools');
    expect(result.ok).toBe(true); expect(document.activeElement).toBe(document.querySelector('button')); expect(result.temporaryTabIndex).toBe(false); runtime.dispose();
  });

  it('adds a temporary tabindex when a semantic target has no focusable descendant', () => {
    document.body.innerHTML = '<main id="experience-workspace-controls">Workspace status</main>';
    const root = document.getElementById('experience-workspace-controls')!; const runtime = new WorkspaceFocusRecoveryRuntime({ document }); const result = runtime.focusZone('workspace');
    expect(result.ok).toBe(true); expect(result.temporaryTabIndex).toBe(true); expect(root).toHaveAttribute('tabindex', '-1'); expect(document.activeElement).toBe(root);
    root.blur(); expect(root).not.toHaveAttribute('tabindex'); runtime.dispose();
  });

  it('restores a pre-existing negative tabindex after blur', () => {
    document.body.innerHTML = '<main id="experience-workspace-controls" tabindex="-1">Workspace</main>';
    const root = document.getElementById('experience-workspace-controls')!; const runtime = new WorkspaceFocusRecoveryRuntime({ document });
    expect(runtime.focusZone('workspace').ok).toBe(true); root.blur(); expect(root).toHaveAttribute('tabindex', '-1'); runtime.dispose();
  });

  it('preserves scroll position by requesting preventScroll', () => {
    document.body.innerHTML = '<div id="esri-map-container" tabindex="0">Map</div>'; const map = document.getElementById('esri-map-container')!;
    const focus = vi.spyOn(map, 'focus'); const runtime = new WorkspaceFocusRecoveryRuntime({ document }); runtime.focusZone('map');
    expect(focus).toHaveBeenCalledWith({ preventScroll: true }); runtime.dispose();
  });

  it('recovers to a preferred zone when body owns focus', () => {
    document.body.innerHTML = '<main id="experience-workspace-controls" tabindex="0">Workspace</main><div id="esri-map-container" tabindex="0">Map</div>'; document.body.focus();
    const runtime = new WorkspaceFocusRecoveryRuntime({ document }); const result = runtime.recoverDisconnectedFocus({ preferredZone: 'map', originZone: 'workspace', modality: 'keyboard', inventory, dialogDepth: 0, paletteOpen: false });
    expect(result.ok).toBe(true); expect(result.zone).toBe('map'); runtime.dispose();
  });

  it('does not steal focus from a connected active element', () => {
    document.body.innerHTML = '<button id="active">Stay</button><div id="esri-map-container" tabindex="0">Map</div>'; document.getElementById('active')!.focus();
    const runtime = new WorkspaceFocusRecoveryRuntime({ document }); const result = runtime.recoverDisconnectedFocus({ preferredZone: 'map', originZone: 'workspace', modality: 'keyboard', inventory, dialogDepth: 0, paletteOpen: false });
    expect(result.ok).toBe(false); expect(document.activeElement).toBe(document.getElementById('active')); runtime.dispose();
  });

  it('prefers an open dialog over the requested base zone', () => {
    document.body.innerHTML = '<div id="esri-map-container" tabindex="0">Map</div><div role="dialog" aria-label="Ayarlar"><button type="button">Kapat</button></div>';
    const dialogInventory = createWorkspaceLandmarkInventory([
      ...inventory.entries.filter((entry) => entry.id !== 'dialog').map((entry) => ({ id: entry.id, present: entry.present, visible: entry.visible, focusable: entry.focusable, labelled: entry.labelled, disabled: entry.disabled })),
      observation('dialog'),
    ]);
    const runtime = new WorkspaceFocusRecoveryRuntime({ document }); const result = runtime.recover({ reason: 'dialog-close', preferredZone: 'map', originZone: 'workspace', modality: 'keyboard', availableZones: dialogInventory.availableFocusZones, dialogDepth: 1, paletteOpen: false });
    expect(result.ok).toBe(true); expect(result.zone).toBe('dialog'); expect(document.activeElement).toBe(document.querySelector('button')); runtime.dispose();
  });

  it('cycles forward through canonical workspace, tools and map zones', () => {
    document.body.innerHTML = '<main id="experience-workspace-controls" tabindex="0">Workspace</main><aside id="sidebar" tabindex="0">Tools</aside><div id="esri-map-container" tabindex="0">Map</div>';
    const runtime = new WorkspaceFocusRecoveryRuntime({ document }); expect(runtime.cycle('workspace', inventory, 'keyboard').zone).toBe('tools');
    expect(runtime.cycle('tools', inventory, 'keyboard').zone).toBe('map'); expect(runtime.cycle('map', inventory, 'keyboard').zone).toBe('workspace'); runtime.dispose();
  });

  it('cycles backwards through canonical zones', () => {
    document.body.innerHTML = '<main id="experience-workspace-controls" tabindex="0">Workspace</main><aside id="sidebar" tabindex="0">Tools</aside><div id="esri-map-container" tabindex="0">Map</div>';
    const runtime = new WorkspaceFocusRecoveryRuntime({ document }); expect(runtime.cycle('workspace', inventory, 'keyboard', true).zone).toBe('map'); expect(runtime.cycle('map', inventory, 'keyboard', true).zone).toBe('tools'); runtime.dispose();
  });

  it('reports focus exceptions without leaking them into user interaction', () => {
    document.body.innerHTML = '<div id="esri-map-container" tabindex="0">Map</div>'; const map = document.getElementById('esri-map-container')!;
    vi.spyOn(map, 'focus').mockImplementation(() => { throw new Error('focus unavailable'); }); const reporter = vi.fn();
    const runtime = new WorkspaceFocusRecoveryRuntime({ document, onError: reporter }); const result = runtime.focusZone('map');
    expect(result.ok).toBe(false); expect(result.reason).toBe('focus-failed'); expect(reporter).toHaveBeenCalledTimes(1); runtime.dispose();
  });

  it('contains diagnostic reporter failures', () => {
    document.body.innerHTML = '<div id="esri-map-container" tabindex="0">Map</div>';
    vi.spyOn(document.getElementById('esri-map-container')!, 'focus').mockImplementation(() => { throw new Error('focus unavailable'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runtime = new WorkspaceFocusRecoveryRuntime({ document, onError: () => { throw new Error('reporter unavailable'); } });
    expect(runtime.focusZone('map').ok).toBe(false);
    expect(runtime.getReporterFailureCount()).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('uses a custom focus-ring attribute when configured', () => {
    document.body.innerHTML = '<div id="esri-map-container" tabindex="0">Map</div>'; const runtime = new WorkspaceFocusRecoveryRuntime({ document, focusRingAttribute: 'data-test-focus-ring' });
    runtime.focusZone('map', 'keyboard'); expect(document.getElementById('esri-map-container')).toHaveAttribute('data-test-focus-ring', 'true'); runtime.dispose();
  });

  it('restores temporary tabindex during disposal', () => {
    document.body.innerHTML = '<main id="experience-workspace-controls">Workspace</main>'; const root = document.getElementById('experience-workspace-controls')!;
    const runtime = new WorkspaceFocusRecoveryRuntime({ document }); runtime.focusZone('workspace'); expect(root).toHaveAttribute('tabindex', '-1'); runtime.dispose(); expect(root).not.toHaveAttribute('tabindex');
  });

  it('rejects future focus work after disposal', () => {
    document.body.innerHTML = '<div id="esri-map-container" tabindex="0">Map</div>'; const runtime = new WorkspaceFocusRecoveryRuntime({ document }); runtime.dispose();
    expect(runtime.focusZone('map')).toEqual(expect.objectContaining({ ok: false, reason: 'runtime-disposed' })); expect(runtime.isDisposed()).toBe(true);
  });
});