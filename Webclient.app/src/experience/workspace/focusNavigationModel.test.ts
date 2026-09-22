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
  test('normalizes deterministic order and starts without an active target', () => {
    const model = createWorkspaceFocusModel([...TARGETS].reverse());
    const state = model.getSnapshot();
    expect(state.activeId).toBeNull();
    expect(state.availableIds[0]).toBe('brand');
    expect(state.availableIds).not.toContain('hidden');
    expect(state.availableIds).not.toContain('disabled');
    expect(state.availableIds).not.toContain('dialog-close');
  });

  test('moves forward and wraps at the end', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    expect(model.move('next').activeId).toBe('brand');
    model.move('last');
    expect(model.move('next').activeId).toBe('brand');
  });

  test('moves backward and wraps at the beginning', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    expect(model.move('previous').activeId).toBe('status');
    expect(model.move('next').activeId).toBe('brand');
    expect(model.move('previous').activeId).toBe('status');
  });

  test('supports first and last navigation', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    expect(model.move('last').activeId).toBe('status');
    expect(model.move('first').activeId).toBe('brand');
  });

  test('moves directly to a semantic region', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    expect(model.moveRegion('map').activeId).toBe('map');
    expect(model.moveRegion('map', 'last').activeId).toBe('zoom');
    expect(model.getSnapshot().activeRegion).toBe('map');
  });

  test('leaves active target unchanged when a region has no available target', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    model.activate('map');
    expect(model.moveRegion('content').activeId).toBe('map');
  });

  test('does not activate hidden, disabled, unknown or modal-only targets outside modal scope', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    model.activate('map');
    expect(model.activate('hidden').activeId).toBe('map');
    expect(model.activate('disabled').activeId).toBe('map');
    expect(model.activate('missing').activeId).toBe('map');
    expect(model.activate('dialog-save').activeId).toBe('map');
  });

  test('allows explicit clearing of active focus identity', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    model.activate('map');
    expect(model.activate(null).activeId).toBeNull();
  });

  test('enters a modal scope and traps navigation to scoped targets', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    model.activate('map');
    const entered = model.enterModal('dialog');
    expect(entered.modalScope).toBe('dialog');
    expect(entered.activeId).toBe('dialog-close');
    expect(entered.availableIds).toEqual(['dialog-close', 'dialog-field', 'dialog-save']);
    expect(model.move('previous').activeId).toBe('dialog-save');
    expect(model.move('next').activeId).toBe('dialog-close');
  });

  test('honors an available preferred modal target', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    expect(model.enterModal('dialog', 'dialog-field').activeId).toBe('dialog-field');
  });

  test('ignores preferred targets outside the active modal scope', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    expect(model.enterModal('dialog', 'map').activeId).toBe('dialog-close');
  });

  test('restores the pre-modal target when leaving modal scope', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    model.activate('zoom');
    model.enterModal('dialog', 'dialog-save');
    expect(model.leaveModal().activeId).toBe('zoom');
    expect(model.getSnapshot().modalScope).toBeNull();
  });

  test('fails closed when the pre-modal target disappears before restore', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    model.activate('zoom');
    model.enterModal('dialog');
    model.replaceTargets(TARGETS.filter((target) => target.id !== 'zoom'));
    expect(model.leaveModal().activeId).toBeNull();
  });

  test('preserves active identity across target replacement when still available', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    model.activate('map');
    const state = model.replaceTargets([...TARGETS].reverse());
    expect(state.activeId).toBe('map');
  });

  test('clears active identity when replacement disables the active target', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    model.activate('map');
    const next = TARGETS.map((target) => target.id === 'map' ? { ...target, disabled: true } : target);
    expect(model.replaceTargets(next).activeId).toBeNull();
  });

  test('increments revision on state-producing mutations', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    const initial = model.getSnapshot().revision;
    const activated = model.activate('map').revision;
    const moved = model.move('next').revision;
    expect(activated).toBeGreaterThan(initial);
    expect(moved).toBeGreaterThan(activated);
  });

  test('freezes public snapshots and normalized target collections', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    const state = model.getSnapshot();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.targets)).toBe(true);
    expect(Object.isFrozen(state.availableIds)).toBe(true);
    expect(Object.isFrozen(state.targets[0])).toBe(true);
  });

  test('rejects duplicate target identities', () => {
    expect(() => createWorkspaceFocusModel([TARGETS[0]!, TARGETS[0]!])).toThrow(/Duplicate workspace focus target id/);
  });

  test('rejects missing target identity and label', () => {
    expect(() => createWorkspaceFocusModel([{ id: '', region: 'map', label: 'Map', order: 0 }])).toThrow(/id is required/);
    expect(() => createWorkspaceFocusModel([{ id: 'map', region: 'map', label: '', order: 0 }])).toThrow(/label is required/);
  });

  test('rejects non-finite ordering values', () => {
    expect(() => createWorkspaceFocusModel([{ id: 'map', region: 'map', label: 'Map', order: Number.NaN }])).toThrow(/order must be finite/);
  });

  test('rejects empty modal scope names', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    expect(() => model.enterModal('   ')).toThrow(/modal focus scope is required/);
  });

  test('handles an empty target collection without modulo or index failures', () => {
    const model = createWorkspaceFocusModel([]);
    expect(model.move('next').activeId).toBeNull();
    expect(model.move('previous').activeId).toBeNull();
    expect(model.moveRegion('map').activeId).toBeNull();
  });

  test('keeps caller-owned target arrays immutable', () => {
    const mutable = [...TARGETS];
    const before = mutable.map((target) => target.id);
    const model = createWorkspaceFocusModel(mutable);
    model.move('next');
    model.moveRegion('map');
    expect(mutable.map((target) => target.id)).toEqual(before);
  });

  test('sorts equal-order targets deterministically by region then id', () => {
    const model = createWorkspaceFocusModel([
      { id: 'z', region: 'map', label: 'Z', order: 1 },
      { id: 'a', region: 'map', label: 'A', order: 1 },
      { id: 'header', region: 'header', label: 'Header', order: 1 },
    ]);
    expect(model.getSnapshot().availableIds).toEqual(['header', 'a', 'z']);
  });

  test('keeps modal-only targets out of ordinary region navigation', () => {
    const model = createWorkspaceFocusModel(TARGETS);
    model.moveRegion('content');
    expect(model.getSnapshot().activeId).toBeNull();
    model.enterModal('dialog');
    expect(model.moveRegion('content', 'last').activeId).toBe('dialog-save');
  });
});
