import { createListIconModel } from '../../../gis-engine/iconPresentation';
import type { ListIconModel } from '../../../gis-engine/contracts';
import type { CoordinatorRequestInput } from '../../../Toolbox/SearchCoordinatorRuntime';
import type {
  SessionExecutionResult,
  SessionSearchOptions,
} from '../../../Toolbox/SearchSessionRuntime';

const TURKISH_LOCALE = 'tr-TR';
export const DEFAULT_GROUP_LIMIT = 10;

type UnknownRecord = Record<string, unknown>;
type CoordinatorModule = typeof import('../../../Toolbox/SearchCoordinatorRuntime');
type SessionModule = typeof import('../../../Toolbox/SearchSessionRuntime');
type ObservabilityModule = typeof import('../../../Toolbox/SearchObservabilityRuntime');
type Coordinator = ReturnType<CoordinatorModule['createSearchCoordinator']>;
type Session = ReturnType<SessionModule['createSearchSession']>;
type Observability = ReturnType<ObservabilityModule['createSearchObservability']>;
type CoordinatorOptions = Parameters<CoordinatorModule['createSearchCoordinator']>[0];
type SessionOptions = Parameters<SessionModule['createSearchSession']>[1];
type ObservabilityOptions = Parameters<ObservabilityModule['createSearchObservability']>[0];

export interface SearchRecordInput extends UnknownRecord {
  readonly attr?: UnknownRecord | null;
  readonly attributes?: UnknownRecord | null;
  readonly properties?: UnknownRecord | null;
}

export interface NormalizedSearchRecord {
  readonly raw: SearchRecordInput;
  readonly id: unknown;
  readonly key: string;
  readonly title: string;
  readonly address: string;
  readonly phone: string;
  readonly category: string;
  readonly type: string;
  readonly icon: ListIconModel;
}

export interface SearchResultGroup {
  readonly category: string;
  readonly totalCount: number;
  readonly visibleCount: number;
  readonly startIndex: number;
  readonly items: readonly NormalizedSearchRecord[];
}

export interface GroupedSearchResults {
  readonly groups: readonly SearchResultGroup[];
  readonly flatItems: readonly NormalizedSearchRecord[];
  readonly totalCount: number;
  readonly visibleCount: number;
}

export interface EgoLine extends UnknownRecord {
  readonly lineNo: string;
  readonly lineName: string;
  readonly lineType: string;
}

export interface EgoStop extends UnknownRecord {
  readonly stopNo: string;
  readonly stopName: string;
  readonly lineType: string;
  readonly latitude: number;
  readonly longitude: number;
}

export type SearchFieldSelector<T extends UnknownRecord> =
  | keyof T
  | ((record: T) => unknown);

export type ActiveIndexDirection = 'previous' | 'next' | 'first' | 'last';

export type QueryMatchMedia = (
  query: string,
) => Pick<MediaQueryList, 'matches'> | null | undefined;

export interface ProductionSearchModules {
  readonly coordinator: CoordinatorModule;
  readonly session: SessionModule;
  readonly observability: ObservabilityModule;
}

export interface ProductionSearchRuntimeOptions {
  readonly modules?: readonly [CoordinatorModule, SessionModule, ObservabilityModule];
  readonly coordinator?: Coordinator;
  readonly session?: Session;
  readonly observability?: Observability;
  readonly coordinatorOptions?: CoordinatorOptions;
  readonly sessionOptions?: SessionOptions;
  readonly observabilityOptions?: ObservabilityOptions;
  readonly now?: () => number;
}

