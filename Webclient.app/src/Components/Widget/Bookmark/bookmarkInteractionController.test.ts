import { describe, expect, it, vi } from 'vitest';
import type { BookmarkRecord } from '../_shared/MapWidgetRuntime';
import { BookmarkExperienceModel, bookmarkIdentity } from './bookmarkExperienceModel';
import {
  createBookmarkInteractionController,
  type BookmarkMapViewPort,
  type BookmarkStoragePort,
} from './bookmarkInteractionController';

const INITIAL: readonly BookmarkRecord[] = Object.freeze([
  Object.freeze({ Title: 'Kızılay', Lat: 39.9208, Lng: 32.8541, Zoom: 15 }),
  Object.freeze({ Title: 'Çankaya', Lat: 39.8897, Lng: 32.8634, Zoom: 14 }),
  Object.freeze({ Title: 'Ulus', Lat: 39.9417, Lng: 32.8542, Zoom: 16 }),
]);

interface HarnessOptions {
  readonly stored?: unknown;
  readonly view?: BookmarkMapViewPort | null;
  readonly onNotice?: (notice: { readonly severity: string; readonly message: string }) => void;
}

const createHarness = (options: HarnessOptions = {}) => {
  let stored: unknown = options.stored ?? INITIAL;
  const write = vi.fn((next: readonly BookmarkRecord[]) => {
    stored = next;
  });
  const read = vi.fn(() => stored);
  const storage: BookmarkStoragePort = { read, write };
  const view: BookmarkMapViewPort | null = options.view === undefined
    ? {
        center: { latitude: 39.93, longitude: 32.85 },
        zoom: 13,
        goTo: vi.fn().mockResolvedValue(undefined),
      }
    : options.view;
  const getView = vi.fn(() => view);
  const model = new BookmarkExperienceModel();
  const controller = createBookmarkInteractionController({
    model,
    storage,
    map: { getView },
    ...(options.onNotice ? { onNotice: options.onNotice } : {}),
  });
  return {
    model,
    controller,
    storage,
    write,
    read,
    getView,
    view,
    getStored: () => stored,
  };
};

describe('bookmark interaction refresh', () => {
  it('loads canonical storage into the model', () => {
    const { controller, model, read } = createHarness();
    controller.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    expect(model.getSnapshot().entries.map((entry) => entry.bookmark.Title)).toEqual(['Kızılay', 'Çankaya', 'Ulus']);
    expect(controller.getSnapshot().phase).toBe('idle');
  });

  it('surfaces rejected stored records without failing the healthy set', () => {
    const { controller, model } = createHarness({
      stored: [...INITIAL, { Title: '', Lat: 'not-a-number', Lng: 2, Zoom: 3 }],
    });
    controller.refresh();
    expect(model.getSnapshot().totalCount).toBe(3);
    expect(model.getSnapshot().rejectedCount).toBe(1);
    expect(model.getSnapshot().storageWarning).toContain('1 geçersiz veya yinelenen yer işareti');
    expect(controller.getSnapshot().lastNotice).toBeNull();
  });

  it('handles storage read exceptions as bounded errors', () => {
    const model = new BookmarkExperienceModel();
    const controller = createBookmarkInteractionController({
      model,
      storage: {
        read: () => { throw new Error('secret storage detail'); },
        write: vi.fn(),
      },
      map: { getView: () => null },
    });
    controller.refresh();
    expect(model.getSnapshot().totalCount).toBe(0);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'error',
      lastNotice: { severity: 'error' },
    });
  });
});

