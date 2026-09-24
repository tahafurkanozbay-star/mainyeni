export interface DisclosureTreeNodeInput {
  readonly id: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly hidden?: boolean;
  readonly children?: readonly DisclosureTreeNodeInput[];
}

export interface DisclosureTreeItem {
  readonly id: string;
  readonly label: string;
  readonly level: number;
  readonly parentId: string | null;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly disabled: boolean;
  readonly selected: boolean;
  readonly active: boolean;
  readonly positionInSet: number;
  readonly setSize: number;
}

export interface DisclosureTreeSnapshot {
  readonly items: readonly DisclosureTreeItem[];
  readonly activeId: string | null;
  readonly selectedIds: readonly string[];
  readonly expandedIds: readonly string[];
  readonly visibleCount: number;
  readonly revision: number;
}

export interface DisclosureTreeModelOptions {
  readonly nodes: readonly DisclosureTreeNodeInput[];
  readonly expandedIds?: readonly string[];
  readonly selectedIds?: readonly string[];
  readonly activeId?: string | null;
  readonly selectionMode?: 'single' | 'multiple';
  readonly onObserverError?: (error: unknown) => void;
}

export interface DisclosureTreeModel {
  snapshot(): DisclosureTreeSnapshot;
  setNodes(nodes: readonly DisclosureTreeNodeInput[]): void;
  toggleExpanded(id: string): boolean;
  setExpanded(id: string, expanded: boolean): boolean;
  collapseAll(): void;
  expandTo(id: string): boolean;
  setActive(id: string | null): boolean;
  moveActive(direction: 'next' | 'previous' | 'first' | 'last' | 'parent' | 'child'): string | null;
  typeahead(query: string): string | null;
  toggleSelected(id: string): boolean;
  clearSelection(): void;
  subscribe(observer: (snapshot: DisclosureTreeSnapshot) => void): () => void;
}

interface InternalNode {
  readonly id: string;
  readonly label: string;
  readonly normalizedLabel: string;
  readonly parentId: string | null;
  readonly childIds: readonly string[];
  readonly disabled: boolean;
  readonly hidden: boolean;
  readonly depth: number;
  readonly siblingIndex: number;
  readonly siblingCount: number;
}

interface TreeStructure {
  readonly nodes: Map<string, InternalNode>;
  readonly rootIds: readonly string[];
}

const MAX_NODES = 2_000;
const MAX_DEPTH = 12;
const MAX_LABEL = 240;

const normalizeSearch = (value: string): string =>
  value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ');

const cleanId = (value: string): string => {
  const id = value.trim();
  if (!id) throw new Error('Tree node id is required.');
  return id;
};

const cleanLabel = (value: string): string => {
  const label = value.trim().replace(/\s+/g, ' ');
  if (!label) throw new Error('Tree node label is required.');
  return label.slice(0, MAX_LABEL);
};

const requiredNode = (structure: TreeStructure, id: string): InternalNode => {
  const node = structure.nodes.get(id);
  if (!node) throw new Error(`Unknown tree node: ${id}`);
  return node;
};

const buildTree = (inputs: readonly DisclosureTreeNodeInput[]): TreeStructure => {
  const nodes = new Map<string, InternalNode>();
  const seen = new Set<string>();
  let count = 0;

  const visit = (
    input: DisclosureTreeNodeInput,
    parentId: string | null,
    depth: number,
    siblingIndex: number,
    siblingCount: number,
  ): string => {
    count += 1;
    if (count > MAX_NODES) throw new Error(`Tree node capacity exceeded (${MAX_NODES}).`);
    if (depth > MAX_DEPTH) throw new Error(`Tree depth capacity exceeded (${MAX_DEPTH}).`);
    const id = cleanId(input.id);
    if (seen.has(id)) throw new Error(`Duplicate tree node id: ${id}`);
    seen.add(id);
    const label = cleanLabel(input.label);
    const children = input.children ?? [];
    const childIds = children.map((child, index) => visit(child, id, depth + 1, index, children.length));
    nodes.set(id, Object.freeze({
      id,
      label,
      normalizedLabel: normalizeSearch(label),
      parentId,
      childIds: Object.freeze(childIds),
      disabled: input.disabled === true,
      hidden: input.hidden === true,
      depth,
      siblingIndex,
      siblingCount,
    }));
    return id;
  };

  return {
    nodes,
    rootIds: Object.freeze(inputs.map((input, index) => visit(input, null, 1, index, inputs.length))),
  };
};