export interface ProductionSearchFacade {
  readonly coordinator: Coordinator;
  readonly session: Session;
  readonly observability: Observability;
  ingest(
    datasetName: string,
    payload: unknown,
    ingestOptions?: UnknownRecord,
  ): ReturnType<Coordinator['ingest']>;
  register(
    datasetName: string,
    records: readonly unknown[],
    metadata?: UnknownRecord,
    registerOptions?: UnknownRecord,
  ): ReturnType<Coordinator['register']>;
  registerLoader(
    datasetName: string,
    loader: Parameters<Coordinator['registerLoader']>[1],
  ): ReturnType<Coordinator['registerLoader']>;
  search(
    datasetName: string,
    request?: CoordinatorRequestInput,
    searchOptions?: SessionSearchOptions,
  ): Promise<SessionExecutionResult>;
  schedule(
    datasetName: string,
    request?: CoordinatorRequestInput,
    searchOptions?: SessionSearchOptions,
  ): Promise<SessionExecutionResult>;
  loadMore(searchOptions?: SessionSearchOptions): Promise<SessionExecutionResult>;
  invalidate(datasetName: string): ReturnType<Coordinator['invalidate']>;
  getState(): ReturnType<Session['getState']>;
  diagnostics(): Readonly<{
    coordinator: ReturnType<Coordinator['diagnostics']>;
    session: ReturnType<Session['diagnostics']>;
    observability: ReturnType<Observability['snapshot']>;
    performanceGate: ReturnType<Observability['evaluate']>;
  }>;
  recommendDebounce(query?: string): number;
  dispose(): ReturnType<Session['dispose']>;
}

const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const normalizeWhitespace = (value: unknown): string => String(value ?? '')
  .replace(/\s+/g, ' ')
  .trim();

export const normalizeTurkishSearchText = (value: unknown): string =>
  normalizeWhitespace(value).toLocaleUpperCase(TURKISH_LOCALE);

export const matchesSearchText = (value: unknown, searchText: unknown): boolean => {
  const needle = normalizeTurkishSearchText(searchText);
  if (!needle) return true;
  return normalizeTurkishSearchText(value).includes(needle);
};

const recordSources = (record: SearchRecordInput | null | undefined): readonly UnknownRecord[] => {
  if (!record) return [];
  return [record, record.attr, record.attributes, record.properties].filter(isRecord);
};

export const readFirstValue = (
  record: SearchRecordInput | null | undefined,
  keys: readonly string[],
  fallback: unknown = '',
): unknown => {
  const sources = recordSources(record);
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if (value !== null && value !== undefined && String(value).trim() !== '') return value;
    }
  }
  return fallback;
};

export const getRecordId = (record: SearchRecordInput | null | undefined): unknown =>
  readFirstValue(record, ['ObjectId', 'objectId', 'objectid', 'OBJECTID', 'Id', 'id', 'ID'], null);

export const getRecordTitle = (record: SearchRecordInput | null | undefined): string =>
  normalizeWhitespace(readFirstValue(record, ['Title', 'title', 'ADI', 'adi', 'ad', 'AD', 'name', 'Name'], 'İsimsiz kayıt'));

export const getRecordAddress = (record: SearchRecordInput | null | undefined): string =>
  normalizeWhitespace(readFirstValue(record, ['Address', 'address', 'ADRES', 'adres', '_MAHALLE_ADI', 'mahalleAdi'], ''));

export const getRecordPhone = (record: SearchRecordInput | null | undefined): string =>
  normalizeWhitespace(readFirstValue(record, ['Phone', 'phone', 'TELEFON', 'telefon', 'TEL', 'tel'], ''));

export const getRecordCategory = (record: SearchRecordInput | null | undefined): string => {
  const semanticCategory = normalizeWhitespace(readFirstValue(record, ['Category', 'category', 'kategori', 'KATEGORI'], ''));
  if (semanticCategory) return semanticCategory;
  const technicalType = normalizeWhitespace(readFirstValue(record, ['type', 'Type'], ''));
  return technicalType || 'Diğer';
};

export const createStableResultKey = (record: SearchRecordInput | null | undefined, fallbackIndex = 0): string => {
  const id = getRecordId(record);
  if (id !== null && id !== undefined && String(id).trim() !== '') return 'id:' + String(id);
  return 'record:' + getRecordCategory(record) + '|' + getRecordTitle(record) + '|' + getRecordAddress(record) + '|' + String(fallbackIndex);
};

