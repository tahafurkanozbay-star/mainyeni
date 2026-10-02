import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_LANDMARK_DEFINITIONS,
  createWorkspaceLandmarkInventory,
  workspaceLandmarkEntry,
  workspaceLandmarkInventoryChanged,
  workspaceLandmarkRequiredFailures,
  workspaceLandmarkStatus,
  workspaceLandmarkUsableIds,
  type WorkspaceLandmarkObservation,
} from './workspaceLandmarkInventoryModel';

const observation = (
  id: WorkspaceLandmarkObservation['id'],
  patch: Partial<Omit<WorkspaceLandmarkObservation, 'id'>> = {},
): WorkspaceLandmarkObservation => ({
  id,
  present: true,
  visible: true,
  focusable: true,
  labelled: true,
  disabled: false,
  ...patch,
});

const readyCore = (): readonly WorkspaceLandmarkObservation[] => [
  observation('map'),
  observation('navigation'),
  observation('search'),
  observation('sidebar'),
  observation('toolbar'),
  observation('workspace'),
];

describe('workspaceLandmarkInventoryModel', () => {
  it('publishes deterministic definitions in stable order', () => {
    expect(WORKSPACE_LANDMARK_DEFINITIONS.map((item) => item.id)).toEqual([
      'map',
      'navigation',
      'search',
      'sidebar',
      'toolbar',
      'workspace',
      'help',
      'dialog',
      'command-palette',
    ]);
    expect(WORKSPACE_LANDMARK_DEFINITIONS.map((item) => item.order)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(Object.isFrozen(WORKSPACE_LANDMARK_DEFINITIONS)).toBe(true);
    expect(WORKSPACE_LANDMARK_DEFINITIONS.every((item) => Object.isFrozen(item))).toBe(true);
  });

  it.each([
    [{ present: false }, 'missing'],
    [{ present: true, visible: false }, 'hidden'],
    [{ present: true, visible: true, disabled: true }, 'disabled'],
    [{ present: true, visible: true, disabled: false, labelled: false }, 'unlabelled'],
    [{ present: true, visible: true, disabled: false, labelled: true, focusable: false }, 'unfocusable'],
    [{ present: true, visible: true, disabled: false, labelled: true, focusable: true }, 'ready'],
  ] as const)('classifies landmark status %#', (patch, expected) => {
    expect(workspaceLandmarkStatus({ id: 'map', focusable: false, labelled: false, disabled: false, visible: false, ...patch })).toBe(expected);
  });

  it('reports a critical inventory when required landmarks are absent', () => {
    const snapshot = createWorkspaceLandmarkInventory([]);
    expect(snapshot.health).toBe('critical');
    expect(snapshot.readyCount).toBe(0);
    expect(snapshot.missingRequiredCount).toBe(6);
    expect(snapshot.announcement).toContain('6 zorunlu');
    expect(workspaceLandmarkRequiredFailures(snapshot)).toHaveLength(6);
  });

  it('reports ready when all required landmarks are usable and optional surfaces are absent', () => {
    const snapshot = createWorkspaceLandmarkInventory(readyCore());
    expect(snapshot.health).toBe('ready');
    expect(snapshot.readyCount).toBe(6);
    expect(snapshot.degradedCount).toBe(3);
    expect(snapshot.missingRequiredCount).toBe(0);
    expect(snapshot.announcement).toBe('6 çalışma alanı hedefi kullanıma hazır.');
  });

  it('marks visible optional landmarks as degraded only when they are present but unusable', () => {
    const missingHelp = createWorkspaceLandmarkInventory(readyCore());
    const brokenHelp = createWorkspaceLandmarkInventory([
      ...readyCore(),
      observation('help', { labelled: false }),
    ]);
    expect(missingHelp.health).toBe('ready');
    expect(brokenHelp.health).toBe('degraded');
    expect(workspaceLandmarkEntry(brokenHelp, 'help')?.status).toBe('unlabelled');
  });

  it('marks required unlabelled landmarks as degraded without treating them as physically missing', () => {
    const snapshot = createWorkspaceLandmarkInventory([
      ...readyCore().filter((item) => item.id !== 'toolbar'),
      observation('toolbar', { labelled: false }),
    ]);
    expect(snapshot.health).toBe('degraded');
    expect(snapshot.missingRequiredCount).toBe(0);
    expect(workspaceLandmarkEntry(snapshot, 'toolbar')?.status).toBe('unlabelled');
  });

  it('marks required hidden landmarks as critical', () => {
    const snapshot = createWorkspaceLandmarkInventory([
      ...readyCore().filter((item) => item.id !== 'sidebar'),
      observation('sidebar', { visible: false }),
    ]);
    expect(snapshot.health).toBe('critical');
    expect(snapshot.missingRequiredCount).toBe(1);
    expect(workspaceLandmarkRequiredFailures(snapshot).map((item) => item.id)).toContain('sidebar');
  });

  it('keeps focus zones unique and ordered by landmark definitions', () => {
    const snapshot = createWorkspaceLandmarkInventory([
      ...readyCore(),
      observation('dialog'),
      observation('command-palette'),
    ]);
    expect(snapshot.availableFocusZones).toEqual(['map', 'workspace', 'tools', 'dialog', 'command-palette']);
    expect(Object.isFrozen(snapshot.availableFocusZones)).toBe(true);
  });

  it('does not expose focus zones for hidden or disabled landmarks', () => {
    const snapshot = createWorkspaceLandmarkInventory([
      observation('map', { disabled: true }),
      observation('navigation'),
      observation('search', { visible: false }),
      observation('sidebar'),
      observation('toolbar'),
      observation('workspace'),
    ]);
    expect(snapshot.availableFocusZones).not.toContain('map');
    expect(snapshot.availableFocusZones).toEqual(['workspace', 'tools']);
  });

  it('returns usable ids without leaking DOM objects', () => {
    const snapshot = createWorkspaceLandmarkInventory([
      ...readyCore(),
      observation('help'),
      observation('dialog', { focusable: false }),
    ]);
    expect(workspaceLandmarkUsableIds(snapshot)).toEqual([
      'map',
      'navigation',
      'search',
      'sidebar',
      'toolbar',
      'workspace',
      'help',
    ]);
    expect(snapshot.entries.every((entry) => Object.values(entry).every((value) => !(value instanceof Element)))).toBe(true);
  });

  it('supports a bounded required-id override for specialized shells', () => {
    const snapshot = createWorkspaceLandmarkInventory([
      observation('map'),
      observation('workspace'),
    ], { requiredIds: ['map', 'workspace', 'map'] });
    expect(snapshot.health).toBe('ready');
    expect(snapshot.entries.filter((item) => item.required).map((item) => item.id)).toEqual(['map', 'workspace']);
  });

  it('keeps disabled required landmarks degraded instead of critical', () => {
    const snapshot = createWorkspaceLandmarkInventory([
      ...readyCore().filter((item) => item.id !== 'search'),
      observation('search', { disabled: true }),
    ]);
    expect(snapshot.health).toBe('degraded');
    expect(workspaceLandmarkEntry(snapshot, 'search')?.status).toBe('disabled');
  });

  it('normalizes duplicate observations using the last bounded observation', () => {
    const snapshot = createWorkspaceLandmarkInventory([
      observation('map', { visible: false }),
      observation('map'),
      ...readyCore().filter((item) => item.id !== 'map'),
    ]);
    expect(workspaceLandmarkEntry(snapshot, 'map')?.status).toBe('ready');
  });

  it('bounds observation intake so unbounded callers cannot grow retained state', () => {
    const many = Array.from({ length: 40 }, (_, index) => observation(index % 2 === 0 ? 'map' : 'workspace'));
    const snapshot = createWorkspaceLandmarkInventory(many);
    expect(snapshot.entries).toHaveLength(WORKSPACE_LANDMARK_DEFINITIONS.length);
    expect(snapshot.totalCount).toBe(9);
  });

  it('sanitizes invalid revision values', () => {
    expect(createWorkspaceLandmarkInventory(readyCore(), {}, Number.NaN).revision).toBe(0);
    expect(createWorkspaceLandmarkInventory(readyCore(), {}, -12).revision).toBe(0);
    expect(createWorkspaceLandmarkInventory(readyCore(), {}, 4.9).revision).toBe(4);
  });

  it('freezes snapshots and entries for external-store safety', () => {
    const snapshot = createWorkspaceLandmarkInventory(readyCore());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(snapshot.entries.every((entry) => Object.isFrozen(entry))).toBe(true);
  });

  it('detects meaningful status changes while ignoring revision-only changes', () => {
    const first = createWorkspaceLandmarkInventory(readyCore(), {}, 1);
    const revisionOnly = createWorkspaceLandmarkInventory(readyCore(), {}, 2);
    const changed = createWorkspaceLandmarkInventory([
      ...readyCore().filter((item) => item.id !== 'toolbar'),
      observation('toolbar', { focusable: false }),
    ], {}, 3);
    expect(workspaceLandmarkInventoryChanged(first, revisionOnly)).toBe(false);
    expect(workspaceLandmarkInventoryChanged(first, changed)).toBe(true);
  });

  it('detects required-policy changes even when physical observations are stable', () => {
    const base = createWorkspaceLandmarkInventory(readyCore());
    const specialized = createWorkspaceLandmarkInventory(readyCore(), { requiredIds: ['map', 'workspace'] });
    expect(workspaceLandmarkInventoryChanged(base, specialized)).toBe(true);
  });

  it('returns null for unknown inventory lookups without mutating state', () => {
    const snapshot = createWorkspaceLandmarkInventory(readyCore());
    expect(workspaceLandmarkEntry(snapshot, 'dialog')).not.toBeNull();
    expect(workspaceLandmarkEntry(snapshot, 'command-palette')?.status).toBe('missing');
    expect(snapshot.revision).toBe(0);
  });
});
