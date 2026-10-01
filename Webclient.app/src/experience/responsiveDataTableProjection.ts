export type ResponsiveDataTableViewport = 'phone' | 'tablet' | 'desktop';
export type ResponsiveDataTableDensity = 'comfortable' | 'compact';
export type ResponsiveDataTableAlign = 'start' | 'center' | 'end';

export interface ResponsiveDataTableColumnDefinition {
  readonly id: string;
  readonly label: string;
  readonly priority?: number;
  readonly essential?: boolean;
  readonly hideOnPhone?: boolean;
  readonly minimumWidth?: number;
  readonly preferredWidth?: number;
  readonly align?: ResponsiveDataTableAlign;
}

export interface ResponsiveDataTableEnvironment {
  readonly containerWidth: number;
  readonly viewportWidth: number;
  readonly coarsePointer: boolean;
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
}

export interface ResponsiveDataTableProjectionInput {
  readonly columns: readonly ResponsiveDataTableColumnDefinition[];
  readonly environment: ResponsiveDataTableEnvironment;
  readonly userHiddenColumnIds?: readonly string[];
  readonly density?: ResponsiveDataTableDensity;
  readonly maxColumns?: number;
}

export interface ResponsiveDataTableProjectedColumn {
  readonly id: string;
  readonly label: string;
  readonly priority: number;
  readonly essential: boolean;
  readonly width: number;
  readonly align: ResponsiveDataTableAlign;
  readonly columnIndex: number;
}

export interface ResponsiveDataTableProjectionSnapshot {
  readonly viewport: ResponsiveDataTableViewport;
  readonly density: ResponsiveDataTableDensity;
  readonly visibleColumns: readonly ResponsiveDataTableProjectedColumn[];
  readonly visibleColumnIds: readonly string[];
  readonly hiddenColumnIds: readonly string[];
  readonly userHiddenColumnIds: readonly string[];
  readonly automaticHiddenColumnIds: readonly string[];
  readonly tableWidth: number;
  readonly availableWidth: number;
  readonly horizontalOverflow: boolean;
  readonly touchTargetPx: number;
  readonly compactRows: boolean;
  readonly reducedMotion: boolean;
  readonly forcedColors: boolean;
  readonly coarsePointer: boolean;
  readonly announcement: string;
}

export interface ResponsiveDataTableObserverDiagnostics {
  readonly revision: number;
  readonly observerCount: number;
  readonly rejectedObserverCount: number;
  readonly failureCount: number;
  readonly lastFailureKind: string | null;
  readonly disposed: boolean;
}

export interface ResponsiveDataTableProjectionModelOptions {
  readonly columns: readonly ResponsiveDataTableColumnDefinition[];
  readonly initialEnvironment?: Partial<ResponsiveDataTableEnvironment>;
  readonly initialDensity?: ResponsiveDataTableDensity;
  readonly maxObservers?: number;
  readonly maxColumns?: number;
}

type ProjectionListener = (snapshot: ResponsiveDataTableProjectionSnapshot) => void;

const PHONE_BREAKPOINT = 640;
const TABLET_BREAKPOINT = 1024;
const DEFAULT_CONTAINER_WIDTH = 1024;
const DEFAULT_VIEWPORT_WIDTH = 1440;
const MIN_COLUMN_WIDTH = 88;
const MAX_COLUMN_WIDTH = 420;
const DEFAULT_COLUMN_WIDTH = 160;
const MAX_COLUMNS = 32;
const DEFAULT_MAX_OBSERVERS = 32;
const MAX_OBSERVERS = 128;

const clampInteger = (
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value as number)));
};

const normalizeText = (value: unknown, maximum: number): string => {
  const normalized = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
};

const normalizeId = (value: unknown): string => normalizeText(value, 80);

