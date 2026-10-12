import { normalizeInteger, normalizeSearchText, normalizeText } from '../../../data-search/normalization';

export const NUMBERING_QUERY_VERSION_V11 = '2026-10-12.v11' as const;

export type NumberingLevelV11 = 'district' | 'neighborhood' | 'street' | 'door';
export type NumberingStatusV11 = 'idle' | 'loading' | 'ready' | 'error' | 'disposed';

export const NUMBERING_LEVELS_V11: readonly NumberingLevelV11[] = Object.freeze([
  'district',
  'neighborhood',
  'street',
  'door',
]);

export interface NumberingFeatureV11 {
  readonly attr?: Readonly<Record<string, unknown>> | null;
  readonly geometry?: unknown;
}

export interface NumberingServiceResultV11 {
  readonly type?: unknown;
  readonly data?: readonly NumberingFeatureV11[] | null;
  readonly message?: unknown;
  readonly errorMessage?: unknown;
}

export interface NumberingOptionV11 {
  readonly value: string;
  readonly label: string;
  readonly searchLabel: string;
  readonly sourceIndex: number;
}

export interface NumberingSelectionV11 {
  readonly value: string;
  readonly label: string;
}

export interface NumberingPathV11 {
  readonly district: NumberingSelectionV11 | null;
  readonly neighborhood: NumberingSelectionV11 | null;
  readonly street: NumberingSelectionV11 | null;
  readonly door: NumberingSelectionV11 | null;
}

export interface NumberingLevelStateV11 {
  readonly level: NumberingLevelV11;
  readonly status: NumberingStatusV11;
  readonly filter: string;
  readonly optionCount: number;
  readonly visibleOptionCount: number;
  readonly truncated: boolean;
  readonly selected: NumberingSelectionV11 | null;
  readonly options: readonly NumberingOptionV11[];
  readonly message: string;
  readonly error: string;
  readonly generation: number;
}

export interface NumberingHistoryEntryV11 {
  readonly sequence: number;
  readonly level: NumberingLevelV11;
  readonly operation: string;
  readonly outcome: 'success' | 'failure' | 'stale' | 'cancelled';
  readonly startedAt: number;
  readonly completedAt: number;
  readonly itemCount: number;
  readonly errorName: string;
}

export interface NumberingRuntimeMetricsV11 {
  readonly requests: number;
  readonly successes: number;
  readonly failures: number;
  readonly staleResponses: number;
  readonly cancellations: number;
  readonly focusRequests: number;
  readonly observerFailures: number;
  readonly optionTruncations: number;
}

export interface NumberingRuntimeSnapshotV11 {
  readonly version: typeof NUMBERING_QUERY_VERSION_V11;
  readonly disposed: boolean;
  readonly initialized: boolean;
  readonly sequence: number;
  readonly path: NumberingPathV11;
  readonly levels: Readonly<Record<NumberingLevelV11, NumberingLevelStateV11>>;
  readonly activeLevel: NumberingLevelV11 | null;
  readonly busy: boolean;
  readonly complete: boolean;
  readonly canReset: boolean;
  readonly pathLabel: string;
  readonly history: readonly NumberingHistoryEntryV11[];
  readonly metrics: NumberingRuntimeMetricsV11;
}

export interface NumberingRuntimePolicyV11 {
  readonly maxOptionsPerLevel?: number;
  readonly maxVisibleOptions?: number;
  readonly maxFilterLength?: number;
  readonly maxHistory?: number;
  readonly maxObservers?: number;
  readonly minimumFilterLengthForOverflow?: number;
  readonly clock?: () => number;
}

export interface NormalizedNumberingRuntimePolicyV11 {
  readonly maxOptionsPerLevel: number;
  readonly maxVisibleOptions: number;
  readonly maxFilterLength: number;
  readonly maxHistory: number;
  readonly maxObservers: number;
  readonly minimumFilterLengthForOverflow: number;
  readonly clock: () => number;
}

export interface NumberingTransportV11 {
  readonly loadDistricts: () => Promise<NumberingServiceResultV11>;
  readonly loadDistrict: (districtId: string) => Promise<NumberingServiceResultV11>;
  readonly loadNeighborhoods: (districtId: string) => Promise<NumberingServiceResultV11>;
  readonly loadNeighborhood: (neighborhoodId: string) => Promise<NumberingServiceResultV11>;
  readonly loadStreets: (neighborhoodId: string) => Promise<NumberingServiceResultV11>;
  readonly loadStreetGeometries: (streetId: string) => Promise<readonly NumberingFeatureV11[]>;
  readonly loadDoors: (streetId: string) => Promise<NumberingServiceResultV11>;
  readonly loadDoor: (doorId: string) => Promise<NumberingServiceResultV11>;
}

export interface NumberingFocusContextV11 {
  readonly level: NumberingLevelV11;
  readonly selection: NumberingSelectionV11;
  readonly zoomLevel: number | null;
  readonly sequence: number;
}

