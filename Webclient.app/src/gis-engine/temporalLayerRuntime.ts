import {
  createDeterministicFingerprint,
  normalizeIdentifier,
  positiveInteger,
} from './runtimeContracts';

export type TemporalPlaybackDirection = 1 | -1;
export type TemporalPlanMode = 'instant' | 'window' | 'range';

export interface TemporalRange {
  readonly start: number;
  readonly end: number;
}

export interface TemporalLayerRegistration {
  readonly layerId: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly defaultStepMs?: number;
  readonly defaultWindowMs?: number;
  readonly supportsTime?: boolean;
  readonly metadataRevision?: string | number | null;
}

export interface TemporalPlaybackConfiguration {
  readonly stepMs?: number;
  readonly intervalMs?: number;
  readonly direction?: TemporalPlaybackDirection;
  readonly loop?: boolean;
  readonly windowMs?: number;
}

export interface TemporalLayerPlan {
  readonly layerId: string;
  readonly mode: TemporalPlanMode;
  readonly cursor: number;
  readonly range: TemporalRange;
  readonly timeExtent: Readonly<{
    readonly start: number;
    readonly end: number;
  }>;
  readonly stepMs: number;
  readonly windowMs: number;
  readonly supportsTime: boolean;
  readonly metadataRevision: string | number | null;
  readonly fingerprint: string;
}

export interface TemporalPlaybackSnapshot {
  readonly playing: boolean;
  readonly direction: TemporalPlaybackDirection;
  readonly loop: boolean;
  readonly intervalMs: number;
  readonly stepMs: number;
  readonly windowMs: number;
  readonly lastTickAt: number | null;
  readonly accumulatedMs: number;
}

export interface TemporalRuntimeSnapshot {
  readonly destroyed: boolean;
  readonly cursor: number;
  readonly range: TemporalRange;
  readonly registeredLayerCount: number;
  readonly playback: TemporalPlaybackSnapshot;
  readonly revision: number;
}

export interface TemporalRuntimeEvent {
  readonly type:
    | 'layer-registered'
    | 'layer-unregistered'
    | 'range-changed'
    | 'cursor-changed'
    | 'playback-configured'
    | 'playback-started'
    | 'playback-paused'
    | 'playback-stepped'
    | 'playback-looped'
    | 'destroyed';
  readonly timestamp: number;
  readonly revision: number;
  readonly layerId?: string;
  readonly reason?: string;
  readonly cursor?: number;
  readonly range?: TemporalRange;
}

export interface TemporalLayerRuntimeConfiguration {
  readonly now?: () => number;
  readonly initialRange?: TemporalRange;
  readonly initialCursor?: number;
  readonly maxLayers?: number;
  readonly minIntervalMs?: number;
  readonly maxIntervalMs?: number;
  readonly defaultStepMs?: number;
  readonly defaultWindowMs?: number;
  readonly onListenerError?: (error: unknown, event: Readonly<TemporalRuntimeEvent>) => void;
}

export interface TemporalLayerRuntime {
  registerLayer: (registration: TemporalLayerRegistration) => TemporalLayerPlan;
  unregisterLayer: (layerId: unknown) => boolean;
  hasLayer: (layerId: unknown) => boolean;
  getLayerPlan: (layerId: unknown, mode?: TemporalPlanMode) => TemporalLayerPlan;
  listLayerPlans: (mode?: TemporalPlanMode) => readonly TemporalLayerPlan[];
  setRange: (range: TemporalRange, reason?: string) => TemporalRuntimeSnapshot;
  setCursor: (cursor: number, reason?: string) => TemporalRuntimeSnapshot;
  configurePlayback: (configuration?: TemporalPlaybackConfiguration) => TemporalRuntimeSnapshot;
  play: (reason?: string) => TemporalRuntimeSnapshot;
  pause: (reason?: string) => TemporalRuntimeSnapshot;
  step: (count?: number, reason?: string) => TemporalRuntimeSnapshot;
  tick: (timestamp?: number) => TemporalRuntimeSnapshot;
  subscribe: (listener: (event: Readonly<TemporalRuntimeEvent>) => void) => () => boolean;
  getSnapshot: () => TemporalRuntimeSnapshot;
  destroy: () => void;
}

interface LayerEntry {
  readonly layerId: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly defaultStepMs: number;
  readonly defaultWindowMs: number;
  readonly supportsTime: boolean;
  readonly metadataRevision: string | number | null;
}

const MAX_EPOCH = 8_640_000_000_000_000;
const MIN_EPOCH = -MAX_EPOCH;
const DEFAULT_MIN_INTERVAL_MS = 16;
const DEFAULT_MAX_INTERVAL_MS = 60_000;
const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_STEP_MS = 60_000;
const DEFAULT_WINDOW_MS = 0;

