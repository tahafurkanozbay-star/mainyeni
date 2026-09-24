import { describe, expect, it, vi } from 'vitest';
import { LegendPanelModel, type LegendItemInput } from './legendPanelModel';

const items: readonly LegendItemInput[] = [
  { id: 'road-primary', layerId: 'roads', layerLabel: 'Yollar', label: 'Ana Yol', symbolKind: 'line', description: 'Birincil ulaşım', scaleMin: 1_000, scaleMax: 100_000 },
  { id: 'road-local', layerId: 'roads', layerLabel: 'Yollar', label: 'Yerel Yol', symbolKind: 'line', scaleMin: 1_000, scaleMax: 25_000 },
  { id: 'park', layerId: 'places', layerLabel: 'Yerler', label: 'Yeşil Alan', symbolKind: 'fill' },
  { id: 'school', layerId: 'places', layerLabel: 'Yerler', label: 'İlköğretim', symbolKind: 'marker' },
];

const rows = (model: LegendPanelModel) => model.snapshot.groups.flatMap((group) => group.rows);

describe('LegendPanelModel', () => {
  it('groups legend rows deterministically and exposes tree-independent ARIA set facts', () => {
    const model = new LegendPanelModel({ items });
    expect(model.snapshot.groups.map((group) => group.layerId)).toEqual(['roads', 'places']);
    expect(model.snapshot.groups[0]?.rows.map((row) => row.positionInSet)).toEqual([1, 2]);
    expect(model.snapshot.groups[0]?.rows.every((row) => row.setSize === 4)).toBe(true);
    expect(model.snapshot.totalCount).toBe(4);
  });

  it('uses one roving tab stop across expanded visible rows', () => {
    const model = new LegendPanelModel({ items });
    expect(rows(model).filter((row) => row.tabIndex === 0)).toHaveLength(1);
    expect(model.snapshot.focusedId).toBe('road-primary');
    model.focusNext();
    expect(model.snapshot.focusedId).toBe('road-local');
    model.focusPrevious();
    expect(model.snapshot.focusedId).toBe('road-primary');
  });

  it('wraps keyboard focus and supports first/last navigation', () => {
    const model = new LegendPanelModel({ items });
    model.focusPrevious();
    expect(model.snapshot.focusedId).toBe('school');
    model.focusNext();
    expect(model.snapshot.focusedId).toBe('road-primary');
    model.focusLast();
    expect(model.snapshot.focusedId).toBe('school');
    model.focusFirst();
    expect(model.snapshot.focusedId).toBe('road-primary');
  });

  it('repairs focus when a layer group collapses', () => {
    const model = new LegendPanelModel({ items });
    model.focus('road-local');
    model.toggleLayer('roads');
    expect(model.snapshot.focusedId).toBe('park');
    expect(model.snapshot.groups[0]?.expanded).toBe(false);
  });

  it('can collapse and expand every layer without losing selection', () => {
    const model = new LegendPanelModel({ items });
    model.select('park');
    model.collapseAll();
    expect(model.snapshot.groups.every((group) => !group.expanded)).toBe(true);
    expect(model.snapshot.selectedId).toBe('park');
    expect(model.snapshot.focusedId).toBeUndefined();
    model.expandAll();
    expect(model.snapshot.groups.every((group) => group.expanded)).toBe(true);
  });

  it('filters Turkish labels and descriptions with normalized casing', () => {
    const model = new LegendPanelModel({ items });
    model.setQuery('ilköĞRETİM');
    expect(rows(model).map((row) => row.id)).toEqual(['school']);
    expect(model.snapshot.groups.map((group) => group.layerId)).toEqual(['places']);
    model.setQuery('ulaşım');
    expect(rows(model).map((row) => row.id)).toEqual(['road-primary']);
  });

  it('keeps matching rows discoverable while their layer is normally collapsed', () => {
    const model = new LegendPanelModel({ items, initialExpandedLayerIds: [] });
    expect(model.snapshot.groups.every((group) => !group.expanded)).toBe(true);
    model.setQuery('yeşil');
    expect(model.snapshot.groups[0]?.expanded).toBe(true);
    expect(rows(model).map((row) => row.id)).toEqual(['park']);
  });

  it('distinguishes no legend, no search results and out-of-scale states', () => {
    expect(new LegendPanelModel({ items: [] }).snapshot.emptyReason).toBe('no-legend');
    const model = new LegendPanelModel({ items: items.slice(0, 2) });
    model.setQuery('bulunmaz');
    expect(model.snapshot.emptyReason).toBe('no-results');
    model.clearQuery();
    model.setScale(500_000);
    expect(model.snapshot.emptyReason).toBe('out-of-scale');
  });

  it('applies scale visibility without mutating source visibility', () => {
    const model = new LegendPanelModel({ items, initialScale: 50_000 });
    expect(rows(model).find((row) => row.id === 'road-primary')?.inScale).toBe(true);
    expect(rows(model).find((row) => row.id === 'road-local')?.inScale).toBe(false);
    expect(rows(model).find((row) => row.id === 'road-local')?.visible).toBe(true);
    model.setScale(10_000);
    expect(rows(model).find((row) => row.id === 'road-local')?.inScale).toBe(true);
  });

  it('repairs focus when scale makes the focused symbol unavailable', () => {
    const model = new LegendPanelModel({ items, initialScale: 10_000 });
    model.focus('road-local');
    model.setScale(50_000);
    expect(model.snapshot.focusedId).not.toBe('road-local');
  });

  it('ignores invalid selection and focus requests', () => {
    const model = new LegendPanelModel({ items });
    const revision = model.snapshot.revision;
    model.focus('missing');
    model.select('missing');
    expect(model.snapshot.revision).toBe(revision);
  });

  it('does not select disabled or out-of-scale rows', () => {
    const model = new LegendPanelModel({ items: [{ ...items[0]!, disabled: true }, items[1]!] });
    model.select('road-primary');
    expect(model.snapshot.selectedId).toBeUndefined();
    model.setScale(50_000);
    model.select('road-local');
    expect(model.snapshot.selectedId).toBeUndefined();
  });

  it('provides coarse pointer, density, reduced-motion and forced-colors presentation facts', () => {
    const coarse = new LegendPanelModel({ items, preferences: { coarsePointer: true, reducedMotion: true, forcedColors: true } });
    expect(rows(coarse).every((row) => row.targetSize === 48)).toBe(true);
    expect(coarse.snapshot.reducedMotion).toBe(true);
    expect(coarse.snapshot.forcedColors).toBe(true);
    const compact = new LegendPanelModel({ items, preferences: { density: 'compact' } });
    expect(rows(compact).every((row) => row.targetSize === 36)).toBe(true);
  });

  it('announces search, selection and disclosure changes', () => {
    const announce = vi.fn();
    const model = new LegendPanelModel({ items, onAnnouncement: announce });
    model.setQuery('yol');
    model.clearQuery();
    model.select('park');
    model.toggleLayer('places');
    expect(announce).toHaveBeenCalledTimes(4);
    expect(announce.mock.calls[0]?.[0].message).toContain('sonucu');
    expect(announce.mock.calls[2]?.[0].message).toContain('seçildi');
  });

  it('isolates observer failures and reports them without breaking later observers', () => {
    const onObserverError = vi.fn();
    const healthy = vi.fn();
    const model = new LegendPanelModel({ items, onObserverError });
    model.subscribe(() => { throw new Error('observer'); });
    model.subscribe(healthy);
    model.setQuery('yol');
    expect(onObserverError).toHaveBeenCalled();
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  it('isolates announcement and reporter failures from interaction state', () => {
    const model = new LegendPanelModel({
      items,
      onAnnouncement: () => { throw new Error('announcement'); },
      onObserverError: () => { throw new Error('reporter'); },
    });
    expect(() => model.select('park')).not.toThrow();
    expect(model.snapshot.selectedId).toBe('park');
  });

  it('returns immutable snapshot collections', () => {
    const model = new LegendPanelModel({ items });
    expect(Object.isFrozen(model.snapshot)).toBe(true);
    expect(Object.isFrozen(model.snapshot.groups)).toBe(true);
    expect(Object.isFrozen(model.snapshot.groups[0])).toBe(true);
    expect(Object.isFrozen(model.snapshot.groups[0]?.rows)).toBe(true);
  });

  it('rejects duplicate ids, conflicting labels, invalid scales and excessive input', () => {
    expect(() => new LegendPanelModel({ items: [items[0]!, items[0]!] })).toThrow(/Duplicate/);
    expect(() => new LegendPanelModel({ items: [items[0]!, { ...items[1]!, layerLabel: 'Başka' }] })).toThrow(/Conflicting/);
    expect(() => new LegendPanelModel({ items: [{ ...items[0]!, scaleMin: -1 }] })).toThrow(/scaleMin/);
    expect(() => new LegendPanelModel({ items: [{ ...items[0]!, scaleMin: 20, scaleMax: 10 }] })).toThrow(/scaleMin/);
    expect(() => new LegendPanelModel({ items: Array.from({ length: 2_001 }, (_, index) => ({ ...items[0]!, id: `id-${index}` })) })).toThrow(/2000/);
  });

  it('rejects blank required identity fields', () => {
    expect(() => new LegendPanelModel({ items: [{ ...items[0]!, id: ' ' }] })).toThrow(/non-empty/);
    expect(() => new LegendPanelModel({ items: [{ ...items[0]!, layerId: ' ' }] })).toThrow(/non-empty/);
    expect(() => new LegendPanelModel({ items: [{ ...items[0]!, label: ' ' }] })).toThrow(/non-empty/);
  });
});
