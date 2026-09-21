import { describe, expect, test, vi } from 'vitest';
import { createReadinessGate } from './readinessGate';

const gateWithClock = () => {
  let now = 1_000;
  const gate = createReadinessGate({ clock: { now: () => now } });
  return {
    gate,
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
};

describe('ReadinessGate', () => {
  test('starts blocked when required critical evidence is unknown', () => {
    const { gate } = gateWithClock();
    gate.register({ id: 'config', severity: 'critical', required: true });
    expect(gate.snapshot()).toMatchObject({
      state: 'blocked',
      blockers: ['config'],
      unknown: ['config'],
    });
  });

  test('becomes ready after critical pass evidence', () => {
    const { gate } = gateWithClock();
    gate.register({ id: 'config', severity: 'critical', required: true });
    expect(gate.record('config', 'pass').state).toBe('ready');
  });

  test('critical fail blocks readiness', () => {
    const { gate } = gateWithClock();
    gate.register({ id: 'config', severity: 'critical', required: true });
    expect(gate.record('config', 'fail', { code: 'INVALID_CONFIG' })).toMatchObject({
      state: 'blocked',
      blockers: ['config'],
    });
  });

  test('degraded severity does not hard block', () => {
    const { gate } = gateWithClock();
    gate.register({ id: 'config', severity: 'critical', required: true });
    gate.register({ id: 'network', severity: 'degraded', required: true });
    gate.record('config', 'pass');
    expect(gate.record('network', 'fail')).toMatchObject({
      state: 'degraded',
      blockers: [],
      degraded: ['network'],
    });
  });

  test('optional unknown evidence does not affect readiness', () => {
    const { gate } = gateWithClock();
    gate.register({ id: 'config', severity: 'critical', required: true });
    gate.register({ id: 'network', severity: 'degraded', required: false });
    gate.record('config', 'pass');
    expect(gate.snapshot().state).toBe('ready');
  });

  test('TTL expiration converts evidence back to unknown', () => {
    const { gate, advance } = gateWithClock();
    gate.register({
      id: 'network',
      severity: 'critical',
      required: true,
      ttlMs: 1_000,
    });
    gate.record('network', 'pass');
    expect(gate.snapshot().state).toBe('ready');
    advance(1_001);
    expect(gate.snapshot()).toMatchObject({
      state: 'blocked',
      blockers: ['network'],
      unknown: ['network'],
    });
    expect(gate.snapshot().requirements[0]?.stale).toBe(true);
  });

  test('non-expiring evidence remains valid indefinitely', () => {
    const { gate, advance } = gateWithClock();
    gate.register({
      id: 'config',
      severity: 'critical',
      required: true,
    });
    gate.record('config', 'pass');
    advance(100_000_000);
    expect(gate.snapshot().state).toBe('ready');
  });

  test('record uses explicit observation time', () => {
    const { gate, advance } = gateWithClock();
    gate.register({
      id: 'network',
      severity: 'critical',
      required: true,
      ttlMs: 1_000,
    });
    gate.record('network', 'pass', { observedAt: 500 });
    advance(501);
    expect(gate.snapshot().state).toBe('blocked');
  });

  test('detail sanitization removes credential-shaped values', () => {
    const { gate } = gateWithClock();
    gate.register({ id: 'config', severity: 'critical' });
    gate.record('config', 'fail', {
      detail: 'token=secret-token password=hunter2',
    });
    const serialized = JSON.stringify(gate.snapshot());
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).toContain('[redacted]');
  });

  test('detail sanitization removes absolute URLs', () => {
    const { gate } = gateWithClock();
    gate.register({ id: 'network', severity: 'degraded' });
    gate.record('network', 'fail', {
      detail: 'failed https://private.example/api?token=abc',
    });
    expect(JSON.stringify(gate.snapshot())).not.toContain('private.example');
  });

  test('unknown requirement ids fail fast', () => {
    const { gate } = gateWithClock();
    expect(() => gate.record('missing', 'pass')).toThrow(/unknown readiness requirement/i);
  });

  test('invalid status fails fast', () => {
    const { gate } = gateWithClock();
    gate.register({ id: 'config', severity: 'critical' });
    expect(() => gate.record('config', 'broken' as 'pass')).toThrow(/unsupported readiness status/i);
  });

  test('invalid severity fails fast', () => {
    const { gate } = gateWithClock();
    expect(() => gate.register({
      id: 'config',
      severity: 'fatal' as 'critical',
    })).toThrow(/unsupported readiness severity/i);
  });

  test('clearEvidence restores unknown state', () => {
    const { gate } = gateWithClock();
    gate.register({ id: 'config', severity: 'critical', required: true });
    gate.record('config', 'pass');
    expect(gate.clearEvidence('config')).toBe(true);
    expect(gate.snapshot().state).toBe('blocked');
  });

  test('clearEvidence returns false when nothing was recorded', () => {
    const { gate } = gateWithClock();
    gate.register({ id: 'config', severity: 'critical' });
    expect(gate.clearEvidence('config')).toBe(false);
  });

  test('unregister removes requirement and evidence', () => {
    const { gate } = gateWithClock();
    const unregister = gate.register({ id: 'config', severity: 'critical' });
    gate.record('config', 'pass');
    unregister();
    expect(gate.snapshot()).toMatchObject({
      state: 'ready',
      requirements: [],
    });
  });

  test('subscribers receive evidence changes', () => {
    const { gate } = gateWithClock();
    gate.register({ id: 'config', severity: 'critical' });
    const listener = vi.fn();
    gate.subscribe(listener);
    gate.record('config', 'pass');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ state: 'ready' });
  });

  test('emitCurrent immediately sends a snapshot', () => {
    const { gate } = gateWithClock();
    gate.register({ id: 'config', severity: 'critical' });
    const listener = vi.fn();
    gate.subscribe(listener, true);
    expect(listener).toHaveBeenCalledOnce();
  });

  test('unsubscribe stops subsequent notifications', () => {
    const { gate } = gateWithClock();
    gate.register({ id: 'config', severity: 'critical' });
    const listener = vi.fn();
    const unsubscribe = gate.subscribe(listener);
    unsubscribe();
    gate.record('config', 'pass');
    expect(listener).not.toHaveBeenCalled();
  });

  test('listener exceptions are isolated', () => {
    const onListenerError = vi.fn();
    const gate = createReadinessGate({ onListenerError });
    gate.register({ id: 'config', severity: 'critical' });
    gate.subscribe(() => { throw new Error('listener failed'); });
    expect(() => gate.record('config', 'pass')).not.toThrow();
    expect(onListenerError).toHaveBeenCalledOnce();
  });

  test('history records state transitions', () => {
    const { gate } = gateWithClock();
    gate.register({ id: 'config', severity: 'critical' });
    gate.record('config', 'fail', { code: 'BAD' });
    gate.record('config', 'pass', { code: 'GOOD' });
    expect(gate.history()).toEqual([
      expect.objectContaining({ sequence: 1, status: 'fail', state: 'blocked', code: 'BAD' }),
      expect.objectContaining({ sequence: 2, status: 'pass', state: 'ready', code: 'GOOD' }),
    ]);
  });

  test('history capacity is bounded', () => {
    const gate = createReadinessGate({ historyLimit: 2 });
    gate.register({ id: 'config', severity: 'critical' });
    gate.record('config', 'unknown');
    gate.record('config', 'fail');
    gate.record('config', 'pass');
    expect(gate.history()).toHaveLength(2);
    expect(gate.history()[0]?.sequence).toBe(2);
  });

  test('history can be disabled', () => {
    const gate = createReadinessGate({ historyLimit: 0 });
    gate.register({ id: 'config', severity: 'critical' });
    gate.record('config', 'pass');
    expect(gate.history()).toEqual([]);
  });

  test('fingerprint changes when effective readiness changes', () => {
    const { gate } = gateWithClock();
    gate.register({ id: 'config', severity: 'critical' });
    const initial = gate.snapshot().fingerprint;
    gate.record('config', 'pass');
    expect(gate.snapshot().fingerprint).not.toBe(initial);
  });

  test('fingerprint ignores raw detail text', () => {
    const { gate } = gateWithClock();
    gate.register({ id: 'config', severity: 'critical' });
    gate.record('config', 'fail', { code: 'BAD', detail: 'first detail' });
    const first = gate.snapshot().fingerprint;
    gate.record('config', 'fail', { code: 'BAD', detail: 'second detail' });
    expect(gate.snapshot().fingerprint).toBe(first);
  });

  test('requirements are sorted for deterministic support output', () => {
    const { gate } = gateWithClock();
    gate.register({ id: 'zeta', severity: 'degraded', required: false });
    gate.register({ id: 'alpha', severity: 'degraded', required: false });
    expect(gate.snapshot().requirements.map((item) => item.requirement.id))
      .toEqual(['alpha', 'zeta']);
  });

  test('requirement capacity is enforced', () => {
    const gate = createReadinessGate({ maxRequirements: 1 });
    gate.register({ id: 'one', severity: 'critical' });
    expect(() => gate.register({ id: 'two', severity: 'critical' }))
      .toThrow(/capacity/i);
  });

  test('dispose clears and closes the gate', () => {
    const { gate } = gateWithClock();
    gate.register({ id: 'config', severity: 'critical' });
    gate.dispose();
    expect(() => gate.snapshot()).toThrow(/disposed/i);
    expect(() => gate.register({ id: 'next', severity: 'critical' }))
      .toThrow(/disposed/i);
  });
});
