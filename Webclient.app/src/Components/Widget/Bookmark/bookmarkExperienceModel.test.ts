import { describe, expect, it, vi } from 'vitest';
import type { BookmarkRecord } from '../_shared/MapWidgetRuntime';
import {
  BOOKMARK_PRESENTATION_FACTS,
  BookmarkExperienceModel,
  bookmarkDomId,
  bookmarkIdentity,
  normalizeBookmarkSearchText,
} from './bookmarkExperienceModel';

const BOOKMARKS: readonly BookmarkRecord[] = Object.freeze([
  Object.freeze({ Title: 'Kızılay Meydanı', Lat: 39.9208, Lng: 32.8541, Zoom: 15 }),
  Object.freeze({ Title: 'Atatürk Orman Çiftliği', Lat: 39.944, Lng: 32.802, Zoom: 13 }),
  Object.freeze({ Title: 'Çankaya Belediyesi', Lat: 39.8897, Lng: 32.8634, Zoom: 14.5 }),
  Object.freeze({ Title: 'Göksu Parkı', Lat: 39.9734, Lng: 32.649, Zoom: 14 }),
  Object.freeze({ Title: 'Ulus Meydanı', Lat: 39.9417, Lng: 32.8542, Zoom: 16 }),
  Object.freeze({ Title: 'Kuğulu Park', Lat: 39.9027, Lng: 32.8608, Zoom: 17 }),
  Object.freeze({ Title: 'Ankara Kalesi', Lat: 39.9389, Lng: 32.8648, Zoom: 16.5 }),
]);

const createLoaded = (options: ConstructorParameters<typeof BookmarkExperienceModel>[0] = {}) => {
  const model = new BookmarkExperienceModel(options);
  model.setBookmarks(BOOKMARKS);
  return model;
};

describe('normalizeBookmarkSearchText', () => {
  it('normalizes Turkish characters and case', () => {
    expect(normalizeBookmarkSearchText('  ÇANKAYA ŞĞÜÖİ  ')).toBe('cankaya sguoi');
  });

  it('keeps numeric coordinate fragments searchable', () => {
    expect(normalizeBookmarkSearchText('39.9208 / 32.8541')).toBe('39.9208 32.8541');
  });

  it('collapses punctuation and whitespace', () => {
    expect(normalizeBookmarkSearchText('Kızılay,,,   Meydanı')).toBe('kizilay meydani');
  });
});

describe('bookmark identity helpers', () => {
  it('creates deterministic identities for the same record', () => {
    expect(bookmarkIdentity(BOOKMARKS[0])).toBe(bookmarkIdentity({ ...BOOKMARKS[0] }));
  });

  it('changes identity when coordinates change', () => {
    expect(bookmarkIdentity(BOOKMARKS[0])).not.toBe(bookmarkIdentity({ ...BOOKMARKS[0], Lat: 40 }));
  });

  it('creates DOM-safe stable ids', () => {
    const first = bookmarkDomId(BOOKMARKS[0]);
    expect(first).toMatch(/^bookmark-option-[a-z0-9]+$/u);
    expect(first).toBe(bookmarkDomId(BOOKMARKS[0]));
  });
});

describe('BookmarkExperienceModel snapshots', () => {
  it('starts with a stable empty immutable snapshot', () => {
    const model = new BookmarkExperienceModel();
    const snapshot = model.getSnapshot();
    expect(snapshot.revision).toBe(0);
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.emptyReason).toBe('no-bookmarks');
    expect(snapshot.announcement).toBe('Henüz kayıtlı yer işareti yok.');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
  });

  it('indexes loaded bookmarks and activates the first result', () => {
    const model = createLoaded();
    const snapshot = model.getSnapshot();
    expect(snapshot.totalCount).toBe(BOOKMARKS.length);
    expect(snapshot.resultCount).toBe(BOOKMARKS.length);
    expect(snapshot.activeId).toBe(snapshot.entries[0].id);
    expect(snapshot.entries[0].active).toBe(true);
    expect(snapshot.entries[0].position).toBe(1);
    expect(snapshot.entries.at(-1)?.setSize).toBe(BOOKMARKS.length);
  });

  it('keeps source bookmark records available without cloning their values', () => {
    const model = createLoaded();
    expect(model.getSnapshot().entries[0].bookmark).toBe(BOOKMARKS[0]);
  });

  it('reports rejected storage records in snapshot and announcement', () => {
    const model = new BookmarkExperienceModel();
    model.setBookmarks(BOOKMARKS.slice(0, 2), 3);
    const snapshot = model.getSnapshot();
    expect(snapshot.rejectedCount).toBe(3);
    expect(snapshot.storageWarning).toContain('3 geçersiz');
    expect(snapshot.announcement).toBe('3 yer işareti kayıtlı.');
  });

  it('clamps negative rejected counts to zero', () => {
    const model = new BookmarkExperienceModel();
    model.setBookmarks(BOOKMARKS, -99);
    expect(model.getSnapshot().rejectedCount).toBe(0);
  });

  it('increments revision on bookmark replacement', () => {
    const model = new BookmarkExperienceModel();
    model.setBookmarks(BOOKMARKS.slice(0, 1));
    const firstRevision = model.getSnapshot().revision;
    model.setBookmarks(BOOKMARKS.slice(0, 2));
    expect(model.getSnapshot().revision).toBe(firstRevision + 1);
  });
});