const normalizeEnvironment = (
  environment: Partial<ResponsiveDataTableEnvironment> | undefined,
): ResponsiveDataTableEnvironment => Object.freeze({
  containerWidth: clampInteger(environment?.containerWidth, 0, 100_000, DEFAULT_CONTAINER_WIDTH),
  viewportWidth: clampInteger(environment?.viewportWidth, 0, 100_000, DEFAULT_VIEWPORT_WIDTH),
  coarsePointer: environment?.coarsePointer === true,
  reducedMotion: environment?.reducedMotion === true,
  forcedColors: environment?.forcedColors === true,
});

const viewportFor = (
  environment: ResponsiveDataTableEnvironment,
): ResponsiveDataTableViewport => {
  const width = Math.min(environment.containerWidth, environment.viewportWidth);
  if (width < PHONE_BREAKPOINT) return 'phone';
  if (width < TABLET_BREAKPOINT) return 'tablet';
  return 'desktop';
};

const normalizeColumns = (
  columns: readonly ResponsiveDataTableColumnDefinition[],
  maxColumns: number,
): readonly ResponsiveDataTableColumnDefinition[] => {
  const seen = new Set<string>();
  const normalized: ResponsiveDataTableColumnDefinition[] = [];

  for (const column of columns) {
    if (normalized.length >= maxColumns) break;
    const id = normalizeId(column.id);
    const label = normalizeText(column.label, 100);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    normalized.push(Object.freeze({
      id,
      label,
      priority: clampInteger(column.priority, -10_000, 10_000, 0),
      essential: column.essential === true,
      hideOnPhone: column.hideOnPhone === true,
      minimumWidth: clampInteger(column.minimumWidth, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH),
      preferredWidth: clampInteger(column.preferredWidth, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH, DEFAULT_COLUMN_WIDTH),
      align: column.align === 'center' || column.align === 'end' ? column.align : 'start',
    }));
  }

  if (normalized.length > 0 && !normalized.some((column) => column.essential)) {
    normalized[0] = Object.freeze({ ...normalized[0], essential: true });
  }

  return Object.freeze(normalized);
};

const normalizeHiddenSet = (
  ids: readonly string[] | undefined,
  columns: readonly ResponsiveDataTableColumnDefinition[],
): ReadonlySet<string> => {
  const allowed = new Set(columns.filter((column) => !column.essential).map((column) => column.id));
  const normalized = new Set<string>();
  for (const id of ids ?? []) {
    const candidate = normalizeId(id);
    if (allowed.has(candidate)) normalized.add(candidate);
  }
  return normalized;
};

const automaticBudgetFor = (viewport: ResponsiveDataTableViewport): number => {
  if (viewport === 'phone') return 3;
  if (viewport === 'tablet') return 6;
  return MAX_COLUMNS;
};

const rankColumns = (
  columns: readonly ResponsiveDataTableColumnDefinition[],
): readonly ResponsiveDataTableColumnDefinition[] => Object.freeze(
  columns.slice().sort((left, right) => {
    if (left.essential !== right.essential) return left.essential ? -1 : 1;
    const priority = (left.priority ?? 0) - (right.priority ?? 0);
    return priority !== 0 ? priority : left.id.localeCompare(right.id, 'tr-TR');
  }),
);

