export type ResultTablePreferenceViewport = 'phone' | 'tablet' | 'desktop';
export type ResultTableDensity = 'compact' | 'comfortable';

export interface ResultTablePreferenceColumnInput {
  readonly id: string;
  readonly label: string;
  readonly pinned?: boolean;
  readonly hideable?: boolean;
  readonly minimumWidth?: number;
  readonly maximumWidth?: number;
  readonly defaultWidth?: number;
}

export interface ResultTablePreferenceInput {
  readonly order?: readonly string[];
  readonly hidden?: readonly string[];
  readonly widths?: Readonly<Record<string, number>>;
  readonly density?: ResultTableDensity;
}

export interface ResultTablePreferenceColumnModel {
  readonly id: string;
  readonly label: string;
  readonly pinned: boolean;
  readonly hideable: boolean;
  readonly hidden: boolean;
  readonly width: number;
  readonly minimumWidth: number;
  readonly maximumWidth: number;
  readonly order: number;
}

export interface ResultTablePreferenceModel {
  readonly viewport: ResultTablePreferenceViewport;
  readonly density: ResultTableDensity;
  readonly columns: readonly ResultTablePreferenceColumnModel[];
  readonly visibleColumnIds: readonly string[];
  readonly hiddenColumnIds: readonly string[];
  readonly canReset: boolean;
  readonly announcement: string;
}

export interface ResultTableResizeInput {
  readonly columnId: string;
  readonly startWidth: number;
  readonly delta: number;
  readonly minimumWidth?: number;
  readonly maximumWidth?: number;
  readonly keyboard?: boolean;
}

export interface ResultTableResizeModel {
  readonly columnId: string;
  readonly width: number;
  readonly changed: boolean;
  readonly announcement: string;
}

export interface ResultTablePreferenceAction {
  readonly type: 'move' | 'toggle-visibility' | 'resize' | 'reset';
  readonly columnId?: string;
  readonly delta?: number;
}

const MAX_COLUMNS = 32;
const MIN_WIDTH = 88;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 160;
const PHONE_BREAKPOINT = 640;
const TABLET_BREAKPOINT = 1024;

const clamp = (value: number | undefined, minimum: number, maximum: number, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value as number)));
};

