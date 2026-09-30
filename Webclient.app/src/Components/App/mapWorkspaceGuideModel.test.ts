import { describe, expect, it, vi } from 'vitest';
import {
  MAP_WORKSPACE_GUIDE_CATEGORIES,
  MAP_WORKSPACE_GUIDE_DEFINITIONS,
  MapWorkspaceGuideModel,
  auditMapWorkspaceGuideCatalog,
  type MapWorkspaceGuideDefinition,
} from './mapWorkspaceGuideModel';

describe('mapWorkspaceGuideModel catalog', () => {
  it('ships a bounded deterministic help catalog', () => {
    expect(MAP_WORKSPACE_GUIDE_DEFINITIONS).toHaveLength(16);
    expect(auditMapWorkspaceGuideCatalog()).toEqual([]);
    expect(MAP_WORKSPACE_GUIDE_DEFINITIONS.map((entry) => entry.id)).toEqual([
      'map-focus',
      'map-pan-zoom',
      'sidebar-discovery',
      'command-center',
      'basemap',
      'measurement',
      'map-mode',
      'feedback',
      'query-results',
      'data-table',
      'data-disclaimer',
      'focus-visible',
      'skip-navigation',
      'motion-colors',
      'offline-recovery',
      'startup-recovery',
    ]);
  });

  it('ships every public category in deterministic order', () => {
    expect(MAP_WORKSPACE_GUIDE_CATEGORIES).toEqual([
      { id: 'all', label: 'Tüm rehber' },
      { id: 'navigation', label: 'Gezinme' },
      { id: 'tools', label: 'Araçlar' },
      { id: 'data', label: 'Veri ve sonuçlar' },
      { id: 'accessibility', label: 'Erişilebilirlik' },
      { id: 'recovery', label: 'Bağlantı ve kurtarma' },
    ]);
  });

  it('freezes catalog definitions and nested arrays', () => {
    const first = MAP_WORKSPACE_GUIDE_DEFINITIONS[0];
    expect(Object.isFrozen(MAP_WORKSPACE_GUIDE_DEFINITIONS)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.steps)).toBe(true);
    expect(Object.isFrozen(first?.keywords)).toBe(true);
  });

  it('detects duplicate ids', () => {
    const duplicate = [
      ...MAP_WORKSPACE_GUIDE_DEFINITIONS,
      MAP_WORKSPACE_GUIDE_DEFINITIONS[0]!,
    ];
    expect(auditMapWorkspaceGuideCatalog(duplicate).some((finding) => finding.code === 'duplicate-id')).toBe(true);
  });

  it('detects missing titles and summaries', () => {
    const source = MAP_WORKSPACE_GUIDE_DEFINITIONS[0]!;
    const broken: MapWorkspaceGuideDefinition[] = [
      { ...source, id: 'empty-title', title: '' },
      { ...source, id: 'empty-summary', summary: '   ' },
    ];
    const findings = auditMapWorkspaceGuideCatalog(broken);
    expect(findings.some((finding) => finding.code === 'empty-title')).toBe(true);
    expect(findings.some((finding) => finding.code === 'empty-summary')).toBe(true);
  });

  it('detects missing and empty steps', () => {
    const source = MAP_WORKSPACE_GUIDE_DEFINITIONS[0]!;
    const findings = auditMapWorkspaceGuideCatalog([
      { ...source, id: 'empty-steps', steps: [] },
      { ...source, id: 'empty-step', steps: ['Birinci', '  '] },
    ]);
    expect(findings.some((finding) => finding.code === 'empty-steps')).toBe(true);
    expect(findings.some((finding) => finding.code === 'empty-step')).toBe(true);
  });

  it('rejects entries that exceed the bounded step budget', () => {
    const source = MAP_WORKSPACE_GUIDE_DEFINITIONS[0]!;
    const findings = auditMapWorkspaceGuideCatalog([
      { ...source, id: 'too-many', steps: Array.from({ length: 9 }, (_, index) => `Adım ${index + 1}`) },
    ]);
    expect(findings.some((finding) => finding.code === 'too-many-steps')).toBe(true);
  });

  it('rejects unbounded catalogs', () => {
    const source = MAP_WORKSPACE_GUIDE_DEFINITIONS[0]!;
    const oversized = Array.from({ length: 49 }, (_, index) => ({
      ...source,
      id: `guide-${index}`,
    }));
    expect(auditMapWorkspaceGuideCatalog(oversized).some((finding) => finding.code === 'catalog-too-large')).toBe(true);
  });
});

