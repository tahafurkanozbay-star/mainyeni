import { describe, expect, it, vi } from 'vitest';
import {
  WINDOW_WORKSPACE_SCOPES,
  WindowWorkspaceModel,
  auditWindowWorkspaceSource,
  classifyWindowWorkspaceKind,
  createWindowWorkspaceModel,
  normalizeWindowWorkspaceText,
  windowWorkspaceKindLabel,
  windowWorkspaceStateLabel,
  type WindowWorkspaceSourceSnapshot,
} from './windowWorkspaceModel';

const source = (
  revision: number,
  windows: WindowWorkspaceSourceSnapshot['windows'],
  activeWindowId: string | null = null,
): WindowWorkspaceSourceSnapshot => Object.freeze({
  revision,
  activeWindowId,
  windows: Object.freeze(windows),
});

const queryWindow = (
  id: string,
  title: string,
  visible = false,
  minimized = false,
) => Object.freeze({
  id,
  title,
  visible,
  minimized,
  lazy: true,
});

const toolWindow = (
  id: string,
  title: string | null,
  visible = false,
  minimized = false,
) => Object.freeze({
  id,
  title,
  visible,
  minimized,
  lazy: false,
});

describe('windowWorkspaceModel helpers', () => {
  it('normalizes Turkish letters and accents for forgiving discovery', () => {
    expect(normalizeWindowWorkspaceText('ÖLÇÜM İŞLEMLERİ')).toBe('olcum islemleri');
    expect(normalizeWindowWorkspaceText('Çığlık  ŞĞÜÖİ')).toBe('ciglik sguoi');
  });

  it('normalizes punctuation into stable search separators', () => {
    expect(normalizeWindowWorkspaceText('Parklar_query-window / ABB')).toBe('parklar_query-window abb');
  });

  it('classifies query windows', () => {
    expect(classifyWindowWorkspaceKind('park-query-window')).toBe('query');
  });

  it('classifies widget windows as tools', () => {
    expect(classifyWindowWorkspaceKind('measurement-widget')).toBe('tool');
    expect(classifyWindowWorkspaceKind('toolbar-widget')).toBe('tool');
  });

  it('classifies shell navigation surfaces', () => {
    expect(classifyWindowWorkspaceKind('sidebar')).toBe('navigation');
    expect(classifyWindowWorkspaceKind('mainbar')).toBe('navigation');
  });

  it('keeps unknown ids in the generic window kind', () => {
    expect(classifyWindowWorkspaceKind('municipal-dashboard')).toBe('other');
  });

  it('exposes Turkish kind labels', () => {
    expect(windowWorkspaceKindLabel('query')).toBe('Sorgu');
    expect(windowWorkspaceKindLabel('tool')).toBe('Harita aracı');
    expect(windowWorkspaceKindLabel('navigation')).toBe('Gezinme');
    expect(windowWorkspaceKindLabel('other')).toBe('Pencere');
  });

  it('exposes deterministic state labels', () => {
    expect(windowWorkspaceStateLabel('active')).toBe('Açık');
    expect(windowWorkspaceStateLabel('minimized')).toBe('Küçültülmüş');
    expect(windowWorkspaceStateLabel('hidden')).toBe('Kapalı');
  });

  it('publishes all supported scopes in stable order', () => {
    expect(WINDOW_WORKSPACE_SCOPES.map((item) => item.id)).toEqual([
      'recent',
      'open',
      'queries',
      'tools',
      'all',
    ]);
  });
});

describe('auditWindowWorkspaceSource', () => {
  it('accepts a clean bounded catalog', () => {
    const findings = auditWindowWorkspaceSource(source(1, [
      queryWindow('park-query-window', 'Parklar'),
      toolWindow('measurement-widget', 'Ölçüm'),
    ]));
    expect(findings).toEqual([]);
  });

  it('reports duplicate ids', () => {
    const findings = auditWindowWorkspaceSource(source(1, [
      queryWindow('same', 'Bir'),
      queryWindow('same', 'İki'),
    ]));
    expect(findings.some((finding) => finding.code === 'duplicate-id')).toBe(true);
  });

  it('reports empty ids', () => {
    const findings = auditWindowWorkspaceSource(source(1, [
      queryWindow('   ', 'Boş'),
    ]));
    expect(findings.some((finding) => finding.code === 'empty-id')).toBe(true);
  });

  it('reports oversized ids', () => {
    const findings = auditWindowWorkspaceSource(source(1, [
      queryWindow('x'.repeat(150), 'Uzun'),
    ]));
    expect(findings.some((finding) => finding.code === 'oversized-id')).toBe(true);
  });

  it('reports oversized titles without exposing the full text', () => {
    const findings = auditWindowWorkspaceSource(source(1, [
      queryWindow('long-query-window', 'T'.repeat(220)),
    ]));
    expect(findings.some((finding) => finding.code === 'oversized-title')).toBe(true);
  });

  it('reports catalog overflow against the requested bound', () => {
    const findings = auditWindowWorkspaceSource(source(
      1,
      Array.from({ length: 4 }, (_, index) => queryWindow(`w-${index}`, `W ${index}`)),
    ), 3);
    expect(findings.some((finding) => finding.code === 'catalog-too-large')).toBe(true);
  });
});

