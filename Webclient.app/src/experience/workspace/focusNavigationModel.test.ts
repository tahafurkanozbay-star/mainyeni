import { createWorkspaceFocusModel, type WorkspaceFocusTarget } from './focusNavigationModel';

const TARGETS: readonly WorkspaceFocusTarget[] = Object.freeze([
  { id: 'brand', region: 'header', label: 'Ana sayfa', order: 0 },
  { id: 'search', region: 'header', label: 'Arama', order: 10 },
  { id: 'nav-layers', region: 'navigation', label: 'Katmanlar', order: 20 },
  { id: 'map', region: 'map', label: 'Harita', order: 30 },
  { id: 'zoom', region: 'map', label: 'Yakınlaştır', order: 31 },
  { id: 'tools', region: 'tools', label: 'Araçlar', order: 40 },
  { id: 'status', region: 'status', label: 'Durum', order: 50 },
  { id: 'hidden', region: 'tools', label: 'Gizli', order: 41, hidden: true },
  { id: 'disabled', region: 'tools', label: 'Kapalı', order: 42, disabled: true },
  { id: 'dialog-close', region: 'content', label: 'Pencereyi kapat', order: 0, modalScope: 'dialog' },
  { id: 'dialog-field', region: 'content', label: 'Pencere alanı', order: 1, modalScope: 'dialog' },
  { id: 'dialog-save', region: 'content', label: 'Kaydet', order: 2, modalScope: 'dialog' },
]);

describe('focusNavigationModel', () => {
  test('normalizes deterministic order and availability', () => {
    const state = createWorkspaceFocusModel([...TARGETS].reverse()).getSnapshot();
    expect(state.activeId).toBeNull();
    expect(state.availableIds[0]).toBe('brand');
    expect(state.availableIds).not.toContain('hidden');
    expect(state.availableIds).not.toContain('disabled');
    expect(state.availableIds).not.toContain('dialog-close');
  });
  test('moves forward/backward and wraps', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    expect(model.move('next').activeId).toBe('brand');
    model.move('last');
    expect(model.move('next').activeId).toBe('brand');
    expect(model.move('previous').activeId).toBe('status');
  });
  test('supports semantic region navigation', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    expect(model.moveRegion('map').activeId).toBe('map');
    expect(model.moveRegion('map', 'last').activeId).toBe('zoom');
    expect(model.getSnapshot().activeRegion).toBe('map');
  });
  test('rejects activation of unavailable identities', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    model.activate('map');
    expect(model.activate('hidden').activeId).toBe('map');
    expect(model.activate('disabled').activeId).toBe('map');
    expect(model.activate('missing').activeId).toBe('map');
    expect(model.activate('dialog-save').activeId).toBe('map');
  });
  test('traps focus in modal scope and restores prior focus', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    model.activate('zoom');
    const entered = model.enterModal('dialog', 'dialog-field');
    expect(entered.availableIds).toEqual(['dialog-close', 'dialog-field', 'dialog-save']);
    expect(entered.activeId).toBe('dialog-field');
    expect(model.move('previous').activeId).toBe('dialog-close');
    expect(model.leaveModal().activeId).toBe('zoom');
  });
  test('fails closed when pre-modal target disappears', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    model.activate('zoom');
    model.enterModal('dialog');
    model.replaceTargets(TARGETS.filter((target) => target.id !== 'zoom'));
    expect(model.leaveModal().activeId).toBeNull();
  });
  test('preserves or clears active identity correctly on replacement', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    model.activate('map');
    expect(model.replaceTargets([...TARGETS].reverse()).activeId).toBe('map');
    const disabled = TARGETS.map((target) => target.id === 'map' ? { ...target, disabled: true } : target);
    expect(model.replaceTargets(disabled).activeId).toBeNull();
  });
  test('publishes immutable snapshots and revisions', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    const initial = model.getSnapshot();
    const next = model.activate('map');
    expect(next.revision).toBeGreaterThan(initial.revision);
    expect(Object.isFrozen(next)).toBe(true);
    expect(Object.isFrozen(next.targets)).toBe(true);
    expect(Object.isFrozen(next.availableIds)).toBe(true);
    expect(Object.isFrozen(next.targets[0])).toBe(true);
  });
  test('validates identities labels ordering and modal scopes', () => {
    expect(() => createWorkspaceFocusModel([TARGETS[0]!, TARGETS[0]!])).toThrow(/Duplicate/);
    expect(() => createWorkspaceFocusModel([{ id: '', region: 'map', label: 'Map', order: 0 }])).toThrow(/id is required/);
    expect(() => createWorkspaceFocusModel([{ id: 'map', region: 'map', label: '', order: 0 }])).toThrow(/label is required/);
    expect(() => createWorkspaceFocusModel([{ id: 'map', region: 'map', label: 'Map', order: Number.NaN }])).toThrow(/finite/);
    expect(() => createWorkspaceFocusModel(TARGETS).enterModal('   ')).toThrow(/scope is required/);
  });
  test('handles empty collections and equal-order deterministic sorting', () => {
    const empty = createWorkspaceFocusModel([]);
    expect(empty.move('next').activeId).toBeNull();
    const model = createWorkspaceFocusModel([
      { id: 'z', region: 'map', label: 'Z', order: 1 },
      { id: 'a', region: 'map', label: 'A', order: 1 },
      { id: 'header', region: 'header', label: 'Header', order: 1 },
    ]);
    expect(model.getSnapshot().availableIds).toEqual(['header', 'a', 'z']);
  });
});
