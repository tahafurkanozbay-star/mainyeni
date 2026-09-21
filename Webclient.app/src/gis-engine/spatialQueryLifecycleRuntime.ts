export type SpatialQueryLifecyclePriority = 'background' | 'normal' | 'interactive';
export type SpatialQueryLifecyclePhase =
  | 'registered'
  | 'admitted'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type SpatialQueryLifecycleTerminalPhase = Extract<
  SpatialQueryLifecyclePhase,
  'completed' | 'failed' | 'cancelled' | 'expired'
>;

export interface SpatialQueryLifecycleConfig {
  readonly maxTrackedQueries: number;
  readonly maxEvents: number;
  readonly maxLifetimeMs: number;
  readonly maxExecutionMs: number;
  readonly maxTerminalAgeMs: number;
  readonly maxRequestKeyLength: number;
  readonly maxOwnerIdLength: number;
  readonly maxServiceIdLength: number;
}

export interface SpatialQueryLifecycleRegistration {
  readonly serviceId: string;
  readonly layerId: number;
  readonly ownerId: string;
  readonly requestKey: string;
  readonly priority?: SpatialQueryLifecyclePriority;
  readonly expectedFeatures?: number;
  readonly expectedBytes?: number;
  readonly now?: number;
}

export interface SpatialQueryLifecycleRecord {
  readonly id: number;
  readonly serviceId: string;
  readonly layerId: number;
  readonly ownerId: string;
  readonly requestKey: string;
  readonly priority: SpatialQueryLifecyclePriority;
  readonly expectedFeatures: number;
  readonly expectedBytes: number;
  readonly phase: SpatialQueryLifecyclePhase;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lifetimeDeadlineAt: number;
  readonly executionDeadlineAt: number | null;
  readonly terminalAt: number | null;
  readonly version: number;
}

export interface SpatialQueryLifecycleEvent {
  readonly sequence: number;
  readonly queryId: number;
  readonly serviceId: string;
  readonly layerId: number;
  readonly ownerId: string;
  readonly from: SpatialQueryLifecyclePhase | null;
  readonly to: SpatialQueryLifecyclePhase;
  readonly at: number;
  readonly version: number;
}

export interface SpatialQueryLifecycleSnapshot {
  readonly tracked: number;
  readonly active: number;
  readonly terminal: number;
  readonly registered: number;
  readonly admitted: number;
  readonly executing: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly expired: number;
  readonly owners: number;
  readonly services: number;
  readonly expectedFeaturesActive: number;
  readonly expectedBytesActive: number;
  readonly createdTotal: number;
  readonly transitionedTotal: number;
  readonly removedTotal: number;
  readonly generation: number;
}

export interface SpatialQueryLifecycleRuntime {
  register(input: SpatialQueryLifecycleRegistration): SpatialQueryLifecycleRecord;
  admit(queryId: number, now?: number): SpatialQueryLifecycleRecord;
  start(queryId: number, now?: number): SpatialQueryLifecycleRecord;
  complete(queryId: number, now?: number): SpatialQueryLifecycleRecord;
  fail(queryId: number, now?: number): SpatialQueryLifecycleRecord;
  cancel(queryId: number, now?: number): SpatialQueryLifecycleRecord;
  cancelOwner(ownerId: string, now?: number): number;
  expireDue(now?: number, limit?: number): readonly SpatialQueryLifecycleRecord[];
  sweepTerminal(now?: number, limit?: number): number;
  get(queryId: number): SpatialQueryLifecycleRecord | undefined;
  events(limit?: number): readonly SpatialQueryLifecycleEvent[];
  snapshot(): SpatialQueryLifecycleSnapshot;
  clearTerminal(): number;
  dispose(): number;
}

const DEFAULT_CONFIG: SpatialQueryLifecycleConfig = {
  maxTrackedQueries: 2_048,
  maxEvents: 4_096,
  maxLifetimeMs: 120_000,
  maxExecutionMs: 60_000,
  maxTerminalAgeMs: 30_000,
  maxRequestKeyLength: 512,
  maxOwnerIdLength: 128,
  maxServiceIdLength: 256,
};

