import { describe, expect, it } from 'vitest';
import { RuntimeBackpressureController, type RuntimePressurePolicy } from './runtimeBackpressureController';

const policy = (overrides: Partial<RuntimePressurePolicy> = {}): RuntimePressurePolicy => ({
  maxScopes: 4,
  maxDeferred: 6,
  maxDeferredPerScope: 3,
  maxIdentifierLength: 64,
  deferTtlMs: 100,
  idleScopeTtlMs: 200,
  elevatedConcurrencyFactor: 0.5,
  criticalConcurrencyFactor: 0.25,
  baseConcurrency: { interactive: 4, background: 4, maintenance: 4 },
  ...overrides,
});

function harness(overrides: Partial<RuntimePressurePolicy> = {}) {
  let now = 0;
  const controller = new RuntimeBackpressureController({ policy: policy(overrides), now: () => now });
  return { controller, setNow: (value: number) => { now = value; } };
}

const request = (id: string, lane: 'interactive' | 'background' | 'maintenance' = 'interactive', scope = 'map') => ({ id, lane, scope });

describe('RuntimeBackpressureController', () => {
  it('admits work under normal pressure and freezes permits', () => {
    const { controller } = harness();
    const result = controller.admit(request('Search:1'));
    expect(result.decision).toBe('admit');
    expect(result.permit).toEqual({ id: 'search:1', scope: 'map', lane: 'interactive', generation: 1, admittedAt: 0 });
    expect(Object.isFrozen(result.permit)).toBe(true);
  });

  it('normalizes identifiers without retaining caller objects', () => {
    const { controller } = harness();
    const input = request('  TASK/1  ', 'background', '  VIEW:A  ');
    const result = controller.admit(input);
    expect(result.permit?.id).toBe('task/1');
    expect(result.permit?.scope).toBe('view:a');
    expect(result.permit).not.toBe(input);
  });

  it.each(['', ' ', '<script>', 'bad id', 'ü'])('rejects unsafe request id %j', (id) => {
    const { controller } = harness();
    expect(() => controller.admit(request(id))).toThrow(TypeError);
  });

  it('rejects identifiers beyond the configured bound', () => {
    const { controller } = harness({ maxIdentifierLength: 8 });
    expect(() => controller.admit(request('identifier-too-long'))).toThrow(TypeError);
  });

  it('rejects unsupported runtime lanes at the authority boundary', () => {
    const { controller } = harness();
    expect(() => controller.admit({ id: 'x', scope: 'map', lane: 'urgent' as never })).toThrow(TypeError);
  });

  it('reduces lane concurrency under elevated pressure', () => {
    const { controller } = harness();
    controller.sample({ cpu: 0.7, memory: 0.2, network: 0.1 });
    expect(controller.admit(request('a')).decision).toBe('admit');
    expect(controller.admit(request('b')).decision).toBe('admit');
    expect(controller.admit(request('c')).decision).toBe('defer');
    expect(controller.snapshot().level).toBe('elevated');
  });

  it('reduces lane concurrency under critical pressure', () => {
    const { controller } = harness();
    controller.sample({ cpu: 0.1, memory: 0.91, network: 0.1 });
    expect(controller.admit(request('a')).decision).toBe('admit');
    expect(controller.admit(request('b')).decision).toBe('defer');
    expect(controller.snapshot().level).toBe('critical');
  });

  it('restores capacity when pressure returns to normal', () => {
    const { controller } = harness();
    controller.sample({ cpu: 0.95, memory: 0, network: 0 });
    controller.admit(request('a'));
    controller.admit(request('b'));
    controller.admit(request('c'));
    expect(controller.snapshot().deferred).toBe(2);
    const promoted = controller.sample({ cpu: 0.1, memory: 0.1, network: 0.1 });
    expect(promoted.map((item) => item.id)).toEqual(['b', 'c']);
  });

  it('fails closed on malformed pressure samples', () => {
    const { controller } = harness();
    expect(() => controller.sample({ cpu: Number.NaN, memory: 0, network: 0 })).toThrow(RangeError);
    expect(() => controller.sample({ cpu: -0.1, memory: 0, network: 0 })).toThrow(RangeError);
    expect(() => controller.sample({ cpu: 1.1, memory: 0, network: 0 })).toThrow(RangeError);
  });

  it('rejects duplicate active identifiers', () => {
    const { controller } = harness();
    controller.admit(request('a'));
    expect(controller.admit(request('a'))).toEqual({ decision: 'reject', reason: 'duplicate' });
  });

  it('rejects duplicate deferred identifiers', () => {
    const { controller } = harness({ baseConcurrency: { interactive: 1, background: 1, maintenance: 1 } });
    controller.admit(request('a'));
    controller.admit(request('b'));
    expect(controller.admit(request('b'))).toEqual({ decision: 'reject', reason: 'duplicate' });
  });

  it('bounds the global deferred queue', () => {
    const { controller } = harness({ maxDeferred: 1, baseConcurrency: { interactive: 1, background: 1, maintenance: 1 } });
    controller.admit(request('a'));
    expect(controller.admit(request('b')).decision).toBe('defer');
    expect(controller.admit(request('c'))).toEqual({ decision: 'reject', reason: 'queue-full' });
  });

  it('bounds deferred work per scope', () => {
    const { controller } = harness({ maxDeferredPerScope: 1, baseConcurrency: { interactive: 1, background: 1, maintenance: 1 } });
    controller.admit(request('a'));
    controller.admit(request('b'));
    expect(controller.admit(request('c'))).toEqual({ decision: 'reject', reason: 'queue-full' });
  });

  it('expires deferred work deterministically', () => {
    const { controller, setNow } = harness({ deferTtlMs: 10, baseConcurrency: { interactive: 1, background: 1, maintenance: 1 } });
    controller.admit(request('a'));
    controller.admit(request('b'));
    setNow(10);
    controller.sweep();
    expect(controller.snapshot().deferred).toBe(0);
  });

  it('promotes interactive work before lower-priority lanes', () => {
    const { controller } = harness({ baseConcurrency: { interactive: 1, background: 1, maintenance: 1 } });
    const interactive = controller.admit(request('i1'));
    controller.admit(request('i2'));
    controller.admit(request('b1', 'background'));
    controller.admit(request('b2', 'background'));
    const promoted = controller.release(interactive.permit!);
    expect(promoted[0]?.id).toBe('i2');
  });

  it('preserves FIFO ordering within a lane', () => {
    const { controller } = harness({ baseConcurrency: { interactive: 1, background: 1, maintenance: 1 } });
    const first = controller.admit(request('a')).permit!;
    controller.admit(request('b'));
    controller.admit(request('c'));
    expect(controller.release(first).map((item) => item.id)).toEqual(['b']);
  });

  it('cancels deferred work and frees queue capacity', () => {
    const { controller } = harness({ maxDeferred: 1, baseConcurrency: { interactive: 1, background: 1, maintenance: 1 } });
    controller.admit(request('a'));
    controller.admit(request('b'));
    expect(controller.cancel('B')).toBe(true);
    expect(controller.admit(request('c')).decision).toBe('defer');
  });

  it('does not cancel active work through deferred cancellation', () => {
    const { controller } = harness();
    controller.admit(request('a'));
    expect(controller.cancel('a')).toBe(false);
    expect(controller.snapshot().active).toBe(1);
  });

  it('rejects forged permits without mutating accounting', () => {
    const { controller } = harness();
    const permit = controller.admit(request('a')).permit!;
    expect(controller.release({ ...permit, generation: 99 })).toEqual([]);
    expect(controller.snapshot().active).toBe(1);
  });

  it('rejects permits with forged scope, lane, or timestamp', () => {
    const { controller } = harness();
    const permit = controller.admit(request('a')).permit!;
    expect(controller.release({ ...permit, scope: 'other' })).toEqual([]);
    expect(controller.release({ ...permit, lane: 'background' })).toEqual([]);
    expect(controller.release({ ...permit, admittedAt: 99 })).toEqual([]);
    expect(controller.snapshot().active).toBe(1);
  });

  it('makes duplicate release idempotent', () => {
    const { controller } = harness();
    const permit = controller.admit(request('a')).permit!;
    controller.release(permit);
    expect(controller.release(permit)).toEqual([]);
  });

  it('invalidates permits across scope reset generations', () => {
    const { controller } = harness();
    const permit = controller.admit(request('a')).permit!;
    expect(controller.resetScope('map')).toBe(true);
    expect(controller.release(permit)).toEqual([]);
    expect(controller.snapshot().generation).toBe(2);
  });

  it('removes active and deferred accounting during scope reset', () => {
    const { controller } = harness({ baseConcurrency: { interactive: 1, background: 1, maintenance: 1 } });
    controller.admit(request('a'));
    controller.admit(request('b'));
    controller.resetScope('map');
    expect(controller.snapshot()).toMatchObject({ active: 0, deferred: 0, scopes: 0 });
  });

  it('bounds scope cardinality', () => {
    const { controller } = harness({ maxScopes: 1 });
    controller.admit(request('a', 'interactive', 'one'));
    expect(controller.admit(request('b', 'background', 'two'))).toEqual({ decision: 'reject', reason: 'scope-limit' });
  });

  it('evicts idle scopes after retention expires', () => {
    const { controller, setNow } = harness({ maxScopes: 1, idleScopeTtlMs: 10 });
    const permit = controller.admit(request('a', 'interactive', 'one')).permit!;
    controller.release(permit);
    setNow(10);
    expect(controller.admit(request('b', 'interactive', 'two')).decision).toBe('admit');
  });

  it('never evicts scopes containing active work', () => {
    const { controller, setNow } = harness({ maxScopes: 1, idleScopeTtlMs: 10 });
    controller.admit(request('a', 'interactive', 'one'));
    setNow(20);
    expect(controller.admit(request('b', 'interactive', 'two'))).toEqual({ decision: 'reject', reason: 'scope-limit' });
  });

  it('never evicts scopes containing deferred work', () => {
    const { controller, setNow } = harness({ maxScopes: 1, idleScopeTtlMs: 10, deferTtlMs: 100, baseConcurrency: { interactive: 1, background: 1, maintenance: 1 } });
    controller.admit(request('a', 'interactive', 'one'));
    controller.admit(request('b', 'interactive', 'one'));
    setNow(20);
    expect(controller.admit(request('c', 'background', 'two'))).toEqual({ decision: 'reject', reason: 'scope-limit' });
  });

  it('returns aggregate-only frozen snapshots', () => {
    const { controller } = harness();
    controller.admit(request('secret-like-id'));
    const snapshot = controller.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.activeByLane)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('secret-like-id');
  });

  it('clears all retained identifiers on disposal', () => {
    const { controller } = harness({ baseConcurrency: { interactive: 1, background: 1, maintenance: 1 } });
    controller.admit(request('a'));
    controller.admit(request('b'));
    controller.dispose();
    expect(controller.snapshot()).toMatchObject({ active: 0, deferred: 0, scopes: 0, disposed: true });
  });

  it('rejects new work after disposal', () => {
    const { controller } = harness();
    controller.dispose();
    expect(controller.admit(request('a'))).toEqual({ decision: 'reject', reason: 'disposed' });
  });

  it('makes disposal idempotent', () => {
    const { controller } = harness();
    controller.dispose();
    controller.dispose();
    expect(controller.snapshot().generation).toBe(2);
  });

  it('does not promote work after disposal', () => {
    const { controller } = harness();
    controller.dispose();
    expect(controller.sweep()).toEqual([]);
  });

  it('rejects pressure sampling after disposal', () => {
    const { controller } = harness();
    controller.dispose();
    expect(() => controller.sample({ cpu: 0, memory: 0, network: 0 })).toThrow(/disposed/);
  });

  it('fails closed when the runtime clock is NaN', () => {
    const controller = new RuntimeBackpressureController({ policy: policy(), now: () => Number.NaN });
    expect(() => controller.admit(request('a'))).toThrow(RangeError);
  });

  it('fails closed when the runtime clock is negative', () => {
    const controller = new RuntimeBackpressureController({ policy: policy(), now: () => -1 });
    expect(() => controller.admit(request('a'))).toThrow(RangeError);
  });

  it.each([
    ['maxScopes', { maxScopes: 0 }],
    ['maxDeferred', { maxDeferred: -1 }],
    ['deferTtlMs', { deferTtlMs: 0 }],
    ['idleScopeTtlMs', { idleScopeTtlMs: 0 }],
    ['elevatedConcurrencyFactor', { elevatedConcurrencyFactor: 0 }],
    ['criticalConcurrencyFactor', { criticalConcurrencyFactor: 2 }],
  ] as const)('rejects invalid %s policy values', (_name, overrides) => {
    expect(() => new RuntimeBackpressureController({ policy: policy(overrides) })).toThrow();
  });

  it('tracks independent lane accounting', () => {
    const { controller } = harness();
    controller.admit(request('i', 'interactive'));
    controller.admit(request('b', 'background'));
    controller.admit(request('m', 'maintenance'));
    expect(controller.snapshot().activeByLane).toEqual({ interactive: 1, background: 1, maintenance: 1 });
  });

  it('tracks independent deferred lane accounting', () => {
    const { controller } = harness({ baseConcurrency: { interactive: 1, background: 1, maintenance: 1 } });
    controller.admit(request('i1', 'interactive')); controller.admit(request('i2', 'interactive'));
    controller.admit(request('b1', 'background')); controller.admit(request('b2', 'background'));
    controller.admit(request('m1', 'maintenance')); controller.admit(request('m2', 'maintenance'));
    expect(controller.snapshot().deferredByLane).toEqual({ interactive: 1, background: 1, maintenance: 1 });
  });

  it('allows separator-safe platform identifiers', () => {
    const { controller } = harness();
    expect(controller.admit(request('layer:3d/tile_1.v2')).decision).toBe('admit');
  });
});