describe('BookmarkExperienceModel search', () => {
  it('filters by Turkish-insensitive title text', () => {
    const model = createLoaded();
    model.setQuery('CANKAYA');
    expect(model.getSnapshot().entries.map((entry) => entry.bookmark.Title)).toEqual(['Çankaya Belediyesi']);
  });

  it('filters by another Turkish-insensitive title', () => {
    const model = createLoaded();
    model.setQuery('GOKSU');
    expect(model.getSnapshot().entries[0]?.bookmark.Title).toBe('Göksu Parkı');
  });

  it('filters by coordinate text', () => {
    const model = createLoaded();
    model.setQuery('39.9208');
    expect(model.getSnapshot().entries).toHaveLength(1);
    expect(model.getSnapshot().entries[0].bookmark.Title).toBe('Kızılay Meydanı');
  });

  it('filters by zoom value', () => {
    const model = createLoaded();
    model.setQuery('17.0');
    expect(model.getSnapshot().entries.map((entry) => entry.bookmark.Title)).toEqual(['Kuğulu Park']);
  });

  it('uses a specific no-results state', () => {
    const model = createLoaded();
    model.setQuery('olmayan konum');
    const snapshot = model.getSnapshot();
    expect(snapshot.resultCount).toBe(0);
    expect(snapshot.emptyReason).toBe('no-results');
    expect(snapshot.activeId).toBeNull();
    expect(snapshot.announcement).toBe('Aramayla eşleşen yer işareti bulunamadı.');
  });

  it('restores the first active row after clearing a no-results query', () => {
    const model = createLoaded();
    model.setQuery('yok');
    model.setQuery('');
    expect(model.getSnapshot().activeId).toBe(model.getSnapshot().entries[0].id);
  });

  it('bounds query length to the configured maximum', () => {
    const model = createLoaded({ maxQueryLength: 8 });
    model.setQuery('123456789012345');
    expect(model.getSnapshot().query).toBe('12345678');
  });

  it('does not publish when the bounded query is unchanged', () => {
    const model = createLoaded({ maxQueryLength: 3 });
    model.setQuery('abc');
    const revision = model.getSnapshot().revision;
    model.setQuery('abcdef');
    expect(model.getSnapshot().revision).toBe(revision);
  });
});

describe('BookmarkExperienceModel view mode', () => {
  it('defaults to grid', () => {
    expect(createLoaded().getSnapshot().viewMode).toBe('grid');
  });

  it('switches to list without changing result order', () => {
    const model = createLoaded();
    const before = model.getSnapshot().entries.map((entry) => entry.key);
    model.setViewMode('list');
    expect(model.getSnapshot().viewMode).toBe('list');
    expect(model.getSnapshot().entries.map((entry) => entry.key)).toEqual(before);
  });

  it('does not publish duplicate view-mode changes', () => {
    const model = createLoaded();
    const revision = model.getSnapshot().revision;
    model.setViewMode('grid');
    expect(model.getSnapshot().revision).toBe(revision);
  });
});

describe('BookmarkExperienceModel roving active row', () => {
  it('moves to the next row', () => {
    const model = createLoaded();
    model.moveActive('next');
    expect(model.getSnapshot().activeId).toBe(model.getSnapshot().entries[1].id);
  });

  it('wraps next movement from the last row', () => {
    const model = createLoaded();
    model.moveActive('last');
    model.moveActive('next');
    expect(model.getSnapshot().activeId).toBe(model.getSnapshot().entries[0].id);
  });

  it('wraps previous movement from the first row', () => {
    const model = createLoaded();
    model.moveActive('previous');
    expect(model.getSnapshot().activeId).toBe(model.getSnapshot().entries.at(-1)?.id);
  });

  it('moves directly to first and last', () => {
    const model = createLoaded();
    model.moveActive('last');
    expect(model.getSnapshot().activeId).toBe(model.getSnapshot().entries.at(-1)?.id);
    model.moveActive('first');
    expect(model.getSnapshot().activeId).toBe(model.getSnapshot().entries[0].id);
  });

  it('uses configured page size for page movement', () => {
    const model = createLoaded({ pageSize: 3 });
    model.moveActive('page-next');
    expect(model.getSnapshot().activeId).toBe(model.getSnapshot().entries[3].id);
    model.moveActive('page-previous');
    expect(model.getSnapshot().activeId).toBe(model.getSnapshot().entries[0].id);
  });

  it('clamps page-next at the final row', () => {
    const model = createLoaded({ pageSize: 20 });
    model.moveActive('page-next');
    expect(model.getSnapshot().activeId).toBe(model.getSnapshot().entries.at(-1)?.id);
  });

  it('ignores unknown active ids', () => {
    const model = createLoaded();
    const active = model.getSnapshot().activeId;
    model.setActive('not-present');
    expect(model.getSnapshot().activeId).toBe(active);
  });

  it('maintains active row when it remains in filtered results', () => {
    const model = createLoaded();
    const target = model.getSnapshot().entries.find((entry) => entry.bookmark.Title === 'Kuğulu Park');
    expect(target).toBeDefined();
    model.setActive(target!.id);
    model.setQuery('park');
    expect(model.getSnapshot().activeId).toBe(target!.id);
  });

  it('moves active row to the first result when filtering removes it', () => {
    const model = createLoaded();
    model.moveActive('last');
    model.setQuery('kizilay');
    expect(model.getSnapshot().activeId).toBe(model.getSnapshot().entries[0].id);
  });

  it('does nothing on an empty result set', () => {
    const model = createLoaded();
    model.setQuery('none');
    const revision = model.getSnapshot().revision;
    model.moveActive('next');
    expect(model.getSnapshot().revision).toBe(revision);
  });
});

