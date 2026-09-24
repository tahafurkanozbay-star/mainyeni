import { assertAllowedArcGisResourceUrl } from './serviceCapabilityRuntime';
import {
  average,
  clampNumber,
  createMonotonicSequence,
  finiteNumber,
  normalizeIdentifier,
  percentile,
  positiveInteger,
  type GisCircuitState,
  type GisHealthState,
  type GisRequestMetric,
  type GisServiceHealthSnapshot,
} from './runtimeContracts';

export interface GisServiceHealthPolicy {
  readonly sampleWindow?: number;
  readonly degradeFailureRatio?: number;
  readonly unavailableFailureRatio?: number;
  readonly consecutiveFailureLimit?: number;
  readonly timeoutFailureWeight?: number;
  readonly slowLatencyMs?: number;
  readonly verySlowLatencyMs?: number;
  readonly openCircuitMs?: number;
  readonly maxOpenCircuitMs?: number;
  readonly halfOpenProbeLimit?: number;
  readonly healthyScore?: number;
  readonly degradedScore?: number;
}

export interface GisServiceRegistration {
  readonly serviceId: string;
  readonly resourceUrl: string;
  readonly resourceKind?: string | null;
  readonly maxRecordCount?: number | null;
  readonly metadataRevision?: string | number | null;
}

export interface GisServiceHealthEvent {
  readonly sequence: number;
  readonly timestamp: number;
  readonly type: string;
  readonly serviceId: string;
  readonly previousState?: GisHealthState;
  readonly nextState?: GisHealthState;
  readonly previousCircuit?: GisCircuitState;
  readonly nextCircuit?: GisCircuitState;
  readonly reason?: string;
  readonly snapshot: GisServiceHealthSnapshot;
}

export interface GisServiceHealthRuntimeConfiguration {
  readonly now?: () => number;
  readonly policy?: GisServiceHealthPolicy;
  readonly onEvent?: (event: GisServiceHealthEvent) => void;
  readonly onListenerError?: (error: unknown, event: GisServiceHealthEvent) => void;
}

export interface GisRequestTicket {
  readonly ticketId: string;
  readonly serviceId: string;
  readonly startedAt: number;
  readonly probe: boolean;
}

export interface GisServiceAvailability {
  readonly allowed: boolean;
  readonly reason: 'ok' | 'circuit-open' | 'probe-capacity' | 'unregistered' | 'destroyed';
  readonly serviceId: string;
  readonly state: GisHealthState;
  readonly circuit: GisCircuitState;
  readonly nextProbeAt: number | null;
}

interface Sample {
  readonly timestamp: number;
  readonly durationMs: number;
  readonly success: boolean;
  readonly timeout: boolean;
  readonly cancelled: boolean;
  readonly transferLimitExceeded: boolean;
  readonly status: number | null;
  readonly bytes: number;
  readonly errorCode: string | null;
}

interface ServiceState {
  readonly serviceId: string;
  readonly resourceUrl: string;
  readonly resourceKind: string | null;
  readonly maxRecordCount: number | null;
  metadataRevision: string | number | null;
  state: GisHealthState;
  circuit: GisCircuitState;
  samples: Sample[];
  successes: number;
  failures: number;
  consecutiveFailures: number;
  timeoutCount: number;
  cancellationCount: number;
  transferLimitCount: number;
  totalBytes: number;
  latencyEwmaMs: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  circuitOpenedAt: number | null;
  nextProbeAt: number | null;
  currentOpenDurationMs: number;
  halfOpenProbes: number;
  halfOpenSuccesses: number;
  inFlight: number;
}

const DEFAULT_POLICY: Required<GisServiceHealthPolicy> = Object.freeze({
  sampleWindow: 40,
  degradeFailureRatio: 0.18,
  unavailableFailureRatio: 0.5,
  consecutiveFailureLimit: 4,
  timeoutFailureWeight: 1.25,
  slowLatencyMs: 1800,
  verySlowLatencyMs: 5000,
  openCircuitMs: 8000,
  maxOpenCircuitMs: 120000,
  halfOpenProbeLimit: 2,
  healthyScore: 75,
  degradedScore: 42,
});