const chooseVisibleColumns = (
  columns: readonly ResponsiveDataTableColumnDefinition[],
  environment: ResponsiveDataTableEnvironment,
  userHidden: ReadonlySet<string>,
): readonly ResponsiveDataTableColumnDefinition[] => {
  const viewport = viewportFor(environment);
  const budget = automaticBudgetFor(viewport);
  const ranked = rankColumns(columns);
  const candidates = ranked.filter((column) => !userHidden.has(column.id));
  const essential = candidates.filter((column) => column.essential);
  const optional = candidates.filter((column) => !column.essential);
  const chosen: ResponsiveDataTableColumnDefinition[] = essential.slice(0, budget);
  let usedWidth = chosen.reduce((sum, column) => sum + (column.minimumWidth ?? MIN_COLUMN_WIDTH), 0);

  for (const column of optional) {
    if (chosen.length >= budget) break;
    if (viewport === 'phone' && column.hideOnPhone) continue;
    const minimum = column.minimumWidth ?? MIN_COLUMN_WIDTH;
    const canFit = usedWidth + minimum <= Math.max(environment.containerWidth, MIN_COLUMN_WIDTH);
    if (!canFit && chosen.length > 0) continue;
    chosen.push(column);
    usedWidth += minimum;
  }

  if (chosen.length === 0 && candidates.length > 0) chosen.push(candidates[0]);
  if (chosen.length === 0 && columns.length > 0) chosen.push(columns[0]);
  const chosenIds = new Set(chosen.map((column) => column.id));
  return Object.freeze(columns.filter((column) => chosenIds.has(column.id)));
};

const allocateWidths = (
  columns: readonly ResponsiveDataTableColumnDefinition[],
  environment: ResponsiveDataTableEnvironment,
  density: ResponsiveDataTableDensity,
): readonly number[] => {
  if (columns.length === 0) return Object.freeze([]);
  const densityScale = density === 'compact' ? 0.9 : 1;
  const minimums = columns.map((column) => Math.max(
    MIN_COLUMN_WIDTH,
    Math.round((column.minimumWidth ?? MIN_COLUMN_WIDTH) * densityScale),
  ));
  const preferred = columns.map((column, index) => Math.max(
    minimums[index],
    Math.round((column.preferredWidth ?? DEFAULT_COLUMN_WIDTH) * densityScale),
  ));
  const availableWidth = Math.max(environment.containerWidth, MIN_COLUMN_WIDTH);
  const minimumTotal = minimums.reduce((sum, width) => sum + width, 0);
  if (availableWidth <= minimumTotal) return Object.freeze(minimums);

  const preferredTotal = preferred.reduce((sum, width) => sum + width, 0);
  if (preferredTotal <= availableWidth) {
    const spare = availableWidth - preferredTotal;
    const share = Math.floor(spare / columns.length);
    return Object.freeze(preferred.map((width) => Math.min(MAX_COLUMN_WIDTH, width + share)));
  }

  const flexible = preferred.map((width, index) => width - minimums[index]);
  const flexibleTotal = flexible.reduce((sum, width) => sum + width, 0);
  const distributable = availableWidth - minimumTotal;
  return Object.freeze(minimums.map((minimum, index) => {
    if (flexibleTotal <= 0) return minimum;
    return minimum + Math.floor(distributable * ((flexible[index] ?? 0) / flexibleTotal));
  }));
};

const buildAnnouncement = (
  visibleCount: number,
  hiddenCount: number,
  viewport: ResponsiveDataTableViewport,
  density: ResponsiveDataTableDensity,
): string => {
  if (visibleCount === 0) return 'Tablo sütunu bulunamadı.';
  const viewportText = viewport === 'phone' ? 'dar' : viewport === 'tablet' ? 'orta' : 'geniş';
  const densityText = density === 'compact' ? 'sıkı' : 'rahat';
  if (hiddenCount === 0) {
    return `${visibleCount} sütun ${viewportText} görünümde ${densityText} yoğunlukla gösteriliyor.`;
  }
  return `${visibleCount} sütun gösteriliyor, ${hiddenCount} sütun ${viewportText} görünüm için gizlendi. ${densityText} yoğunluk etkin.`;
};

