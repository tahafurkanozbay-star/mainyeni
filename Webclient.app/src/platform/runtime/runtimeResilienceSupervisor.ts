import {
  LoadSheddingPolicy,
  type LoadSheddingDecision,
  type LoadSheddingPriority,
} from './loadSheddingPolicy';
import {
  ResilienceEnvelope,
  type ResilienceEnvelopeBudget,
  type ResilienceEnvelopeLane,
  type ResilienceEnvelopeOptions,
} from './resilienceEnvelope';
import {
  RuntimeDeadlineLedger,
  type RuntimeDeadlineLedgerOptions,
  type RuntimeDeadlineLease,
} from './runtimeDeadlineLedger';
import {
  RuntimeSignalWindow,
  type RuntimeSignalLaneSnapshot,
  type RuntimeSignalWindowOptions,
  type RuntimeSignalWindowSnapshot,
} from './runtimeSignalWindow';

export type RuntimeResilienceLane = ResilienceEnvelopeLane;

export type RuntimeResilienceOutcome =
  | 'success'
  | 'failure'
  | 'timeout'
  | 'cancelled'
  | 'rejected'
  | 'released';

export type RuntimeResilienceRejectionReason =
  | 'capacity'
  | 'queue'
  | 'latency'
  | 'errors'
  | 'duplicate'
  | 'deadline'
  | 'disposed';

export type RuntimeResilienceEventKind =
  | 'admitted'
  | 'shed'
  | 'completed'
  | 'swept'
  | 'signal-rejected'
  | 'observer-failed'
  | 'disposed';

export interface RuntimeResilienceLoad {
  readonly active: number;
  readonly queued: number;
}

export interface RuntimeResilienceSupervisorPolicy {
  readonly minimumSignalSamples: Readonly<Record<RuntimeResilienceLane, number>>;
  readonly maxErrorRate: Readonly<Record<RuntimeResilienceLane, number>>;
  readonly historyLimit: number;
  readonly maxKeyLength: number;
}

export interface RuntimeResilienceSupervisorOptions {
  readonly envelope?: ResilienceEnvelopeOptions;
  readonly signals?: RuntimeSignalWindowOptions;
  readonly deadlines?: RuntimeDeadlineLedgerOptions;
  readonly policy?: Partial<RuntimeResilienceSupervisorPolicy>;
  readonly onEvent?: (event: RuntimeResilienceEvent) => void;
}

export interface RuntimeResilienceAssessRequest {
  readonly lane: RuntimeResilienceLane;
  readonly nowMs: number;
  readonly load: RuntimeResilienceLoad;
}

export interface RuntimeResilienceBeginRequest extends RuntimeResilienceAssessRequest {
  readonly key: string;
  readonly timeoutMs?: number;
  readonly parentDeadlineMs?: number;
}

export interface RuntimeResilienceDecision {
  readonly lane: RuntimeResilienceLane;
  readonly admitted: boolean;
  readonly reason: LoadSheddingDecision['reason'];
  readonly pressure: number;
  readonly budget: ResilienceEnvelopeBudget;
  readonly signalCount: number;
  readonly p95LatencyMs: number;
  readonly errorRate: number;
  readonly active: number;
  readonly queued: number;
  readonly assessedAtMs: number;
}

export interface RuntimeResilienceCompletion {
  readonly outcome: RuntimeResilienceOutcome;
  readonly nowMs: number;
  readonly latencyMs?: number;
  readonly weight?: number;
}

export interface RuntimeResilienceLease {
  readonly lane: RuntimeResilienceLane;
  readonly createdAtMs: number;
  readonly deadlineMs: number;
  readonly timeoutMs: number;
  readonly decision: RuntimeResilienceDecision;
  readonly remainingMs: (nowMs: number) => number;
  readonly expired: (nowMs: number) => boolean;
  readonly finish: (completion: RuntimeResilienceCompletion) => boolean;
}

