import { describe, expect, it, vi } from 'vitest';
import {
  createSidebarNavigationModel,
  type SidebarNavigationLimits,
  type SidebarNavigationModel,
  type SidebarNavigationView,
} from './sidebarNavigationModel';
import type { ShellSidebarGroup, ShellSidebarItem } from './sidebarCatalogRuntime';

const GROUPS: readonly ShellSidebarGroup[] = Object.freeze([
  Object.freeze({ id: 'ABB', label: 'Ankara Büyükşehir Belediyesi', shortLabel: 'ABB' }),
  Object.freeze({ id: 'EGO', label: 'EGO Genel Müdürlüğü', shortLabel: 'EGO' }),
  Object.freeze({ id: 'ASKI', label: 'ASKİ Genel Müdürlüğü', shortLabel: 'ASKİ' }),
]);

const ITEMS: readonly ShellSidebarItem[] = Object.freeze([
  Object.freeze({ group: 'ABB', label: 'Parklar', windowId: 'park', iconType: 'park', serviceKey: 'ParkService' }),
  Object.freeze({ group: 'ABB', label: 'Kütüphaneler', windowId: 'library', iconType: 'kütüphane', serviceKey: 'LibraryService' }),
  Object.freeze({ group: 'ABB', label: 'Kadın Danışma Merkezi', windowId: 'women', iconType: 'kadın danışma', serviceKey: 'WomenService' }),
  Object.freeze({ group: 'EGO', label: 'Otobüs Durakları', windowId: 'bus', iconType: 'otobüs durağı', serviceKey: 'BusService' }),
  Object.freeze({ group: 'EGO', label: 'Metro Hattı', windowId: 'metro', iconType: 'metro hattı', serviceKey: 'MetroService' }),
  Object.freeze({ group: 'ASKI', label: 'Atık Su Tesisleri', windowId: 'water', iconType: 'atıksu tesisi', serviceKey: 'WaterService' }),
]);

const createModel = (options: {
  readonly favorites?: readonly string[];
  readonly recents?: readonly string[];
  readonly maxRecentIds?: number;
  readonly maxFavoriteIds?: number;
  readonly maxQueryLength?: number;
} = {}): SidebarNavigationModel => {
  const limits: SidebarNavigationLimits = {
    ...(options.maxRecentIds !== undefined ? { maxRecentIds: options.maxRecentIds } : {}),
    ...(options.maxFavoriteIds !== undefined ? { maxFavoriteIds: options.maxFavoriteIds } : {}),
    ...(options.maxQueryLength !== undefined ? { maxQueryLength: options.maxQueryLength } : {}),
  };
  return createSidebarNavigationModel({
    groups: GROUPS,
    items: ITEMS,
    initialFavoriteIds: options.favorites ?? [],
    initialRecentIds: options.recents ?? [],
    limits,
  });
};

const ids = (model: SidebarNavigationModel): readonly string[] =>
  model.getSnapshot().visibleItems.map((item) => item.windowId);