export const createResponsiveDataTableProjection = (
  input: ResponsiveDataTableProjectionInput,
): ResponsiveDataTableProjectionSnapshot => {
  const maxColumns = clampInteger(input.maxColumns, 1, MAX_COLUMNS, MAX_COLUMNS);
  const environment = normalizeEnvironment(input.environment);
  const columns = normalizeColumns(input.columns, maxColumns);
  const userHidden = normalizeHiddenSet(input.userHiddenColumnIds, columns);
  const density: ResponsiveDataTableDensity = input.density === 'compact' ? 'compact' : 'comfortable';
  const viewport = viewportFor(environment);
  const visibleSource = chooseVisibleColumns(columns, environment, userHidden);
  const widths = allocateWidths(visibleSource, environment, density);
  const visibleColumns = Object.freeze(visibleSource.map((column, index) => Object.freeze({
    id: column.id,
    label: column.label,
    priority: column.priority ?? 0,
    essential: column.essential === true,
    width: widths[index] ?? MIN_COLUMN_WIDTH,
    align: column.align === 'center' || column.align === 'end' ? column.align : 'start',
    columnIndex: index + 1,
  })));
  const visibleIds = new Set(visibleColumns.map((column) => column.id));
  const hiddenColumnIds = Object.freeze(columns.filter((column) => !visibleIds.has(column.id)).map((column) => column.id));
  const userHiddenColumnIds = Object.freeze(columns.filter((column) => userHidden.has(column.id)).map((column) => column.id));
  const userHiddenIds = new Set(userHiddenColumnIds);
  const automaticHiddenColumnIds = Object.freeze(hiddenColumnIds.filter((id) => !userHiddenIds.has(id)));
  const tableWidth = visibleColumns.reduce((sum, column) => sum + column.width, 0);

  return Object.freeze({
    viewport,
    density,
    visibleColumns,
    visibleColumnIds: Object.freeze(visibleColumns.map((column) => column.id)),
    hiddenColumnIds,
    userHiddenColumnIds,
    automaticHiddenColumnIds,
    tableWidth,
    availableWidth: environment.containerWidth,
    horizontalOverflow: tableWidth > environment.containerWidth,
    touchTargetPx: environment.coarsePointer ? 48 : 44,
    compactRows: density === 'compact',
    reducedMotion: environment.reducedMotion,
    forcedColors: environment.forcedColors,
    coarsePointer: environment.coarsePointer,
    announcement: buildAnnouncement(visibleColumns.length, hiddenColumnIds.length, viewport, density),
  });
};

const classifyFailure = (error: unknown): string => {
  if (error instanceof Error) return normalizeText(error.name || 'Error', 48) || 'Error';
  if (error === null) return 'null';
  return normalizeText(typeof error, 48) || 'unknown';
};

export class ResponsiveDataTableProjectionModel {
  readonly #columns: readonly ResponsiveDataTableColumnDefinition[];
  readonly #listeners = new Set<ProjectionListener>();
  readonly #maxObservers: number;
  readonly #maxColumns: number;
  #environment: ResponsiveDataTableEnvironment;
  #density: ResponsiveDataTableDensity;
  #userHiddenColumnIds = new Set<string>();
  #snapshot: ResponsiveDataTableProjectionSnapshot;
  #disposed = false;
  #diagnostics: ResponsiveDataTableObserverDiagnostics;

