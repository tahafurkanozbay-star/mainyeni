export type LegendSymbolKind = 'fill' | 'line' | 'marker' | 'text' | 'raster';
export type LegendStatus = 'ready' | 'loading' | 'error';
export type LegendDensity = 'comfortable' | 'compact';

export interface LegendItemInput {
  readonly id: string;
  readonly layerId: string;
  readonly layerLabel: string;
  readonly label: string;
  readonly symbolKind: LegendSymbolKind;
  readonly description?: string;
  readonly visible?: boolean;
  readonly disabled?: boolean;
  readonly status?: LegendStatus;
  readonly errorMessage?: string;
  readonly scaleMin?: number;
  readonly scaleMax?: number;
}

export interface LegendPreferences {
  readonly density?: LegendDensity;
  readonly coarsePointer?: boolean;
  readonly reducedMotion?: boolean;
  readonly forcedColors?: boolean;
}

export interface LegendRow {
  readonly id: string;
  readonly layerId: string;
  readonly layerLabel: string;
  readonly label: string;
  readonly description: string | undefined;
  readonly symbolKind: LegendSymbolKind;
  readonly visible: boolean;
  readonly disabled: boolean;
  readonly status: LegendStatus;
  readonly errorMessage: string | undefined;
  readonly inScale: boolean;
  readonly match: boolean;
  readonly tabIndex: 0 | -1;
  readonly selected: boolean;
  readonly targetSize: number;
  readonly positionInSet: number;
  readonly setSize: number;
}

export interface LegendLayerGroup {
  readonly layerId: string;
  readonly label: string;
  readonly expanded: boolean;
  readonly visibleCount: number;
  readonly totalCount: number;
  readonly rows: readonly LegendRow[];
}

export interface LegendSnapshot {
  readonly revision: number;
  readonly groups: readonly LegendLayerGroup[];
  readonly focusedId: string | undefined;
  readonly selectedId: string | undefined;
  readonly query: string;
  readonly scale: number | undefined;
  readonly resultCount: number;
  readonly totalCount: number;
  readonly emptyReason: 'none' | 'no-legend' | 'no-results' | 'out-of-scale';
  readonly density: LegendDensity;
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
}

export interface LegendAnnouncement {
  readonly message: string;
  readonly priority: 'polite' | 'assertive';
}

export interface LegendPanelOptions {
  readonly items: readonly LegendItemInput[];
  readonly preferences?: LegendPreferences;
  readonly initialExpandedLayerIds?: readonly string[];
  readonly initialSelectedId?: string;
  readonly initialScale?: number;
  readonly onAnnouncement?: (announcement: LegendAnnouncement) => void;
  readonly onObserverError?: (error: unknown) => void;
}

type Listener = (snapshot: LegendSnapshot) => void;

interface LegendItem {
  readonly id: string;
  readonly layerId: string;
  readonly layerLabel: string;
  readonly label: string;
  readonly normalizedSearch: string;
  readonly description: string | undefined;
  readonly symbolKind: LegendSymbolKind;
  readonly visible: boolean;
  readonly disabled: boolean;
  readonly status: LegendStatus;
  readonly errorMessage: string | undefined;
  readonly scaleMin: number | undefined;
  readonly scaleMax: number | undefined;
}

const normalize = (value: string): string =>
  value.trim().toLocaleLowerCase('tr-TR').replaceAll('ı', 'i');

const validScale = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0;

const isInScale = (item: LegendItem, scale: number | undefined): boolean => {
  if (!validScale(scale)) return true;
  if (item.scaleMin !== undefined && scale < item.scaleMin) return false;
  if (item.scaleMax !== undefined && scale > item.scaleMax) return false;
  return true;
};

export class LegendPanelModel {
  readonly #items: readonly LegendItem[];
  readonly #itemsById = new Map<string, LegendItem>();
  readonly #layerOrder: readonly string[];
  readonly #layerLabels = new Map<string, string>();
  readonly #expanded = new Set<string>();
  readonly #listeners = new Set<Listener>();
  readonly #onAnnouncement: ((announcement: LegendAnnouncement) => void) | undefined;
  readonly #onObserverError: ((error: unknown) => void) | undefined;
  readonly #density: LegendDensity;
  readonly #targetSize: number;
  readonly #reducedMotion: boolean;
  readonly #forcedColors: boolean;
  #query = '';
  #scale: number | undefined;
  #focusedId: string | undefined;
  #selectedId: string | undefined;
  #revision = 0;
  #snapshot: LegendSnapshot;

