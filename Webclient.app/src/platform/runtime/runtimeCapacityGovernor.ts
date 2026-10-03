export type RuntimeCapacityPriority = 'background' | 'normal' | 'critical';
export type RuntimeCapacityReason = 'admitted' | 'scope-capacity' | 'global-capacity' | 'unit-capacity' | 'byte-capacity' | 'disposed' | 'invalid';
export interface RuntimeCapacityPolicy { maxScopes: number; maxActivePerScope: number; maxActiveGlobal: number; maxUnitsGlobal: number; maxBytesGlobal: number; maxLeaseAgeMs: number; maxIdentifierLength: number; criticalReserve: number; }
export interface RuntimeCapacityRequest { scope: string; key: string; priority?: RuntimeCapacityPriority; units?: number; bytes?: number; }
export interface RuntimeCapacityLease { readonly scope: string; readonly key: string; readonly priority: RuntimeCapacityPriority; readonly generation: number; readonly units: number; readonly bytes: number; readonly admittedAt: number; readonly expiresAt: number; }
export interface RuntimeCapacityDecision { readonly accepted: boolean; readonly reason: RuntimeCapacityReason; readonly lease: RuntimeCapacityLease | null; }
export interface RuntimeCapacityScopeSnapshot { readonly scope: string; readonly generation: number; readonly active: number; readonly units: number; readonly bytes: number; readonly critical: number; readonly normal: number; readonly background: number; readonly lastTouchedAt: number; }
export interface RuntimeCapacitySnapshot { readonly disposed: boolean; readonly scopeCount: number; readonly active: number; readonly units: number; readonly bytes: number; readonly scopes: readonly RuntimeCapacityScopeSnapshot[]; }
interface ActiveLease extends RuntimeCapacityLease { readonly token: number; }
interface ScopeState { scope: string; generation: number; leases: Map<string, ActiveLease>; lastTouchedAt: number; }
const DEFAULT_POLICY: RuntimeCapacityPolicy = { maxScopes: 64, maxActivePerScope: 16, maxActiveGlobal: 128, maxUnitsGlobal: 512, maxBytesGlobal: 64 * 1024 * 1024, maxLeaseAgeMs: 30_000, maxIdentifierLength: 96, criticalReserve: 8 };
function positiveInteger(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; }
function nonNegativeInteger(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback; }
function clock(value: number): number { return Number.isFinite(value) && value >= 0 ? value : 0; }
function identifier(value: unknown, max: number): string | null { if (typeof value !== 'string') return null; const normalized = value.trim().toLowerCase(); return normalized && normalized.length <= max && /^[a-z0-9][a-z0-9._:/-]*$/.test(normalized) ? normalized : null; }
function priority(value: unknown): RuntimeCapacityPriority { return value === 'critical' || value === 'background' ? value : 'normal'; }
function publicLease(lease: ActiveLease): RuntimeCapacityLease { return Object.freeze({ scope: lease.scope, key: lease.key, priority: lease.priority, generation: lease.generation, units: lease.units, bytes: lease.bytes, admittedAt: lease.admittedAt, expiresAt: lease.expiresAt }); }
function result(accepted: boolean, reason: RuntimeCapacityReason, lease: RuntimeCapacityLease | null = null): RuntimeCapacityDecision { return Object.freeze({ accepted, reason, lease }); }

