export type ViewportPressureLevel = 'normal' | 'elevated' | 'critical';

export interface ViewportPerformanceSample {
  readonly frameMs?: number;
  readonly gpuPressure?: number;
  readonly heapPressure?: number;
  readonly queryLatencyMs?: number;
  readonly networkBacklog?: number;
  readonly inFlightQueries?: number;
  readonly moving?: boolean;
  readonly timestamp?: number;
}

export interface ViewportBudgetProfile {
  readonly pressure: ViewportPressureLevel;
  readonly maxFeaturesFactor: number;
  readonly maxFieldsFactor: number;
  readonly prefetchFactor: number;
  readonly concurrencyFactor: number;
  readonly cacheTtlFactor: number;
  readonly moving: boolean;
}

export interface ViewportBudgetControllerConfiguration {
  readonly elevatedFrameMs: number;
  readonly criticalFrameMs: number;
  readonly elevatedGpuPressure: number;
  readonly criticalGpuPressure: number;
  readonly elevatedHeapPressure: number;
  readonly criticalHeapPressure: number;
  readonly elevatedQueryLatencyMs: number;
  readonly criticalQueryLatencyMs: number;
  readonly elevatedNetworkBacklog: number;
  readonly criticalNetworkBacklog: number;
  readonly elevatedInFlightQueries: number;
  readonly criticalInFlightQueries: number;
  readonly recoverySamples: number;
  readonly historySize: number;
  readonly maxSampleAgeMs: number;
  readonly movingFeatureFactor: number;
  readonly movingPrefetchFactor: number;
}

export interface ViewportBudgetMetrics {
  readonly samples: number;
  readonly frameP50Ms: number;
  readonly frameP95Ms: number;
  readonly queryLatencyP50Ms: number;
  readonly queryLatencyP95Ms: number;
  readonly maximumGpuPressure: number;
  readonly maximumHeapPressure: number;
  readonly maximumNetworkBacklog: number;
  readonly maximumInFlightQueries: number;
}

export interface ViewportBudgetControllerSnapshot {
  readonly revision: number;
  readonly pressure: ViewportPressureLevel;
  readonly candidatePressure: ViewportPressureLevel;
  readonly candidateSamples: number;
  readonly profile: ViewportBudgetProfile;
  readonly metrics: ViewportBudgetMetrics;
  readonly lastSampleAt: number | null;
}

interface NormalizedViewportPerformanceSample {
  readonly frameMs: number | null;
  readonly gpuPressure: number | null;
  readonly heapPressure: number | null;
  readonly queryLatencyMs: number | null;
  readonly networkBacklog: number | null;
  readonly inFlightQueries: number | null;
  readonly moving: boolean;
  readonly timestamp: number;
}

const DEFAULT_CONFIGURATION: ViewportBudgetControllerConfiguration = Object.freeze({
  elevatedFrameMs: 24,
  criticalFrameMs: 42,
  elevatedGpuPressure: 0.72,
  criticalGpuPressure: 0.9,
  elevatedHeapPressure: 0.72,
  criticalHeapPressure: 0.9,
  elevatedQueryLatencyMs: 750,
  criticalQueryLatencyMs: 2_000,
  elevatedNetworkBacklog: 16,
  criticalNetworkBacklog: 48,
  elevatedInFlightQueries: 8,
  criticalInFlightQueries: 18,
  recoverySamples: 3,
  historySize: 90,
  maxSampleAgeMs: 30_000,
  movingFeatureFactor: 0.6,
  movingPrefetchFactor: 0.45,
});

const PRESSURE_RANK: Readonly<Record<ViewportPressureLevel, number>> = Object.freeze({
  normal: 0,
  elevated: 1,
  critical: 2,
});

const BASE_PROFILE: Readonly<Record<ViewportPressureLevel, Omit<ViewportBudgetProfile, 'pressure' | 'moving'>>> = Object.freeze({
  normal: Object.freeze({
    maxFeaturesFactor: 1,
    maxFieldsFactor: 1,
    prefetchFactor: 1,
    concurrencyFactor: 1,
    cacheTtlFactor: 1,
  }),
  elevated: Object.freeze({
    maxFeaturesFactor: 0.68,
    maxFieldsFactor: 0.8,
    prefetchFactor: 0.45,
    concurrencyFactor: 0.72,
    cacheTtlFactor: 1.15,
  }),
  critical: Object.freeze({
    maxFeaturesFactor: 0.35,
    maxFieldsFactor: 0.55,
    prefetchFactor: 0.12,
    concurrencyFactor: 0.4,
    cacheTtlFactor: 1.35,
  }),
});