describe('WindowWorkspaceModel source ingestion', () => {
  it('starts with an immutable empty recent snapshot', () => {
    const model = createWindowWorkspaceModel();
    const snapshot = model.getSnapshot();
    expect(snapshot).toMatchObject({
      revision: 0,
      sourceRevision: 0,
      scope: 'recent',
      totalCount: 0,
      resultCount: 0,
      openCount: 0,
      minimizedCount: 0,
      recentCount: 0,
      emptyReason: 'no-windows',
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
  });

  it('indexes registered windows and preserves visible state', () => {
    const model = createWindowWorkspaceModel();
    model.ingest(source(4, [
      queryWindow('park-query-window', 'Parklar', true),
      toolWindow('measurement-widget', 'Ölçüm'),
      toolWindow('bookmark-widget', 'Yer işaretleri', true, true),
    ], 'park-query-window'));

    const snapshot = model.getSnapshot();
    expect(snapshot.sourceRevision).toBe(4);
    expect(snapshot.totalCount).toBe(3);
    expect(snapshot.openCount).toBe(2);
    expect(snapshot.minimizedCount).toBe(1);
    expect(snapshot.activeWindowId).toBe('park-query-window');
  });

  it('records a newly active source window as the most recent item', () => {
    const model = createWindowWorkspaceModel();
    model.ingest(source(1, [
      queryWindow('park-query-window', 'Parklar', true),
      queryWindow('culture-query-window', 'Kültür'),
    ], 'park-query-window'));

    expect(model.getSnapshot().entries.map((entry) => entry.id)).toEqual(['park-query-window']);
    expect(model.getSnapshot().recentCount).toBe(1);
  });

  it('moves later active windows to the front of recents', () => {
    const model = createWindowWorkspaceModel();
    const windows = [
      queryWindow('park-query-window', 'Parklar'),
      queryWindow('culture-query-window', 'Kültür'),
    ];
    model.ingest(source(1, [
      { ...windows[0], visible: true },
      windows[1],
    ], 'park-query-window'));
    model.ingest(source(2, [
      windows[0],
      { ...windows[1], visible: true },
    ], 'culture-query-window'));

    expect(model.getSnapshot().entries.map((entry) => entry.id)).toEqual([
      'culture-query-window',
      'park-query-window',
    ]);
  });

  it('bounds the recent list', () => {
    const model = createWindowWorkspaceModel({ maxRecent: 2 });
    const ids = ['a-query-window', 'b-query-window', 'c-query-window'];
    for (let index = 0; index < ids.length; index += 1) {
      model.ingest(source(index + 1, ids.map((id) => queryWindow(
        id,
        id,
        id === ids[index],
      )), ids[index] ?? null));
    }
    expect(model.getSnapshot().recentCount).toBe(2);
    expect(model.getSnapshot().entries.map((entry) => entry.id)).toEqual([
      'c-query-window',
      'b-query-window',
    ]);
  });

  it('prunes recent ids when a window is unregistered', () => {
    const model = createWindowWorkspaceModel();
    model.ingest(source(1, [queryWindow('a-query-window', 'A', true)], 'a-query-window'));
    expect(model.getSnapshot().recentCount).toBe(1);

    model.ingest(source(2, []));
    expect(model.getSnapshot().recentCount).toBe(0);
    expect(model.getSnapshot().emptyReason).toBe('no-windows');
  });

  it('derives an active window when source active id is absent', () => {
    const model = createWindowWorkspaceModel();
    model.ingest(source(1, [
      queryWindow('park-query-window', 'Parklar', true),
    ], null));
    expect(model.getSnapshot().activeWindowId).toBe('park-query-window');
  });

  it('ignores an unknown source active id', () => {
    const model = createWindowWorkspaceModel();
    model.ingest(source(1, [
      queryWindow('park-query-window', 'Parklar'),
    ], 'missing'));
    expect(model.getSnapshot().activeWindowId).toBeNull();
  });

  it('rejects duplicate source ids instead of creating ambiguous selection', () => {
    const model = createWindowWorkspaceModel();
    expect(() => model.ingest(source(1, [
      queryWindow('same', 'Bir'),
      queryWindow('same', 'İki'),
    ]))).toThrow(/invalid window workspace source/i);
  });

  it('rejects empty source ids', () => {
    const model = createWindowWorkspaceModel();
    expect(() => model.ingest(source(1, [
      queryWindow(' ', 'Boş'),
    ]))).toThrow(/invalid window workspace source/i);
  });

  it('bounds oversized source catalogs without retaining excess records', () => {
    const model = createWindowWorkspaceModel({ maxWindows: 3 });
    model.ingest(source(1, Array.from({ length: 6 }, (_, index) => (
      queryWindow(`window-${index}`, `Pencere ${index}`)
    ))));
    model.setScope('all');
    expect(model.getSnapshot().totalCount).toBe(3);
  });

  it('does not retain query payloads because source records have no query field', () => {
    const model = createWindowWorkspaceModel();
    const unsafe = {
      id: 'park-query-window',
      title: 'Parklar',
      visible: false,
      minimized: false,
      lazy: true,
      query: { token: 'should-not-be-retained' },
    };
    model.ingest(source(1, [unsafe]));
    model.setScope('all');
    expect(JSON.stringify(model.getSnapshot())).not.toContain('should-not-be-retained');
  });
});

describe('WindowWorkspaceModel discovery', () => {
  const build = (): WindowWorkspaceModel => {
    const model = createWindowWorkspaceModel({ maxRecent: 6, pageSize: 2 });
    model.ingest(source(1, [
      queryWindow('park-query-window', 'Parklar', true),
      queryWindow('culture-query-window', 'Kültür ve Sanat'),
      queryWindow('wifi-query-window', 'Wi-Fi Noktaları'),
      toolWindow('measurement-widget', 'Ölçüm araçları'),
      toolWindow('bookmark-widget', 'Yer işaretleri', true, true),
      toolWindow('sidebar', 'Şehir servisleri'),
    ], 'park-query-window'));
    model.noteActivated('measurement-widget');
    model.noteActivated('culture-query-window');
    return model;
  };

  it('searches Turkish text without diacritic sensitivity', () => {
    const model = build();
    model.setScope('all');
    model.setQuery('OLCUM');
    expect(model.getSnapshot().entries.map((entry) => entry.id)).toEqual(['measurement-widget']);
  });

  it('searches window ids as a secondary discovery path', () => {
    const model = build();
    model.setScope('all');
    model.setQuery('bookmark');
    expect(model.getSnapshot().entries.map((entry) => entry.id)).toEqual(['bookmark-widget']);
  });

  it('filters query windows', () => {
    const model = build();
    model.setScope('queries');
    expect(model.getSnapshot().entries.every((entry) => entry.kind === 'query')).toBe(true);
    expect(model.getSnapshot().resultCount).toBe(3);
  });

  it('filters tools and navigation surfaces together', () => {
    const model = build();
    model.setScope('tools');
    expect(model.getSnapshot().entries.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      'measurement-widget',
      'bookmark-widget',
      'sidebar',
    ]));
  });

  it('filters visible and minimized windows in open scope', () => {
    const model = build();
    model.setScope('open');
    expect(model.getSnapshot().entries.map((entry) => entry.id)).toEqual([
      'park-query-window',
      'bookmark-widget',
    ]);
  });

  it('sorts the active open window before minimized windows', () => {
    const model = build();
    model.setScope('open');
    const [first, second] = model.getSnapshot().entries;
    expect(first?.state).toBe('active');
    expect(second?.state).toBe('minimized');
  });

  it('returns all windows in all scope', () => {
    const model = build();
    model.setScope('all');
    expect(model.getSnapshot().resultCount).toBe(6);
  });

  it('composes scope and text query', () => {
    const model = build();
    model.setScope('queries');
    model.setQuery('kultur');
    expect(model.getSnapshot().entries.map((entry) => entry.id)).toEqual(['culture-query-window']);
  });

  it('reports a query empty reason', () => {
    const model = build();
    model.setScope('all');
    model.setQuery('bulunmayan-terim');
    expect(model.getSnapshot()).toMatchObject({
      resultCount: 0,
      emptyReason: 'no-results',
    });
    expect(model.getSnapshot().announcement).toMatch(/eşleşen/i);
  });

  it('reports a no-open empty reason', () => {
    const model = createWindowWorkspaceModel();
    model.ingest(source(1, [
      queryWindow('park-query-window', 'Parklar'),
    ]));
    model.setScope('open');
    expect(model.getSnapshot().emptyReason).toBe('no-open');
  });

  it('reports a no-recent empty reason', () => {
    const model = createWindowWorkspaceModel();
    model.ingest(source(1, [
      queryWindow('park-query-window', 'Parklar'),
    ]));
    expect(model.getSnapshot().emptyReason).toBe('no-recent');
  });

  it('bounds and sanitizes the query', () => {
    const model = createWindowWorkspaceModel({ maxQueryLength: 8 });
    model.setQuery('  abc\u0000def ghi  ');
    expect(model.getSnapshot().query.length).toBeLessThanOrEqual(8);
    expect(model.getSnapshot().query).not.toContain('\u0000');
  });

  it('resetDiscovery prefers recent scope when recents exist', () => {
    const model = build();
    model.setScope('queries');
    model.setQuery('park');
    model.resetDiscovery();
    expect(model.getSnapshot()).toMatchObject({ scope: 'recent', query: '' });
  });

  it('resetDiscovery falls back to all when no recents exist', () => {
    const model = createWindowWorkspaceModel();
    model.ingest(source(1, [queryWindow('park-query-window', 'Parklar')]));
    model.resetDiscovery();
    expect(model.getSnapshot().scope).toBe('all');
  });

  it('uses known tool labels when the source title is absent', () => {
    const model = createWindowWorkspaceModel();
    model.ingest(source(1, [toolWindow('measurement-widget', null)]));
    model.setScope('all');
    expect(model.getSnapshot().entries[0]?.title).toBe('Ölçüm araçları');
  });

  it('humanizes unknown ids when no source title exists', () => {
    const model = createWindowWorkspaceModel();
    model.ingest(source(1, [toolWindow('municipal-dashboard-window', null)]));
    model.setScope('all');
    expect(model.getSnapshot().entries[0]?.title).toBe('Municipal dashboard');
  });

  it('creates stable DOM ids for unusual but valid window ids', () => {
    const model = createWindowWorkspaceModel();
    model.ingest(source(1, [toolWindow('özel araç-widget', 'Özel araç')]));
    model.setScope('all');
    expect(model.getSnapshot().entries[0]?.domId).toMatch(/^experience-window-dock-item-/);
    expect(model.getSnapshot().entries[0]?.domId).not.toContain(' ');
  });

  it('publishes collection positions for assistive technology', () => {
    const model = build();
    model.setScope('all');
    const entries = model.getSnapshot().entries;
    expect(entries[0]?.position).toBe(1);
    expect(entries.at(-1)?.position).toBe(entries.length);
    expect(entries.every((entry) => entry.setSize === entries.length)).toBe(true);
  });

  it('publishes only one selected entry', () => {
    const model = build();
    model.setScope('all');
    expect(model.getSnapshot().entries.filter((entry) => entry.selected)).toHaveLength(1);
  });
});