export interface RuntimeResilienceBeginAccepted {
  readonly admitted: true;
  readonly lease: RuntimeResilienceLease;
  readonly decision: RuntimeResilienceDecision;
}

export interface RuntimeResilienceBeginRejected {
  readonly admitted: false;
  readonly reason: RuntimeResilienceRejectionReason;
  readonly decision: RuntimeResilienceDecision | null;
}

export type RuntimeResilienceBeginResult =
  | RuntimeResilienceBeginAccepted
  | RuntimeResilienceBeginRejected;

export interface RuntimeResilienceCounters {
  readonly assessed: number;
  readonly admitted: number;
  readonly shed: number;
  readonly completed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly timedOut: number;
  readonly cancelled: number;
  readonly rejected: number;
  readonly released: number;
  readonly duplicateRejected: number;
  readonly deadlineRejected: number;
  readonly signalRejected: number;
  readonly swept: number;
  readonly observerFailures: number;
}

export interface RuntimeResilienceLaneCounters {
  readonly admitted: number;
  readonly shed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly timedOut: number;
  readonly cancelled: number;
  readonly rejected: number;
  readonly released: number;
}

export interface RuntimeResilienceEvent {
  readonly sequence: number;
  readonly at: number;
  readonly kind: RuntimeResilienceEventKind;
  readonly lane?: RuntimeResilienceLane;
  readonly outcome?: RuntimeResilienceOutcome;
  readonly rejectionReason?: RuntimeResilienceRejectionReason;
  readonly pressure?: number;
  readonly signalCount?: number;
  readonly durationMs?: number;
  readonly errorName?: string;
}

export interface RuntimeResilienceSupervisorSnapshot {
  readonly disposed: boolean;
  readonly active: number;
  readonly lastNowMs: number | null;
  readonly counters: RuntimeResilienceCounters;
  readonly laneCounters: Readonly<Record<RuntimeResilienceLane, RuntimeResilienceLaneCounters>>;
  readonly activeByLane: Readonly<Record<RuntimeResilienceLane, number>>;
  readonly signals: RuntimeSignalWindowSnapshot;
  readonly envelope: Readonly<Record<RuntimeResilienceLane, ResilienceEnvelopeBudget>>;
  readonly events: readonly RuntimeResilienceEvent[];
  readonly fingerprint: string;
}

export interface RuntimeResilienceSupervisor {
  readonly assess: (request: RuntimeResilienceAssessRequest) => RuntimeResilienceDecision;
  readonly begin: (request: RuntimeResilienceBeginRequest) => RuntimeResilienceBeginResult;
  readonly recordSignal: (
    lane: RuntimeResilienceLane,
    latencyMs: number,
    success: boolean,
    nowMs: number,
    weight?: number,
  ) => boolean;
  readonly sweep: (nowMs: number) => number;
  readonly snapshot: () => RuntimeResilienceSupervisorSnapshot;
  readonly dispose: (nowMs: number) => void;
}

export class RuntimeResilienceRejectedError extends Error {
  readonly code = 'PLATFORM_RESILIENCE_SHED';

  constructor(
    readonly reason: RuntimeResilienceRejectionReason,
    readonly decision: RuntimeResilienceDecision | null = null,
  ) {
    super('Runtime resilience policy rejected the workload.');
    this.name = 'RuntimeResilienceRejectedError';
  }
}

interface MutableCounters {
  assessed: number;
  admitted: number;
  shed: number;
  completed: number;
  succeeded: number;
  failed: number;
  timedOut: number;
  cancelled: number;
  rejected: number;
  released: number;
  duplicateRejected: number;
  deadlineRejected: number;
  signalRejected: number;
  swept: number;
  observerFailures: number;
}

interface MutableLaneCounters {
  admitted: number;
  shed: number;
  succeeded: number;
  failed: number;
  timedOut: number;
  cancelled: number;
  rejected: number;
  released: number;
}

interface ActiveSession {
  readonly key: string;
  readonly lane: RuntimeResilienceLane;
  readonly startedAtMs: number;
  readonly deadline: RuntimeDeadlineLease;
  readonly decision: RuntimeResilienceDecision;
  settled: boolean;
}