export interface NumberingRuntimeEffectsV11 {
  readonly focusGeometries?: (
    geometries: readonly unknown[],
    context: NumberingFocusContextV11,
  ) => Promise<void> | void;
  readonly logSelection?: (
    path: NumberingPathV11,
    context: Readonly<{ sequence: number; level: NumberingLevelV11 }>,
  ) => Promise<void> | void;
  readonly reportError?: (
    error: unknown,
    context: Readonly<{
      level: NumberingLevelV11;
      operation: string;
      fallback: string;
      sequence: number;
    }>,
  ) => void;
  readonly reportObserverError?: (error: unknown) => void;
}

export interface NumberingOptionReadPolicyV11 {
  readonly valueKey: string;
  readonly labelKey: string;
  readonly maxOptions: number;
}

export interface NumberingOptionNormalizationV11 {
  readonly options: readonly NumberingOptionV11[];
  readonly inputCount: number;
  readonly outputCount: number;
  readonly duplicateCount: number;
  readonly invalidCount: number;
  readonly truncatedCount: number;
}

export interface NumberingFilterResultV11 {
  readonly options: readonly NumberingOptionV11[];
  readonly totalMatches: number;
  readonly truncated: boolean;
}

const DEFAULT_MAX_OPTIONS = 20_000;
const DEFAULT_MAX_VISIBLE_OPTIONS = 240;
const DEFAULT_MAX_FILTER_LENGTH = 120;
const DEFAULT_MAX_HISTORY = 80;
const DEFAULT_MAX_OBSERVERS = 32;
const DEFAULT_MIN_FILTER_FOR_OVERFLOW = 2;

const freezeSelection = (
  selection: NumberingSelectionV11 | null,
): NumberingSelectionV11 | null => selection
  ? Object.freeze({ value: selection.value, label: selection.label })
  : null;

export const emptyNumberingPathV11 = (): NumberingPathV11 => Object.freeze({
  district: null,
  neighborhood: null,
  street: null,
  door: null,
});

export const cloneNumberingPathV11 = (
  path: NumberingPathV11,
): NumberingPathV11 => Object.freeze({
  district: freezeSelection(path.district),
  neighborhood: freezeSelection(path.neighborhood),
  street: freezeSelection(path.street),
  door: freezeSelection(path.door),
});

export const safeNumberingNowV11 = (clock: () => number): number => {
  const value = Number(clock());
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now();
};

export const normalizeNumberingRuntimePolicyV11 = (
  policy: NumberingRuntimePolicyV11 = {},
): NormalizedNumberingRuntimePolicyV11 => {
  const maxOptionsPerLevel = normalizeInteger(policy.maxOptionsPerLevel, {
    min: 100,
    max: 100_000,
    fallback: DEFAULT_MAX_OPTIONS,
  });
  const maxVisibleOptions = normalizeInteger(policy.maxVisibleOptions, {
    min: 20,
    max: Math.min(2_000, maxOptionsPerLevel),
    fallback: Math.min(DEFAULT_MAX_VISIBLE_OPTIONS, maxOptionsPerLevel),
  });
  return Object.freeze({
    maxOptionsPerLevel,
    maxVisibleOptions,
    maxFilterLength: normalizeInteger(policy.maxFilterLength, {
      min: 16,
      max: 500,
      fallback: DEFAULT_MAX_FILTER_LENGTH,
    }),
    maxHistory: normalizeInteger(policy.maxHistory, {
      min: 0,
      max: 2_000,
      fallback: DEFAULT_MAX_HISTORY,
    }),
    maxObservers: normalizeInteger(policy.maxObservers, {
      min: 1,
      max: 256,
      fallback: DEFAULT_MAX_OBSERVERS,
    }),
    minimumFilterLengthForOverflow: normalizeInteger(policy.minimumFilterLengthForOverflow, {
      min: 0,
      max: 12,
      fallback: DEFAULT_MIN_FILTER_FOR_OVERFLOW,
    }),
    clock: typeof policy.clock === 'function' ? policy.clock : () => Date.now(),
  });
};

export const normalizeNumberingIdentityV11 = (value: unknown): string => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return normalizeText(value).slice(0, 180);
};

export const normalizeNumberingLabelV11 = (value: unknown): string =>
  normalizeText(value).slice(0, 300);

export const normalizeNumberingFilterV11 = (
  value: unknown,
  maximumLength = DEFAULT_MAX_FILTER_LENGTH,
): string => normalizeText(value).slice(0, Math.max(1, maximumLength));

export const searchNumberingLabelV11 = (value: unknown): string =>
  normalizeSearchText(value).slice(0, 400);

export const readNumberingOptionV11 = (
  feature: NumberingFeatureV11,
  valueKey: string,
  labelKey: string,
  sourceIndex: number,
): NumberingOptionV11 | null => {
  const attributes = feature.attr ?? {};
  const value = normalizeNumberingIdentityV11(attributes[valueKey]);
  if (!value) return null;
  const label = normalizeNumberingLabelV11(attributes[labelKey]) || value;
  return Object.freeze({
    value,
    label,
    searchLabel: searchNumberingLabelV11(label),
    sourceIndex,
  });
};