const normalizePolicy = (input: GisServiceHealthPolicy = {}): Required<GisServiceHealthPolicy> => {
  const degradeFailureRatio = clampNumber(input.degradeFailureRatio, 0.01, 0.95, DEFAULT_POLICY.degradeFailureRatio);
  const unavailableFailureRatio = Math.max(
    degradeFailureRatio,
    clampNumber(input.unavailableFailureRatio, 0.05, 1, DEFAULT_POLICY.unavailableFailureRatio),
  );
  return Object.freeze({
    sampleWindow: positiveInteger(input.sampleWindow, DEFAULT_POLICY.sampleWindow, 500),
    degradeFailureRatio,
    unavailableFailureRatio,
    consecutiveFailureLimit: positiveInteger(input.consecutiveFailureLimit, DEFAULT_POLICY.consecutiveFailureLimit, 50),
    timeoutFailureWeight: clampNumber(input.timeoutFailureWeight, 1, 5, DEFAULT_POLICY.timeoutFailureWeight),
    slowLatencyMs: positiveInteger(input.slowLatencyMs, DEFAULT_POLICY.slowLatencyMs, 60000),
    verySlowLatencyMs: Math.max(
      positiveInteger(input.slowLatencyMs, DEFAULT_POLICY.slowLatencyMs, 60000),
      positiveInteger(input.verySlowLatencyMs, DEFAULT_POLICY.verySlowLatencyMs, 120000),
    ),
    openCircuitMs: positiveInteger(input.openCircuitMs, DEFAULT_POLICY.openCircuitMs, 600000),
    maxOpenCircuitMs: Math.max(
      positiveInteger(input.openCircuitMs, DEFAULT_POLICY.openCircuitMs, 600000),
      positiveInteger(input.maxOpenCircuitMs, DEFAULT_POLICY.maxOpenCircuitMs, 3600000),
    ),
    halfOpenProbeLimit: positiveInteger(input.halfOpenProbeLimit, DEFAULT_POLICY.halfOpenProbeLimit, 16),
    healthyScore: clampNumber(input.healthyScore, 1, 100, DEFAULT_POLICY.healthyScore),
    degradedScore: clampNumber(input.degradedScore, 0, 99, DEFAULT_POLICY.degradedScore),
  });
};

const normalizeStatus = (value: unknown): number | null => {
  const status = finiteNumber(value);
  if (status === null) return null;
  return Math.min(999, Math.max(0, Math.floor(status)));
};

const normalizeDuration = (value: unknown): number => Math.min(
  10 * 60 * 1000,
  Math.max(0, finiteNumber(value, 0) ?? 0),
);

const normalizeBytes = (value: unknown): number => Math.min(
  Number.MAX_SAFE_INTEGER,
  Math.max(0, Math.floor(finiteNumber(value, 0) ?? 0)),
);

const isRetryableStatus = (status: number | null): boolean => (
  status === null || status === 408 || status === 425 || status === 429 || status >= 500
);

const createState = (registration: GisServiceRegistration): ServiceState => {
  const resourceUrl = assertAllowedArcGisResourceUrl(registration.resourceUrl);
  if (!resourceUrl) throw new TypeError('A verified ArcGIS REST resource URL is required.');
  return {
    serviceId: normalizeIdentifier(registration.serviceId, 'serviceId'),
    resourceUrl,
    resourceKind: registration.resourceKind == null ? null : String(registration.resourceKind),
    maxRecordCount: registration.maxRecordCount == null ? null : positiveInteger(registration.maxRecordCount, 1, 10000000),
    metadataRevision: registration.metadataRevision ?? null,
    state: 'unknown',
    circuit: 'closed',
    samples: [],
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
    timeoutCount: 0,
    cancellationCount: 0,
    transferLimitCount: 0,
    totalBytes: 0,
    latencyEwmaMs: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    circuitOpenedAt: null,
    nextProbeAt: null,
    currentOpenDurationMs: 0,
    halfOpenProbes: 0,
    halfOpenSuccesses: 0,
    inFlight: 0,
  };
};

const weightedFailureRatio = (state: ServiceState, policy: Required<GisServiceHealthPolicy>): number => {
  if (!state.samples.length) return 0;
  const weightedFailures = state.samples.reduce((sum, sample) => {
    if (sample.success || sample.cancelled) return sum;
    return sum + (sample.timeout ? policy.timeoutFailureWeight : 1);
  }, 0);
  return weightedFailures / state.samples.length;
};

const latencyPenalty = (state: ServiceState, policy: Required<GisServiceHealthPolicy>): number => {
  const latency = state.latencyEwmaMs;
  if (!latency) return 0;
  if (latency >= policy.verySlowLatencyMs) return 28;
  if (latency >= policy.slowLatencyMs) {
    const range = Math.max(1, policy.verySlowLatencyMs - policy.slowLatencyMs);
    const progress = (latency - policy.slowLatencyMs) / range;
    return 10 + (18 * Math.min(1, progress));
  }
  return Math.max(0, (latency / policy.slowLatencyMs) * 8);
};

