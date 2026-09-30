import { stableSortFindings, type AuditSection, type Finding, type RepositoryInventory } from './contracts.mts';
import { firstWorkflowField, jobHasSecrets, jobHasWriteAuthority, jobUsesProtectedEnvironment, workflowFiles, workflowJobBlocks, workflowTriggerProfile, type WorkflowJobBlock } from './workflow-structure.mts';
import { firstWorkflowStepField, stepDisplayName, stepRunText, stepUsesIdentity, workflowStepBlocks, type WorkflowStepBlock } from './workflow-step-structure.mts';

export interface WorkflowRunSourceSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly line: number;
  readonly privileged: boolean;
  readonly promotionLike: boolean;
  readonly repositoryGuard: boolean;
  readonly branchGuard: boolean;
  readonly shaGuard: boolean;
  readonly successGuard: boolean;
  readonly forkRejectionGuard: boolean;
}

export interface WorkflowRunSourceProvenanceSummary {
  readonly workflowFiles: number;
  readonly workflowRunJobs: number;
  readonly privilegedWorkflowRunJobs: number;
  readonly promotionSteps: number;
  readonly repositoryBoundPromotions: number;
  readonly refBoundPromotions: number;
  readonly signals: readonly WorkflowRunSourceSignal[];
  readonly findings: readonly Finding[];
}

