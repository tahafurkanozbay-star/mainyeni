export type SpatialQueryAdmissionPriority = 'background' | 'normal' | 'interactive';
export type SpatialQueryAdmissionDecision = 'admit' | 'defer' | 'reject';

export interface SpatialQueryAdmissionRequest {
  readonly serviceId: string;
  readonly layerId: number;
  readonly priority?: SpatialQueryAdmissionPriority;
  readonly estimatedFeatures?: number;
  readonly estimatedBytes?: number;
  readonly estimatedCpuMs?: number;
  readonly estimatedGpuBytes?: number;
  readonly cacheHit?: boolean;
}

export interface SpatialQueryAdmissionPolicy {
  readonly maxConcurrent: number;
  readonly maxConcurrentPerService: number;
  readonly maxQueued: number;
  readonly maxQueuedPerService: number;
  readonly maxEstimatedFeaturesInFlight: number;
  readonly maxEstimatedBytesInFlight: number;
  readonly maxEstimatedCpuMsInFlight: number;
  readonly maxEstimatedGpuBytesInFlight: number;
  readonly maxSingleEstimatedFeatures: number;
  readonly maxSingleEstimatedBytes: number;
  readonly maxSingleEstimatedCpuMs: number;
  readonly maxSingleEstimatedGpuBytes: number;
  readonly interactiveReserve: number;
}

export interface SpatialQueryAdmissionTicket {
  readonly id: number;
  readonly serviceId: string;
  readonly layerId: number;
  readonly priority: SpatialQueryAdmissionPriority;
  readonly estimatedFeatures: number;
  readonly estimatedBytes: number;
  readonly estimatedCpuMs: number;
  readonly estimatedGpuBytes: number;
  readonly admittedAt: number;
}

export interface SpatialQueryAdmissionResult {
  readonly decision: SpatialQueryAdmissionDecision;
  readonly reason:
    | 'admitted'
    | 'cache-hit'
    | 'single-request-budget'
    | 'global-concurrency'
    | 'service-concurrency'
    | 'feature-budget'
    | 'byte-budget'
    | 'cpu-budget'
    | 'gpu-budget'
    | 'queue-budget'
    | 'service-queue-budget';
  readonly ticket?: SpatialQueryAdmissionTicket;
  readonly retryable: boolean;
}

export interface SpatialQueryAdmissionSnapshot {
  readonly active: number;
  readonly queued: number;
  readonly activeServices: number;
  readonly admitted: number;
  readonly deferred: number;
  readonly rejected: number;
  readonly released: number;
  readonly cacheHits: number;
  readonly estimatedFeaturesInFlight: number;
  readonly estimatedBytesInFlight: number;
  readonly estimatedCpuMsInFlight: number;
  readonly estimatedGpuBytesInFlight: number;
  readonly generation: number;
}

interface NormalizedRequest {
  readonly serviceId: string;
  readonly layerId: number;
  readonly priority: SpatialQueryAdmissionPriority;
  readonly estimatedFeatures: number;
  readonly estimatedBytes: number;
  readonly estimatedCpuMs: number;
  readonly estimatedGpuBytes: number;
  readonly cacheHit: boolean;
}

interface QueuedRequest extends NormalizedRequest {
  readonly sequence: number;
  readonly queuedAt: number;
}

const DEFAULT_POLICY: SpatialQueryAdmissionPolicy = {
  maxConcurrent: 8,
  maxConcurrentPerService: 4,
  maxQueued: 128,
  maxQueuedPerService: 32,
  maxEstimatedFeaturesInFlight: 50_000,
  maxEstimatedBytesInFlight: 64 * 1024 * 1024,
  maxEstimatedCpuMsInFlight: 4_000,
  maxEstimatedGpuBytesInFlight: 128 * 1024 * 1024,
  maxSingleEstimatedFeatures: 20_000,
  maxSingleEstimatedBytes: 32 * 1024 * 1024,
  maxSingleEstimatedCpuMs: 2_000,
  maxSingleEstimatedGpuBytes: 64 * 1024 * 1024,
  interactiveReserve: 2,
};

const positiveSafeInteger = (value: number, name: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
};

