import type { RuntimeFailureBudgetLane } from './runtimeFailureBudget';

export type RuntimeReservationPriority = 'urgent' | 'standard' | 'opportunistic';
export type RuntimeReservationDisposition = 'reserved' | 'queued' | 'rejected' | 'cancelled' | 'released' | 'expired';
export type RuntimeReservationReason = 'capacity' | 'queued' | 'duplicate' | 'queue-full' | 'lane-queue-full' | 'oversized' | 'cancelled' | 'released' | 'expired';

export interface RuntimeCapacityReservationPolicy {
  readonly capacity: number;
  readonly maximumReservationUnits: number;
  readonly maximumQueue: number;
  readonly maximumPerLaneQueue: number;
  readonly maximumHistory: number;
  readonly maximumLeaseDurationMs: number;
  readonly minimumCriticalReserve: number;
  readonly minimumInteractiveReserve: number;
}
export interface RuntimeCapacityReservationRequest { readonly id: string; readonly lane: RuntimeFailureBudgetLane; readonly priority: RuntimeReservationPriority; readonly units: number; readonly leaseDurationMs: number; readonly at: number; }
export interface RuntimeCapacityReservation { readonly id: string; readonly lane: RuntimeFailureBudgetLane; readonly priority: RuntimeReservationPriority; readonly units: number; readonly reservedAt: number; readonly expiresAt: number; }
export interface RuntimeCapacityReservationDecision { readonly id: string; readonly lane: RuntimeFailureBudgetLane; readonly disposition: RuntimeReservationDisposition; readonly reason: RuntimeReservationReason; readonly units: number; readonly at: number; }
export interface RuntimeCapacityReservationLaneSnapshot { readonly lane: RuntimeFailureBudgetLane; readonly activeReservations: number; readonly activeUnits: number; readonly queuedReservations: number; readonly queuedUnits: number; }
export interface RuntimeCapacityReservationSnapshot { readonly capacity: number; readonly activeReservations: number; readonly activeUnits: number; readonly availableUnits: number; readonly queuedReservations: number; readonly queuedUnits: number; readonly nextExpiryAt: number | null; readonly lanes: Readonly<Record<RuntimeFailureBudgetLane, RuntimeCapacityReservationLaneSnapshot>>; }

interface QueuedReservation extends RuntimeCapacityReservationRequest { readonly sequence: number; }
interface LaneAccounting { activeReservations: number; activeUnits: number; queuedReservations: number; queuedUnits: number; }

