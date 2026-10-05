export type RuntimeLoadClass = 'critical' | 'interactive' | 'background';
export type RuntimePressureBand = 'normal' | 'elevated' | 'severe';

export interface RuntimeLoadShedPolicy {
  readonly maxScopes: number;
  readonly maxSamplesPerScope: number;
  readonly sampleTtlMs: number;
  readonly idleScopeTtlMs: number;
  readonly elevatedThreshold: number;
  readonly severeThreshold: number;
  readonly recoveryThreshold: number;
  readonly recoverySamples: number;
  readonly maxClockSkewMs: number;
}

export interface RuntimeLoadSample {
  readonly cpu: number;
  readonly memory: number;
  readonly network: number;
}

export interface RuntimeLoadDecision {
  readonly admitted: boolean;
  readonly band: RuntimePressureBand;
  readonly generation: number;
  readonly evaluatedAt: number;
}

export interface RuntimeLoadShedSnapshot {
  readonly scopes: number;
  readonly samples: number;
  readonly normalScopes: number;
  readonly elevatedScopes: number;
  readonly severeScopes: number;
  readonly admitted: number;
  readonly shed: number;
  readonly generation: number;
  readonly disposed: boolean;
}

interface SampleState extends RuntimeLoadSample { readonly at: number; }
interface ScopeState {
  readonly samples: SampleState[];
  band: RuntimePressureBand;
  recoveryStreak: number;
  touchedAt: number;
}

const DEFAULT_POLICY: RuntimeLoadShedPolicy = Object.freeze({
  maxScopes: 128,
  maxSamplesPerScope: 12,
  sampleTtlMs: 30_000,
  idleScopeTtlMs: 300_000,
  elevatedThreshold: 0.7,
  severeThreshold: 0.9,
  recoveryThreshold: 0.55,
  recoverySamples: 3,
  maxClockSkewMs: 1_000,
});
const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER - 1;

function integer(value: number, name: string, min: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) throw new TypeError(`${name} must be an integer >= ${min}`);
  return value;
}
function ratio(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new TypeError(`${name} must be between 0 and 1`);
  return value;
}
function validatePolicy(input: Partial<RuntimeLoadShedPolicy>): RuntimeLoadShedPolicy {
  const p = { ...DEFAULT_POLICY, ...input };
  integer(p.maxScopes, 'maxScopes', 1);
  integer(p.maxSamplesPerScope, 'maxSamplesPerScope', 1);
  integer(p.sampleTtlMs, 'sampleTtlMs', 1);
  integer(p.idleScopeTtlMs, 'idleScopeTtlMs', 1);
  integer(p.recoverySamples, 'recoverySamples', 1);
  integer(p.maxClockSkewMs, 'maxClockSkewMs', 0);
  ratio(p.elevatedThreshold, 'elevatedThreshold');
  ratio(p.severeThreshold, 'severeThreshold');
  ratio(p.recoveryThreshold, 'recoveryThreshold');
  if (p.elevatedThreshold >= p.severeThreshold) throw new RangeError('elevatedThreshold must be below severeThreshold');
  if (p.recoveryThreshold >= p.elevatedThreshold) throw new RangeError('recoveryThreshold must be below elevatedThreshold');
  return Object.freeze(p);
}
function validateScope(scope: string): string {
  if (!SAFE_SCOPE.test(scope)) throw new TypeError('scope must be a bounded platform identifier');
  return scope;
}
function validateClass(value: RuntimeLoadClass): RuntimeLoadClass {
  if (value !== 'critical' && value !== 'interactive' && value !== 'background') throw new TypeError('unsupported runtime load class');
  return value;
}
function validateSample(sample: RuntimeLoadSample): RuntimeLoadSample {
  ratio(sample.cpu, 'cpu'); ratio(sample.memory, 'memory'); ratio(sample.network, 'network');
  return sample;
}

export class RuntimeLoadShedGovernor {
  private readonly policy: RuntimeLoadShedPolicy;
  private readonly now: () => number;
  private readonly scopes = new Map<string, ScopeState>();
  private generation = 1;
  private lastNow = 0;
  private admitted = 0;
  private shed = 0;
  private disposed = false;

  constructor(policy: Partial<RuntimeLoadShedPolicy> = {}, now: () => number = Date.now) {
    this.policy = validatePolicy(policy);
    this.now = now;
    this.lastNow = this.readClock();
  }

  record(scopeInput: string, sampleInput: RuntimeLoadSample): RuntimePressureBand {
    this.assertUsable();
    const scope = validateScope(scopeInput);
    const sample = validateSample(sampleInput);
    const now = this.tick();
    this.sweepAt(now);
    let state = this.scopes.get(scope);
    if (!state) {
      if (!this.ensureCapacity(now)) throw new Error('runtime load scope capacity exhausted');
      state = { samples: [], band: 'normal', recoveryStreak: 0, touchedAt: now };
      this.scopes.set(scope, state);
    }
    state.samples.push({ ...sample, at: now });
    if (state.samples.length > this.policy.maxSamplesPerScope) state.samples.splice(0, state.samples.length - this.policy.maxSamplesPerScope);
    state.touchedAt = now;
    this.recompute(state);
    return state.band;
  }

