import { describe, expect, it, vi } from 'vitest';
import { LayerPanelModel, type LayerNodeInput, type LayerPanelSnapshot } from './layerPanelModel';

const nodes: readonly LayerNodeInput[] = [
  { id: 'transport', label: 'Ulaşım', kind: 'group', children: ['roads', 'rail'] },
  { id: 'roads', label: 'Yollar', kind: 'layer', parentId: 'transport' },
  { id: 'rail', label: 'Raylı Sistem', kind: 'layer', parentId: 'transport', visible: false },
  { id: 'environment', label: 'Çevre', kind: 'group', children: ['parks'] },
  { id: 'parks', label: 'Yeşil Alanlar', kind: 'layer', parentId: 'environment' },
];

const row = (snapshot: LayerPanelSnapshot, id: string) => {
  const found = snapshot.rows.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing row ${id}`);
  return found;
};

describe('LayerPanelModel', () => {
  it('starts with roots only and one roving tab stop', () => {
    const model = new LayerPanelModel({ nodes });
    expect(model.snapshot.rows.map(({ id }) => id)).toEqual(['transport', 'environment']);
    expect(model.snapshot.rows.filter(({ tabIndex }) => tabIndex === 0)).toHaveLength(1);
    expect(model.snapshot.focusedId).toBe('transport');
  });

  it('expands groups with tree aria metadata', () => {
    const model = new LayerPanelModel({ nodes });
    model.toggleExpanded('transport');
    expect(model.snapshot.rows.map(({ id }) => id)).toEqual(['transport', 'roads', 'rail', 'environment']);
    expect(row(model.snapshot, 'roads')).toMatchObject({ level: 2, positionInSet: 1, setSize: 2 });
    expect(row(model.snapshot, 'transport').expanded).toBe(true);
  });

  it('repairs focus when a focused descendant is collapsed', () => {
    const model = new LayerPanelModel({ nodes, initialExpandedIds: ['transport'] });
    model.focus('roads');
    model.collapse('transport');
    expect(model.snapshot.focusedId).toBe('transport');
    expect(row(model.snapshot, 'transport').tabIndex).toBe(0);
  });

  it('wraps next and previous focus over enabled visible rows', () => {
    const model = new LayerPanelModel({ nodes });
    model.focusLast();
    expect(model.snapshot.focusedId).toBe('environment');
    model.focusNext();
    expect(model.snapshot.focusedId).toBe('transport');
    model.focusPrevious();
    expect(model.snapshot.focusedId).toBe('environment');
  });

  it('skips disabled rows during keyboard movement', () => {
    const model = new LayerPanelModel({ nodes: [
      { id: 'a', label: 'A', kind: 'layer' },
      { id: 'b', label: 'B', kind: 'layer', disabled: true },
      { id: 'c', label: 'C', kind: 'layer' },
    ] });
    model.focusNext();
    expect(model.snapshot.focusedId).toBe('c');
  });

  it('supports parent and first-child keyboard navigation', () => {
    const model = new LayerPanelModel({ nodes });
    model.focusFirstChild();
    expect(model.snapshot.focusedId).toBe('roads');
    expect(row(model.snapshot, 'transport').expanded).toBe(true);
    model.focusParent();
    expect(model.snapshot.focusedId).toBe('transport');
  });

  it('filters with Turkish-aware matching while retaining ancestors', () => {
    const model = new LayerPanelModel({ nodes });
    model.setQuery('yeşil');
    expect(model.snapshot.rows.map(({ id }) => id)).toEqual(['environment', 'parks']);
    expect(model.snapshot.resultCount).toBe(1);
    expect(row(model.snapshot, 'environment').match).toBe(false);
    expect(row(model.snapshot, 'parks').match).toBe(true);
  });

  it('makes matched descendants discoverable without mutating expansion state', () => {
    const model = new LayerPanelModel({ nodes });
    model.setQuery('raylı');
    expect(row(model.snapshot, 'transport').expanded).toBe(true);
    model.clearQuery();
    expect(row(model.snapshot, 'transport').expanded).toBe(false);
    expect(model.snapshot.rows.some(({ id }) => id === 'rail')).toBe(false);
  });

  it('reports no-results and no-layers empty states separately', () => {
    const populated = new LayerPanelModel({ nodes });
    populated.setQuery('bulunmayan');
    expect(populated.snapshot.emptyReason).toBe('no-results');
    expect(populated.snapshot.rows).toEqual([]);
    expect(new LayerPanelModel({ nodes: [] }).snapshot.emptyReason).toBe('no-layers');
  });

  it('selects a row and moves roving focus with selection', () => {
    const model = new LayerPanelModel({ nodes });
    model.select('environment');
    expect(model.snapshot.selectedId).toBe('environment');
    expect(model.snapshot.focusedId).toBe('environment');
    expect(row(model.snapshot, 'environment').selected).toBe(true);
  });

  it('ignores selection of disabled rows', () => {
    const model = new LayerPanelModel({ nodes: [{ id: 'locked', label: 'Kilitli', kind: 'layer', disabled: true }] });
    model.select('locked');
    expect(model.snapshot.selectedId).toBeUndefined();
  });

  it('toggles visibility and announces the resulting state', () => {
    const onAnnouncement = vi.fn();
    const model = new LayerPanelModel({ nodes, initialExpandedIds: ['transport'], onAnnouncement });
    model.toggleVisibility('rail');
    expect(row(model.snapshot, 'rail').visible).toBe(true);
    expect(onAnnouncement).toHaveBeenLastCalledWith({ message: 'Raylı Sistem görünür.', priority: 'polite' });
  });

  it('does not toggle a loading layer visibility', () => {
    const model = new LayerPanelModel({ nodes: [{ id: 'loading', label: 'Yükleniyor', kind: 'layer', status: 'loading' }] });
    model.toggleVisibility('loading');
    expect(row(model.snapshot, 'loading').visible).toBe(true);
    expect(model.snapshot.revision).toBe(0);
  });

  it('announces result counts after search', () => {
    const onAnnouncement = vi.fn();
    const model = new LayerPanelModel({ nodes, onAnnouncement });
    model.setQuery('yol');
    expect(onAnnouncement).toHaveBeenCalledWith({ message: '1 katman sonucu bulundu.', priority: 'polite' });
    model.clearQuery();
    expect(onAnnouncement).toHaveBeenLastCalledWith({ message: '5 katman gösteriliyor.', priority: 'polite' });
  });

  it('uses 48px targets for coarse pointers', () => {
    const model = new LayerPanelModel({ nodes, preferences: { coarsePointer: true, density: 'compact' } });
    expect(model.snapshot.rows.every(({ targetSize }) => targetSize === 48)).toBe(true);
  });

  it('preserves reduced-motion and forced-colors presentation facts', () => {
    const model = new LayerPanelModel({ nodes, preferences: { reducedMotion: true, forcedColors: true } });
    expect(model.snapshot).toMatchObject({ reducedMotion: true, forcedColors: true });
  });

  it('uses compact target sizing for fine pointers', () => {
    const model = new LayerPanelModel({ nodes, preferences: { density: 'compact' } });
    expect(model.snapshot.rows.every(({ targetSize }) => targetSize === 36)).toBe(true);
  });

  it('emits immutable snapshots with monotonic revisions', () => {
    const model = new LayerPanelModel({ nodes });
    const initial = model.snapshot;
    model.toggleExpanded('transport');
    const expanded = model.snapshot;
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.rows)).toBe(true);
    expect(expanded.revision).toBe(initial.revision + 1);
    expect(initial.rows).toHaveLength(2);
  });

  it('notifies subscribers immediately and after commits', () => {
    const model = new LayerPanelModel({ nodes });
    const revisions: number[] = [];
    const unsubscribe = model.subscribe((snapshot) => revisions.push(snapshot.revision));
    model.toggleExpanded('transport');
    unsubscribe();
    model.toggleExpanded('environment');
    expect(revisions).toEqual([0, 1]);
  });

  it('isolates observer failures and reports them', () => {
    const onObserverError = vi.fn();
    const model = new LayerPanelModel({ nodes, onObserverError });
    model.subscribe(() => { throw new Error('observer'); });
    const healthy = vi.fn();
    model.subscribe(healthy);
    model.toggleExpanded('transport');
    expect(onObserverError).toHaveBeenCalled();
    expect(healthy).toHaveBeenLastCalledWith(model.snapshot);
  });

  it('isolates announcement adapter failures', () => {
    const onObserverError = vi.fn();
    const model = new LayerPanelModel({
      nodes,
      onObserverError,
      onAnnouncement: () => { throw new Error('announcement'); },
    });
    expect(() => model.select('environment')).not.toThrow();
    expect(onObserverError).toHaveBeenCalledTimes(1);
    expect(model.snapshot.selectedId).toBe('environment');
  });

  it('rejects duplicate ids', () => {
    expect(() => new LayerPanelModel({ nodes: [
      { id: 'same', label: 'A', kind: 'layer' },
      { id: 'same', label: 'B', kind: 'layer' },
    ] })).toThrow('Duplicate layer id');
  });

  it('rejects unknown parents', () => {
    expect(() => new LayerPanelModel({ nodes: [
      { id: 'orphan', label: 'Yetim', kind: 'layer', parentId: 'missing' },
    ] })).toThrow('Unknown parent');
  });

  it('rejects parent-child mismatches', () => {
    expect(() => new LayerPanelModel({ nodes: [
      { id: 'group', label: 'Grup', kind: 'group', children: ['child'] },
      { id: 'child', label: 'Çocuk', kind: 'layer' },
    ] })).toThrow('Parent/child mismatch');
  });

  it('rejects children on leaf layers', () => {
    expect(() => new LayerPanelModel({ nodes: [
      { id: 'leaf', label: 'Yaprak', kind: 'layer', children: ['child'] },
      { id: 'child', label: 'Çocuk', kind: 'layer', parentId: 'leaf' },
    ] })).toThrow('cannot contain children');
  });

  it('rejects cyclic trees', () => {
    expect(() => new LayerPanelModel({ nodes: [
      { id: 'a', label: 'A', kind: 'group', parentId: 'b', children: ['b'] },
      { id: 'b', label: 'B', kind: 'group', parentId: 'a', children: ['a'] },
    ] })).toThrow('cycle');
  });

  it('caps layer panel size to prevent unbounded UI state', () => {
    const oversized = Array.from({ length: 2_001 }, (_, index): LayerNodeInput => ({
      id: `layer-${index}`,
      label: `Katman ${index}`,
      kind: 'layer',
    }));
    expect(() => new LayerPanelModel({ nodes: oversized })).toThrow(RangeError);
  });
});