describe('BookmarkExperienceModel reset', () => {
  it('clears search while preserving view mode', () => {
    const model = createLoaded();
    model.setViewMode('list');
    model.setQuery('park');
    model.resetInteraction();
    expect(model.getSnapshot().query).toBe('');
    expect(model.getSnapshot().viewMode).toBe('list');
    expect(model.getSnapshot().resultCount).toBe(BOOKMARKS.length);
  });
});

describe('BookmarkExperienceModel observers', () => {
  it('notifies healthy observers on state changes', () => {
    const model = createLoaded();
    const observer = vi.fn();
    model.subscribe(observer);
    model.setQuery('park');
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes deterministically', () => {
    const model = createLoaded();
    const observer = vi.fn();
    const unsubscribe = model.subscribe(observer);
    unsubscribe();
    model.setQuery('park');
    expect(observer).not.toHaveBeenCalled();
    expect(model.getObserverDiagnostics().activeObserverCount).toBe(0);
  });

  it('isolates a throwing observer and continues healthy observers', () => {
    const model = createLoaded();
    const healthy = vi.fn();
    model.subscribe(() => { throw new TypeError('boom'); });
    model.subscribe(healthy);
    model.setQuery('park');
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(model.getObserverDiagnostics()).toMatchObject({
      failureCount: 1,
      lastFailureKind: 'TypeError',
      lastFailureRevision: model.getSnapshot().revision,
    });
  });

  it('bounds observer count and records rejected subscriptions', () => {
    const model = createLoaded({ maxObservers: 2 });
    model.subscribe(() => undefined);
    model.subscribe(() => undefined);
    const third = vi.fn();
    model.subscribe(third);
    model.setQuery('park');
    expect(third).not.toHaveBeenCalled();
    expect(model.getObserverDiagnostics()).toMatchObject({
      activeObserverCount: 2,
      rejectedObserverCount: 1,
    });
  });

  it('does not duplicate the same observer', () => {
    const model = createLoaded({ maxObservers: 1 });
    const observer = vi.fn();
    model.subscribe(observer);
    model.subscribe(observer);
    expect(model.getObserverDiagnostics()).toMatchObject({
      activeObserverCount: 1,
      rejectedObserverCount: 0,
    });
  });

  it('disposes listeners and marks diagnostics', () => {
    const model = createLoaded();
    const observer = vi.fn();
    model.subscribe(observer);
    model.dispose();
    expect(model.disposed()).toBe(true);
    expect(model.getObserverDiagnostics()).toMatchObject({
      activeObserverCount: 0,
      disposed: true,
    });
    model.setQuery('park');
    expect(observer).not.toHaveBeenCalled();
  });

  it('rejects observers after disposal without throwing', () => {
    const model = createLoaded();
    model.dispose();
    const observer = vi.fn();
    const unsubscribe = model.subscribe(observer);
    unsubscribe();
    expect(model.getObserverDiagnostics().rejectedObserverCount).toBe(1);
  });
});

describe('bookmark presentation contract', () => {
  it('exposes 44px base and 48px coarse pointer targets', () => {
    expect(BOOKMARK_PRESENTATION_FACTS.minimumPointerTargetPx).toBe(44);
    expect(BOOKMARK_PRESENTATION_FACTS.coarsePointerTargetPx).toBe(48);
  });

  it('declares reduced-motion, forced-colors and roving keyboard support', () => {
    expect(BOOKMARK_PRESENTATION_FACTS).toMatchObject({
      supportsReducedMotion: true,
      supportsForcedColors: true,
      keyboardModel: 'roving-active-descendant',
    });
  });
});