/** Bounded, payload-free authority for expensive runtime work capacity. It owns scalar accounting only. */
export class RuntimeCapacityGovernor {
  readonly policy: Readonly<RuntimeCapacityPolicy>;
  private readonly now: () => number;
  private readonly scopes = new Map<string, ScopeState>();
  private readonly generations = new Map<string, number>();
  private disposed = false;
  private nextToken = 1;
  constructor(options: { policy?: Partial<RuntimeCapacityPolicy>; now?: () => number } = {}) {
    const p = options.policy ?? {}; const maxActiveGlobal = positiveInteger(p.maxActiveGlobal, DEFAULT_POLICY.maxActiveGlobal);
    this.policy = Object.freeze({ maxScopes: positiveInteger(p.maxScopes, DEFAULT_POLICY.maxScopes), maxActivePerScope: positiveInteger(p.maxActivePerScope, DEFAULT_POLICY.maxActivePerScope), maxActiveGlobal, maxUnitsGlobal: positiveInteger(p.maxUnitsGlobal, DEFAULT_POLICY.maxUnitsGlobal), maxBytesGlobal: positiveInteger(p.maxBytesGlobal, DEFAULT_POLICY.maxBytesGlobal), maxLeaseAgeMs: positiveInteger(p.maxLeaseAgeMs, DEFAULT_POLICY.maxLeaseAgeMs), maxIdentifierLength: positiveInteger(p.maxIdentifierLength, DEFAULT_POLICY.maxIdentifierLength), criticalReserve: Math.min(maxActiveGlobal, nonNegativeInteger(p.criticalReserve, DEFAULT_POLICY.criticalReserve)) });
    this.now = options.now ?? Date.now;
  }
  admit(request: RuntimeCapacityRequest): RuntimeCapacityDecision {
    if (this.disposed) return result(false, 'disposed'); const now = this.readNow(); this.sweep(now);
    const scope = identifier(request.scope, this.policy.maxIdentifierLength); const key = identifier(request.key, this.policy.maxIdentifierLength); const units = positiveInteger(request.units ?? 1, 1); const bytes = nonNegativeInteger(request.bytes ?? 0, 0);
    if (!scope || !key || units > this.policy.maxUnitsGlobal || bytes > this.policy.maxBytesGlobal) return result(false, 'invalid');
    const lane = priority(request.priority); let state = this.scopes.get(scope);
    if (!state) { if (!this.ensureScopeCapacity()) return result(false, 'scope-capacity'); state = this.createScope(scope, now); }
    if (state.leases.has(key)) return result(false, 'invalid'); if (state.leases.size >= this.policy.maxActivePerScope) return result(false, 'scope-capacity');
    const totals = this.totals(); const generalLimit = Math.max(0, this.policy.maxActiveGlobal - this.policy.criticalReserve);
    if (totals.active >= this.policy.maxActiveGlobal || (lane !== 'critical' && totals.active >= generalLimit)) return result(false, 'global-capacity');
    if (totals.units + units > this.policy.maxUnitsGlobal) return result(false, 'unit-capacity'); if (totals.bytes + bytes > this.policy.maxBytesGlobal) return result(false, 'byte-capacity');
    const active: ActiveLease = Object.freeze({ scope, key, priority: lane, generation: state.generation, units, bytes, admittedAt: now, expiresAt: now + this.policy.maxLeaseAgeMs, token: this.nextToken++ }); state.leases.set(key, active); state.lastTouchedAt = now; return result(true, 'admitted', publicLease(active));
  }
  release(lease: RuntimeCapacityLease): boolean { return this.settle(lease); }
  cancel(lease: RuntimeCapacityLease): boolean { return this.settle(lease); }
  renew(lease: RuntimeCapacityLease): RuntimeCapacityLease | null { if (this.disposed) return null; const now = this.readNow(); const active = this.resolve(lease, now); if (!active) return null; const state = this.scopes.get(active.scope)!; const renewed: ActiveLease = Object.freeze({ ...active, admittedAt: now, expiresAt: now + this.policy.maxLeaseAgeMs, token: this.nextToken++ }); state.leases.set(active.key, renewed); state.lastTouchedAt = now; return publicLease(renewed); }
  sweep(at = this.readNow()): number { if (this.disposed) return 0; const now = clock(at); let removed = 0; for (const state of this.scopes.values()) for (const [key, lease] of state.leases) if (lease.expiresAt <= now) { state.leases.delete(key); removed += 1; } return removed; }
  resetScope(raw: string): boolean { if (this.disposed) return false; const scope = identifier(raw, this.policy.maxIdentifierLength); if (!scope || !this.scopes.has(scope)) return false; this.scopes.delete(scope); this.createScope(scope, this.readNow()); return true; }
  retireScope(raw: string): boolean { if (this.disposed) return false; const scope = identifier(raw, this.policy.maxIdentifierLength); return scope ? this.scopes.delete(scope) : false; }
  snapshot(): RuntimeCapacitySnapshot { if (!this.disposed) this.sweep(); const scopes = [...this.scopes.values()].sort((a,b) => a.scope.localeCompare(b.scope)).map(state => { let units=0,bytes=0,critical=0,normal=0,background=0; for (const lease of state.leases.values()) { units+=lease.units; bytes+=lease.bytes; if(lease.priority==='critical')critical+=1; else if(lease.priority==='background')background+=1; else normal+=1; } return Object.freeze({ scope:state.scope,generation:state.generation,active:state.leases.size,units,bytes,critical,normal,background,lastTouchedAt:state.lastTouchedAt }); }); const totals=this.totals(); return Object.freeze({disposed:this.disposed,scopeCount:scopes.length,active:totals.active,units:totals.units,bytes:totals.bytes,scopes:Object.freeze(scopes)}); }
  dispose(): void { if (this.disposed) return; this.disposed=true; this.scopes.clear(); this.generations.clear(); }
  private settle(lease: RuntimeCapacityLease): boolean { if(this.disposed)return false; const active=this.resolve(lease,this.readNow()); if(!active)return false; const state=this.scopes.get(active.scope)!; state.leases.delete(active.key); state.lastTouchedAt=this.readNow(); return true; }
  private resolve(lease: RuntimeCapacityLease, now:number): ActiveLease|null { const scope=identifier(lease?.scope,this.policy.maxIdentifierLength),key=identifier(lease?.key,this.policy.maxIdentifierLength); if(!scope||!key)return null; const state=this.scopes.get(scope),active=state?.leases.get(key); if(!state||!active||active.generation!==lease.generation||active.expiresAt<=now){if(active&&active.expiresAt<=now)state?.leases.delete(key);return null;} if(active.admittedAt!==lease.admittedAt||active.expiresAt!==lease.expiresAt||active.units!==lease.units||active.bytes!==lease.bytes||active.priority!==lease.priority)return null; return active; }
  private ensureScopeCapacity(): boolean { if(this.scopes.size<this.policy.maxScopes)return true; const candidate=[...this.scopes.values()].filter(s=>s.leases.size===0).sort((a,b)=>a.lastTouchedAt-b.lastTouchedAt||a.scope.localeCompare(b.scope))[0]; if(!candidate)return false; this.scopes.delete(candidate.scope); return true; }
  private createScope(scope:string,now:number):ScopeState { const generation=(this.generations.get(scope)??0)+1; this.generations.set(scope,generation); const state:ScopeState={scope,generation,leases:new Map(),lastTouchedAt:now}; this.scopes.set(scope,state); return state; }
  private totals():{active:number;units:number;bytes:number}{let active=0,units=0,bytes=0;for(const state of this.scopes.values())for(const lease of state.leases.values()){active+=1;units+=lease.units;bytes+=lease.bytes;}return{active,units,bytes};}
  private readNow():number{return clock(this.now());}
}
export function createRuntimeCapacityGovernor(options: ConstructorParameters<typeof RuntimeCapacityGovernor>[0] = {}): RuntimeCapacityGovernor { return new RuntimeCapacityGovernor(options); }
