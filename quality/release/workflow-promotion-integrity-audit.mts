import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  firstWorkflowField,
  jobHasSecrets,
  jobHasWriteAuthority,
  jobUsesProtectedEnvironment,
  workflowFiles,
  workflowJobBlocks,
  workflowTriggerProfile,
  type WorkflowJobBlock,
} from './workflow-structure.mts';
import {
  firstWorkflowStepField,
  stepDisplayName,
  stepRunText,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export interface WorkflowPromotionSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly line: number;
  readonly privileged: boolean;
  readonly promotionLike: boolean;
  readonly jobSuccessGuard: boolean;
  readonly stepSuccessGuard: boolean;
  readonly effectiveSuccessGuard: boolean;
  readonly jobFailureOverride: boolean;
  readonly stepFailureOverride: boolean;
}

export interface WorkflowPromotionIntegritySummary {
  readonly workflowFiles: number;
  readonly workflowRunJobs: number;
  readonly privilegedWorkflowRunJobs: number;
  readonly promotionSteps: number;
  readonly guardedPromotionSteps: number;
  readonly unguardedPromotionSteps: number;
  readonly signals: readonly WorkflowPromotionSignal[];
  readonly findings: readonly Finding[];
}

const SUCCESS_GUARD = /github\.event\.workflow_run\.conclusion\s*==\s*['"]success['"]|['"]success['"]\s*==\s*github\.event\.workflow_run\.conclusion/i;
const FAILURE_OVERRIDE = /\b(?:always|failure)\s*\(\s*\)|!\s*cancelled\s*\(\s*\)|\bcancelled\s*\(\s*\)\s*==\s*false/i;
const PROMOTION_WORD = /(?:^|[^a-z0-9])(?:deploy|deployment|publish|publication|release|promote|promotion|sign|signature|attest|attestation|provenance|push|upload|package|packages|registry|pages)(?:[^a-z0-9]|$)/i;
const PROMOTION_COMMAND = /\b(?:npm\s+publish|pnpm\s+publish|yarn\s+npm\s+publish|dotnet\s+nuget\s+push|nuget\s+push|docker\s+push|podman\s+push|gh\s+release\s+(?:create|upload)|gh\s+api\b[^\n]*(?:releases|deployments|packages)|kubectl\s+(?:apply|set\s+image)|helm\s+(?:upgrade|install)|terraform\s+apply|az\s+(?:webapp|containerapp|deployment)|aws\s+(?:deploy|s3\s+sync|ecr)|gcloud\s+(?:run\s+deploy|app\s+deploy)|cosign\s+sign|gh\s+attestation)/i;
const PROMOTION_ACTION = /^(?:actions\/upload-pages-artifact|actions\/deploy-pages|softprops\/action-gh-release|docker\/build-push-action|sigstore\/cosign-installer|actions\/attest-build-provenance)@/i;

function privileged(block: WorkflowJobBlock): boolean {
  return jobHasWriteAuthority(block) || jobHasSecrets(block) || jobUsesProtectedEnvironment(block);
}

function condition(field: ReturnType<typeof firstWorkflowField>): string {
  return field?.value ?? '';
}

function successGuard(value: string): boolean {
  return SUCCESS_GUARD.test(value);
}

function failureOverride(value: string): boolean {
  return FAILURE_OVERRIDE.test(value);
}

function promotionLike(step: WorkflowStepBlock): boolean {
  const name = stepDisplayName(step);
  const run = stepRunText(step);
  const uses = firstWorkflowStepField(step, 'uses')?.value ?? '';
  return PROMOTION_WORD.test(name)
    || PROMOTION_COMMAND.test(run)
    || PROMOTION_ACTION.test(uses);
}

function signalFor(block: WorkflowJobBlock, step: WorkflowStepBlock): WorkflowPromotionSignal {
  const jobIf = condition(firstWorkflowField(block, 'if'));
  const stepIf = firstWorkflowStepField(step, 'if')?.value ?? '';
  const jobSuccessGuard = successGuard(jobIf);
  const stepSuccessGuard = successGuard(stepIf);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    line: firstWorkflowStepField(step, 'if')?.line ?? step.startLine,
    privileged: privileged(block),
    promotionLike: promotionLike(step),
    jobSuccessGuard,
    stepSuccessGuard,
    effectiveSuccessGuard: jobSuccessGuard || stepSuccessGuard,
    jobFailureOverride: failureOverride(jobIf),
    stepFailureOverride: failureOverride(stepIf),
  };
}

function location(item: WorkflowPromotionSignal) {
  return { file: item.file, line: item.line };
}