const computeHealthScore = (state: ServiceState, policy: Required<GisServiceHealthPolicy>): number => {
  if (!state.samples.length) return 50;
  const failureRatio = weightedFailureRatio(state, policy);
  const consecutivePenalty = Math.min(28, state.consecutiveFailures * 7);
  const failurePenalty = Math.min(55, failureRatio * 75);
  const slowPenalty = latencyPenalty(state, policy);
  const circuitPenalty = state.circuit === 'open' ? 25 : state.circuit === 'half-open' ? 12 : 0;
  const transferPenalty = state.samples.length
    ? Math.min(8, (state.transferLimitCount / Math.max(1, state.successes)) * 4)
    : 0;
  return Math.round(clampNumber(
    100 - failurePenalty - consecutivePenalty - slowPenalty - circuitPenalty - transferPenalty,
    0,
    100,
    0,
  ));
};

const deriveState = (state: ServiceState, policy: Required<GisServiceHealthPolicy>): GisHealthState => {
  if (!state.samples.length) return 'unknown';
  const score = computeHealthScore(state, policy);
  const failureRatio = weightedFailureRatio(state, policy);
  if (
    state.circuit === 'open'
    || state.consecutiveFailures >= policy.consecutiveFailureLimit
    || failureRatio >= policy.unavailableFailureRatio
    || score < policy.degradedScore
  ) return 'unavailable';
  if (
    state.circuit === 'half-open'
    || failureRatio >= policy.degradeFailureRatio
    || state.latencyEwmaMs >= policy.slowLatencyMs
    || score < policy.healthyScore
  ) return 'degraded';
  return 'healthy';
};

const snapshotState = (
  state: ServiceState,
  policy: Required<GisServiceHealthPolicy>,
): GisServiceHealthSnapshot => {
  const durations = state.samples.filter((sample) => !sample.cancelled).map((sample) => sample.durationMs);
  return Object.freeze({
    serviceId: state.serviceId,
    resourceUrl: state.resourceUrl,
    state: state.state,
    circuit: state.circuit,
    samples: state.samples.length,
    successes: state.successes,
    failures: state.failures,
    consecutiveFailures: state.consecutiveFailures,
    timeoutCount: state.timeoutCount,
    cancellationCount: state.cancellationCount,
    transferLimitCount: state.transferLimitCount,
    averageLatencyMs: Math.round(average(durations) * 100) / 100,
    p95LatencyMs: Math.round(percentile(durations, 0.95) * 100) / 100,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt,
    circuitOpenedAt: state.circuitOpenedAt,
    nextProbeAt: state.nextProbeAt,
    inFlight: state.inFlight,
    healthScore: computeHealthScore(state, policy),
  });
};