describe('bookmark save', () => {
  it('saves the current map center and zoom', () => {
    const { controller, model, write } = createHarness();
    controller.refresh();
    expect(controller.saveCurrentView('Yeni görünüm')).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    const written = write.mock.calls[0]?.[0];
    expect(written).toHaveLength(4);
    expect(written?.at(-1)).toEqual({ Title: 'Yeni görünüm', Lat: 39.93, Lng: 32.85, Zoom: 13 });
    expect(model.getSnapshot().totalCount).toBe(4);
    expect(controller.getSnapshot().lastNotice?.message).toContain('Yeni görünüm kaydedildi');
  });

  it('rejects blank titles without writing', () => {
    const { controller, write } = createHarness();
    controller.refresh();
    expect(controller.saveCurrentView('   ')).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(controller.getSnapshot().lastNotice).toMatchObject({ severity: 'warning' });
  });

  it('rejects duplicate titles using the canonical stored set', () => {
    const { controller, write } = createHarness();
    controller.refresh();
    expect(controller.saveCurrentView('Kızılay')).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(controller.getSnapshot().lastNotice?.message).toContain('Aynı adla');
  });

  it('does not lose hidden bookmarks while a search filter is active', () => {
    const { controller, model, write } = createHarness();
    controller.refresh();
    model.setQuery('Kızılay');
    expect(model.getSnapshot().resultCount).toBe(1);
    expect(controller.saveCurrentView('Yeni')).toBe(true);
    expect(write.mock.calls[0]?.[0].map((item) => item.Title)).toEqual(['Kızılay', 'Çankaya', 'Ulus', 'Yeni']);
  });

  it('rejects save when the map view is unavailable', () => {
    const { controller, write } = createHarness({ view: null });
    controller.refresh();
    expect(controller.saveCurrentView('Yeni')).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error' });
  });

  it('rejects save when map coordinates cannot be normalized', () => {
    const { controller, write } = createHarness({ view: { center: null, zoom: 12 } });
    controller.refresh();
    expect(controller.saveCurrentView('Yeni')).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('handles storage write errors without mutating model state', () => {
    const model = new BookmarkExperienceModel();
    const controller = createBookmarkInteractionController({
      model,
      storage: {
        read: () => INITIAL,
        write: () => { throw new Error('quota full'); },
      },
      map: { getView: () => ({ center: { latitude: 39, longitude: 32 }, zoom: 12 }) },
    });
    controller.refresh();
    expect(controller.saveCurrentView('Yeni')).toBe(false);
    expect(model.getSnapshot().totalCount).toBe(3);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error' });
  });
});

describe('bookmark delete', () => {
  it('deletes by stable key and persists remaining records', () => {
    const { controller, model, write } = createHarness();
    controller.refresh();
    const key = bookmarkIdentity(INITIAL[1]);
    expect(controller.remove(key)).toBe(true);
    expect(write.mock.calls[0]?.[0].map((item) => item.Title)).toEqual(['Kızılay', 'Ulus']);
    expect(model.getSnapshot().entries.map((entry) => entry.bookmark.Title)).toEqual(['Kızılay', 'Ulus']);
  });

  it('preserves hidden records when deleting from filtered results', () => {
    const { controller, model, write } = createHarness();
    controller.refresh();
    model.setQuery('Kızılay');
    const visibleKey = model.getSnapshot().entries[0].key;
    expect(controller.remove(visibleKey)).toBe(true);
    expect(write.mock.calls[0]?.[0].map((item) => item.Title)).toEqual(['Çankaya', 'Ulus']);
  });

  it('returns false for an unknown key without writing', () => {
    const { controller, write } = createHarness();
    controller.refresh();
    expect(controller.remove('missing')).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('announces the deleted title', () => {
    const { controller } = createHarness();
    controller.refresh();
    controller.remove(bookmarkIdentity(INITIAL[0]));
    expect(controller.getSnapshot().lastNotice).toEqual({ severity: 'info', message: 'Kızılay silindi.' });
  });
});

describe('bookmark navigation', () => {
  it('navigates to the selected bookmark target', async () => {
    const goTo = vi.fn().mockResolvedValue(undefined);
    const { controller, model } = createHarness({
      view: { center: { latitude: 39, longitude: 32 }, zoom: 12, goTo },
    });
    controller.refresh();
    const key = model.getSnapshot().entries[0].key;
    await expect(controller.navigate(key)).resolves.toBe(true);
    expect(goTo).toHaveBeenCalledWith({ center: [32.8541, 39.9208], zoom: 15 });
    expect(controller.getSnapshot().lastNotice?.message).toContain('Kızılay görünümüne gidildi');
  });

  it('reports unavailable map view without invoking an operation', async () => {
    const { controller, model } = createHarness({ view: {} });
    controller.refresh();
    await expect(controller.navigate(model.getSnapshot().entries[0].key)).resolves.toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'error',
      lastNotice: { severity: 'error', message: 'Harita görünümü henüz hazır değil.' },
    });
  });

  it('reports a rejected goTo operation', async () => {
    const goTo = vi.fn().mockRejectedValue(new Error('navigation failed')); 
    const { controller, model } = createHarness({
      view: { center: { latitude: 39, longitude: 32 }, zoom: 12, goTo },
    });
    controller.refresh();
    await expect(controller.navigate(model.getSnapshot().entries[0].key)).resolves.toBe(false);
    expect(controller.getSnapshot().phase).toBe('error');
    expect(controller.getSnapshot().lastNotice?.message).toContain('navigation failed');
  });

  it('returns false for a missing bookmark key', async () => {
    const { controller } = createHarness();
    controller.refresh();
    await expect(controller.navigate('missing')).resolves.toBe(false);
  });

  it('can navigate a canonical record even while search hides it', async () => {
    const goTo = vi.fn().mockResolvedValue(undefined);
    const { controller, model } = createHarness({
      view: { center: { latitude: 39, longitude: 32 }, zoom: 12, goTo },
    });
    controller.refresh();
    const hiddenKey = bookmarkIdentity(INITIAL[2]);
    model.setQuery('Kızılay');
    await expect(controller.navigate(hiddenKey)).resolves.toBe(true);
    expect(goTo).toHaveBeenCalledWith({ center: [32.8542, 39.9417], zoom: 16 });
  });
});

describe('bookmark notices and observers', () => {
  it('sends notices through the optional adapter', () => {
    const onNotice = vi.fn();
    const { controller } = createHarness({ onNotice });
    controller.refresh();
    controller.saveCurrentView('Yeni');
    expect(onNotice).toHaveBeenCalledWith({ severity: 'info', message: 'Yeni kaydedildi.' });
  });

  it('records notice adapter failures without breaking state', () => {
    const { controller } = createHarness({
      onNotice: () => { throw new TypeError('adapter'); },
    });
    controller.refresh();
    expect(controller.saveCurrentView('Yeni')).toBe(true);
    expect(controller.getDiagnostics()).toMatchObject({
      noticeAdapterFailureCount: 1,
      lastFailureKind: 'TypeError',
    });
  });

  it('notifies healthy controller observers', () => {
    const { controller } = createHarness();
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.refresh();
    expect(listener).toHaveBeenCalled();
  });

  it('isolates throwing observers', () => {
    const { controller } = createHarness();
    const healthy = vi.fn();
    controller.subscribe(() => { throw new RangeError('observer'); });
    controller.subscribe(healthy);
    controller.refresh();
    expect(healthy).toHaveBeenCalled();
    expect(controller.getDiagnostics()).toMatchObject({
      observerFailureCount: 1,
      lastFailureKind: 'RangeError',
    });
  });

  it('tracks active observer count through unsubscribe', () => {
    const { controller } = createHarness();
    const unsubscribe = controller.subscribe(() => undefined);
    expect(controller.getDiagnostics().activeObserverCount).toBe(1);
    unsubscribe();
    expect(controller.getDiagnostics().activeObserverCount).toBe(0);
  });

  it('bounds observers', () => {
    const { controller } = createHarness();
    for (let index = 0; index < 24; index += 1) controller.subscribe(() => undefined);
    controller.subscribe(() => undefined);
    expect(controller.getDiagnostics()).toMatchObject({
      activeObserverCount: 24,
      rejectedObserverCount: 1,
    });
  });

  it('clears the active notice', () => {
    const { controller } = createHarness();
    controller.refresh();
    controller.saveCurrentView('Yeni');
    expect(controller.getSnapshot().lastNotice).not.toBeNull();
    controller.clearNotice();
    expect(controller.getSnapshot().lastNotice).toBeNull();
  });
});

describe('bookmark controller disposal', () => {
  it('disposes observers and diagnostics', () => {
    const { controller } = createHarness();
    controller.subscribe(() => undefined);
    controller.dispose();
    expect(controller.getDiagnostics()).toMatchObject({
      activeObserverCount: 0,
      disposed: true,
    });
  });

  it('rejects subscriptions after disposal', () => {
    const { controller } = createHarness();
    controller.dispose();
    controller.subscribe(() => undefined);
    expect(controller.getDiagnostics().rejectedObserverCount).toBe(1);
  });

  it('makes mutating commands no-ops after disposal', async () => {
    const { controller, write } = createHarness();
    controller.refresh();
    controller.dispose();
    expect(controller.saveCurrentView('Yeni')).toBe(false);
    expect(controller.remove(bookmarkIdentity(INITIAL[0]))).toBe(false);
    await expect(controller.navigate(bookmarkIdentity(INITIAL[0]))).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
