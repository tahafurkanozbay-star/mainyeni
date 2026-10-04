import { describe, expect, it } from 'vitest';
import { createArcGisResultWorkspaceExperience, type ResultWorkspaceSnapshot } from './ArcGisResultWorkspaceExperiencePolicy';
import {
  createArcGisResultWorkspaceMapInteractionContract,
  resolveArcGisResultWorkspaceMapSurfaceKey,
  resolveArcGisResultWorkspaceMapToolbarKey,
  type MapInteractionContract,
  type MapInteractionKeyEvent,
} from './ArcGisResultWorkspaceMapInteractionExperiencePolicy';

const snapshot = (options: { width?: number; coarse?: boolean; reduced?: boolean; forced?: boolean; modality?: 'keyboard' | 'pointer' } = {}): ResultWorkspaceSnapshot =>
  createArcGisResultWorkspaceExperience({
    heading: 'Kent sonuçları',
    status: 'ready',
    rows: [
      { key: '1', title: 'Birinci sonuç', subtitle: 'Çankaya', cells: [] },
      { key: '2', title: 'İkinci sonuç', subtitle: 'Keçiören', cells: [] },
    ],
  }, {
    viewportWidth: options.width ?? 1280,
    viewportHeight: 800,
    coarsePointer: options.coarse,
    reducedMotion: options.reduced,
    forcedColors: options.forced,
  }, options.modality ?? 'keyboard');

const contract = (overrides: Parameters<typeof createArcGisResultWorkspaceMapInteractionContract>[1] = {}, previous: MapInteractionContract | null = null) =>
  createArcGisResultWorkspaceMapInteractionContract(snapshot(), overrides, previous);

const ignoredEvents: readonly MapInteractionKeyEvent[] = [
  { key: 'ArrowRight', editable: true },
  { key: 'ArrowRight', composing: true },
  { key: 'ArrowRight', repeat: true },
  { key: 'ArrowRight', defaultPrevented: true },
  { key: 'ArrowRight', altKey: true },
  { key: 'ArrowRight', ctrlKey: true },
  { key: 'ArrowRight', metaKey: true },
];