const LANES: readonly RuntimeResilienceLane[] = Object.freeze([
  'critical',
  'interactive',
  'background',
]);

const DEFAULT_POLICY: RuntimeResilienceSupervisorPolicy = Object.freeze({
  minimumSignalSamples: Object.freeze({
    critical: 6,
    interactive: 8,
    background: 6,
  }),
  maxErrorRate: Object.freeze({
    critical: 0.25,
    interactive: 0.15,
    background: 0.08,
  }),
  historyLimit: 128,
  maxKeyLength: 192,
});

const emptyLaneCounters = (): MutableLaneCounters => ({
  admitted: 0,
  shed: 0,
  succeeded: 0,
  failed: 0,
  timedOut: 0,
  cancelled: 0,
  rejected: 0,
  released: 0,
});

const createCounters = (): MutableCounters => ({
  assessed: 0,
  admitted: 0,
  shed: 0,
  completed: 0,
  succeeded: 0,
  failed: 0,
  timedOut: 0,
  cancelled: 0,
  rejected: 0,
  released: 0,
  duplicateRejected: 0,
  deadlineRejected: 0,
  signalRejected: 0,
  swept: 0,
  observerFailures: 0,
});

const finiteNonNegative = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(name + ' must be a finite non-negative number');
  }
  return value;
};

const positiveInteger = (
  value: number,
  name: string,
  maximum: number,
): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(
      name + ' must be a positive safe integer <= ' + maximum,
    );
  }
  return value;
};

const normalizeRate = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new RangeError(name + ' must be > 0 and <= 1');
  }
  return value;
};

const normalizeLaneRecord = <TValue>(
  source: Partial<Record<RuntimeResilienceLane, TValue>> | undefined,
  fallback: Readonly<Record<RuntimeResilienceLane, TValue>>,
): Readonly<Record<RuntimeResilienceLane, TValue>> => Object.freeze({
  critical: source?.critical ?? fallback.critical,
  interactive: source?.interactive ?? fallback.interactive,
  background: source?.background ?? fallback.background,
});

const normalizePolicy = (
  source: Partial<RuntimeResilienceSupervisorPolicy> = {},
): RuntimeResilienceSupervisorPolicy => {
  const minimumSignalSamples = normalizeLaneRecord(
    source.minimumSignalSamples,
    DEFAULT_POLICY.minimumSignalSamples,
  );
  const maxErrorRate = normalizeLaneRecord(
    source.maxErrorRate,
    DEFAULT_POLICY.maxErrorRate,
  );

  return Object.freeze({
    minimumSignalSamples: Object.freeze({
      critical: positiveInteger(
        minimumSignalSamples.critical,
        'minimumSignalSamples.critical',
        10_000,
      ),
      interactive: positiveInteger(
        minimumSignalSamples.interactive,
        'minimumSignalSamples.interactive',
        10_000,
      ),
      background: positiveInteger(
        minimumSignalSamples.background,
        'minimumSignalSamples.background',
        10_000,
      ),
    }),
    maxErrorRate: Object.freeze({
      critical: normalizeRate(maxErrorRate.critical, 'maxErrorRate.critical'),
      interactive: normalizeRate(
        maxErrorRate.interactive,
        'maxErrorRate.interactive',
      ),
      background: normalizeRate(
        maxErrorRate.background,
        'maxErrorRate.background',
      ),
    }),
    historyLimit: positiveInteger(
      source.historyLimit ?? DEFAULT_POLICY.historyLimit,
      'historyLimit',
      2_048,
    ),
    maxKeyLength: positiveInteger(
      source.maxKeyLength ?? DEFAULT_POLICY.maxKeyLength,
      'maxKeyLength',
      1_024,
    ),
  });
};

