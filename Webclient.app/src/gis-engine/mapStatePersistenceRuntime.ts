import {
  createDeterministicFingerprint,
  normalizeIdentifier,
  positiveInteger,
} from './runtimeContracts';

export type GisMapMode = '2d' | '3d';

export interface GisMapViewState {
  readonly mode: GisMapMode;
  readonly center: readonly [number, number] | readonly [number, number, number];
  readonly spatialReferenceWkid: number;
  readonly scale?: number | null;
  readonly zoom?: number | null;
  readonly rotation?: number | null;
  readonly tilt?: number | null;
}

export interface GisPersistedLayerState {
  readonly layerId: string;
  readonly visible: boolean;
  readonly opacity: number;
  readonly order: number;
  readonly minScale?: number | null;
  readonly maxScale?: number | null;
}

export interface GisPersistedTemporalState {
  readonly cursor: number;
  readonly start: number;
  readonly end: number;
  readonly playing?: boolean;
  readonly direction?: 1 | -1;
  readonly stepMs?: number;
  readonly windowMs?: number;
}

export interface GisPersistedSelectionState {
  readonly layerId: string;
  readonly featureIds: readonly (string | number)[];
}

export interface GisMapSessionInput {
  readonly view: GisMapViewState;
  readonly basemapId?: string | null;
  readonly layers?: readonly GisPersistedLayerState[];
  readonly temporal?: GisPersistedTemporalState | null;
  readonly selections?: readonly GisPersistedSelectionState[];
  readonly workspace?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface GisMapSessionState {
  readonly schemaVersion: 1;
  readonly capturedAt: number;
  readonly expiresAt: number | null;
  readonly fingerprint: string;
  readonly view: GisMapViewState;
  readonly basemapId: string | null;
  readonly layers: readonly GisPersistedLayerState[];
  readonly temporal: GisPersistedTemporalState | null;
  readonly selections: readonly GisPersistedSelectionState[];
  readonly workspace: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface GisMapStateStorage {
  readonly getItem: (key: string) => string | null | Promise<string | null>;
  readonly setItem: (key: string, value: string) => void | Promise<void>;
  readonly removeItem: (key: string) => void | Promise<void>;
}

export interface GisMapStatePersistenceConfiguration {
  readonly now?: () => number;
  readonly storage?: GisMapStateStorage | null;
  readonly keyPrefix?: string;
  readonly ttlMs?: number;
  readonly maxEncodedLength?: number;
  readonly maxLayers?: number;
  readonly maxSelections?: number;
  readonly maxSelectionIdsPerLayer?: number;
  readonly maxMetadataDepth?: number;
  readonly maxMetadataKeys?: number;
  readonly maxMetadataStringLength?: number;
}

export interface GisMapStateDecodeResult {
  readonly state: GisMapSessionState;
  readonly expired: boolean;
}

export interface GisMapStatePersistenceRuntime {
  capture: (input: GisMapSessionInput) => GisMapSessionState;
  encode: (state: GisMapSessionState) => string;
  decode: (encoded: string, options?: { readonly allowExpired?: boolean }) => GisMapStateDecodeResult;
  save: (key: unknown, state: GisMapSessionState) => Promise<string>;
  load: (
    key: unknown,
    options?: { readonly allowExpired?: boolean },
  ) => Promise<GisMapStateDecodeResult | null>;
  remove: (key: unknown) => Promise<void>;
  storageKey: (key: unknown) => string;
}

const SECRET_KEY_PATTERN = /(?:token|secret|password|passwd|authorization|cookie|credential|api[-_]?key|client[-_]?secret)/i;
const DEFAULT_MAX_ENCODED_LENGTH = 32 * 1024;
const DEFAULT_MAX_LAYERS = 256;
const DEFAULT_MAX_SELECTIONS = 64;
const DEFAULT_MAX_SELECTION_IDS = 1000;
const DEFAULT_METADATA_DEPTH = 8;
const DEFAULT_METADATA_KEYS = 256;
const DEFAULT_METADATA_STRING = 4096;

const finite = (value: unknown, label: string): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new TypeError(`${label} must be finite.`);
  return numeric;
};

const finiteOptional = (
  value: unknown,
  label: string,
): number | null => {
  if (value === undefined || value === null || value === '') return null;
  return finite(value, label);
};

const clamp = (value: number, minimum: number, maximum: number): number => (
  Math.min(maximum, Math.max(minimum, value))
);

const normalizeWkid = (value: unknown): number => {
  const numeric = Math.trunc(finite(value, 'Spatial reference WKID'));
  if (numeric <= 0 || numeric > 10_000_000) {
    throw new RangeError('Spatial reference WKID is outside the supported range.');
  }
  return numeric;
};

const normalizeCoordinate = (value: unknown, label: string): number => {
  const numeric = finite(value, label);
  if (Math.abs(numeric) > 1_000_000_000) {
    throw new RangeError(`${label} is outside the supported coordinate range.`);
  }
  return numeric;
};

const normalizeCenter = (
  value: GisMapViewState['center'],
): GisMapViewState['center'] => {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)) {
    throw new TypeError('Map center must contain two or three finite coordinates.');
  }
  const x = normalizeCoordinate(value[0], 'Map center x');
  const y = normalizeCoordinate(value[1], 'Map center y');
  if (value.length === 2) return Object.freeze([x, y] as const);
  const z = normalizeCoordinate(value[2], 'Map center z');
  return Object.freeze([x, y, z] as const);
};