export const normalizeSearchRecord = (record: SearchRecordInput, index = 0): NormalizedSearchRecord => {
  const id = getRecordId(record);
  const title = getRecordTitle(record);
  const category = getRecordCategory(record);
  const type = normalizeWhitespace(readFirstValue(record, ['type', 'Type', 'TYPE', 'tur', 'TUR', 'tip', 'TIP'], ''));
  const iconKey = normalizeWhitespace(readFirstValue(record, ['iconKey', 'IconKey', 'serviceTitle', 'ServiceTitle'], ''));
  return Object.freeze({
    raw: record,
    id,
    key: createStableResultKey(record, index),
    title,
    address: getRecordAddress(record),
    phone: getRecordPhone(record),
    category,
    type,
    icon: createListIconModel({ id: typeof id === 'string' || typeof id === 'number' ? id : undefined, title, category, type, iconKey }),
  });
};

export const normalizeSearchCollection = (records: unknown): readonly NormalizedSearchRecord[] =>
  Array.isArray(records) ? records.filter(isRecord).map((record, index) => normalizeSearchRecord(record, index)) : [];

export const groupSearchResults = (records: unknown, groupLimit = DEFAULT_GROUP_LIMIT): GroupedSearchResults => {
  const normalized = normalizeSearchCollection(records);
  const safeLimit = Number.isFinite(groupLimit) ? Math.max(0, Math.trunc(groupLimit)) : DEFAULT_GROUP_LIMIT;
  const groupsByName = new Map<string, NormalizedSearchRecord[]>();
  normalized.forEach((record) => {
    const group = groupsByName.get(record.category);
    if (group) group.push(record);
    else groupsByName.set(record.category, [record]);
  });
  const groups: SearchResultGroup[] = [];
  const flatItems: NormalizedSearchRecord[] = [];
  groupsByName.forEach((items, category) => {
    const visibleItems = items.slice(0, safeLimit);
    const startIndex = flatItems.length;
    flatItems.push(...visibleItems);
    groups.push(Object.freeze({ category, totalCount: items.length, visibleCount: visibleItems.length, startIndex, items: visibleItems }));
  });
  return Object.freeze({ groups, flatItems, totalCount: normalized.length, visibleCount: flatItems.length });
};

export const filterBySearchFields = <T extends UnknownRecord>(
  records: readonly T[] | null | undefined,
  searchText: unknown,
  selectors: readonly SearchFieldSelector<T>[] = [],
): readonly T[] => {
  if (!Array.isArray(records)) return [];
  const needle = normalizeTurkishSearchText(searchText);
  if (!needle) return [...records];
  return records.filter((record) => selectors.some((selector) => {
    const value = typeof selector === 'function' ? selector(record) : record[selector];
    return normalizeTurkishSearchText(value).includes(needle);
  }));
};

export const normalizeEgoLine = (line: UnknownRecord): EgoLine => ({
  ...line,
  lineNo: normalizeWhitespace(readFirstValue(line, ['haT_NO', 'HAT_NO', 'hatNo'], '')),
  lineName: normalizeWhitespace(readFirstValue(line, ['haT_ADI', 'HAT_ADI', 'hatAdi'], '')),
  lineType: normalizeWhitespace(readFirstValue(line, ['haT_TIPI', 'HAT_TIPI', 'hatTipi'], '')),
});

const parseLocaleNumber = (value: unknown): number => Number.parseFloat(String(value ?? '').replace(',', '.'));

export const normalizeEgoStop = (stop: UnknownRecord): EgoStop => ({
  ...stop,
  stopNo: normalizeWhitespace(readFirstValue(stop, ['duraK_NO', 'DURAK_NO', 'durakNo'], '')),
  stopName: normalizeWhitespace(readFirstValue(stop, ['duraK_ADI', 'DURAK_ADI', 'durakAdi'], '')),
  lineType: normalizeWhitespace(readFirstValue(stop, ['haT_TIPI', 'HAT_TIPI', 'hatTipi'], '')),
  latitude: parseLocaleNumber(readFirstValue(stop, ['lat', 'latitude', 'LAT'], '')),
  longitude: parseLocaleNumber(readFirstValue(stop, ['lng', 'longitude', 'LNG'], '')),
});