const text = (value: unknown, maximum = 100): string => {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1).trimEnd()}…`;
};

const viewport = (width: number): ResultTablePreferenceViewport => {
  const safe = clamp(width, 0, 100_000, 0);
  if (safe < PHONE_BREAKPOINT) return 'phone';
  if (safe < TABLET_BREAKPOINT) return 'tablet';
  return 'desktop';
};

const normalizeColumns = (columns: readonly ResultTablePreferenceColumnInput[]): readonly ResultTablePreferenceColumnInput[] => {
  const result: ResultTablePreferenceColumnInput[] = [];
  const seen = new Set<string>();
  for (const column of columns) {
    if (result.length >= MAX_COLUMNS) break;
    const id = text(column.id, 80);
    const label = text(column.label);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    result.push(Object.freeze({ ...column, id, label }));
  }
  return Object.freeze(result);
};

const normalizeIds = (ids: readonly string[] | undefined, allowed: ReadonlySet<string>): readonly string[] => {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of ids ?? []) {
    const id = text(candidate, 80);
    if (!id || !allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return Object.freeze(result);
};

const orderedColumns = (
  columns: readonly ResultTablePreferenceColumnInput[],
  order: readonly string[],
): readonly ResultTablePreferenceColumnInput[] => {
  const byId = new Map(columns.map((column) => [column.id, column] as const));
  const requested = order.map((id) => byId.get(id)).filter((column): column is ResultTablePreferenceColumnInput => Boolean(column));
  const requestedIds = new Set(requested.map((column) => column.id));
  const remainder = columns.filter((column) => !requestedIds.has(column.id));
  const combined = [...requested, ...remainder];
  const pinned = combined.filter((column) => column.pinned === true);
  const unpinned = combined.filter((column) => column.pinned !== true);
  return Object.freeze([...pinned, ...unpinned]);
};

export const createArcGisResultTablePreferenceModel = (
  columnsInput: readonly ResultTablePreferenceColumnInput[],
  preferences: ResultTablePreferenceInput,
  viewportWidth: number,
): ResultTablePreferenceModel => {
  const columns = normalizeColumns(columnsInput);
  const allowed = new Set(columns.map((column) => column.id));
  const order = normalizeIds(preferences.order, allowed);
  const hidden = new Set(normalizeIds(preferences.hidden, allowed));
  const ordered = orderedColumns(columns, order);
  const models = Object.freeze(ordered.map((column, index) => {
    const minimumWidth = clamp(column.minimumWidth, MIN_WIDTH, MAX_WIDTH, MIN_WIDTH);
    const maximumWidth = clamp(column.maximumWidth, minimumWidth, MAX_WIDTH, MAX_WIDTH);
    const defaultWidth = clamp(column.defaultWidth, minimumWidth, maximumWidth, DEFAULT_WIDTH);
    const preferredWidth = clamp(preferences.widths?.[column.id], minimumWidth, maximumWidth, defaultWidth);
    const hideable = column.hideable !== false && column.pinned !== true;
    return Object.freeze({
      id: column.id,
      label: column.label,
      pinned: column.pinned === true,
      hideable,
      hidden: hideable && hidden.has(column.id),
      width: preferredWidth,
      minimumWidth,
      maximumWidth,
      order: index,
    });
  }));
  const visible = Object.freeze(models.filter((column) => !column.hidden).map((column) => column.id));
  const hiddenIds = Object.freeze(models.filter((column) => column.hidden).map((column) => column.id));
  const hasCustomOrder = order.some((id, index) => columns[index]?.id !== id);
  const hasCustomWidth = models.some((column) => column.width !== clamp(columns.find((source) => source.id === column.id)?.defaultWidth, column.minimumWidth, column.maximumWidth, DEFAULT_WIDTH));
  const density = preferences.density === 'compact' ? 'compact' : 'comfortable';
  const canReset = hasCustomOrder || hiddenIds.length > 0 || hasCustomWidth || density !== 'comfortable';
  return Object.freeze({
    viewport: viewport(viewportWidth),
    density,
    columns: models,
    visibleColumnIds: visible,
    hiddenColumnIds: hiddenIds,
    canReset,
    announcement: hiddenIds.length > 0 ? `${visible.length} sütun görünür, ${hiddenIds.length} sütun gizli.` : `${visible.length} sütunun tümü görünür.`,
  });
};

export const resolveArcGisResultTableResize = (input: ResultTableResizeInput): ResultTableResizeModel => {
  const id = text(input.columnId, 80);
  const minimum = clamp(input.minimumWidth, MIN_WIDTH, MAX_WIDTH, MIN_WIDTH);
  const maximum = clamp(input.maximumWidth, minimum, MAX_WIDTH, MAX_WIDTH);
  const start = clamp(input.startWidth, minimum, maximum, DEFAULT_WIDTH);
  const rawDelta = Number.isFinite(input.delta) ? Math.trunc(input.delta) : 0;
  const delta = input.keyboard ? Math.sign(rawDelta) * Math.min(40, Math.abs(rawDelta)) : rawDelta;
  const width = clamp(start + delta, minimum, maximum, start);
  return Object.freeze({
    columnId: id,
    width,
    changed: width !== start,
    announcement: id ? `${id} sütunu ${width} piksel genişliğinde.` : `Sütun ${width} piksel genişliğinde.`,
  });
};

export const resolveResultTablePreferenceKeyboardAction = (
  key: string,
  columnId: string,
  ctrlKey = false,
  shiftKey = false,
): ResultTablePreferenceAction | null => {
  const id = text(columnId, 80);
  if (!id) return null;
  if (ctrlKey && key === 'ArrowLeft') return Object.freeze({ type: 'move', columnId: id, delta: -1 });
  if (ctrlKey && key === 'ArrowRight') return Object.freeze({ type: 'move', columnId: id, delta: 1 });
  if (shiftKey && key === 'ArrowLeft') return Object.freeze({ type: 'resize', columnId: id, delta: -16 });
  if (shiftKey && key === 'ArrowRight') return Object.freeze({ type: 'resize', columnId: id, delta: 16 });
  if (key === 'Delete') return Object.freeze({ type: 'toggle-visibility', columnId: id });
  if (key === 'Escape') return Object.freeze({ type: 'reset' });
  return null;
};

export const applyResultTableColumnMove = (
  order: readonly string[],
  columnId: string,
  delta: number,
  pinnedIds: readonly string[] = [],
): readonly string[] => {
  const normalized = order.map((id) => text(id, 80)).filter(Boolean);
  const id = text(columnId, 80);
  const current = normalized.indexOf(id);
  if (current < 0 || delta === 0) return Object.freeze([...normalized]);
  const pinned = new Set(pinnedIds.map((candidate) => text(candidate, 80)).filter(Boolean));
  const isPinned = pinned.has(id);
  const groupIndices = normalized.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) => pinned.has(candidate) === isPinned).map(({ index }) => index);
  const groupPosition = groupIndices.indexOf(current);
  const nextGroupPosition = Math.min(groupIndices.length - 1, Math.max(0, groupPosition + Math.sign(delta)));
  const target = groupIndices[nextGroupPosition];
  if (target === undefined || target === current) return Object.freeze([...normalized]);
  const result = [...normalized];
  const [moved] = result.splice(current, 1);
  result.splice(target, 0, moved);
  return Object.freeze(result);
};