  constructor(options: LegendPanelOptions) {
    if (options.items.length > 2_000) throw new RangeError('Legend supports at most 2000 items.');
    const layerOrder: string[] = [];
    const items: LegendItem[] = [];

    for (const input of options.items) {
      const id = input.id.trim();
      const layerId = input.layerId.trim();
      const layerLabel = input.layerLabel.trim();
      const label = input.label.trim();
      if (!id || !layerId || !layerLabel || !label) throw new Error('Legend ids and labels must be non-empty.');
      if (this.#itemsById.has(id)) throw new Error(`Duplicate legend item id: ${id}`);
      if (input.scaleMin !== undefined && !validScale(input.scaleMin)) throw new RangeError('scaleMin must be positive.');
      if (input.scaleMax !== undefined && !validScale(input.scaleMax)) throw new RangeError('scaleMax must be positive.');
      if (input.scaleMin !== undefined && input.scaleMax !== undefined && input.scaleMin > input.scaleMax) {
        throw new RangeError('scaleMin cannot exceed scaleMax.');
      }
      const description = input.description?.trim() || undefined;
      const item: LegendItem = Object.freeze({
        id,
        layerId,
        layerLabel,
        label,
        normalizedSearch: normalize(`${layerLabel} ${label} ${description ?? ''}`),
        description,
        symbolKind: input.symbolKind,
        visible: input.visible ?? true,
        disabled: input.disabled ?? false,
        status: input.status ?? 'ready',
        errorMessage: input.errorMessage?.trim() || undefined,
        scaleMin: input.scaleMin,
        scaleMax: input.scaleMax,
      });
      if (!this.#layerLabels.has(layerId)) {
        layerOrder.push(layerId);
        this.#layerLabels.set(layerId, layerLabel);
      } else if (this.#layerLabels.get(layerId) !== layerLabel) {
        throw new Error(`Conflicting layer label for ${layerId}.`);
      }
      this.#itemsById.set(id, item);
      items.push(item);
    }

    this.#items = Object.freeze(items);
    this.#layerOrder = Object.freeze(layerOrder);
    this.#density = options.preferences?.density ?? 'comfortable';
    this.#targetSize = options.preferences?.coarsePointer === true ? 48 : this.#density === 'compact' ? 36 : 40;
    this.#reducedMotion = options.preferences?.reducedMotion ?? false;
    this.#forcedColors = options.preferences?.forcedColors ?? false;
    this.#onAnnouncement = options.onAnnouncement;
    this.#onObserverError = options.onObserverError;
    this.#scale = validScale(options.initialScale) ? options.initialScale : undefined;

    const initialExpanded = options.initialExpandedLayerIds;
    if (initialExpanded === undefined) {
      for (const id of this.#layerOrder) this.#expanded.add(id);
    } else {
      for (const id of initialExpanded) if (this.#layerLabels.has(id)) this.#expanded.add(id);
    }
    if (options.initialSelectedId && this.#itemsById.has(options.initialSelectedId)) this.#selectedId = options.initialSelectedId;
    this.#snapshot = this.#buildSnapshot();
    this.#focusedId = this.#focusableRows()[0]?.id;
    this.#snapshot = this.#buildSnapshot();
  }

  get snapshot(): LegendSnapshot { return this.#snapshot; }

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
    this.#announce(next ? `${this.#snapshot.resultCount} lejant sonucu bulundu.` : 'Lejant filtresi temizlendi.', 'polite');
  }

  clearQuery(): void { this.setQuery(''); }

  setScale(scale: number | undefined): void {
    const next = validScale(scale) ? scale : undefined;
    if (next === this.#scale) return;
    this.#scale = next;
    this.#repairFocus();
    this.#commit();
  }

  toggleLayer(layerId: string): void {
    if (!this.#layerLabels.has(layerId)) return;
    if (this.#expanded.has(layerId)) this.#expanded.delete(layerId); else this.#expanded.add(layerId);
    this.#repairFocus();
    this.#commit();
    this.#announce(`${this.#layerLabels.get(layerId)} ${this.#expanded.has(layerId) ? 'genişletildi' : 'daraltıldı'}.`, 'polite');
  }

  expandAll(): void {
    let changed = false;
    for (const id of this.#layerOrder) if (!this.#expanded.has(id)) { this.#expanded.add(id); changed = true; }
    if (changed) this.#commit();
  }

  collapseAll(): void {
    if (this.#expanded.size === 0) return;
    this.#expanded.clear();
    this.#repairFocus();
    this.#commit();
  }

  select(id: string): void {
    const row = this.#allRows().find((candidate) => candidate.id === id);
    if (!row || row.disabled || !row.visible || !row.inScale) return;
    if (this.#selectedId === id && this.#focusedId === id) return;
    this.#selectedId = id;
    this.#focusedId = id;
    this.#commit();
    this.#announce(`${row.label} seçildi.`, 'polite');
  }

  focus(id: string): void {
    if (!this.#focusableRows().some((row) => row.id === id)) return;
    if (this.#focusedId === id) return;
    this.#focusedId = id;
    this.#commit();
  }

  focusNext(): void { this.#moveFocus(1); }
  focusPrevious(): void { this.#moveFocus(-1); }
  focusFirst(): void { this.#focusBoundary('first'); }
  focusLast(): void { this.#focusBoundary('last'); }

  #moveFocus(delta: -1 | 1): void {
    const rows = this.#focusableRows();
    if (rows.length === 0) return;
    const index = rows.findIndex((row) => row.id === this.#focusedId);
    const nextIndex = index < 0 ? 0 : (index + delta + rows.length) % rows.length;
    this.#focusedId = rows[nextIndex]?.id;
    this.#commit();
  }

  #focusBoundary(boundary: 'first' | 'last'): void {
    const rows = this.#focusableRows();
    const row = boundary === 'first' ? rows[0] : rows.at(-1);
    if (!row || row.id === this.#focusedId) return;
    this.#focusedId = row.id;
    this.#commit();
  }

  #repairFocus(): void {
    const rows = this.#focusableRows();
    if (rows.some((row) => row.id === this.#focusedId)) return;
    this.#focusedId = rows[0]?.id;
  }

  #matches(item: LegendItem): boolean {
    return !this.#query || item.normalizedSearch.includes(normalize(this.#query));
  }

  #allRows(): readonly LegendRow[] {
    const matched = this.#items.filter((item) => this.#matches(item));
    const setSize = matched.length;
    return matched.map((item, index) => ({
      id: item.id,
      layerId: item.layerId,
      layerLabel: item.layerLabel,
      label: item.label,
      description: item.description,
      symbolKind: item.symbolKind,
      visible: item.visible,
      disabled: item.disabled,
      status: item.status,
      errorMessage: item.errorMessage,
      inScale: isInScale(item, this.#scale),
      match: this.#query.length > 0,
      tabIndex: item.id === this.#focusedId ? 0 : -1,
      selected: item.id === this.#selectedId,
      targetSize: this.#targetSize,
      positionInSet: index + 1,
      setSize,
    }));
  }

  #focusableRows(): readonly LegendRow[] {
    return this.#allRows().filter((row) => this.#expanded.has(row.layerId) && row.visible && row.inScale && !row.disabled && row.status !== 'loading');
  }

  #buildSnapshot(): LegendSnapshot {
    const allRows = this.#allRows();
    const groups: LegendLayerGroup[] = [];
    for (const layerId of this.#layerOrder) {
      const rows = allRows.filter((row) => row.layerId === layerId);
      if (this.#query && rows.length === 0) continue;
      groups.push(Object.freeze({
        layerId,
        label: this.#layerLabels.get(layerId) ?? layerId,
        expanded: this.#query ? true : this.#expanded.has(layerId),
        visibleCount: rows.filter((row) => row.visible && row.inScale).length,
        totalCount: rows.length,
        rows: Object.freeze(rows.map((row) => Object.freeze({ ...row, tabIndex: row.id === this.#focusedId ? 0 : -1 }))),
      }));
    }
    const resultCount = allRows.filter((row) => row.visible && row.inScale).length;
    let emptyReason: LegendSnapshot['emptyReason'] = 'none';
    if (this.#items.length === 0) emptyReason = 'no-legend';
    else if (this.#query && allRows.length === 0) emptyReason = 'no-results';
    else if (allRows.length > 0 && resultCount === 0) emptyReason = 'out-of-scale';
    return Object.freeze({
      revision: this.#revision,
      groups: Object.freeze(groups),
      focusedId: this.#focusedId,
      selectedId: this.#selectedId,
      query: this.#query,
      scale: this.#scale,
      resultCount,
      totalCount: this.#items.length,
      emptyReason,
      density: this.#density,
      reducedMotion: this.#reducedMotion,
      forcedColors: this.#forcedColors,
    });
  }

  #commit(): void {
    this.#revision += 1;
    this.#snapshot = this.#buildSnapshot();
    for (const listener of this.#listeners) this.#notifyOne(listener);
  }

  #notifyOne(listener: Listener): void {
    try { listener(this.#snapshot); } catch (error) { this.#reportObserverError(error); }
  }

  #announce(message: string, priority: LegendAnnouncement['priority']): void {
    if (!this.#onAnnouncement) return;
    try { this.#onAnnouncement({ message, priority }); } catch (error) { this.#reportObserverError(error); }
  }

  #reportObserverError(error: unknown): void {
    if (!this.#onObserverError) return;
    try { this.#onObserverError(error); } catch (reportingError) { void reportingError; }
  }
}
