export type LayerListStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export interface LayerListLayerInput {
  readonly id: string;
  readonly title: string;
  readonly visible: boolean;
  readonly opacity: number;
  readonly disabled?: boolean;
}

export interface LayerListGroupInput {
  readonly id: string;
  readonly title: string;
  readonly layers: readonly LayerListLayerInput[];
}

export interface LayerListVisibleRow {
  readonly key: string;
  readonly kind: 'group' | 'layer';
  readonly groupId: string;
  readonly layerId: string | null;
  readonly title: string;
  readonly level: 1 | 2;
  readonly position: number;
  readonly setSize: number;
  readonly expanded: boolean | null;
  readonly visible: boolean;
  readonly mixed: boolean;
  readonly disabled: boolean;
  readonly opacity: number | null;
  readonly active: boolean;
}

export interface LayerListExperienceSnapshot {
  readonly revision: number;
  readonly status: LayerListStatus;
  readonly query: string;
  readonly normalizedQuery: string;
  readonly activeKey: string | null;
  readonly rows: readonly LayerListVisibleRow[];
  readonly groupCount: number;
  readonly layerCount: number;
  readonly visibleLayerCount: number;
  readonly resultLayerCount: number;
  readonly announcement: string;
  readonly errorMessage: string | null;
}

export interface LayerListObserverDiagnostics {
  readonly activeObserverCount: number;
  readonly rejectedObserverCount: number;
  readonly failureCount: number;
  readonly lastFailureKind: string | null;
  readonly lastFailureRevision: number | null;
  readonly disposed: boolean;
}

export interface LayerListExperienceModelOptions {
  readonly maxGroups?: number;
  readonly maxLayers?: number;
  readonly maxQueryLength?: number;
  readonly maxObservers?: number;
  readonly pageSize?: number;
  readonly onObserverError?: (error: unknown) => void;
}

export type LayerListMoveIntent =
  | 'next'
  | 'previous'
  | 'first'
  | 'last'
  | 'page-next'
  | 'page-previous'
  | 'parent'
  | 'first-child';

interface InternalLayer extends LayerListLayerInput {
  readonly normalizedTitle: string;
}

interface InternalGroup {
  readonly id: string;
  readonly title: string;
  readonly normalizedTitle: string;
  readonly layers: readonly InternalLayer[];
}

const DEFAULT_MAX_GROUPS = 64;
const DEFAULT_MAX_LAYERS = 512;
const DEFAULT_MAX_QUERY_LENGTH = 96;
const DEFAULT_MAX_OBSERVERS = 32;
const DEFAULT_PAGE_SIZE = 7;
const MAX_LIMIT = 2048;
const MAX_ERROR_LENGTH = 180;

const clampInteger = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value ?? fallback)));
};

const safeId = (value: string, fallback: string): string => {
  const normalized = value.trim().slice(0, 96);
  return normalized || fallback;
};

const safeTitle = (value: string, fallback: string): string => {
  const normalized = value.replace(/\s+/gu, ' ').trim().slice(0, 180);
  return normalized || fallback;
};

const safeOpacity = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 100;

const stripControlCharacters = (value: string): string => {
  let sanitized = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    sanitized += codePoint !== undefined && (codePoint < 32 || codePoint === 127) ? ' ' : character;
  }
  return sanitized;
};

const safeErrorMessage = (error: unknown): string | null => {
  const value = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const normalized = stripControlCharacters(value).replace(/\s+/gu, ' ').trim();
  return normalized ? normalized.slice(0, MAX_ERROR_LENGTH) : null;
};

const classifyFailure = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error === null) return 'null';
  return typeof error;
};

const TURKISH_FOLD: Readonly<Record<string, string>> = Object.freeze({
  ı: 'i',
  İ: 'i',
  ş: 's',
  Ş: 's',
  ğ: 'g',
  Ğ: 'g',
  ü: 'u',
  Ü: 'u',
  ö: 'o',
  Ö: 'o',
  ç: 'c',
  Ç: 'c',
});