const nonNegativeFinite = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and non-negative`);
  return value;
};

const normalizeText = (value: string): string => value.trim();
const priorityRank = (priority: SpatialQueryAdmissionPriority): number => priority === 'interactive' ? 3 : priority === 'normal' ? 2 : 1;

export const normalizeSpatialQueryAdmissionPolicy = (
  policy: Partial<SpatialQueryAdmissionPolicy> = {},
): SpatialQueryAdmissionPolicy => {
  const normalized = { ...DEFAULT_POLICY, ...policy };
  positiveSafeInteger(normalized.maxConcurrent, 'maxConcurrent', 256);
  positiveSafeInteger(normalized.maxConcurrentPerService, 'maxConcurrentPerService', 256);
  positiveSafeInteger(normalized.maxQueued, 'maxQueued', 100_000);
  positiveSafeInteger(normalized.maxQueuedPerService, 'maxQueuedPerService', 100_000);
  positiveSafeInteger(normalized.maxEstimatedFeaturesInFlight, 'maxEstimatedFeaturesInFlight', 100_000_000);
  positiveSafeInteger(normalized.maxEstimatedBytesInFlight, 'maxEstimatedBytesInFlight', 4 * 1024 * 1024 * 1024);
  positiveSafeInteger(normalized.maxEstimatedCpuMsInFlight, 'maxEstimatedCpuMsInFlight', 60 * 60_000);
  positiveSafeInteger(normalized.maxEstimatedGpuBytesInFlight, 'maxEstimatedGpuBytesInFlight', 4 * 1024 * 1024 * 1024);
  positiveSafeInteger(normalized.maxSingleEstimatedFeatures, 'maxSingleEstimatedFeatures', normalized.maxEstimatedFeaturesInFlight);
  positiveSafeInteger(normalized.maxSingleEstimatedBytes, 'maxSingleEstimatedBytes', normalized.maxEstimatedBytesInFlight);
  positiveSafeInteger(normalized.maxSingleEstimatedCpuMs, 'maxSingleEstimatedCpuMs', normalized.maxEstimatedCpuMsInFlight);
  positiveSafeInteger(normalized.maxSingleEstimatedGpuBytes, 'maxSingleEstimatedGpuBytes', normalized.maxEstimatedGpuBytesInFlight);
  if (!Number.isSafeInteger(normalized.interactiveReserve) || normalized.interactiveReserve < 0 || normalized.interactiveReserve >= normalized.maxConcurrent) {
    throw new RangeError('interactiveReserve must be a non-negative safe integer below maxConcurrent');
  }
  if (normalized.maxConcurrentPerService > normalized.maxConcurrent) {
    throw new RangeError('maxConcurrentPerService cannot exceed maxConcurrent');
  }
  if (normalized.maxQueuedPerService > normalized.maxQueued) {
    throw new RangeError('maxQueuedPerService cannot exceed maxQueued');
  }
  return Object.freeze(normalized);
};

const normalizeRequest = (request: SpatialQueryAdmissionRequest): NormalizedRequest => {
  const serviceId = normalizeText(request.serviceId);
  if (!serviceId) throw new TypeError('serviceId is required');
  if (!Number.isSafeInteger(request.layerId) || request.layerId < 0) throw new RangeError('layerId must be a non-negative safe integer');
  const priority = request.priority ?? 'normal';
  if (priority !== 'background' && priority !== 'normal' && priority !== 'interactive') throw new TypeError('priority is invalid');
  return Object.freeze({
    serviceId,
    layerId: request.layerId,
    priority,
    estimatedFeatures: nonNegativeFinite(request.estimatedFeatures ?? 0, 'estimatedFeatures'),
    estimatedBytes: nonNegativeFinite(request.estimatedBytes ?? 0, 'estimatedBytes'),
    estimatedCpuMs: nonNegativeFinite(request.estimatedCpuMs ?? 0, 'estimatedCpuMs'),
    estimatedGpuBytes: nonNegativeFinite(request.estimatedGpuBytes ?? 0, 'estimatedGpuBytes'),
    cacheHit: request.cacheHit === true,
  });
};

export const createSpatialQueryAdmissionController = (
  policyInput: Partial<SpatialQueryAdmissionPolicy> = {},
): Readonly<{
  request(request: SpatialQueryAdmissionRequest, now?: number): SpatialQueryAdmissionResult;
  enqueue(request: SpatialQueryAdmissionRequest, now?: number): SpatialQueryAdmissionResult;
  drain(now?: number): readonly SpatialQueryAdmissionTicket[];
  release(ticketId: number): boolean;
  cancelQueued(serviceId: string, layerId?: number): number;
  clearQueue(): number;
  snapshot(): SpatialQueryAdmissionSnapshot;
}> => {
  const policy = normalizeSpatialQueryAdmissionPolicy(policyInput);
  const active = new Map<number, SpatialQueryAdmissionTicket>();
  const queued: QueuedRequest[] = [];
  let nextTicketId = 0;
  let sequence = 0;
  let admitted = 0;
  let deferred = 0;
  let rejected = 0;
  let released = 0;
  let cacheHits = 0;
  let generation = 0;

  const activeForService = (serviceId: string): number => {
    let count = 0;
    for (const ticket of active.values()) if (ticket.serviceId === serviceId) count += 1;
    return count;
  };

  const queuedForService = (serviceId: string): number => {
    let count = 0;
    for (const item of queued) if (item.serviceId === serviceId) count += 1;
    return count;
  };

  const totals = (): readonly [number, number, number, number] => {
    let features = 0;
    let bytes = 0;
    let cpuMs = 0;
    let gpuBytes = 0;
    for (const ticket of active.values()) {
      features += ticket.estimatedFeatures;
      bytes += ticket.estimatedBytes;
      cpuMs += ticket.estimatedCpuMs;
      gpuBytes += ticket.estimatedGpuBytes;
    }
    return [features, bytes, cpuMs, gpuBytes];
  };

  const rejectSingleBudget = (request: NormalizedRequest): SpatialQueryAdmissionResult | undefined => {
    if (request.estimatedFeatures > policy.maxSingleEstimatedFeatures ||
      request.estimatedBytes > policy.maxSingleEstimatedBytes ||
      request.estimatedCpuMs > policy.maxSingleEstimatedCpuMs ||
      request.estimatedGpuBytes > policy.maxSingleEstimatedGpuBytes) {
      rejected += 1;
      return Object.freeze({ decision: 'reject', reason: 'single-request-budget', retryable: false });
    }
    return undefined;
  };

  const evaluateCapacity = (request: NormalizedRequest): SpatialQueryAdmissionResult['reason'] | undefined => {
    const nonInteractiveLimit = policy.maxConcurrent - policy.interactiveReserve;
    if (active.size >= policy.maxConcurrent || (request.priority !== 'interactive' && active.size >= nonInteractiveLimit)) return 'global-concurrency';
    if (activeForService(request.serviceId) >= policy.maxConcurrentPerService) return 'service-concurrency';
    const [features, bytes, cpuMs, gpuBytes] = totals();
    if (features + request.estimatedFeatures > policy.maxEstimatedFeaturesInFlight) return 'feature-budget';
    if (bytes + request.estimatedBytes > policy.maxEstimatedBytesInFlight) return 'byte-budget';
    if (cpuMs + request.estimatedCpuMs > policy.maxEstimatedCpuMsInFlight) return 'cpu-budget';
    if (gpuBytes + request.estimatedGpuBytes > policy.maxEstimatedGpuBytesInFlight) return 'gpu-budget';
    return undefined;
  };

  const admit = (request: NormalizedRequest, now: number): SpatialQueryAdmissionResult => {
    const ticket: SpatialQueryAdmissionTicket = Object.freeze({
      id: ++nextTicketId,
      serviceId: request.serviceId,
      layerId: request.layerId,
      priority: request.priority,
      estimatedFeatures: request.estimatedFeatures,
      estimatedBytes: request.estimatedBytes,
      estimatedCpuMs: request.estimatedCpuMs,
      estimatedGpuBytes: request.estimatedGpuBytes,
      admittedAt: now,
    });
    active.set(ticket.id, ticket);
    admitted += 1;
    generation += 1;
    return Object.freeze({ decision: 'admit', reason: 'admitted', ticket, retryable: false });
  };

  const request = (requestInput: SpatialQueryAdmissionRequest, now = Date.now()): SpatialQueryAdmissionResult => {
    nonNegativeFinite(now, 'now');
    const normalized = normalizeRequest(requestInput);
    if (normalized.cacheHit) {
      cacheHits += 1;
      return Object.freeze({ decision: 'admit', reason: 'cache-hit', retryable: false });
    }
    const budgetFailure = rejectSingleBudget(normalized);
    if (budgetFailure) return budgetFailure;
    const capacityFailure = evaluateCapacity(normalized);
    if (capacityFailure) {
      deferred += 1;
      return Object.freeze({ decision: 'defer', reason: capacityFailure, retryable: true });
    }
    return admit(normalized, now);
  };

  const enqueue = (requestInput: SpatialQueryAdmissionRequest, now = Date.now()): SpatialQueryAdmissionResult => {
    nonNegativeFinite(now, 'now');
    const normalized = normalizeRequest(requestInput);
    if (normalized.cacheHit) return request(normalized, now);
    const budgetFailure = rejectSingleBudget(normalized);
    if (budgetFailure) return budgetFailure;
    if (queued.length >= policy.maxQueued) {
      rejected += 1;
      return Object.freeze({ decision: 'reject', reason: 'queue-budget', retryable: true });
    }
    if (queuedForService(normalized.serviceId) >= policy.maxQueuedPerService) {
      rejected += 1;
      return Object.freeze({ decision: 'reject', reason: 'service-queue-budget', retryable: true });
    }
    queued.push(Object.freeze({ ...normalized, sequence: ++sequence, queuedAt: now }));
    queued.sort((left, right) => priorityRank(right.priority) - priorityRank(left.priority) || left.sequence - right.sequence);
    deferred += 1;
    generation += 1;
    return Object.freeze({ decision: 'defer', reason: evaluateCapacity(normalized) ?? 'global-concurrency', retryable: true });
  };

  const drain = (now = Date.now()): readonly SpatialQueryAdmissionTicket[] => {
    nonNegativeFinite(now, 'now');
    const admittedTickets: SpatialQueryAdmissionTicket[] = [];
    let index = 0;
    while (index < queued.length) {
      const candidate = queued[index];
      const failure = evaluateCapacity(candidate);
      if (failure) {
        index += 1;
        continue;
      }
      queued.splice(index, 1);
      const result = admit(candidate, now);
      if (result.ticket) admittedTickets.push(result.ticket);
    }
    return Object.freeze(admittedTickets);
  };

  const release = (ticketId: number): boolean => {
    if (!Number.isSafeInteger(ticketId) || ticketId <= 0) return false;
    const removed = active.delete(ticketId);
    if (removed) {
      released += 1;
      generation += 1;
    }
    return removed;
  };

  const cancelQueued = (serviceIdInput: string, layerId?: number): number => {
    const serviceId = normalizeText(serviceIdInput);
    if (!serviceId) return 0;
    if (layerId !== undefined && (!Number.isSafeInteger(layerId) || layerId < 0)) throw new RangeError('layerId must be a non-negative safe integer');
    let removed = 0;
    for (let index = queued.length - 1; index >= 0; index -= 1) {
      const candidate = queued[index];
      if (candidate.serviceId === serviceId && (layerId === undefined || candidate.layerId === layerId)) {
        queued.splice(index, 1);
        removed += 1;
      }
    }
    if (removed > 0) generation += 1;
    return removed;
  };

  const clearQueue = (): number => {
    const removed = queued.length;
    if (removed === 0) return 0;
    queued.length = 0;
    generation += 1;
    return removed;
  };

  const snapshot = (): SpatialQueryAdmissionSnapshot => {
    const [features, bytes, cpuMs, gpuBytes] = totals();
    const services = new Set<string>();
    for (const ticket of active.values()) services.add(ticket.serviceId);
    return Object.freeze({
      active: active.size,
      queued: queued.length,
      activeServices: services.size,
      admitted,
      deferred,
      rejected,
      released,
      cacheHits,
      estimatedFeaturesInFlight: features,
      estimatedBytesInFlight: bytes,
      estimatedCpuMsInFlight: cpuMs,
      estimatedGpuBytesInFlight: gpuBytes,
      generation,
    });
  };

  return Object.freeze({ request, enqueue, drain, release, cancelQueued, clearQueue, snapshot });
};
