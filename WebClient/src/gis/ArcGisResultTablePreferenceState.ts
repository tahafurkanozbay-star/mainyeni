import {
  applyResultTableColumnMove,
  resolveArcGisResultTableResize,
  type ResultTableDensity,
  type ResultTablePreferenceColumnInput,
  type ResultTablePreferenceInput,
} from './ArcGisResultTablePreferencePolicy';

export interface ResultTablePreferenceState {
  readonly version: 1;
  readonly order: readonly string[];
  readonly hidden: readonly string[];
  readonly widths: Readonly<Record<string, number>>;
  readonly density: ResultTableDensity;
}

export type ResultTablePreferenceStateAction =
  | Readonly<{ type: 'move'; columnId: string; delta: number }>
  | Readonly<{ type: 'toggle-visibility'; columnId: string }>
  | Readonly<{ type: 'resize'; columnId: string; delta: number; keyboard?: boolean }>
  | Readonly<{ type: 'density'; density: ResultTableDensity }>
  | Readonly<{ type: 'reset' }>;

export interface ResultTablePreferenceTransition {
  readonly state: ResultTablePreferenceState;
  readonly changed: boolean;
  readonly announcement: string;
  readonly focusColumnId: string | null;
}

const MAX_COLUMNS = 32;
const MAX_SERIALIZED_LENGTH = 8_192;
const ID_LENGTH = 80;

const cleanText = (value: unknown, maximum = ID_LENGTH): string => {
  const normalized = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return normalized.length <= maximum ? normalized : normalized.slice(0, maximum);
};

const freezeState = (state: Omit<ResultTablePreferenceState, 'version'>): ResultTablePreferenceState => Object.freeze({
  version: 1 as const,
  order: Object.freeze([...state.order]),
  hidden: Object.freeze([...state.hidden]),
  widths: Object.freeze({ ...state.widths }),
  density: state.density,
});

const normalizedColumns = (columns: readonly ResultTablePreferenceColumnInput[]): readonly ResultTablePreferenceColumnInput[] => {
  const result: ResultTablePreferenceColumnInput[] = [];
  const seen = new Set<string>();
  for (const source of columns) {
    if (result.length >= MAX_COLUMNS) break;
    const id = cleanText(source.id);
    const label = cleanText(source.label, 100);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    result.push(Object.freeze({ ...source, id, label }));
  }
  return Object.freeze(result);
};