export const filterEgoLines = (lines: readonly UnknownRecord[] | null | undefined, searchText: unknown, showAll = false): readonly EgoLine[] => {
  const normalized = Array.isArray(lines) ? lines.map(normalizeEgoLine) : [];
  const needle = normalizeTurkishSearchText(searchText);
  if (!needle) return showAll ? normalized : [];
  return normalized.filter((line) => normalizeTurkishSearchText(line.lineNo).includes(needle) || normalizeTurkishSearchText(line.lineName).includes(needle));
};

export const filterEgoStops = (stops: readonly UnknownRecord[] | null | undefined, searchText: unknown, showAll = false): readonly EgoStop[] => {
  const normalized = Array.isArray(stops) ? stops.map(normalizeEgoStop) : [];
  const needle = normalizeTurkishSearchText(searchText);
  if (!needle) return showAll ? normalized : [];
  return normalized.filter((stop) => normalizeTurkishSearchText(stop.stopNo).includes(needle) || normalizeTurkishSearchText(stop.stopName).includes(needle));
};

export const parseRouteCoordinatePairs = (value: unknown): readonly (readonly [number, number])[] => {
  const tokens = normalizeWhitespace(value).split(' ').filter(Boolean);
  const points: Array<readonly [number, number]> = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const latitudeToken = tokens[index];
    const longitudeToken = tokens[index + 1];
    if (latitudeToken === undefined || longitudeToken === undefined) continue;
    const latitude = parseLocaleNumber(latitudeToken);
    const longitude = parseLocaleNumber(longitudeToken);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) points.push([longitude, latitude]);
  }
  return points;
};

export const normalizeActiveIndex = (index: unknown, count: unknown): number => {
  const numericCount = Number(count);
  if (!Number.isFinite(numericCount) || numericCount <= 0) return -1;
  const boundedCount = Math.trunc(numericCount);
  const numericIndex = Number(index);
  const normalizedIndex = Number.isFinite(numericIndex) ? Math.trunc(numericIndex) : 0;
  return Math.min(boundedCount - 1, Math.max(0, normalizedIndex));
};

export const moveActiveIndex = (current: unknown, direction: ActiveIndexDirection, count: unknown): number => {
  const numericCount = Number(count);
  if (!Number.isFinite(numericCount) || numericCount <= 0) return -1;
  const boundedCount = Math.trunc(numericCount);
  const normalizedCurrent = normalizeActiveIndex(current, boundedCount);
  if (direction === 'previous') return Math.max(0, normalizedCurrent - 1);
  if (direction === 'next') return Math.min(boundedCount - 1, normalizedCurrent + 1);
  if (direction === 'first') return 0;
  return boundedCount - 1;
};

export const isResultActivationKey = (key: string): boolean => key === 'Enter' || key === ' ';

export const createAriaOptionId = (ownerId: unknown, recordKey: unknown): string => {
  const safeOwner = normalizeWhitespace(ownerId).replace(/[^a-zA-Z0-9_-]/g, '-') || 'query-search';
  const safeKey = normalizeWhitespace(recordKey).replace(/[^a-zA-Z0-9_-]/g, '-') || 'option';
  return safeOwner + '-' + safeKey;
};

export const isSmallViewport = (
  matchMedia: QueryMatchMedia | null | undefined = typeof window !== 'undefined' ? window.matchMedia.bind(window) : null,
): boolean => {
  if (typeof matchMedia !== 'function') return false;
  return Boolean(matchMedia('(max-width: 959px)')?.matches);
};

export const loadProductionSearchRuntimeModules = async (): Promise<readonly [CoordinatorModule, SessionModule, ObservabilityModule]> => Promise.all([
  import('../../../Toolbox/SearchCoordinatorRuntime'),
  import('../../../Toolbox/SearchSessionRuntime'),
  import('../../../Toolbox/SearchObservabilityRuntime'),
]);

const getOptionalNow = (searchOptions: SessionSearchOptions, fallback: (() => number) | undefined): (() => number) | undefined => {
  const candidate = searchOptions.now;
  return typeof candidate === 'function' ? candidate as () => number : fallback;
};

