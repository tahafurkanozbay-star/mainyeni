import { describe, expect, it } from 'vitest';
import { AsyncSurfaceState } from './asyncSurfaceState';
import { InteractionModalityModel } from './interactionModalityModel';
import { LegendPanelModel } from './legendPanelModel';
import { MapPopupModel } from './mapPopupModel';
import { ShortcutHelpModel } from './shortcutHelpModel';

describe('workspace accessibility contracts', () => {
  it('keeps coarse-pointer interactive targets at least 48px across new surfaces', () => {
    const legend = new LegendPanelModel({ items: [{ id: 'a', layerId: 'l', layerLabel: 'Katman', label: 'Öğe', symbolKind: 'fill' }], preferences: { coarsePointer: true } });
    const popup = new MapPopupModel({ preferences: { coarsePointer: true } });
    const asyncSurface = new AsyncSurfaceState({ coarsePointer: true });
    const modality = new InteractionModalityModel({ coarsePointer: true });
    expect(legend.snapshot.groups[0]?.rows[0]?.targetSize).toBeGreaterThanOrEqual(48);
    expect(popup.snapshot.targetSize).toBeGreaterThanOrEqual(48);
    expect(asyncSurface.snapshot.targetSize).toBeGreaterThanOrEqual(48);
    expect(modality.snapshot.targetSize).toBeGreaterThanOrEqual(48);
  });

  it('keeps reduced-motion preference explicit on animated-capable surfaces', () => {
    const legend = new LegendPanelModel({ items: [], preferences: { reducedMotion: true } });
    const popup = new MapPopupModel({ preferences: { reducedMotion: true } });
    const asyncSurface = new AsyncSurfaceState({ reducedMotion: true });
    expect(legend.snapshot.reducedMotion).toBe(true);
    expect(popup.snapshot.reducedMotion).toBe(true);
    expect(asyncSurface.snapshot.reducedMotion).toBe(true);
  });

  it('preserves one roving tab stop in legend and shortcut-help collections', () => {
    const legend = new LegendPanelModel({ items: [
      { id: 'a', layerId: 'l', layerLabel: 'Katman', label: 'A', symbolKind: 'fill' },
      { id: 'b', layerId: 'l', layerLabel: 'Katman', label: 'B', symbolKind: 'line' },
    ] });
    const help = new ShortcutHelpModel({ items: [
      { id: 'a', label: 'A', keys: ['a'], scope: 'global', category: 'Genel' },
      { id: 'b', label: 'B', keys: ['b'], scope: 'global', category: 'Genel' },
    ] });
    help.open();
    expect(legend.snapshot.groups.flatMap((group) => group.rows).filter((row) => row.tabIndex === 0)).toHaveLength(1);
    expect(help.snapshot.groups.flatMap((group) => group.rows).filter((row) => row.tabIndex === 0)).toHaveLength(1);
  });

  it('uses assertive live semantics only for errors', () => {
    const state = new AsyncSurfaceState();
    state.empty(); expect(state.snapshot.ariaLive).toBe('polite');
    state.error('Hata'); expect(state.snapshot.ariaLive).toBe('assertive');
    state.loading(); expect(state.snapshot.ariaLive).toBe('off');
  });

  it('restores focus ownership when transient popup and help surfaces close', () => {
    const popup = new MapPopupModel();
    popup.open([{ id: 'x', title: 'Detay' }], { restoreFocusTarget: 'map' });
    const help = new ShortcutHelpModel({ items: [{ id: 'x', label: 'Yardım', keys: ['?'], scope: 'global', category: 'Genel' }] });
    help.open('help-button');
    expect(popup.close()).toBe('map');
    expect(help.close()).toBe('help-button');
  });
});