const finiteEpoch = (value: unknown, label: string): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < MIN_EPOCH || numeric > MAX_EPOCH) {
    throw new RangeError(`${label} must be a finite epoch-millisecond value.`);
  }
  return Math.trunc(numeric);
};

const nonNegativeDuration = (
  value: unknown,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.min(maximum, Math.trunc(numeric));
};

const normalizeRange = (value: TemporalRange): TemporalRange => {
  const start = finiteEpoch(value.start, 'Temporal range start');
  const end = finiteEpoch(value.end, 'Temporal range end');
  if (end < start) {
    throw new RangeError('Temporal range end cannot be earlier than start.');
  }
  return Object.freeze({ start, end });
};

const clamp = (value: number, minimum: number, maximum: number): number => (
  Math.min(maximum, Math.max(minimum, value))
);

const intersectRange = (left: TemporalRange, right: TemporalRange): TemporalRange | null => {
  const start = Math.max(left.start, right.start);
  const end = Math.min(left.end, right.end);
  if (end < start) return null;
  return Object.freeze({ start, end });
};

const clonePlayback = (
  playback: TemporalPlaybackSnapshot,
): TemporalPlaybackSnapshot => Object.freeze({ ...playback });

const freezeSnapshot = (
  destroyed: boolean,
  cursor: number,
  range: TemporalRange,
  registeredLayerCount: number,
  playback: TemporalPlaybackSnapshot,
  revision: number,
): TemporalRuntimeSnapshot => Object.freeze({
  destroyed,
  cursor,
  range: Object.freeze({ ...range }),
  registeredLayerCount,
  playback: clonePlayback(playback),
  revision,
});