export const normalizeNumberingOptionsV11 = (
  input: readonly NumberingFeatureV11[] | null | undefined,
  policy: NumberingOptionReadPolicyV11,
): NumberingOptionNormalizationV11 => {
  const source = Array.isArray(input) ? input : [];
  const maximum = Math.max(1, policy.maxOptions);
  const seen = new Set<string>();
  const options: NumberingOptionV11[] = [];
  let duplicateCount = 0;
  let invalidCount = 0;
  let truncatedCount = 0;

  for (let index = 0; index < source.length; index += 1) {
    const feature = source[index];
    if (!feature) {
      invalidCount += 1;
      continue;
    }
    const option = readNumberingOptionV11(
      feature,
      policy.valueKey,
      policy.labelKey,
      index,
    );
    if (!option) {
      invalidCount += 1;
      continue;
    }
    if (seen.has(option.value)) {
      duplicateCount += 1;
      continue;
    }
    if (options.length >= maximum) {
      truncatedCount += 1;
      continue;
    }
    seen.add(option.value);
    options.push(option);
  }

  return Object.freeze({
    options: Object.freeze(options),
    inputCount: source.length,
    outputCount: options.length,
    duplicateCount,
    invalidCount,
    truncatedCount,
  });
};

export const filterNumberingOptionsV11 = (
  options: readonly NumberingOptionV11[],
  filterInput: unknown,
  maximumVisible: number,
): NumberingFilterResultV11 => {
  const filter = searchNumberingLabelV11(filterInput);
  const visible: NumberingOptionV11[] = [];
  let totalMatches = 0;
  const maximum = Math.max(1, maximumVisible);

  for (const option of options) {
    if (filter && !option.searchLabel.includes(filter)) continue;
    totalMatches += 1;
    if (visible.length < maximum) visible.push(option);
  }

  return Object.freeze({
    options: Object.freeze(visible),
    totalMatches,
    truncated: totalMatches > visible.length,
  });
};

export const findNumberingOptionV11 = (
  options: readonly NumberingOptionV11[],
  valueInput: unknown,
): NumberingOptionV11 | null => {
  const value = normalizeNumberingIdentityV11(valueInput);
  if (!value) return null;
  return options.find(option => option.value === value) ?? null;
};

export const numberingSelectionFromOptionV11 = (
  option: NumberingOptionV11 | null,
): NumberingSelectionV11 | null => option
  ? Object.freeze({ value: option.value, label: option.label })
  : null;

export const numberingPathLabelV11 = (path: NumberingPathV11): string =>
  NUMBERING_LEVELS_V11
    .map(level => path[level]?.label ?? '')
    .filter(Boolean)
    .join(' / ');

export const descendantsOfNumberingLevelV11 = (
  level: NumberingLevelV11,
): readonly NumberingLevelV11[] => {
  const index = NUMBERING_LEVELS_V11.indexOf(level);
  return index < 0
    ? Object.freeze([])
    : Object.freeze(NUMBERING_LEVELS_V11.slice(index + 1));
};

export const levelAndDescendantsV11 = (
  level: NumberingLevelV11,
): readonly NumberingLevelV11[] => Object.freeze([
  level,
  ...descendantsOfNumberingLevelV11(level),
]);

export const numberingLevelLabelV11 = (level: NumberingLevelV11): string => {
  if (level === 'district') return 'İlçe';
  if (level === 'neighborhood') return 'Mahalle';
  if (level === 'street') return 'Cadde / Sokak';
  return 'Bina No';
};

export const selectionPathCompleteV11 = (path: NumberingPathV11): boolean =>
  Boolean(path.district && path.neighborhood && path.street && path.door);

export const errorNameV11 = (error: unknown): string => {
  if (error instanceof Error) return normalizeText(error.name || 'Error').slice(0, 80) || 'Error';
  return 'Error';
};

export const errorMessageV11 = (error: unknown, fallback: string): string => {
  if (error instanceof Error) {
    const message = normalizeText(error.message);
    if (message) return message.slice(0, 500);
  }
  const text = normalizeText(error);
  return text ? text.slice(0, 500) : fallback;
};

export const serviceMessageV11 = (
  result: NumberingServiceResultV11 | null | undefined,
  fallback: string,
): string => {
  const preferred = normalizeText(result?.message);
  if (preferred) return preferred.slice(0, 500);
  const secondary = normalizeText(result?.errorMessage);
  return secondary ? secondary.slice(0, 500) : fallback;
};

export const geometriesFromFeaturesV11 = (
  input: readonly NumberingFeatureV11[] | null | undefined,
  maximum = 10_000,
): readonly unknown[] => {
  const source = Array.isArray(input) ? input : [];
  const output: unknown[] = [];
  const limit = Math.max(1, maximum);
  for (const feature of source) {
    const geometry = feature?.geometry;
    if (geometry === null || geometry === undefined) continue;
    output.push(geometry);
    if (output.length >= limit) break;
  }
  return Object.freeze(output);
};

export const selectionEqualsV11 = (
  left: NumberingSelectionV11 | null,
  right: NumberingSelectionV11 | null,
): boolean => left?.value === right?.value && left?.label === right?.label;
