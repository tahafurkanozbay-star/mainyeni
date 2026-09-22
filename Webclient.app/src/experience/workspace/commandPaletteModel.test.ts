import { createCommandPaletteModel, type CommandPaletteItem } from './commandPaletteModel';

const ITEMS: readonly CommandPaletteItem[] = Object.freeze([
  { id: 'search-address', label: 'Adres ara', description: 'Adres ve kapı numarası bul', keywords: ['arama', 'adres'], group: 'navigation', shortcut: 'Ctrl+K', priority: 10 },
  { id: 'focus-map', label: 'Haritaya odaklan', description: 'Harita çalışma alanına geç', keywords: ['harita', 'map'], group: 'map' },
  { id: 'zoom-in', label: 'Yakınlaştır', description: 'Harita ölçeğini büyüt', keywords: ['zoom', 'artı'], group: 'map' },
  { id: 'zoom-out', label: 'Uzaklaştır', description: 'Harita ölçeğini küçült', keywords: ['zoom', 'eksi'], group: 'map' },
  { id: 'layers', label: 'Katmanları aç', description: 'Katman panelini göster', keywords: ['layer', 'panel'], group: 'tools' },
  { id: 'measure', label: 'Ölçüm aracını aç', description: 'Mesafe ve alan ölç', keywords: ['mesafe', 'alan'], group: 'tools' },
  { id: 'toggle-3d', label: '3B görünüme geç', description: 'Sahne görünümünü etkinleştir', keywords: ['3d', 'sahne'], group: 'view' },
  { id: 'help', label: 'Klavye yardımını aç', description: 'Kısayolları göster', keywords: ['yardım', 'kısayol'], group: 'help' },
]);