export const createProductionSearchRuntime = async (
  options: ProductionSearchRuntimeOptions = {},
): Promise<ProductionSearchFacade> => {
  const modules = options.modules ?? await loadProductionSearchRuntimeModules();
  const [coordinatorModule, sessionModule, observabilityModule] = modules;
  const createCoordinator = coordinatorModule?.createSearchCoordinator;
  const createSession = sessionModule?.createSearchSession;
  const createObservability = observabilityModule?.createSearchObservability;
  const measureAsync = observabilityModule?.measureAsyncOperation;

  if (typeof createCoordinator !== 'function' || typeof createSession !== 'function' || typeof createObservability !== 'function' || typeof measureAsync !== 'function') {
    throw new Error('Production search runtime modules are incomplete');
  }

  const coordinator = options.coordinator ?? createCoordinator(options.coordinatorOptions);
  const observability = options.observability ?? createObservability(options.observabilityOptions);
  const session = options.session ?? createSession(coordinator, {
    ...options.sessionOptions,
    debounceMs: options.sessionOptions?.debounceMs ?? observability.recommendDebounce({ queryLength: 0 }),
  });

  const observeEnvelope = (
    envelope: SessionExecutionResult,
    measured: Awaited<ReturnType<typeof measureAsync>>,
    context: UnknownRecord = {},
  ): SessionExecutionResult => {
    if (measured.error) {
      observability.recordError(context);
      throw measured.error;
    }
    const result = envelope?.result ?? envelope;
    observability.recordSearch(result, measured.durationMs, context);
    return envelope;
  };

  const measuredSearch = async (
    method: (datasetName: unknown, request?: CoordinatorRequestInput, searchOptions?: SessionSearchOptions) => Promise<SessionExecutionResult>,
    datasetName: string,
    request: CoordinatorRequestInput,
    searchOptions: SessionSearchOptions,
  ): Promise<SessionExecutionResult> => {
    const now = getOptionalNow(searchOptions, options.now);
    const measured = await measureAsync(() => method(datasetName, request, searchOptions), now ? { now } : {});
    return observeEnvelope(measured.value as SessionExecutionResult, measured, { dataset: datasetName, mode: request.mode });
  };

  return {
    coordinator,
    session,
    observability,
    ingest(datasetName, payload, ingestOptions = {}) {
      const snapshot = coordinator.ingest(datasetName, payload, ingestOptions);
      observability.recordDatasetSize(snapshot.recordCount, { dataset: snapshot.name });
      return snapshot;
    },
    register(datasetName, records, metadata = {}, registerOptions = {}) {
      const snapshot = coordinator.register(datasetName, records, metadata, registerOptions);
      observability.recordDatasetSize(snapshot.recordCount, { dataset: snapshot.name });
      return snapshot;
    },
    registerLoader(datasetName, loader) { return coordinator.registerLoader(datasetName, loader); },
    search(datasetName, request = {}, searchOptions = {}) {
      return measuredSearch(session.searchNow.bind(session), datasetName, request, searchOptions);
    },
    schedule(datasetName, request = {}, searchOptions = {}) {
      return measuredSearch(session.schedule.bind(session), datasetName, request, searchOptions);
    },
    async loadMore(searchOptions = {}) {
      const now = getOptionalNow(searchOptions, options.now);
      const measured = await measureAsync(() => session.loadMore(searchOptions), now ? { now } : {});
      const state = session.getState();
      return observeEnvelope(measured.value as SessionExecutionResult, measured, {
        dataset: state.dataset,
        mode: isRecord(state.result) ? state.result.mode : undefined,
      });
    },
    invalidate(datasetName) { return coordinator.invalidate(datasetName); },
    getState() { return session.getState(); },
    diagnostics() {
      return Object.freeze({
        coordinator: coordinator.diagnostics(),
        session: session.diagnostics(),
        observability: observability.snapshot(),
        performanceGate: observability.evaluate(),
      });
    },
    recommendDebounce(query = '') {
      const diagnostics = coordinator.diagnostics();
      const registry = isRecord(diagnostics) && isRecord(diagnostics.registry) ? diagnostics.registry : {};
      const totalRecords = Number(registry.totalRecords);
      return observability.recommendDebounce({
        queryLength: normalizeWhitespace(query).length,
        recordCount: Number.isFinite(totalRecords) ? totalRecords : 0,
      });
    },
    dispose() { return session.dispose(); },
  };
};