const normalizeView = (view: GisMapViewState): GisMapViewState => {
  if (!view || (view.mode !== '2d' && view.mode !== '3d')) {
    throw new TypeError('Map mode must be either 2d or 3d.');
  }

  const scale = finiteOptional(view.scale, 'Map scale');
  const zoom = finiteOptional(view.zoom, 'Map zoom');
  const rotation = finiteOptional(view.rotation, 'Map rotation');
  const tilt = finiteOptional(view.tilt, 'Map tilt');

  if (scale !== null && scale <= 0) throw new RangeError('Map scale must be positive.');
  if (zoom !== null && zoom < 0) throw new RangeError('Map zoom cannot be negative.');

  return Object.freeze({
    mode: view.mode,
    center: normalizeCenter(view.center),
    spatialReferenceWkid: normalizeWkid(view.spatialReferenceWkid),
    ...(scale === null ? {} : { scale }),
    ...(zoom === null ? {} : { zoom }),
    ...(rotation === null ? {} : { rotation: ((rotation % 360) + 360) % 360 }),
    ...(view.mode !== '3d' || tilt === null ? {} : { tilt: clamp(tilt, 0, 180) }),
  });
};

const normalizeFeatureId = (value: unknown): string | number => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Selected feature ids must be finite.');
    return value;
  }
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError('Selected feature ids cannot be blank.');
  if (normalized.length > 512) throw new RangeError('Selected feature id is too long.');
  return normalized;
};