export const createServiceHealthRuntime = (
  configuration: GisServiceHealthRuntimeConfiguration = {},
) => {
  const clock = typeof configuration.now === 'function' ? configuration.now : () => Date.now();
  let policy = normalizePolicy(configuration.policy);
  const states = new Map<string, ServiceState>();
  const listeners = new Set<(event: GisServiceHealthEvent) => void>();
  const nextSequence = createMonotonicSequence();
  const ticketSequence = createMonotonicSequence();
  const tickets = new Map<string, GisRequestTicket>();
  let destroyed = false;

  const assertActive = (): void => {
    if (destroyed) throw new Error('GIS service health runtime has been destroyed.');
  };

  const getState = (serviceId: unknown): ServiceState | null => {
    const id = normalizeIdentifier(serviceId, 'serviceId');
    return states.get(id) || null;
  };

  const requireState = (serviceId: unknown): ServiceState => {
    const state = getState(serviceId);
    if (!state) throw new Error(`GIS service is not registered: ${String(serviceId)}`);
    return state;
  };

  const emit = (
    state: ServiceState,
    type: string,
    details: Partial<Omit<GisServiceHealthEvent, 'sequence' | 'timestamp' | 'type' | 'serviceId' | 'snapshot'>> = {},
  ): GisServiceHealthEvent => {
    const event: GisServiceHealthEvent = Object.freeze({
      sequence: nextSequence(),
      timestamp: clock(),
      type,
      serviceId: state.serviceId,
      ...details,
      snapshot: snapshotState(state, policy),
    });
    for (const listener of [...listeners]) {
      try { listener(event); } catch (error) { configuration.onListenerError?.(error, event); }
    }
    try { configuration.onEvent?.(event); } catch (error) { configuration.onListenerError?.(error, event); }
    return event;
  };

  const transitionHealth = (state: ServiceState, reason: string): void => {
    const previousState = state.state;
    const nextState = deriveState(state, policy);
    state.state = nextState;
    if (previousState !== nextState) {
      emit(state, 'service-health-transition', { previousState, nextState, reason });
    }
  };

  const openCircuit = (state: ServiceState, reason: string): void => {
    const previousCircuit = state.circuit;
    if (previousCircuit === 'open') return;
    state.circuit = 'open';
    state.circuitOpenedAt = clock();
    state.currentOpenDurationMs = state.currentOpenDurationMs > 0
      ? Math.min(policy.maxOpenCircuitMs, state.currentOpenDurationMs * 2)
      : policy.openCircuitMs;
    state.nextProbeAt = state.circuitOpenedAt + state.currentOpenDurationMs;
    state.halfOpenProbes = 0;
    state.halfOpenSuccesses = 0;
    emit(state, 'service-circuit-transition', { previousCircuit, nextCircuit: 'open', reason });
  };

  const closeCircuit = (state: ServiceState, reason: string): void => {
    const previousCircuit = state.circuit;
    state.circuit = 'closed';
    state.circuitOpenedAt = null;
    state.nextProbeAt = null;
    state.currentOpenDurationMs = 0;
    state.halfOpenProbes = 0;
    state.halfOpenSuccesses = 0;
    if (previousCircuit !== 'closed') {
      emit(state, 'service-circuit-transition', { previousCircuit, nextCircuit: 'closed', reason });
    }
  };

  const moveHalfOpenIfDue = (state: ServiceState): void => {
    if (state.circuit !== 'open') return;
    if (state.nextProbeAt === null || clock() < state.nextProbeAt) return;
    const previousCircuit = state.circuit;
    state.circuit = 'half-open';
    state.halfOpenProbes = 0;
    state.halfOpenSuccesses = 0;
    emit(state, 'service-circuit-transition', {
      previousCircuit,
      nextCircuit: 'half-open',
      reason: 'probe-window-opened',
    });
  };

  const evaluateCircuit = (state: ServiceState, sample: Sample): void => {
    if (sample.cancelled) return;
    if (state.circuit === 'half-open') {
      if (!sample.success) {
        openCircuit(state, 'half-open-probe-failed');
        return;
      }
      state.halfOpenSuccesses += 1;
      if (state.halfOpenSuccesses >= policy.halfOpenProbeLimit) closeCircuit(state, 'half-open-probes-succeeded');
      return;
    }
    if (sample.success) {
      if (state.circuit !== 'closed') closeCircuit(state, 'request-succeeded');
      return;
    }
    const failureRatio = weightedFailureRatio(state, policy);
    const ratioSampleFloorReached = state.samples.length >= policy.consecutiveFailureLimit;
    if (
      state.consecutiveFailures >= policy.consecutiveFailureLimit
      || (ratioSampleFloorReached && failureRatio >= policy.unavailableFailureRatio)
    ) openCircuit(state, 'failure-threshold-exceeded');
  };

  const pushSample = (state: ServiceState, sample: Sample): void => {
    state.samples.push(sample);
    if (state.samples.length > policy.sampleWindow) state.samples.shift();
    if (sample.cancelled) {
      state.cancellationCount += 1;
    } else if (sample.success) {
      state.successes += 1;
      state.consecutiveFailures = 0;
      state.lastSuccessAt = sample.timestamp;
    } else {
      state.failures += 1;
      state.consecutiveFailures += 1;
      state.lastFailureAt = sample.timestamp;
      if (sample.timeout) state.timeoutCount += 1;
    }
    if (sample.transferLimitExceeded) state.transferLimitCount += 1;
    state.totalBytes += sample.bytes;
    if (!sample.cancelled) {
      state.latencyEwmaMs = state.latencyEwmaMs === 0
        ? sample.durationMs
        : ((state.latencyEwmaMs * 0.82) + (sample.durationMs * 0.18));
    }
    evaluateCircuit(state, sample);
    transitionHealth(state, sample.success ? 'request-success' : sample.cancelled ? 'request-cancelled' : 'request-failure');
  };

  const registerService = (registration: GisServiceRegistration): GisServiceHealthSnapshot => {
    assertActive();
    const id = normalizeIdentifier(registration.serviceId, 'serviceId');
    const existing = states.get(id);
    if (existing) {
      const verifiedUrl = assertAllowedArcGisResourceUrl(registration.resourceUrl);
      if (!verifiedUrl || existing.resourceUrl !== verifiedUrl) {
        throw new Error(`Service ${id} cannot be rebound to a different ArcGIS resource URL.`);
      }
      existing.metadataRevision = registration.metadataRevision ?? existing.metadataRevision;
      return snapshotState(existing, policy);
    }
    const state = createState(registration);
    states.set(id, state);
    emit(state, 'service-registered', { reason: 'registration' });
    return snapshotState(state, policy);
  };

  const unregisterService = (serviceId: unknown): boolean => {
    assertActive();
    const state = requireState(serviceId);
    if (state.inFlight > 0) {
      throw new Error(`Service ${state.serviceId} still has ${state.inFlight} tracked request(s) in flight.`);
    }
    const removed = states.delete(state.serviceId);
    if (removed) emit(state, 'service-unregistered', { reason: 'unregistration' });
    return removed;
  };

  const getAvailability = (serviceId: unknown): GisServiceAvailability => {
    if (destroyed) {
      return Object.freeze({
        allowed: false,
        reason: 'destroyed',
        serviceId: String(serviceId ?? ''),
        state: 'unknown',
        circuit: 'open',
        nextProbeAt: null,
      });
    }
    const id = normalizeIdentifier(serviceId, 'serviceId');
    const state = states.get(id);
    if (!state) {
      return Object.freeze({
        allowed: false,
        reason: 'unregistered',
        serviceId: id,
        state: 'unknown',
        circuit: 'open',
        nextProbeAt: null,
      });
    }
    moveHalfOpenIfDue(state);
    const probeCapacityReached = state.circuit === 'half-open' && state.halfOpenProbes >= policy.halfOpenProbeLimit;
    return Object.freeze({
      allowed: state.circuit === 'closed' || (state.circuit === 'half-open' && !probeCapacityReached),
      reason: state.circuit === 'open' ? 'circuit-open' : probeCapacityReached ? 'probe-capacity' : 'ok',
      serviceId: id,
      state: state.state,
      circuit: state.circuit,
      nextProbeAt: state.nextProbeAt,
    });
  };

  const beginRequest = (serviceId: unknown): GisRequestTicket => {
    assertActive();
    const availability = getAvailability(serviceId);
    if (!availability.allowed) {
      throw new Error(`GIS service request rejected: ${availability.serviceId} (${availability.reason}).`);
    }
    const state = requireState(availability.serviceId);
    const probe = state.circuit === 'half-open';
    if (probe) state.halfOpenProbes += 1;
    state.inFlight += 1;
    const ticket: GisRequestTicket = Object.freeze({
      ticketId: `gis-health-${ticketSequence()}`,
      serviceId: state.serviceId,
      startedAt: clock(),
      probe,
    });
    tickets.set(ticket.ticketId, ticket);
    emit(state, 'service-request-started', { reason: probe ? 'half-open-probe' : 'request' });
    return ticket;
  };

  const completeRequest = (
    ticket: GisRequestTicket,
    result: Partial<Omit<GisRequestMetric, 'serviceId' | 'startedAt' | 'durationMs'>> & { durationMs?: number | null } = {},
  ): GisServiceHealthSnapshot => {
    assertActive();
    const tracked = tickets.get(ticket.ticketId);
    if (!tracked || tracked.serviceId !== ticket.serviceId) {
      throw new Error('Unknown or already completed GIS service health ticket.');
    }
    tickets.delete(ticket.ticketId);
    const state = requireState(ticket.serviceId);
    state.inFlight = Math.max(0, state.inFlight - 1);
    const timestamp = clock();
    const durationMs = normalizeDuration(result.durationMs ?? Math.max(0, timestamp - tracked.startedAt));
    const cancelled = result.cancelled === true;
    const timeout = !cancelled && result.timeout === true;
    const status = normalizeStatus(result.status);
    const ok = cancelled
      ? false
      : result.ok === true || (result.ok !== false && status !== null && status >= 200 && status < 400);
    const sample: Sample = Object.freeze({
      timestamp,
      durationMs,
      success: ok,
      timeout,
      cancelled,
      transferLimitExceeded: result.transferLimitExceeded === true,
      status,
      bytes: normalizeBytes(result.bytes),
      errorCode: result.errorCode == null ? null : String(result.errorCode).slice(0, 128),
    });
    pushSample(state, sample);
    emit(state, 'service-request-completed', {
      reason: cancelled
        ? 'cancelled'
        : ok
          ? 'success'
          : timeout
            ? 'timeout'
            : isRetryableStatus(status)
              ? 'retryable-failure'
              : 'failure',
    });
    return snapshotState(state, policy);
  };

  const recordMetric = (metric: GisRequestMetric): GisServiceHealthSnapshot => {
    assertActive();
    const state = requireState(metric.serviceId);
    const timestamp = clock();
    const durationMs = normalizeDuration(metric.durationMs ?? Math.max(0, timestamp - metric.startedAt));
    const cancelled = metric.cancelled === true;
    const timeout = !cancelled && metric.timeout === true;
    const status = normalizeStatus(metric.status);
    const ok = cancelled
      ? false
      : metric.ok === true || (metric.ok !== false && status !== null && status >= 200 && status < 400);
    pushSample(state, Object.freeze({
      timestamp,
      durationMs,
      success: ok,
      timeout,
      cancelled,
      transferLimitExceeded: metric.transferLimitExceeded === true,
      status,
      bytes: normalizeBytes(metric.bytes),
      errorCode: metric.errorCode == null ? null : String(metric.errorCode).slice(0, 128),
    }));
    emit(state, 'service-metric-recorded', { reason: cancelled ? 'cancelled' : ok ? 'success' : 'failure' });
    return snapshotState(state, policy);
  };

  const resetService = (serviceId: unknown): GisServiceHealthSnapshot => {
    assertActive();
    const current = requireState(serviceId);
    if (current.inFlight > 0) throw new Error(`Cannot reset service ${current.serviceId} while requests are in flight.`);
    const replacement = createState({
      serviceId: current.serviceId,
      resourceUrl: current.resourceUrl,
      resourceKind: current.resourceKind,
      maxRecordCount: current.maxRecordCount,
      metadataRevision: current.metadataRevision,
    });
    states.set(current.serviceId, replacement);
    emit(replacement, 'service-health-reset', { reason: 'manual-reset' });
    return snapshotState(replacement, policy);
  };

  const configure = (next: GisServiceHealthPolicy = {}): Required<GisServiceHealthPolicy> => {
    assertActive();
    policy = normalizePolicy({ ...policy, ...next });
    for (const state of states.values()) {
      if (state.samples.length > policy.sampleWindow) {
        state.samples.splice(0, state.samples.length - policy.sampleWindow);
      }
      transitionHealth(state, 'policy-change');
    }
    return policy;
  };

  const getSnapshot = (serviceId?: unknown): GisServiceHealthSnapshot | readonly GisServiceHealthSnapshot[] => {
    if (serviceId !== undefined) return snapshotState(requireState(serviceId), policy);
    return Object.freeze(
      [...states.values()]
        .sort((left, right) => left.serviceId.localeCompare(right.serviceId))
        .map((state) => snapshotState(state, policy)),
    );
  };

  const getSummary = () => {
    const services = [...states.values()].map((state) => snapshotState(state, policy));
    return Object.freeze({
      registered: services.length,
      healthy: services.filter((item) => item.state === 'healthy').length,
      degraded: services.filter((item) => item.state === 'degraded').length,
      unavailable: services.filter((item) => item.state === 'unavailable').length,
      unknown: services.filter((item) => item.state === 'unknown').length,
      openCircuits: services.filter((item) => item.circuit === 'open').length,
      halfOpenCircuits: services.filter((item) => item.circuit === 'half-open').length,
      inFlight: services.reduce((sum, item) => sum + item.inFlight, 0),
      averageHealthScore: services.length
        ? Math.round(average(services.map((item) => item.healthScore)) * 100) / 100
        : 0,
    });
  };

  const subscribe = (listener: (event: GisServiceHealthEvent) => void): (() => void) => {
    if (destroyed || typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    tickets.clear();
    states.clear();
    listeners.clear();
  };

  return Object.freeze({
    registerService,
    unregisterService,
    getAvailability,
    beginRequest,
    completeRequest,
    recordMetric,
    resetService,
    configure,
    getSnapshot,
    getSummary,
    subscribe,
    destroy,
    isDestroyed: () => destroyed,
    getPolicy: () => policy,
  });
};