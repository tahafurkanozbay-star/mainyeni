import { describe, expect, it } from 'vitest';
import type { ResultWorkspaceSnapshot } from './ArcGisResultWorkspaceExperiencePolicy';
import {
  createArcGisResultWorkspaceMapAccessibilityContract,
  resolveArcGisResultWorkspaceMapAccessibilityKey,
  type WorkspaceMapAccessibilityContract,
} from './ArcGisResultWorkspaceMapAccessibilityExperiencePolicy';

const snapshot = (overrides: Partial<ResultWorkspaceSnapshot> = {}): ResultWorkspaceSnapshot => ({
  model: { status: 'ready' } as ResultWorkspaceSnapshot['model'],
  interaction: {
    resultIds: ['a', 'b', 'c'],
    selectedIds: [],
    focusedId: 'a',
    activeId: null,
    surface: 'map',
    viewport: 'desktop',
    detailOpen: false,
    filterOpen: false,
    scrollTop: 0,
    rowHeight: 56,
    viewportHeight: 700,
  },
  presentation: {
    viewport: 'desktop', panel: 'map', layout: 'split', density: 'comfortable',
    filtersOverlay: false, detailOverlay: false, mapVisible: true, collectionVisible: true,
    splitView: true, compactChrome: false,
  },
  accessibility: {
    collectionRole: 'region', collectionLabel: 'Sonuçlar', collectionBusy: false, collectionLive: 'polite',
    detailRole: 'region', detailLabel: 'Detay', filterRole: 'region', filterLabel: 'Filtreler', mapLabel: 'Harita',
    focusVisible: true, minimumTargetSize: 44, motionDurationMs: 160, forcedColors: false,
  },
  modality: 'keyboard',
  revision: 1,
  ...overrides,
});

const activeTabStops = (contract: WorkspaceMapAccessibilityContract): string[] =>
  contract.controls.filter((control) => control.tabIndex === 0).map((control) => control.control);

