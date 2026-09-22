import { describe, expect, it } from 'vitest';
import { ResilienceEnvelope } from './resilienceEnvelope';

describe('ResilienceEnvelope', () => {
  it('provides bounded lane defaults with critical capacity reserved above background work', () => {
    const envelope = new ResilienceEnvelope();
    expect(envelope.budget('critical')).toEqual({ maxInFlight: 8, maxQueued: 32, timeoutMs: 15_000, maxAttempts: 3 });
    expect(envelope.budget('interactive').maxInFlight).toBe(6);
    expect(envelope.budget('background').maxInFlight).toBe(3);
  });

  it('normalizes overrides without exposing mutable policy state', () => {
    const envelope = new ResilienceEnvelope({ interactive: { maxInFlight: 20, timeoutMs: 2_000 } });
    const budget = envelope.budget('interactive');
    expect(budget.maxInFlight).toBe(20);
    expect(budget.timeoutMs).toBe(2_000);
    expect(Object.isFrozen(budget)).toBe(true);
    expect(Object.isFrozen(envelope.snapshot())).toBe(true);
  });

  it('caps hostile configuration values and rejects non-finite inputs', () => {
    const envelope = new ResilienceEnvelope({ critical: { maxInFlight: 50_000, maxQueued: 50_000, timeoutMs: 99_000_000, maxAttempts: 999 } });
    expect(envelope.budget('critical')).toEqual({ maxInFlight: 1_000, maxQueued: 10_000, timeoutMs: 600_000, maxAttempts: 10 });
    expect(() => new ResilienceEnvelope({ background: { timeoutMs: Number.NaN } })).toThrow(RangeError);
    expect(() => new ResilienceEnvelope({ background: { maxQueued: Number.POSITIVE_INFINITY } })).toThrow(RangeError);
  });

  it('clamps zero and negative values to safe non-zero minima', () => {
    const envelope = new ResilienceEnvelope({ background: { maxInFlight: 0, maxQueued: -2, timeoutMs: -1, maxAttempts: 0 } });
    expect(envelope.budget('background')).toEqual({ maxInFlight: 1, maxQueued: 1, timeoutMs: 1, maxAttempts: 1 });
  });
});