const sanitizeMetadata = (
  value: unknown,
  limits: Readonly<{
    depth: number;
    keys: number;
    stringLength: number;
  }>,
): Readonly<Record<string, unknown>> => {
  let keyCount = 0;
  const seen = new Set<object>();

  const visit = (candidate: unknown, depth: number): unknown => {
    if (depth > limits.depth) {
      throw new RangeError('Map state metadata exceeds the configured nesting budget.');
    }

    if (
      candidate === null
      || typeof candidate === 'boolean'
      || typeof candidate === 'number'
    ) {
      if (typeof candidate === 'number' && !Number.isFinite(candidate)) {
        throw new TypeError('Map state metadata numbers must be finite.');
      }
      return candidate;
    }

    if (typeof candidate === 'string') {
      return candidate.slice(0, limits.stringLength);
    }

    if (candidate === undefined) return null;

    if (typeof candidate === 'function' || typeof candidate === 'symbol' || typeof candidate === 'bigint') {
      throw new TypeError('Map state metadata contains a non-serializable value.');
    }

    if (Array.isArray(candidate)) {
      if (seen.has(candidate)) throw new TypeError('Map state metadata cannot contain cycles.');
      seen.add(candidate);
      const output = candidate.slice(0, limits.keys).map((entry) => visit(entry, depth + 1));
      seen.delete(candidate);
      return Object.freeze(output);
    }

    if (typeof candidate === 'object') {
      const objectValue = candidate as Record<string, unknown>;
      if (seen.has(objectValue)) throw new TypeError('Map state metadata cannot contain cycles.');
      seen.add(objectValue);
      const output: Record<string, unknown> = {};
      for (const [rawKey, entry] of Object.entries(objectValue)) {
        const key = String(rawKey).trim();
        if (!key || SECRET_KEY_PATTERN.test(key)) continue;
        keyCount += 1;
        if (keyCount > limits.keys) {
          throw new RangeError('Map state metadata exceeds the configured key budget.');
        }
        output[key] = visit(entry, depth + 1);
      }
      seen.delete(objectValue);
      return Object.freeze(output);
    }

    throw new TypeError('Map state metadata contains an unsupported value.');
  };

  const sanitized = visit(value ?? {}, 0);
  return (
    sanitized !== null
    && typeof sanitized === 'object'
    && !Array.isArray(sanitized)
      ? sanitized as Readonly<Record<string, unknown>>
      : Object.freeze({})
  );
};

const normalizeLayer = (
  input: GisPersistedLayerState,
): GisPersistedLayerState => {
  const layerId = normalizeIdentifier(input.layerId, 'layerId');
  const opacity = clamp(finite(input.opacity, 'Layer opacity'), 0, 1);
  const order = Math.max(0, Math.trunc(finite(input.order, 'Layer order')));
  const minScale = finiteOptional(input.minScale, 'Layer minimum scale');
  const maxScale = finiteOptional(input.maxScale, 'Layer maximum scale');

  if (minScale !== null && minScale < 0) throw new RangeError('Layer minimum scale cannot be negative.');
  if (maxScale !== null && maxScale < 0) throw new RangeError('Layer maximum scale cannot be negative.');

  return Object.freeze({
    layerId,
    visible: input.visible !== false,
    opacity,
    order,
    ...(minScale === null ? {} : { minScale }),
    ...(maxScale === null ? {} : { maxScale }),
  });
};

const normalizeTemporal = (
  input: GisPersistedTemporalState | null | undefined,
): GisPersistedTemporalState | null => {
  if (!input) return null;
  const start = Math.trunc(finite(input.start, 'Temporal start'));
  const end = Math.trunc(finite(input.end, 'Temporal end'));
  if (end < start) throw new RangeError('Temporal end cannot be earlier than start.');
  const cursor = clamp(Math.trunc(finite(input.cursor, 'Temporal cursor')), start, end);
  const stepMs = input.stepMs === undefined
    ? undefined
    : positiveInteger(input.stepMs, 1, 365 * 24 * 60 * 60 * 1000);
  const windowMs = input.windowMs === undefined
    ? undefined
    : Math.max(0, Math.trunc(finite(input.windowMs, 'Temporal window')));

  return Object.freeze({
    cursor,
    start,
    end,
    ...(input.playing === undefined ? {} : { playing: input.playing === true }),
    ...(input.direction === undefined ? {} : { direction: input.direction === -1 ? -1 : 1 }),
    ...(stepMs === undefined ? {} : { stepMs }),
    ...(windowMs === undefined ? {} : { windowMs }),
  });
};

const normalizeWorkspace = (value: unknown): string | null => {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > 512) throw new RangeError('Workspace identifier is too long.');
  return normalized;
};

const safeParse = (encoded: string): unknown => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw new Error('Encoded GIS map state is not valid URI data.');
  }
  try {
    return JSON.parse(decoded);
  } catch {
    throw new Error('Encoded GIS map state is not valid JSON.');
  }
};