describe('WindowWorkspaceModel keyboard selection state', () => {
  const build = (): WindowWorkspaceModel => {
    const model = createWindowWorkspaceModel({ pageSize: 2 });
    model.ingest(source(1, [
      queryWindow('a-query-window', 'A'),
      queryWindow('b-query-window', 'B'),
      queryWindow('c-query-window', 'C'),
      queryWindow('d-query-window', 'D'),
      queryWindow('e-query-window', 'E'),
    ]));
    model.setScope('all');
    return model;
  };

  it('moves to next and previous entries with wraparound', () => {
    const model = build();
    expect(model.getSnapshot().activeEntryId).toBe('a-query-window');
    model.moveActive('previous');
    expect(model.getSnapshot().activeEntryId).toBe('e-query-window');
    model.moveActive('next');
    expect(model.getSnapshot().activeEntryId).toBe('a-query-window');
  });

  it('moves to first and last entries', () => {
    const model = build();
    model.moveActive('last');
    expect(model.getSnapshot().activeEntryId).toBe('e-query-window');
    model.moveActive('first');
    expect(model.getSnapshot().activeEntryId).toBe('a-query-window');
  });

  it('moves by bounded page size', () => {
    const model = build();
    model.moveActive('page-next');
    expect(model.getSnapshot().activeEntryId).toBe('c-query-window');
    model.moveActive('page-next');
    expect(model.getSnapshot().activeEntryId).toBe('e-query-window');
    model.moveActive('page-previous');
    expect(model.getSnapshot().activeEntryId).toBe('c-query-window');
  });

  it('ignores selection of filtered-out ids', () => {
    const model = build();
    model.setQuery('A');
    model.setActive('e-query-window');
    expect(model.getSnapshot().activeEntryId).toBe('a-query-window');
  });

  it('reconciles selection when a filter removes the selected item', () => {
    const model = build();
    model.setActive('d-query-window');
    model.setQuery('B');
    expect(model.getSnapshot().activeEntryId).toBe('b-query-window');
  });

  it('noteActivated brings a registered item into recents', () => {
    const model = build();
    model.noteActivated('d-query-window');
    model.setScope('recent');
    expect(model.getSnapshot().entries[0]?.id).toBe('d-query-window');
  });

  it('ignores noteActivated for unknown ids', () => {
    const model = build();
    const before = model.getSnapshot().revision;
    model.noteActivated('missing');
    expect(model.getSnapshot().revision).toBe(before);
  });
});

