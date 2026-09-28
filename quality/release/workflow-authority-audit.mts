import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  hasUntrustedExpression,
  jobHasSecrets,
  jobHasWriteAuthority,
  jobUsesProtectedEnvironment,
  workflowFiles,
  workflowJobBlocks,
  workflowTriggerProfile,
  type WorkflowJobBlock,
} from './workflow-structure.mts';

export interface WorkflowAuthoritySignal {
  readonly file: string;
  readonly job: string;
  readonly externalContribution: boolean;
  readonly pullRequest: boolean;
  readonly pullRequestTarget: boolean;
  readonly workflowRun: boolean;
  readonly repositoryDispatch: boolean;
  readonly workflowCall: boolean;
  readonly writeAuthority: boolean;
  readonly secrets: boolean;
  readonly protectedEnvironment: boolean;
  readonly checkout: boolean;
  readonly runStep: boolean;
  readonly untrustedExpression: boolean;
  readonly workflowRunHeadCheckout: boolean;
  readonly workflowRunArtifactDownload: boolean;
  readonly workflowRunRepositoryGuard: boolean;
  readonly workflowRunBranchGuard: boolean;
  readonly dispatchPayloadReference: boolean;
}

export interface WorkflowAuthoritySummary {
  readonly workflowFiles: number;
  readonly jobs: number;
  readonly privilegedJobs: number;
  readonly externalPrivilegedJobs: number;
  readonly workflowRunJobs: number;
  readonly repositoryDispatchJobs: number;
  readonly signals: readonly WorkflowAuthoritySignal[];
  readonly findings: readonly Finding[];
}

