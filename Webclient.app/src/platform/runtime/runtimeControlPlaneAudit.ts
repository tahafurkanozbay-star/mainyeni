import type { RuntimeControlPlaneSnapshot } from './runtimeControlPlane';

export type RuntimeControlPlaneAuditSeverity = 'info' | 'warning' | 'error';

export interface RuntimeControlPlaneAuditOptions {
  readonly maxFindings?: number;
  readonly minimumHealthyScore?: number;
  readonly maxQueuedRequests?: number;
  readonly maxOwnershipFailures?: number;
  readonly maxRecoveryFailures?: number;
}

export interface RuntimeControlPlaneAuditFinding {
  readonly severity: RuntimeControlPlaneAuditSeverity;
  readonly code: string;
  readonly message: string;
  readonly componentId: string | null;
}

export interface RuntimeControlPlaneAuditReport {
  readonly generatedAt: number;
  readonly passed: boolean;
  readonly errors: number;
  readonly warnings: number;
  readonly findings: readonly RuntimeControlPlaneAuditFinding[];
}

const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
};

const boundedNumber = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, numeric));
};

const severityRank: Readonly<Record<RuntimeControlPlaneAuditSeverity, number>> = Object.freeze({
  error: 0,
  warning: 1,
  info: 2,
});

const findingComparator = (
  left: RuntimeControlPlaneAuditFinding,
  right: RuntimeControlPlaneAuditFinding,
): number => severityRank[left.severity] - severityRank[right.severity]
  || left.code.localeCompare(right.code)
  || (left.componentId ?? '').localeCompare(right.componentId ?? '');