const normalizedIds = (input: unknown, allowed: ReadonlySet<string>): readonly string[] => {
  if (!Array.isArray(input)) return Object.freeze([]);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of input) {
    if (result.length >= MAX_COLUMNS) break;
    const id = cleanText(candidate);
    if (!id || !allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return Object.freeze(result);
};

const defaultState = (columns: readonly ResultTablePreferenceColumnInput[]): ResultTablePreferenceState => freezeState({
  order: columns.map((column) => column.id),
  hidden: [],
  widths: {},
  density: 'comfortable',
});

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const normalizeResultTablePreferenceState = (
  columnsInput: readonly ResultTablePreferenceColumnInput[],
  input?: ResultTablePreferenceInput | ResultTablePreferenceState | null,
): ResultTablePreferenceState => {
  const columns = normalizedColumns(columnsInput);
  const allowed = new Set(columns.map((column) => column.id));
  const source = asRecord(input) ?? {};
  const requestedOrder = normalizedIds(source.order, allowed);
  const requestedSet = new Set(requestedOrder);
  const order = Object.freeze([
    ...requestedOrder,
    ...columns.map((column) => column.id).filter((id) => !requestedSet.has(id)),
  ]);
  const hiddenRequested = new Set(normalizedIds(source.hidden, allowed));
  const hidden = Object.freeze(columns
    .filter((column) => column.pinned !== true && column.hideable !== false && hiddenRequested.has(column.id))
    .map((column) => column.id));
  const widthsSource = asRecord(source.widths) ?? {};
  const widths: Record<string, number> = {};
  for (const column of columns) {
    const width = widthsSource[column.id];
    if (!Number.isFinite(width)) continue;
    const minimum = Number.isFinite(column.minimumWidth) ? Math.max(88, Math.trunc(column.minimumWidth as number)) : 88;
    const maximum = Number.isFinite(column.maximumWidth) ? Math.min(520, Math.max(minimum, Math.trunc(column.maximumWidth as number))) : 520;
    widths[column.id] = Math.min(maximum, Math.max(minimum, Math.trunc(width as number)));
  }
  return freezeState({
    order,
    hidden,
    widths,
    density: source.density === 'compact' ? 'compact' : 'comfortable',
  });
};

export const parseResultTablePreferenceState = (
  serialized: string | null | undefined,
  columns: readonly ResultTablePreferenceColumnInput[],
): ResultTablePreferenceState => {
  if (!serialized || serialized.length > MAX_SERIALIZED_LENGTH) return defaultState(normalizedColumns(columns));
  try {
    const parsed: unknown = JSON.parse(serialized);
    const record = asRecord(parsed);
    if (!record || (record.version !== undefined && record.version !== 1)) return defaultState(normalizedColumns(columns));
    return normalizeResultTablePreferenceState(columns, record as unknown as ResultTablePreferenceState);
  } catch {
    return defaultState(normalizedColumns(columns));
  }
};

export const serializeResultTablePreferenceState = (state: ResultTablePreferenceState): string => JSON.stringify({
  version: 1,
  order: state.order,
  hidden: state.hidden,
  widths: state.widths,
  density: state.density,
});

const transition = (
  state: ResultTablePreferenceState,
  changed: boolean,
  announcement: string,
  focusColumnId: string | null,
): ResultTablePreferenceTransition => Object.freeze({ state, changed, announcement, focusColumnId });

export const reduceResultTablePreferenceState = (
  columnsInput: readonly ResultTablePreferenceColumnInput[],
  currentInput: ResultTablePreferenceState,
  action: ResultTablePreferenceStateAction,
): ResultTablePreferenceTransition => {
  const columns = normalizedColumns(columnsInput);
  const current = normalizeResultTablePreferenceState(columns, currentInput);
  const byId = new Map(columns.map((column) => [column.id, column] as const));
  const columnId = 'columnId' in action ? cleanText(action.columnId) : '';
  const column = columnId ? byId.get(columnId) : undefined;

  if (action.type === 'reset') {
    const next = defaultState(columns);
    const changed = serializeResultTablePreferenceState(next) !== serializeResultTablePreferenceState(current);
    return transition(next, changed, changed ? 'Tablo sütun tercihleri varsayılan değerlere döndürüldü.' : 'Tablo sütun tercihleri zaten varsayılan değerlerde.', columns[0]?.id ?? null);
  }

  if (action.type === 'density') {
    const density: ResultTableDensity = action.density === 'compact' ? 'compact' : 'comfortable';
    if (density === current.density) return transition(current, false, density === 'compact' ? 'Kompakt tablo yoğunluğu zaten etkin.' : 'Rahat tablo yoğunluğu zaten etkin.', null);
    const next = freezeState({ ...current, density });
    return transition(next, true, density === 'compact' ? 'Kompakt tablo yoğunluğu etkinleştirildi.' : 'Rahat tablo yoğunluğu etkinleştirildi.', null);
  }

  if (!column) return transition(current, false, 'Sütun tercihi değiştirilemedi.', null);

  if (action.type === 'toggle-visibility') {
    if (column.pinned === true || column.hideable === false) return transition(current, false, `${column.label} sütunu her zaman görünür.`, column.id);
    const hidden = new Set(current.hidden);
    const willHide = !hidden.has(column.id);
    if (willHide) hidden.add(column.id); else hidden.delete(column.id);
    const next = freezeState({ ...current, hidden: current.order.filter((id) => hidden.has(id)) });
    return transition(next, true, `${column.label} sütunu ${willHide ? 'gizlendi' : 'gösterildi'}.`, column.id);
  }

  if (action.type === 'move') {
    const pinnedIds = columns.filter((candidate) => candidate.pinned === true).map((candidate) => candidate.id);
    const order = applyResultTableColumnMove(current.order, column.id, action.delta, pinnedIds);
    const changed = order.some((id, index) => current.order[index] !== id);
    if (!changed) return transition(current, false, `${column.label} sütunu daha fazla taşınamaz.`, column.id);
    const next = freezeState({ ...current, order });
    const position = order.indexOf(column.id) + 1;
    return transition(next, true, `${column.label} sütunu ${position}. konuma taşındı.`, column.id);
  }

  const startWidth = current.widths[column.id] ?? column.defaultWidth ?? 160;
  const resize = resolveArcGisResultTableResize({
    columnId: column.id,
    startWidth,
    delta: action.delta,
    minimumWidth: column.minimumWidth,
    maximumWidth: column.maximumWidth,
    keyboard: action.keyboard,
  });
  if (!resize.changed) return transition(current, false, `${column.label} sütunu genişlik sınırında.`, column.id);
  const next = freezeState({ ...current, widths: { ...current.widths, [column.id]: resize.width } });
  return transition(next, true, `${column.label} sütunu ${resize.width} piksel genişliğinde.`, column.id);
};