const finitePositive = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(label + ' must be a finite positive number');
  }
  return value;
};

const finiteNonNegative = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(label + ' must be finite and non-negative');
  }
  return Object.is(value, -0) ? 0 : value;
};

const probability = (value: number, label: string): number => {
  const normalized = finiteNonNegative(value, label);
  if (normalized > 1) throw new RangeError(label + ' must be between 0 and 1');
  return normalized;
};

const positiveSafeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(label + ' must be a positive safe integer');
  }
  return value;
};

const nonNegativeSafeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(label + ' must be a non-negative safe integer');
  }
  return value;
};

const normalizeConfiguration = (
  input: Partial<ViewportBudgetControllerConfiguration>,
): ViewportBudgetControllerConfiguration => {
  const resolved = { ...DEFAULT_CONFIGURATION, ...input };
  const elevatedFrameMs = finitePositive(resolved.elevatedFrameMs, 'elevatedFrameMs');
  const criticalFrameMs = finitePositive(resolved.criticalFrameMs, 'criticalFrameMs');
  const elevatedGpuPressure = probability(resolved.elevatedGpuPressure, 'elevatedGpuPressure');
  const criticalGpuPressure = probability(resolved.criticalGpuPressure, 'criticalGpuPressure');
  const elevatedHeapPressure = probability(resolved.elevatedHeapPressure, 'elevatedHeapPressure');
  const criticalHeapPressure = probability(resolved.criticalHeapPressure, 'criticalHeapPressure');
  const elevatedQueryLatencyMs = finitePositive(
    resolved.elevatedQueryLatencyMs,
    'elevatedQueryLatencyMs',
  );
  const criticalQueryLatencyMs = finitePositive(
    resolved.criticalQueryLatencyMs,
    'criticalQueryLatencyMs',
  );
  const elevatedNetworkBacklog = nonNegativeSafeInteger(
    resolved.elevatedNetworkBacklog,
    'elevatedNetworkBacklog',
  );
  const criticalNetworkBacklog = nonNegativeSafeInteger(
    resolved.criticalNetworkBacklog,
    'criticalNetworkBacklog',
  );
  const elevatedInFlightQueries = nonNegativeSafeInteger(
    resolved.elevatedInFlightQueries,
    'elevatedInFlightQueries',
  );
  const criticalInFlightQueries = nonNegativeSafeInteger(
    resolved.criticalInFlightQueries,
    'criticalInFlightQueries',
  );
  const recoverySamples = positiveSafeInteger(resolved.recoverySamples, 'recoverySamples');
  const historySize = positiveSafeInteger(resolved.historySize, 'historySize');
  const maxSampleAgeMs = finitePositive(resolved.maxSampleAgeMs, 'maxSampleAgeMs');
  const movingFeatureFactor = probability(resolved.movingFeatureFactor, 'movingFeatureFactor');
  const movingPrefetchFactor = probability(
    resolved.movingPrefetchFactor,
    'movingPrefetchFactor',
  );

  if (criticalFrameMs <= elevatedFrameMs) {
    throw new RangeError('criticalFrameMs must exceed elevatedFrameMs');
  }
  if (criticalGpuPressure <= elevatedGpuPressure) {
    throw new RangeError('criticalGpuPressure must exceed elevatedGpuPressure');
  }
  if (criticalHeapPressure <= elevatedHeapPressure) {
    throw new RangeError('criticalHeapPressure must exceed elevatedHeapPressure');
  }
  if (criticalQueryLatencyMs <= elevatedQueryLatencyMs) {
    throw new RangeError('criticalQueryLatencyMs must exceed elevatedQueryLatencyMs');
  }
  if (criticalNetworkBacklog <= elevatedNetworkBacklog) {
    throw new RangeError('criticalNetworkBacklog must exceed elevatedNetworkBacklog');
  }
  if (criticalInFlightQueries <= elevatedInFlightQueries) {
    throw new RangeError('criticalInFlightQueries must exceed elevatedInFlightQueries');
  }
  if (historySize > 2_048) {
    throw new RangeError('historySize exceeds the bounded metrics budget');
  }

  return Object.freeze({
    elevatedFrameMs,
    criticalFrameMs,
    elevatedGpuPressure,
    criticalGpuPressure,
    elevatedHeapPressure,
    criticalHeapPressure,
    elevatedQueryLatencyMs,
    criticalQueryLatencyMs,
    elevatedNetworkBacklog,
    criticalNetworkBacklog,
    elevatedInFlightQueries,
    criticalInFlightQueries,
    recoverySamples,
    historySize,
    maxSampleAgeMs,
    movingFeatureFactor,
    movingPrefetchFactor,
  });
};