const CHECKOUT = /^\s*-?\s*uses\s*:\s*actions\/checkout@[^\s#]+/im;
const RUN_STEP = /^\s*-?\s*run\s*:/im;
const WORKFLOW_RUN_HEAD_CHECKOUT = /^\s*ref\s*:\s*\$\{\{\s*github\.event\.workflow_run\.(?:head_sha|head_branch)\s*\}\}/im;
const DOWNLOAD_ARTIFACT = /^\s*-?\s*uses\s*:\s*actions\/download-artifact@[^\s#]+/im;
const WORKFLOW_RUN_ID = /\$\{\{\s*github\.event\.workflow_run\.id\s*\}\}/i;
const GH_RUN_DOWNLOAD = /\bgh\s+run\s+download\b/i;
const WORKFLOW_RUN_REPOSITORY_GUARD = /github\.event\.workflow_run\.head_repository\.(?:full_name|html_url)\s*==\s*github\.repository/i;
const WORKFLOW_RUN_FORK_GUARD = /github\.event\.workflow_run\.head_repository\.fork\s*==\s*false/i;
const WORKFLOW_RUN_BRANCH_GUARD = /github\.event\.workflow_run\.head_branch\s*==\s*['"][A-Za-z0-9._\/-]+['"]/i;
const DISPATCH_PAYLOAD = /github\.event\.client_payload\b/i;
const DISPATCH_EXECUTABLE_FIELD = /^\s*(?:-\s+)?(?:run|shell|uses|working-directory|runs-on|environment|ref|path)\s*:[^\n]*github\.event\.client_payload/im;

function signal(block: WorkflowJobBlock): WorkflowAuthoritySignal {
  const trigger = workflowTriggerProfile(block.file);
  const writeAuthority = jobHasWriteAuthority(block);
  const secrets = jobHasSecrets(block);
  const protectedEnvironment = jobUsesProtectedEnvironment(block);
  const checkout = CHECKOUT.test(block.text);
  const runStep = RUN_STEP.test(block.text);
  const workflowRunArtifactDownload =
    (DOWNLOAD_ARTIFACT.test(block.text) && WORKFLOW_RUN_ID.test(block.text)) ||
    (GH_RUN_DOWNLOAD.test(block.text) && WORKFLOW_RUN_ID.test(block.text));
  return {
    file: block.file.repositoryPath,
    job: block.name,
    externalContribution: trigger.externalContribution,
    pullRequest: trigger.pullRequest,
    pullRequestTarget: trigger.pullRequestTarget,
    workflowRun: trigger.workflowRun,
    repositoryDispatch: trigger.repositoryDispatch,
    workflowCall: trigger.workflowCall,
    writeAuthority,
    secrets,
    protectedEnvironment,
    checkout,
    runStep,
    untrustedExpression: hasUntrustedExpression(block.text),
    workflowRunHeadCheckout: WORKFLOW_RUN_HEAD_CHECKOUT.test(block.text),
    workflowRunArtifactDownload,
    workflowRunRepositoryGuard:
      WORKFLOW_RUN_REPOSITORY_GUARD.test(block.text) || WORKFLOW_RUN_FORK_GUARD.test(block.text),
    workflowRunBranchGuard: WORKFLOW_RUN_BRANCH_GUARD.test(block.text),
    dispatchPayloadReference: DISPATCH_PAYLOAD.test(block.text),
  };
}

function location(block: WorkflowJobBlock) {
  return { file: block.file.repositoryPath, line: block.startLine };
}

function privileged(current: WorkflowAuthoritySignal): boolean {
  return current.writeAuthority || current.secrets || current.protectedEnvironment;
}

function externalAuthorityFindings(block: WorkflowJobBlock, current: WorkflowAuthoritySignal): Finding[] {
  if (!current.externalContribution) return [];
  const findings: Finding[] = [];
  const where = location(block);

  if (current.writeAuthority && current.checkout) {
    const blocked = !current.protectedEnvironment;
    findings.push({
      id: 'ci-external-checkout-write-authority',
      domain: 'security',
      severity: blocked ? 'critical' : 'high',
      ...(blocked ? { blocking: true } : {}),
      title: 'Contribution-triggered checkout runs with write-capable token authority',
      message: `Job ${block.name} checks out repository content on an externally influenced event while its effective token permissions include write access. Repository-controlled code can reach a mutation-capable credential.`,
      location: where,
      remediation: 'Keep contribution validation contents: read with persist-credentials disabled. Move mutations to a separate trusted workflow that never checks out or executes contribution-controlled code.',
      tags: ['ci', 'token', 'checkout', 'pull-request', 'least-privilege'],
    });
  } else if (current.writeAuthority) {
    findings.push({
      id: 'ci-external-write-authority-review',
      domain: 'security',
      severity: current.untrustedExpression ? 'high' : 'medium',
      title: 'Externally influenced job has write-capable token authority',
      message: `Job ${block.name} can be reached from contribution-controlled events and has effective write permissions. Even metadata-only automation should prove that untrusted event data cannot steer mutation targets or executable inputs.`,
      location: where,
      remediation: 'Reduce the external job to read-only authority or isolate mutation into a trusted follow-up job with validated identifiers and no contribution-controlled execution.',
      tags: ['ci', 'token', 'least-privilege', 'event-boundary'],
    });
  }

  if (current.secrets) {
    const blocked = current.checkout || current.runStep || current.untrustedExpression;
    findings.push({
      id: 'ci-external-secret-context',
      domain: 'security',
      severity: blocked ? 'critical' : 'high',
      ...(blocked ? { blocking: true } : {}),
      title: 'Externally influenced job enters a secret-bearing execution context',
      message: `Job ${block.name} inherits or directly references secrets while handling contribution-controlled events. Checkout, shell execution, or untrusted expressions can turn event data into secret exfiltration.`,
      location: where,
      remediation: 'Remove secrets from contribution validation. Use protected trusted jobs for secret-bearing deployment or metadata mutation and pass only validated, minimal outputs across the boundary.',
      tags: ['ci', 'secrets', 'event-boundary', 'least-privilege'],
    });
  }

  return findings;
}

function workflowRunFindings(block: WorkflowJobBlock, current: WorkflowAuthoritySignal): Finding[] {
  if (!current.workflowRun) return [];
  const findings: Finding[] = [];
  const where = location(block);
  const isPrivileged = privileged(current);
  const guarded = current.workflowRunRepositoryGuard && current.workflowRunBranchGuard;

  if (isPrivileged && current.workflowRunHeadCheckout) {
    findings.push({
      id: 'ci-workflow-run-privileged-head-checkout',
      domain: 'security',
      severity: 'critical',
      blocking: true,
      title: 'Privileged workflow_run job checks out triggering workflow head',
      message: `Job ${block.name} runs in workflow_run context with privileged authority and checks out github.event.workflow_run.head_sha/head_branch. An upstream pull-request run can therefore become privileged code execution.`,
      location: where,
      remediation: 'Never execute workflow_run head code with secrets or write authority. Keep privileged follow-up jobs on trusted base/default-branch code and treat upstream outputs as untrusted data.',
      tags: ['ci', 'workflow-run', 'checkout', 'secrets', 'token'],
    });
  }

  if (isPrivileged && current.workflowRunArtifactDownload) {
    const blocked = !guarded;
    findings.push({
      id: 'ci-workflow-run-privileged-artifact-consumption',
      domain: 'security',
      severity: blocked ? 'critical' : 'high',
      ...(blocked ? { blocking: true } : {}),
      title: 'Privileged workflow_run job consumes artifacts from the triggering run',
      message: `Job ${block.name} downloads artifacts identified by github.event.workflow_run.id while running with write authority, secrets, or an environment boundary. Upstream artifacts are attacker-controlled unless repository/ref provenance is independently constrained.`,
      location: where,
      remediation: 'Verify upstream repository/ref provenance before artifact access, validate artifact contents as data, and never execute downloaded scripts or binaries in the privileged workflow.',
      tags: ['ci', 'workflow-run', 'artifact', 'provenance', 'secrets'],
    });
  }

  if (isPrivileged && !guarded) {
    findings.push({
      id: 'ci-workflow-run-privilege-trust-guard-missing',
      domain: 'security',
      severity: current.workflowRunHeadCheckout || current.workflowRunArtifactDownload ? 'high' : 'medium',
      title: 'Privileged workflow_run job lacks explicit repository and branch trust guards',
      message: `Job ${block.name} receives privileged workflow_run context without proving both triggering repository identity and a literal trusted head branch before privileged work.`,
      location: where,
      remediation: 'Gate privileged workflow_run work on the expected head repository and a small literal trusted branch allowlist. Keep pull-request follow-ups read-only and data-only.',
      tags: ['ci', 'workflow-run', 'provenance', 'trust-boundary'],
    });
  }

  return findings;
}

function repositoryDispatchFindings(block: WorkflowJobBlock, current: WorkflowAuthoritySignal): Finding[] {
  if (!current.repositoryDispatch || !current.dispatchPayloadReference) return [];
  const findings: Finding[] = [];
  const where = location(block);
  const isPrivileged = privileged(current);
  const executablePayload = DISPATCH_EXECUTABLE_FIELD.test(block.text);

  if (isPrivileged && executablePayload) {
    findings.push({
      id: 'ci-repository-dispatch-payload-privilege',
      domain: 'security',
      severity: 'critical',
      blocking: true,
      title: 'repository_dispatch payload reaches a privileged executable context',
      message: `Job ${block.name} combines repository_dispatch client_payload data with write authority, secrets, or an environment boundary in an executable or trust-selecting context.`,
      location: where,
      remediation: 'Treat client_payload as untrusted input. Validate against closed identifiers, map to reviewed literals, and separate privileged mutation from any payload-controlled shell, checkout, runner, path, or environment selection.',
      tags: ['ci', 'repository-dispatch', 'payload', 'expression-injection', 'token'],
    });
  } else if (isPrivileged) {
    findings.push({
      id: 'ci-repository-dispatch-payload-review',
      domain: 'security',
      severity: 'high',
      title: 'Privileged repository_dispatch job consumes client payload',
      message: `Job ${block.name} consumes repository_dispatch client_payload while privileged. API authentication does not make arbitrary payload fields safe mutation selectors.`,
      location: where,
      remediation: 'Validate payload schema, length, identifiers and allowlists before privileged use; log only bounded non-secret metadata.',
      tags: ['ci', 'repository-dispatch', 'payload', 'validation'],
    });
  }

  return findings;
}

function authorityFindings(block: WorkflowJobBlock): Finding[] {
  const current = signal(block);
  return [
    ...externalAuthorityFindings(block, current),
    ...workflowRunFindings(block, current),
    ...repositoryDispatchFindings(block, current),
  ];
}

export function auditWorkflowAuthority(inventory: RepositoryInventory): AuditSection<WorkflowAuthoritySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowJobBlocks(file));
  const signals = jobs.map(signal);
  const findings = stableSortFindings(jobs.flatMap(authorityFindings));
  return {
    domain: 'security',
    title: 'CI event authority and privileged follow-up audit',
    summary: {
      workflowFiles: files.length,
      jobs: signals.length,
      privilegedJobs: signals.filter(item => privileged(item)).length,
      externalPrivilegedJobs: signals.filter(item => item.externalContribution && privileged(item)).length,
      workflowRunJobs: signals.filter(item => item.workflowRun).length,
      repositoryDispatchJobs: signals.filter(item => item.repositoryDispatch).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
