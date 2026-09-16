import {
  RESOURCE_KINDS,
  clampNumber,
  createMonotonicIdFactory,
  nonNegativeInteger,
  positiveInteger,
  type ResourceBudgetSnapshot,
  type ResourceKind,
  type ResourceReservation,
  type ReservationRequest,
  type RuntimeBudget,
  type RuntimeBudgetOverrides,
  type RuntimeCapabilities,
  type RuntimeTier,
} from './contracts';

const DEFAULT_BUDGETS: Readonly<Record<RuntimeTier, RuntimeBudget>> = Object.freeze({
  minimal: Object.freeze({
    tier: 'minimal',
    maxConcurrentNetwork: 3,
    maxConcurrentCpu: 1,
    maxQueuedTasks: 80,
    maxCacheEntries: 80,
    maxCacheBytes: 8 * 1024 * 1024,
    maxVisibleFeatures2d: 2500,
    maxVisibleFeatures3d: 800,
    maxGpuHeavyLayers: 1,
    frameBudgetMs: 10,
    backgroundSliceMs: 4,
    telemetryCapacity: 300,
  }),
  balanced: Object.freeze({
    tier: 'balanced',
    maxConcurrentNetwork: 6,
    maxConcurrentCpu: 2,
    maxQueuedTasks: 180,
    maxCacheEntries: 180,
    maxCacheBytes: 24 * 1024 * 1024,
    maxVisibleFeatures2d: 8000,
    maxVisibleFeatures3d: 2500,
    maxGpuHeavyLayers: 2,
    frameBudgetMs: 12,
    backgroundSliceMs: 6,
    telemetryCapacity: 600,
  }),
  enhanced: Object.freeze({
    tier: 'enhanced',
    maxConcurrentNetwork: 10,
    maxConcurrentCpu: 4,
    maxQueuedTasks: 320,
    maxCacheEntries: 320,
    maxCacheBytes: 64 * 1024 * 1024,
    maxVisibleFeatures2d: 20000,
    maxVisibleFeatures3d: 7000,
    maxGpuHeavyLayers: 4,
    frameBudgetMs: 14,
    backgroundSliceMs: 8,
    telemetryCapacity: 1000,
  }),
});

const LIMIT_BY_KIND: Readonly<Record<ResourceKind, keyof RuntimeBudget>> = Object.freeze({
  network: 'maxConcurrentNetwork',
  cpu: 'maxConcurrentCpu',
  memory: 'maxCacheBytes',
  render: 'maxGpuHeavyLayers',
  storage: 'maxCacheEntries',
});

const MAX_OVERRIDE_VALUES: Readonly<Record<keyof RuntimeBudgetOverrides, number>> = Object.freeze({
  maxConcurrentNetwork: 32,
  maxConcurrentCpu: 16,
  maxQueuedTasks: 2000,
  maxCacheEntries: 5000,
  maxCacheBytes: 512 * 1024 * 1024,
  maxVisibleFeatures2d: 250000,
  maxVisibleFeatures3d: 100000,
  maxGpuHeavyLayers: 12,
  frameBudgetMs: 32,
  backgroundSliceMs: 16,
  telemetryCapacity: 10000,
});

const normalizedOverride = (
  key: keyof RuntimeBudgetOverrides,
  value: unknown,
  fallback: number,
): number => {
  const maximum = MAX_OVERRIDE_VALUES[key];
  if (key === 'frameBudgetMs' || key === 'backgroundSliceMs') {
    return clampNumber(value, 1, maximum, fallback);
  }
  return positiveInteger(value, fallback, maximum);
};

