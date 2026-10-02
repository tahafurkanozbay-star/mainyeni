import { describe, expect, it } from 'vitest';
import {
  MAP_WORKSPACE_REGION_GUIDE,
  auditMapWorkspaceRegionGuide,
  buildMapWorkspaceRegionGuideEntries,
  getMapWorkspaceRegionGuide,
  type MapWorkspaceRegionGuideDefinition,
} from './mapWorkspaceRegionGuide';
import {
  MAP_WORKSPACE_SHELL_REGIONS,
  type MapWorkspaceShellRegionId,
  type MapWorkspaceShellRegionState,
} from './mapWorkspaceShellModel';

const REGION_IDS = MAP_WORKSPACE_SHELL_REGIONS.map((region) => region.id);

const state = (
  id: MapWorkspaceShellRegionId,
  overrides: Partial<MapWorkspaceShellRegionState> = {},
): MapWorkspaceShellRegionState => {
  const definition = MAP_WORKSPACE_SHELL_REGIONS.find((region) => region.id === id);
  if (!definition) throw new Error(`Missing test region: ${id}`);
  return Object.freeze({
    ...definition,
    available: true,
    active: false,
    lastFocusedRevision: null,
    ...overrides,
  });
};

describe('mapWorkspaceRegionGuide', () => {
  it('covers every canonical shell region exactly once', () => {
    const ids = MAP_WORKSPACE_REGION_GUIDE.map((entry) => entry.id);
    expect(ids).toEqual(REGION_IDS);
    expect(new Set(ids).size).toBe(REGION_IDS.length);
  });

  it('passes its own guide audit', () => {
    expect(auditMapWorkspaceRegionGuide(REGION_IDS)).toEqual([]);
  });

  it('keeps every guide definition immutable', () => {
    expect(Object.isFrozen(MAP_WORKSPACE_REGION_GUIDE)).toBe(true);
    expect(MAP_WORKSPACE_REGION_GUIDE.every(Object.isFrozen)).toBe(true);
  });

  it('requires non-empty user purpose text for all regions', () => {
    for (const entry of MAP_WORKSPACE_REGION_GUIDE) {
      expect(entry.purpose.trim().length).toBeGreaterThan(18);
    }
  });

  it('requires explicit keyboard guidance for all regions', () => {
    for (const entry of MAP_WORKSPACE_REGION_GUIDE) {
      expect(entry.keyboardHint.trim().length).toBeGreaterThan(18);
      expect(entry.keyboardHint).toMatch(/F6|Tab|Shift|Space|Enter|\?/);
    }
  });

  it('provides distinct available and unavailable labels', () => {
    for (const entry of MAP_WORKSPACE_REGION_GUIDE) {
      expect(entry.availableLabel.trim()).not.toBe('');
      expect(entry.unavailableLabel.trim()).not.toBe('');
      expect(entry.availableLabel).not.toBe(entry.unavailableLabel);
    }
  });

  it.each(REGION_IDS)('returns canonical guidance for %s', (id) => {
    const guide = getMapWorkspaceRegionGuide(id);
    expect(guide.id).toBe(id);
    expect(guide.purpose).toEqual(expect.any(String));
    expect(guide.keyboardHint).toEqual(expect.any(String));
  });

  it('reports a missing canonical region', () => {
    const partial = MAP_WORKSPACE_REGION_GUIDE.filter((entry) => entry.id !== 'toolbar');
    expect(auditMapWorkspaceRegionGuide(REGION_IDS, partial)).toContainEqual(expect.objectContaining({
      code: 'missing-region',
      regionId: 'toolbar',
    }));
  });

  it('reports duplicate region ids', () => {
    const duplicate = [
      ...MAP_WORKSPACE_REGION_GUIDE,
      MAP_WORKSPACE_REGION_GUIDE[0]!,
    ];
    expect(auditMapWorkspaceRegionGuide(REGION_IDS, duplicate)).toContainEqual(expect.objectContaining({
      code: 'duplicate-id',
      regionId: 'navigation',
    }));
  });

  it('reports empty purpose text', () => {
    const invalid: MapWorkspaceRegionGuideDefinition[] = MAP_WORKSPACE_REGION_GUIDE.map((entry) => (
      entry.id === 'map' ? { ...entry, purpose: '   ' } : { ...entry }
    ));
    expect(auditMapWorkspaceRegionGuide(REGION_IDS, invalid)).toContainEqual(expect.objectContaining({
      code: 'empty-purpose',
      regionId: 'map',
    }));
  });

  it('reports empty keyboard guidance', () => {
    const invalid: MapWorkspaceRegionGuideDefinition[] = MAP_WORKSPACE_REGION_GUIDE.map((entry) => (
      entry.id === 'sidebar' ? { ...entry, keyboardHint: '' } : { ...entry }
    ));
    expect(auditMapWorkspaceRegionGuide(REGION_IDS, invalid)).toContainEqual(expect.objectContaining({
      code: 'empty-keyboard-hint',
      regionId: 'sidebar',
    }));
  });

  it('can audit a reduced expected region contract', () => {
    const expected: MapWorkspaceShellRegionId[] = ['map', 'toolbar'];
    const guide = MAP_WORKSPACE_REGION_GUIDE.filter((entry) => expected.includes(entry.id));
    expect(auditMapWorkspaceRegionGuide(expected, guide)).toEqual([]);
  });

  it('builds immutable presentation entries', () => {
    const entries = buildMapWorkspaceRegionGuideEntries([
      state('map'),
      state('toolbar'),
    ]);
    expect(Object.isFrozen(entries)).toBe(true);
    expect(entries.every(Object.isFrozen)).toBe(true);
  });

  it('preserves shell ordering when building presentation entries', () => {
    const input = [state('navigation'), state('map'), state('sidebar'), state('toolbar')];
    const entries = buildMapWorkspaceRegionGuideEntries(input);
    expect(entries.map((entry) => entry.id)).toEqual(input.map((entry) => entry.id));
  });

  it('preserves active state from shell regions', () => {
    const entries = buildMapWorkspaceRegionGuideEntries([
      state('map'),
      state('toolbar', { active: true }),
    ]);
    expect(entries.find((entry) => entry.id === 'toolbar')?.active).toBe(true);
    expect(entries.find((entry) => entry.id === 'map')?.active).toBe(false);
  });

  it('preserves last focused revision', () => {
    const entries = buildMapWorkspaceRegionGuideEntries([
      state('map', { lastFocusedRevision: 42 }),
    ]);
    expect(entries[0]?.lastFocusedRevision).toBe(42);
  });

  it('uses available state labels when a region can be focused', () => {
    const entries = buildMapWorkspaceRegionGuideEntries([state('map', { available: true })]);
    expect(entries[0]?.stateLabel).toBe(getMapWorkspaceRegionGuide('map').availableLabel);
  });

  it('uses unavailable state labels when a region is hidden', () => {
    const entries = buildMapWorkspaceRegionGuideEntries([state('map', { available: false })]);
    expect(entries[0]?.stateLabel).toBe(getMapWorkspaceRegionGuide('map').unavailableLabel);
  });

  it('keeps navigation guidance focused on application-level movement', () => {
    const entry = getMapWorkspaceRegionGuide('navigation');
    expect(entry.purpose).toMatch(/menü|navigasyon|arama/i);
    expect(entry.keyboardHint).toMatch(/F6/i);
  });

  it('keeps map guidance focused on spatial interaction', () => {
    const entry = getMapWorkspaceRegionGuide('map');
    expect(entry.purpose).toMatch(/2D\/3D|harita/i);
    expect(entry.keyboardHint).toMatch(/yön tuşları|artı\/eksi/i);
  });

  it('keeps sidebar guidance focused on discoverability', () => {
    const entry = getMapWorkspaceRegionGuide('sidebar');
    expect(entry.purpose).toMatch(/Katman|hizmet|favori/i);
  });

  it('keeps toolbar guidance focused on map actions', () => {
    const entry = getMapWorkspaceRegionGuide('toolbar');
    expect(entry.purpose).toMatch(/Ölçüm|çizim|altlık|sorgu/i);
  });

  it('keeps workspace guidance focused on view preferences', () => {
    const entry = getMapWorkspaceRegionGuide('workspace');
    expect(entry.purpose).toMatch(/2D\/3D|görünüm|durum/i);
  });

  it('keeps help guidance focused on discoverability', () => {
    const entry = getMapWorkspaceRegionGuide('help');
    expect(entry.purpose).toMatch(/Kısayol|rehber/i);
    expect(entry.keyboardHint).toMatch(/Shift\+\?/i);
  });

  it('never embeds URLs in region guidance', () => {
    const serialized = JSON.stringify(MAP_WORKSPACE_REGION_GUIDE);
    expect(serialized).not.toMatch(/https?:\/\//i);
  });

  it('never embeds network or telemetry instructions', () => {
    const serialized = JSON.stringify(MAP_WORKSPACE_REGION_GUIDE).toLowerCase();
    expect(serialized).not.toContain('fetch(');
    expect(serialized).not.toContain('analytics');
    expect(serialized).not.toContain('telemetry');
  });

  it('keeps guide entries concise enough for map overlays', () => {
    for (const entry of MAP_WORKSPACE_REGION_GUIDE) {
      expect(entry.purpose.length).toBeLessThanOrEqual(120);
      expect(entry.keyboardHint.length).toBeLessThanOrEqual(150);
    }
  });

  it('does not mutate source shell region records', () => {
    const source = state('map');
    const before = JSON.stringify(source);
    buildMapWorkspaceRegionGuideEntries([source]);
    expect(JSON.stringify(source)).toBe(before);
  });
});