const optionalFiniteNonNegative = (
  value: number | undefined,
  label: string,
): number | null => value === undefined ? null : finiteNonNegative(value, label);

const optionalProbability = (
  value: number | undefined,
  label: string,
): number | null => value === undefined ? null : probability(value, label);

const optionalSafeInteger = (
  value: number | undefined,
  label: string,
): number | null => value === undefined ? null : nonNegativeSafeInteger(value, label);

const percentile = (values: readonly number[], ratio: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index] ?? 0;
};

const maximum = (values: readonly number[]): number => {
  let current = 0;
  for (const value of values) current = Math.max(current, value);
  return current;
};

const factor = (base: number, motionFactor: number, moving: boolean): number => (
  moving ? Math.max(0.01, Math.min(1, base * motionFactor)) : base
);

export const deriveViewportPressure = (
  sample: ViewportPerformanceSample,
  configurationInput: Partial<ViewportBudgetControllerConfiguration> = {},
): ViewportPressureLevel => {
  const configuration = normalizeConfiguration(configurationInput);
  const normalized = {
    frameMs: optionalFiniteNonNegative(sample.frameMs, 'frameMs'),
    gpuPressure: optionalProbability(sample.gpuPressure, 'gpuPressure'),
    heapPressure: optionalProbability(sample.heapPressure, 'heapPressure'),
    queryLatencyMs: optionalFiniteNonNegative(sample.queryLatencyMs, 'queryLatencyMs'),
    networkBacklog: optionalSafeInteger(sample.networkBacklog, 'networkBacklog'),
    inFlightQueries: optionalSafeInteger(sample.inFlightQueries, 'inFlightQueries'),
  };

  if (
    (normalized.frameMs !== null && normalized.frameMs >= configuration.criticalFrameMs)
    || (
      normalized.gpuPressure !== null
      && normalized.gpuPressure >= configuration.criticalGpuPressure
    )
    || (
      normalized.heapPressure !== null
      && normalized.heapPressure >= configuration.criticalHeapPressure
    )
    || (
      normalized.queryLatencyMs !== null
      && normalized.queryLatencyMs >= configuration.criticalQueryLatencyMs
    )
    || (
      normalized.networkBacklog !== null
      && normalized.networkBacklog >= configuration.criticalNetworkBacklog
    )
    || (
      normalized.inFlightQueries !== null
      && normalized.inFlightQueries >= configuration.criticalInFlightQueries
    )
  ) return 'critical';

  if (
    (normalized.frameMs !== null && normalized.frameMs >= configuration.elevatedFrameMs)
    || (
      normalized.gpuPressure !== null
      && normalized.gpuPressure >= configuration.elevatedGpuPressure
    )
    || (
      normalized.heapPressure !== null
      && normalized.heapPressure >= configuration.elevatedHeapPressure
    )
    || (
      normalized.queryLatencyMs !== null
      && normalized.queryLatencyMs >= configuration.elevatedQueryLatencyMs
    )
    || (
      normalized.networkBacklog !== null
      && normalized.networkBacklog >= configuration.elevatedNetworkBacklog
    )
    || (
      normalized.inFlightQueries !== null
      && normalized.inFlightQueries >= configuration.elevatedInFlightQueries
    )
  ) return 'elevated';

  return 'normal';
};

export class ViewportBudgetController {
  readonly #configuration: ViewportBudgetControllerConfiguration;
  readonly #history: NormalizedViewportPerformanceSample[] = [];
  #pressure: ViewportPressureLevel = 'normal';
  #candidatePressure: ViewportPressureLevel = 'normal';
  #candidateSamples = 0;
  #moving = false;
  #lastSampleAt: number | null = null;
  #revision = 0;

  constructor(configuration: Partial<ViewportBudgetControllerConfiguration> = {}) {
    this.#configuration = normalizeConfiguration(configuration);
  }

  get configuration(): ViewportBudgetControllerConfiguration {
    return this.#configuration;
  }