const normalizeLoad = (load: RuntimeResilienceLoad): RuntimeResilienceLoad => {
  const active = finiteNonNegative(load.active, 'load.active');
  const queued = finiteNonNegative(load.queued, 'load.queued');
  if (!Number.isSafeInteger(active) || !Number.isSafeInteger(queued)) {
    throw new RangeError('load counts must be safe integers');
  }
  return Object.freeze({ active, queued });
};

const normalizeKey = (key: string, maximum: number): string => {
  const normalized = key.trim();
  if (!normalized) throw new TypeError('resilience key must not be empty');
  if (normalized.length > maximum) {
    throw new RangeError(
      'resilience key exceeds the maximum length of ' + maximum,
    );
  }
  return normalized;
};

const priorityForLane = (
  lane: RuntimeResilienceLane,
): LoadSheddingPriority => lane;

const errorName = (error: unknown): string =>
  error instanceof Error && error.name.trim()
    ? error.name.trim().slice(0, 80)
    : 'UnknownError';

const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const freezeDecision = (
  value: RuntimeResilienceDecision,
): RuntimeResilienceDecision => Object.freeze({
  ...value,
  budget: value.budget,
});

const decisionFrom = (
  lane: RuntimeResilienceLane,
  nowMs: number,
  load: RuntimeResilienceLoad,
  budget: ResilienceEnvelopeBudget,
  signals: RuntimeSignalLaneSnapshot,
  minimumSignalSamples: number,
  policy: LoadSheddingPolicy,
): RuntimeResilienceDecision => {
  const enoughSignals = signals.count >= minimumSignalSamples;
  const result = policy.evaluate({
    active: load.active,
    queued: load.queued,
    latencyMs: enoughSignals ? signals.p95LatencyMs : 0,
    errorRate: enoughSignals ? signals.errorRate : 0,
  }, priorityForLane(lane));

  return freezeDecision({
    lane,
    admitted: result.admitted,
    reason: result.reason,
    pressure: result.pressure,
    budget,
    signalCount: signals.count,
    p95LatencyMs: signals.p95LatencyMs,
    errorRate: signals.errorRate,
    active: load.active,
    queued: load.queued,
    assessedAtMs: nowMs,
  });
};

const immutableCounters = (
  counters: MutableCounters,
): RuntimeResilienceCounters => Object.freeze({ ...counters });

const immutableLaneCounters = (
  counters: Readonly<Record<RuntimeResilienceLane, MutableLaneCounters>>,
): Readonly<Record<RuntimeResilienceLane, RuntimeResilienceLaneCounters>> =>
  Object.freeze({
    critical: Object.freeze({ ...counters.critical }),
    interactive: Object.freeze({ ...counters.interactive }),
    background: Object.freeze({ ...counters.background }),
  });

const outcomeCounter = (
  counters: MutableCounters,
  laneCounters: MutableLaneCounters,
  outcome: RuntimeResilienceOutcome,
): void => {
  if (outcome === 'success') {
    counters.succeeded += 1;
    laneCounters.succeeded += 1;
  } else if (outcome === 'failure') {
    counters.failed += 1;
    laneCounters.failed += 1;
  } else if (outcome === 'timeout') {
    counters.timedOut += 1;
    laneCounters.timedOut += 1;
  } else if (outcome === 'cancelled') {
    counters.cancelled += 1;
    laneCounters.cancelled += 1;
  } else if (outcome === 'rejected') {
    counters.rejected += 1;
    laneCounters.rejected += 1;
  } else {
    counters.released += 1;
    laneCounters.released += 1;
  }
};

