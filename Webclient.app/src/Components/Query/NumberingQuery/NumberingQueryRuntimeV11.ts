import { Constants_ServiceResultType } from '../../../Core/Constants';
import {
  NUMBERING_LEVELS_V11,
  NUMBERING_QUERY_VERSION_V11,
  cloneNumberingPathV11,
  descendantsOfNumberingLevelV11,
  emptyNumberingPathV11,
  errorMessageV11,
  errorNameV11,
  filterNumberingOptionsV11,
  findNumberingOptionV11,
  geometriesFromFeaturesV11,
  normalizeNumberingFilterV11,
  normalizeNumberingOptionsV11,
  normalizeNumberingRuntimePolicyV11,
  numberingLevelLabelV11,
  numberingPathLabelV11,
  numberingSelectionFromOptionV11,
  safeNumberingNowV11,
  selectionPathCompleteV11,
  serviceMessageV11,
  type NormalizedNumberingRuntimePolicyV11,
  type NumberingFeatureV11,
  type NumberingHistoryEntryV11,
  type NumberingLevelStateV11,
  type NumberingLevelV11,
  type NumberingOptionV11,
  type NumberingPathV11,
  type NumberingRuntimeEffectsV11,
  type NumberingRuntimeMetricsV11,
  type NumberingRuntimePolicyV11,
  type NumberingRuntimeSnapshotV11,
  type NumberingSelectionV11,
  type NumberingServiceResultV11,
  type NumberingStatusV11,
  type NumberingTransportV11,
} from './NumberingQueryContractsV11';

interface MutableLevelV11 {
  status: NumberingStatusV11;
  options: readonly NumberingOptionV11[];
  filter: string;
  selected: NumberingSelectionV11 | null;
  error: string;
  message: string;
  generation: number;
  sourceTruncated: boolean;
}

interface MutableMetricsV11 {
  requests: number;
  successes: number;
  failures: number;
  staleResponses: number;
  cancellations: number;
  focusRequests: number;
  observerFailures: number;
  optionTruncations: number;
}

interface RequestTokenV11 {
  readonly sequence: number;
  readonly level: NumberingLevelV11;
  readonly operation: string;
  readonly generation: number;
  readonly startedAt: number;
}

interface OptionKeysV11 {
  readonly valueKey: string;
  readonly labelKey: string;
}

const OPTION_KEYS: Readonly<Record<NumberingLevelV11, OptionKeysV11>> = Object.freeze({
  district: Object.freeze({ valueKey: 'id', labelKey: 'ad' }),
  neighborhood: Object.freeze({ valueKey: 'id', labelKey: 'ad' }),
  street: Object.freeze({ valueKey: 'yolid', labelKey: 'ad' }),
  door: Object.freeze({ valueKey: 'id', labelKey: 'kapino' }),
});

const EMPTY_OPTIONS: readonly NumberingOptionV11[] = Object.freeze([]);

const newLevel = (): MutableLevelV11 => ({
  status: 'idle',
  options: EMPTY_OPTIONS,
  filter: '',
  selected: null,
  error: '',
  message: '',
  generation: 0,
  sourceTruncated: false,
});

const createMutableLevels = (): Record<NumberingLevelV11, MutableLevelV11> => ({
  district: newLevel(),
  neighborhood: newLevel(),
  street: newLevel(),
  door: newLevel(),
});

const createMutableMetrics = (): MutableMetricsV11 => ({
  requests: 0,
  successes: 0,
  failures: 0,
  staleResponses: 0,
  cancellations: 0,
  focusRequests: 0,
  observerFailures: 0,
  optionTruncations: 0,
});

const isSuccess = (
  result: NumberingServiceResultV11 | null | undefined,
): boolean => result?.type === Constants_ServiceResultType.Success;

const frozenMetrics = (metrics: MutableMetricsV11): NumberingRuntimeMetricsV11 => Object.freeze({
  requests: metrics.requests,
  successes: metrics.successes,
  failures: metrics.failures,
  staleResponses: metrics.staleResponses,
  cancellations: metrics.cancellations,
  focusRequests: metrics.focusRequests,
  observerFailures: metrics.observerFailures,
  optionTruncations: metrics.optionTruncations,
});