describe('ArcGisResultWorkspaceMapInteractionExperiencePolicy', () => {
  it('builds deterministic semantic ids and a toolbar contract', () => {
    const value = contract({ scopeId: ' Kent Harita! ' });
    expect(value.scopeId).toBe('kent-harita');
    expect(value.toolbarId).toBe('kent-harita-toolbar');
    expect(value.instructionsId).toBe('kent-harita-instructions');
    expect(value.statusId).toBe('kent-harita-status');
    expect(value.mapFocusId).toBe('kent-harita-map');
    expect(value.role).toBe('toolbar');
    expect(value.label).toBe('Harita etkileşim araçları');
  });

  it('admits tools in canonical order regardless of caller order', () => {
    const value = contract({ availableTools: ['fullscreen', 'identify', 'explore'] });
    expect(value.tools.map((item) => item.tool)).toEqual(['explore', 'identify', 'fullscreen']);
  });

  it('deduplicates caller tool inventory', () => {
    const value = contract({ availableTools: ['explore', 'explore', 'select', 'select'] });
    expect(value.tools.map((item) => item.tool)).toEqual(['explore', 'select']);
  });

  it('maintains exactly one enabled roving tab stop', () => {
    const value = contract();
    expect(value.tools.filter((item) => item.tabIndex === 0)).toHaveLength(1);
    expect(value.tools.find((item) => item.tabIndex === 0)?.tool).toBe('explore');
  });

  it('preserves a previously roving tool when still enabled', () => {
    const initial = contract({ activeTool: 'identify' });
    const moved = { ...initial, rovingTool: 'measure-area' as const };
    const next = contract({ activeTool: 'identify' }, moved);
    expect(next.rovingTool).toBe('measure-area');
  });

  it('falls back when a previous roving tool disappears', () => {
    const initial = contract({ activeTool: 'identify' });
    const moved = { ...initial, rovingTool: 'measure-area' as const };
    const next = contract({ activeTool: 'identify', availableTools: ['explore', 'identify'] }, moved);
    expect(next.rovingTool).toBe('identify');
  });

  it('marks exclusive active tools as pressed', () => {
    const value = contract({ activeTool: 'measure-distance' });
    expect(value.activeTool).toBe('measure-distance');
    expect(value.tools.find((item) => item.tool === 'measure-distance')?.pressed).toBe(true);
    expect(value.tools.find((item) => item.tool === 'explore')?.pressed).toBe(false);
  });

  it('does not treat command-style locate as an exclusive active tool', () => {
    const value = contract({ activeTool: 'locate' });
    expect(value.activeTool).toBeNull();
  });

  it('represents fullscreen independently from exclusive active tool', () => {
    const value = contract({ activeTool: 'select', fullscreen: true });
    expect(value.activeTool).toBe('select');
    expect(value.tools.find((item) => item.tool === 'fullscreen')?.pressed).toBe(true);
    expect(value.fullscreen).toBe(true);
  });

  it('disables locate when geolocation is unavailable', () => {
    const value = contract({ canLocate: false });
    expect(value.tools.find((item) => item.tool === 'locate')?.disabled).toBe(true);
  });

  it('disables every tool while map is not ready', () => {
    const value = contract({ mapReady: false });
    expect(value.busy).toBe(true);
    expect(value.tools.every((item) => item.disabled)).toBe(true);
    expect(value.rovingTool).toBeNull();
    expect(value.statusMessage).toContain('hazırlanıyor');
  });

  it('uses assertive bounded map error status', () => {
    const hostile = `  Hata\u0000 ${'x'.repeat(500)} `;
    const value = contract({ mapError: hostile });
    expect(value.statusLive).toBe('assertive');
    expect(value.statusMessage.length).toBeLessThanOrEqual(180);
    expect(value.statusMessage).not.toContain('\u0000');
    expect(value.busy).toBe(false);
  });

  it('locks all interaction without inventing another state machine', () => {
    const value = contract({ interactionLocked: true });
    expect(value.interactionLocked).toBe(true);
    expect(value.tools.every((item) => item.disabled)).toBe(true);
    expect(value.statusMessage).toContain('kilitli');
  });

  it('clamps zoom to admitted bounds', () => {
    expect(contract({ minZoom: 5, maxZoom: 18, zoomLevel: 99 }).zoomLevel).toBe(18);
    expect(contract({ minZoom: 5, maxZoom: 18, zoomLevel: -99 }).zoomLevel).toBe(5);
  });

  it('normalizes invalid zoom inputs', () => {
    const value = contract({ minZoom: Number.NaN, maxZoom: Number.POSITIVE_INFINITY, zoomLevel: Number.NaN });
    expect(value.minZoom).toBe(0);
    expect(value.maxZoom).toBe(24);
    expect(value.zoomLevel).toBe(0);
  });

  it('normalizes bearing into a stable compass interval', () => {
    expect(contract({ bearing: -10 }).bearing).toBe(350);
    expect(contract({ bearing: 725 }).bearing).toBe(5);
  });

  it('clamps pitch to an ergonomic scene interval', () => {
    expect(contract({ pitch: -10 }).pitch).toBe(0);
    expect(contract({ pitch: 99 }).pitch).toBe(85);
  });

  it('inherits keyboard focus visibility', () => {
    expect(contract().focusVisible).toBe(true);
    const pointer = createArcGisResultWorkspaceMapInteractionContract(snapshot({ modality: 'pointer' }));
    expect(pointer.focusVisible).toBe(false);
  });

  it('inherits coarse pointer target sizing', () => {
    const value = createArcGisResultWorkspaceMapInteractionContract(snapshot({ coarse: true }));
    expect(value.minimumTargetSize).toBe(48);
    expect(value.tools.every((item) => item.minimumTargetSize === 48)).toBe(true);
  });

  it('inherits reduced motion and forced colors', () => {
    const value = createArcGisResultWorkspaceMapInteractionContract(snapshot({ reduced: true, forced: true }));
    expect(value.reducedMotion).toBe(true);
    expect(value.forcedColors).toBe(true);
  });

  it('provides compact phone-specific guidance', () => {
    const value = createArcGisResultWorkspaceMapInteractionContract(snapshot({ width: 390 }));
    expect(value.instructions).toContain('Escape');
    expect(value.instructions).not.toContain('artı ve eksi');
  });

  it('provides desktop map keyboard guidance', () => {
    expect(contract().instructions).toContain('artı ve eksi');
  });

  it('keeps revision stable for equivalent contracts', () => {
    const first = contract({ zoomLevel: 8, activeTool: 'select' });
    const second = contract({ zoomLevel: 8, activeTool: 'select' }, first);
    expect(second.revision).toBe(first.revision);
  });

  it('increments revision for meaningful state changes', () => {
    const first = contract({ zoomLevel: 8 });
    const second = contract({ zoomLevel: 9 }, first);
    expect(second.revision).toBe(first.revision + 1);
  });

  it('moves toolbar focus forward and wraps', () => {
    const value = contract({ availableTools: ['explore', 'identify'] });
    const next = resolveArcGisResultWorkspaceMapToolbarKey(value, { key: 'ArrowRight' });
    expect(next.action).toBe('focus-tool');
    expect(next.tool).toBe('identify');
    const moved = { ...value, rovingTool: 'identify' as const };
    expect(resolveArcGisResultWorkspaceMapToolbarKey(moved, { key: 'ArrowRight' }).tool).toBe('explore');
  });

  it('moves toolbar focus backward and wraps', () => {
    const value = contract({ availableTools: ['explore', 'identify'] });
    const next = resolveArcGisResultWorkspaceMapToolbarKey(value, { key: 'ArrowLeft' });
    expect(next.tool).toBe('identify');
  });

  it('supports Home and End boundaries', () => {
    const value = contract({ availableTools: ['explore', 'identify', 'fullscreen'] });
    expect(resolveArcGisResultWorkspaceMapToolbarKey(value, { key: 'Home' }).tool).toBe('explore');
    expect(resolveArcGisResultWorkspaceMapToolbarKey(value, { key: 'End' }).tool).toBe('fullscreen');
  });

  it('skips disabled tools during roving navigation', () => {
    const value = contract({ availableTools: ['explore', 'locate', 'fullscreen'], canLocate: false });
    expect(resolveArcGisResultWorkspaceMapToolbarKey(value, { key: 'ArrowRight' }).tool).toBe('fullscreen');
  });

  it('activates the roving tool with Enter', () => {
    const value = contract({ activeTool: 'identify' });
    const resolution = resolveArcGisResultWorkspaceMapToolbarKey(value, { key: 'Enter' });
    expect(resolution.action).toBe('activate-tool');
    expect(resolution.tool).toBe('identify');
    expect(resolution.preventDefault).toBe(true);
  });

  it('activates the roving tool with Space', () => {
    const value = contract({ activeTool: 'identify' });
    expect(resolveArcGisResultWorkspaceMapToolbarKey(value, { key: ' ' }).action).toBe('activate-tool');
  });

  it('restores map focus with Escape', () => {
    const value = contract();
    const resolution = resolveArcGisResultWorkspaceMapToolbarKey(value, { key: 'Escape' });
    expect(resolution.action).toBe('focus-map');
    expect(resolution.focusTarget).toBe(value.mapFocusId);
  });

  it.each(ignoredEvents)('fails closed for ignored toolbar key context %#', (event) => {
    const resolution = resolveArcGisResultWorkspaceMapToolbarKey(contract(), event);
    expect(resolution.handled).toBe(false);
    expect(resolution.preventDefault).toBe(false);
  });

  it('fails closed for locked toolbar interaction', () => {
    const value = contract({ interactionLocked: true });
    expect(resolveArcGisResultWorkspaceMapToolbarKey(value, { key: 'ArrowRight' }).handled).toBe(false);
  });

  it('pans map with arrow keys', () => {
    const value = contract({ zoomLevel: 10 });
    expect(resolveArcGisResultWorkspaceMapSurfaceKey(value, { key: 'ArrowUp' }).direction).toBe('north');
    expect(resolveArcGisResultWorkspaceMapSurfaceKey(value, { key: 'ArrowDown' }).direction).toBe('south');
    expect(resolveArcGisResultWorkspaceMapSurfaceKey(value, { key: 'ArrowLeft' }).direction).toBe('west');
    expect(resolveArcGisResultWorkspaceMapSurfaceKey(value, { key: 'ArrowRight' }).direction).toBe('east');
  });

  it('zooms in with plus and equals', () => {
    const value = contract({ zoomLevel: 10 });
    expect(resolveArcGisResultWorkspaceMapSurfaceKey(value, { key: '+' }).zoom).toBe('in');
    expect(resolveArcGisResultWorkspaceMapSurfaceKey(value, { key: '=' }).zoom).toBe('in');
  });

  it('zooms out with minus and underscore', () => {
    const value = contract({ zoomLevel: 10 });
    expect(resolveArcGisResultWorkspaceMapSurfaceKey(value, { key: '-' }).zoom).toBe('out');
    expect(resolveArcGisResultWorkspaceMapSurfaceKey(value, { key: '_' }).zoom).toBe('out');
  });

  it('does not consume zoom-in at maximum zoom', () => {
    const value = contract({ minZoom: 0, maxZoom: 10, zoomLevel: 10 });
    expect(resolveArcGisResultWorkspaceMapSurfaceKey(value, { key: '+' }).handled).toBe(false);
  });

  it('does not consume zoom-out at minimum zoom', () => {
    const value = contract({ minZoom: 4, maxZoom: 10, zoomLevel: 4 });
    expect(resolveArcGisResultWorkspaceMapSurfaceKey(value, { key: '-' }).handled).toBe(false);
  });

  it('resets orientation with unmodified zero', () => {
    const value = contract({ bearing: 120, pitch: 50 });
    const resolution = resolveArcGisResultWorkspaceMapSurfaceKey(value, { key: '0' });
    expect(resolution.action).toBe('reset-orientation');
    expect(resolution.preventDefault).toBe(true);
  });

  it('does not hijack shifted zero', () => {
    const value = contract();
    expect(resolveArcGisResultWorkspaceMapSurfaceKey(value, { key: '0', shiftKey: true }).handled).toBe(false);
  });

  it.each(ignoredEvents)('fails closed for ignored map surface key context %#', (event) => {
    const resolution = resolveArcGisResultWorkspaceMapSurfaceKey(contract(), event);
    expect(resolution.handled).toBe(false);
    expect(resolution.preventDefault).toBe(false);
  });

  it('does not consume map keys while busy', () => {
    const value = contract({ mapReady: false });
    expect(resolveArcGisResultWorkspaceMapSurfaceKey(value, { key: 'ArrowUp' }).handled).toBe(false);
  });

  it('does not consume unknown toolbar or map keys', () => {
    const value = contract();
    expect(resolveArcGisResultWorkspaceMapToolbarKey(value, { key: 'F12' }).handled).toBe(false);
    expect(resolveArcGisResultWorkspaceMapSurfaceKey(value, { key: 'F12' }).handled).toBe(false);
  });

  it('returns immutable top-level and tool contracts', () => {
    const value = contract();
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.tools)).toBe(true);
    expect(value.tools.every(Object.isFrozen)).toBe(true);
  });
});