export const createRuntimeResilienceSupervisor = (
  options: RuntimeResilienceSupervisorOptions = {},
): RuntimeResilienceSupervisor => {
  const policy = normalizePolicy(options.policy);
  const envelope = new ResilienceEnvelope(options.envelope);
  const signals = new RuntimeSignalWindow(options.signals);
  const deadlines = new RuntimeDeadlineLedger(options.deadlines);
  const counters = createCounters();
  const laneCounters: Record<RuntimeResilienceLane, MutableLaneCounters> = {
    critical: emptyLaneCounters(),
    interactive: emptyLaneCounters(),
    background: emptyLaneCounters(),
  };
  const policies: Readonly<Record<RuntimeResilienceLane, LoadSheddingPolicy>> =
    Object.freeze({
      critical: new LoadSheddingPolicy({
        maxActive: envelope.budget('critical').maxInFlight,
        maxQueued: envelope.budget('critical').maxQueued,
        maxLatencyMs: envelope.budget('critical').timeoutMs,
        maxErrorRate: policy.maxErrorRate.critical,
      }),
      interactive: new LoadSheddingPolicy({
        maxActive: envelope.budget('interactive').maxInFlight,
        maxQueued: envelope.budget('interactive').maxQueued,
        maxLatencyMs: envelope.budget('interactive').timeoutMs,
        maxErrorRate: policy.maxErrorRate.interactive,
      }),
      background: new LoadSheddingPolicy({
        maxActive: envelope.budget('background').maxInFlight,
        maxQueued: envelope.budget('background').maxQueued,
        maxLatencyMs: envelope.budget('background').timeoutMs,
        maxErrorRate: policy.maxErrorRate.background,
      }),
    });

  const active = new Map<string, ActiveSession>();
  const events: RuntimeResilienceEvent[] = [];
  let sequence = 0;
  let lastNowMs: number | null = null;
  let disposed = false;

  const observeNow = (nowMs: number): number => {
    const normalized = finiteNonNegative(nowMs, 'nowMs');
    if (lastNowMs !== null && normalized < lastNowMs) {
      throw new RangeError('runtime resilience clock must be monotonic');
    }
    lastNowMs = normalized;
    return normalized;
  };

  const emit = (
    kind: RuntimeResilienceEventKind,
    at: number,
    details: Omit<RuntimeResilienceEvent, 'sequence' | 'at' | 'kind'> = {},
  ): void => {
    const event: RuntimeResilienceEvent = Object.freeze({
      sequence: ++sequence,
      at,
      kind,
      ...details,
    });
    events.push(event);
    if (events.length > policy.historyLimit) {
      events.splice(0, events.length - policy.historyLimit);
    }
    if (!options.onEvent) return;
    try {
      options.onEvent(event);
    } catch (error) {
      counters.observerFailures += 1;
      const observerEvent: RuntimeResilienceEvent = Object.freeze({
        sequence: ++sequence,
        at,
        kind: 'observer-failed',
        errorName: errorName(error),
      });
      events.push(observerEvent);
      if (events.length > policy.historyLimit) {
        events.splice(0, events.length - policy.historyLimit);
      }
    }
  };

  const laneSignals = (
    lane: RuntimeResilienceLane,
  ): RuntimeSignalLaneSnapshot => signals.snapshot().lanes[lane];

  const assess = (
    request: RuntimeResilienceAssessRequest,
  ): RuntimeResilienceDecision => {
    if (disposed) {
      throw new RuntimeResilienceRejectedError('disposed');
    }
    if (!LANES.includes(request.lane)) {
      throw new TypeError('runtime resilience lane is invalid');
    }
    const nowMs = observeNow(request.nowMs);
    signals.evictExpired(nowMs);
    const load = normalizeLoad(request.load);
    const budget = envelope.budget(request.lane);
    const decision = decisionFrom(
      request.lane,
      nowMs,
      load,
      budget,
      laneSignals(request.lane),
      policy.minimumSignalSamples[request.lane],
      policies[request.lane],
    );
    counters.assessed += 1;
    return decision;
  };

  const finalize = (
    session: ActiveSession,
    completion: RuntimeResilienceCompletion,
    forcedOutcome?: RuntimeResilienceOutcome,
  ): boolean => {
    if (session.settled || !active.has(session.key)) return false;
    const nowMs = observeNow(completion.nowMs);
    const deadlineExpired = nowMs >= session.deadline.deadlineMs;
    const outcome = forcedOutcome
      ?? (deadlineExpired ? 'timeout' : completion.outcome);
    session.settled = true;
    active.delete(session.key);

    if (outcome === 'cancelled' || outcome === 'released' || outcome === 'rejected') {
      deadlines.release(session.key, nowMs);
    } else {
      session.deadline.complete(nowMs);
    }

    const measuredLatency = completion.latencyMs === undefined
      ? Math.max(0, nowMs - session.startedAtMs)
      : finiteNonNegative(completion.latencyMs, 'latencyMs');
    const weight = completion.weight;
    if (outcome === 'success' || outcome === 'failure' || outcome === 'timeout') {
      const accepted = signals.record({
        lane: session.lane,
        latencyMs: measuredLatency,
        success: outcome === 'success',
        timestampMs: nowMs,
        ...(weight === undefined ? {} : { weight }),
      });
      if (!accepted) {
        counters.signalRejected += 1;
        emit('signal-rejected', nowMs, {
          lane: session.lane,
          outcome,
          durationMs: measuredLatency,
        });
      }
    }

    counters.completed += 1;
    outcomeCounter(counters, laneCounters[session.lane], outcome);
    emit('completed', nowMs, {
      lane: session.lane,
      outcome,
      pressure: session.decision.pressure,
      signalCount: laneSignals(session.lane).count,
      durationMs: measuredLatency,
    });
    return true;
  };

  const begin = (
    request: RuntimeResilienceBeginRequest,
  ): RuntimeResilienceBeginResult => {
    if (disposed) {
      return Object.freeze({
        admitted: false,
        reason: 'disposed',
        decision: null,
      });
    }

    const key = normalizeKey(request.key, policy.maxKeyLength);
    const nowMs = observeNow(request.nowMs);
    if (active.has(key)) {
      counters.shed += 1;
      counters.duplicateRejected += 1;
      laneCounters[request.lane].shed += 1;
      emit('shed', nowMs, {
        lane: request.lane,
        rejectionReason: 'duplicate',
      });
      return Object.freeze({
        admitted: false,
        reason: 'duplicate',
        decision: null,
      });
    }

    const decision = assess({
      lane: request.lane,
      nowMs,
      load: request.load,
    });
    if (!decision.admitted) {
      counters.shed += 1;
      laneCounters[request.lane].shed += 1;
      const reason = decision.reason === 'healthy' || decision.reason === 'priority'
        ? 'capacity'
        : decision.reason;
      emit('shed', nowMs, {
        lane: request.lane,
        rejectionReason: reason,
        pressure: decision.pressure,
        signalCount: decision.signalCount,
      });
      return Object.freeze({
        admitted: false,
        reason,
        decision,
      });
    }

    const budget = decision.budget;
    const requestedTimeout = request.timeoutMs === undefined
      ? budget.timeoutMs
      : Math.min(
        finiteNonNegative(request.timeoutMs, 'timeoutMs'),
        budget.timeoutMs,
      );
    const deadline = deadlines.create({
      key,
      lane: request.lane,
      nowMs,
      timeoutMs: requestedTimeout,
      ...(request.parentDeadlineMs === undefined
        ? {}
        : { parentDeadlineMs: request.parentDeadlineMs }),
    });
    if (!deadline) {
      counters.shed += 1;
      counters.deadlineRejected += 1;
      laneCounters[request.lane].shed += 1;
      emit('shed', nowMs, {
        lane: request.lane,
        rejectionReason: 'deadline',
        pressure: decision.pressure,
        signalCount: decision.signalCount,
      });
      return Object.freeze({
        admitted: false,
        reason: 'deadline',
        decision,
      });
    }

    const session: ActiveSession = {
      key,
      lane: request.lane,
      startedAtMs: nowMs,
      deadline,
      decision,
      settled: false,
    };
    active.set(key, session);
    counters.admitted += 1;
    laneCounters[request.lane].admitted += 1;
    emit('admitted', nowMs, {
      lane: request.lane,
      pressure: decision.pressure,
      signalCount: decision.signalCount,
    });

    const lease: RuntimeResilienceLease = Object.freeze({
      lane: request.lane,
      createdAtMs: deadline.createdAtMs,
      deadlineMs: deadline.deadlineMs,
      timeoutMs: deadline.timeoutMs,
      decision,
      remainingMs: (value: number): number => deadline.remainingMs(value),
      expired: (value: number): boolean => deadline.expired(value),
      finish: (completion: RuntimeResilienceCompletion): boolean =>
        finalize(session, completion),
    });

    return Object.freeze({
      admitted: true,
      lease,
      decision,
    });
  };

  const recordSignal = (
    lane: RuntimeResilienceLane,
    latencyMs: number,
    success: boolean,
    nowMs: number,
    weight?: number,
  ): boolean => {
    if (disposed) {
      throw new RuntimeResilienceRejectedError('disposed');
    }
    if (!LANES.includes(lane)) throw new TypeError('runtime resilience lane is invalid');
    const timestamp = observeNow(nowMs);
    const accepted = signals.record({
      lane,
      latencyMs: finiteNonNegative(latencyMs, 'latencyMs'),
      success,
      timestampMs: timestamp,
      ...(weight === undefined ? {} : { weight }),
    });
    if (!accepted) {
      counters.signalRejected += 1;
      emit('signal-rejected', timestamp, { lane });
    }
    return accepted;
  };

  const sweep = (nowMs: number): number => {
    if (disposed) return 0;
    const timestamp = observeNow(nowMs);
    let swept = 0;
    for (const session of active.values()) {
      if (session.settled || timestamp < session.deadline.deadlineMs) continue;
      if (finalize(
        session,
        {
          outcome: 'timeout',
          nowMs: timestamp,
          latencyMs: Math.max(0, timestamp - session.startedAtMs),
        },
        'timeout',
      )) {
        swept += 1;
      }
    }
    counters.swept += swept;
    if (swept > 0) {
      emit('swept', timestamp, { durationMs: 0 });
    }
    return swept;
  };

  const snapshot = (): RuntimeResilienceSupervisorSnapshot => {
    const deadlineSnapshot = deadlines.snapshot();
    const signalSnapshot = signals.snapshot();
    const counterSnapshot = immutableCounters(counters);
    const laneCounterSnapshot = immutableLaneCounters(laneCounters);
    const eventSnapshot = Object.freeze(events.slice());
    const fingerprint = fnv1a([
      Number(disposed),
      active.size,
      lastNowMs ?? '',
      ...Object.values(counterSnapshot),
      ...LANES.flatMap((lane) => [
        lane,
        deadlineSnapshot.byLane[lane],
        laneCounterSnapshot[lane].admitted,
        laneCounterSnapshot[lane].shed,
        laneCounterSnapshot[lane].succeeded,
        laneCounterSnapshot[lane].failed,
        laneCounterSnapshot[lane].timedOut,
        signalSnapshot.lanes[lane].count,
        signalSnapshot.lanes[lane].errorRate,
        signalSnapshot.lanes[lane].p95LatencyMs,
      ]),
    ].join('|'));

    return Object.freeze({
      disposed,
      active: active.size,
      lastNowMs,
      counters: counterSnapshot,
      laneCounters: laneCounterSnapshot,
      activeByLane: Object.freeze({ ...deadlineSnapshot.byLane }),
      signals: signalSnapshot,
      envelope: envelope.snapshot(),
      events: eventSnapshot,
      fingerprint,
    });
  };

  const dispose = (nowMs: number): void => {
    if (disposed) return;
    const timestamp = observeNow(nowMs);
    for (const session of active.values()) {
      finalize(session, {
        outcome: 'released',
        nowMs: timestamp,
        latencyMs: Math.max(0, timestamp - session.startedAtMs),
      }, 'released');
    }
    active.clear();
    disposed = true;
    emit('disposed', timestamp);
  };

  return Object.freeze({
    assess,
    begin,
    recordSignal,
    sweep,
    snapshot,
    dispose,
  });
};
