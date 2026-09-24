import { describe, expect, it, vi } from 'vitest';
import { createDisclosureTreeModel, type DisclosureTreeNodeInput } from './disclosureTreeModel';

const nodes: readonly DisclosureTreeNodeInput[] = [
  {
    id: 'transport',
    label: 'Ulaşım',
    children: [
      { id: 'roads', label: 'Yollar' },
      { id: 'rail', label: 'Raylı Sistem' },
      { id: 'disabled', label: 'Kapalı Katman', disabled: true },
    ],
  },
  {
    id: 'environment',
    label: 'Çevre',
    children: [
      { id: 'parks', label: 'Parklar' },
      {
        id: 'water',
        label: 'Su',
        children: [
          { id: 'streams', label: 'Dereler' },
          { id: 'lakes', label: 'Göller' },
        ],
      },
    ],
  },
  { id: 'hidden', label: 'Gizli', hidden: true },
];

describe('disclosureTreeModel', () => {
  it('starts with root nodes only when groups are collapsed', () => {
    const model = createDisclosureTreeModel({ nodes });
    const snapshot = model.snapshot();
    expect(snapshot.items.map((item) => item.id)).toEqual(['transport', 'environment']);
    expect(snapshot.activeId).toBe('transport');
    expect(snapshot.visibleCount).toBe(2);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.items)).toBe(true);
  });

  it('expands a group and exposes correct tree metadata', () => {
    const model = createDisclosureTreeModel({ nodes });
    expect(model.toggleExpanded('transport')).toBe(true);
    const items = model.snapshot().items;
    expect(items.map((item) => item.id)).toEqual(['transport', 'roads', 'rail', 'disabled', 'environment']);
    expect(items[1]).toMatchObject({ level: 2, parentId: 'transport', positionInSet: 1, setSize: 3 });
    expect(items[0]).toMatchObject({ expandable: true, expanded: true });
  });

  it('rejects expansion for leaves and unknown nodes', () => {
    const model = createDisclosureTreeModel({ nodes, expandedIds: ['transport'] });
    expect(model.toggleExpanded('roads')).toBe(false);
    expect(() => model.toggleExpanded('missing')).toThrow('Unknown tree node');
  });

  it('collapses all groups deterministically', () => {
    const model = createDisclosureTreeModel({ nodes, expandedIds: ['transport', 'environment', 'water'] });
    model.collapseAll();
    expect(model.snapshot().expandedIds).toEqual([]);
    expect(model.snapshot().items.map((item) => item.id)).toEqual(['transport', 'environment']);
  });

  it('expands every ancestor needed to reveal a target', () => {
    const model = createDisclosureTreeModel({ nodes });
    expect(model.expandTo('streams')).toBe(true);
    expect(model.snapshot().expandedIds).toEqual(['environment', 'water']);
    expect(model.snapshot().items.map((item) => item.id)).toContain('streams');
    expect(model.expandTo('streams')).toBe(false);
  });

  it('moves active item with next and previous semantics', () => {
    const model = createDisclosureTreeModel({ nodes, expandedIds: ['transport'] });
    expect(model.moveActive('next')).toBe('roads');
    expect(model.moveActive('next')).toBe('rail');
    expect(model.moveActive('next')).toBe('environment');
    expect(model.moveActive('previous')).toBe('rail');
  });

  it('skips disabled items during linear keyboard movement', () => {
    const model = createDisclosureTreeModel({ nodes, expandedIds: ['transport'], activeId: 'rail' });
    expect(model.moveActive('next')).toBe('environment');
    expect(model.setActive('disabled')).toBe(false);
    expect(model.snapshot().activeId).toBe('environment');
  });

  it('supports Home and End semantics', () => {
    const model = createDisclosureTreeModel({ nodes, expandedIds: ['transport'] });
    model.moveActive('last');
    expect(model.snapshot().activeId).toBe('environment');
    model.moveActive('first');
    expect(model.snapshot().activeId).toBe('transport');
  });

  it('uses Right semantics to expand and then enter the first enabled child', () => {
    const model = createDisclosureTreeModel({ nodes });
    expect(model.moveActive('child')).toBe('transport');
    expect(model.snapshot().expandedIds).toContain('transport');
    expect(model.moveActive('child')).toBe('roads');
  });

  it('uses Left semantics to collapse and then move to the parent', () => {
    const model = createDisclosureTreeModel({ nodes, expandedIds: ['transport'], activeId: 'transport' });
    expect(model.moveActive('parent')).toBe('transport');
    expect(model.snapshot().expandedIds).not.toContain('transport');
    model.setExpanded('transport', true);
    model.setActive('roads');
    expect(model.moveActive('parent')).toBe('transport');
  });

  it('performs Turkish-aware typeahead and wraps after the active node', () => {
    const turkishNodes: readonly DisclosureTreeNodeInput[] = [
      { id: 'ankara', label: 'Ankara' },
      { id: 'istanbul', label: 'İstanbul' },
      { id: 'izmir', label: 'İzmir' },
    ];
    const model = createDisclosureTreeModel({ nodes: turkishNodes, activeId: 'ankara' });
    expect(model.typeahead('ist')).toBe('istanbul');
    expect(model.typeahead('izm')).toBe('izmir');
    expect(model.typeahead('ank')).toBe('ankara');
  });

  it('keeps active state unchanged for an unmatched typeahead query', () => {
    const model = createDisclosureTreeModel({ nodes, activeId: 'environment' });
    expect(model.typeahead('bulunmuyor')).toBe('environment');
    expect(model.typeahead('   ')).toBe('environment');
  });

  it('supports single selection and toggles the same item off', () => {
    const model = createDisclosureTreeModel({ nodes, expandedIds: ['transport'], selectionMode: 'single' });
    model.toggleSelected('roads');
    expect(model.snapshot().selectedIds).toEqual(['roads']);
    model.toggleSelected('rail');
    expect(model.snapshot().selectedIds).toEqual(['rail']);
    model.toggleSelected('rail');
    expect(model.snapshot().selectedIds).toEqual([]);
  });

  it('supports multiple selection while preserving visible order', () => {
    const model = createDisclosureTreeModel({ nodes, expandedIds: ['transport'], selectionMode: 'multiple' });
    model.toggleSelected('rail');
    model.toggleSelected('roads');
    expect(model.snapshot().selectedIds).toEqual(['roads', 'rail']);
    model.toggleSelected('roads');
    expect(model.snapshot().selectedIds).toEqual(['rail']);
  });

  it('does not select disabled nodes', () => {
    const model = createDisclosureTreeModel({ nodes, expandedIds: ['transport'], selectionMode: 'multiple' });
    expect(model.toggleSelected('disabled')).toBe(false);
    expect(model.snapshot().selectedIds).toEqual([]);
  });

  it('clears selection only when there is state to change', () => {
    const model = createDisclosureTreeModel({ nodes, expandedIds: ['transport'] });
    const before = model.snapshot().revision;
    model.clearSelection();
    expect(model.snapshot().revision).toBe(before);
    model.toggleSelected('roads');
    model.clearSelection();
    expect(model.snapshot().selectedIds).toEqual([]);
  });

  it('reconciles active, selected, and expanded state when nodes change', () => {
    const model = createDisclosureTreeModel({
      nodes,
      expandedIds: ['transport'],
      selectedIds: ['roads'],
      activeId: 'roads',
    });
    model.setNodes([{ id: 'environment', label: 'Çevre' }]);
    expect(model.snapshot()).toMatchObject({
      activeId: 'environment',
      selectedIds: [],
      expandedIds: [],
      visibleCount: 1,
    });
  });

  it('validates duplicate ids, blank labels, capacity, and depth', () => {
    expect(() => createDisclosureTreeModel({ nodes: [{ id: 'x', label: 'X' }, { id: 'x', label: 'Y' }] })).toThrow('Duplicate');
    expect(() => createDisclosureTreeModel({ nodes: [{ id: 'x', label: ' ' }] })).toThrow('label is required');

    const tooMany = Array.from({ length: 2001 }, (_, index) => ({ id: `n-${index}`, label: `N ${index}` }));
    expect(() => createDisclosureTreeModel({ nodes: tooMany })).toThrow('capacity');

    let deep: DisclosureTreeNodeInput = { id: 'leaf', label: 'Leaf' };
    for (let index = 0; index < 13; index += 1) deep = { id: `level-${index}`, label: `Level ${index}`, children: [deep] };
    expect(() => createDisclosureTreeModel({ nodes: [deep] })).toThrow('depth');
  });

  it('notifies observers with immutable revisions and supports unsubscribe', () => {
    const observer = vi.fn();
    const model = createDisclosureTreeModel({ nodes });
    const unsubscribe = model.subscribe(observer);
    expect(observer).toHaveBeenCalledTimes(1);
    model.toggleExpanded('transport');
    expect(observer).toHaveBeenCalledTimes(2);
    expect(observer.mock.calls.at(-1)?.[0]).toMatchObject({ revision: 1 });
    unsubscribe();
    model.toggleExpanded('environment');
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it('reports observer failures without replacing the tree state', () => {
    const reporter = vi.fn();
    const model = createDisclosureTreeModel({ nodes, onObserverError: reporter });
    model.subscribe(() => { throw new Error('observer failed'); });
    expect(() => model.toggleExpanded('transport')).not.toThrow();
    expect(reporter).toHaveBeenCalled();
    expect(model.snapshot().expandedIds).toContain('transport');
  });

  it('survives diagnostic reporter failures', () => {
    const model = createDisclosureTreeModel({
      nodes,
      onObserverError: () => { throw new Error('reporter failed'); },
    });
    model.subscribe(() => { throw new Error('observer failed'); });
    expect(() => model.toggleExpanded('transport')).not.toThrow();
    expect(model.snapshot().expandedIds).toContain('transport');
  });

  it('does not activate hidden nodes', () => {
    const model = createDisclosureTreeModel({ nodes });
    expect(model.setActive('hidden')).toBe(false);
    expect(model.snapshot().items.some((item) => item.id === 'hidden')).toBe(false);
  });
});