const fallbackForLevel = (
  level: NumberingLevelV11,
  operation: 'list' | 'detail',
): string => {
  if (operation === 'list') {
    if (level === 'district') return 'İlçe listesi alınamadı.';
    if (level === 'neighborhood') return 'Mahalle listesi alınamadı.';
    if (level === 'street') return 'Cadde ve sokak listesi alınamadı.';
    return 'Bina numarası listesi alınamadı.';
  }
  if (level === 'district') return 'İlçe konumu alınamadı.';
  if (level === 'neighborhood') return 'Mahalle konumu alınamadı.';
  if (level === 'street') return 'Cadde ve sokak konumu alınamadı.';
  return 'Bina konumu alınamadı.';
};

const statusMessage = (
  level: NumberingLevelV11,
  status: NumberingStatusV11,
): string => {
  if (status !== 'loading') return '';
  if (level === 'district') return 'İlçeler yükleniyor…';
  if (level === 'neighborhood') return 'Mahalleler yükleniyor…';
  if (level === 'street') return 'Cadde, sokak ve bina numaraları yükleniyor…';
  return 'Bina konumu yükleniyor…';
};

const isPromiseRejected = (
  result: PromiseSettledResult<unknown>,
): result is PromiseRejectedResult => result.status === 'rejected';

const copyHistoryEntry = (
  entry: NumberingHistoryEntryV11,
): NumberingHistoryEntryV11 => Object.freeze({ ...entry });

export class NumberingQueryRuntimeV11 {
  readonly #transport: NumberingTransportV11;
  readonly #effects: NumberingRuntimeEffectsV11;
  readonly #policy: NormalizedNumberingRuntimePolicyV11;
  readonly #levels = createMutableLevels();
  readonly #observers = new Set<() => void>();
  readonly #history: NumberingHistoryEntryV11[] = [];
  readonly #metrics = createMutableMetrics();

  #sequence = 0;
  #disposed = false;
  #initialized = false;
  #snapshot: NumberingRuntimeSnapshotV11;

  constructor(
    transport: NumberingTransportV11,
    effects: NumberingRuntimeEffectsV11 = {},
    policy: NumberingRuntimePolicyV11 = {},
  ) {
    this.#transport = transport;
    this.#effects = effects;
    this.#policy = normalizeNumberingRuntimePolicyV11(policy);
    this.#snapshot = this.#buildSnapshot();
  }