const TERMINAL_PHASES = new Set<SpatialQueryLifecyclePhase>([
  'completed',
  'failed',
  'cancelled',
  'expired',
]);

const normalizePositiveSafeInteger = (value: number, name: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(name + ' must be a positive safe integer no greater than ' + maximum);
  }
  return value;
};

const normalizeNonNegativeSafeInteger = (value: number, name: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(name + ' must be a non-negative safe integer no greater than ' + maximum);
  }
  return value;
};

const normalizeTimestamp = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(name + ' must be a non-negative safe integer timestamp');
  }
  return value;
};

const normalizeIdentifier = (value: string, name: string, maximumLength: number): string => {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(name + ' is required');
  if (normalized.length > maximumLength) {
    throw new RangeError(name + ' cannot exceed ' + maximumLength + ' characters');
  }
  return normalized;
};

const normalizePriority = (
  value: SpatialQueryLifecyclePriority | undefined,
): SpatialQueryLifecyclePriority => {
  const normalized = value ?? 'normal';
  if (normalized !== 'background' && normalized !== 'normal' && normalized !== 'interactive') {
    throw new TypeError('priority is invalid');
  }
  return normalized;
};

const safeDeadline = (start: number, duration: number, name: string): number => {
  const deadline = start + duration;
  if (!Number.isSafeInteger(deadline)) {
    throw new RangeError(name + ' exceeds the safe timestamp range');
  }
  return deadline;
};

export const normalizeSpatialQueryLifecycleConfig = (
  input: Partial<SpatialQueryLifecycleConfig> = {},
): SpatialQueryLifecycleConfig => {
  const config = { ...DEFAULT_CONFIG, ...input };
  normalizePositiveSafeInteger(config.maxTrackedQueries, 'maxTrackedQueries', 100_000);
  normalizePositiveSafeInteger(config.maxEvents, 'maxEvents', 200_000);
  normalizePositiveSafeInteger(config.maxLifetimeMs, 'maxLifetimeMs', 24 * 60 * 60_000);
  normalizePositiveSafeInteger(config.maxExecutionMs, 'maxExecutionMs', 24 * 60 * 60_000);
  normalizeNonNegativeSafeInteger(config.maxTerminalAgeMs, 'maxTerminalAgeMs', 24 * 60 * 60_000);
  normalizePositiveSafeInteger(config.maxRequestKeyLength, 'maxRequestKeyLength', 16_384);
  normalizePositiveSafeInteger(config.maxOwnerIdLength, 'maxOwnerIdLength', 2_048);
  normalizePositiveSafeInteger(config.maxServiceIdLength, 'maxServiceIdLength', 4_096);
  if (config.maxExecutionMs > config.maxLifetimeMs) {
    throw new RangeError('maxExecutionMs cannot exceed maxLifetimeMs');
  }
  return Object.freeze(config);
};

const isTerminal = (phase: SpatialQueryLifecyclePhase): boolean => TERMINAL_PHASES.has(phase);

const canTransition = (
  from: SpatialQueryLifecyclePhase,
  to: SpatialQueryLifecyclePhase,
): boolean => {
  if (from === 'registered') {
    return to === 'admitted' || to === 'cancelled' || to === 'expired' || to === 'failed';
  }
  if (from === 'admitted') {
    return to === 'executing' || to === 'cancelled' || to === 'expired' || to === 'failed';
  }
  if (from === 'executing') {
    return to === 'completed' || to === 'failed' || to === 'cancelled' || to === 'expired';
  }
  return false;
};

const freezeRecord = (
  value: SpatialQueryLifecycleRecord,
): SpatialQueryLifecycleRecord => Object.freeze(value);