  sample(input: ViewportPerformanceSample): ViewportBudgetControllerSnapshot {
    const timestamp = input.timestamp === undefined
      ? Date.now()
      : finiteNonNegative(input.timestamp, 'timestamp');
    if (this.#lastSampleAt !== null && timestamp < this.#lastSampleAt) {
      throw new RangeError('viewport performance timestamps must be monotonic');
    }

    const normalized: NormalizedViewportPerformanceSample = Object.freeze({
      frameMs: optionalFiniteNonNegative(input.frameMs, 'frameMs'),
      gpuPressure: optionalProbability(input.gpuPressure, 'gpuPressure'),
      heapPressure: optionalProbability(input.heapPressure, 'heapPressure'),
      queryLatencyMs: optionalFiniteNonNegative(input.queryLatencyMs, 'queryLatencyMs'),
      networkBacklog: optionalSafeInteger(input.networkBacklog, 'networkBacklog'),
      inFlightQueries: optionalSafeInteger(input.inFlightQueries, 'inFlightQueries'),
      moving: input.moving === true,
      timestamp,
    });

    const next = deriveViewportPressure(input, this.#configuration);
    this.#moving = normalized.moving;
    this.#lastSampleAt = timestamp;
    this.#record(normalized);
    this.#transition(next);
    this.#revision += 1;
    return this.snapshot();
  }

  profile(): ViewportBudgetProfile {
    const base = BASE_PROFILE[this.#pressure];
    return Object.freeze({
      pressure: this.#pressure,
      maxFeaturesFactor: factor(
        base.maxFeaturesFactor,
        this.#configuration.movingFeatureFactor,
        this.#moving,
      ),
      maxFieldsFactor: base.maxFieldsFactor,
      prefetchFactor: factor(
        base.prefetchFactor,
        this.#configuration.movingPrefetchFactor,
        this.#moving,
      ),
      concurrencyFactor: base.concurrencyFactor,
      cacheTtlFactor: base.cacheTtlFactor,
      moving: this.#moving,
    });
  }

  metrics(): ViewportBudgetMetrics {
    const frames = this.#history
      .map((sample) => sample.frameMs)
      .filter((value): value is number => value !== null);
    const latency = this.#history
      .map((sample) => sample.queryLatencyMs)
      .filter((value): value is number => value !== null);
    const gpu = this.#history
      .map((sample) => sample.gpuPressure)
      .filter((value): value is number => value !== null);
    const heap = this.#history
      .map((sample) => sample.heapPressure)
      .filter((value): value is number => value !== null);
    const network = this.#history
      .map((sample) => sample.networkBacklog)
      .filter((value): value is number => value !== null);
    const inFlight = this.#history
      .map((sample) => sample.inFlightQueries)
      .filter((value): value is number => value !== null);

    return Object.freeze({
      samples: this.#history.length,
      frameP50Ms: percentile(frames, 0.5),
      frameP95Ms: percentile(frames, 0.95),
      queryLatencyP50Ms: percentile(latency, 0.5),
      queryLatencyP95Ms: percentile(latency, 0.95),
      maximumGpuPressure: maximum(gpu),
      maximumHeapPressure: maximum(heap),
      maximumNetworkBacklog: maximum(network),
      maximumInFlightQueries: maximum(inFlight),
    });
  }

  snapshot(): ViewportBudgetControllerSnapshot {
    return Object.freeze({
      revision: this.#revision,
      pressure: this.#pressure,
      candidatePressure: this.#candidatePressure,
      candidateSamples: this.#candidateSamples,
      profile: this.profile(),
      metrics: this.metrics(),
      lastSampleAt: this.#lastSampleAt,
    });
  }

  reset(): ViewportBudgetControllerSnapshot {
    this.#history.length = 0;
    this.#pressure = 'normal';
    this.#candidatePressure = 'normal';
    this.#candidateSamples = 0;
    this.#moving = false;
    this.#lastSampleAt = null;
    this.#revision += 1;
    return this.snapshot();
  }

  #transition(next: ViewportPressureLevel): void {
    if (PRESSURE_RANK[next] > PRESSURE_RANK[this.#pressure]) {
      this.#pressure = next;
      this.#candidatePressure = next;
      this.#candidateSamples = 0;
      return;
    }
    if (next === this.#pressure) {
      this.#candidatePressure = next;
      this.#candidateSamples = 0;
      return;
    }
    if (this.#candidatePressure !== next) {
      this.#candidatePressure = next;
      this.#candidateSamples = 1;
      return;
    }
    this.#candidateSamples += 1;
    if (this.#candidateSamples >= this.#configuration.recoverySamples) {
      this.#pressure = next;
      this.#candidateSamples = 0;
    }
  }

  #record(sample: NormalizedViewportPerformanceSample): void {
    this.#history.push(sample);
    const cutoff = sample.timestamp - this.#configuration.maxSampleAgeMs;
    while (
      this.#history.length > 0
      && (
        this.#history.length > this.#configuration.historySize
        || (this.#history[0]?.timestamp ?? sample.timestamp) < cutoff
      )
    ) {
      this.#history.shift();
    }
  }
}

export const createViewportBudgetController = (
  configuration: Partial<ViewportBudgetControllerConfiguration> = {},
): ViewportBudgetController => new ViewportBudgetController(configuration);