export const createRuntimeBudget = (
  capabilities: Pick<RuntimeCapabilities, 'tier' | 'saveData' | 'reducedMotion' | 'deviceMemoryGb'>,
  overrides: RuntimeBudgetOverrides = {},
): RuntimeBudget => {
  const base = DEFAULT_BUDGETS[capabilities.tier];
  const constrained = { ...base };

  if (capabilities.saveData) {
    constrained.maxConcurrentNetwork = Math.min(constrained.maxConcurrentNetwork, 3);
    constrained.maxCacheBytes = Math.min(constrained.maxCacheBytes, 12 * 1024 * 1024);
    constrained.maxVisibleFeatures2d = Math.min(constrained.maxVisibleFeatures2d, 5000);
    constrained.maxVisibleFeatures3d = Math.min(constrained.maxVisibleFeatures3d, 1500);
  }

  if (capabilities.reducedMotion) {
    constrained.maxGpuHeavyLayers = Math.min(constrained.maxGpuHeavyLayers, 2);
  }

  if (capabilities.deviceMemoryGb !== null && capabilities.deviceMemoryGb <= 2) {
    constrained.maxCacheBytes = Math.min(constrained.maxCacheBytes, 8 * 1024 * 1024);
    constrained.maxVisibleFeatures2d = Math.min(constrained.maxVisibleFeatures2d, 3000);
    constrained.maxVisibleFeatures3d = Math.min(constrained.maxVisibleFeatures3d, 1000);
  }

  for (const key of Object.keys(overrides) as Array<keyof RuntimeBudgetOverrides>) {
    const value = overrides[key];
    if (value === undefined) continue;
    constrained[key] = normalizedOverride(key, value, constrained[key]);
  }

  return Object.freeze(constrained);
};

