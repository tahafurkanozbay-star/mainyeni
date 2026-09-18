import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  MAX_BOOKMARK_COUNT,
  appendBookmark,
  clampContextMenuPosition,
  createBookmarkRecord,
  createLatestOperationGate,
  createResourceBag,
  decodeBookmarks,
  isAbortLikeError,
  nextRovingIndex,
  normalizeMapPoint,
  normalizeTimeout,
  normalizeWidgetError,
  objectIdFromIdentifyResult,
  openExternalUrl,
  removeBookmarkAt,
  safeRecordEntries,
  sanitizeExternalUrl,
  sanitizeWidgetLabel,
  type BookmarkRecord,
} from './MapWidgetRuntime';

describe('MapWidgetRuntime', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('normalization and public error copy', () => {
    it('keeps finite timeout values inside the supported safety window', () => {
      expect(normalizeTimeout(250)).toBe(250);
      expect(normalizeTimeout(1)).toBe(100);
      expect(normalizeTimeout(120_000)).toBe(60_000);
      expect(normalizeTimeout(Number.NaN, 900)).toBe(900);
      expect(normalizeTimeout('1500')).toBe(1500);
    });

    it('normalizes control characters and whitespace in error messages', () => {
      expect(normalizeWidgetError(new Error('  Ağ\n\t bağlantısı   koptu  ')))
        .toBe('Ağ bağlantısı koptu');
      expect(normalizeWidgetError({})).toBe('İşlem tamamlanamadı. Lütfen tekrar deneyin.');
    });

    it('bounds error copy so runtime internals cannot flood the interface', () => {
      const result = normalizeWidgetError(new Error('x'.repeat(2_000)));
      expect(result.length).toBeLessThanOrEqual(240);
    });

    it('recognizes the supported cancellation families', () => {
      expect(isAbortLikeError(new DOMException('cancel', 'AbortError'))).toBe(true);
      expect(isAbortLikeError(Object.assign(new Error('cancelled by user'), { code: 'CANCELLED' }))).toBe(true);
      expect(isAbortLikeError(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }))).toBe(true);
      expect(isAbortLikeError(new Error('ordinary failure'))).toBe(false);
      expect(isAbortLikeError('cancelled')).toBe(false);
    });

    it('sanitizes labels without accepting blank control-only values', () => {
      expect(sanitizeWidgetLabel('  Kızılay\n  Meydanı ')).toBe('Kızılay Meydanı');
      expect(sanitizeWidgetLabel('\u0000\u0001', 'Varsayılan')).toBe('Varsayılan');
      expect(sanitizeWidgetLabel(null, 'Varsayılan')).toBe('Varsayılan');
    });
  });

  describe('external navigation boundary', () => {
    it('accepts only HTTP(S) URLs and strips no security controls', () => {
      expect(sanitizeExternalUrl('https://example.test/maps?q=1')).toBe('https://example.test/maps?q=1');
      expect(sanitizeExternalUrl('javascript:alert(1)')).toBeNull();
      expect(sanitizeExternalUrl('data:text/html,hello')).toBeNull();
      expect(sanitizeExternalUrl('ftp://example.test/file')).toBeNull();
    });

    it('rejects credential-bearing and unbounded URLs', () => {
      expect(sanitizeExternalUrl('https://user:secret@example.test/path')).toBeNull();
      expect(sanitizeExternalUrl(`https://example.test/${'a'.repeat(3_000)}`)).toBeNull();
    });

    it('opens safe URLs with noopener and clears opener when a window is returned', () => {
      const child = { opener: window } as unknown as Window;
      const open = vi.fn(() => child);
      const result = openExternalUrl('https://example.test/route', { open } as Pick<Window, 'open'>);

      expect(result).toBe(true);
      expect(open).toHaveBeenCalledWith('https://example.test/route', '_blank', 'noopener,noreferrer');
      expect(child.opener).toBeNull();
    });

    it('does not invoke the browser for rejected URLs', () => {
      const open = vi.fn();
      expect(openExternalUrl('javascript:alert(1)', { open } as Pick<Window, 'open'>)).toBe(false);
      expect(open).not.toHaveBeenCalled();
    });

    it('reports blocked popups without throwing', () => {
      const open = vi.fn(() => null);
      expect(openExternalUrl('https://example.test/', { open } as Pick<Window, 'open'>)).toBe(false);
    });
  });

  describe('map point and context-menu geometry', () => {
    it('normalizes latitude/longitude and x/y shaped map points', () => {
      expect(normalizeMapPoint({ latitude: 39.93, longitude: 32.85 })).toEqual({
        latitude: 39.93,
        longitude: 32.85,
      });
      expect(normalizeMapPoint({ y: '39.93', x: '32.85' })).toEqual({
        latitude: 39.93,
        longitude: 32.85,
      });
    });

    it('rejects non-finite and out-of-world coordinates', () => {
      expect(normalizeMapPoint({ latitude: 91, longitude: 32 })).toBeNull();
      expect(normalizeMapPoint({ latitude: 39, longitude: 181 })).toBeNull();
      expect(normalizeMapPoint({ latitude: Number.NaN, longitude: 32 })).toBeNull();
      expect(normalizeMapPoint(null)).toBeNull();
    });

    it('keeps a context menu inside the viewport', () => {
      expect(clampContextMenuPosition(
        { x: 980, y: 780 },
        { width: 1024, height: 800 },
        { width: 240, height: 180 },
      )).toEqual({ x: 776, y: 612 });
    });

    it('honors safe-area insets and margins', () => {
      expect(clampContextMenuPosition(
        { x: -50, y: -50 },
        {
          width: 390,
          height: 844,
          safeInsetTop: 30,
          safeInsetLeft: 12,
          safeInsetRight: 8,
          safeInsetBottom: 20,
        },
        { width: 220, height: 260 },
        10,
      )).toEqual({ x: 22, y: 40 });
    });

    it('remains deterministic when the menu is larger than the viewport', () => {
      const result = clampContextMenuPosition(
        { x: 100, y: 100 },
        { width: 100, height: 80 },
        { width: 500, height: 500 },
        8,
      );
      expect(result).toEqual({ x: 8, y: 8 });
    });
  });

  describe('record presentation privacy boundary', () => {
    it('filters credential-shaped top-level fields', () => {
      expect(safeRecordEntries({
        NAME: 'Park',
        token: 'hidden',
        Authorization: 'hidden',
        session_id: 'hidden',
        population: 42,
      })).toEqual([
        { key: 'NAME', value: 'Park' },
        { key: 'population', value: '42' },
      ]);
    });

    it('bounds field count and individual value length', () => {
      const source = Object.fromEntries(
        Array.from({ length: 120 }, (_, index) => [`field-${index}`, 'x'.repeat(900)]),
      );
      const result = safeRecordEntries(source, 7);
      expect(result).toHaveLength(7);
      expect(result.every((entry) => entry.value.length <= 500)).toBe(true);
    });

    it('serializes structured values and survives circular structures', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(safeRecordEntries({
        object: { a: 1 },
        circular,
        date: new Date('2026-09-18T00:00:00.000Z'),
      })).toEqual([
        { key: 'object', value: '{"a":1}' },
        { key: 'circular', value: '[gösterilemiyor]' },
        { key: 'date', value: '2026-09-18T00:00:00.000Z' },
      ]);
    });
  });

  describe('resource lifecycle bag', () => {
    it('disposes resources in reverse acquisition order', () => {
      const order: string[] = [];
      const bag = createResourceBag();
      bag.add(() => order.push('first'));
      bag.add({ remove: () => order.push('second') });
      bag.add({ destroy: () => order.push('third') });

      expect(bag.size()).toBe(3);
      bag.dispose();

      expect(order).toEqual(['third', 'second', 'first']);
      expect(bag.size()).toBe(0);
      expect(bag.disposed()).toBe(true);
    });

    it('isolates disposal failures and continues releasing later resources', () => {
      const order: string[] = [];
      const errors: unknown[] = [];
      const bag = createResourceBag((error) => errors.push(error));

      bag.add(() => order.push('first'));
      bag.add(() => {
        order.push('second');
        throw new Error('dispose failed');
      });
      bag.add(() => order.push('third'));

      bag.dispose();

      expect(order).toEqual(['third', 'second', 'first']);
      expect(errors).toHaveLength(1);
    });

    it('disposes resources immediately when added after closure', () => {
      const dispose = vi.fn();
      const bag = createResourceBag();
      bag.dispose();
      bag.add({ dispose });
      expect(dispose).toHaveBeenCalledOnce();
      expect(bag.size()).toBe(0);
    });

    it('can remove ownership before final disposal', () => {
      const dispose = vi.fn();
      const resource = { dispose };
      const bag = createResourceBag();
      bag.add(resource);
      bag.delete(resource);
      bag.dispose();
      expect(dispose).not.toHaveBeenCalled();
    });
  });

  describe('latest-operation gate', () => {
    it('publishes running and success snapshots for the latest operation', async () => {
      const phases: string[] = [];
      const gate = createLatestOperationGate((snapshot) => phases.push(snapshot.phase));

      await expect(gate.run(async ({ isCurrent }) => {
        expect(isCurrent()).toBe(true);
        return 42;
      })).resolves.toBe(42);

      expect(phases).toEqual(['running', 'success']);
      expect(gate.snapshot().phase).toBe('success');
      expect(gate.snapshot().completedAt).not.toBeNull();
    });

    it('cancels the previous generation when new work supersedes it', async () => {
      vi.useFakeTimers();
      const gate = createLatestOperationGate();
      const first = gate.run(async ({ signal }) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'stale';
      });

      const second = gate.run(async () => 'fresh');

      await expect(second).resolves.toBe('fresh');
      await expect(first).rejects.toMatchObject({ name: 'AbortError' });
      expect(gate.snapshot().phase).toBe('success');
    });

    it('enforces a hard timeout even if the operation ignores AbortSignal', async () => {
      vi.useFakeTimers();
      const gate = createLatestOperationGate();
      const operation = gate.run(
        async () => new Promise<string>((resolve) => {
          window.setTimeout(() => resolve('too-late'), 5_000);
        }),
        { timeoutMs: 250 },
      );

      await vi.advanceTimersByTimeAsync(251);
      await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
      expect(gate.snapshot().phase).toBe('cancelled');
    });

    it('records normalized failures without converting them into cancellation', async () => {
      const gate = createLatestOperationGate();
      await expect(gate.run(async () => {
        throw new Error('  service\nfailed ');
      })).rejects.toThrow('service\nfailed');

      expect(gate.snapshot()).toMatchObject({
        phase: 'error',
        error: 'service failed',
      });
    });

    it('supports explicit cancellation', async () => {
      const gate = createLatestOperationGate();
      const operation = gate.run(async ({ signal }) => (
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('stop', 'AbortError')), { once: true });
        })
      ));

      gate.cancel('panel-closed');
      await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
      expect(gate.snapshot().phase).toBe('cancelled');
    });

    it('rejects new work after disposal', async () => {
      const gate = createLatestOperationGate();
      gate.dispose();
      await expect(gate.run(async () => 'never')).rejects.toThrow('disposed');
    });
  });

  describe('bookmark storage codec', () => {
    const bookmark = (
      Title: string,
      Lat = 39.93,
      Lng = 32.85,
      Zoom = 12,
    ): BookmarkRecord => ({ Title, Lat, Lng, Zoom });

    it('decodes valid records and rejects malformed values', () => {
      const result = decodeBookmarks([
        bookmark('Kızılay'),
        { Title: '', Lat: 39, Lng: 32, Zoom: 12 },
        { Title: 'Out', Lat: 120, Lng: 32, Zoom: 12 },
        null,
      ]);

      expect(result.bookmarks).toEqual([bookmark('Kızılay')]);
      expect(result.rejected).toBe(3);
    });

    it('deduplicates titles using Turkish case rules', () => {
      const result = decodeBookmarks([
        bookmark('ANKARA'),
        bookmark('ankara', 39.9, 32.8, 11),
      ]);
      expect(result.bookmarks).toHaveLength(1);
      expect(result.rejected).toBe(1);
    });

    it('caps decoded storage at the supported bookmark budget', () => {
      const source = Array.from(
        { length: MAX_BOOKMARK_COUNT + 20 },
        (_, index) => bookmark(`item-${index}`),
      );
      const result = decodeBookmarks(source);
      expect(result.bookmarks).toHaveLength(MAX_BOOKMARK_COUNT);
      expect(result.rejected).toBe(20);
    });

    it('creates a bookmark from a valid map center and zoom', () => {
      expect(createBookmarkRecord(
        '  Kuğulu   Park ',
        { latitude: 39.901, longitude: 32.860 },
        15,
      )).toEqual({
        Title: 'Kuğulu Park',
        Lat: 39.901,
        Lng: 32.86,
        Zoom: 15,
      });
    });

    it('rejects invalid centers and zoom levels', () => {
      expect(createBookmarkRecord('A', { latitude: 100, longitude: 32 }, 12)).toBeNull();
      expect(createBookmarkRecord('A', { latitude: 39, longitude: 32 }, 99)).toBeNull();
      expect(createBookmarkRecord('', { latitude: 39, longitude: 32 }, 12)).toBeNull();
    });

    it('appends unique bookmarks but refuses title collisions', () => {
      const initial = Object.freeze([bookmark('Kızılay')]);
      const appended = appendBookmark(initial, bookmark('Ulus'));
      expect(appended.map((item) => item.Title)).toEqual(['Kızılay', 'Ulus']);

      const duplicate = appendBookmark(appended, bookmark('ulus'));
      expect(duplicate).toBe(appended);
    });

    it('removes bookmarks by stable list index without mutating the input', () => {
      const initial = Object.freeze([bookmark('A'), bookmark('B'), bookmark('C')]);
      expect(removeBookmarkAt(initial, 1).map((item) => item.Title)).toEqual(['A', 'C']);
      expect(initial.map((item) => item.Title)).toEqual(['A', 'B', 'C']);
    });
  });

  describe('keyboard and identify helpers', () => {
    it('wraps roving focus for arrow keys', () => {
      expect(nextRovingIndex({ activeIndex: 0, itemCount: 4 }, 'ArrowUp')).toBe(3);
      expect(nextRovingIndex({ activeIndex: 3, itemCount: 4 }, 'ArrowDown')).toBe(0);
      expect(nextRovingIndex({ activeIndex: 2, itemCount: 4 }, 'Home')).toBe(0);
      expect(nextRovingIndex({ activeIndex: 1, itemCount: 4 }, 'End')).toBe(3);
      expect(nextRovingIndex({ activeIndex: 1, itemCount: 4 }, 'Enter')).toBe(1);
      expect(nextRovingIndex({ activeIndex: 0, itemCount: 0 }, 'ArrowDown')).toBe(-1);
    });

    it('extracts supported ArcGIS object id aliases', () => {
      expect(objectIdFromIdentifyResult({ attributes: { OBJECTID: 5 } }, 'fallback')).toBe(5);
      expect(objectIdFromIdentifyResult({ feature: { attributes: { fid: 'f-9' } } }, 'fallback')).toBe('f-9');
      expect(objectIdFromIdentifyResult({}, 7)).toBe(7);
    });
  });
});
