import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  jobHasSecrets,
  jobHasWriteAuthority,
  workflowFiles,
  workflowJobBlocks,
  workflowTriggerProfile,
  type WorkflowJobBlock,
} from './workflow-structure.mts';
import {
  stepDisplayName,
  stepNestedMapping,
  stepRunText,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export interface GitOperationSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly gitCommands: number;
  readonly pushes: number;
  readonly dynamicRefs: number;
  readonly dynamicRemotes: number;
  readonly secretRemoteWrites: number;
  readonly unsafeDirectoryBypasses: number;
  readonly persistentCredentialHelpers: number;
  readonly externalContribution: boolean;
  readonly privileged: boolean;
}

export interface GitOperationBoundarySummary {
  readonly workflowFiles: number;
  readonly gitSteps: number;
  readonly pushes: number;
  readonly dynamicRefs: number;
  readonly secretRemoteWrites: number;
  readonly unsafeDirectoryBypasses: number;
  readonly persistentCredentialHelpers: number;
  readonly signals: readonly GitOperationSignal[];
  readonly findings: readonly Finding[];
}

const GIT_COMMAND = /(?:^|[;&|]\s*)git\s+(?:-[A-Za-z]\s+[^\s]+\s+)*(?:config|remote|push|fetch|pull|clone|checkout|switch|reset|submodule)\b/im;
const GIT_PUSH = /(?:^|[;&|]\s*)git\s+push\b/im;
const GIT_REF_COMMAND = /(?:^|[;&|]\s*)git\s+(?:fetch|checkout|switch|reset)\b[^\n]*/gim;
const GIT_REMOTE_COMMAND = /(?:^|[;&|]\s*)git\s+(?:clone|remote\s+set-url|fetch|pull)\b[^\n]*/gim;
const UNTRUSTED_EXPR = /\$\{\{[\s\S]*?(?:github\.event\.|github\.head_ref\b|inputs\.|github\.event\.inputs\.|needs\.|matrix\.)[\s\S]*?\}\}/i;
const SAFE_DIRECTORY_WILDCARD = /git\s+config\s+(?:--global\s+)?(?:--add\s+)?safe\.directory\s+['"]?\*['"]?/i;
const CREDENTIAL_HELPER_STORE = /git\s+config\s+(?:--global\s+)?credential\.helper\s+(?:['"]?)store\b/i;
const CREDENTIAL_HELPER_SHELL = /git\s+config\s+(?:--global\s+)?credential\.helper\s+['"]?!/i;
const EXTRAHEADER = /git\s+config\s+[^\n]*http\.[^\s]+\.extraheader\b/i;
const INSTEAD_OF = /git\s+config\s+(?:--global\s+)?url\.[^\n]+\.insteadOf\b/i;
const REMOTE_SET_URL = /git\s+remote\s+set-url\b[^\n]*/i;
const SECRET_EXPR = /\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}/i;
const URL_CREDENTIAL = /https?:\/\/[^\s:@/]+:[^\s@/]+@|https?:\/\/[^\s@/]+@/i;
const SUBMODULE_REMOTE = /git\s+submodule\s+update\b[^\n]*--remote\b/i;

function secretEnvNames(step: WorkflowStepBlock): string[] {
  return [...stepNestedMapping(step, 'env').entries()]
    .filter(([, value]) => SECRET_EXPR.test(value))
    .map(([name]) => name);
}

function referencesSecretVariable(text: string, names: readonly string[]): boolean {
  return names.some(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:\\$\\{${escaped}\\}|\\$${escaped}\\b|\\$env:${escaped}\\b|%${escaped}%)`, 'i').test(text);
  });
}

function matchCount(text: string, pattern: RegExp): number {
  const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let count = 0;
  while (matcher.exec(text) !== null) count += 1;
  return count;
}

function dynamicCommandCount(text: string, pattern: RegExp): number {
  const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    if (UNTRUSTED_EXPR.test(match[0])) count += 1;
  }
  return count;
}

function secretRemoteWrites(run: string, step: WorkflowStepBlock): number {
  const names = secretEnvNames(step);
  return run.split('\n').filter(line => {
    if (!REMOTE_SET_URL.test(line) && !INSTEAD_OF.test(line) && !EXTRAHEADER.test(line)) return false;
    return SECRET_EXPR.test(line) || referencesSecretVariable(line, names) || URL_CREDENTIAL.test(line);
  }).length;
}

function privileged(block: WorkflowJobBlock): boolean {
  return jobHasWriteAuthority(block) || jobHasSecrets(block);
}

function signal(block: WorkflowJobBlock, step: WorkflowStepBlock): GitOperationSignal | undefined {
  const run = stepRunText(step);
  if (!GIT_COMMAND.test(run) && !GIT_PUSH.test(run)) return undefined;
  const trigger = workflowTriggerProfile(block.file);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    gitCommands: run.split('\n').filter(line => /(?:^|[;&|]\s*)git\s+/i.test(line)).length,
    pushes: matchCount(run, GIT_PUSH),
    dynamicRefs: dynamicCommandCount(run, GIT_REF_COMMAND),
    dynamicRemotes: dynamicCommandCount(run, GIT_REMOTE_COMMAND),
    secretRemoteWrites: secretRemoteWrites(run, step),
    unsafeDirectoryBypasses: matchCount(run, SAFE_DIRECTORY_WILDCARD),
    persistentCredentialHelpers: matchCount(run, CREDENTIAL_HELPER_STORE) + matchCount(run, CREDENTIAL_HELPER_SHELL),
    externalContribution: trigger.externalContribution,
    privileged: privileged(block),
  };
}

function finding(step: WorkflowStepBlock, id: string, severity: Finding['severity'], title: string, message: string, remediation: string, blocking = false): Finding {
  return {
    id,
    domain: 'security',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: step.job.file.repositoryPath, line: step.startLine },
    evidence: { excerpt: stepRunText(step).slice(0, 420), metadata: { job: step.job.name, step: stepDisplayName(step) } },
    remediation,
    tags: ['ci', 'git', 'credentials', 'repository-integrity', 'trust-boundary'],
  };
}

function auditStep(block: WorkflowJobBlock, step: WorkflowStepBlock): Finding[] {
  const run = stepRunText(step);
  if (!GIT_COMMAND.test(run) && !GIT_PUSH.test(run)) return [];
  const trigger = workflowTriggerProfile(block.file);
  const isPrivileged = privileged(block);
  const findings: Finding[] = [];

  if (SAFE_DIRECTORY_WILDCARD.test(run)) {
    findings.push(finding(
      step,
      'ci-git-safe-directory-wildcard',
      'critical',
      'Workflow disables Git repository ownership protection globally',
      `Step ${stepDisplayName(step)} configures safe.directory '*', allowing Git to trust repositories regardless of filesystem ownership. This removes a security boundary intended to prevent repository confusion on shared/persistent runners.`,
      'Trust only the exact checked-out workspace path. Never configure safe.directory as a wildcard.',
      true,
    ));
  }

  if (CREDENTIAL_HELPER_STORE.test(run) || CREDENTIAL_HELPER_SHELL.test(run)) {
    findings.push(finding(
      step,
      'ci-git-persistent-credential-helper',
      isPrivileged ? 'critical' : 'high',
      'Workflow configures persistent or executable Git credential helper',
      `Step ${stepDisplayName(step)} configures credential.helper store or a shell-backed helper. Credentials can persist on disk or execute helper shell code beyond the intended command boundary.`,
      'Use the ephemeral checkout credential mechanism or a narrowly scoped in-memory credential flow. Never persist CI tokens with credential.helper store or shell helpers.',
      isPrivileged,
    ));
  }

  if (secretRemoteWrites(run, step) > 0) {
    findings.push(finding(
      step,
      'ci-git-secret-remote-url',
      'critical',
      'Git remote or config embeds credential material',
      `Step ${stepDisplayName(step)} writes secret-backed credential material into a Git remote/config value. Credentials may remain in .git/config, global config, process arguments, diagnostics, or runner state.`,
      'Keep remote URLs credential-free. Use ephemeral HTTP extra headers or checkout-managed authentication with persist-credentials disabled when executable repository code runs.',
      true,
    ));
  }

  if (GIT_PUSH.test(run) && trigger.externalContribution) {
    findings.push(finding(
      step,
      'ci-git-external-event-push',
      isPrivileged ? 'critical' : 'high',
      'Externally influenced workflow performs git push',
      `Step ${stepDisplayName(step)} pushes repository refs from an externally influenced trigger. Contribution-controlled code/data can steer mutations when credentials are available.`,
      'Move git push to a trusted push/workflow_dispatch follow-up that consumes only validated immutable identifiers and never executes contribution-controlled code.',
      isPrivileged,
    ));
  }

  if (dynamicCommandCount(run, GIT_REF_COMMAND) > 0) {
    findings.push(finding(
      step,
      'ci-git-dynamic-ref-operation',
      isPrivileged ? 'critical' : 'high',
      'Git fetch/checkout/reset target is expression-controlled',
      `Step ${stepDisplayName(step)} uses runtime/event data directly in a Git ref operation. Unvalidated refs can redirect later build or release execution to unexpected commits.`,
      'Validate against a closed ref policy or resolve to an immutable expected commit SHA before checkout/reset/fetch use.',
      isPrivileged,
    ));
  }

  if (dynamicCommandCount(run, GIT_REMOTE_COMMAND) > 0) {
    findings.push(finding(
      step,
      'ci-git-dynamic-remote-operation',
      isPrivileged ? 'critical' : 'high',
      'Git remote origin or fetch source is expression-controlled',
      `Step ${stepDisplayName(step)} allows runtime/event data to select a Git repository or remote URL, extending executable source trust beyond reviewed repository configuration.`,
      'Map validated repository identifiers to a closed allowlist of literal origins and pin the consumed commit.',
      isPrivileged,
    ));
  }

  if (SUBMODULE_REMOTE.test(run)) {
    findings.push(finding(
      step,
      'ci-git-submodule-remote-update',
      isPrivileged ? 'high' : 'medium',
      'Workflow updates submodule to mutable remote branch tip',
      `Step ${stepDisplayName(step)} uses git submodule update --remote, which consumes current remote branch state rather than only the reviewed superproject gitlink commit.`,
      'Use the committed submodule gitlink SHA. Update submodule pointers through reviewed repository changes rather than --remote in release CI.',
    ));
  }

  return findings;
}

export function auditGitOperationBoundaries(inventory: RepositoryInventory): AuditSection<GitOperationBoundarySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowJobBlocks(file));
  const pairs = jobs.flatMap(job => workflowStepBlocks(job).map(step => ({ job, step })));
  const signals = pairs.map(({ job, step }) => signal(job, step)).filter((item): item is GitOperationSignal => item !== undefined);
  const findings = stableSortFindings(pairs.flatMap(({ job, step }) => auditStep(job, step)));
  return {
    domain: 'security',
    title: 'Git operation and credential trust-boundary audit',
    summary: {
      workflowFiles: files.length,
      gitSteps: signals.length,
      pushes: signals.reduce((sum, item) => sum + item.pushes, 0),
      dynamicRefs: signals.reduce((sum, item) => sum + item.dynamicRefs, 0),
      secretRemoteWrites: signals.reduce((sum, item) => sum + item.secretRemoteWrites, 0),
      unsafeDirectoryBypasses: signals.reduce((sum, item) => sum + item.unsafeDirectoryBypasses, 0),
      persistentCredentialHelpers: signals.reduce((sum, item) => sum + item.persistentCredentialHelpers, 0),
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
