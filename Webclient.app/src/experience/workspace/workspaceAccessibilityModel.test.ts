import { describe, expect, it } from 'vitest';
import {
  closeWorkspaceDialog,
  createWorkspaceAccessibilityState,
  enterWorkspaceFocusZone,
  openWorkspaceDialog,
  setCommandPaletteOpen,
  setWorkspaceConnectivity,
  setWorkspaceInputModality,
  setWorkspaceMapBusy,
  setWorkspaceMediaAccessibility,
  workspaceAccessibilitySummary,
  workspaceFocusSelector,
} from './workspaceAccessibilityModel';

describe('workspaceAccessibilityModel', () => {
  it('creates a bounded deterministic initial state', () => {
    const state = createWorkspaceAccessibilityState();
    expect(state).toEqual({
      modality: 'unknown', focusZone: 'unknown', previousFocusZone: 'unknown', dialogDepth: 0,
      commandPaletteOpen: false, mapBusy: false, online: true, reducedMotion: false,
      forcedColors: false, sequence: 0,
    });
    expect(Object.isFrozen(state)).toBe(true);
  });

  it('normalizes invalid negative dialog depth', () => {
    expect(createWorkspaceAccessibilityState({ dialogDepth: -20 }).dialogDepth).toBe(0);
  });

  it('changes input modality without announcements', () => {
    const result = setWorkspaceInputModality(createWorkspaceAccessibilityState(), 'keyboard');
    expect(result.state.modality).toBe('keyboard');
    expect(result.state.sequence).toBe(1);
    expect(result.announcement).toBeNull();
  });

  it('keeps idempotent modality transitions referentially stable', () => {
    const state = createWorkspaceAccessibilityState({ modality: 'keyboard' });
    expect(setWorkspaceInputModality(state, 'keyboard').state).toBe(state);
  });

  it('tracks previous focus zone', () => {
    const state = createWorkspaceAccessibilityState({ focusZone: 'map' });
    const result = enterWorkspaceFocusZone(state, 'tools');
    expect(result.state.focusZone).toBe('tools');
    expect(result.state.previousFocusZone).toBe('map');
  });

  it('does not mutate sequence for repeated focus entry', () => {
    const state = createWorkspaceAccessibilityState({ focusZone: 'map' });
    expect(enterWorkspaceFocusZone(state, 'map').state).toBe(state);
  });

  it('opens a dialog and records focus origin', () => {
    const state = createWorkspaceAccessibilityState({ focusZone: 'tools' });
    const result = openWorkspaceDialog(state);
    expect(result.state.focusZone).toBe('dialog');
    expect(result.state.previousFocusZone).toBe('tools');
    expect(result.state.dialogDepth).toBe(1);
    expect(result.announcement).toContain('açıldı');
  });

  it('supports nested dialogs without repeated announcements', () => {
    const first = openWorkspaceDialog(createWorkspaceAccessibilityState({ focusZone: 'map' }));
    const second = openWorkspaceDialog(first.state);
    expect(second.state.dialogDepth).toBe(2);
    expect(second.announcement).toBeNull();
  });

  it('restores focus origin after final dialog closes', () => {
    const opened = openWorkspaceDialog(createWorkspaceAccessibilityState({ focusZone: 'tools' }));
    const result = closeWorkspaceDialog(opened.state);
    expect(result.state.dialogDepth).toBe(0);
    expect(result.restoreFocusTo).toBe('tools');
    expect(result.state.focusZone).toBe('tools');
  });

  it('ignores close when no dialog is open', () => {
    const state = createWorkspaceAccessibilityState();
    expect(closeWorkspaceDialog(state).state).toBe(state);
  });

  it('opens and closes command palette with focus recovery', () => {
    const state = createWorkspaceAccessibilityState({ focusZone: 'map' });
    const opened = setCommandPaletteOpen(state, true);
    expect(opened.state.focusZone).toBe('command-palette');
    expect(opened.state.previousFocusZone).toBe('map');
    const closed = setCommandPaletteOpen(opened.state, false);
    expect(closed.restoreFocusTo).toBe('map');
    expect(closed.state.focusZone).toBe('map');
  });

  it('uses workspace as safe palette recovery when origin is palette', () => {
    const state = createWorkspaceAccessibilityState({
      focusZone: 'command-palette', previousFocusZone: 'command-palette', commandPaletteOpen: true,
    });
    expect(setCommandPaletteOpen(state, false).restoreFocusTo).toBe('workspace');
  });

  it('announces map busy transitions politely', () => {
    const busy = setWorkspaceMapBusy(createWorkspaceAccessibilityState(), true);
    expect(busy.priority).toBe('polite');
    expect(busy.announcement).toContain('güncelleniyor');
    const ready = setWorkspaceMapBusy(busy.state, false);
    expect(ready.announcement).toContain('tamamlandı');
  });

  it('makes offline transition assertive and recovery polite', () => {
    const offline = setWorkspaceConnectivity(createWorkspaceAccessibilityState(), false);
    expect(offline.priority).toBe('assertive');
    expect(offline.announcement).toContain('Bağlantı kesildi');
    const online = setWorkspaceConnectivity(offline.state, true);
    expect(online.priority).toBe('polite');
    expect(online.announcement).toContain('yeniden kuruldu');
  });

  it('does not announce repeated connectivity state', () => {
    const state = createWorkspaceAccessibilityState({ online: false });
    expect(setWorkspaceConnectivity(state, false).state).toBe(state);
  });

  it('tracks reduced motion and forced colors as media state', () => {
    const result = setWorkspaceMediaAccessibility(createWorkspaceAccessibilityState(), {
      reducedMotion: true, forcedColors: true,
    });
    expect(result.state.reducedMotion).toBe(true);
    expect(result.state.forcedColors).toBe(true);
    expect(result.announcement).toBeNull();
  });

  it.each([
    ['map', '#esri-map-container'],
    ['tools', '#sidebar'],
    ['workspace', '#experience-workspace-controls'],
    ['command-palette', '[data-experience-command-palette]'],
    ['dialog', '[role="dialog"]'],
    ['unknown', null],
  ] as const)('maps %s focus zone to a stable selector', (zone, selector) => {
    expect(workspaceFocusSelector(zone)).toBe(selector);
  });

  it('builds a concise accessibility summary', () => {
    const state = createWorkspaceAccessibilityState({
      modality: 'keyboard', online: false, mapBusy: true, reducedMotion: true, forcedColors: true,
    });
    expect(workspaceAccessibilitySummary(state)).toEqual([
      'Çevrimdışı', 'Harita güncelleniyor', 'Azaltılmış hareket', 'Zorunlu renkler etkin', 'Klavye kullanımı',
    ]);
  });

  it('returns a frozen summary', () => {
    expect(Object.isFrozen(workspaceAccessibilitySummary(createWorkspaceAccessibilityState()))).toBe(true);
  });
});