const REPOSITORY_GUARD = /github\.event\.workflow_run\.head_repository\.full_name\s*==\s*(?:github\.repository|['"][^'"]+\/[^"]+['"])|(?:github\.repository|['"][^'"]+\/[^"]+['"])[\s\S]*?==\s*github\.event\.workflow_run\.head_repository\.full_name/i;
const FORK_REJECTION = /github\.event\.workflow_run\.head_repository\.(?:fork\s*==\s*false|full_name\s*==\s*github\.repository)/i;
const BRANCH_GUARD = /github\.event\.workflow_run\.head_branch\s*==\s*['"][A-Za-z0-9._\/-]+['"]|['"][A-Za-z0-9._\/-]+['"]\s*==\s*github\.event\.workflow_run\.head_branch/i;
const SHA_GUARD = /github\.event\.workflow_run\.head_sha\s*==\s*(?:github\.sha|needs\.[A-Za-z0-9_.-]+\.outputs\.[A-Za-z0-9_.-]+|['"][0-9a-f]{40}['"])/i;
const SUCCESS_GUARD = /github\.event\.workflow_run\.conclusion\s*==\s*['"]success['"]|['"]success['"]\s*==\s*github\.event\.workflow_run\.conclusion/i;
const PROMOTION_COMMAND = /\b(?:npm\s+publish|pnpm\s+publish|yarn\s+npm\s+publish|dotnet\s+nuget\s+push|nuget\s+push|docker\s+push|podman\s+push|gh\s+release\s+(?:create|upload)|kubectl\s+(?:apply|set\s+image)|helm\s+(?:upgrade|install)|terraform\s+apply|cosign\s+sign|gh\s+attestation|aws\s+(?:deploy|s3\s+sync|ecr)|gcloud\s+(?:run\s+deploy|app\s+deploy)|az\s+(?:webapp|containerapp|deployment))\b/i;
const PROMOTION_ACTION = /^(?:actions\/deploy-pages|softprops\/action-gh-release|docker\/build-push-action|actions\/attest-build-provenance)@/i;
const PROMOTION_NAME = /(?:^|[^a-z0-9])(?:deploy|publish|release|promote|sign|attest|push|upload)(?:[^a-z0-9]|$)/i;

function privileged(block: WorkflowJobBlock): boolean {
  return jobHasWriteAuthority(block) || jobHasSecrets(block) || jobUsesProtectedEnvironment(block);
}

function promotion(step: WorkflowStepBlock): boolean {
  return PROMOTION_NAME.test(stepDisplayName(step)) || PROMOTION_COMMAND.test(stepRunText(step)) || PROMOTION_ACTION.test(stepUsesIdentity(step)?.raw ?? '');
}

function guardText(block: WorkflowJobBlock, step: WorkflowStepBlock): string {
  return `${firstWorkflowField(block, 'if')?.value ?? ''}\n${firstWorkflowStepField(step, 'if')?.value ?? ''}`;
}

function signalFor(block: WorkflowJobBlock, step: WorkflowStepBlock): WorkflowRunSourceSignal {
  const guards = guardText(block, step);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    line: firstWorkflowStepField(step, 'if')?.line ?? firstWorkflowField(block, 'if')?.line ?? step.startLine,
    privileged: privileged(block),
    promotionLike: promotion(step),
    repositoryGuard: REPOSITORY_GUARD.test(guards),
    branchGuard: BRANCH_GUARD.test(guards),
    shaGuard: SHA_GUARD.test(guards),
    successGuard: SUCCESS_GUARD.test(guards),
    forkRejectionGuard: FORK_REJECTION.test(guards),
  };
}

function finding(signal: WorkflowRunSourceSignal, id: string, title: string, message: string, remediation: string): Finding {
  return {
    id,
    domain: 'security',
    severity: 'critical',
    blocking: true,
    title,
    message,
    location: { file: signal.file, line: signal.line },
    evidence: { metadata: { job: signal.job, step: signal.step, repositoryGuard: signal.repositoryGuard, branchGuard: signal.branchGuard, shaGuard: signal.shaGuard, successGuard: signal.successGuard } },
    remediation,
    tags: ['ci', 'workflow-run', 'provenance', 'promotion', 'supply-chain', 'fail-closed'],
  };
}

function findingsFor(signal: WorkflowRunSourceSignal): Finding[] {
  if (!signal.privileged || !signal.promotionLike) return [];
  const findings: Finding[] = [];
  if (!signal.repositoryGuard) findings.push(finding(signal, 'ci-workflow-run-promotion-unbound-repository', 'Privileged workflow_run promotion is not bound to the producer repository', `Step ${signal.step} can promote output from a workflow_run without proving that head_repository.full_name is the reviewed repository. A successful run from an unexpected fork/repository must not inherit release authority.`, 'Require github.event.workflow_run.head_repository.full_name == github.repository before any privileged promotion.'));
  if (!signal.forkRejectionGuard) findings.push(finding(signal, 'ci-workflow-run-promotion-fork-not-rejected', 'Privileged workflow_run promotion does not explicitly reject fork provenance', `Step ${signal.step} lacks a fail-closed fork/repository provenance condition before release mutation.`, 'Reject fork provenance explicitly, preferably by requiring head_repository.full_name == github.repository.'));
  if (!signal.branchGuard && !signal.shaGuard) findings.push(finding(signal, 'ci-workflow-run-promotion-unbound-ref', 'Privileged workflow_run promotion is not bound to an approved producer ref', `Step ${signal.step} checks neither a literal workflow_run.head_branch nor a trusted workflow_run.head_sha before promotion. Workflow name and successful conclusion alone do not authorize a source ref.`, 'Bind promotion to an allowlisted literal head_branch or to a trusted expected head_sha derived from immutable release metadata.'));
  return findings;
}

export function auditWorkflowRunSourceProvenance(inventory: RepositoryInventory): AuditSection<WorkflowRunSourceProvenanceSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowTriggerProfile(file).workflowRun ? workflowJobBlocks(file) : []);
  const signals = jobs.flatMap(block => workflowStepBlocks(block).map(step => signalFor(block, step)));
  const promotions = signals.filter(signal => signal.privileged && signal.promotionLike);
  const findings = stableSortFindings(promotions.flatMap(findingsFor));
  return {
    domain: 'security',
    title: 'workflow_run producer repository and ref provenance audit',
    summary: {
      workflowFiles: files.length,
      workflowRunJobs: jobs.length,
      privilegedWorkflowRunJobs: jobs.filter(privileged).length,
      promotionSteps: promotions.length,
      repositoryBoundPromotions: promotions.filter(signal => signal.repositoryGuard).length,
      refBoundPromotions: promotions.filter(signal => signal.branchGuard || signal.shaGuard).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