describe('MapWorkspaceGuideModel', () => {
  it('starts with all topics and a deterministic active topic', () => {
    const model = new MapWorkspaceGuideModel();
    const snapshot = model.getSnapshot();
    expect(snapshot).toMatchObject({
      revision: 0,
      query: '',
      category: 'all',
      activeId: 'map-focus',
      resultCount: 16,
      totalCount: 16,
      empty: false,
    });
    expect(snapshot.activeEntry?.title).toBe('Harita çalışma alanına hızlı geçiş');
    expect(snapshot.announcement).toBe('16 çalışma alanı rehberi gösteriliyor.');
  });

  it('publishes immutable snapshots and entries', () => {
    const model = new MapWorkspaceGuideModel();
    const snapshot = model.getSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(snapshot.entries.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0]?.steps)).toBe(true);
  });

  it('searches Turkish text without requiring accents', () => {
    const model = new MapWorkspaceGuideModel();
    model.setQuery('olcum');
    const snapshot = model.getSnapshot();
    expect(snapshot.resultCount).toBe(1);
    expect(snapshot.activeEntry?.sourceId).toBe('measurement');
    expect(snapshot.activeEntry?.title).toContain('Ölçüm');
  });

  it('searches English technical keywords', () => {
    const model = new MapWorkspaceGuideModel();
    model.setQuery('forced colors');
    expect(model.getSnapshot().entries.map((entry) => entry.sourceId)).toEqual(['motion-colors']);
    model.setQuery('bootstrap');
    expect(model.getSnapshot().entries.map((entry) => entry.sourceId)).toEqual(['startup-recovery']);
  });

  it('searches shortcut hints', () => {
    const model = new MapWorkspaceGuideModel();
    model.setQuery('Ctrl+K');
    expect(model.getSnapshot().entries.map((entry) => entry.sourceId)).toEqual(['command-center']);
    model.setQuery('Alt+R');
    expect(model.getSnapshot().entries.map((entry) => entry.sourceId)).toEqual(['measurement']);
  });

  it('filters by navigation category', () => {
    const model = new MapWorkspaceGuideModel();
    model.setCategory('navigation');
    expect(model.getSnapshot().entries.map((entry) => entry.sourceId)).toEqual([
      'map-focus',
      'map-pan-zoom',
      'sidebar-discovery',
      'command-center',
    ]);
    expect(model.getSnapshot().activeId).toBe('map-focus');
  });

  it('filters by accessibility category', () => {
    const model = new MapWorkspaceGuideModel();
    model.setCategory('accessibility');
    expect(model.getSnapshot().entries.map((entry) => entry.sourceId)).toEqual([
      'focus-visible',
      'skip-navigation',
      'motion-colors',
    ]);
  });

  it('filters by recovery category', () => {
    const model = new MapWorkspaceGuideModel();
    model.setCategory('recovery');
    expect(model.getSnapshot().entries.map((entry) => entry.sourceId)).toEqual([
      'offline-recovery',
      'startup-recovery',
    ]);
  });

  it('composes query and category filters', () => {
    const model = new MapWorkspaceGuideModel();
    model.setCategory('data');
    model.setQuery('sayfa');
    expect(model.getSnapshot().entries.map((entry) => entry.sourceId)).toEqual(['data-table']);
  });

  it('publishes a useful empty state', () => {
    const model = new MapWorkspaceGuideModel();
    model.setQuery('meteoroloji radarı');
    expect(model.getSnapshot()).toMatchObject({
      resultCount: 0,
      activeId: null,
      activeEntry: null,
      empty: true,
      announcement: 'Filtrelerle eşleşen rehber konusu bulunamadı.',
    });
  });

  it('bounds query length', () => {
    const model = new MapWorkspaceGuideModel(undefined, { maxQueryLength: 12 });
    model.setQuery('a'.repeat(50));
    expect(model.getSnapshot().query).toHaveLength(12);
  });

  it('normalizes impossible query budgets to supported limits', () => {
    const lower = new MapWorkspaceGuideModel(undefined, { maxQueryLength: 0 });
    lower.setQuery('abc');
    expect(lower.getSnapshot().query).toBe('a');

    const upper = new MapWorkspaceGuideModel(undefined, { maxQueryLength: 9999 });
    upper.setQuery('a'.repeat(500));
    expect(upper.getSnapshot().query).toHaveLength(180);
  });

  it('keeps the active topic when it remains visible after search', () => {
    const model = new MapWorkspaceGuideModel();
    model.setActive('measurement');
    model.setQuery('ölçüm');
    expect(model.getSnapshot().activeId).toBe('measurement');
  });

  it('moves active selection with wraparound', () => {
    const model = new MapWorkspaceGuideModel(undefined, { pageSize: 5 });
    model.moveActive('previous');
    expect(model.getSnapshot().activeId).toBe('startup-recovery');
    model.moveActive('next');
    expect(model.getSnapshot().activeId).toBe('map-focus');
  });

  it('moves active selection to first and last', () => {
    const model = new MapWorkspaceGuideModel();
    model.moveActive('last');
    expect(model.getSnapshot().activeId).toBe('startup-recovery');
    model.moveActive('first');
    expect(model.getSnapshot().activeId).toBe('map-focus');
  });

  it('moves by bounded pages', () => {
    const model = new MapWorkspaceGuideModel(undefined, { pageSize: 4 });
    model.moveActive('page-next');
    expect(model.getSnapshot().activeId).toBe('basemap');
    model.moveActive('page-next');
    expect(model.getSnapshot().activeId).toBe('query-results');
    model.moveActive('page-previous');
    expect(model.getSnapshot().activeId).toBe('basemap');
  });

  it('does not publish for invalid active ids', () => {
    const model = new MapWorkspaceGuideModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.setActive('does-not-exist');
    expect(listener).not.toHaveBeenCalled();
    expect(model.getSnapshot().revision).toBe(0);
  });

  it('does not publish when category is unchanged', () => {
    const model = new MapWorkspaceGuideModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.setCategory('all');
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies observers once per state change', () => {
    const model = new MapWorkspaceGuideModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.setQuery('harita');
    expect(listener).toHaveBeenCalledTimes(1);
    model.setCategory('navigation');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('enforces the observer budget', () => {
    const model = new MapWorkspaceGuideModel(undefined, { maxListeners: 2 });
    model.subscribe(() => undefined);
    model.subscribe(() => undefined);
    expect(() => model.subscribe(() => undefined)).toThrow(/listener limit exceeded/u);
  });

  it('allows observer slots to be reused', () => {
    const model = new MapWorkspaceGuideModel(undefined, { maxListeners: 1 });
    const unsubscribe = model.subscribe(() => undefined);
    unsubscribe();
    expect(() => model.subscribe(() => undefined)).not.toThrow();
  });

  it('reset restores all topics and defaults', () => {
    const model = new MapWorkspaceGuideModel();
    model.setCategory('tools');
    model.setQuery('ölçüm');
    model.reset();
    expect(model.getSnapshot()).toMatchObject({
      query: '',
      category: 'all',
      activeId: 'map-focus',
      resultCount: 16,
    });
  });

  it('disposes listeners and ignores later mutations', () => {
    const model = new MapWorkspaceGuideModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.dispose();
    const revision = model.getSnapshot().revision;
    model.setQuery('ölçüm');
    model.setCategory('tools');
    model.moveActive('next');
    expect(model.disposed()).toBe(true);
    expect(model.listenerCount()).toBe(0);
    expect(model.getSnapshot().revision).toBe(revision);
    expect(listener).not.toHaveBeenCalled();
  });

  it('returns a no-op subscription after disposal', () => {
    const model = new MapWorkspaceGuideModel();
    model.dispose();
    const unsubscribe = model.subscribe(() => undefined);
    expect(() => unsubscribe()).not.toThrow();
    expect(model.listenerCount()).toBe(0);
  });
});