  subscribe(observer: () => void): () => void {
    this.#ensureActive();
    if (typeof observer !== 'function') throw new TypeError('Numbering observer must be a function');
    if (this.#observers.has(observer)) return () => this.#observers.delete(observer);
    if (this.#observers.size >= this.#policy.maxObservers) {
      throw new RangeError(`Numbering observer limit reached: ${this.#policy.maxObservers}`);
    }
    this.#observers.add(observer);
    return () => {
      this.#observers.delete(observer);
    };
  }

  snapshot(): NumberingRuntimeSnapshotV11 {
    return this.#snapshot;
  }

  policy(): NumberingRuntimePolicyV11 {
    return Object.freeze({
      maxOptionsPerLevel: this.#policy.maxOptionsPerLevel,
      maxVisibleOptions: this.#policy.maxVisibleOptions,
      maxFilterLength: this.#policy.maxFilterLength,
      maxHistory: this.#policy.maxHistory,
      maxObservers: this.#policy.maxObservers,
      minimumFilterLengthForOverflow: this.#policy.minimumFilterLengthForOverflow,
      clock: this.#policy.clock,
    });
  }

  async initialize(): Promise<void> {
    this.#ensureActive();
    if (this.#initialized && this.#levels.district.options.length > 0) return;
    this.#initialized = true;
    const token = this.#begin('district', 'load-districts');
    try {
      const result = await this.#transport.loadDistricts();
      if (!this.#isCurrent(token)) {
        this.#recordStale(token);
        return;
      }
      if (!isSuccess(result)) {
        this.#failLevel(token, serviceMessageV11(result, fallbackForLevel('district', 'list')));
        return;
      }
      this.#applyOptions('district', result.data);
      this.#succeedLevel(token, this.#levels.district.options.length);
    } catch (error) {
      if (!this.#isCurrent(token)) {
        this.#recordStale(token);
        return;
      }
      this.#failLevel(token, errorMessageV11(error, fallbackForLevel('district', 'list')), error);
    }
  }

  setFilter(level: NumberingLevelV11, value: unknown): void {
    this.#ensureActive();
    const next = normalizeNumberingFilterV11(value, this.#policy.maxFilterLength);
    if (next === this.#levels[level].filter) return;
    this.#levels[level].filter = next;
    this.#publish();
  }

  clearFilter(level: NumberingLevelV11): void {
    this.setFilter(level, '');
  }

  async select(level: NumberingLevelV11, valueInput: unknown): Promise<void> {
    this.#ensureActive();
    const option = findNumberingOptionV11(this.#levels[level].options, valueInput);
    if (!option) {
      this.clearSelection(level);
      return;
    }
    const selection = numberingSelectionFromOptionV11(option);
    if (!selection) return;
    if (level === 'district') {
      await this.#selectDistrict(selection);
      return;
    }
    if (level === 'neighborhood') {
      await this.#selectNeighborhood(selection);
      return;
    }
    if (level === 'street') {
      await this.#selectStreet(selection);
      return;
    }
    await this.#selectDoor(selection);
  }

  clearSelection(level: NumberingLevelV11): void {
    this.#ensureActive();
    this.#invalidateLevelAndDescendants(level);
    this.#levels[level].selected = null;
    this.#levels[level].error = '';
    this.#levels[level].message = '';
    this.#levels[level].status = this.#levels[level].options.length > 0 ? 'ready' : 'idle';
    for (const descendant of descendantsOfNumberingLevelV11(level)) {
      this.#levels[descendant].selected = null;
      this.#levels[descendant].filter = '';
      this.#levels[descendant].options = EMPTY_OPTIONS;
      this.#levels[descendant].error = '';
      this.#levels[descendant].message = '';
      this.#levels[descendant].status = 'idle';
      this.#levels[descendant].sourceTruncated = false;
    }
    this.#publish();
  }

  reset(): void {
    this.#ensureActive();
    this.#sequence += 1;
    for (const level of NUMBERING_LEVELS_V11) {
      const mutable = this.#levels[level];
      if (mutable.status === 'loading') this.#metrics.cancellations += 1;
      mutable.generation += 1;
      mutable.selected = null;
      mutable.filter = '';
      mutable.error = '';
      mutable.message = '';
      if (level === 'district') {
        mutable.status = mutable.options.length > 0 ? 'ready' : 'idle';
      } else {
        mutable.options = EMPTY_OPTIONS;
        mutable.status = 'idle';
        mutable.sourceTruncated = false;
      }
    }
    this.#publish();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#sequence += 1;
    for (const level of NUMBERING_LEVELS_V11) {
      const mutable = this.#levels[level];
      if (mutable.status === 'loading') this.#metrics.cancellations += 1;
      mutable.generation += 1;
      mutable.status = 'disposed';
      mutable.options = EMPTY_OPTIONS;
      mutable.filter = '';
      mutable.selected = null;
      mutable.error = '';
      mutable.message = '';
      mutable.sourceTruncated = false;
    }
    this.#history.length = 0;
    this.#snapshot = this.#buildSnapshot();
    this.#observers.clear();
  }

  #ensureActive(): void {
    if (this.#disposed) throw new Error('Numbering query runtime has been disposed');
  }

  #path(): NumberingPathV11 {
    return Object.freeze({
      district: this.#levels.district.selected,
      neighborhood: this.#levels.neighborhood.selected,
      street: this.#levels.street.selected,
      door: this.#levels.door.selected,
    });
  }

  #levelSnapshot(level: NumberingLevelV11): NumberingLevelStateV11 {
    const mutable = this.#levels[level];
    const filtered = filterNumberingOptionsV11(
      mutable.options,
      mutable.filter,
      this.#policy.maxVisibleOptions,
    );
    const shouldRequireFilter = mutable.options.length > this.#policy.maxVisibleOptions
      && mutable.filter.length < this.#policy.minimumFilterLengthForOverflow;
    const options = shouldRequireFilter ? EMPTY_OPTIONS : filtered.options;
    const visibleOptionCount = shouldRequireFilter ? 0 : options.length;
    const truncated = mutable.sourceTruncated
      || shouldRequireFilter
      || filtered.truncated;
    let message = mutable.message;
    if (!message && shouldRequireFilter) {
      message = `${mutable.options.length.toLocaleString('tr-TR')} seçenek var. Listelemek için en az ${this.#policy.minimumFilterLengthForOverflow} karakter yazın.`;
    } else if (!message && filtered.truncated) {
      message = `${filtered.totalMatches.toLocaleString('tr-TR')} eşleşmeden ilk ${visibleOptionCount.toLocaleString('tr-TR')} sonuç gösteriliyor.`;
    }
    return Object.freeze({
      level,
      status: mutable.status,
      filter: mutable.filter,
      optionCount: mutable.options.length,
      visibleOptionCount,
      truncated,
      selected: mutable.selected,
      options,
      message,
      error: mutable.error,
      generation: mutable.generation,
    });
  }

  #buildSnapshot(): NumberingRuntimeSnapshotV11 {
    const path = cloneNumberingPathV11(this.#path());
    const levels = Object.freeze({
      district: this.#levelSnapshot('district'),
      neighborhood: this.#levelSnapshot('neighborhood'),
      street: this.#levelSnapshot('street'),
      door: this.#levelSnapshot('door'),
    });
    const activeLevel = NUMBERING_LEVELS_V11.find(level => levels[level].status === 'loading') ?? null;
    const busy = activeLevel !== null;
    const canReset = NUMBERING_LEVELS_V11.some(level => Boolean(levels[level].selected || levels[level].filter));
    return Object.freeze({
      version: NUMBERING_QUERY_VERSION_V11,
      disposed: this.#disposed,
      initialized: this.#initialized,
      sequence: this.#sequence,
      path,
      levels,
      activeLevel,
      busy,
      complete: selectionPathCompleteV11(path),
      canReset,
      pathLabel: numberingPathLabelV11(path),
      history: Object.freeze(this.#history.map(copyHistoryEntry)),
      metrics: frozenMetrics(this.#metrics),
    });
  }

  #publish(): void {
    this.#snapshot = this.#buildSnapshot();
    for (const observer of [...this.#observers]) {
      try {
        observer();
      } catch (error) {
        this.#metrics.observerFailures += 1;
        try {
          this.#effects.reportObserverError?.(error);
        } catch {
          // Observer diagnostics must never break the runtime.
        }
      }
    }
  }

  #begin(level: NumberingLevelV11, operation: string): RequestTokenV11 {
    const mutable = this.#levels[level];
    mutable.generation += 1;
    mutable.status = 'loading';
    mutable.error = '';
    mutable.message = statusMessage(level, 'loading');
    this.#sequence += 1;
    this.#metrics.requests += 1;
    const token = Object.freeze({
      sequence: this.#sequence,
      level,
      operation,
      generation: mutable.generation,
      startedAt: safeNumberingNowV11(this.#policy.clock),
    });
    this.#publish();
    return token;
  }

  #isCurrent(token: RequestTokenV11): boolean {
    return !this.#disposed
      && this.#levels[token.level].generation === token.generation;
  }

  #invalidateLevelAndDescendants(level: NumberingLevelV11): void {
    const index = NUMBERING_LEVELS_V11.indexOf(level);
    for (let cursor = index; cursor < NUMBERING_LEVELS_V11.length; cursor += 1) {
      const target = NUMBERING_LEVELS_V11[cursor];
      if (!target) continue;
      const mutable = this.#levels[target];
      if (mutable.status === 'loading') this.#metrics.cancellations += 1;
      mutable.generation += 1;
      if (target !== level) mutable.status = 'idle';
    }
  }

  #invalidateDescendants(level: NumberingLevelV11): void {
    for (const descendant of descendantsOfNumberingLevelV11(level)) {
      const mutable = this.#levels[descendant];
      if (mutable.status === 'loading') this.#metrics.cancellations += 1;
      mutable.generation += 1;
      mutable.status = 'idle';
      mutable.options = EMPTY_OPTIONS;
      mutable.selected = null;
      mutable.filter = '';
      mutable.error = '';
      mutable.message = '';
      mutable.sourceTruncated = false;
    }
  }

  #applyOptions(
    level: NumberingLevelV11,
    input: readonly NumberingFeatureV11[] | null | undefined,
  ): void {
    const keys = OPTION_KEYS[level];
    const normalized = normalizeNumberingOptionsV11(input, {
      valueKey: keys.valueKey,
      labelKey: keys.labelKey,
      maxOptions: this.#policy.maxOptionsPerLevel,
    });
    this.#levels[level].options = normalized.options;
    this.#levels[level].sourceTruncated = normalized.truncatedCount > 0;
    if (normalized.truncatedCount > 0) this.#metrics.optionTruncations += 1;
  }

  #succeedLevel(token: RequestTokenV11, itemCount: number): void {
    if (!this.#isCurrent(token)) {
      this.#recordStale(token);
      return;
    }
    const mutable = this.#levels[token.level];
    mutable.status = 'ready';
    mutable.error = '';
    mutable.message = '';
    this.#metrics.successes += 1;
    this.#recordHistory(token, 'success', itemCount, '');
    this.#publish();
  }

