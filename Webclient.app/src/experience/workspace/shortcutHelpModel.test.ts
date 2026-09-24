import { describe, expect, it, vi } from 'vitest';
import { ShortcutHelpModel, type ShortcutHelpItemInput } from './shortcutHelpModel';

const items: readonly ShortcutHelpItemInput[] = [
  { id: 'search', label: 'Aramayı aç', description: 'Adres ve yer ara', keys: ['Control', 'k'], scope: 'global', category: 'Genel' },
  { id: 'map', label: 'Haritaya odaklan', keys: ['m'], scope: 'map', category: 'Harita' },
  { id: 'zoom', label: 'Yakınlaştır', keys: ['+'], scope: 'map', category: 'Harita' },
  { id: 'table', label: 'Tabloya odaklan', keys: ['t'], scope: 'table', category: 'Veri', enabled: false },
];

const rows = (model: ShortcutHelpModel) => model.snapshot.groups.flatMap((group) => group.rows);

describe('ShortcutHelpModel', () => {
  it('opens with one roving focus target and restores focus on close', () => {
    const model = new ShortcutHelpModel({ items });
    model.open('help-button');
    expect(model.snapshot.open).toBe(true);
    expect(model.snapshot.focusedId).toBe('search');
    expect(rows(model).filter((row) => row.tabIndex === 0)).toHaveLength(1);
    expect(model.close()).toBe('help-button');
    expect(model.snapshot.focusedId).toBeUndefined();
  });

  it('groups shortcuts in stable category order', () => {
    const model = new ShortcutHelpModel({ items });
    expect(model.snapshot.groups.map((group) => group.category)).toEqual(['Genel', 'Harita', 'Veri']);
    expect(model.snapshot.groups[1]?.rows.map((row) => row.id)).toEqual(['map', 'zoom']);
  });

  it('formats human-readable key labels', () => {
    const model = new ShortcutHelpModel({ items });
    expect(rows(model).find((row) => row.id === 'search')?.keyLabel).toBe('Ctrl + K');
  });

  it('filters Turkish-aware labels, descriptions and key labels', () => {
    const model = new ShortcutHelpModel({ items });
    model.open();
    model.setQuery('odaklan');
    expect(rows(model).map((row) => row.id)).toEqual(['map', 'table']);
    model.setQuery('adres');
    expect(rows(model).map((row) => row.id)).toEqual(['search']);
    model.setQuery('ctrl');
    expect(rows(model).map((row) => row.id)).toEqual(['search']);
  });

  it('filters by interaction scope and repairs focus', () => {
    const model = new ShortcutHelpModel({ items });
    model.open();
    model.setScope('map');
    expect(rows(model).map((row) => row.id)).toEqual(['map', 'zoom']);
    expect(model.snapshot.focusedId).toBe('map');
    model.setScope('table');
    expect(model.snapshot.focusedId).toBeUndefined();
  });

  it('skips disabled shortcuts during keyboard navigation', () => {
    const model = new ShortcutHelpModel({ items });
    model.open();
    model.focusLast();
    expect(model.snapshot.focusedId).toBe('zoom');
    model.focusNext();
    expect(model.snapshot.focusedId).toBe('search');
    model.focusPrevious();
    expect(model.snapshot.focusedId).toBe('zoom');
  });

  it('supports first and last keyboard navigation', () => {
    const model = new ShortcutHelpModel({ items });
    model.open();
    model.focusLast();
    expect(model.snapshot.focusedId).toBe('zoom');
    model.focusFirst();
    expect(model.snapshot.focusedId).toBe('search');
  });

  it('ignores focus requests for disabled or missing rows', () => {
    const model = new ShortcutHelpModel({ items });
    model.open();
    const revision = model.snapshot.revision;
    model.focus('table'); model.focus('missing');
    expect(model.snapshot.revision).toBe(revision);
  });

  it('distinguishes no shortcuts and no results', () => {
    expect(new ShortcutHelpModel({ items: [] }).snapshot.emptyReason).toBe('no-shortcuts');
    const model = new ShortcutHelpModel({ items });
    model.setQuery('bulunamaz');
    expect(model.snapshot.emptyReason).toBe('no-results');
  });

  it('clears query and returns all shortcuts', () => {
    const model = new ShortcutHelpModel({ items });
    model.setQuery('harita');
    expect(model.snapshot.resultCount).toBeLessThan(4);
    model.clearQuery();
    expect(model.snapshot.resultCount).toBe(4);
  });

  it('toggles the help surface without losing deterministic restoration', () => {
    const model = new ShortcutHelpModel({ items });
    model.toggle('toolbar-help');
    expect(model.snapshot.open).toBe(true);
    model.toggle();
    expect(model.snapshot.open).toBe(false);
  });

  it('provides list position metadata for screen readers', () => {
    const model = new ShortcutHelpModel({ items });
    expect(rows(model).map((row) => row.positionInSet)).toEqual([1, 2, 3, 4]);
    expect(rows(model).every((row) => row.setSize === 4)).toBe(true);
  });

  it('isolates observer failures', () => {
    const onObserverError = vi.fn();
    const healthy = vi.fn();
    const model = new ShortcutHelpModel({ items, onObserverError });
    model.subscribe(() => { throw new Error('observer'); });
    model.subscribe(healthy);
    model.open();
    expect(onObserverError).toHaveBeenCalled();
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  it('isolates reporter failures', () => {
    const model = new ShortcutHelpModel({ items, onObserverError: () => { throw new Error('reporter'); } });
    model.subscribe(() => { throw new Error('observer'); });
    expect(() => model.open()).not.toThrow();
    expect(model.snapshot.open).toBe(true);
  });

  it('keeps snapshot collections immutable', () => {
    const model = new ShortcutHelpModel({ items });
    expect(Object.isFrozen(model.snapshot)).toBe(true);
    expect(Object.isFrozen(model.snapshot.groups)).toBe(true);
    expect(Object.isFrozen(model.snapshot.groups[0]?.rows)).toBe(true);
    expect(Object.isFrozen(rows(model)[0]?.keys)).toBe(true);
  });

  it('rejects malformed, duplicate and excessive shortcut definitions', () => {
    expect(() => new ShortcutHelpModel({ items: [{ ...items[0]!, id: ' ' }] })).toThrow(/required/);
    expect(() => new ShortcutHelpModel({ items: [{ ...items[0]!, keys: [] }] })).toThrow(/required/);
    expect(() => new ShortcutHelpModel({ items: [items[0]!, items[0]!] })).toThrow(/Duplicate/);
    expect(() => new ShortcutHelpModel({ items: [{ ...items[0]!, keys: ['Control', ' '] }] })).toThrow(/non-empty/);
    expect(() => new ShortcutHelpModel({ items: Array.from({ length: 501 }, (_, index) => ({ ...items[0]!, id: `id-${index}` })) })).toThrow(/500/);
  });
});
