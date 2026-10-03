import { describe, expect, it } from 'vitest';
import { FailureDomainSupervisor, createFailureDomainSupervisor } from './failureDomainSupervisor';

function harness(overrides: ConstructorParameters<typeof FailureDomainSupervisor>[0]['policy'] = {}) {
  let now = 0;
  const supervisor = new FailureDomainSupervisor({
    now: () => now,
    policy: {
      failureThreshold: 3,
      successThreshold: 2,
      openDurationMs: 100,
      rollingWindowMs: 500,
      halfOpenMaxConcurrent: 1,
      maxDomains: 4,
      maxIdentifierLength: 32,
      ...overrides,
    },
  });
  return { supervisor, setNow: (value: number) => { now = value; } };
}

describe('FailureDomainSupervisor', () => {
  it('starts closed and returns immutable normalized permits', () => {
    const { supervisor } = harness();
    const permit = supervisor.acquire('  API:Search  ');
    expect(permit).toEqual({ domain: 'api:search', generation: 1, probe: false, acquiredAt: 0 });
    expect(Object.isFrozen(permit)).toBe(true);
    expect(supervisor.snapshot().domains[0]?.state).toBe('closed');
  });

  it('rejects empty, oversized, and unsafe identifiers', () => {
    const { supervisor } = harness({ maxIdentifierLength: 8 });
    expect(supervisor.acquire('')).toBeNull();
    expect(supervisor.acquire('         ')).toBeNull();
    expect(supervisor.acquire('too-long-domain')).toBeNull();
    expect(supervisor.acquire('bad domain')).toBeNull();
    expect(supervisor.acquire('<script>')).toBeNull();
    expect(supervisor.snapshot().domainCount).toBe(0);
  });

  it('opens after the configured consecutive failure threshold', () => {
    const { supervisor } = harness();
    for (let index = 0; index < 3; index += 1) {
      const permit = supervisor.acquire('search');
      expect(permit).not.toBeNull();
      expect(supervisor.fail(permit!)).toBe(true);
    }
    const snapshot = supervisor.snapshot().domains[0]!;
    expect(snapshot.state).toBe('open');
    expect(snapshot.consecutiveFailures).toBe(3);
    expect(snapshot.retryAt).toBe(100);
    expect(supervisor.acquire('search')).toBeNull();
  });

  it('resets consecutive failures after a closed-state success', () => {
    const { supervisor } = harness();
    const first = supervisor.acquire('search')!;
    expect(supervisor.fail(first)).toBe(true);
    expect(supervisor.snapshot().domains[0]?.consecutiveFailures).toBe(1);
    const second = supervisor.acquire('search')!;
    expect(supervisor.succeed(second)).toBe(true);
    expect(supervisor.snapshot().domains[0]?.consecutiveFailures).toBe(0);
  });

  it('opens immediately for fatal failures', () => {
    const { supervisor } = harness({ failureThreshold: 99 });
    const permit = supervisor.acquire('renderer')!;
    expect(supervisor.fail(permit, 'fatal')).toBe(true);
    expect(supervisor.snapshot().domains[0]?.state).toBe('open');
  });

  it('moves an open domain to half-open after cooldown', () => {
    const { supervisor, setNow } = harness({ failureThreshold: 1 });
    const permit = supervisor.acquire('tiles')!;
    supervisor.fail(permit);
    setNow(99);
    expect(supervisor.acquire('tiles')).toBeNull();
    setNow(100);
    const probe = supervisor.acquire('tiles');
    expect(probe?.probe).toBe(true);
    expect(supervisor.snapshot().domains[0]?.state).toBe('half-open');
  });

  it('bounds concurrent half-open probes', () => {
    const { supervisor, setNow } = harness({ failureThreshold: 1, halfOpenMaxConcurrent: 2 });
    supervisor.fail(supervisor.acquire('tiles')!);
    setNow(100);
    const first = supervisor.acquire('tiles');
    const second = supervisor.acquire('tiles');
    expect(first?.probe).toBe(true);
    expect(second?.probe).toBe(true);
    expect(supervisor.acquire('tiles')).toBeNull();
    expect(supervisor.snapshot().domains[0]?.activeProbes).toBe(2);
  });

  it('closes only after enough successful probes', () => {
    const { supervisor, setNow } = harness({ failureThreshold: 1, successThreshold: 2 });
    supervisor.fail(supervisor.acquire('api')!);
    setNow(100);
    const first = supervisor.acquire('api')!;
    expect(supervisor.succeed(first)).toBe(true);
    expect(supervisor.snapshot().domains[0]?.state).toBe('half-open');
    const second = supervisor.acquire('api')!;
    expect(supervisor.succeed(second)).toBe(true);
    expect(supervisor.snapshot().domains[0]?.state).toBe('closed');
    expect(supervisor.acquire('api')?.probe).toBe(false);
  });

  it('reopens immediately when a probe fails', () => {
    const { supervisor, setNow } = harness({ failureThreshold: 1 });
    supervisor.fail(supervisor.acquire('api')!);
    setNow(100);
    const probe = supervisor.acquire('api')!;
    setNow(101);
    expect(supervisor.fail(probe, 'degraded')).toBe(true);
    const snapshot = supervisor.snapshot().domains[0]!;
    expect(snapshot.state).toBe('open');
    expect(snapshot.retryAt).toBe(201);
  });

  it('cancels a probe without treating cancellation as success or failure', () => {
    const { supervisor, setNow } = harness({ failureThreshold: 1 });
    supervisor.fail(supervisor.acquire('api')!);
    setNow(100);
    const probe = supervisor.acquire('api')!;
    expect(supervisor.cancel(probe)).toBe(true);
    const snapshot = supervisor.snapshot().domains[0]!;
    expect(snapshot.state).toBe('half-open');
    expect(snapshot.activeProbes).toBe(0);
    expect(snapshot.consecutiveFailures).toBe(0);
    expect(snapshot.consecutiveSuccesses).toBe(0);
  });

  it('rejects cancellation for non-probe permits', () => {
    const { supervisor } = harness();
    expect(supervisor.cancel(supervisor.acquire('api')!)).toBe(false);
  });

  it('invalidates stale permits across state generations', () => {
    const { supervisor } = harness({ failureThreshold: 1 });
    const stale = supervisor.acquire('api')!;
    const opener = supervisor.acquire('api')!;
    expect(supervisor.fail(opener)).toBe(true);
    expect(supervisor.succeed(stale)).toBe(false);
    expect(supervisor.fail(stale)).toBe(false);
  });

  it('supports an explicit administrative open', () => {
    const { supervisor } = harness();
    expect(supervisor.forceOpen('search')).toBe(true);
    expect(supervisor.snapshot().domains[0]?.state).toBe('open');
    expect(supervisor.acquire('search')).toBeNull();
  });

  it('supports an explicit reset to a clean closed generation', () => {
    const { supervisor } = harness({ failureThreshold: 1 });
    supervisor.fail(supervisor.acquire('search')!);
    const before = supervisor.snapshot().domains[0]!.generation;
    expect(supervisor.reset('search')).toBe(true);
    const after = supervisor.snapshot().domains[0]!;
    expect(after.state).toBe('closed');
    expect(after.generation).toBeGreaterThan(before);
    expect(after.rollingFailures).toBe(0);
    expect(after.retryAt).toBeNull();
  });

  it('returns false when resetting an unknown domain', () => {
    const { supervisor } = harness();
    expect(supervisor.reset('unknown')).toBe(false);
  });

  it('retires a domain and allows it to be recreated cleanly', () => {
    const { supervisor } = harness();
    supervisor.acquire('search');
    expect(supervisor.retire('search')).toBe(true);
    expect(supervisor.snapshot().domainCount).toBe(0);
    expect(supervisor.acquire('search')?.generation).toBe(1);
  });

  it('prunes rolling failure history without changing closed state', () => {
    const { supervisor, setNow } = harness({ failureThreshold: 10, rollingWindowMs: 50 });
    supervisor.fail(supervisor.acquire('api')!);
    expect(supervisor.snapshot().domains[0]?.rollingFailures).toBe(1);
    setNow(51);
    expect(supervisor.snapshot().domains[0]?.rollingFailures).toBe(0);
    expect(supervisor.snapshot().domains[0]?.state).toBe('closed');
  });

  it('sweep advances all eligible open domains', () => {
    const { supervisor, setNow } = harness({ failureThreshold: 1 });
    supervisor.fail(supervisor.acquire('a')!);
    supervisor.fail(supervisor.acquire('b')!);
    setNow(100);
    expect(supervisor.sweep()).toBe(2);
    expect(supervisor.snapshot().domains.map(item => item.state)).toEqual(['half-open', 'half-open']);
  });

  it('sweep is inert before retry deadlines', () => {
    const { supervisor, setNow } = harness({ failureThreshold: 1 });
    supervisor.fail(supervisor.acquire('a')!);
    setNow(99);
    expect(supervisor.sweep()).toBe(0);
    expect(supervisor.snapshot().domains[0]?.state).toBe('open');
  });

  it('evicts the least recently touched inactive domain at capacity', () => {
    const { supervisor, setNow } = harness({ maxDomains: 2 });
    supervisor.acquire('alpha');
    setNow(1);
    supervisor.acquire('beta');
    setNow(2);
    expect(supervisor.acquire('gamma')).not.toBeNull();
    expect(supervisor.snapshot().domains.map(item => item.domain)).toEqual(['beta', 'gamma']);
  });

  it('uses lexical order to make same-time capacity eviction deterministic', () => {
    const { supervisor } = harness({ maxDomains: 2 });
    supervisor.acquire('beta');
    supervisor.acquire('alpha');
    supervisor.acquire('gamma');
    expect(supervisor.snapshot().domains.map(item => item.domain)).toEqual(['beta', 'gamma']);
  });

  it('does not evict a domain with an active half-open probe', () => {
    const { supervisor, setNow } = harness({ maxDomains: 2, failureThreshold: 1 });
    supervisor.fail(supervisor.acquire('protected')!);
    setNow(100);
    expect(supervisor.acquire('protected')?.probe).toBe(true);
    setNow(101);
    supervisor.acquire('idle');
    setNow(102);
    supervisor.acquire('new');
    expect(supervisor.snapshot().domains.map(item => item.domain)).toEqual(['new', 'protected']);
  });

  it('bounds domain cardinality under repeated unique input', () => {
    const { supervisor } = harness({ maxDomains: 3 });
    for (let index = 0; index < 100; index += 1) supervisor.acquire(`domain-${index}`);
    expect(supervisor.snapshot().domainCount).toBe(3);
  });

  it('produces detached frozen snapshot containers', () => {
    const { supervisor } = harness();
    supervisor.acquire('search');
    const snapshot = supervisor.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.domains)).toBe(true);
    expect(Object.isFrozen(snapshot.domains[0])).toBe(true);
  });

  it('sorts snapshot domains for deterministic diagnostics', () => {
    const { supervisor } = harness();
    supervisor.acquire('zeta');
    supervisor.acquire('alpha');
    supervisor.acquire('middle');
    expect(supervisor.snapshot().domains.map(item => item.domain)).toEqual(['alpha', 'middle', 'zeta']);
  });

  it('normalizes invalid clocks to zero rather than leaking NaN', () => {
    const supervisor = new FailureDomainSupervisor({ now: () => Number.NaN });
    const permit = supervisor.acquire('api');
    expect(permit?.acquiredAt).toBe(0);
    expect(supervisor.snapshot().domains[0]?.lastTransitionAt).toBe(0);
  });

  it('normalizes negative clocks to zero', () => {
    const supervisor = new FailureDomainSupervisor({ now: () => -500 });
    expect(supervisor.acquire('api')?.acquiredAt).toBe(0);
  });

  it('normalizes invalid policy values to safe defaults', () => {
    const supervisor = new FailureDomainSupervisor({
      policy: {
        failureThreshold: 0,
        successThreshold: Number.NaN,
        openDurationMs: -1,
        halfOpenMaxConcurrent: 0,
        rollingWindowMs: 0,
        maxDomains: 0,
        maxIdentifierLength: 0,
      },
    });
    expect(supervisor.policy.failureThreshold).toBeGreaterThan(0);
    expect(supervisor.policy.successThreshold).toBeGreaterThan(0);
    expect(supervisor.policy.openDurationMs).toBeGreaterThanOrEqual(0);
    expect(supervisor.policy.maxDomains).toBeGreaterThan(0);
  });

  it('floors fractional policy limits', () => {
    const supervisor = new FailureDomainSupervisor({ policy: { failureThreshold: 2.9, maxDomains: 3.8 } });
    expect(supervisor.policy.failureThreshold).toBe(2);
    expect(supervisor.policy.maxDomains).toBe(3);
  });

  it('exposes a frozen policy object', () => {
    const { supervisor } = harness();
    expect(Object.isFrozen(supervisor.policy)).toBe(true);
  });

  it('factory creates an operational supervisor', () => {
    const supervisor = createFailureDomainSupervisor({ policy: { failureThreshold: 1 } });
    expect(supervisor).toBeInstanceOf(FailureDomainSupervisor);
    expect(supervisor.acquire('api')).not.toBeNull();
  });

  it('dispose is terminal and clears retained domain state', () => {
    const { supervisor } = harness();
    const permit = supervisor.acquire('api')!;
    supervisor.acquire('search');
    supervisor.dispose();
    expect(supervisor.disposed).toBe(true);
    expect(supervisor.snapshot().domainCount).toBe(0);
    expect(supervisor.acquire('new')).toBeNull();
    expect(supervisor.succeed(permit)).toBe(false);
    expect(supervisor.fail(permit)).toBe(false);
    expect(supervisor.forceOpen('new')).toBe(false);
    expect(supervisor.reset('api')).toBe(false);
    expect(supervisor.retire('api')).toBe(false);
    expect(supervisor.sweep()).toBe(0);
  });

  it('dispose is idempotent', () => {
    const { supervisor } = harness();
    supervisor.dispose();
    expect(() => supervisor.dispose()).not.toThrow();
  });

  it('rejects duplicate completion of a half-open probe', () => {
    const { supervisor, setNow } = harness({ failureThreshold: 1, successThreshold: 3 });
    supervisor.fail(supervisor.acquire('api')!);
    setNow(100);
    const probe = supervisor.acquire('api')!;
    expect(supervisor.succeed(probe)).toBe(true);
    expect(supervisor.succeed(probe)).toBe(false);
  });

  it('rejects duplicate cancellation of a probe', () => {
    const { supervisor, setNow } = harness({ failureThreshold: 1 });
    supervisor.fail(supervisor.acquire('api')!);
    setNow(100);
    const probe = supervisor.acquire('api')!;
    expect(supervisor.cancel(probe)).toBe(true);
    expect(supervisor.cancel(probe)).toBe(false);
  });

  it('tracks degraded failures in the rolling history', () => {
    const { supervisor } = harness({ failureThreshold: 5 });
    const permit = supervisor.acquire('api')!;
    expect(supervisor.fail(permit, 'degraded')).toBe(true);
    expect(supervisor.snapshot().domains[0]?.rollingFailures).toBe(1);
  });

  it('does not retain caller payloads because permits contain scalar metadata only', () => {
    const { supervisor } = harness();
    const permit = supervisor.acquire('api')!;
    expect(Object.keys(permit).sort()).toEqual(['acquiredAt', 'domain', 'generation', 'probe']);
  });

  it('preserves slash, colon, dot, underscore, and dash in safe domain keys', () => {
    const { supervisor } = harness();
    const permit = supervisor.acquire('API:/v2.search_worker-1');
    expect(permit?.domain).toBe('api:/v2.search_worker-1');
  });

  it('does not create records for administrative operations on unknown domains', () => {
    const { supervisor } = harness();
    expect(supervisor.reset('missing')).toBe(false);
    expect(supervisor.retire('missing')).toBe(false);
    expect(supervisor.snapshot().domainCount).toBe(0);
  });

  it('forceOpen respects the global cardinality bound', () => {
    const { supervisor } = harness({ maxDomains: 2 });
    expect(supervisor.forceOpen('a')).toBe(true);
    expect(supervisor.forceOpen('b')).toBe(true);
    expect(supervisor.forceOpen('c')).toBe(true);
    expect(supervisor.snapshot().domainCount).toBe(2);
  });

  it('open duration may safely be configured to zero', () => {
    const { supervisor } = harness({ failureThreshold: 1, openDurationMs: 0 });
    supervisor.fail(supervisor.acquire('api')!);
    const probe = supervisor.acquire('api');
    expect(probe?.probe).toBe(true);
  });
});