describe('WindowWorkspaceModel observer reliability', () => {
  it('notifies subscribers on meaningful commits', () => {
    const listener = vi.fn();
    const model = createWindowWorkspaceModel();
    model.subscribe(listener);
    model.ingest(source(1, [queryWindow('a-query-window', 'A')]));
    model.setScope('all');
    model.setQuery('a');
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('supports idempotent unsubscribe', () => {
    const listener = vi.fn();
    const model = createWindowWorkspaceModel();
    const unsubscribe = model.subscribe(listener);
    unsubscribe();
    unsubscribe();
    model.setQuery('x');
    expect(listener).not.toHaveBeenCalled();
    expect(model.getDiagnostics().activeListenerCount).toBe(0);
  });

  it('bounds listener capacity without throwing into user interaction', () => {
    const model = createWindowWorkspaceModel({ maxListeners: 1 });
    model.subscribe(() => undefined);
    const second = vi.fn();
    const unsubscribe = model.subscribe(second);
    expect(model.getDiagnostics()).toMatchObject({
      activeListenerCount: 1,
      rejectedListenerCount: 1,
    });
    unsubscribe();
    model.setQuery('x');
    expect(second).not.toHaveBeenCalled();
  });

  it('isolates a failing listener and continues notifying healthy listeners', () => {
    const healthy = vi.fn();
    const reporter = vi.fn();
    const model = createWindowWorkspaceModel({ onListenerError: reporter });
    model.subscribe(() => { throw new Error('observer failed'); });
    model.subscribe(healthy);

    expect(() => model.setQuery('park')).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(model.getDiagnostics()).toMatchObject({
      listenerFailureCount: 1,
      reporterFailureCount: 0,
      lastFailureKind: 'Error',
    });
  });

  it('records reporter failures without interrupting the interaction state', () => {
    const model = createWindowWorkspaceModel({
      onListenerError() {
        throw new TypeError('reporter failed');
      },
    });
    model.subscribe(() => { throw new Error('observer failed'); });

    model.setQuery('park');
    expect(model.getSnapshot().query).toBe('park');
    expect(model.getDiagnostics()).toMatchObject({
      listenerFailureCount: 1,
      reporterFailureCount: 1,
      lastFailureKind: 'reporter:TypeError',
    });
  });

  it('tracks listener failure revision', () => {
    const model = createWindowWorkspaceModel();
    model.subscribe(() => { throw new Error('fail'); });
    model.setQuery('x');
    expect(model.getDiagnostics().lastFailureRevision).toBe(model.getSnapshot().revision);
  });

  it('dispose clears listeners and makes later mutations no-op', () => {
    const listener = vi.fn();
    const model = createWindowWorkspaceModel();
    model.subscribe(listener);
    model.dispose();
    const revision = model.getSnapshot().revision;
    model.setQuery('after');
    model.setScope('all');
    model.noteActivated('missing');
    expect(model.getSnapshot().revision).toBe(revision);
    expect(listener).not.toHaveBeenCalled();
    expect(model.getDiagnostics()).toMatchObject({
      activeListenerCount: 0,
      disposed: true,
    });
  });

  it('records rejected subscriptions after dispose', () => {
    const model = createWindowWorkspaceModel();
    model.dispose();
    model.subscribe(() => undefined);
    expect(model.getDiagnostics().rejectedListenerCount).toBe(1);
  });

  it('reports inventory by window kind', () => {
    const model = createWindowWorkspaceModel();
    model.ingest(source(1, [
      queryWindow('park-query-window', 'Parklar'),
      queryWindow('culture-query-window', 'Kültür'),
      toolWindow('measurement-widget', 'Ölçüm'),
      toolWindow('sidebar', 'Şehir servisleri'),
      toolWindow('custom-window', 'Özel'),
    ]));
    expect(model.inventory()).toEqual({
      totalCount: 5,
      queryCount: 2,
      toolCount: 1,
      navigationCount: 1,
      otherCount: 1,
    });
  });
});
