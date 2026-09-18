import { describe, expect, it } from 'vitest';
import type {
  GuardrailCounters,
  GuardrailJournalSnapshot,
} from './contracts';
import {
  evaluateGuardrailReadiness,
  normalizeGuardrailReadinessPolicy,
} from './readiness';

const counters = (
  overrides: Partial<GuardrailCounters> = {},
): GuardrailCounters => ({
  allowed: 100,
  normalized: 0,
  denied: 0,
  info: 100,
  warning: 0,
  error: 0,
  critical: 0,
  droppedEvents: 0,
  duplicateEvents: 0,
  ...overrides,
});

const snapshot = (
  overrides: Partial<GuardrailCounters> = {},
): GuardrailJournalSnapshot => ({
  capacity: 512,
  retained: 100,
  firstEventAt: 1,
  lastEventAt: 100,
  counters: counters(overrides),
  events: [],
});

describe('guardrail readiness', () => {
  it('reports ready for a clean bounded journal', () => {
    const report = evaluateGuardrailReadiness(snapshot(), {}, () => 200);
    expect(report).toMatchObject({
      state: 'ready',
      score: 100,
      evaluatedAt: 200,
    });
    expect(report.reasons).toHaveLength(0);
  });

  it('blocks when critical events exceed the threshold', () => {
    const report = evaluateGuardrailReadiness(snapshot({ critical: 1 }));
    expect(report.state).toBe('blocked');
    expect(report.reasons.map((entry) => entry.code)).toContain('critical-event');
    expect(report.score).toBeLessThan(100);
  });

  it('blocks when errors exceed their threshold', () => {
    const report = evaluateGuardrailReadiness(snapshot({ error: 6 }));
    expect(report.state).toBe('blocked');
    expect(report.reasons.map((entry) => entry.code)).toContain('error-threshold');
  });

  it('blocks when denied decisions exceed their threshold', () => {
    const report = evaluateGuardrailReadiness(snapshot({ denied: 26 }));
    expect(report.state).toBe('blocked');
    expect(report.reasons.map((entry) => entry.code)).toContain('deny-threshold');
  });

  it('degrades when only warning volume exceeds its threshold', () => {
    const report = evaluateGuardrailReadiness(snapshot({ warning: 51 }), {
      minimumScore: 0,
    });
    expect(report.state).toBe('degraded');
    expect(report.reasons.map((entry) => entry.code)).toContain('warning-threshold');
  });

  it('blocks when bounded history had to drop events', () => {
    const report = evaluateGuardrailReadiness(snapshot({ droppedEvents: 1 }));
    expect(report.state).toBe('blocked');
    expect(report.reasons.map((entry) => entry.code)).toContain('history-threshold');
  });

  it('degrades for excessive duplicate event volume', () => {
    const report = evaluateGuardrailReadiness(snapshot({ duplicateEvents: 251 }), {
      minimumScore: 0,
    });
    expect(report.state).toBe('degraded');
    expect(report.reasons.map((entry) => entry.code)).toContain('duplicate-threshold');
  });

  it('blocks when the composite readiness score falls below threshold', () => {
    const report = evaluateGuardrailReadiness(
      snapshot({ warning: 20 }),
      {
        maxWarningEvents: 100,
        minimumScore: 100,
      },
    );
    expect(report.state).toBe('blocked');
    expect(report.reasons.map((entry) => entry.code)).toContain('readiness-score');
  });

  it('keeps score in the inclusive zero-to-one-hundred interval', () => {
    const report = evaluateGuardrailReadiness(
      snapshot({
        denied: 1_000,
        warning: 1_000,
        error: 1_000,
        critical: 1_000,
        droppedEvents: 1_000,
        duplicateEvents: 1_000,
      }),
    );
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
  });

  it('normalizes negative policy thresholds', () => {
    const policy = normalizeGuardrailReadinessPolicy({
      maxDeniedEvents: -1,
      maxWarningEvents: -1,
      maxErrorEvents: Number.NaN,
      minimumScore: 101,
    });
    expect(policy.maxDeniedEvents).toBeGreaterThanOrEqual(0);
    expect(policy.maxWarningEvents).toBeGreaterThanOrEqual(0);
    expect(policy.maxErrorEvents).toBeGreaterThanOrEqual(0);
    expect(policy.minimumScore).toBeLessThanOrEqual(100);
  });

  it('supports zero thresholds intentionally', () => {
    const policy = normalizeGuardrailReadinessPolicy({
      maxDeniedEvents: 0,
      maxWarningEvents: 0,
      maxErrorEvents: 0,
      maxCriticalEvents: 0,
      maxDroppedEvents: 0,
      maxDuplicateEvents: 0,
    });
    expect(policy.maxDeniedEvents).toBe(0);
    expect(policy.maxDuplicateEvents).toBe(0);
  });
});
