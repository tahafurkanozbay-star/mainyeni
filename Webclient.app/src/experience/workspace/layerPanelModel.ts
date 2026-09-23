export type LayerNodeKind = 'group' | 'layer';
export type LayerPanelDensity = 'comfortable' | 'compact';
export type LayerPanelStatus = 'ready' | 'loading' | 'error';

export interface LayerNodeInput {
  readonly id: string;
  readonly label: string;
  readonly kind: LayerNodeKind;
  readonly parentId?: string;
  readonly visible?: boolean;
  readonly disabled?: boolean;
  readonly children?: readonly string[];
  readonly status?: LayerPanelStatus;
  readonly errorMessage?: string;
}

export interface LayerPanelPreferences {
  readonly density?: LayerPanelDensity;
  readonly coarsePointer?: boolean;
  readonly reducedMotion?: boolean;
  readonly forcedColors?: boolean;
}

export interface LayerPanelRow {
  readonly id: string;
  readonly label: string;
  readonly kind: LayerNodeKind;
  readonly level: number;
  readonly positionInSet: number;
  readonly setSize: number;
  readonly expanded: boolean | undefined;
  readonly visible: boolean;
  readonly disabled: boolean;
  readonly status: LayerPanelStatus;
  readonly errorMessage: string | undefined;
  readonly tabIndex: 0 | -1;
  readonly selected: boolean;
  readonly match: boolean;
  readonly targetSize: number;
}

export interface LayerPanelSnapshot {
  readonly revision: number;
  readonly rows: readonly LayerPanelRow[];
  readonly focusedId: string | undefined;
  readonly selectedId: string | undefined;
  readonly query: string;
  readonly resultCount: number;
  readonly totalCount: number;
  readonly density: LayerPanelDensity;
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
  readonly emptyReason: 'none' | 'no-layers' | 'no-results';
}

export interface LayerPanelAnnouncement {
  readonly message: string;
  readonly priority: 'polite' | 'assertive';
}

export interface LayerPanelOptions {
  readonly nodes: readonly LayerNodeInput[];
  readonly preferences?: LayerPanelPreferences;
  readonly initialExpandedIds?: readonly string[];
  readonly initialSelectedId?: string;
  readonly onAnnouncement?: (announcement: LayerPanelAnnouncement) => void;
  readonly onObserverError?: (error: unknown) => void;
}

type Listener = (snapshot: LayerPanelSnapshot) => void;

interface LayerNode {
  readonly id: string;
  readonly label: string;
  readonly normalizedLabel: string;
  readonly kind: LayerNodeKind;
  readonly parentId: string | undefined;
  readonly children: readonly string[];
  readonly disabled: boolean;
  readonly status: LayerPanelStatus;
  readonly errorMessage: string | undefined;
  visible: boolean;
}

const normalize = (value: string): string =>
  value.trim().toLocaleLowerCase('tr-TR').replaceAll('ı', 'i');

const safeCall = (
  callback: ((value: never) => void) | undefined,
  value: never,
  report: ((error: unknown) => void) | undefined,
): void => {
  if (!callback) return;
  try {
    callback(value);
  } catch (error) {
    if (!report) return;
    try {
      report(error);
    } catch {
      // Observer reporting is deliberately isolated from interaction state.
    }
  }
};

export class LayerPanelModel {
  readonly #nodes = new Map<string, LayerNode>();
  readonly #roots: readonly string[];
  readonly #expanded = new Set<string>();
  readonly #listeners = new Set<Listener>();
  readonly #onAnnouncement: ((announcement: LayerPanelAnnouncement) => void) | undefined;
  readonly #onObserverError: ((error: unknown) => void) | undefined;
  readonly #density: LayerPanelDensity;
  readonly #targetSize: number;
  readonly #reducedMotion: boolean;
  readonly #forcedColors: boolean;
  #focusedId: string | undefined;
  #selectedId: string | undefined;
  #query = '';
  #revision = 0;
  #snapshot: LayerPanelSnapshot;

  constructor(options: LayerPanelOptions) {
    if (options.nodes.length > 2_000) {
      throw new RangeError('Layer panel supports at most 2000 nodes.');
    }

    for (const input of options.nodes) {
      const id = input.id.trim();
      const label = input.label.trim();
      if (!id || !label) throw new Error('Layer ids and labels must be non-empty.');
      if (this.#nodes.has(id)) throw new Error(`Duplicate layer id: ${id}`);
      this.#nodes.set(id, {
        id,
        label,
        normalizedLabel: normalize(label),
        kind: input.kind,
        parentId: input.parentId?.trim() || undefined,
        children: Object.freeze([...(input.children ?? [])]),
        visible: input.visible ?? true,
        disabled: input.disabled ?? false,
        status: input.status ?? 'ready',
        errorMessage: input.errorMessage,
      });
    }