export const createGisMapStatePersistenceRuntime = (
  configuration: GisMapStatePersistenceConfiguration = {},
): GisMapStatePersistenceRuntime => {
  const now = typeof configuration.now === 'function' ? configuration.now : () => Date.now();
  const storage = configuration.storage ?? null;
  const keyPrefix = String(configuration.keyPrefix ?? 'kent-rehberi:map-state:').trim();
  const ttlMs = configuration.ttlMs === undefined
    ? 0
    : Math.max(0, Math.trunc(finite(configuration.ttlMs, 'Map state TTL')));
  const maxEncodedLength = positiveInteger(
    configuration.maxEncodedLength,
    DEFAULT_MAX_ENCODED_LENGTH,
    1024 * 1024,
  );
  const maxLayers = positiveInteger(configuration.maxLayers, DEFAULT_MAX_LAYERS, 10_000);
  const maxSelections = positiveInteger(
    configuration.maxSelections,
    DEFAULT_MAX_SELECTIONS,
    10_000,
  );
  const maxSelectionIdsPerLayer = positiveInteger(
    configuration.maxSelectionIdsPerLayer,
    DEFAULT_MAX_SELECTION_IDS,
    100_000,
  );
  const metadataLimits = Object.freeze({
    depth: positiveInteger(configuration.maxMetadataDepth, DEFAULT_METADATA_DEPTH, 64),
    keys: positiveInteger(configuration.maxMetadataKeys, DEFAULT_METADATA_KEYS, 10_000),
    stringLength: positiveInteger(
      configuration.maxMetadataStringLength,
      DEFAULT_METADATA_STRING,
      1024 * 1024,
    ),
  });

  const storageKey = (key: unknown): string => (
    `${keyPrefix}${normalizeIdentifier(key, 'mapStateKey')}`
  );

  const capture = (input: GisMapSessionInput): GisMapSessionState => {
    const layerInputs = input.layers ?? [];
    if (layerInputs.length > maxLayers) {
      throw new RangeError(`Map state layer budget exceeded (${maxLayers}).`);
    }

    const selectionInputs = input.selections ?? [];
    if (selectionInputs.length > maxSelections) {
      throw new RangeError(`Map state selection-layer budget exceeded (${maxSelections}).`);
    }

    const layers = Object.freeze(
      layerInputs
        .map(normalizeLayer)
        .sort((left, right) => left.order - right.order
          || left.layerId.localeCompare(right.layerId)),
    );

    const selections = Object.freeze(
      selectionInputs
        .map((selection): GisPersistedSelectionState => {
          const layerId = normalizeIdentifier(selection.layerId, 'selectionLayerId');
          if (selection.featureIds.length > maxSelectionIdsPerLayer) {
            throw new RangeError(
              `Map state selection id budget exceeded for layer ${layerId} (${maxSelectionIdsPerLayer}).`,
            );
          }
          const featureIds = Object.freeze(selection.featureIds.map(normalizeFeatureId));
          return Object.freeze({ layerId, featureIds });
        })
        .sort((left, right) => left.layerId.localeCompare(right.layerId)),
    );

    const capturedAt = Math.trunc(now());
    const expiresAt = ttlMs > 0 ? capturedAt + ttlMs : null;
    const view = normalizeView(input.view);
    const basemapId = normalizeWorkspace(input.basemapId);
    const temporal = normalizeTemporal(input.temporal);
    const workspace = normalizeWorkspace(input.workspace);
    const metadata = sanitizeMetadata(input.metadata ?? {}, metadataLimits);
    const core = {
      schemaVersion: 1 as const,
      capturedAt,
      expiresAt,
      view,
      basemapId,
      layers,
      temporal,
      selections,
      workspace,
      metadata,
    };
    const fingerprint = createDeterministicFingerprint('gis-map-session', core);

    return Object.freeze({
      ...core,
      fingerprint,
    });
  };

  const encode = (state: GisMapSessionState): string => {
    if (state.schemaVersion !== 1) throw new Error('Unsupported GIS map state schema version.');
    const encoded = encodeURIComponent(JSON.stringify(state));
    if (encoded.length > maxEncodedLength) {
      throw new RangeError(
        `Encoded GIS map state exceeds the configured length budget (${maxEncodedLength}).`,
      );
    }
    return encoded;
  };

  const decode = (
    encoded: string,
    options: { readonly allowExpired?: boolean } = {},
  ): GisMapStateDecodeResult => {
    if (typeof encoded !== 'string' || !encoded.trim()) {
      throw new TypeError('Encoded GIS map state is required.');
    }
    if (encoded.length > maxEncodedLength) {
      throw new RangeError(
        `Encoded GIS map state exceeds the configured length budget (${maxEncodedLength}).`,
      );
    }

    const raw = safeParse(encoded);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Decoded GIS map state must be an object.');
    }
    const source = raw as Record<string, unknown>;
    if (source.schemaVersion !== 1) {
      throw new Error('Unsupported GIS map state schema version.');
    }

    const capturedAt = Math.trunc(finite(source.capturedAt, 'Captured timestamp'));
    const expiresAt = source.expiresAt === null || source.expiresAt === undefined
      ? null
      : Math.trunc(finite(source.expiresAt, 'Expiration timestamp'));

    const decodedBasemapId = source.basemapId as string | null | undefined;
    const decodedTemporal = source.temporal as GisPersistedTemporalState | null | undefined;
    const decodedWorkspace = source.workspace as string | null | undefined;
    const rebuilt = capture({
      view: source.view as GisMapViewState,
      ...(decodedBasemapId === undefined ? {} : { basemapId: decodedBasemapId }),
      layers: Array.isArray(source.layers)
        ? source.layers as unknown as readonly GisPersistedLayerState[]
        : [],
      ...(decodedTemporal === undefined ? {} : { temporal: decodedTemporal }),
      selections: Array.isArray(source.selections)
        ? source.selections as unknown as readonly GisPersistedSelectionState[]
        : [],
      ...(decodedWorkspace === undefined ? {} : { workspace: decodedWorkspace }),
      metadata: source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata)
        ? source.metadata as Readonly<Record<string, unknown>>
        : {},
    });

    const core = {
      schemaVersion: 1 as const,
      capturedAt,
      expiresAt,
      view: rebuilt.view,
      basemapId: rebuilt.basemapId,
      layers: rebuilt.layers,
      temporal: rebuilt.temporal,
      selections: rebuilt.selections,
      workspace: rebuilt.workspace,
      metadata: rebuilt.metadata,
    };
    const fingerprint = createDeterministicFingerprint('gis-map-session', core);
    if (typeof source.fingerprint !== 'string' || source.fingerprint !== fingerprint) {
      throw new Error('GIS map state fingerprint validation failed.');
    }

    const state: GisMapSessionState = Object.freeze({
      ...core,
      fingerprint,
    });
    const expired = expiresAt !== null && Math.trunc(now()) > expiresAt;
    if (expired && options.allowExpired !== true) {
      throw new Error('GIS map state has expired.');
    }

    return Object.freeze({ state, expired });
  };

  const requireStorage = (): GisMapStateStorage => {
    if (!storage) throw new Error('No GIS map state storage adapter is configured.');
    return storage;
  };

  const save = async (
    key: unknown,
    state: GisMapSessionState,
  ): Promise<string> => {
    const target = storageKey(key);
    const encoded = encode(state);
    await requireStorage().setItem(target, encoded);
    return target;
  };

  const load = async (
    key: unknown,
    options: { readonly allowExpired?: boolean } = {},
  ): Promise<GisMapStateDecodeResult | null> => {
    const target = storageKey(key);
    const value = await requireStorage().getItem(target);
    if (value === null) return null;
    return decode(value, options);
  };

  const remove = async (key: unknown): Promise<void> => {
    await requireStorage().removeItem(storageKey(key));
  };

  return Object.freeze({
    capture,
    encode,
    decode,
    save,
    load,
    remove,
    storageKey,
  });
};