  decide(scopeInput: string, loadClassInput: RuntimeLoadClass): RuntimeLoadDecision {
    this.assertUsable();
    const scope = validateScope(scopeInput);
    const loadClass = validateClass(loadClassInput);
    const now = this.tick();
    this.sweepAt(now);
    const state = this.scopes.get(scope);
    const band = state?.band ?? 'normal';
    if (state) state.touchedAt = now;
    const admitted = band === 'normal' || loadClass === 'critical' || (band === 'elevated' && loadClass === 'interactive');
    if (admitted) this.admitted = this.bump(this.admitted); else this.shed = this.bump(this.shed);
    return Object.freeze({ admitted, band, generation: this.generation, evaluatedAt: now });
  }

  band(scopeInput: string): RuntimePressureBand {
    this.assertUsable();
    const scope = validateScope(scopeInput);
    const now = this.tick();
    this.sweepAt(now);
    return this.scopes.get(scope)?.band ?? 'normal';
  }

  resetScope(scopeInput: string): boolean {
    this.assertUsable();
    const scope = validateScope(scopeInput);
    this.tick();
    const removed = this.scopes.delete(scope);
    if (removed) this.advanceGeneration();
    return removed;
  }

  sweep(): number { this.assertUsable(); return this.sweepAt(this.tick()); }

  snapshot(): RuntimeLoadShedSnapshot {
    let samples = 0, normalScopes = 0, elevatedScopes = 0, severeScopes = 0;
    for (const state of this.scopes.values()) {
      samples += state.samples.length;
      if (state.band === 'normal') normalScopes += 1;
      else if (state.band === 'elevated') elevatedScopes += 1;
      else severeScopes += 1;
    }
    return Object.freeze({ scopes: this.scopes.size, samples, normalScopes, elevatedScopes, severeScopes, admitted: this.admitted, shed: this.shed, generation: this.generation, disposed: this.disposed });
  }

  dispose(): void {
    if (this.disposed) return;
    this.scopes.clear();
    this.advanceGeneration();
    this.disposed = true;
  }

  private recompute(state: ScopeState): void {
    if (state.samples.length === 0) {
      state.band = 'normal';
      state.recoveryStreak = 0;
      return;
    }
    let peak = 0;
    for (const sample of state.samples) peak = Math.max(peak, sample.cpu, sample.memory, sample.network);
    if (peak >= this.policy.severeThreshold) { state.band = 'severe'; state.recoveryStreak = 0; return; }
    if (peak >= this.policy.elevatedThreshold) { state.band = 'elevated'; state.recoveryStreak = 0; return; }
    if (peak <= this.policy.recoveryThreshold) state.recoveryStreak += 1; else state.recoveryStreak = 0;
    if (state.recoveryStreak >= this.policy.recoverySamples) state.band = 'normal';
  }

  private sweepAt(now: number): number {
    let removed = 0;
    for (const [scope, state] of this.scopes) {
      let firstLive = 0;
      while (firstLive < state.samples.length && now - state.samples[firstLive]!.at >= this.policy.sampleTtlMs) firstLive += 1;
      if (firstLive > 0) { state.samples.splice(0, firstLive); removed += firstLive; this.recompute(state); }
      if (state.samples.length === 0 && now - state.touchedAt >= this.policy.idleScopeTtlMs) this.scopes.delete(scope);
    }
    return removed;
  }

  private ensureCapacity(now: number): boolean {
    if (this.scopes.size < this.policy.maxScopes) return true;
    let candidate: string | null = null, touched = Number.POSITIVE_INFINITY;
    for (const [scope, state] of this.scopes) if (state.samples.length === 0 && state.touchedAt < touched) { candidate = scope; touched = state.touchedAt; }
    if (candidate === null || touched > now) return false;
    this.scopes.delete(candidate);
    return true;
  }

  private tick(): number {
    const current = this.readClock();
    if (current + this.policy.maxClockSkewMs < this.lastNow) throw new Error('runtime load clock moved backwards beyond policy');
    this.lastNow = Math.max(this.lastNow, current);
    return this.lastNow;
  }
  private readClock(): number {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) throw new Error('runtime load clock must return a finite non-negative value');
    return value;
  }
  private bump(value: number): number { return value >= MAX_COUNTER ? MAX_COUNTER : value + 1; }
  private advanceGeneration(): void { this.generation = this.generation >= MAX_COUNTER ? 1 : this.generation + 1; }
  private assertUsable(): void { if (this.disposed) throw new Error('RuntimeLoadShedGovernor is disposed'); }
}

export function createRuntimeLoadShedGovernor(policy: Partial<RuntimeLoadShedPolicy> = {}, now: () => number = Date.now): RuntimeLoadShedGovernor {
  return new RuntimeLoadShedGovernor(policy, now);
}