const LANES: readonly RuntimeFailureBudgetLane[] = Object.freeze(['critical', 'interactive', 'background']);
const PRIORITY_ORDER: Readonly<Record<RuntimeReservationPriority, number>> = Object.freeze({ urgent: 0, standard: 1, opportunistic: 2 });
const DEFAULT_POLICY: RuntimeCapacityReservationPolicy = Object.freeze({ capacity: 64, maximumReservationUnits: 32, maximumQueue: 128, maximumPerLaneQueue: 64, maximumHistory: 128, maximumLeaseDurationMs: 120_000, minimumCriticalReserve: 8, minimumInteractiveReserve: 8 });
const emptyAccounting = (): LaneAccounting => ({ activeReservations: 0, activeUnits: 0, queuedReservations: 0, queuedUnits: 0 });
const boundedInteger = (value: number, name: string, minimum: number, maximum: number): number => { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`); return value; };
const normalizePolicy = (input: Partial<RuntimeCapacityReservationPolicy>): RuntimeCapacityReservationPolicy => {
  const policy = Object.freeze({
    capacity: boundedInteger(input.capacity ?? DEFAULT_POLICY.capacity, 'capacity', 1, 100_000),
    maximumReservationUnits: boundedInteger(input.maximumReservationUnits ?? DEFAULT_POLICY.maximumReservationUnits, 'maximumReservationUnits', 1, 100_000),
    maximumQueue: boundedInteger(input.maximumQueue ?? DEFAULT_POLICY.maximumQueue, 'maximumQueue', 0, 100_000),
    maximumPerLaneQueue: boundedInteger(input.maximumPerLaneQueue ?? DEFAULT_POLICY.maximumPerLaneQueue, 'maximumPerLaneQueue', 0, 100_000),
    maximumHistory: boundedInteger(input.maximumHistory ?? DEFAULT_POLICY.maximumHistory, 'maximumHistory', 0, 10_000),
    maximumLeaseDurationMs: boundedInteger(input.maximumLeaseDurationMs ?? DEFAULT_POLICY.maximumLeaseDurationMs, 'maximumLeaseDurationMs', 1, 86_400_000),
    minimumCriticalReserve: boundedInteger(input.minimumCriticalReserve ?? DEFAULT_POLICY.minimumCriticalReserve, 'minimumCriticalReserve', 0, 100_000),
    minimumInteractiveReserve: boundedInteger(input.minimumInteractiveReserve ?? DEFAULT_POLICY.minimumInteractiveReserve, 'minimumInteractiveReserve', 0, 100_000),
  });
  if (policy.maximumReservationUnits > policy.capacity) throw new RangeError('maximumReservationUnits must not exceed capacity');
  if (policy.maximumPerLaneQueue > policy.maximumQueue) throw new RangeError('maximumPerLaneQueue must not exceed maximumQueue');
  if (policy.minimumCriticalReserve + policy.minimumInteractiveReserve > policy.capacity) throw new RangeError('lane reserves must not exceed capacity');
  return policy;
};
const assertId = (id: string): void => { if (typeof id !== 'string' || id.length === 0 || id.length > 256) throw new TypeError('reservation id must contain between 1 and 256 characters'); };
const assertAt = (at: number): void => { if (!Number.isSafeInteger(at) || at < 0) throw new RangeError('at must be a non-negative safe integer'); };
const assertLane = (lane: RuntimeFailureBudgetLane): void => { if (!LANES.includes(lane)) throw new TypeError(`unsupported reservation lane: ${String(lane)}`); };
const assertPriority = (priority: RuntimeReservationPriority): void => { if (!(priority in PRIORITY_ORDER)) throw new TypeError(`unsupported reservation priority: ${String(priority)}`); };

export class RuntimeCapacityReservationPool {
  readonly #policy: RuntimeCapacityReservationPolicy;
  readonly #active = new Map<string, RuntimeCapacityReservation>();
  readonly #queues: Record<RuntimeFailureBudgetLane, QueuedReservation[]> = { critical: [], interactive: [], background: [] };
  readonly #queuedIds = new Set<string>();
  readonly #history: RuntimeCapacityReservationDecision[] = [];
  readonly #accounting: Record<RuntimeFailureBudgetLane, LaneAccounting> = { critical: emptyAccounting(), interactive: emptyAccounting(), background: emptyAccounting() };
  #activeUnits = 0;
  #queuedUnits = 0;
  #sequence = 0;
  #lastAt: number | null = null;

  constructor(policy: Partial<RuntimeCapacityReservationPolicy> = {}) { this.#policy = normalizePolicy(policy); }
  policy(): RuntimeCapacityReservationPolicy { return this.#policy; }

  request(input: RuntimeCapacityReservationRequest): RuntimeCapacityReservationDecision {
    this.#validateRequest(input);
    this.#advance(input.at);
    this.#expire(input.at);
    if (this.#active.has(input.id) || this.#queuedIds.has(input.id)) return this.#decision(input, 'rejected', 'duplicate');
    if (input.units > this.#policy.maximumReservationUnits) return this.#decision(input, 'rejected', 'oversized');
    if (this.#queuedIds.size === 0 && this.#canReserve(input.lane, input.units)) {
      this.#reserve(input, input.at);
      return this.#decision(input, 'reserved', 'capacity');
    }
    if (this.#queuedIds.size >= this.#policy.maximumQueue) return this.#decision(input, 'rejected', 'queue-full');
    const queue = this.#queues[input.lane];
    if (queue.length >= this.#policy.maximumPerLaneQueue) return this.#decision(input, 'rejected', 'lane-queue-full');
    queue.push({ ...input, sequence: ++this.#sequence });
    queue.sort((left, right) => PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] || left.sequence - right.sequence);
    this.#queuedIds.add(input.id);
    this.#accountQueued(input.lane, input.units, 1);
    return this.#decision(input, 'queued', 'queued');
  }

  release(id: string, at: number): readonly RuntimeCapacityReservation[] {
    assertId(id); assertAt(at); this.#advance(at); this.#expire(at);
    const reservation = this.#active.get(id);
    if (!reservation) return Object.freeze([]);
    this.#removeActive(id, reservation);
    this.#record({ id, lane: reservation.lane, disposition: 'released', reason: 'released', units: reservation.units, at });
    return this.#promote(at);
  }

  cancel(id: string, at: number): boolean {
    assertId(id); assertAt(at); this.#advance(at); this.#expire(at);
    const located = this.#findQueued(id);
    if (!located) return false;
    const [removed] = this.#queues[located.lane].splice(located.index, 1);
    if (!removed) return false;
    this.#queuedIds.delete(id);
    this.#accountQueued(located.lane, -removed.units, -1);
    this.#record({ id, lane: located.lane, disposition: 'cancelled', reason: 'cancelled', units: removed.units, at });
    return true;
  }

  sweep(at: number): readonly RuntimeCapacityReservation[] { assertAt(at); this.#advance(at); return this.#expire(at) === 0 ? Object.freeze([]) : this.#promote(at); }
  active(): readonly RuntimeCapacityReservation[] { return Object.freeze([...this.#active.values()].map((entry) => Object.freeze({ ...entry }))); }
  history(): readonly RuntimeCapacityReservationDecision[] { return Object.freeze(this.#history.map((entry) => Object.freeze({ ...entry }))); }

  snapshot(at?: number): RuntimeCapacityReservationSnapshot {
    if (at !== undefined) { assertAt(at); this.#advance(at); this.#expire(at); }
    const lanes = Object.freeze({ critical: this.#laneSnapshot('critical'), interactive: this.#laneSnapshot('interactive'), background: this.#laneSnapshot('background') });
    let nextExpiryAt: number | null = null;
    for (const reservation of this.#active.values()) if (nextExpiryAt === null || reservation.expiresAt < nextExpiryAt) nextExpiryAt = reservation.expiresAt;
    return Object.freeze({ capacity: this.#policy.capacity, activeReservations: this.#active.size, activeUnits: this.#activeUnits, availableUnits: this.#policy.capacity - this.#activeUnits, queuedReservations: this.#queuedIds.size, queuedUnits: this.#queuedUnits, nextExpiryAt, lanes });
  }

  reset(lane?: RuntimeFailureBudgetLane): void {
    if (lane === undefined) {
      this.#active.clear(); this.#queuedIds.clear(); this.#history.length = 0;
      for (const laneName of LANES) { this.#queues[laneName].length = 0; this.#accounting[laneName] = emptyAccounting(); }
      this.#activeUnits = 0; this.#queuedUnits = 0; this.#sequence = 0; this.#lastAt = null;
      return;
    }
    assertLane(lane);
    const activeIds = [...this.#active.entries()].filter(([, reservation]) => reservation.lane === lane).map(([id]) => id);
    for (const id of activeIds) { const reservation = this.#active.get(id); if (reservation) this.#removeActive(id, reservation); }
    for (const request of this.#queues[lane]) this.#queuedIds.delete(request.id);
    this.#queuedUnits -= this.#accounting[lane].queuedUnits;
    this.#queues[lane].length = 0;
    this.#accounting[lane].queuedReservations = 0;
    this.#accounting[lane].queuedUnits = 0;
  }

  #validateRequest(input: RuntimeCapacityReservationRequest): void { assertId(input.id); assertLane(input.lane); assertPriority(input.priority); assertAt(input.at); boundedInteger(input.units, 'units', 1, 100_000); boundedInteger(input.leaseDurationMs, 'leaseDurationMs', 1, this.#policy.maximumLeaseDurationMs); }
  #advance(at: number): void { if (this.#lastAt !== null && at < this.#lastAt) throw new RangeError('reservation pool time must be monotonic'); this.#lastAt = at; }
  #protectedReserveFor(lane: RuntimeFailureBudgetLane): number {
    if (lane === 'critical') return 0;
    const criticalShortfall = Math.max(0, this.#policy.minimumCriticalReserve - this.#accounting.critical.activeUnits);
    if (lane === 'interactive') return criticalShortfall;
    const interactiveShortfall = Math.max(0, this.#policy.minimumInteractiveReserve - this.#accounting.interactive.activeUnits);
    return criticalShortfall + interactiveShortfall;
  }
  #canReserve(lane: RuntimeFailureBudgetLane, units: number): boolean { const available = this.#policy.capacity - this.#activeUnits; return units <= Math.max(0, available - this.#protectedReserveFor(lane)); }
  #reserve(input: RuntimeCapacityReservationRequest, at: number): RuntimeCapacityReservation {
    const expiresAt = at + input.leaseDurationMs;
    if (!Number.isSafeInteger(expiresAt)) throw new RangeError('reservation expiry exceeds safe integer range');
    const reservation = Object.freeze({ id: input.id, lane: input.lane, priority: input.priority, units: input.units, reservedAt: at, expiresAt });
    this.#active.set(input.id, reservation);
    if (this.#queuedIds.delete(input.id)) this.#accountQueued(input.lane, -input.units, -1);
    this.#activeUnits += input.units;
    this.#accounting[input.lane].activeUnits += input.units;
    this.#accounting[input.lane].activeReservations += 1;
    return reservation;
  }
  #removeActive(id: string, reservation: RuntimeCapacityReservation): void {
    this.#active.delete(id);
    this.#activeUnits -= reservation.units;
    this.#accounting[reservation.lane].activeUnits -= reservation.units;
    this.#accounting[reservation.lane].activeReservations -= 1;
  }
  #accountQueued(lane: RuntimeFailureBudgetLane, unitDelta: number, countDelta: number): void {
    this.#queuedUnits += unitDelta;
    this.#accounting[lane].queuedUnits += unitDelta;
    this.#accounting[lane].queuedReservations += countDelta;
  }
  #expire(at: number): number {
    let expired = 0;
    for (const [id, reservation] of this.#active) {
      if (reservation.expiresAt > at) continue;
      this.#removeActive(id, reservation);
      expired += 1;
      this.#record({ id, lane: reservation.lane, disposition: 'expired', reason: 'expired', units: reservation.units, at });
    }
    return expired;
  }
  #promote(at: number): readonly RuntimeCapacityReservation[] {
    const promoted: RuntimeCapacityReservation[] = [];
    const maximumVisits = this.#queuedIds.size * LANES.length;
    let visits = 0; let laneIndex = 0; let misses = 0;
    while (this.#queuedIds.size > 0 && visits < maximumVisits && misses < LANES.length) {
      const lane = LANES[laneIndex]; laneIndex = (laneIndex + 1) % LANES.length; visits += 1;
      if (!lane) break;
      const next = this.#queues[lane][0];
      if (!next || !this.#canReserve(lane, next.units)) { misses += 1; continue; }
      this.#queues[lane].shift();
      const reservation = this.#reserve(next, at);
      promoted.push(reservation);
      this.#record({ id: next.id, lane, disposition: 'reserved', reason: 'capacity', units: next.units, at });
      misses = 0;
    }
    return Object.freeze(promoted);
  }
  #findQueued(id: string): { lane: RuntimeFailureBudgetLane; index: number } | null {
    const criticalIndex = this.#queues.critical.findIndex((entry) => entry.id === id);
    if (criticalIndex >= 0) return { lane: 'critical', index: criticalIndex };
    const interactiveIndex = this.#queues.interactive.findIndex((entry) => entry.id === id);
    if (interactiveIndex >= 0) return { lane: 'interactive', index: interactiveIndex };
    const backgroundIndex = this.#queues.background.findIndex((entry) => entry.id === id);
    return backgroundIndex >= 0 ? { lane: 'background', index: backgroundIndex } : null;
  }
  #laneSnapshot(lane: RuntimeFailureBudgetLane): RuntimeCapacityReservationLaneSnapshot {
    const value = this.#accounting[lane];
    return Object.freeze({ lane, activeReservations: value.activeReservations, activeUnits: value.activeUnits, queuedReservations: value.queuedReservations, queuedUnits: value.queuedUnits });
  }
  #decision(input: RuntimeCapacityReservationRequest, disposition: RuntimeReservationDisposition, reason: RuntimeReservationReason): RuntimeCapacityReservationDecision { return this.#record({ id: input.id, lane: input.lane, disposition, reason, units: input.units, at: input.at }); }
  #record(decision: RuntimeCapacityReservationDecision): RuntimeCapacityReservationDecision { const frozen = Object.freeze({ ...decision }); if (this.#policy.maximumHistory > 0) { this.#history.push(frozen); if (this.#history.length > this.#policy.maximumHistory) this.#history.splice(0, this.#history.length - this.#policy.maximumHistory); } return frozen; }
}