export const auditRuntimeControlPlaneSnapshot = (
  snapshot: RuntimeControlPlaneSnapshot,
  options: RuntimeControlPlaneAuditOptions = {},
): RuntimeControlPlaneAuditReport => {
  const maxFindings = boundedInteger(options.maxFindings, 64, 1, 1024);
  const minimumHealthyScore = boundedNumber(options.minimumHealthyScore, 70, 0, 100);
  const maxQueuedRequests = boundedInteger(options.maxQueuedRequests, 128, 0, 100_000);
  const maxOwnershipFailures = boundedInteger(options.maxOwnershipFailures, 0, 0, 1024);
  const maxRecoveryFailures = boundedInteger(options.maxRecoveryFailures, 3, 0, 1024);
  const findings: RuntimeControlPlaneAuditFinding[] = [];

  const push = (
    severity: RuntimeControlPlaneAuditSeverity,
    code: string,
    message: string,
    componentId: string | null = null,
  ): void => {
    if (findings.length >= maxFindings) return;
    findings.push(Object.freeze({ severity, code, message: message.slice(0, 1000), componentId }));
  };

  if (snapshot.phase === 'running' && snapshot.readiness.status !== 'ready') {
    push('error', 'phase-readiness-mismatch', `Control plane is running while readiness is ${snapshot.readiness.status}.`);
  }
  if (snapshot.phase === 'degraded' && snapshot.readiness.status === 'ready') {
    push('warning', 'degraded-phase-with-ready-report', 'Control plane remains degraded although readiness is ready.');
  }
  if ((snapshot.phase === 'running' || snapshot.phase === 'degraded') && !snapshot.supervisor.started) {
    push('error', 'supervisor-not-started', `Control plane phase ${snapshot.phase} requires a started supervisor.`);
  }
  if ((snapshot.phase === 'idle' || snapshot.phase === 'stopped') && snapshot.supervisor.started) {
    push('error', 'supervisor-started-outside-runtime', `Supervisor is started while control plane phase is ${snapshot.phase}.`);
  }

  if (snapshot.barrier.status !== snapshot.readiness.status) {
    push(
      'warning',
      'barrier-readiness-drift',
      `Readiness barrier reports ${snapshot.barrier.status} while supervisor readiness is ${snapshot.readiness.status}.`,
    );
  }
  if (snapshot.barrier.waiting > 0 && snapshot.readiness.status === 'ready' && snapshot.barrier.readyStreak > 0) {
    push('info', 'pending-stability-waiters', `${snapshot.barrier.waiting} readiness waiters still require additional stable samples.`);
  }

  if (snapshot.health.assessment.state === 'healthy' && snapshot.health.assessment.score < minimumHealthyScore) {
    push(
      'warning',
      'healthy-score-below-floor',
      `Health state is healthy but score ${snapshot.health.assessment.score} is below ${minimumHealthyScore}.`,
      snapshot.health.componentId,
    );
  }
  if (
    (snapshot.health.assessment.state === 'unhealthy' || snapshot.health.assessment.state === 'critical')
    && snapshot.readiness.status === 'ready'
  ) {
    push(
      'error',
      'unhealthy-control-plane-ready',
      `Runtime health is ${snapshot.health.assessment.state} while readiness remains ready.`,
      snapshot.health.componentId,
    );
  }
  if (snapshot.health.summary.retained < 0 || snapshot.health.summary.failures < 0) {
    push('error', 'invalid-health-counters', 'Health journal exposed negative counters.', snapshot.health.componentId);
  }
  if (snapshot.health.summary.failures > snapshot.health.summary.total) {
    push('warning', 'failure-window-exceeds-total', 'Failure window count exceeds total retained journal count.', snapshot.health.componentId);
  }

  if (snapshot.supervisor.requests.active < 0 || snapshot.supervisor.requests.queued < 0) {
    push('error', 'invalid-request-counters', 'Request coordinator exposed negative active or queued counters.');
  }
  if (snapshot.supervisor.requests.queued > maxQueuedRequests) {
    push(
      'warning',
      'request-queue-pressure',
      `Queued request count ${snapshot.supervisor.requests.queued} exceeds audit budget ${maxQueuedRequests}.`,
    );
  }

  if (snapshot.ownership.resourceCount !== snapshot.ownership.resources.length) {
    push(
      'error',
      'ownership-count-mismatch',
      `Ownership resourceCount ${snapshot.ownership.resourceCount} differs from listed ${snapshot.ownership.resources.length}.`,
    );
  }
  if (snapshot.ownership.failures.length > maxOwnershipFailures) {
    push(
      maxOwnershipFailures === 0 ? 'error' : 'warning',
      'ownership-disposal-failures',
      `${snapshot.ownership.failures.length} owned resources reported disposal failures.`,
    );
  }

  const inFlightRecoveries = snapshot.recovery.components.filter((component) => component.inFlight);
  if (inFlightRecoveries.length > 0) {
    push('info', 'recovery-in-flight', `${inFlightRecoveries.length} component recoveries are currently in flight.`);
  }
  const recoveryFailures = snapshot.recovery.history.filter((event) => event.outcome === 'failed');
  if (recoveryFailures.length > maxRecoveryFailures) {
    push(
      'warning',
      'recovery-failure-budget',
      `${recoveryFailures.length} recovery failures exceed audit budget ${maxRecoveryFailures}.`,
    );
  }
  const blockedRecoveries = snapshot.recovery.history.filter((event) => event.outcome === 'blocked');
  for (const blocked of blockedRecoveries.slice(-Math.min(8, blockedRecoveries.length))) {
    push(
      'warning',
      'recovery-budget-blocked',
      `Recovery was blocked by budget: ${blocked.reason}.`,
      blocked.componentId,
    );
  }

  for (const componentId of snapshot.readiness.unhealthy) {
    push('error', 'required-component-unhealthy', 'Required runtime component is unhealthy.', componentId);
  }
  for (const componentId of snapshot.readiness.unknown) {
    push('error', 'required-component-unknown', 'Required runtime component health is unknown.', componentId);
  }
  for (const componentId of snapshot.readiness.stale) {
    push('warning', 'required-component-stale', 'Required runtime component health is stale.', componentId);
  }

  findings.sort(findingComparator);
  const errors = findings.filter((finding) => finding.severity === 'error').length;
  const warnings = findings.filter((finding) => finding.severity === 'warning').length;
  return Object.freeze({
    generatedAt: snapshot.generatedAt,
    passed: errors === 0,
    errors,
    warnings,
    findings: Object.freeze(findings),
  });
};

export class RuntimeControlPlaneAuditError extends Error {
  readonly code = 'RUNTIME_CONTROL_PLANE_AUDIT_FAILED';
  readonly report: RuntimeControlPlaneAuditReport;

  constructor(report: RuntimeControlPlaneAuditReport) {
    super(`Runtime control-plane audit failed with ${report.errors} errors and ${report.warnings} warnings.`);
    this.name = 'RuntimeControlPlaneAuditError';
    this.report = report;
  }
}

export const assertRuntimeControlPlaneHealthy = (
  snapshot: RuntimeControlPlaneSnapshot,
  options: RuntimeControlPlaneAuditOptions = {},
): RuntimeControlPlaneAuditReport => {
  const report = auditRuntimeControlPlaneSnapshot(snapshot, options);
  if (!report.passed) throw new RuntimeControlPlaneAuditError(report);
  return report;
};