describe('ArcGisResultWorkspaceMapAccessibilityExperiencePolicy', () => {
  it('creates a semantic map region with deterministic ids and bounded status copy', () => {
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(snapshot(), {
      scopeId: '  Kent Haritası / 01  ', mapTitle: 'Kent sonuç haritası', resultCount: 3,
    });
    expect(contract.scopeId).toBe('kent-haritas-01');
    expect(contract.regionId).toBe('kent-haritas-01-region');
    expect(contract.headingId).toBe('kent-haritas-01-heading');
    expect(contract.descriptionId).toBe('kent-haritas-01-description');
    expect(contract.statusId).toBe('kent-haritas-01-status');
    expect(contract.role).toBe('region');
    expect(contract.label).toBe('Kent sonuç haritası');
    expect(contract.statusMessage).toBe('Harita hazır: 3 sonuç.');
    expect(contract.statusLive).toBe('polite');
    expect(contract.busy).toBe(false);
  });

  it('inherits target, motion, forced-colors and keyboard focus policies', () => {
    const source = snapshot({
      modality: 'keyboard',
      accessibility: {
        ...snapshot().accessibility,
        minimumTargetSize: 48,
        motionDurationMs: 0,
        forcedColors: true,
      },
    });
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(source);
    expect(contract.minimumTargetSize).toBe(48);
    expect(contract.controls.every((control) => control.minimumTargetSize === 48)).toBe(true);
    expect(contract.reducedMotion).toBe(true);
    expect(contract.forcedColors).toBe(true);
    expect(contract.focusVisible).toBe(true);
  });

  it('does not expose keyboard focus styling for pointer modality', () => {
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(snapshot({ modality: 'pointer' }));
    expect(contract.focusVisible).toBe(false);
  });

  it('announces loading without enabling map-manipulation controls', () => {
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(snapshot(), { mapReady: false });
    expect(contract.busy).toBe(true);
    expect(contract.statusMessage).toBe('Harita hazırlanıyor.');
    expect(contract.statusLive).toBe('polite');
    expect(contract.controls.find((item) => item.control === 'zoom-in')?.disabled).toBe(true);
    expect(contract.controls.find((item) => item.control === 'zoom-out')?.disabled).toBe(true);
    expect(contract.controls.find((item) => item.control === 'reset-view')?.disabled).toBe(true);
  });

  it('announces sanitized map errors assertively and disables map manipulation', () => {
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(snapshot(), {
      mapError: '  Harita\u0000 katmanı   yüklenemedi.  ',
    });
    expect(contract.statusMessage).toBe('Harita katmanı yüklenemedi.');
    expect(contract.statusLive).toBe('assertive');
    expect(contract.busy).toBe(false);
    expect(contract.controls.find((item) => item.control === 'zoom-in')?.disabled).toBe(true);
  });

  it('bounds hostile labels and counts', () => {
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(snapshot(), {
      activeResultLabel: `\u0000${'x'.repeat(500)}`,
      resultCount: Number.POSITIVE_INFINITY,
      selectedCount: 90_000,
    });
    expect(contract.statusMessage.length).toBeLessThanOrEqual(180);
    expect(contract.statusMessage).not.toContain('\u0000');
    expect(contract.statusMessage).toContain('20.000 seçili');
    expect(contract.statusMessage).toContain('3 sonuç');
  });

  it('caps explicit result counts at the workspace admission limit', () => {
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(snapshot(), { resultCount: 999_999 });
    expect(contract.statusMessage).toContain('20.000 sonuç');
  });

  it('describes selection and focused result without retaining payload graphs', () => {
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(snapshot(), {
      selectedCount: 2, activeResultLabel: 'Ankara Kalesi',
    });
    expect(contract.statusMessage).toBe('Harita hazır: 3 sonuç, 2 seçili. Odaktaki sonuç: Ankara Kalesi.');
    expect(Object.keys(contract)).not.toContain('snapshot');
    expect(Object.keys(contract)).not.toContain('geometry');
    expect(Object.keys(contract)).not.toContain('graphic');
  });

  it('uses a single roving tab stop among enabled controls', () => {
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(snapshot());
    expect(activeTabStops(contract)).toHaveLength(1);
    expect(activeTabStops(contract)).toEqual(['filters']);
  });

  it('disables results navigation when the collection is already the active visible panel', () => {
    const source = snapshot({ presentation: { ...snapshot().presentation, panel: 'collection' } });
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(source);
    expect(contract.controls.find((item) => item.control === 'results')?.disabled).toBe(true);
  });

  it('disables filter open control while filters are already open', () => {
    const source = snapshot({ interaction: { ...snapshot().interaction, filterOpen: true } });
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(source);
    expect(contract.controls.find((item) => item.control === 'filters')?.disabled).toBe(true);
  });

  it('disables detail without a focused or active result', () => {
    const source = snapshot({ interaction: { ...snapshot().interaction, focusedId: null, activeId: null } });
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(source);
    expect(contract.controls.find((item) => item.control === 'detail')?.disabled).toBe(true);
  });

  it('enables detail for an active result even if collection focus is absent', () => {
    const source = snapshot({ interaction: { ...snapshot().interaction, focusedId: null, activeId: 'b' } });
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(source);
    expect(contract.controls.find((item) => item.control === 'detail')?.disabled).toBe(false);
  });

  it('admits controls in canonical order and removes duplicates', () => {
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(snapshot(), {
      controls: ['reset-view', 'filters', 'filters', 'zoom-in'],
    });
    expect(contract.controls.map((item) => item.control)).toEqual(['filters', 'zoom-in', 'reset-view']);
  });

  it('preserves the previous active control while it remains enabled', () => {
    const first = createArcGisResultWorkspaceMapAccessibilityContract(snapshot(), { controls: ['zoom-in', 'zoom-out'] });
    const previous = { ...first, activeControl: 'zoom-out' as const };
    const next = createArcGisResultWorkspaceMapAccessibilityContract(snapshot(), { controls: ['zoom-in', 'zoom-out'] }, previous);
    expect(next.activeControl).toBe('zoom-out');
    expect(activeTabStops(next)).toEqual(['zoom-out']);
  });

  it('falls back to the first enabled control when the previous control becomes disabled', () => {
    const first = createArcGisResultWorkspaceMapAccessibilityContract(snapshot(), { controls: ['detail', 'zoom-in'] });
    const previous = { ...first, activeControl: 'detail' as const };
    const source = snapshot({ interaction: { ...snapshot().interaction, focusedId: null, activeId: null } });
    const next = createArcGisResultWorkspaceMapAccessibilityContract(source, { controls: ['detail', 'zoom-in'] }, previous);
    expect(next.activeControl).toBe('zoom-in');
  });

  it('increments revision only when observable contract state changes', () => {
    const first = createArcGisResultWorkspaceMapAccessibilityContract(snapshot());
    const stable = createArcGisResultWorkspaceMapAccessibilityContract(snapshot(), {}, first);
    const changed = createArcGisResultWorkspaceMapAccessibilityContract(snapshot(), { selectedCount: 2 }, stable);
    expect(first.revision).toBe(0);
    expect(stable.revision).toBe(0);
    expect(changed.revision).toBe(1);
  });

  it('describes hidden map state on compact result view', () => {
    const source = snapshot({
      presentation: {
        ...snapshot().presentation,
        viewport: 'phone', panel: 'collection', splitView: false, mapVisible: false, compactChrome: true,
      },
    });
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(source);
    expect(contract.mapVisible).toBe(false);
    expect(contract.description).toContain('Harita şu anda gizli');
  });

  it('describes compact visible map without desktop split-view guidance', () => {
    const source = snapshot({
      presentation: {
        ...snapshot().presentation,
        viewport: 'phone', panel: 'map', splitView: false, mapVisible: true, collectionVisible: false, compactChrome: true,
      },
    });
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(source);
    expect(contract.description).toContain('Harita görünümü etkin');
    expect(contract.description).not.toContain('birlikte görünür');
  });

  it.each([
    ['ArrowRight', 'zoom-in'],
    ['ArrowDown', 'zoom-in'],
    ['ArrowLeft', 'reset-view'],
    ['ArrowUp', 'reset-view'],
  ] as const)('moves roving focus with %s and wraps across enabled controls', (key, expected) => {
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(snapshot(), {
      controls: ['filters', 'zoom-in', 'reset-view'],
    });
    const resolution = resolveArcGisResultWorkspaceMapAccessibilityKey(contract, { key });
    expect(resolution).toMatchObject({ handled: true, preventDefault: true, action: 'focus-control', control: expected });
  });

  it('moves to first and last enabled controls with Home and End', () => {
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(snapshot(), {
      controls: ['filters', 'zoom-in', 'reset-view'],
    });
    expect(resolveArcGisResultWorkspaceMapAccessibilityKey(contract, { key: 'Home' }).control).toBe('filters');
    expect(resolveArcGisResultWorkspaceMapAccessibilityKey(contract, { key: 'End' }).control).toBe('reset-view');
  });

  it.each(['Enter', ' '] as const)('invokes the active enabled control with %s', (key) => {
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(snapshot(), { controls: ['zoom-in'] });
    const resolution = resolveArcGisResultWorkspaceMapAccessibilityKey(contract, { key });
    expect(resolution).toEqual({
      handled: true, preventDefault: true, action: 'invoke-control', control: 'zoom-in',
      focusTarget: `${contract.scopeId}-control-zoom-in`,
    });
  });

  it('returns focus to the map region with Escape', () => {
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(snapshot());
    expect(resolveArcGisResultWorkspaceMapAccessibilityKey(contract, { key: 'Escape' })).toEqual({
      handled: true, preventDefault: true, action: 'focus-map', control: null, focusTarget: contract.regionId,
    });
  });

  it.each([
    { editable: true }, { composing: true }, { repeat: true }, { defaultPrevented: true },
    { altKey: true }, { ctrlKey: true }, { metaKey: true },
  ])('fails closed for suppressed keyboard context %#', (flags) => {
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(snapshot());
    expect(resolveArcGisResultWorkspaceMapAccessibilityKey(contract, { key: 'ArrowRight', ...flags })).toEqual({
      handled: false, preventDefault: false, action: 'none', control: null, focusTarget: null,
    });
  });

  it('does not consume unrelated keys', () => {
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(snapshot());
    expect(resolveArcGisResultWorkspaceMapAccessibilityKey(contract, { key: 'x' })).toEqual({
      handled: false, preventDefault: false, action: 'none', control: null, focusTarget: null,
    });
  });

  it('does not consume movement or invocation when no enabled controls exist', () => {
    const source = snapshot({
      interaction: { ...snapshot().interaction, focusedId: null, activeId: null, filterOpen: true },
      presentation: { ...snapshot().presentation, panel: 'collection' },
    });
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(source, {
      mapReady: false, controls: ['results', 'filters', 'detail', 'zoom-in', 'zoom-out', 'reset-view'],
    });
    expect(contract.activeControl).toBeNull();
    expect(activeTabStops(contract)).toHaveLength(0);
    expect(resolveArcGisResultWorkspaceMapAccessibilityKey(contract, { key: 'ArrowRight' }).handled).toBe(false);
    expect(resolveArcGisResultWorkspaceMapAccessibilityKey(contract, { key: 'Enter' }).handled).toBe(false);
  });

  it('returns frozen top-level and control collections', () => {
    const contract = createArcGisResultWorkspaceMapAccessibilityContract(snapshot());
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.controls)).toBe(true);
    expect(contract.controls.every(Object.isFrozen)).toBe(true);
  });
});
