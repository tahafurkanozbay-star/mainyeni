import type { StoreRuntimeSnapshot } from './contracts';

export type StoreReadinessStatus =
  | 'uninitialized'
  | 'ready'
  | 'degraded'
  | 'blocked'
  | 'disposed';

export interface StoreReadinessReason {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly detail: string;
}

export interface StoreReadinessAssessment {
  readonly status: StoreReadinessStatus;
  readonly ready: boolean;
  readonly reasons: readonly StoreReadinessReason[];
}

const reason = (
  code: string,
  severity: StoreReadinessReason['severity'],
  detail: string,
): StoreReadinessReason => Object.freeze({ code, severity, detail });

export const evaluateStoreReadiness = (
  snapshot: StoreRuntimeSnapshot,
): StoreReadinessAssessment => {
  const health = snapshot.health;
  const reasons: StoreReadinessReason[] = [];

  if (!health.initialized) {
    reasons.push(reason('store-uninitialized', 'info', 'Store runtime has not observed initial state yet.'));
    return Object.freeze({
      status: 'uninitialized',
      ready: false,
      reasons: Object.freeze(reasons),
    });
  }

  if (health.disposed) {
    reasons.push(reason('store-disposed', 'info', 'Store runtime is disposed.'));
    return Object.freeze({
      status: 'disposed',
      ready: false,
      reasons: Object.freeze(reasons),
    });
  }

  if (health.invariantErrors > 0) {
    reasons.push(reason(
      'store-invariant-errors',
      'error',
      'Store state contains ' + health.invariantErrors + ' invariant error(s).',
    ));
  }
  if (health.invariantWarnings > 0) {
    reasons.push(reason(
      'store-invariant-warnings',
      'warning',
      'Store state contains ' + health.invariantWarnings + ' invariant warning(s).',
    ));
  }
  if (health.failedTransitions > 0) {
    reasons.push(reason(
      'store-transition-failures',
      'warning',
      'Store runtime observed ' + health.failedTransitions + ' reducer/dispatch failure(s).',
    ));
  }
  if (health.subscriberErrors > 0) {
    reasons.push(reason(
      'store-subscriber-errors',
      'warning',
      'Store selector subscribers raised ' + health.subscriberErrors + ' isolated error(s).',
    ));
  }

  const status: StoreReadinessStatus = reasons.some((item) => item.severity === 'error')
    ? 'blocked'
    : reasons.some((item) => item.severity === 'warning')
      ? 'degraded'
      : 'ready';

  return Object.freeze({
    status,
    ready: status === 'ready',
    reasons: Object.freeze(reasons),
  });
};
