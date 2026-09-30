import { describe, expect, it, vi } from 'vitest';
import {
  MAP_SHORTCUT_HELP_CATEGORIES,
  MapShortcutHelpModel,
  auditMapShortcutHelpCatalog,
  normalizeMapShortcutHelpText,
  type MapShortcutHelpCategory,
} from './mapShortcutHelpModel';
import type { MapWorkspaceShortcutDefinition } from './mapWorkspaceShortcuts';

const shortcuts: readonly MapWorkspaceShortcutDefinition[] = Object.freeze([
  Object.freeze({ id: 'focus-map', action: 'focus-map', key: 'm', alt: true, label: 'Alt+M', description: 'Harita çalışma alanına odaklan' }),
  Object.freeze({ id: 'focus-navigation', action: 'focus-navigation', key: 'n', alt: true, label: 'Alt+N', description: 'Ana navigasyona odaklan' }),
  Object.freeze({ id: 'toggle-sidebar', action: 'toggle-sidebar', key: 'l', alt: true, label: 'Alt+L', description: 'Katman ve araç kenar çubuğunu aç veya kapat' }),
  Object.freeze({ id: 'command-center', action: 'open-command-center', key: 'k', ctrl: true, label: 'Ctrl+K', description: 'Komut merkezini aç' }),
  Object.freeze({ id: 'basemap', action: 'open-basemap', key: 'b', alt: true, label: 'Alt+B', description: 'Altlık harita seçicisini aç' }),
  Object.freeze({ id: 'measurement', action: 'open-measurement', key: 'r', alt: true, label: 'Alt+R', description: 'Ölçüm araçlarını aç' }),
  Object.freeze({ id: 'feedback', action: 'open-feedback', key: 'f', alt: true, label: 'Alt+F', description: 'Geri bildirim penceresini aç' }),
]);

const createShortcut = (id: string, overrides: Partial<MapWorkspaceShortcutDefinition> = {}): MapWorkspaceShortcutDefinition => ({
  id,
  action: 'focus-map',
  key: 'x',
  label: 'Alt+X',
  description: 'Örnek açıklama',
  ...overrides,
});

describe('normalizeMapShortcutHelpText', () => {
  it('normalizes Turkish characters and accents for tolerant discovery', () => {
    expect(normalizeMapShortcutHelpText('ÖLÇÜM ŞEÇİCİ ĞÜÇ')).toBe('olcum secici guc');
  });

  it('normalizes dotless and dotted Turkish i deterministically', () => {
    expect(normalizeMapShortcutHelpText('Iğdır İçi')).toBe('igdir ici');
  });

  it('keeps shortcut punctuation needed for key labels', () => {
    expect(normalizeMapShortcutHelpText('Ctrl+K ?')).toBe('ctrl+k ?');
  });

  it('collapses unsupported punctuation and repeated whitespace', () => {
    expect(normalizeMapShortcutHelpText('  Harita —   araçları!!!  ')).toBe('harita araclari');
  });
});

describe('auditMapShortcutHelpCatalog', () => {
  it('accepts the governed catalog fixture', () => {
    expect(auditMapShortcutHelpCatalog(shortcuts)).toEqual([]);
  });

  it('reports duplicate ids', () => {
    const findings = auditMapShortcutHelpCatalog([shortcuts[0], { ...shortcuts[0] }]);
    expect(findings).toContainEqual(expect.objectContaining({ code: 'duplicate-id', shortcutId: 'focus-map' }));
  });

  it('reports empty labels and descriptions independently', () => {
    const findings = auditMapShortcutHelpCatalog([
      createShortcut('bad-label', { label: ' ' }),
      createShortcut('bad-description', { description: '\n' }),
    ]);
    expect(findings.some((finding) => finding.code === 'empty-label' && finding.shortcutId === 'bad-label')).toBe(true);
    expect(findings.some((finding) => finding.code === 'empty-description' && finding.shortcutId === 'bad-description')).toBe(true);
  });

  it('reports unknown action-to-category mappings instead of silently indexing them', () => {
    const invalid = createShortcut('unknown-action', { action: 'not-a-real-action' as MapWorkspaceShortcutDefinition['action'] });
    expect(auditMapShortcutHelpCatalog([invalid])).toContainEqual(expect.objectContaining({ code: 'invalid-category', shortcutId: 'unknown-action' }));
  });

  it('fails bounded catalogs larger than the help budget', () => {
    const oversized = Array.from({ length: 65 }, (_, index) => createShortcut(`shortcut-${index}`));
    expect(auditMapShortcutHelpCatalog(oversized).some((finding) => finding.code === 'catalog-too-large')).toBe(true);
  });
});