  #failLevel(
    token: RequestTokenV11,
    message: string,
    error?: unknown,
  ): void {
    if (!this.#isCurrent(token)) {
      this.#recordStale(token);
      return;
    }
    const mutable = this.#levels[token.level];
    mutable.status = 'error';
    mutable.error = message;
    mutable.message = '';
    this.#metrics.failures += 1;
    this.#recordHistory(token, 'failure', 0, errorNameV11(error));
    this.#reportError(error ?? new Error(message), token, message);
    this.#publish();
  }

  #recordStale(token: RequestTokenV11): void {
    this.#metrics.staleResponses += 1;
    this.#recordHistory(token, 'stale', 0, '');
  }

  #recordHistory(
    token: RequestTokenV11,
    outcome: NumberingHistoryEntryV11['outcome'],
    itemCount: number,
    errorName: string,
  ): void {
    if (this.#policy.maxHistory <= 0) return;
    this.#history.push(Object.freeze({
      sequence: token.sequence,
      level: token.level,
      operation: token.operation,
      outcome,
      startedAt: token.startedAt,
      completedAt: safeNumberingNowV11(this.#policy.clock),
      itemCount: Math.max(0, itemCount),
      errorName,
    }));
    if (this.#history.length > this.#policy.maxHistory) {
      this.#history.splice(0, this.#history.length - this.#policy.maxHistory);
    }
  }

  #reportError(error: unknown, token: RequestTokenV11, fallback: string): void {
    try {
      this.#effects.reportError?.(error, Object.freeze({
        level: token.level,
        operation: token.operation,
        fallback,
        sequence: token.sequence,
      }));
    } catch {
      // Error reporting is intentionally isolated from query state.
    }
  }

  async #focus(
    geometries: readonly unknown[],
    level: NumberingLevelV11,
    selection: NumberingSelectionV11,
    sequence: number,
    zoomLevel: number | null,
  ): Promise<void> {
    if (geometries.length === 0 || !this.#effects.focusGeometries) return;
    this.#metrics.focusRequests += 1;
    try {
      await this.#effects.focusGeometries(geometries, Object.freeze({
        level,
        selection,
        zoomLevel,
        sequence,
      }));
    } catch (error) {
      const token: RequestTokenV11 = Object.freeze({
        sequence,
        level,
        operation: 'focus-geometries',
        generation: this.#levels[level].generation,
        startedAt: safeNumberingNowV11(this.#policy.clock),
      });
      this.#reportError(error, token, 'Adres konumu haritada gösterilemedi.');
    }
  }

  async #logSelection(level: NumberingLevelV11, sequence: number): Promise<void> {
    if (!this.#effects.logSelection) return;
    try {
      await this.#effects.logSelection(cloneNumberingPathV11(this.#path()), Object.freeze({
        sequence,
        level,
      }));
    } catch {
      // Client logging must not block address interaction.
    }
  }

  #replaceSelection(level: NumberingLevelV11, selection: NumberingSelectionV11): void {
    this.#levels[level].selected = selection;
    this.#levels[level].error = '';
    this.#levels[level].message = '';
    this.#levels[level].filter = '';
    this.#invalidateDescendants(level);
  }

  async #selectDistrict(selection: NumberingSelectionV11): Promise<void> {
    this.#replaceSelection('district', selection);
    const token = this.#begin('district', 'select-district');
    const settled = await Promise.allSettled([
      this.#transport.loadDistrict(selection.value),
      this.#transport.loadNeighborhoods(selection.value),
    ]);
    if (!this.#isCurrent(token)) {
      this.#recordStale(token);
      return;
    }

    const districtResult = settled[0];
    const neighborhoodsResult = settled[1];
    let listSucceeded = false;

    if (districtResult?.status === 'fulfilled') {
      if (isSuccess(districtResult.value)) {
        const geometries = geometriesFromFeaturesV11(districtResult.value.data);
        void this.#focus(geometries, 'district', selection, token.sequence, null);
      } else {
        this.#reportError(
          new Error(serviceMessageV11(districtResult.value, fallbackForLevel('district', 'detail'))),
          token,
          fallbackForLevel('district', 'detail'),
        );
      }
    } else if (districtResult && isPromiseRejected(districtResult)) {
      this.#reportError(districtResult.reason, token, fallbackForLevel('district', 'detail'));
    }

    if (neighborhoodsResult?.status === 'fulfilled' && isSuccess(neighborhoodsResult.value)) {
      this.#applyOptions('neighborhood', neighborhoodsResult.value.data);
      listSucceeded = true;
    } else {
      const error = neighborhoodsResult?.status === 'rejected'
        ? neighborhoodsResult.reason
        : new Error(serviceMessageV11(
          neighborhoodsResult?.status === 'fulfilled' ? neighborhoodsResult.value : null,
          fallbackForLevel('neighborhood', 'list'),
        ));
      this.#levels.neighborhood.options = EMPTY_OPTIONS;
      this.#levels.neighborhood.error = errorMessageV11(error, fallbackForLevel('neighborhood', 'list'));
      this.#reportError(error, token, fallbackForLevel('neighborhood', 'list'));
    }

    if (listSucceeded) this.#succeedLevel(token, this.#levels.neighborhood.options.length);
    else this.#failLevel(token, this.#levels.neighborhood.error || fallbackForLevel('neighborhood', 'list'));
  }

  async #selectNeighborhood(selection: NumberingSelectionV11): Promise<void> {
    this.#replaceSelection('neighborhood', selection);
    const token = this.#begin('neighborhood', 'select-neighborhood');
    const settled = await Promise.allSettled([
      this.#transport.loadNeighborhood(selection.value),
      this.#transport.loadStreets(selection.value),
    ]);
    if (!this.#isCurrent(token)) {
      this.#recordStale(token);
      return;
    }

    const detailResult = settled[0];
    const streetsResult = settled[1];
    let listSucceeded = false;

    if (detailResult?.status === 'fulfilled') {
      if (isSuccess(detailResult.value)) {
        const geometries = geometriesFromFeaturesV11(detailResult.value.data);
        void this.#focus(geometries, 'neighborhood', selection, token.sequence, null);
      } else {
        this.#reportError(
          new Error(serviceMessageV11(detailResult.value, fallbackForLevel('neighborhood', 'detail'))),
          token,
          fallbackForLevel('neighborhood', 'detail'),
        );
      }
    } else if (detailResult && isPromiseRejected(detailResult)) {
      this.#reportError(detailResult.reason, token, fallbackForLevel('neighborhood', 'detail'));
    }

    if (streetsResult?.status === 'fulfilled' && isSuccess(streetsResult.value)) {
      this.#applyOptions('street', streetsResult.value.data);
      listSucceeded = true;
    } else {
      const error = streetsResult?.status === 'rejected'
        ? streetsResult.reason
        : new Error(serviceMessageV11(
          streetsResult?.status === 'fulfilled' ? streetsResult.value : null,
          fallbackForLevel('street', 'list'),
        ));
      this.#levels.street.options = EMPTY_OPTIONS;
      this.#levels.street.error = errorMessageV11(error, fallbackForLevel('street', 'list'));
      this.#reportError(error, token, fallbackForLevel('street', 'list'));
    }

    if (listSucceeded) this.#succeedLevel(token, this.#levels.street.options.length);
    else this.#failLevel(token, this.#levels.street.error || fallbackForLevel('street', 'list'));
  }

  async #selectStreet(selection: NumberingSelectionV11): Promise<void> {
    this.#replaceSelection('street', selection);
    const token = this.#begin('street', 'select-street');
    const settled = await Promise.allSettled([
      this.#transport.loadStreetGeometries(selection.value),
      this.#transport.loadDoors(selection.value),
    ]);
    if (!this.#isCurrent(token)) {
      this.#recordStale(token);
      return;
    }

    const geometryResult = settled[0];
    const doorsResult = settled[1];
    let listSucceeded = false;

    if (geometryResult?.status === 'fulfilled') {
      const geometries = geometriesFromFeaturesV11(geometryResult.value);
      void this.#focus(geometries, 'street', selection, token.sequence, null);
    } else if (geometryResult && isPromiseRejected(geometryResult)) {
      this.#reportError(geometryResult.reason, token, fallbackForLevel('street', 'detail'));
    }

    if (doorsResult?.status === 'fulfilled' && isSuccess(doorsResult.value)) {
      this.#applyOptions('door', doorsResult.value.data);
      listSucceeded = true;
    } else {
      const error = doorsResult?.status === 'rejected'
        ? doorsResult.reason
        : new Error(serviceMessageV11(
          doorsResult?.status === 'fulfilled' ? doorsResult.value : null,
          fallbackForLevel('door', 'list'),
        ));
      this.#levels.door.options = EMPTY_OPTIONS;
      this.#levels.door.error = errorMessageV11(error, fallbackForLevel('door', 'list'));
      this.#reportError(error, token, fallbackForLevel('door', 'list'));
    }

    if (listSucceeded) this.#succeedLevel(token, this.#levels.door.options.length);
    else this.#failLevel(token, this.#levels.door.error || fallbackForLevel('door', 'list'));
  }

  async #selectDoor(selection: NumberingSelectionV11): Promise<void> {
    this.#levels.door.selected = selection;
    this.#levels.door.filter = '';
    const token = this.#begin('door', 'select-door');
    void this.#logSelection('door', token.sequence);
    try {
      const result = await this.#transport.loadDoor(selection.value);
      if (!this.#isCurrent(token)) {
        this.#recordStale(token);
        return;
      }
      if (!isSuccess(result)) {
        this.#failLevel(token, serviceMessageV11(result, fallbackForLevel('door', 'detail')));
        return;
      }
      const geometries = geometriesFromFeaturesV11(result.data);
      if (geometries.length === 0) {
        this.#failLevel(token, 'Bina konumu bulunamadı.');
        return;
      }
      await this.#focus(geometries, 'door', selection, token.sequence, 18);
      if (!this.#isCurrent(token)) {
        this.#recordStale(token);
        return;
      }
      this.#succeedLevel(token, geometries.length);
    } catch (error) {
      if (!this.#isCurrent(token)) {
        this.#recordStale(token);
        return;
      }
      this.#failLevel(token, errorMessageV11(error, fallbackForLevel('door', 'detail')), error);
    }
  }
}

export const createNumberingQueryRuntimeV11 = (
  transport: NumberingTransportV11,
  effects: NumberingRuntimeEffectsV11 = {},
  policy: NumberingRuntimePolicyV11 = {},
): NumberingQueryRuntimeV11 => new NumberingQueryRuntimeV11(transport, effects, policy);

export const numberingRuntimeLevelLabelV11 = numberingLevelLabelV11;