    this.#validateGraph();
    this.#roots = Object.freeze(
      [...this.#nodes.values()].filter((node) => node.parentId === undefined).map((node) => node.id),
    );
    this.#density = options.preferences?.density ?? 'comfortable';
    this.#targetSize = options.preferences?.coarsePointer === true ? 48 : this.#density === 'compact' ? 36 : 40;
    this.#reducedMotion = options.preferences?.reducedMotion ?? false;
    this.#forcedColors = options.preferences?.forcedColors ?? false;
    this.#onAnnouncement = options.onAnnouncement;
    this.#onObserverError = options.onObserverError;

    for (const id of options.initialExpandedIds ?? []) {
      if (this.#nodes.get(id)?.kind === 'group') this.#expanded.add(id);
    }
    if (options.initialSelectedId && this.#nodes.has(options.initialSelectedId)) {
      this.#selectedId = options.initialSelectedId;
    }
    this.#snapshot = this.#buildSnapshot();
    this.#focusedId = this.#snapshot.rows.find((row) => !row.disabled)?.id;
    this.#snapshot = this.#buildSnapshot();
  }

  get snapshot(): LayerPanelSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    this.#notifyOne(listener);
    return () => this.#listeners.delete(listener);
  }

  setQuery(query: string): void {
    const next = query.trim();
    if (next === this.#query) return;
    this.#query = next;
    this.#repairFocus();
    this.#commit();
    const count = this.#snapshot.resultCount;
    this.#announce(
      next ? `${count} katman sonucu bulundu.` : `${this.#snapshot.totalCount} katman gösteriliyor.`,
      'polite',
    );
  }

  clearQuery(): void {
    this.setQuery('');
  }

  toggleExpanded(id: string): void {
    const node = this.#nodes.get(id);
    if (!node || node.kind !== 'group' || node.disabled) return;
    if (this.#expanded.has(id)) this.#expanded.delete(id);
    else this.#expanded.add(id);
    this.#repairFocus();
    this.#commit();
    this.#announce(`${node.label} ${this.#expanded.has(id) ? 'genişletildi' : 'daraltıldı'}.`, 'polite');
  }

  expand(id: string): void {
    const node = this.#nodes.get(id);
    if (!node || node.kind !== 'group' || node.disabled || this.#expanded.has(id)) return;
    this.#expanded.add(id);
    this.#commit();
  }

  collapse(id: string): void {
    if (!this.#expanded.delete(id)) return;
    this.#repairFocus();
    this.#commit();
  }

  select(id: string): void {
    const node = this.#nodes.get(id);
    if (!node || node.disabled || this.#selectedId === id) return;
    this.#selectedId = id;
    this.#focusedId = id;
    this.#commit();
    this.#announce(`${node.label} seçildi.`, 'polite');
  }

  toggleVisibility(id: string): void {
    const node = this.#nodes.get(id);
    if (!node || node.disabled || node.status === 'loading') return;
    node.visible = !node.visible;
    this.#commit();
    this.#announce(`${node.label} ${node.visible ? 'görünür' : 'gizli'}.`, 'polite');
  }

  focus(id: string): void {
    if (!this.#snapshot.rows.some((row) => row.id === id && !row.disabled)) return;
    if (this.#focusedId === id) return;
    this.#focusedId = id;
    this.#commit();
  }

  focusNext(): void {
    this.#moveFocus(1);
  }

  focusPrevious(): void {
    this.#moveFocus(-1);
  }

  focusFirst(): void {
    this.#focusBoundary(false);
  }

  focusLast(): void {
    this.#focusBoundary(true);
  }

  focusParent(): void {
    const focused = this.#focusedId ? this.#nodes.get(this.#focusedId) : undefined;
    if (!focused?.parentId) return;
    this.focus(focused.parentId);
  }

  focusFirstChild(): void {
    const focused = this.#focusedId ? this.#nodes.get(this.#focusedId) : undefined;
    if (!focused || focused.kind !== 'group') return;
    if (!this.#expanded.has(focused.id)) {
      this.#expanded.add(focused.id);
      this.#commit();
    }
    const child = focused.children
      .map((id) => this.#nodes.get(id))
      .find((node) => node !== undefined && !node.disabled);
    if (child) this.focus(child.id);
  }

  #moveFocus(delta: 1 | -1): void {
    const enabled = this.#snapshot.rows.filter((row) => !row.disabled);
    if (enabled.length === 0) return;
    const index = enabled.findIndex((row) => row.id === this.#focusedId);
    const start = index < 0 ? (delta === 1 ? -1 : 0) : index;
    const nextIndex = (start + delta + enabled.length) % enabled.length;
    const next = enabled[nextIndex];
    if (next) this.focus(next.id);
  }

  #focusBoundary(last: boolean): void {
    const enabled = this.#snapshot.rows.filter((row) => !row.disabled);
    const target = last ? enabled.at(-1) : enabled[0];
    if (target) this.focus(target.id);
  }

  #repairFocus(): void {
    const rows = this.#computeRows();
    if (rows.some((row) => row.id === this.#focusedId && !row.disabled)) return;
    this.#focusedId = rows.find((row) => !row.disabled)?.id;
  }

  #computeRows(): LayerPanelRow[] {
    const query = normalize(this.#query);
    const matched = new Set<string>();
    if (query) {
      for (const node of this.#nodes.values()) {
        if (!node.normalizedLabel.includes(query)) continue;
        matched.add(node.id);
        let parentId = node.parentId;
        while (parentId) {
          matched.add(parentId);
          parentId = this.#nodes.get(parentId)?.parentId;
        }
      }
    }

    const rows: LayerPanelRow[] = [];
    const visit = (id: string, level: number, positionInSet: number, setSize: number): void => {
      const node = this.#nodes.get(id);
      if (!node || (query && !matched.has(id))) return;
      const isMatch = !query || node.normalizedLabel.includes(query);
      rows.push({
        id: node.id,
        label: node.label,
        kind: node.kind,
        level,
        positionInSet,
        setSize,
        expanded: node.kind === 'group' ? this.#expanded.has(node.id) || Boolean(query) : undefined,
        visible: node.visible,
        disabled: node.disabled,
        status: node.status,
        errorMessage: node.errorMessage,
        tabIndex: node.id === this.#focusedId ? 0 : -1,
        selected: node.id === this.#selectedId,
        match: isMatch,
        targetSize: this.#targetSize,
      });
      if (node.kind !== 'group' || (!this.#expanded.has(node.id) && !query)) return;
      node.children.forEach((childId, index) => visit(childId, level + 1, index + 1, node.children.length));
    };
    this.#roots.forEach((id, index) => visit(id, 1, index + 1, this.#roots.length));
    return rows;
  }

  #buildSnapshot(): LayerPanelSnapshot {
    const rows = Object.freeze(this.#computeRows());
    const directMatches = this.#query
      ? rows.filter((row) => row.match).length
      : this.#nodes.size;
    const emptyReason = this.#nodes.size === 0 ? 'no-layers' : directMatches === 0 ? 'no-results' : 'none';
    return Object.freeze({
      revision: this.#revision,
      rows,
      focusedId: this.#focusedId,
      selectedId: this.#selectedId,
      query: this.#query,
      resultCount: directMatches,
      totalCount: this.#nodes.size,
      density: this.#density,
      reducedMotion: this.#reducedMotion,
      forcedColors: this.#forcedColors,
      emptyReason,
    });
  }

  #commit(): void {
    this.#revision += 1;
    this.#snapshot = this.#buildSnapshot();
    for (const listener of this.#listeners) this.#notifyOne(listener);
  }

  #notifyOne(listener: Listener): void {
    try {
      listener(this.#snapshot);
    } catch (error) {
      if (!this.#onObserverError) return;
      try {
        this.#onObserverError(error);
      } catch {
        // Error reporting cannot break layer interaction state.
      }
    }
  }

  #announce(message: string, priority: LayerPanelAnnouncement['priority']): void {
    if (!this.#onAnnouncement) return;
    try {
      this.#onAnnouncement({ message, priority });
    } catch (error) {
      if (!this.#onObserverError) return;
      try {
        this.#onObserverError(error);
      } catch {
        // Announcement adapters are optional observers.
      }
    }
  }

  #validateGraph(): void {
    for (const node of this.#nodes.values()) {
      if (node.parentId && !this.#nodes.has(node.parentId)) {
        throw new Error(`Unknown parent ${node.parentId} for ${node.id}.`);
      }
      if (node.kind === 'layer' && node.children.length > 0) {
        throw new Error(`Layer ${node.id} cannot contain children.`);
      }
      for (const childId of node.children) {
        const child = this.#nodes.get(childId);
        if (!child) throw new Error(`Unknown child ${childId} for ${node.id}.`);
        if (child.parentId !== node.id) throw new Error(`Parent/child mismatch for ${childId}.`);
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error(`Layer tree contains a cycle at ${id}.`);
      if (visited.has(id)) return;
      visiting.add(id);
      const node = this.#nodes.get(id);
      node?.children.forEach(visit);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of this.#nodes.keys()) visit(id);
  }
}