describe('MAP_SHORTCUT_HELP_CATEGORIES', () => {
  it('exposes a stable keyboard-friendly category order', () => {
    expect(MAP_SHORTCUT_HELP_CATEGORIES).toEqual([
      { id: 'all', label: 'Tümü' },
      { id: 'navigation', label: 'Odak ve gezinme' },
      { id: 'workspace', label: 'Çalışma alanı' },
      { id: 'tools', label: 'Harita araçları' },
    ]);
    expect(Object.isFrozen(MAP_SHORTCUT_HELP_CATEGORIES)).toBe(true);
  });
});

describe('MapShortcutHelpModel snapshots', () => {
  it('starts with every shortcut visible and the first option active', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    const snapshot = model.getSnapshot();
    expect(snapshot).toMatchObject({ revision: 0, query: '', normalizedQuery: '', category: 'all', activeId: 'focus-map', resultCount: 7, totalCount: 7, emptyReason: 'none', announcement: '7 harita kısayolu gösteriliyor.' });
    expect(snapshot.entries.map((entry) => entry.sourceId)).toEqual(shortcuts.map((shortcut) => shortcut.id));
    expect(snapshot.entries[0]).toMatchObject({ position: 1, setSize: 7, selected: true });
    expect(snapshot.entries[6]).toMatchObject({ position: 7, setSize: 7, selected: false });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(snapshot.entries.every((entry) => Object.isFrozen(entry))).toBe(true);
  });

  it('assigns deterministic accessible option ids', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    expect(model.getSnapshot().entries[0].id).toBe('map-shortcut-help-option-focus-map');
    expect(model.getSnapshot().entries.at(-1)?.id).toBe('map-shortcut-help-option-feedback');
  });

  it.each([
    ['focus-map', 'navigation', 'Odak ve gezinme'],
    ['focus-navigation', 'navigation', 'Odak ve gezinme'],
    ['toggle-sidebar', 'workspace', 'Çalışma alanı'],
    ['command-center', 'workspace', 'Çalışma alanı'],
    ['basemap', 'tools', 'Harita araçları'],
    ['measurement', 'tools', 'Harita araçları'],
    ['feedback', 'tools', 'Harita araçları'],
  ] as const)('maps %s into %s', (id, category, categoryLabel) => {
    const model = new MapShortcutHelpModel(shortcuts);
    expect(model.getSnapshot().entries.find((candidate) => candidate.sourceId === id)).toMatchObject({ category, categoryLabel });
  });
});