describe('createSidebarNavigationModel', () => {
  it('starts visible, expanded and in the all-services view', () => {
    const model = createModel();
    expect(model.getSnapshot()).toMatchObject({
      visible: true,
      collapsed: false,
      activeGroupId: null,
      view: 'all',
      query: '',
      normalizedQuery: '',
      resultCount: ITEMS.length,
      activeItemId: 'park',
      activeIndex: 0,
      emptyReason: 'none',
      revision: 0,
    });
    expect(ids(model)).toEqual(['park', 'library', 'women', 'bus', 'metro', 'water']);
  });

  it('freezes externally visible snapshots and collections', () => {
    const model = createModel({ favorites: ['park'], recents: ['metro'] });
    const snapshot = model.getSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.visibleItems)).toBe(true);
    expect(Object.isFrozen(snapshot.favoriteIds)).toBe(true);
    expect(Object.isFrozen(snapshot.recentIds)).toBe(true);
    expect(Object.isFrozen(snapshot.counts)).toBe(true);
  });

  it('rejects duplicate groups before runtime state exists', () => {
    expect(() => createSidebarNavigationModel({
      groups: [...GROUPS, { id: 'ABB', label: 'Duplicate' }],
      items: ITEMS,
    })).toThrow(/Duplicate sidebar group id/u);
  });

  it('rejects duplicate item window ids', () => {
    expect(() => createSidebarNavigationModel({
      groups: GROUPS,
      items: [...ITEMS, { group: 'ABB', label: 'Duplicate', windowId: 'park' }],
    })).toThrow(/Duplicate sidebar window id/u);
  });

  it('rejects items that point at an unknown group', () => {
    expect(() => createSidebarNavigationModel({
      groups: GROUPS,
      items: [...ITEMS, { group: 'OTHER', label: 'Unknown', windowId: 'unknown' }],
    })).toThrow(/unknown group/u);
  });

  it('enforces group and item admission budgets', () => {
    expect(() => createSidebarNavigationModel({ groups: GROUPS, items: ITEMS, limits: { maxGroups: 2 } })).toThrow(RangeError);
    expect(() => createSidebarNavigationModel({ groups: GROUPS, items: ITEMS, limits: { maxItems: 5 } })).toThrow(RangeError);
  });

  it('sanitizes initial favorites and recents against the admitted catalog', () => {
    const model = createModel({ favorites: ['park', 'missing', 'park', 'metro'], recents: ['missing', 'bus', 'bus', 'library'] });
    expect(model.getSnapshot().favoriteIds).toEqual(['park', 'metro']);
    expect(model.getSnapshot().recentIds).toEqual(['bus', 'library']);
  });

  it('bounds initial favorites and recents', () => {
    const model = createModel({ favorites: ['park', 'library', 'women', 'bus'], recents: ['metro', 'bus', 'library', 'park'], maxFavoriteIds: 2, maxRecentIds: 2 });
    expect(model.getSnapshot().favoriteIds).toEqual(['park', 'library']);
    expect(model.getSnapshot().recentIds).toEqual(['metro', 'bus']);
  });

  it('filters by group and resets query/view when the group changes', () => {
    const model = createModel({ favorites: ['park'] });
    model.setView('favorites');
    model.setQuery('park');
    model.setGroup('EGO');
    expect(model.getSnapshot()).toMatchObject({ activeGroupId: 'EGO', view: 'all', query: '', collapsed: false });
    expect(ids(model)).toEqual(['bus', 'metro']);
  });

  it('toggles a selected group back to the all-group scope', () => {
    const model = createModel();
    model.toggleGroup('ABB');
    expect(model.getSnapshot().activeGroupId).toBe('ABB');
    model.toggleGroup('ABB');
    expect(model.getSnapshot().activeGroupId).toBeNull();
    expect(model.getSnapshot().resultCount).toBe(ITEMS.length);
  });

  it('rejects unknown groups instead of silently creating an invalid filter', () => {
    const model = createModel();
    expect(() => model.setGroup('UNKNOWN')).toThrow(/Unknown sidebar group/u);
    expect(() => model.toggleGroup('UNKNOWN')).toThrow(/Unknown sidebar group/u);
  });

  it.each([
    ['all', ['park', 'library', 'women', 'bus', 'metro', 'water']],
    ['favorites', ['park', 'metro']],
    ['recent', ['metro', 'library']],
  ] as const)('renders %s view deterministically', (view, expected) => {
    const model = createModel({ favorites: ['park', 'metro'], recents: ['metro', 'library'] });
    model.setView(view as SidebarNavigationView);
    expect(ids(model)).toEqual(expected);
  });

  it('keeps recent ordering when a group filter is active', () => {
    const model = createModel({ recents: ['metro', 'park', 'bus', 'library'] });
    model.setGroup('EGO');
    model.setView('recent');
    expect(ids(model)).toEqual(['metro', 'bus']);
  });

  it('reports view counts inside the current group scope', () => {
    const model = createModel({ favorites: ['park', 'bus'], recents: ['library', 'bus'] });
    model.setGroup('ABB');
    expect(model.getSnapshot().counts).toEqual({ all: 3, favorites: 1, recent: 1 });
  });

  it('searches Turkish labels accent-tolerantly through normalized catalog text', () => {
    const model = createModel();
    model.setQuery('KUTUPHANE');
    expect(ids(model)).toEqual(['library']);
    model.setQuery('atik su');
    expect(ids(model)).toEqual(['water']);
    model.setQuery('kadin danisma');
    expect(ids(model)).toEqual(['women']);
  });

  it('matches service keys and icon metadata without exposing those strings as rendered labels', () => {
    const model = createModel();
    model.setQuery('MetroService');
    expect(ids(model)).toEqual(['metro']);
    model.setQuery('otobus duragi');
    expect(ids(model)).toEqual(['bus']);
  });

  it('requires every normalized search token to match', () => {
    const model = createModel();
    model.setQuery('otobus duragi');
    expect(ids(model)).toEqual(['bus']);
    model.setQuery('otobus park');
    expect(ids(model)).toEqual([]);
  });

  it('removes control characters from queries', () => {
    const model = createModel();
    model.setQuery('par\u0000k\nlar');
    expect(model.getSnapshot().query).toBe('parklar');
    expect(ids(model)).toEqual(['park']);
  });

  it('enforces a UTF-16-safe hard query length budget', () => {
    const model = createModel({ maxQueryLength: 5 });
    model.setQuery('abcd🗺️extra');
    expect(model.getSnapshot().query).toBe('abcd');
    expect(model.getSnapshot().query.length).toBeLessThanOrEqual(5);
  });

  it('clears a query without changing the selected view', () => {
    const model = createModel({ favorites: ['park'] });
    model.setView('favorites');
    model.setQuery('park');
    model.clearQuery();
    expect(model.getSnapshot()).toMatchObject({ view: 'favorites', query: '' });
    expect(ids(model)).toEqual(['park']);
  });

  it('does not publish duplicate query transitions', () => {
    const model = createModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.setQuery('park');
    model.setQuery('park');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('toggles favorites without duplicates', () => {
    const model = createModel({ favorites: ['park'] });
    model.toggleFavorite('park');
    expect(model.getSnapshot().favoriteIds).toEqual([]);
    model.toggleFavorite('park');
    model.toggleFavorite('park');
    expect(model.getSnapshot().favoriteIds).toEqual([]);
  });

  it('rejects favorite mutations for unknown item ids', () => {
    const model = createModel();
    expect(() => model.toggleFavorite('missing')).toThrow(/Unknown sidebar item/u);
  });

  it('reconciles favorites view immediately after removing the active favorite', () => {
    const model = createModel({ favorites: ['park', 'metro'] });
    model.setView('favorites');
    model.setActiveItem('metro');
    model.toggleFavorite('metro');
    expect(ids(model)).toEqual(['park']);
    expect(model.getSnapshot().activeItemId).toBe('park');
  });

  it('records recents with most-recent-first ordering and deduplication', () => {
    const model = createModel({ recents: ['library', 'park'] });
    model.recordRecent('park');
    expect(model.getSnapshot().recentIds).toEqual(['park', 'library']);
    model.recordRecent('bus');
    expect(model.getSnapshot().recentIds).toEqual(['bus', 'park', 'library']);
  });

  it('hard-bounds recent history', () => {
    const model = createModel({ maxRecentIds: 2 });
    model.recordRecent('park');
    model.recordRecent('library');
    model.recordRecent('bus');
    expect(model.getSnapshot().recentIds).toEqual(['bus', 'library']);
  });

  it('rejects recent mutations for unknown ids', () => {
    const model = createModel();
    expect(() => model.recordRecent('missing')).toThrow(/Unknown sidebar item/u);
  });

  it('hydrates preference arrays with dedupe and catalog admission', () => {
    const model = createModel();
    model.setFavoriteIds(['park', 'park', 'missing', 'metro']);
    model.setRecentIds(['missing', 'bus', 'library', 'bus']);
    expect(model.getSnapshot().favoriteIds).toEqual(['park', 'metro']);
    expect(model.getSnapshot().recentIds).toEqual(['bus', 'library']);
  });

  it('assigns the first visible item as the roving active item', () => {
    const model = createModel();
    expect(model.getSnapshot().activeItemId).toBe('park');
    model.setGroup('EGO');
    expect(model.getSnapshot().activeItemId).toBe('bus');
  });

  it('moves the active item forward with wrap-around', () => {
    const model = createModel();
    model.focusLast();
    expect(model.getSnapshot().activeItemId).toBe('water');
    model.moveActive(1);
    expect(model.getSnapshot().activeItemId).toBe('park');
  });

  it('moves the active item backward with wrap-around', () => {
    const model = createModel();
    model.focusFirst();
    model.moveActive(-1);
    expect(model.getSnapshot().activeItemId).toBe('water');
  });

  it('supports bounded page movement', () => {
    const model = createModel();
    model.focusFirst();
    model.moveActiveByPage(1, 3);
    expect(model.getSnapshot().activeItemId).toBe('bus');
    model.moveActiveByPage(-1, 3);
    expect(model.getSnapshot().activeItemId).toBe('park');
  });

  it('ignores non-finite and zero movement requests', () => {
    const model = createModel();
    const revision = model.getSnapshot().revision;
    model.moveActive(0);
    model.moveActive(Number.NaN);
    model.moveActiveByPage(0);
    expect(model.getSnapshot().revision).toBe(revision);
  });

  it('focuses first and last visible items inside filtered views', () => {
    const model = createModel({ favorites: ['library', 'metro'] });
    model.setView('favorites');
    model.focusLast();
    expect(model.getSnapshot().activeItemId).toBe('metro');
    model.focusFirst();
    expect(model.getSnapshot().activeItemId).toBe('library');
  });

  it('rejects setting an active item that is outside the current view', () => {
    const model = createModel({ favorites: ['park'] });
    model.setView('favorites');
    expect(() => model.setActiveItem('bus')).toThrow(/not currently visible/u);
  });

  it('returns the active catalog item for activation', () => {
    const model = createModel();
    model.setActiveItem('metro');
    expect(model.getActiveItem()).toMatchObject({ windowId: 'metro', label: 'Metro Hattı' });
  });

  it('returns null when no item is visible', () => {
    const model = createModel();
    model.setQuery('nothing matches');
    expect(model.getSnapshot().activeItemId).toBeNull();
    expect(model.getSnapshot().activeIndex).toBe(-1);
    expect(model.getActiveItem()).toBeNull();
  });

  it('classifies no-results empty state when search removes all candidates', () => {
    const model = createModel();
    model.setQuery('not found');
    expect(model.getSnapshot()).toMatchObject({ emptyReason: 'no-results', resultCount: 0 });
    expect(model.getSnapshot().announcement).toMatch(/bulunamadı/u);
  });

  it('classifies no-favorites empty state', () => {
    const model = createModel();
    model.setView('favorites');
    expect(model.getSnapshot()).toMatchObject({ emptyReason: 'no-favorites', resultCount: 0 });
    expect(model.getSnapshot().announcement).toMatch(/favori/u);
  });

  it('classifies no-recents empty state', () => {
    const model = createModel();
    model.setView('recent');
    expect(model.getSnapshot()).toMatchObject({ emptyReason: 'no-recents', resultCount: 0 });
    expect(model.getSnapshot().announcement).toMatch(/son kullanılan/u);
  });

  it('publishes explicit group announcements', () => {
    const model = createModel();
    model.setGroup('EGO');
    expect(model.getSnapshot().announcement).toContain('EGO Genel Müdürlüğü');
  });

  it('collapses and expands without destroying filter state', () => {
    const model = createModel({ favorites: ['park'] });
    model.setView('favorites');
    model.setQuery('park');
    model.setCollapsed(true);
    expect(model.getSnapshot()).toMatchObject({ collapsed: true, view: 'favorites', query: 'park', activeItemId: null });
    model.toggleCollapsed();
    expect(model.getSnapshot()).toMatchObject({ collapsed: false, view: 'favorites', query: 'park', activeItemId: 'park' });
  });

  it('show always restores an expanded visible panel', () => {
    const model = createModel();
    model.setCollapsed(true);
    model.close();
    model.show();
    expect(model.getSnapshot()).toMatchObject({ visible: true, collapsed: false, activeItemId: 'park' });
    expect(model.getSnapshot().announcement).toBe('Hizmet paneli açıldı.');
  });

  it('close resets transient discovery state but preserves preferences', () => {
    const model = createModel({ favorites: ['park'], recents: ['metro'] });
    model.setGroup('ABB');
    model.setView('favorites');
    model.setQuery('park');
    model.close();
    expect(model.getSnapshot()).toMatchObject({ visible: false, activeGroupId: null, view: 'all', query: '', activeItemId: null });
    expect(model.getSnapshot().favoriteIds).toEqual(['park']);
    expect(model.getSnapshot().recentIds).toEqual(['metro']);
  });

  it('publishes immutable revisioned snapshots for real transitions', () => {
    const model = createModel();
    const listener = vi.fn();
    const unsubscribe = model.subscribe(listener);
    const first = model.getSnapshot();
    model.setGroup('ABB');
    const second = model.getSnapshot();
    expect(second).not.toBe(first);
    expect(second.revision).toBe(first.revision + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    model.setGroup('EGO');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('isolates failing observers and records sanitized diagnostics', () => {
    const model = createModel();
    const healthy = vi.fn();
    model.subscribe(() => { throw new TypeError('private observer detail'); });
    model.subscribe(healthy);
    expect(() => model.setQuery('park')).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(model.getObserverDiagnostics()).toEqual({ failureCount: 1, lastFailureRevision: 1, lastFailureKind: 'TypeError' });
    expect(JSON.stringify(model.getObserverDiagnostics())).not.toContain('private observer detail');
  });

  it('continues across multiple failing observers', () => {
    const model = createModel();
    const healthy = vi.fn();
    model.subscribe(() => { throw 'first'; });
    model.subscribe(() => { throw new RangeError('second'); });
    model.subscribe(healthy);
    model.setQuery('park');
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(model.getObserverDiagnostics()).toMatchObject({ failureCount: 2, lastFailureKind: 'RangeError' });
  });

  it('freezes diagnostics snapshots', () => {
    const model = createModel();
    expect(Object.isFrozen(model.getObserverDiagnostics())).toBe(true);
    model.subscribe(() => { throw new Error('failure'); });
    model.setQuery('park');
    expect(Object.isFrozen(model.getObserverDiagnostics())).toBe(true);
  });

  it('throws after disposal rather than retaining invisible mutable state', () => {
    const model = createModel();
    model.dispose();
    expect(() => model.setQuery('park')).toThrow(/disposed/u);
    expect(() => model.subscribe(() => undefined)).toThrow(/disposed/u);
  });

  it('makes disposal idempotent', () => {
    const model = createModel();
    expect(() => { model.dispose(); model.dispose(); }).not.toThrow();
  });

  it('drops listeners on disposal', () => {
    const model = createModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.dispose();
    expect(listener).not.toHaveBeenCalled();
  });
});
