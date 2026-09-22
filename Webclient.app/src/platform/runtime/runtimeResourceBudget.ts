export type ResourceLane = 'critical' | 'interactive' | 'background';
export type ResourceRejection = 'duplicate' | 'item-too-large' | 'lane-capacity' | 'global-capacity';

export interface RuntimeResourceBudgetConfig {
  readonly maxBytes: number;
  readonly maxItems: number;
  readonly criticalReservedBytes: number;
  readonly interactiveReservedBytes: number;
  readonly maxItemBytes: number;
  readonly historySize: number;
}

export interface ResourceLease {
  readonly key: string;
  readonly lane: ResourceLane;
  readonly bytes: number;
  release(): void;
}

export interface ResourceAdmission {
  readonly admitted: boolean;
  readonly reason: 'admitted' | ResourceRejection;
  readonly lease: ResourceLease | null;
}

export interface ResourceBudgetEvent {
  readonly sequence: number;
  readonly type: 'admit' | 'reject' | 'release';
  readonly key: string;
  readonly lane: ResourceLane;
  readonly bytes: number;
  readonly reason?: ResourceRejection;
}

export interface ResourceLaneUsage {
  readonly items: number;
  readonly bytes: number;
}

export interface RuntimeResourceBudgetSnapshot {
  readonly items: number;
  readonly bytes: number;
  readonly remainingBytes: number;
  readonly lanes: Readonly<Record<ResourceLane, ResourceLaneUsage>>;
  readonly admitted: number;
  readonly rejected: number;
  readonly released: number;
  readonly history: readonly ResourceBudgetEvent[];
}

const LANES: readonly ResourceLane[] = ['critical', 'interactive', 'background'];
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_CONFIG: RuntimeResourceBudgetConfig = {
  maxBytes: DEFAULT_MAX_BYTES,
  maxItems: 256,
  criticalReservedBytes: 8 * 1024 * 1024,
  interactiveReservedBytes: 8 * 1024 * 1024,
  maxItemBytes: 16 * 1024 * 1024,
  historySize: 64,
};

function safePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}

function validateConfig(input: Partial<RuntimeResourceBudgetConfig>): RuntimeResourceBudgetConfig {
  const maxBytes = input.maxBytes ?? DEFAULT_CONFIG.maxBytes;
  const derivedReserve = Math.floor(maxBytes / 8);
  const config: RuntimeResourceBudgetConfig = {
    ...DEFAULT_CONFIG,
    ...input,
    criticalReservedBytes: input.criticalReservedBytes ?? derivedReserve,
    interactiveReservedBytes: input.interactiveReservedBytes ?? derivedReserve,
  };
  safePositiveInteger(config.maxBytes, 'maxBytes');
  safePositiveInteger(config.maxItems, 'maxItems');
  safePositiveInteger(config.maxItemBytes, 'maxItemBytes');
  safePositiveInteger(config.historySize, 'historySize');
  nonNegativeSafeInteger(config.criticalReservedBytes, 'criticalReservedBytes');
  nonNegativeSafeInteger(config.interactiveReservedBytes, 'interactiveReservedBytes');
  if (config.maxItemBytes > config.maxBytes) throw new RangeError('maxItemBytes cannot exceed maxBytes');
  if (config.criticalReservedBytes + config.interactiveReservedBytes > config.maxBytes) {
    throw new RangeError('reserved bytes cannot exceed maxBytes');
  }
  return Object.freeze(config);
}

interface ActiveResource {
  readonly key: string;
  readonly lane: ResourceLane;
  readonly bytes: number;
}

/**
 * Tracks estimated in-process resource ownership without allocating resources itself.
 * Consumers supply byte estimates and explicitly release leases. The budget owns no
 * timer, network transport, Promise, persistence, telemetry, or eviction side effect.
 */
export class RuntimeResourceBudget {
  readonly #config: RuntimeResourceBudgetConfig;
  readonly #active = new Map<string, ActiveResource>();
  readonly #history: ResourceBudgetEvent[] = [];
  #sequence = 0;
  #admitted = 0;
  #rejected = 0;
  #released = 0;