describe('MapShortcutHelpModel filtering', () => {
  it('finds descriptions with Turkish/accent-insensitive search', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    model.setQuery('OLCUM');
    expect(model.getSnapshot()).toMatchObject({ query: 'OLCUM', normalizedQuery: 'olcum', resultCount: 1, activeId: 'measurement', announcement: '1 harita kısayolu bulundu.' });
  });

  it('finds key labels including modifier punctuation', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    model.setQuery('ctrl+k');
    expect(model.getSnapshot().entries.map((entry) => entry.sourceId)).toEqual(['command-center']);
  });

  it('searches category labels as discoverable vocabulary without excluding other relevant text matches', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    model.setQuery('calisma alani');
    const ids = model.getSnapshot().entries.map((entry) => entry.sourceId);
    expect(ids).toEqual(expect.arrayContaining(['toggle-sidebar', 'command-center']));
    expect(ids.indexOf('toggle-sidebar')).toBeLessThan(ids.indexOf('command-center'));
  });

  it('filters by category while preserving catalog order', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    model.setCategory('tools');
    expect(model.getSnapshot()).toMatchObject({ category: 'tools', resultCount: 3, activeId: 'basemap', announcement: '3 harita kısayolu bulundu.' });
    expect(model.getSnapshot().entries.map((entry) => entry.sourceId)).toEqual(['basemap', 'measurement', 'feedback']);
  });

  it('composes query and category filters', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    model.setCategory('tools');
    model.setQuery('geri');
    expect(model.getSnapshot().entries.map((entry) => entry.sourceId)).toEqual(['feedback']);
  });

  it('publishes query-empty state when text excludes every shortcut', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    model.setQuery('uydu-yörünge');
    expect(model.getSnapshot()).toMatchObject({ resultCount: 0, activeId: null, emptyReason: 'query', announcement: 'Filtrelerle eşleşen harita kısayolu bulunamadı.' });
  });

  it('publishes category-empty state for a valid category with no members', () => {
    const model = new MapShortcutHelpModel(shortcuts.filter((shortcut) => shortcut.action === 'focus-map' || shortcut.action === 'focus-navigation'));
    model.setCategory('tools');
    expect(model.getSnapshot()).toMatchObject({ resultCount: 0, activeId: null, emptyReason: 'category' });
  });

  it('truncates oversized query input to its configured budget', () => {
    const model = new MapShortcutHelpModel(shortcuts, { maxQueryLength: 5 });
    model.setQuery('harita-kısayolları');
    expect(model.getSnapshot().query).toBe('harit');
  });

  it('clamps a non-finite query budget to the default instead of poisoning state', () => {
    const model = new MapShortcutHelpModel(shortcuts, { maxQueryLength: Number.NaN });
    model.setQuery('x'.repeat(200));
    expect(model.getSnapshot().query).toHaveLength(80);
  });

  it('ignores unknown category values fail-closed', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    model.setCategory('invalid' as MapShortcutHelpCategory);
    expect(model.getSnapshot().category).toBe('all');
    expect(model.getSnapshot().revision).toBe(0);
  });

  it('does not publish when query/category values are unchanged', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    const listener = vi.fn();
    model.subscribe(listener);
    model.setQuery('');
    model.setCategory('all');
    expect(listener).not.toHaveBeenCalled();
    expect(model.getSnapshot().revision).toBe(0);
  });
});

describe('MapShortcutHelpModel active option navigation', () => {
  it('moves next and previous with wrap-around', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    model.moveActive('previous');
    expect(model.getSnapshot().activeId).toBe('feedback');
    model.moveActive('next');
    expect(model.getSnapshot().activeId).toBe('focus-map');
  });

  it('supports first and last movement', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    model.moveActive('last');
    expect(model.getSnapshot().activeId).toBe('feedback');
    model.moveActive('first');
    expect(model.getSnapshot().activeId).toBe('focus-map');
  });

  it('supports bounded page movement', () => {
    const model = new MapShortcutHelpModel(shortcuts, { pageSize: 3 });
    model.moveActive('page-next');
    expect(model.getSnapshot().activeId).toBe('command-center');
    model.moveActive('page-next');
    expect(model.getSnapshot().activeId).toBe('feedback');
    model.moveActive('page-previous');
    expect(model.getSnapshot().activeId).toBe('command-center');
  });

  it('clamps oversized page-size configuration', () => {
    const many = Array.from({ length: 30 }, (_, index) => createShortcut(`shortcut-${index}`));
    const model = new MapShortcutHelpModel(many, { pageSize: 999 });
    model.moveActive('page-next');
    expect(model.getSnapshot().activeId).toBe('shortcut-20');
  });

  it('keeps the active item when it survives a query change', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    model.setActive('feedback');
    model.setQuery('penceresini');
    expect(model.getSnapshot().activeId).toBe('feedback');
  });

  it('selects the first surviving item when filtering removes the active item', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    model.setActive('feedback');
    model.setCategory('navigation');
    expect(model.getSnapshot().activeId).toBe('focus-map');
  });

  it('ignores attempts to activate filtered-out ids', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    model.setCategory('navigation');
    const revision = model.getSnapshot().revision;
    model.setActive('feedback');
    expect(model.getSnapshot().activeId).toBe('focus-map');
    expect(model.getSnapshot().revision).toBe(revision);
  });

  it('does not publish movement for empty result sets', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    model.setQuery('no-result');
    const revision = model.getSnapshot().revision;
    model.moveActive('next');
    expect(model.getSnapshot().revision).toBe(revision);
    expect(model.getSnapshot().activeId).toBeNull();
  });

  it('keeps exactly one selected presentation item', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    for (const movement of ['next', 'last', 'previous', 'first'] as const) {
      model.moveActive(movement);
      expect(model.getSnapshot().entries.filter((entry) => entry.selected)).toHaveLength(1);
      expect(model.getSnapshot().entries.find((entry) => entry.selected)?.sourceId).toBe(model.getSnapshot().activeId);
    }
  });
});