function finding(
  item: WorkflowPromotionSignal,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  blocking = false,
): Finding {
  return {
    id,
    domain: 'release',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: location(item),
    evidence: {
      metadata: {
        job: item.job,
        step: item.step,
        promotionLike: item.promotionLike,
        privileged: item.privileged,
        jobSuccessGuard: item.jobSuccessGuard,
        stepSuccessGuard: item.stepSuccessGuard,
        jobFailureOverride: item.jobFailureOverride,
        stepFailureOverride: item.stepFailureOverride,
      },
    },
    remediation,
    tags: ['ci', 'workflow-run', 'promotion', 'release-gate', 'fail-closed'],
  };
}

function findingsFor(item: WorkflowPromotionSignal): Finding[] {
  if (!item.privileged) return [];
  const findings: Finding[] = [];

  if (item.promotionLike && !item.effectiveSuccessGuard) {
    findings.push(finding(
      item,
      'ci-workflow-run-promotion-without-success-guard',
      'critical',
      'Privileged workflow_run promotion lacks an upstream success guard',
      `Step ${item.step} in job ${item.job} can publish, deploy, sign, attest, upload or otherwise promote after a workflow_run event without requiring github.event.workflow_run.conclusion == 'success'. Failed or cancelled upstream validation can therefore reach release authority.`,
      "Gate promotion on github.event.workflow_run.conclusion == 'success' at job or promotion-step scope. Keep repository/ref provenance guards in addition to the success check.",
      true,
    ));
  }

  if (item.promotionLike && (item.jobFailureOverride || item.stepFailureOverride)) {
    findings.push(finding(
      item,
      'ci-workflow-run-promotion-failure-override',
      'critical',
      'Privileged workflow_run promotion uses failure-override semantics',
      `Step ${item.step} in job ${item.job} is promotion-like but is governed by always()/failure()/cancellation-override semantics. Cleanup-style conditions must not authorize publication or deployment.`,
      'Use failure overrides only for cleanup/diagnostics. Require an explicit workflow_run success conclusion and trusted provenance before any release mutation.',
      true,
    ));
  }

  return findings;
}

function jobReviewFinding(block: WorkflowJobBlock, signals: readonly WorkflowPromotionSignal[]): Finding[] {
  if (!privileged(block) || signals.some(item => item.promotionLike)) return [];
  const jobIf = condition(firstWorkflowField(block, 'if'));
  if (successGuard(jobIf)) return [];
  const executable = signals.length > 0;
  if (!executable) return [];
  return [{
    id: 'ci-workflow-run-privileged-job-success-guard-review',
    domain: 'release',
    severity: 'high',
    title: 'Privileged workflow_run job does not require upstream success',
    message: `Job ${block.name} executes after workflow_run with write authority, secrets or a protected environment but has no explicit successful-upstream conclusion guard. Even if current steps are not recognized as promotion commands, future mutations can silently inherit this unsafe default.`,
    location: { file: block.file.repositoryPath, line: block.startLine },
    evidence: { metadata: { job: block.name, executableSteps: signals.length } },
    remediation: "Add a job-level if condition requiring github.event.workflow_run.conclusion == 'success' before privileged execution, while retaining repository/ref provenance checks.",
    tags: ['ci', 'workflow-run', 'privilege', 'release-gate', 'fail-closed'],
  }];
}

export function auditWorkflowPromotionIntegrity(
  inventory: RepositoryInventory,
): AuditSection<WorkflowPromotionIntegritySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const workflowRunJobs = files.flatMap(file => {
    if (!workflowTriggerProfile(file).workflowRun) return [];
    return workflowJobBlocks(file);
  });

  const signals = workflowRunJobs.flatMap(block => workflowStepBlocks(block).map(step => signalFor(block, step)));
  const findings = stableSortFindings([
    ...signals.flatMap(findingsFor),
    ...workflowRunJobs.flatMap(block => {
      const jobSignals = signals.filter(item => item.file === block.file.repositoryPath && item.job === block.name);
      return jobReviewFinding(block, jobSignals);
    }),
  ]);

  const promotionSteps = signals.filter(item => item.promotionLike && item.privileged);
  return {
    domain: 'release',
    title: 'workflow_run release-promotion integrity audit',
    summary: {
      workflowFiles: files.length,
      workflowRunJobs: workflowRunJobs.length,
      privilegedWorkflowRunJobs: workflowRunJobs.filter(privileged).length,
      promotionSteps: promotionSteps.length,
      guardedPromotionSteps: promotionSteps.filter(item => item.effectiveSuccessGuard).length,
      unguardedPromotionSteps: promotionSteps.filter(item => !item.effectiveSuccessGuard).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