  public constructor(config: Partial<RuntimeResourceBudgetConfig> = {}) {
    this.#config = validateConfig(config);
  }

  public acquire(key: string, lane: ResourceLane, bytes: number): ResourceAdmission {
    this.#validateRequest(key, lane, bytes);
    if (this.#active.has(key)) return this.#reject(key, lane, bytes, 'duplicate');
    if (bytes > this.#config.maxItemBytes) return this.#reject(key, lane, bytes, 'item-too-large');
    if (this.#active.size >= this.#config.maxItems) return this.#reject(key, lane, bytes, 'global-capacity');
    const used = this.#totalBytes();
    if (used + bytes > this.#config.maxBytes) return this.#reject(key, lane, bytes, 'global-capacity');
    if (!this.#fitsLaneReservation(lane, used + bytes)) return this.#reject(key, lane, bytes, 'lane-capacity');

    const resource = Object.freeze({ key, lane, bytes });
    this.#active.set(key, resource);
    this.#admitted += 1;
    this.#record({ type: 'admit', key, lane, bytes });
    let released = false;
    const lease: ResourceLease = Object.freeze({
      key,
      lane,
      bytes,
      release: (): void => {
        if (released) return;
        const current = this.#active.get(key);
        if (current !== resource) return;
        this.#active.delete(key);
        released = true;
        this.#released += 1;
        this.#record({ type: 'release', key, lane, bytes });
      },
    });
    return Object.freeze({ admitted: true, reason: 'admitted', lease });
  }

  public snapshot(): RuntimeResourceBudgetSnapshot {
    const critical = this.#laneUsage('critical');
    const interactive = this.#laneUsage('interactive');
    const background = this.#laneUsage('background');
    const bytes = critical.bytes + interactive.bytes + background.bytes;
    return Object.freeze({
      items: critical.items + interactive.items + background.items,
      bytes,
      remainingBytes: this.#config.maxBytes - bytes,
      lanes: Object.freeze({ critical, interactive, background }),
      admitted: this.#admitted,
      rejected: this.#rejected,
      released: this.#released,
      history: Object.freeze(this.#history.map((event) => Object.freeze({ ...event }))),
    });
  }

  public reset(): void {
    this.#active.clear();
    this.#history.length = 0;
    this.#sequence = 0;
    this.#admitted = 0;
    this.#rejected = 0;
    this.#released = 0;
  }

  #validateRequest(key: string, lane: ResourceLane, bytes: number): void {
    if (typeof key !== 'string' || key.trim().length === 0) throw new TypeError('key must be a non-empty string');
    if (!LANES.includes(lane)) throw new RangeError(`unsupported lane: ${String(lane)}`);
    safePositiveInteger(bytes, 'bytes');
  }

  #fitsLaneReservation(lane: ResourceLane, projectedTotal: number): boolean {
    const remaining = this.#config.maxBytes - projectedTotal;
    if (lane === 'critical') return true;
    if (lane === 'interactive') return remaining >= this.#config.criticalReservedBytes;
    return remaining >= this.#config.criticalReservedBytes + this.#config.interactiveReservedBytes;
  }

  #totalBytes(): number {
    let total = 0;
    for (const resource of this.#active.values()) total += resource.bytes;
    return total;
  }

  #laneUsage(lane: ResourceLane): ResourceLaneUsage {
    let items = 0;
    let bytes = 0;
    for (const resource of this.#active.values()) {
      if (resource.lane !== lane) continue;
      items += 1;
      bytes += resource.bytes;
    }
    return Object.freeze({ items, bytes });
  }

  #reject(key: string, lane: ResourceLane, bytes: number, reason: ResourceRejection): ResourceAdmission {
    this.#rejected += 1;
    this.#record({ type: 'reject', key, lane, bytes, reason });
    return Object.freeze({ admitted: false, reason, lease: null });
  }

  #record(event: Omit<ResourceBudgetEvent, 'sequence'>): void {
    this.#sequence += 1;
    this.#history.push(Object.freeze({ sequence: this.#sequence, ...event }));
    if (this.#history.length > this.#config.historySize) this.#history.shift();
  }
}
