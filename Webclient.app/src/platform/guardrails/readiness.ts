import type {
  GuardrailJournalSnapshot,
  GuardrailReadinessPolicy,
  GuardrailReadinessReport,
  GuardrailReason,
} from './contracts';

export const DEFAULT_GUARDRAIL_READINESS_POLICY: GuardrailReadinessPolicy = Object.freeze({
  maxDeniedEvents: 25,
  maxWarningEvents: 50,
  maxErrorEvents: 5,
  maxCriticalEvents: 0,
  maxDroppedEvents: 0,
  maxDuplicateEvents: 250,
  minimumScore: 80,
});

const nonNegativeInt = (value: number, fallback: number): number => {
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
};

export const normalizeGuardrailReadinessPolicy = (
  input: Partial<GuardrailReadinessPolicy> = {},
): GuardrailReadinessPolicy => Object.freeze({
  maxDeniedEvents: nonNegativeInt(
    input.maxDeniedEvents ?? DEFAULT_GUARDRAIL_READINESS_POLICY.maxDeniedEvents,
    DEFAULT_GUARDRAIL_READINESS_POLICY.maxDeniedEvents,
  ),
  maxWarningEvents: nonNegativeInt(
    input.maxWarningEvents ?? DEFAULT_GUARDRAIL_READINESS_POLICY.maxWarningEvents,
    DEFAULT_GUARDRAIL_READINESS_POLICY.maxWarningEvents,
  ),
  maxErrorEvents: nonNegativeInt(
    input.maxErrorEvents ?? DEFAULT_GUARDRAIL_READINESS_POLICY.maxErrorEvents,
    DEFAULT_GUARDRAIL_READINESS_POLICY.maxErrorEvents,
  ),
  maxCriticalEvents: nonNegativeInt(
    input.maxCriticalEvents ?? DEFAULT_GUARDRAIL_READINESS_POLICY.maxCriticalEvents,
    DEFAULT_GUARDRAIL_READINESS_POLICY.maxCriticalEvents,
  ),
  maxDroppedEvents: nonNegativeInt(
    input.maxDroppedEvents ?? DEFAULT_GUARDRAIL_READINESS_POLICY.maxDroppedEvents,
    DEFAULT_GUARDRAIL_READINESS_POLICY.maxDroppedEvents,
  ),
  maxDuplicateEvents: nonNegativeInt(
    input.maxDuplicateEvents ?? DEFAULT_GUARDRAIL_READINESS_POLICY.maxDuplicateEvents,
    DEFAULT_GUARDRAIL_READINESS_POLICY.maxDuplicateEvents,
  ),
  minimumScore: Math.max(
    0,
    Math.min(
      100,
      nonNegativeInt(
        input.minimumScore ?? DEFAULT_GUARDRAIL_READINESS_POLICY.minimumScore,
        DEFAULT_GUARDRAIL_READINESS_POLICY.minimumScore,
      ),
    ),
  ),
});

const makeReason = (
  code: string,
  message: string,
  severity: GuardrailReason['severity'],
): GuardrailReason => Object.freeze({ code, message, severity });

const ratioPenalty = (value: number, limit: number, weight: number): number => {
  if (value <= 0) return 0;
  if (limit <= 0) return weight;
  return Math.min(weight, (value / Math.max(1, limit)) * weight);
};

export const evaluateGuardrailReadiness = (
  snapshot: GuardrailJournalSnapshot,
  policyInput: Partial<GuardrailReadinessPolicy> = {},
  now: () => number = Date.now,
): GuardrailReadinessReport => {
  const policy = normalizeGuardrailReadinessPolicy(policyInput);
  const counters = snapshot.counters;
  const reasons: GuardrailReason[] = [];

  if (counters.critical > policy.maxCriticalEvents) {
    reasons.push(makeReason('critical-event', 'Critical event threshold was exceeded.', 'critical'));
  }
  if (counters.error > policy.maxErrorEvents) {
    reasons.push(makeReason('error-threshold', 'Error event threshold was exceeded.', 'error'));
  }
  if (counters.denied > policy.maxDeniedEvents) {
    reasons.push(makeReason('deny-threshold', 'Denied decision threshold was exceeded.', 'error'));
  }
  if (counters.warning > policy.maxWarningEvents) {
    reasons.push(makeReason('warning-threshold', 'Warning event threshold was exceeded.', 'warning'));
  }
  if (counters.droppedEvents > policy.maxDroppedEvents) {
    reasons.push(makeReason('history-threshold', 'Journal history threshold was exceeded.', 'error'));
  }
  if (counters.duplicateEvents > policy.maxDuplicateEvents) {
    reasons.push(makeReason('duplicate-threshold', 'Duplicate event threshold was exceeded.', 'warning'));
  }

  const score = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        100 -
          ratioPenalty(counters.critical, Math.max(1, policy.maxCriticalEvents), 45) -
          ratioPenalty(counters.error, Math.max(1, policy.maxErrorEvents), 25) -
          ratioPenalty(counters.denied, Math.max(1, policy.maxDeniedEvents), 15) -
          ratioPenalty(counters.warning, Math.max(1, policy.maxWarningEvents), 5) -
          ratioPenalty(counters.droppedEvents, Math.max(1, policy.maxDroppedEvents), 20) -
          ratioPenalty(counters.duplicateEvents, Math.max(1, policy.maxDuplicateEvents), 5),
      ),
    ),
  );

  if (score < policy.minimumScore) {
    reasons.push(makeReason('readiness-score', 'Readiness score is below the required threshold.', 'error'));
  }

  const blocked = reasons.some(
    (entry) => entry.severity === 'error' || entry.severity === 'critical',
  );
  const degraded = !blocked && reasons.some((entry) => entry.severity === 'warning');

  return Object.freeze({
    state: blocked ? 'blocked' : degraded ? 'degraded' : 'ready',
    score,
    reasons: Object.freeze(reasons),
    evaluatedAt: now(),
    counters: Object.freeze({ ...counters }),
  });
};