export const createDisclosureTreeModel = (options: DisclosureTreeModelOptions): DisclosureTreeModel => {
  let structure = buildTree(options.nodes);
  const selectionMode = options.selectionMode ?? 'single';
  const observers = new Set<(snapshot: DisclosureTreeSnapshot) => void>();
  const expanded = new Set((options.expandedIds ?? []).filter((id) => structure.nodes.has(id)));
  const selected = new Set((options.selectedIds ?? []).filter((id) => structure.nodes.has(id)));
  let activeId = options.activeId && structure.nodes.has(options.activeId) ? options.activeId : null;
  let revision = 0;

  if (selectionMode === 'single' && selected.size > 1) {
    const first = selected.values().next().value as string | undefined;
    selected.clear();
    if (first) selected.add(first);
  }

  const report = (error: unknown): void => {
    const reporter = options.onObserverError;
    if (!reporter) return;
    try {
      reporter(error);
    } catch (reporterError) {
      void reporterError;
    }
  };

  const visibleIds = (): string[] => {
    const result: string[] = [];
    const append = (ids: readonly string[]): void => {
      ids.forEach((id) => {
        const node = structure.nodes.get(id);
        if (!node || node.hidden) return;
        result.push(id);
        if (node.childIds.length > 0 && expanded.has(id)) append(node.childIds);
      });
    };
    append(structure.rootIds);
    return result;
  };

  const nearestEnabled = (ids: readonly string[], start: number, step: 1 | -1): string | null => {
    for (let index = start; index >= 0 && index < ids.length; index += step) {
      const id = ids[index];
      const node = id ? structure.nodes.get(id) : undefined;
      if (node && !node.disabled && !node.hidden) return node.id;
    }
    return null;
  };

  const reconcile = (): void => {
    Array.from(expanded).forEach((id) => {
      const node = structure.nodes.get(id);
      if (!node || node.childIds.length === 0) expanded.delete(id);
    });
    Array.from(selected).forEach((id) => {
      const node = structure.nodes.get(id);
      if (!node || node.disabled || node.hidden) selected.delete(id);
    });
    const visible = visibleIds();
    if (activeId) {
      const active = structure.nodes.get(activeId);
      if (!active || active.hidden || active.disabled || !visible.includes(activeId)) activeId = null;
    }
    if (!activeId) activeId = nearestEnabled(visible, 0, 1);
  };

  const buildSnapshot = (): DisclosureTreeSnapshot => {
    const ids = visibleIds();
    const items = ids.map((id) => {
      const node = requiredNode(structure, id);
      return Object.freeze({
        id: node.id,
        label: node.label,
        level: node.depth,
        parentId: node.parentId,
        expandable: node.childIds.length > 0,
        expanded: expanded.has(id),
        disabled: node.disabled,
        selected: selected.has(id),
        active: activeId === id,
        positionInSet: node.siblingIndex + 1,
        setSize: node.siblingCount,
      });
    });
    return Object.freeze({
      items: Object.freeze(items),
      activeId,
      selectedIds: Object.freeze(ids.filter((id) => selected.has(id))),
      expandedIds: Object.freeze(Array.from(expanded).filter((id) => structure.nodes.has(id)).sort()),
      visibleCount: items.length,
      revision,
    });
  };

  const notify = (): void => {
    revision += 1;
    const snapshot = buildSnapshot();
    observers.forEach((observer) => {
      try {
        observer(snapshot);
      } catch (error) {
        report(error);
      }
    });
  };

  const setActiveInternal = (id: string | null): boolean => {
    if (id === null) {
      if (activeId === null) return false;
      activeId = null;
      return true;
    }
    const node = structure.nodes.get(id);
    if (!node || node.disabled || node.hidden || !visibleIds().includes(id) || activeId === id) return false;
    activeId = id;
    return true;
  };

  reconcile();

  return {
    snapshot: buildSnapshot,
    setNodes(nodes) {
      structure = buildTree(nodes);
      reconcile();
      notify();
    },
    toggleExpanded(id) {
      const node = requiredNode(structure, id);
      if (node.childIds.length === 0 || node.disabled || node.hidden) return false;
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      reconcile();
      notify();
      return true;
    },
    setExpanded(id, value) {
      const node = requiredNode(structure, id);
      if (node.childIds.length === 0 || node.disabled || node.hidden || expanded.has(id) === value) return false;
      if (value) expanded.add(id);
      else expanded.delete(id);
      reconcile();
      notify();
      return true;
    },
    collapseAll() {
      if (expanded.size === 0) return;
      expanded.clear();
      reconcile();
      notify();
    },
    expandTo(id) {
      const node = structure.nodes.get(id);
      if (!node || node.hidden) return false;
      let parentId = node.parentId;
      let changed = false;
      while (parentId) {
        if (!expanded.has(parentId)) {
          expanded.add(parentId);
          changed = true;
        }
        parentId = structure.nodes.get(parentId)?.parentId ?? null;
      }
      if (changed) notify();
      return changed;
    },
    setActive(id) {
      const changed = setActiveInternal(id);
      if (changed) notify();
      return changed;
    },
    moveActive(direction) {
      const ids = visibleIds();
      if (ids.length === 0) return null;
      const currentIndex = activeId ? ids.indexOf(activeId) : -1;
      let next: string | null = null;
      if (direction === 'first') next = nearestEnabled(ids, 0, 1);
      else if (direction === 'last') next = nearestEnabled(ids, ids.length - 1, -1);
      else if (direction === 'next') next = nearestEnabled(ids, Math.max(0, currentIndex + 1), 1);
      else if (direction === 'previous') next = nearestEnabled(ids, currentIndex < 0 ? ids.length - 1 : currentIndex - 1, -1);
      else if (direction === 'parent' && activeId) {
        const current = requiredNode(structure, activeId);
        if (current.childIds.length > 0 && expanded.has(activeId)) {
          expanded.delete(activeId);
          notify();
          return activeId;
        }
        next = current.parentId;
      } else if (direction === 'child' && activeId) {
        const current = requiredNode(structure, activeId);
        if (current.childIds.length > 0 && !expanded.has(activeId)) {
          expanded.add(activeId);
          notify();
          return activeId;
        }
        next = current.childIds.find((id) => {
          const child = structure.nodes.get(id);
          return Boolean(child && !child.disabled && !child.hidden);
        }) ?? null;
      }
      if (next && setActiveInternal(next)) notify();
      return activeId;
    },
    typeahead(query) {
      const normalized = normalizeSearch(query);
      if (!normalized) return activeId;
      const ids = visibleIds();
      if (ids.length === 0) return null;
      const currentIndex = activeId ? ids.indexOf(activeId) : -1;
      const ordered = [...ids.slice(currentIndex + 1), ...ids.slice(0, currentIndex + 1)];
      const match = ordered.find((id) => {
        const node = structure.nodes.get(id);
        return Boolean(node && !node.disabled && !node.hidden && node.normalizedLabel.startsWith(normalized));
      }) ?? null;
      if (match && setActiveInternal(match)) notify();
      return activeId;
    },
    toggleSelected(id) {
      const node = requiredNode(structure, id);
      if (node.disabled || node.hidden) return false;
      if (selectionMode === 'single') {
        const alreadyOnlySelection = selected.size === 1 && selected.has(id);
        selected.clear();
        if (!alreadyOnlySelection) selected.add(id);
      } else if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      activeId = id;
      notify();
      return true;
    },
    clearSelection() {
      if (selected.size === 0) return;
      selected.clear();
      notify();
    },
    subscribe(observer) {
      observers.add(observer);
      try {
        observer(buildSnapshot());
      } catch (error) {
        report(error);
      }
      return () => observers.delete(observer);
    },
  };
};