  constructor(options: ResponsiveDataTableProjectionModelOptions) {
    this.#maxObservers = clampInteger(options.maxObservers, 1, MAX_OBSERVERS, DEFAULT_MAX_OBSERVERS);
    this.#maxColumns = clampInteger(options.maxColumns, 1, MAX_COLUMNS, MAX_COLUMNS);
    this.#columns = normalizeColumns(options.columns, this.#maxColumns);
    this.#environment = normalizeEnvironment(options.initialEnvironment);
    this.#density = options.initialDensity === 'compact' ? 'compact' : 'comfortable';
    this.#snapshot = this.#project();
    this.#diagnostics = Object.freeze({
      revision: 0,
      observerCount: 0,
      rejectedObserverCount: 0,
      failureCount: 0,
      lastFailureKind: null,
      disposed: false,
    });
  }

  readonly getSnapshot = (): ResponsiveDataTableProjectionSnapshot => this.#snapshot;
  readonly getDiagnostics = (): ResponsiveDataTableObserverDiagnostics => this.#diagnostics;

  readonly subscribe = (listener: ProjectionListener): (() => void) => {
    if (this.#disposed) {
      this.#diagnostics = Object.freeze({
        ...this.#diagnostics,
        rejectedObserverCount: this.#diagnostics.rejectedObserverCount + 1,
      });
      return () => undefined;
    }
    if (this.#listeners.has(listener)) return () => this.#unsubscribe(listener);
    if (this.#listeners.size >= this.#maxObservers) {
      this.#diagnostics = Object.freeze({
        ...this.#diagnostics,
        rejectedObserverCount: this.#diagnostics.rejectedObserverCount + 1,
      });
      return () => undefined;
    }
    this.#listeners.add(listener);
    this.#refreshObserverCount();
    return () => this.#unsubscribe(listener);
  };

  setEnvironment(environment: Partial<ResponsiveDataTableEnvironment>): void {
    if (this.#disposed) return;
    const next = normalizeEnvironment({ ...this.#environment, ...environment });
    if (
      next.containerWidth === this.#environment.containerWidth
      && next.viewportWidth === this.#environment.viewportWidth
      && next.coarsePointer === this.#environment.coarsePointer
      && next.reducedMotion === this.#environment.reducedMotion
      && next.forcedColors === this.#environment.forcedColors
    ) return;
    this.#environment = next;
    this.#publish();
  }

  setDensity(density: ResponsiveDataTableDensity): void {
    if (this.#disposed) return;
    const next: ResponsiveDataTableDensity = density === 'compact' ? 'compact' : 'comfortable';
    if (next === this.#density) return;
    this.#density = next;
    this.#publish();
  }

  setColumnHidden(columnId: string, hidden: boolean): void {
    if (this.#disposed) return;
    const normalized = normalizeId(columnId);
    const column = this.#columns.find((candidate) => candidate.id === normalized);
    if (!column || column.essential) return;
    const had = this.#userHiddenColumnIds.has(normalized);
    if (hidden && !had) this.#userHiddenColumnIds.add(normalized);
    else if (!hidden && had) this.#userHiddenColumnIds.delete(normalized);
    else return;
    this.#publish();
  }

  toggleColumn(columnId: string): void {
    const normalized = normalizeId(columnId);
    this.setColumnHidden(normalized, !this.#userHiddenColumnIds.has(normalized));
  }

  resetColumnVisibility(): void {
    if (this.#disposed || this.#userHiddenColumnIds.size === 0) return;
    this.#userHiddenColumnIds.clear();
    this.#publish();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      observerCount: 0,
      disposed: true,
    });
  }

  #project(): ResponsiveDataTableProjectionSnapshot {
    return createResponsiveDataTableProjection({
      columns: this.#columns,
      environment: this.#environment,
      userHiddenColumnIds: [...this.#userHiddenColumnIds],
      density: this.#density,
      maxColumns: this.#maxColumns,
    });
  }

  #publish(): void {
    if (this.#disposed) return;
    this.#snapshot = this.#project();
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      revision: this.#diagnostics.revision + 1,
    });
    for (const listener of this.#listeners) {
      try {
        listener(this.#snapshot);
      } catch (error) {
        this.#diagnostics = Object.freeze({
          ...this.#diagnostics,
          failureCount: this.#diagnostics.failureCount + 1,
          lastFailureKind: classifyFailure(error),
        });
      }
    }
  }

  #unsubscribe(listener: ProjectionListener): void {
    if (!this.#listeners.delete(listener)) return;
    this.#refreshObserverCount();
  }

  #refreshObserverCount(): void {
    this.#diagnostics = Object.freeze({
      ...this.#diagnostics,
      observerCount: this.#listeners.size,
    });
  }
}

export const createResponsiveDataTableProjectionModel = (
  options: ResponsiveDataTableProjectionModelOptions,
): ResponsiveDataTableProjectionModel => new ResponsiveDataTableProjectionModel(options);