export const normalizeLayerListText = (value: string): string => {
  let folded = '';
  for (const character of value) folded += TURKISH_FOLD[character] ?? character;
  return folded
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('tr-TR')
    .replace(/[^a-z0-9\s_-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
};

const normalizeCatalog = (
  groups: readonly LayerListGroupInput[],
  maxGroups: number,
  maxLayers: number,
): readonly InternalGroup[] => {
  const seenGroupIds = new Set<string>();
  const seenLayerIds = new Set<string>();
  const normalized: InternalGroup[] = [];
  let layerBudget = maxLayers;

  for (let groupIndex = 0; groupIndex < groups.length && normalized.length < maxGroups; groupIndex += 1) {
    const source = groups[groupIndex];
    if (!source) continue;
    const id = safeId(source.id, `group-${groupIndex + 1}`);
    if (seenGroupIds.has(id)) continue;
    seenGroupIds.add(id);

    const layers: InternalLayer[] = [];
    for (let layerIndex = 0; layerIndex < source.layers.length && layerBudget > 0; layerIndex += 1) {
      const layer = source.layers[layerIndex];
      if (!layer) continue;
      const layerId = safeId(layer.id, `${id}-layer-${layerIndex + 1}`);
      const compoundKey = `${id}::${layerId}`;
      if (seenLayerIds.has(compoundKey)) continue;
      seenLayerIds.add(compoundKey);
      const title = safeTitle(layer.title, 'Katman');
      layers.push(Object.freeze({
        ...layer,
        id: layerId,
        title,
        visible: Boolean(layer.visible),
        opacity: safeOpacity(layer.opacity),
        disabled: Boolean(layer.disabled),
        normalizedTitle: normalizeLayerListText(title),
      }));
      layerBudget -= 1;
    }

    const title = safeTitle(source.title, 'Katman grubu');
    normalized.push(Object.freeze({
      id,
      title,
      normalizedTitle: normalizeLayerListText(title),
      layers: Object.freeze(layers),
    }));
  }

  return Object.freeze(normalized);
};

const groupVisibility = (group: InternalGroup): Readonly<{ visible: boolean; mixed: boolean }> => {
  const enabled = group.layers.filter((layer) => !layer.disabled);
  const visibleCount = enabled.filter((layer) => layer.visible).length;
  return Object.freeze({
    visible: enabled.length > 0 && visibleCount === enabled.length,
    mixed: visibleCount > 0 && visibleCount < enabled.length,
  });
};

const createRows = (
  groups: readonly InternalGroup[],
  expandedGroups: ReadonlySet<string>,
  query: string,
  activeKey: string | null,
): readonly LayerListVisibleRow[] => {
  const rows: LayerListVisibleRow[] = [];
  const searching = Boolean(query);

  for (const group of groups) {
    const matchingLayers = searching
      ? group.layers.filter((layer) => layer.normalizedTitle.includes(query))
      : group.layers;
    const groupMatches = searching && group.normalizedTitle.includes(query);
    if (searching && !groupMatches && matchingLayers.length === 0) continue;

    const visibility = groupVisibility(group);
    const groupKey = `group:${group.id}`;
    const expanded = searching || expandedGroups.has(group.id);
    rows.push(Object.freeze({
      key: groupKey,
      kind: 'group',
      groupId: group.id,
      layerId: null,
      title: group.title,
      level: 1,
      position: 1,
      setSize: 1,
      expanded,
      visible: visibility.visible,
      mixed: visibility.mixed,
      disabled: group.layers.length === 0,
      opacity: null,
      active: activeKey === groupKey,
    }));

    if (!expanded) continue;
    const layersToRender = groupMatches ? group.layers : matchingLayers;
    const setSize = layersToRender.length;
    layersToRender.forEach((layer, index) => {
      const key = `layer:${group.id}:${layer.id}`;
      rows.push(Object.freeze({
        key,
        kind: 'layer',
        groupId: group.id,
        layerId: layer.id,
        title: layer.title,
        level: 2,
        position: index + 1,
        setSize,
        expanded: null,
        visible: layer.visible,
        mixed: false,
        disabled: Boolean(layer.disabled),
        opacity: layer.opacity,
        active: activeKey === key,
      }));
    });
  }

  return Object.freeze(rows);
};

const countLayers = (groups: readonly InternalGroup[]): number =>
  groups.reduce((count, group) => count + group.layers.length, 0);

const countVisibleLayers = (groups: readonly InternalGroup[]): number =>
  groups.reduce((count, group) => count + group.layers.filter((layer) => layer.visible).length, 0);

const createAnnouncement = (
  status: LayerListStatus,
  rows: readonly LayerListVisibleRow[],
  layerCount: number,
  query: string,
  errorMessage: string | null,
): string => {
  if (status === 'loading') return 'Katmanlar hazırlanıyor.';
  if (status === 'error') return errorMessage ? `Katmanlar yüklenemedi. ${errorMessage}` : 'Katmanlar yüklenemedi.';
  if (status === 'empty' || layerCount === 0) return 'Gösterilecek katman bulunmuyor.';
  const resultCount = rows.filter((row) => row.kind === 'layer').length;
  if (query) return resultCount === 0 ? 'Aramayla eşleşen katman bulunamadı.' : `${resultCount} katman bulundu.`;
  return `${layerCount} katman hazır.`;
};

const deriveStatus = (status: LayerListStatus, layerCount: number): LayerListStatus => {
  if (status === 'loading' || status === 'error') return status;
  return layerCount === 0 ? 'empty' : 'ready';
};

export class LayerListExperienceModel {
  readonly #listeners = new Set<() => void>();
  readonly #maxGroups: number;
  readonly #maxLayers: number;
  readonly #maxQueryLength: number;
  readonly #maxObservers: number;
  readonly #pageSize: number;
  readonly #onObserverError: ((error: unknown) => void) | undefined;
  #groups: readonly InternalGroup[] = Object.freeze([]);
  #expandedGroups = new Set<string>();
  #snapshot: LayerListExperienceSnapshot;
  #disposed = false;
  #diagnostics: LayerListObserverDiagnostics = Object.freeze({
    activeObserverCount: 0,
    rejectedObserverCount: 0,
    failureCount: 0,
    lastFailureKind: null,
    lastFailureRevision: null,
    disposed: false,
  });

  constructor(options: LayerListExperienceModelOptions = {}) {
    this.#maxGroups = clampInteger(options.maxGroups, DEFAULT_MAX_GROUPS, 1, MAX_LIMIT);
    this.#maxLayers = clampInteger(options.maxLayers, DEFAULT_MAX_LAYERS, 1, MAX_LIMIT);
    this.#maxQueryLength = clampInteger(options.maxQueryLength, DEFAULT_MAX_QUERY_LENGTH, 1, 256);
    this.#maxObservers = clampInteger(options.maxObservers, DEFAULT_MAX_OBSERVERS, 1, 128);
    this.#pageSize = clampInteger(options.pageSize, DEFAULT_PAGE_SIZE, 1, 32);
    this.#onObserverError = options.onObserverError;
    this.#snapshot = Object.freeze({
      revision: 0,
      status: 'idle',
      query: '',
      normalizedQuery: '',
      activeKey: null,
      rows: Object.freeze([]),
      groupCount: 0,
      layerCount: 0,
      visibleLayerCount: 0,
      resultLayerCount: 0,
      announcement: 'Katman listesi hazır.',
      errorMessage: null,
    });
  }

  readonly getSnapshot = (): LayerListExperienceSnapshot => this.#snapshot;
  readonly getObserverDiagnostics = (): LayerListObserverDiagnostics => this.#diagnostics;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed || this.#listeners.size >= this.#maxObservers) {
      this.#diagnostics = Object.freeze({
        ...this.#diagnostics,
        rejectedObserverCount: this.#diagnostics.rejectedObserverCount + 1,
      });
      return () => undefined;
    }
    this.#listeners.add(listener);
    this.#refreshObserverCount();
    return () => {
      this.#listeners.delete(listener);
      this.#refreshObserverCount();
    };
  };

  markLoading(): void {
    this.#rebuild({ status: 'loading', errorMessage: null });
  }

  replace(groups: readonly LayerListGroupInput[]): void {
    if (this.#disposed) return;
    this.#groups = normalizeCatalog(groups, this.#maxGroups, this.#maxLayers);
    const nextExpanded = new Set<string>();
    for (const group of this.#groups) {
      if (this.#expandedGroups.has(group.id)) nextExpanded.add(group.id);
    }
    this.#expandedGroups = nextExpanded;
    this.#rebuild({ status: 'ready', errorMessage: null });
  }

  markError(error: unknown): void {
    this.#rebuild({ status: 'error', errorMessage: safeErrorMessage(error) });
  }

  setQuery(value: string): void {
    if (this.#disposed) return;
    const query = value.slice(0, this.#maxQueryLength);
    if (query === this.#snapshot.query) return;
    this.#rebuild({ query });
  }

  clearQuery(): void {
    this.setQuery('');
  }

  toggleGroup(groupId: string): void {
    if (this.#disposed) return;
    if (!this.#groups.some((group) => group.id === groupId)) return;
    const next = new Set(this.#expandedGroups);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    this.#expandedGroups = next;
    this.#rebuild();
  }

  setActive(key: string): void {
    if (this.#disposed || key === this.#snapshot.activeKey) return;
    if (!this.#snapshot.rows.some((row) => row.key === key)) return;
    this.#rebuild({ activeKey: key });
  }

  moveActive(intent: LayerListMoveIntent): void {
    if (this.#disposed || this.#snapshot.rows.length === 0) return;
    const rows = this.#snapshot.rows;
    const currentIndex = Math.max(0, rows.findIndex((row) => row.key === this.#snapshot.activeKey));
    const current = rows[currentIndex];
    let nextIndex = currentIndex;

    switch (intent) {
      case 'next': nextIndex = Math.min(rows.length - 1, currentIndex + 1); break;
      case 'previous': nextIndex = Math.max(0, currentIndex - 1); break;
      case 'first': nextIndex = 0; break;
      case 'last': nextIndex = rows.length - 1; break;
      case 'page-next': nextIndex = Math.min(rows.length - 1, currentIndex + this.#pageSize); break;
      case 'page-previous': nextIndex = Math.max(0, currentIndex - this.#pageSize); break;
      case 'parent': {
        if (current?.kind === 'group' && current.expanded && !this.#snapshot.normalizedQuery) {
          this.toggleGroup(current.groupId);
          return;
        }
        if (current?.kind === 'layer') {
          const index = rows.findIndex((row) => row.key === `group:${current.groupId}`);
          if (index >= 0) nextIndex = index;
        }
        break;
      }
      case 'first-child': {
        if (current?.kind === 'group') {
          if (!current.expanded) {
            this.toggleGroup(current.groupId);
            return;
          }
          const index = rows.findIndex((row) => row.kind === 'layer' && row.groupId === current.groupId);
          if (index >= 0) {
            this.setActive(rows[index]?.key ?? current.key);
            return;
          }
        }
        break;
      }
    }

    const next = this.#snapshot.rows[nextIndex];
    if (next) this.setActive(next.key);
  }

  setLayerVisibility(groupId: string, layerId: string, visible: boolean): void {
    this.#updateLayer(groupId, layerId, (layer) => Object.freeze({ ...layer, visible: Boolean(visible) }));
  }

  setGroupVisibility(groupId: string, visible: boolean): void {
    if (this.#disposed) return;
    let changed = false;
    this.#groups = Object.freeze(this.#groups.map((group) => {
      if (group.id !== groupId) return group;
      const layers = Object.freeze(group.layers.map((layer) => {
        if (layer.disabled || layer.visible === visible) return layer;
        changed = true;
        return Object.freeze({ ...layer, visible });
      }));
      return changed ? Object.freeze({ ...group, layers }) : group;
    }));
    if (changed) this.#rebuild();
  }

  setLayerOpacity(groupId: string, layerId: string, opacity: number): void {
    const normalized = safeOpacity(opacity);
    this.#updateLayer(groupId, layerId, (layer) =>
      layer.opacity === normalized ? layer : Object.freeze({ ...layer, opacity: normalized }));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      activeObserverCount: 0,
      disposed: true,
    });
  }

  #updateLayer(groupId: string, layerId: string, update: (layer: InternalLayer) => InternalLayer): void {
    if (this.#disposed) return;
    let changed = false;
    this.#groups = Object.freeze(this.#groups.map((group) => {
      if (group.id !== groupId) return group;
      const layers = Object.freeze(group.layers.map((layer) => {
        if (layer.id !== layerId) return layer;
        const next = update(layer);
        if (next !== layer) changed = true;
        return next;
      }));
      return changed ? Object.freeze({ ...group, layers }) : group;
    }));
    if (changed) this.#rebuild();
  }

  #rebuild(overrides: Partial<Pick<LayerListExperienceSnapshot, 'status' | 'query' | 'activeKey' | 'errorMessage'>> = {}): void {
    if (this.#disposed) return;
    const query = overrides.query ?? this.#snapshot.query;
    const normalizedQuery = normalizeLayerListText(query);
    const layerCount = countLayers(this.#groups);
    const status = deriveStatus(overrides.status ?? this.#snapshot.status, layerCount);
    const errorMessage = Object.prototype.hasOwnProperty.call(overrides, 'errorMessage')
      ? overrides.errorMessage ?? null
      : this.#snapshot.errorMessage;
    const candidateActiveKey = overrides.activeKey ?? this.#snapshot.activeKey;
    let rows = createRows(this.#groups, this.#expandedGroups, normalizedQuery, candidateActiveKey);
    const activeKey = rows.some((row) => row.key === candidateActiveKey)
      ? candidateActiveKey
      : rows[0]?.key ?? null;
    if (activeKey !== candidateActiveKey) rows = createRows(this.#groups, this.#expandedGroups, normalizedQuery, activeKey);
    const resultLayerCount = rows.filter((row) => row.kind === 'layer').length;
    const next: LayerListExperienceSnapshot = Object.freeze({
      revision: this.#snapshot.revision + 1,
      status,
      query,
      normalizedQuery,
      activeKey,
      rows,
      groupCount: this.#groups.length,
      layerCount,
      visibleLayerCount: countVisibleLayers(this.#groups),
      resultLayerCount,
      announcement: createAnnouncement(status, rows, layerCount, normalizedQuery, errorMessage),
      errorMessage,
    });
    this.#snapshot = next;
    this.#notify();
  }

  #notify(): void {
    const listeners = Array.from(this.#listeners);
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        this.#recordObserverFailure(error);
        try {
          this.#onObserverError?.(error);
        } catch (reporterError) {
          this.#recordObserverFailure(reporterError);
          globalThis.console?.warn?.('LayerListExperienceModel observer reporter failed.');
        }
      }
    }
  }

  #recordObserverFailure(error: unknown): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      failureCount: this.#diagnostics.failureCount + 1,
      lastFailureKind: classifyFailure(error),
      lastFailureRevision: this.#snapshot.revision,
    });
  }

  #refreshObserverCount(): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      activeObserverCount: this.#listeners.size,
    });
  }
}