export const createSpatialQueryLifecycleRuntime = (
  input: Partial<SpatialQueryLifecycleConfig> = {},
): SpatialQueryLifecycleRuntime => {
  const config = normalizeSpatialQueryLifecycleConfig(input);
  const records = new Map<number, SpatialQueryLifecycleRecord>();
  const ownerActiveIds = new Map<string, Set<number>>();
  const eventRing = new Array<SpatialQueryLifecycleEvent | undefined>(config.maxEvents);
  let eventCursor = 0;
  let eventCount = 0;
  let nextId = 0;
  let nextEventSequence = 0;
  let createdTotal = 0;
  let transitionedTotal = 0;
  let removedTotal = 0;
  let generation = 0;
  let disposed = false;

  const ensureOpen = (): void => {
    if (disposed) throw new Error('spatial query lifecycle runtime is disposed');
  };

  const recordEvent = (
    record: SpatialQueryLifecycleRecord,
    from: SpatialQueryLifecyclePhase | null,
    to: SpatialQueryLifecyclePhase,
    at: number,
  ): void => {
    const event: SpatialQueryLifecycleEvent = Object.freeze({
      sequence: ++nextEventSequence,
      queryId: record.id,
      serviceId: record.serviceId,
      layerId: record.layerId,
      ownerId: record.ownerId,
      from,
      to,
      at,
      version: record.version,
    });
    eventRing[eventCursor] = event;
    eventCursor = (eventCursor + 1) % config.maxEvents;
    if (eventCount < config.maxEvents) eventCount += 1;
  };

  const indexActiveOwner = (record: SpatialQueryLifecycleRecord): void => {
    if (isTerminal(record.phase)) return;
    const existing = ownerActiveIds.get(record.ownerId);
    if (existing) {
      existing.add(record.id);
      return;
    }
    ownerActiveIds.set(record.ownerId, new Set([record.id]));
  };

  const unindexActiveOwner = (record: SpatialQueryLifecycleRecord): void => {
    const ids = ownerActiveIds.get(record.ownerId);
    if (!ids) return;
    ids.delete(record.id);
    if (ids.size === 0) ownerActiveIds.delete(record.ownerId);
  };

  const removeRecord = (record: SpatialQueryLifecycleRecord): boolean => {
    if (!records.delete(record.id)) return false;
    unindexActiveOwner(record);
    removedTotal += 1;
    generation += 1;
    return true;
  };

  const transition = (
    queryId: number,
    target: SpatialQueryLifecyclePhase,
    nowInput: number,
  ): SpatialQueryLifecycleRecord => {
    ensureOpen();
    const now = normalizeTimestamp(nowInput, 'now');
    if (!Number.isSafeInteger(queryId) || queryId <= 0) throw new RangeError('queryId must be a positive safe integer');
    const current = records.get(queryId);
    if (!current) throw new Error('query lifecycle record was not found');
    if (!canTransition(current.phase, target)) {
      throw new Error('invalid lifecycle transition from ' + current.phase + ' to ' + target);
    }
    if (now < current.updatedAt) throw new RangeError('now cannot move backwards');

    const terminalAt = isTerminal(target) ? now : null;
    const executionDeadlineAt = target === 'executing'
      ? Math.min(current.lifetimeDeadlineAt, safeDeadline(now, config.maxExecutionMs, 'execution deadline'))
      : current.executionDeadlineAt;

    const updated = freezeRecord({
      ...current,
      phase: target,
      updatedAt: now,
      executionDeadlineAt,
      terminalAt,
      version: current.version + 1,
    });

    records.set(queryId, updated);
    if (isTerminal(target)) unindexActiveOwner(current);
    transitionedTotal += 1;
    generation += 1;
    recordEvent(updated, current.phase, target, now);
    return updated;
  };

  const get = (queryId: number): SpatialQueryLifecycleRecord | undefined => {
    if (!Number.isSafeInteger(queryId) || queryId <= 0) return undefined;
    return records.get(queryId);
  };

  const sweepTerminal = (nowInput = Date.now(), limitInput = config.maxTrackedQueries): number => {
    ensureOpen();
    const now = normalizeTimestamp(nowInput, 'now');
    const limit = normalizePositiveSafeInteger(limitInput, 'limit', config.maxTrackedQueries);
    let removed = 0;
    for (const record of records.values()) {
      if (removed >= limit) break;
      if (!isTerminal(record.phase) || record.terminalAt === null) continue;
      if (now < record.terminalAt) continue;
      if (now - record.terminalAt < config.maxTerminalAgeMs) continue;
      if (removeRecord(record)) removed += 1;
    }
    return removed;
  };

  const register = (registration: SpatialQueryLifecycleRegistration): SpatialQueryLifecycleRecord => {
    ensureOpen();
    const now = normalizeTimestamp(registration.now ?? Date.now(), 'now');
    sweepTerminal(now, config.maxTrackedQueries);
    if (records.size >= config.maxTrackedQueries) {
      throw new RangeError('maxTrackedQueries capacity has been reached');
    }

    const serviceId = normalizeIdentifier(
      registration.serviceId,
      'serviceId',
      config.maxServiceIdLength,
    );
    const ownerId = normalizeIdentifier(
      registration.ownerId,
      'ownerId',
      config.maxOwnerIdLength,
    );
    const requestKey = normalizeIdentifier(
      registration.requestKey,
      'requestKey',
      config.maxRequestKeyLength,
    );
    if (!Number.isSafeInteger(registration.layerId) || registration.layerId < 0) {
      throw new RangeError('layerId must be a non-negative safe integer');
    }
    const expectedFeatures = normalizeNonNegativeSafeInteger(
      registration.expectedFeatures ?? 0,
      'expectedFeatures',
      100_000_000,
    );
    const expectedBytes = normalizeNonNegativeSafeInteger(
      registration.expectedBytes ?? 0,
      'expectedBytes',
      4 * 1024 * 1024 * 1024,
    );

    const record = freezeRecord({
      id: ++nextId,
      serviceId,
      layerId: registration.layerId,
      ownerId,
      requestKey,
      priority: normalizePriority(registration.priority),
      expectedFeatures,
      expectedBytes,
      phase: 'registered',
      createdAt: now,
      updatedAt: now,
      lifetimeDeadlineAt: safeDeadline(now, config.maxLifetimeMs, 'lifetime deadline'),
      executionDeadlineAt: null,
      terminalAt: null,
      version: 1,
    });

    records.set(record.id, record);
    indexActiveOwner(record);
    createdTotal += 1;
    generation += 1;
    recordEvent(record, null, 'registered', now);
    return record;
  };

  const admit = (queryId: number, now = Date.now()): SpatialQueryLifecycleRecord =>
    transition(queryId, 'admitted', now);

  const start = (queryId: number, now = Date.now()): SpatialQueryLifecycleRecord =>
    transition(queryId, 'executing', now);

  const complete = (queryId: number, now = Date.now()): SpatialQueryLifecycleRecord =>
    transition(queryId, 'completed', now);

  const fail = (queryId: number, now = Date.now()): SpatialQueryLifecycleRecord =>
    transition(queryId, 'failed', now);

  const cancel = (queryId: number, now = Date.now()): SpatialQueryLifecycleRecord =>
    transition(queryId, 'cancelled', now);

  const cancelOwner = (ownerIdInput: string, nowInput = Date.now()): number => {
    ensureOpen();
    const now = normalizeTimestamp(nowInput, 'now');
    const ownerId = normalizeIdentifier(ownerIdInput, 'ownerId', config.maxOwnerIdLength);
    const ids = ownerActiveIds.get(ownerId);
    if (!ids || ids.size === 0) return 0;
    const candidates = Array.from(ids);
    let cancelled = 0;
    for (const queryId of candidates) {
      const current = records.get(queryId);
      if (!current || isTerminal(current.phase)) continue;
      transition(queryId, 'cancelled', now);
      cancelled += 1;
    }
    return cancelled;
  };

  const expireDue = (
    nowInput = Date.now(),
    limitInput = config.maxTrackedQueries,
  ): readonly SpatialQueryLifecycleRecord[] => {
    ensureOpen();
    const now = normalizeTimestamp(nowInput, 'now');
    const limit = normalizePositiveSafeInteger(limitInput, 'limit', config.maxTrackedQueries);
    const expired: SpatialQueryLifecycleRecord[] = [];
    for (const record of records.values()) {
      if (expired.length >= limit) break;
      if (isTerminal(record.phase)) continue;
      const deadline = record.executionDeadlineAt ?? record.lifetimeDeadlineAt;
      if (now < deadline) continue;
      expired.push(transition(record.id, 'expired', now));
    }
    return Object.freeze(expired);
  };

  const events = (limitInput = config.maxEvents): readonly SpatialQueryLifecycleEvent[] => {
    const limit = normalizePositiveSafeInteger(limitInput, 'limit', config.maxEvents);
    const take = Math.min(limit, eventCount);
    const result: SpatialQueryLifecycleEvent[] = [];
    const startOffset = eventCount - take;
    const oldestIndex = (eventCursor - eventCount + config.maxEvents) % config.maxEvents;
    for (let offset = startOffset; offset < eventCount; offset += 1) {
      const index = (oldestIndex + offset) % config.maxEvents;
      const event = eventRing[index];
      if (event) result.push(event);
    }
    return Object.freeze(result);
  };

  const snapshot = (): SpatialQueryLifecycleSnapshot => {
    let registered = 0;
    let admittedCount = 0;
    let executing = 0;
    let completed = 0;
    let failedCount = 0;
    let cancelled = 0;
    let expired = 0;
    let expectedFeaturesActive = 0;
    let expectedBytesActive = 0;
    const services = new Set<string>();

    for (const record of records.values()) {
      services.add(record.serviceId);
      if (record.phase === 'registered') registered += 1;
      else if (record.phase === 'admitted') admittedCount += 1;
      else if (record.phase === 'executing') executing += 1;
      else if (record.phase === 'completed') completed += 1;
      else if (record.phase === 'failed') failedCount += 1;
      else if (record.phase === 'cancelled') cancelled += 1;
      else expired += 1;

      if (!isTerminal(record.phase)) {
        expectedFeaturesActive += record.expectedFeatures;
        expectedBytesActive += record.expectedBytes;
      }
    }

    const terminal = completed + failedCount + cancelled + expired;
    return Object.freeze({
      tracked: records.size,
      active: records.size - terminal,
      terminal,
      registered,
      admitted: admittedCount,
      executing,
      completed,
      failed: failedCount,
      cancelled,
      expired,
      owners: ownerActiveIds.size,
      services: services.size,
      expectedFeaturesActive,
      expectedBytesActive,
      createdTotal,
      transitionedTotal,
      removedTotal,
      generation,
    });
  };

  const clearTerminal = (): number => {
    ensureOpen();
    let removed = 0;
    for (const record of records.values()) {
      if (!isTerminal(record.phase)) continue;
      if (removeRecord(record)) removed += 1;
    }
    return removed;
  };

  const dispose = (): number => {
    if (disposed) return 0;
    const removed = records.size;
    records.clear();
    ownerActiveIds.clear();
    for (let index = 0; index < eventRing.length; index += 1) {
      eventRing[index] = undefined;
    }
    eventCount = 0;
    eventCursor = 0;
    removedTotal += removed;
    generation += 1;
    disposed = true;
    return removed;
  };

  return Object.freeze({
    register,
    admit,
    start,
    complete,
    fail,
    cancel,
    cancelOwner,
    expireDue,
    sweepTerminal,
    get,
    events,
    snapshot,
    clearTerminal,
    dispose,
  });
};
