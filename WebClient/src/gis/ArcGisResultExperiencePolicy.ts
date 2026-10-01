export type ResultExperienceDensity = 'comfortable' | 'compact';
export type ResultExperienceLayout = 'list' | 'table';
export type ResultExperienceStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';
export type ResultExperienceSortDirection = 'ascending' | 'descending';

export interface ArcGisResultExperienceRecord {
  readonly objectId: string | number;
  readonly title: string;
  readonly subtitle?: string;
  readonly category?: string;
  readonly description?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface ArcGisResultExperienceColumn {
  readonly id: string;
  readonly label: string;
  readonly attribute?: string;
  readonly sortable?: boolean;
  readonly priority?: number;
}

export interface ArcGisResultExperienceSort {
  readonly columnId: string;
  readonly direction: ResultExperienceSortDirection;
}

export interface ArcGisResultExperienceSelection {
  readonly objectId: string | number;
  readonly index: number;
}

export interface ArcGisResultExperienceInput {
  readonly records: readonly ArcGisResultExperienceRecord[];
  readonly columns: readonly ArcGisResultExperienceColumn[];
  readonly status: ResultExperienceStatus;
  readonly query?: string;
  readonly errorMessage?: string;
  readonly totalCount?: number;
  readonly page?: number;
  readonly pageSize?: number;
  readonly layout?: ResultExperienceLayout;
  readonly density?: ResultExperienceDensity;
  readonly selectedObjectId?: string | number | null;
  readonly sort?: ArcGisResultExperienceSort | null;
  readonly locale?: string;
}

export interface ArcGisResultExperienceRow {
  readonly key: string;
  readonly objectId: string | number;
  readonly title: string;
  readonly subtitle: string | null;
  readonly category: string | null;
  readonly description: string | null;
  readonly selected: boolean;
  readonly positionInSet: number;
  readonly setSize: number;
  readonly accessibleName: string;
  readonly cells: Readonly<Record<string, string>>;
}

export interface ArcGisResultExperiencePagination {
  readonly page: number;
  readonly pageSize: number;
  readonly totalCount: number;
  readonly pageCount: number;
  readonly firstItem: number;
  readonly lastItem: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly previousPage: number | null;
  readonly nextPage: number | null;
}

export interface ArcGisResultExperienceModel {
  readonly status: ResultExperienceStatus;
  readonly layout: ResultExperienceLayout;
  readonly density: ResultExperienceDensity;
  readonly query: string;
  readonly rows: readonly ArcGisResultExperienceRow[];
  readonly columns: readonly ArcGisResultExperienceColumn[];
  readonly pagination: ArcGisResultExperiencePagination;
  readonly selection: ArcGisResultExperienceSelection | null;
  readonly sort: ArcGisResultExperienceSort | null;
  readonly heading: string;
  readonly summary: string;
  readonly announcement: string;
  readonly emptyTitle: string | null;
  readonly emptyDescription: string | null;
  readonly errorTitle: string | null;
  readonly errorDescription: string | null;
}

export interface ResultKeyboardIntent {
  readonly type: 'move' | 'activate' | 'clear-selection' | 'first' | 'last' | 'page-previous' | 'page-next';
  readonly delta?: number;
}

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 25;
const MAX_TEXT_LENGTH = 240;
const MAX_ACCESSIBLE_NAME_LENGTH = 320;
const DEFAULT_LOCALE = 'tr-TR';

const clampInteger = (value: number | undefined, minimum: number, maximum: number, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value as number)));
};

const normalizeText = (value: unknown, maximum = MAX_TEXT_LENGTH): string => {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
};

const normalizeOptionalText = (value: unknown): string | null => {
  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized : null;
};

const normalizeQuery = (value: string | undefined): string => normalizeText(value, 120);

const stableObjectId = (value: string | number): string => `${typeof value}:${String(value)}`;

const compareObjectIds = (left: string | number, right: string | number): boolean => stableObjectId(left) === stableObjectId(right);

const safeAttribute = (record: ArcGisResultExperienceRecord, attribute: string | undefined): unknown => {
  if (!attribute || !record.attributes) return undefined;
  if (!Object.prototype.hasOwnProperty.call(record.attributes, attribute)) return undefined;
  return record.attributes[attribute];
};

const formatCellValue = (value: unknown, locale: string): string => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Evet' : 'Hayır';
  if (typeof value === 'number' && Number.isFinite(value)) {
    try {
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value);
    } catch {
      return String(value);
    }
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(value);
    } catch {
      return value.toISOString();
    }
  }
  return normalizeText(value);
};