interface InternalReservation {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly units: number;
  readonly owner: string | null;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
  released: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ResourceBudgetManagerOptions {
  readonly budget: RuntimeBudget;
  readonly now?: () => number;
  readonly wallTime?: () => number;
  readonly onRejected?: (request: ReservationRequest, snapshot: ResourceBudgetSnapshot) => void;
  readonly onExpired?: (reservation: Readonly<InternalReservation>) => void;
}

export interface ResourceBudgetManager {
  readonly reserve: (request: ReservationRequest) => ResourceReservation | null;
  readonly canReserve: (request: ReservationRequest) => boolean;
  readonly release: (id: string) => boolean;
  readonly releaseOwner: (owner: string) => number;
  readonly sweepExpired: () => number;
  readonly snapshot: () => ResourceBudgetSnapshot;
  readonly updateBudget: (budget: RuntimeBudget) => void;
  readonly dispose: () => void;
}

const emptyUsage = (): Record<ResourceKind, number> => ({
  network: 0,
  cpu: 0,
  memory: 0,
  render: 0,
  storage: 0,
});

const limitFor = (budget: RuntimeBudget, kind: ResourceKind): number => {
  const key = LIMIT_BY_KIND[kind];
  return Number(budget[key]);
};

const normalizeOwner = (owner: unknown): string | null => {
  if (typeof owner !== 'string') return null;
  const normalized = owner.trim();
  return normalized ? normalized.slice(0, 120) : null;
};

const normalizeUnits = (request: ReservationRequest): number => {
  if (request.kind === 'memory') {
    return positiveInteger(request.units, 1, 512 * 1024 * 1024);
  }
  return positiveInteger(request.units, 1, 100000);
};

export const createResourceBudgetManager = (options: ResourceBudgetManagerOptions): ResourceBudgetManager => {
  let budget = options.budget;
  const wallTime = options.wallTime ?? Date.now;
  const makeId = createMonotonicIdFactory('budget', wallTime);
  const reservations = new Map<string, InternalReservation>();
  const usage = emptyUsage();
  let rejectedReservations = 0;
  let expiredReservations = 0;
  let disposed = false;

  const removeReservation = (reservation: InternalReservation, expired: boolean): boolean => {
    if (reservation.released) return false;
    reservation.released = true;
    if (reservation.timer) {
      clearTimeout(reservation.timer);
      reservation.timer = null;
    }
    reservations.delete(reservation.id);
    usage[reservation.kind] = Math.max(0, usage[reservation.kind] - reservation.units);
    if (expired) {
      expiredReservations += 1;
      options.onExpired?.(reservation);
    }
    return true;
  };

  const sweepExpired = (): number => {
    if (disposed) return 0;
    const now = wallTime();
    let removed = 0;
    for (const reservation of Array.from(reservations.values())) {
      if (reservation.expiresAt !== null && reservation.expiresAt <= now) {
        if (removeReservation(reservation, true)) removed += 1;
      }
    }
    return removed;
  };

  const snapshot = (): ResourceBudgetSnapshot => {
    sweepExpired();
    const available = emptyUsage();
    for (const kind of RESOURCE_KINDS) {
      available[kind] = Math.max(0, limitFor(budget, kind) - usage[kind]);
    }
    return Object.freeze({
      budget,
      used: Object.freeze({ ...usage }),
      available: Object.freeze(available),
      reservationCount: reservations.size,
      rejectedReservations,
      expiredReservations,
    });
  };

  const canReserve = (request: ReservationRequest): boolean => {
    if (disposed) return false;
    sweepExpired();
    const units = normalizeUnits(request);
    return usage[request.kind] + units <= limitFor(budget, request.kind);
  };

  const reserve = (request: ReservationRequest): ResourceReservation | null => {
    if (disposed) return null;
    sweepExpired();
    const units = normalizeUnits(request);
    if (usage[request.kind] + units > limitFor(budget, request.kind)) {
      rejectedReservations += 1;
      options.onRejected?.(request, snapshot());
      return null;
    }

    const createdAt = wallTime();
    const ttlMs = nonNegativeInteger(request.ttlMs, 0, 60 * 60 * 1000);
    const reservation: InternalReservation = {
      id: makeId(),
      kind: request.kind,
      units,
      owner: normalizeOwner(request.owner),
      createdAt,
      expiresAt: ttlMs > 0 ? createdAt + ttlMs : null,
      metadata: request.metadata ? Object.freeze({ ...request.metadata }) : null,
      released: false,
      timer: null,
    };

    usage[reservation.kind] += reservation.units;
    reservations.set(reservation.id, reservation);

    if (ttlMs > 0) {
      reservation.timer = setTimeout(() => {
        const current = reservations.get(reservation.id);
        if (current) removeReservation(current, true);
      }, ttlMs);
    }

    const publicReservation: ResourceReservation = {
      id: reservation.id,
      kind: reservation.kind,
      units: reservation.units,
      owner: reservation.owner,
      createdAt: reservation.createdAt,
      expiresAt: reservation.expiresAt,
      get released() { return reservation.released; },
      release: () => removeReservation(reservation, false),
      dispose: () => { removeReservation(reservation, false); },
    };
    return Object.freeze(publicReservation);
  };

  const release = (id: string): boolean => {
    const reservation = reservations.get(id);
    return reservation ? removeReservation(reservation, false) : false;
  };

  const releaseOwner = (owner: string): number => {
    const normalized = normalizeOwner(owner);
    if (!normalized) return 0;
    let removed = 0;
    for (const reservation of Array.from(reservations.values())) {
      if (reservation.owner === normalized && removeReservation(reservation, false)) removed += 1;
    }
    return removed;
  };

  const updateBudget = (nextBudget: RuntimeBudget): void => {
    budget = nextBudget;
    sweepExpired();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const reservation of Array.from(reservations.values())) {
      removeReservation(reservation, false);
    }
  };

  return Object.freeze({
    reserve,
    canReserve,
    release,
    releaseOwner,
    sweepExpired,
    snapshot,
    updateBudget,
    dispose,
  });
};

export const budgetPressure = (snapshot: ResourceBudgetSnapshot, kind: ResourceKind): number => {
  const limit = limitFor(snapshot.budget, kind);
  if (limit <= 0) return 1;
  return clampNumber(snapshot.used[kind] / limit, 0, 1, 0);
};

export const isBudgetConstrained = (
  snapshot: ResourceBudgetSnapshot,
  threshold = 0.85,
): boolean => RESOURCE_KINDS.some((kind) => budgetPressure(snapshot, kind) >= threshold);