export const createTemporalLayerRuntime = (
  configuration: TemporalLayerRuntimeConfiguration = {},
): TemporalLayerRuntime => {
  const now = typeof configuration.now === 'function' ? configuration.now : () => Date.now();
  const maxLayers = positiveInteger(configuration.maxLayers, 512, 10_000);
  const minIntervalMs = positiveInteger(
    configuration.minIntervalMs,
    DEFAULT_MIN_INTERVAL_MS,
    DEFAULT_MAX_INTERVAL_MS,
  );
  const maxIntervalMs = Math.max(
    minIntervalMs,
    positiveInteger(
      configuration.maxIntervalMs,
      DEFAULT_MAX_INTERVAL_MS,
      24 * 60 * 60 * 1000,
    ),
  );
  const defaultStepMs = positiveInteger(
    configuration.defaultStepMs,
    DEFAULT_STEP_MS,
    365 * 24 * 60 * 60 * 1000,
  );
  const defaultWindowMs = nonNegativeDuration(
    configuration.defaultWindowMs,
    DEFAULT_WINDOW_MS,
    365 * 24 * 60 * 60 * 1000,
  );

  const initialRange = normalizeRange(
    configuration.initialRange ?? { start: 0, end: MAX_EPOCH },
  );
  let cursor = clamp(
    finiteEpoch(configuration.initialCursor ?? initialRange.start, 'Initial temporal cursor'),
    initialRange.start,
    initialRange.end,
  );
  let activeRange = initialRange;
  let revision = 0;
  let destroyed = false;
  const layers = new Map<string, LayerEntry>();
  const listeners = new Set<(event: Readonly<TemporalRuntimeEvent>) => void>();
  let playback: TemporalPlaybackSnapshot = Object.freeze({
    playing: false,
    direction: 1,
    loop: false,
    intervalMs: DEFAULT_INTERVAL_MS,
    stepMs: defaultStepMs,
    windowMs: defaultWindowMs,
    lastTickAt: null,
    accumulatedMs: 0,
  });

  const assertActive = (): void => {
    if (destroyed) throw new Error('Temporal layer runtime has been destroyed.');
  };

  const emit = (
    type: TemporalRuntimeEvent['type'],
    details: Omit<TemporalRuntimeEvent, 'type' | 'timestamp' | 'revision'> = {},
  ): void => {
    const event: Readonly<TemporalRuntimeEvent> = Object.freeze({
      type,
      timestamp: Math.trunc(now()),
      revision,
      ...details,
    });
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error: unknown) {
        configuration.onListenerError?.(error, event);
      }
    }
  };

  const getSnapshot = (): TemporalRuntimeSnapshot => freezeSnapshot(
    destroyed,
    cursor,
    activeRange,
    layers.size,
    playback,
    revision,
  );

  const normalizeLayer = (registration: TemporalLayerRegistration): LayerEntry => {
    const layerId = normalizeIdentifier(registration.layerId, 'layerId');
    const minimum = finiteEpoch(registration.minimum, 'Temporal layer minimum');
    const maximum = finiteEpoch(registration.maximum, 'Temporal layer maximum');
    if (maximum < minimum) {
      throw new RangeError(`Temporal layer ${layerId} maximum cannot be earlier than minimum.`);
    }
    return Object.freeze({
      layerId,
      minimum,
      maximum,
      defaultStepMs: positiveInteger(
        registration.defaultStepMs,
        defaultStepMs,
        365 * 24 * 60 * 60 * 1000,
      ),
      defaultWindowMs: nonNegativeDuration(
        registration.defaultWindowMs,
        defaultWindowMs,
        365 * 24 * 60 * 60 * 1000,
      ),
      supportsTime: registration.supportsTime !== false,
      metadataRevision: registration.metadataRevision ?? null,
    });
  };

  const getLayer = (layerId: unknown): LayerEntry => {
    const id = normalizeIdentifier(layerId, 'layerId');
    const entry = layers.get(id);
    if (!entry) throw new Error(`Temporal layer is not registered: ${id}`);
    return entry;
  };

  const planForLayer = (
    entry: LayerEntry,
    mode: TemporalPlanMode,
  ): TemporalLayerPlan => {
    const layerRange = Object.freeze({ start: entry.minimum, end: entry.maximum });
    const intersection = intersectRange(activeRange, layerRange) ?? Object.freeze({
      start: clamp(cursor, entry.minimum, entry.maximum),
      end: clamp(cursor, entry.minimum, entry.maximum),
    });
    const layerCursor = clamp(cursor, intersection.start, intersection.end);
    const effectiveStep = playback.stepMs || entry.defaultStepMs;
    const effectiveWindow = playback.windowMs || entry.defaultWindowMs;
    let range: TemporalRange;

    if (mode === 'instant') {
      range = Object.freeze({ start: layerCursor, end: layerCursor });
    } else if (mode === 'window') {
      const half = Math.floor(effectiveWindow / 2);
      const start = clamp(layerCursor - half, intersection.start, intersection.end);
      const end = clamp(layerCursor + (effectiveWindow - half), intersection.start, intersection.end);
      range = Object.freeze({ start: Math.min(start, end), end: Math.max(start, end) });
    } else {
      range = intersection;
    }

    const fingerprint = createDeterministicFingerprint('temporal-layer-plan', {
      layerId: entry.layerId,
      mode,
      cursor: layerCursor,
      range,
      stepMs: effectiveStep,
      windowMs: effectiveWindow,
      metadataRevision: entry.metadataRevision,
      revision,
    });

    return Object.freeze({
      layerId: entry.layerId,
      mode,
      cursor: layerCursor,
      range,
      timeExtent: Object.freeze({ start: range.start, end: range.end }),
      stepMs: effectiveStep,
      windowMs: effectiveWindow,
      supportsTime: entry.supportsTime,
      metadataRevision: entry.metadataRevision,
      fingerprint,
    });
  };

  const registerLayer = (
    registration: TemporalLayerRegistration,
  ): TemporalLayerPlan => {
    assertActive();
    const entry = normalizeLayer(registration);
    const existed = layers.has(entry.layerId);
    if (!existed && layers.size >= maxLayers) {
      throw new RangeError(`Temporal layer capacity exceeded (${maxLayers}).`);
    }
    layers.set(entry.layerId, entry);
    revision += 1;
    emit('layer-registered', { layerId: entry.layerId });
    return planForLayer(entry, 'range');
  };

  const unregisterLayer = (layerId: unknown): boolean => {
    assertActive();
    const id = normalizeIdentifier(layerId, 'layerId');
    const removed = layers.delete(id);
    if (removed) {
      revision += 1;
      emit('layer-unregistered', { layerId: id });
    }
    return removed;
  };

  const setRange = (range: TemporalRange, reason = 'set-range'): TemporalRuntimeSnapshot => {
    assertActive();
    const next = normalizeRange(range);
    activeRange = next;
    cursor = clamp(cursor, next.start, next.end);
    revision += 1;
    emit('range-changed', { range: next, cursor, reason });
    return getSnapshot();
  };

  const setCursor = (value: number, reason = 'set-cursor'): TemporalRuntimeSnapshot => {
    assertActive();
    const next = clamp(
      finiteEpoch(value, 'Temporal cursor'),
      activeRange.start,
      activeRange.end,
    );
    if (next === cursor) return getSnapshot();
    cursor = next;
    revision += 1;
    emit('cursor-changed', { cursor, reason });
    return getSnapshot();
  };

  const configurePlayback = (
    input: TemporalPlaybackConfiguration = {},
  ): TemporalRuntimeSnapshot => {
    assertActive();
    const direction: TemporalPlaybackDirection = input.direction === -1 ? -1 : 1;
    const intervalMs = clamp(
      positiveInteger(input.intervalMs, playback.intervalMs, maxIntervalMs),
      minIntervalMs,
      maxIntervalMs,
    );
    const stepMs = positiveInteger(
      input.stepMs,
      playback.stepMs,
      365 * 24 * 60 * 60 * 1000,
    );
    const windowMs = nonNegativeDuration(
      input.windowMs,
      playback.windowMs,
      365 * 24 * 60 * 60 * 1000,
    );
    playback = Object.freeze({
      ...playback,
      direction,
      intervalMs,
      stepMs,
      windowMs,
      loop: input.loop ?? playback.loop,
      accumulatedMs: 0,
      lastTickAt: playback.playing ? Math.trunc(now()) : null,
    });
    revision += 1;
    emit('playback-configured', { cursor });
    return getSnapshot();
  };

  const play = (reason = 'play'): TemporalRuntimeSnapshot => {
    assertActive();
    if (playback.playing) return getSnapshot();
    playback = Object.freeze({
      ...playback,
      playing: true,
      lastTickAt: Math.trunc(now()),
      accumulatedMs: 0,
    });
    revision += 1;
    emit('playback-started', { cursor, reason });
    return getSnapshot();
  };

  const pause = (reason = 'pause'): TemporalRuntimeSnapshot => {
    assertActive();
    if (!playback.playing) return getSnapshot();
    playback = Object.freeze({
      ...playback,
      playing: false,
      lastTickAt: null,
      accumulatedMs: 0,
    });
    revision += 1;
    emit('playback-paused', { cursor, reason });
    return getSnapshot();
  };

  const advanceOnce = (reason: string): boolean => {
    const delta = playback.stepMs * playback.direction;
    const next = cursor + delta;
    if (next >= activeRange.start && next <= activeRange.end) {
      cursor = next;
      revision += 1;
      emit('playback-stepped', { cursor, reason });
      return true;
    }

    if (!playback.loop) {
      cursor = playback.direction === 1 ? activeRange.end : activeRange.start;
      playback = Object.freeze({
        ...playback,
        playing: false,
        lastTickAt: null,
        accumulatedMs: 0,
      });
      revision += 1;
      emit('playback-paused', { cursor, reason: 'boundary' });
      return false;
    }

    cursor = playback.direction === 1 ? activeRange.start : activeRange.end;
    revision += 1;
    emit('playback-looped', { cursor, reason });
    return true;
  };

  const step = (count = 1, reason = 'manual-step'): TemporalRuntimeSnapshot => {
    assertActive();
    const steps = Math.min(10_000, Math.max(1, Math.trunc(Math.abs(Number(count) || 1))));
    for (let index = 0; index < steps; index += 1) {
      if (!advanceOnce(reason)) break;
    }
    return getSnapshot();
  };

  const tick = (timestamp = now()): TemporalRuntimeSnapshot => {
    assertActive();
    if (!playback.playing) return getSnapshot();
    const current = finiteEpoch(timestamp, 'Temporal tick timestamp');
    const previous = playback.lastTickAt ?? current;
    const elapsed = Math.max(0, current - previous);
    let accumulated = playback.accumulatedMs + elapsed;
    let processed = 0;

    while (accumulated >= playback.intervalMs && playback.playing && processed < 10_000) {
      accumulated -= playback.intervalMs;
      processed += 1;
      if (!advanceOnce('tick')) break;
    }

    playback = Object.freeze({
      ...playback,
      lastTickAt: playback.playing ? current : null,
      accumulatedMs: playback.playing ? accumulated : 0,
    });
    return getSnapshot();
  };

  const subscribe = (
    listener: (event: Readonly<TemporalRuntimeEvent>) => void,
  ): (() => boolean) => {
    assertActive();
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    layers.clear();
    playback = Object.freeze({
      ...playback,
      playing: false,
      lastTickAt: null,
      accumulatedMs: 0,
    });
    revision += 1;
    emit('destroyed', { reason: 'destroy' });
    listeners.clear();
  };

  return Object.freeze({
    registerLayer,
    unregisterLayer,
    hasLayer(layerId: unknown) {
      assertActive();
      return layers.has(normalizeIdentifier(layerId, 'layerId'));
    },
    getLayerPlan(layerId: unknown, mode: TemporalPlanMode = 'window') {
      assertActive();
      return planForLayer(getLayer(layerId), mode);
    },
    listLayerPlans(mode: TemporalPlanMode = 'window') {
      assertActive();
      return Object.freeze(
        [...layers.values()]
          .sort((left, right) => left.layerId.localeCompare(right.layerId))
          .map((entry) => planForLayer(entry, mode)),
      );
    },
    setRange,
    setCursor,
    configurePlayback,
    play,
    pause,
    step,
    tick,
    subscribe,
    getSnapshot,
    destroy,
  });
};