const visibleColumns = (columns: readonly ArcGisResultExperienceColumn[]): readonly ArcGisResultExperienceColumn[] => {
  const seen = new Set<string>();
  return [...columns]
    .filter((column) => {
      const id = normalizeText(column.id, 80);
      const label = normalizeText(column.label, 100);
      if (!id || !label || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((left, right) => (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER));
};

const buildCells = (
  record: ArcGisResultExperienceRecord,
  columns: readonly ArcGisResultExperienceColumn[],
  locale: string,
): Readonly<Record<string, string>> => Object.freeze(Object.fromEntries(columns.map((column) => {
  const attributeValue = safeAttribute(record, column.attribute);
  const fallbackValue = column.id === 'title'
    ? record.title
    : column.id === 'category'
      ? record.category
      : undefined;
  return [column.id, formatCellValue(attributeValue ?? fallbackValue, locale)];
})));

const buildAccessibleName = (
  record: ArcGisResultExperienceRecord,
  position: number,
  setSize: number,
  selected: boolean,
): string => {
  const fragments = [
    normalizeText(record.title, 120) || 'Adsız sonuç',
    normalizeOptionalText(record.category),
    normalizeOptionalText(record.subtitle),
    `${position} / ${setSize}`,
    selected ? 'Seçili' : null,
  ].filter((value): value is string => Boolean(value));
  return normalizeText(fragments.join(', '), MAX_ACCESSIBLE_NAME_LENGTH);
};

const buildRows = (
  records: readonly ArcGisResultExperienceRecord[],
  columns: readonly ArcGisResultExperienceColumn[],
  selectedObjectId: string | number | null | undefined,
  locale: string,
): readonly ArcGisResultExperienceRow[] => {
  const seen = new Set<string>();
  const rows: ArcGisResultExperienceRow[] = [];
  for (const record of records) {
    const key = stableObjectId(record.objectId);
    if (seen.has(key)) continue;
    seen.add(key);
    const selected = selectedObjectId !== null
      && selectedObjectId !== undefined
      && compareObjectIds(record.objectId, selectedObjectId);
    const position = rows.length + 1;
    rows.push(Object.freeze({
      key,
      objectId: record.objectId,
      title: normalizeText(record.title, 120) || 'Adsız sonuç',
      subtitle: normalizeOptionalText(record.subtitle),
      category: normalizeOptionalText(record.category),
      description: normalizeOptionalText(record.description),
      selected,
      positionInSet: position,
      setSize: records.length,
      accessibleName: buildAccessibleName(record, position, records.length, selected),
      cells: buildCells(record, columns, locale),
    }));
  }
  const setSize = rows.length;
  return Object.freeze(rows.map((row, index) => Object.freeze({
    ...row,
    positionInSet: index + 1,
    setSize,
    accessibleName: buildAccessibleName(records.find((record) => compareObjectIds(record.objectId, row.objectId)) ?? {
      objectId: row.objectId,
      title: row.title,
      subtitle: row.subtitle ?? undefined,
      category: row.category ?? undefined,
    }, index + 1, setSize, row.selected),
  })));
};

const buildPagination = (input: ArcGisResultExperienceInput): ArcGisResultExperiencePagination => {
  const pageSize = clampInteger(input.pageSize, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const totalCount = clampInteger(input.totalCount, 0, Number.MAX_SAFE_INTEGER, input.records.length);
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  const page = clampInteger(input.page, 1, pageCount, 1);
  const firstItem = totalCount === 0 ? 0 : ((page - 1) * pageSize) + 1;
  const lastItem = totalCount === 0 ? 0 : Math.min(totalCount, firstItem + input.records.length - 1);
  return Object.freeze({
    page,
    pageSize,
    totalCount,
    pageCount,
    firstItem,
    lastItem,
    hasPrevious: page > 1,
    hasNext: page < pageCount,
    previousPage: page > 1 ? page - 1 : null,
    nextPage: page < pageCount ? page + 1 : null,
  });
};

const buildSelection = (rows: readonly ArcGisResultExperienceRow[]): ArcGisResultExperienceSelection | null => {
  const index = rows.findIndex((row) => row.selected);
  if (index < 0) return null;
  return Object.freeze({ objectId: rows[index].objectId, index });
};

const resultWord = (count: number): string => count === 1 ? 'sonuç' : 'sonuç';

const buildHeading = (query: string): string => query ? `“${query}” için sonuçlar` : 'Harita sonuçları';

const buildSummary = (
  status: ResultExperienceStatus,
  pagination: ArcGisResultExperiencePagination,
): string => {
  if (status === 'loading') return 'Sonuçlar yükleniyor';
  if (status === 'error') return 'Sonuçlar yüklenemedi';
  if (status === 'empty' || pagination.totalCount === 0) return 'Sonuç bulunamadı';
  if (pagination.pageCount <= 1) return `${pagination.totalCount} ${resultWord(pagination.totalCount)}`;
  return `${pagination.totalCount} ${resultWord(pagination.totalCount)}, ${pagination.firstItem}–${pagination.lastItem} gösteriliyor`;
};

const buildAnnouncement = (
  status: ResultExperienceStatus,
  pagination: ArcGisResultExperiencePagination,
  query: string,
): string => {
  if (status === 'loading') return query ? `${query} için sonuçlar yükleniyor.` : 'Harita sonuçları yükleniyor.';
  if (status === 'error') return 'Harita sonuçları yüklenemedi. Yeniden deneyebilirsiniz.';
  if (status === 'empty' || pagination.totalCount === 0) return query ? `${query} için sonuç bulunamadı.` : 'Sonuç bulunamadı.';
  return `${pagination.totalCount} sonuç bulundu. Sayfa ${pagination.page}, toplam ${pagination.pageCount} sayfa.`;
};

const buildEmptyCopy = (query: string): readonly [string, string] => query
  ? ['Eşleşen sonuç yok', 'Arama ifadenizi sadeleştirin veya harita kapsamını değiştirin.']
  : ['Bu kapsamda sonuç yok', 'Haritada başka bir alana gidin veya etkin filtreleri gözden geçirin.'];

const buildErrorCopy = (message: string | undefined): readonly [string, string] => [
  'Sonuçlar gösterilemiyor',
  normalizeText(message, 180) || 'Bağlantıyı kontrol edip işlemi yeniden deneyin.',
];

const normalizeSort = (
  sort: ArcGisResultExperienceSort | null | undefined,
  columns: readonly ArcGisResultExperienceColumn[],
): ArcGisResultExperienceSort | null => {
  if (!sort) return null;
  const column = columns.find((candidate) => candidate.id === sort.columnId && candidate.sortable === true);
  if (!column) return null;
  return Object.freeze({ columnId: column.id, direction: sort.direction === 'descending' ? 'descending' : 'ascending' });
};

export const createArcGisResultExperienceModel = (
  input: ArcGisResultExperienceInput,
): ArcGisResultExperienceModel => {
  const query = normalizeQuery(input.query);
  const locale = normalizeText(input.locale, 32) || DEFAULT_LOCALE;
  const columns = visibleColumns(input.columns);
  const rows = buildRows(input.records, columns, input.selectedObjectId, locale);
  const pagination = buildPagination({ ...input, records: rows.map((row) => ({ objectId: row.objectId, title: row.title })) });
  const effectiveStatus: ResultExperienceStatus = input.status === 'ready' && pagination.totalCount === 0 ? 'empty' : input.status;
  const emptyCopy = effectiveStatus === 'empty' ? buildEmptyCopy(query) : null;
  const errorCopy = effectiveStatus === 'error' ? buildErrorCopy(input.errorMessage) : null;
  return Object.freeze({
    status: effectiveStatus,
    layout: input.layout === 'table' ? 'table' : 'list',
    density: input.density === 'compact' ? 'compact' : 'comfortable',
    query,
    rows,
    columns,
    pagination,
    selection: buildSelection(rows),
    sort: normalizeSort(input.sort, columns),
    heading: buildHeading(query),
    summary: buildSummary(effectiveStatus, pagination),
    announcement: buildAnnouncement(effectiveStatus, pagination, query),
    emptyTitle: emptyCopy?.[0] ?? null,
    emptyDescription: emptyCopy?.[1] ?? null,
    errorTitle: errorCopy?.[0] ?? null,
    errorDescription: errorCopy?.[1] ?? null,
  });
};

export const resolveResultKeyboardIntent = (key: string, ctrlKey = false, metaKey = false): ResultKeyboardIntent | null => {
  const modifier = ctrlKey || metaKey;
  if (key === 'ArrowDown') return Object.freeze({ type: 'move', delta: 1 });
  if (key === 'ArrowUp') return Object.freeze({ type: 'move', delta: -1 });
  if (key === 'Home') return Object.freeze({ type: 'first' });
  if (key === 'End') return Object.freeze({ type: 'last' });
  if (key === 'PageUp') return Object.freeze({ type: 'page-previous' });
  if (key === 'PageDown') return Object.freeze({ type: 'page-next' });
  if (key === 'Enter' || key === ' ') return Object.freeze({ type: 'activate' });
  if (key === 'Escape') return Object.freeze({ type: 'clear-selection' });
  if (modifier && key.toLowerCase() === 'a') return null;
  return null;
};

export const resolveNextResultIndex = (
  currentIndex: number,
  rowCount: number,
  intent: ResultKeyboardIntent,
): number | null => {
  if (rowCount <= 0) return null;
  const safeCurrent = clampInteger(currentIndex, 0, rowCount - 1, 0);
  if (intent.type === 'first') return 0;
  if (intent.type === 'last') return rowCount - 1;
  if (intent.type !== 'move') return safeCurrent;
  return Math.min(rowCount - 1, Math.max(0, safeCurrent + (intent.delta ?? 0)));
};

export const describeResultSort = (
  sort: ArcGisResultExperienceSort | null,
  columns: readonly ArcGisResultExperienceColumn[],
): string | null => {
  if (!sort) return null;
  const column = columns.find((candidate) => candidate.id === sort.columnId);
  if (!column) return null;
  return `${column.label}: ${sort.direction === 'descending' ? 'azalan' : 'artan'} sıralama`;
};