describe('commandPaletteModel', () => {
  test('starts closed with bounded deterministic default results', () => {
    const model = createCommandPaletteModel({ items: ITEMS, maxResults: 4 });
    const state = model.getState();
    expect(state.open).toBe(false);
    expect(state.resultCount).toBe(4);
    expect(state.matches).toHaveLength(4);
    expect(state.matches[0]?.item.id).toBe('search-address');
    expect(state.activeId).toBe('search-address');
  });

  test('opens and closes while clearing stale query on close', () => {
    const model = createCommandPaletteModel({ items: ITEMS });
    expect(model.open().open).toBe(true);
    model.setQuery('katman');
    const closed = model.close();
    expect(closed.open).toBe(false);
    expect(closed.query).toBe('');
    expect(closed.resultCount).toBeGreaterThan(1);
  });

  test('ranks exact and prefix label matches above secondary fields', () => {
    const model = createCommandPaletteModel({ items: ITEMS });
    expect(model.setQuery('adres').matches[0]?.item.id).toBe('search-address');
    expect(model.setQuery('yakın').matches[0]?.item.id).toBe('zoom-in');
    expect(model.setQuery('katman').matches[0]?.item.id).toBe('layers');
  });

  test('finds commands through description and keyword aliases', () => {
    const model = createCommandPaletteModel({ items: ITEMS });
    expect(model.setQuery('mesafe').matches[0]?.item.id).toBe('measure');
    expect(model.setQuery('layer').matches[0]?.item.id).toBe('layers');
    expect(model.setQuery('sahne').matches[0]?.item.id).toBe('toggle-3d');
  });

  test('requires every query token to have a searchable match', () => {
    const model = createCommandPaletteModel({ items: ITEMS });
    expect(model.setQuery('harita odak').matches.map((match) => match.item.id)).toContain('focus-map');
    expect(model.setQuery('harita olmayan-token').resultCount).toBe(0);
  });

  test('supports tolerant subsequence matching without returning unrelated commands', () => {
    const model = createCommandPaletteModel({ items: ITEMS });
    expect(model.setQuery('hrta').matches.map((match) => match.item.id)).toContain('focus-map');
    expect(model.setQuery('zzzzzz').resultCount).toBe(0);
  });

  test('moves active result with wrap-around keyboard semantics', () => {
    const model = createCommandPaletteModel({ items: ITEMS, maxResults: 3 });
    model.open();
    const first = model.getState().activeId;
    const second = model.move(1).activeId;
    expect(second).not.toBe(first);
    model.home();
    expect(model.getState().activeId).toBe(first);
    const last = model.move(-1).activeId;
    expect(last).toBe(model.getState().matches.at(-1)?.item.id);
  });

  test('supports Home and End navigation', () => {
    const model = createCommandPaletteModel({ items: ITEMS, maxResults: 5 });
    model.move(1);
    model.move(1);
    expect(model.home().activeIndex).toBe(0);
    const ended = model.end();
    expect(ended.activeIndex).toBe(ended.matches.length - 1);
    expect(model.getActive()?.id).toBe(ended.activeId);
  });

  test('resets active selection to the first relevant result after query changes', () => {
    const model = createCommandPaletteModel({ items: ITEMS });
    model.end();
    const state = model.setQuery('zoom');
    expect(state.activeIndex).toBe(0);
    expect(state.activeId).toBe(state.matches[0]?.item.id);
  });

  test('preserves active identity when replacing items if it remains visible', () => {
    const model = createCommandPaletteModel({ items: ITEMS });
    model.move(1);
    const active = model.getState().activeId;
    const state = model.replaceItems([...ITEMS].reverse());
    expect(state.activeId).toBe(active);
  });

  test('falls back safely when the active item disappears', () => {
    const model = createCommandPaletteModel({ items: ITEMS });
    model.end();
    const removed = model.getState().activeId;
    const state = model.replaceItems(ITEMS.filter((item) => item.id !== removed));
    expect(state.activeIndex).toBe(0);
    expect(state.activeId).not.toBe(removed);
  });

  test('returns no active item for an empty result set', () => {
    const model = createCommandPaletteModel({ items: ITEMS });
    const state = model.setQuery('sonuc-yok-999');
    expect(state.activeIndex).toBe(-1);
    expect(state.activeId).toBeNull();
    expect(model.getActive()).toBeNull();
  });

  test('normalizes case, spacing and Turkish dotted-I searches', () => {
    const model = createCommandPaletteModel({ items: [{ id: 'istanbul', label: 'İstanbul görünümü', group: 'view' }] });
    expect(model.setQuery('  İSTANBUL  ').matches[0]?.item.id).toBe('istanbul');
  });

  test('reports label match ranges for accessible visual emphasis', () => {
    const model = createCommandPaletteModel({ items: ITEMS });
    const match = model.setQuery('katman').matches[0];
    expect(match?.item.id).toBe('layers');
    expect(match?.labelRanges).toEqual([{ start: 0, end: 6 }]);
  });

  test('reports keyword matches separately from labels', () => {
    const model = createCommandPaletteModel({ items: ITEMS });
    const match = model.setQuery('layer').matches[0];
    expect(match?.item.id).toBe('layers');
    expect(match?.keywordMatches).toContain('layer');
  });

  test('enforces max result bounds', () => {
    const model = createCommandPaletteModel({ items: ITEMS, maxResults: 2 });
    expect(model.getState().matches).toHaveLength(2);
    expect(model.setQuery('').matches).toHaveLength(2);
  });

  test('clamps zero maxResults to one result', () => {
    const model = createCommandPaletteModel({ items: ITEMS, maxResults: 0 });
    expect(model.getState().matches).toHaveLength(1);
  });

  test('rejects duplicate ids to keep aria-activedescendant identity deterministic', () => {
    expect(() => createCommandPaletteModel({ items: [ITEMS[0]!, ITEMS[0]!] })).toThrow(/Duplicate command palette item id/);
  });

  test('rejects missing ids and labels', () => {
    expect(() => createCommandPaletteModel({ items: [{ id: '', label: 'A', group: 'help' }] })).toThrow(/id is required/);
    expect(() => createCommandPaletteModel({ items: [{ id: 'a', label: '', group: 'help' }] })).toThrow(/label is required/);
  });

  test('freezes public state and match collections', () => {
    const model = createCommandPaletteModel({ items: ITEMS });
    const state = model.getState();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.matches)).toBe(true);
    expect(Object.isFrozen(state.matches[0])).toBe(true);
    expect(Object.isFrozen(state.matches[0]?.item)).toBe(true);
  });

  test('does not mutate caller-owned item arrays', () => {
    const mutable = [...ITEMS];
    const before = mutable.map((item) => item.id);
    const model = createCommandPaletteModel({ items: mutable });
    model.setQuery('map');
    expect(mutable.map((item) => item.id)).toEqual(before);
  });

  test('keeps disabled commands discoverable so UI can explain why unavailable', () => {
    const model = createCommandPaletteModel({ items: [{ id: 'offline-tool', label: 'Çevrimdışı araç', group: 'tools', disabled: true, disabledReason: 'Ağ bağlantısı gerekli' }] });
    const match = model.setQuery('çevrimdışı').matches[0];
    expect(match?.item.disabled).toBe(true);
    expect(match?.item.disabledReason).toBe('Ağ bağlantısı gerekli');
  });
});