describe('MapShortcutHelpModel lifecycle and observers', () => {
  it('publishes immutable revisions for state transitions', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    const snapshots = [model.getSnapshot()];
    model.subscribe(() => snapshots.push(model.getSnapshot()));
    model.setQuery('harita');
    model.setCategory('tools');
    model.moveActive('next');
    expect(snapshots.map((snapshot) => snapshot.revision)).toEqual([0, 1, 2, 3]);
    expect(new Set(snapshots).size).toBe(4);
  });

  it('resets query/category/active state in one publication', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    model.setCategory('tools');
    model.setQuery('geri');
    const listener = vi.fn();
    model.subscribe(listener);
    model.reset();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(model.getSnapshot()).toMatchObject({ query: '', category: 'all', activeId: 'focus-map', resultCount: 7 });
  });

  it('enforces a bounded listener budget', () => {
    const model = new MapShortcutHelpModel(shortcuts, { maxListeners: 2 });
    model.subscribe(() => undefined);
    model.subscribe(() => undefined);
    expect(() => model.subscribe(() => undefined)).toThrow(/listener limit exceeded/u);
  });

  it('reuses observer capacity after unsubscribe', () => {
    const model = new MapShortcutHelpModel(shortcuts, { maxListeners: 1 });
    const unsubscribe = model.subscribe(() => undefined);
    unsubscribe();
    expect(model.listenerCount()).toBe(0);
    expect(() => model.subscribe(() => undefined)).not.toThrow();
  });

  it('isolates one failing listener and continues notifying healthy listeners', () => {
    const onListenerError = vi.fn();
    const model = new MapShortcutHelpModel(shortcuts, { onListenerError });
    const healthy = vi.fn();
    model.subscribe(() => { throw new Error('observer failed'); });
    model.subscribe(healthy);
    expect(() => model.setQuery('harita')).not.toThrow();
    expect(onListenerError).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('isolates a failing diagnostic reporter', () => {
    const model = new MapShortcutHelpModel(shortcuts, { onListenerError: () => { throw new Error('reporter failed'); } });
    const healthy = vi.fn();
    model.subscribe(() => { throw new Error('observer failed'); });
    model.subscribe(healthy);
    expect(() => model.setCategory('tools')).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('dispose is idempotent and clears retained listeners', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    model.subscribe(() => undefined);
    model.subscribe(() => undefined);
    model.dispose();
    model.dispose();
    expect(model.disposed()).toBe(true);
    expect(model.listenerCount()).toBe(0);
  });

  it('does not publish state after disposal', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    const before = model.getSnapshot();
    model.dispose();
    model.setQuery('harita');
    model.setCategory('tools');
    model.setActive('feedback');
    model.moveActive('next');
    model.reset();
    expect(model.getSnapshot()).toBe(before);
  });

  it('returns a no-op subscription after disposal', () => {
    const model = new MapShortcutHelpModel(shortcuts);
    model.dispose();
    const listener = vi.fn();
    const unsubscribe = model.subscribe(listener);
    expect(() => unsubscribe()).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });
});
