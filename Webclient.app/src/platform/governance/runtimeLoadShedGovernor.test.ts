import { describe, expect, it } from 'vitest';
import { RuntimeLoadShedGovernor } from './runtimeLoadShedGovernor';

const sample = (cpu: number, memory = cpu, network = cpu) => ({ cpu, memory, network });

describe('RuntimeLoadShedGovernor', () => {
  it('starts unknown scopes in the normal band', () => {
    const governor = new RuntimeLoadShedGovernor();
    expect(governor.band('map')).toBe('normal');
    expect(governor.decide('map', 'background')).toMatchObject({ admitted: true, band: 'normal' });
  });

  it('moves to elevated pressure when any resource crosses its threshold', () => {
    const governor = new RuntimeLoadShedGovernor();
    expect(governor.record('map', sample(0.71, 0.1, 0.1))).toBe('elevated');
    expect(governor.record('search', sample(0.1, 0.71, 0.1))).toBe('elevated');
    expect(governor.record('scene', sample(0.1, 0.1, 0.71))).toBe('elevated');
  });

  it('moves to severe pressure at the severe threshold', () => {
    const governor = new RuntimeLoadShedGovernor();
    expect(governor.record('map', sample(0.9))).toBe('severe');
  });

  it('keeps critical work admitted under severe pressure', () => {
    const governor = new RuntimeLoadShedGovernor();
    governor.record('map', sample(0.95));
    expect(governor.decide('map', 'critical').admitted).toBe(true);
  });

  it('sheds interactive and background work under severe pressure', () => {
    const governor = new RuntimeLoadShedGovernor();
    governor.record('map', sample(0.95));
    expect(governor.decide('map', 'interactive').admitted).toBe(false);
    expect(governor.decide('map', 'background').admitted).toBe(false);
  });

  it('admits interactive but sheds background work under elevated pressure', () => {
    const governor = new RuntimeLoadShedGovernor();
    governor.record('map', sample(0.75));
    expect(governor.decide('map', 'interactive').admitted).toBe(true);
    expect(governor.decide('map', 'background').admitted).toBe(false);
  });

  it('requires a bounded recovery streak before returning to normal', () => {
    let now = 0;
    const governor = new RuntimeLoadShedGovernor({ maxSamplesPerScope: 1, recoverySamples: 3 }, () => now);
    governor.record('map', sample(0.95));
    now += 1; expect(governor.record('map', sample(0.2))).toBe('severe');
    now += 1; expect(governor.record('map', sample(0.2))).toBe('severe');
    now += 1; expect(governor.record('map', sample(0.2))).toBe('normal');
  });

  it('breaks a recovery streak when pressure rises', () => {
    let now = 0;
    const governor = new RuntimeLoadShedGovernor({ maxSamplesPerScope: 1, recoverySamples: 2 }, () => now);
    governor.record('map', sample(0.95));
    now += 1; governor.record('map', sample(0.2));
    now += 1; expect(governor.record('map', sample(0.6))).toBe('severe');
    now += 1; expect(governor.record('map', sample(0.2))).toBe('severe');
    now += 1; expect(governor.record('map', sample(0.2))).toBe('normal');
  });

  it('bounds retained samples per scope', () => {
    let now = 0;
    const governor = new RuntimeLoadShedGovernor({ maxSamplesPerScope: 2 }, () => now);
    for (let i = 0; i < 20; i += 1) { now += 1; governor.record('map', sample(0.1)); }
    expect(governor.snapshot().samples).toBe(2);
  });

  it('expires old samples deterministically', () => {
    let now = 0;
    const governor = new RuntimeLoadShedGovernor({ sampleTtlMs: 10 }, () => now);
    governor.record('map', sample(0.95));
    now = 10;
    expect(governor.sweep()).toBe(1);
    expect(governor.band('map')).toBe('normal');
  });

  it('evicts idle empty scopes after retention', () => {
    let now = 0;
    const governor = new RuntimeLoadShedGovernor({ sampleTtlMs: 5, idleScopeTtlMs: 10 }, () => now);
    governor.record('map', sample(0.1));
    now = 5; governor.sweep();
    expect(governor.snapshot().scopes).toBe(1);
    now = 10; governor.sweep();
    expect(governor.snapshot().scopes).toBe(0);
  });

  it('fails closed when scope capacity is occupied by live samples', () => {
    const governor = new RuntimeLoadShedGovernor({ maxScopes: 1 });
    governor.record('one', sample(0.1));
    expect(() => governor.record('two', sample(0.1))).toThrow(/capacity exhausted/);
  });

  it('reuses capacity after an empty scope becomes evictable', () => {
    let now = 0;
    const governor = new RuntimeLoadShedGovernor({ maxScopes: 1, sampleTtlMs: 5, idleScopeTtlMs: 100 }, () => now);
    governor.record('one', sample(0.1));
    now = 5; governor.sweep();
    expect(governor.record('two', sample(0.1))).toBe('normal');
    expect(governor.snapshot().scopes).toBe(1);
  });

  it.each(['', ' space', 'a/b', '<script>', 'x'.repeat(97)])('rejects unsafe scope %j', (scope) => {
    const governor = new RuntimeLoadShedGovernor();
    expect(() => governor.record(scope, sample(0.1))).toThrow(/bounded platform identifier/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1])('rejects invalid sample component %s', (value) => {
    const governor = new RuntimeLoadShedGovernor();
    expect(() => governor.record('map', sample(value))).toThrow();
  });

  it('validates memory and network independently', () => {
    const governor = new RuntimeLoadShedGovernor();
    expect(() => governor.record('map', { cpu: 0.1, memory: 2, network: 0.1 })).toThrow(/memory/);
    expect(() => governor.record('map', { cpu: 0.1, memory: 0.1, network: -1 })).toThrow(/network/);
  });

  it('rejects malformed runtime classes at runtime', () => {
    const governor = new RuntimeLoadShedGovernor();
    expect(() => governor.decide('map', 'batch' as never)).toThrow(/unsupported runtime load class/);
  });

  it('rejects invalid threshold ordering', () => {
    expect(() => new RuntimeLoadShedGovernor({ elevatedThreshold: 0.9, severeThreshold: 0.8 })).toThrow(/elevatedThreshold/);
    expect(() => new RuntimeLoadShedGovernor({ recoveryThreshold: 0.8, elevatedThreshold: 0.7 })).toThrow(/recoveryThreshold/);
  });

  it.each([
    { maxScopes: 0 }, { maxSamplesPerScope: 0 }, { sampleTtlMs: 0 }, { idleScopeTtlMs: 0 }, { recoverySamples: 0 }, { maxClockSkewMs: -1 },
  ])('rejects invalid integer policy %j', (policy) => {
    expect(() => new RuntimeLoadShedGovernor(policy)).toThrow();
  });

  it('tolerates bounded clock rollback without moving logical time backwards', () => {
    let now = 100;
    const governor = new RuntimeLoadShedGovernor({ maxClockSkewMs: 10 }, () => now);
    const first = governor.decide('map', 'critical');
    now = 95;
    const second = governor.decide('map', 'critical');
    expect(second.evaluatedAt).toBe(first.evaluatedAt);
  });

  it('rejects clock rollback beyond policy', () => {
    let now = 100;
    const governor = new RuntimeLoadShedGovernor({ maxClockSkewMs: 5 }, () => now);
    now = 90;
    expect(() => governor.sweep()).toThrow(/clock moved backwards/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('rejects invalid clock value %s', (bad) => {
    expect(() => new RuntimeLoadShedGovernor({}, () => bad)).toThrow(/finite non-negative/);
  });

  it('reports aggregate-only diagnostics', () => {
    const governor = new RuntimeLoadShedGovernor();
    governor.record('secret-looking-scope', sample(0.95));
    governor.decide('secret-looking-scope', 'critical');
    governor.decide('secret-looking-scope', 'background');
    const snapshot = governor.snapshot();
    expect(snapshot).toMatchObject({ scopes: 1, samples: 1, severeScopes: 1, admitted: 1, shed: 1 });
    expect(JSON.stringify(snapshot)).not.toContain('secret-looking-scope');
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('advances generation only when a scope reset removes state', () => {
    const governor = new RuntimeLoadShedGovernor();
    const initial = governor.snapshot().generation;
    expect(governor.resetScope('missing')).toBe(false);
    expect(governor.snapshot().generation).toBe(initial);
    governor.record('map', sample(0.1));
    expect(governor.resetScope('map')).toBe(true);
    expect(governor.snapshot().generation).toBe(initial + 1);
  });

  it('resets pressure state to normal', () => {
    const governor = new RuntimeLoadShedGovernor();
    governor.record('map', sample(0.99));
    governor.resetScope('map');
    expect(governor.band('map')).toBe('normal');
  });

  it('keeps decisions detached and immutable', () => {
    const governor = new RuntimeLoadShedGovernor();
    const decision = governor.decide('map', 'critical');
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it('disposes idempotently and clears retained state', () => {
    const governor = new RuntimeLoadShedGovernor();
    governor.record('map', sample(0.8));
    governor.dispose(); governor.dispose();
    expect(governor.snapshot()).toMatchObject({ scopes: 0, samples: 0, disposed: true });
  });

  it('rejects mutating operations after disposal', () => {
    const governor = new RuntimeLoadShedGovernor();
    governor.dispose();
    expect(() => governor.record('map', sample(0.1))).toThrow(/disposed/);
    expect(() => governor.decide('map', 'critical')).toThrow(/disposed/);
    expect(() => governor.band('map')).toThrow(/disposed/);
    expect(() => governor.resetScope('map')).toThrow(/disposed/);
    expect(() => governor.sweep()).toThrow(/disposed/);
  });
});
