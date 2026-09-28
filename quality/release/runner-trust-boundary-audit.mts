import { stableSortFindings, type AuditSection, type Finding, type RepositoryInventory } from './contracts.mts';
import { workflowFiles, workflowJobBlocks, workflowTriggerProfile, jobHasSecrets, jobUsesProtectedEnvironment, type WorkflowJobBlock } from './workflow-structure.mts';

export interface RunnerTrustSignal {
  readonly file: string;
  readonly job: string;
  readonly selfHosted: boolean;
  readonly dynamicRunner: boolean;
  readonly externalContribution: boolean;
  readonly privilegedTrigger: boolean;
  readonly secrets: boolean;
  readonly protectedEnvironment: boolean;
  readonly repositoryWrite: boolean;
  readonly checkout: boolean;
  readonly containerized: boolean;
  readonly serviceContainers: boolean;
  readonly persistentWorkspaceMutation: boolean;
  readonly hostToolMutation: boolean;
  readonly dockerSocket: boolean;
}

export interface RunnerTrustSummary {
  readonly workflowFiles: number;
  readonly jobs: number;
  readonly selfHostedJobs: number;
  readonly externalSelfHostedJobs: number;
  readonly privilegedSelfHostedJobs: number;
  readonly signals: readonly RunnerTrustSignal[];
  readonly findings: readonly Finding[];
}

const RUNS_ON = /^\s*runs-on\s*:\s*([^\n#]+).*$/im;
const SELF_HOSTED = /(?:^|[\[,'"\s])self-hosted(?:$|[\],'"\s])/i;
const EXPRESSION = /\$\{\{/;
const WRITE_PERMISSION = /^\s*(?:contents|actions|checks|deployments|issues|packages|pages|pull-requests|security-events|statuses)\s*:\s*write\s*(?:#.*)?$/im;
const WRITE_ALL = /^\s*permissions\s*:\s*write-all\s*(?:#.*)?$/im;
const CHECKOUT = /^\s*-?\s*uses\s*:\s*actions\/checkout@/im;
const CONTAINER = /^\s*container\s*:/im;
const SERVICES = /^\s*services\s*:/im;
const WORKSPACE_MUTATION = /(?:rm\s+-rf\s+[^\n]*(?:GITHUB_WORKSPACE|github\.workspace)|git\s+clean\s+-[^\n]*[xfd]|git\s+reset\s+--hard|chmod\s+-R|chown\s+-R)/i;
const HOST_TOOL_MUTATION = /(?:sudo\s+(?:apt|apt-get|dnf|yum|brew)|(?:npm|pnpm|yarn)\s+(?:install|add)\s+-g\b|pipx?\s+install\b|dotnet\s+tool\s+install\s+--global\b)/i;
const DOCKER_SOCKET = /(?:\/var\/run\/docker\.sock|DOCKER_HOST\s*=|docker\s+(?:build|run|compose|system|volume|network)\b)/i;

function runnerValue(block: WorkflowJobBlock): string {
  const match = block.text.match(RUNS_ON);
  return match?.[1]?.trim() ?? '';
}

function repositoryWrite(block: WorkflowJobBlock): boolean {
  return WRITE_ALL.test(block.text) || WRITE_PERMISSION.test(block.text);
}

function signal(block: WorkflowJobBlock): RunnerTrustSignal {
  const trigger = workflowTriggerProfile(block.file);
  const runner = runnerValue(block);
  const selfHosted = SELF_HOSTED.test(runner);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    selfHosted,
    dynamicRunner: EXPRESSION.test(runner),
    externalContribution: trigger.externalContribution,
    privilegedTrigger: trigger.pullRequestTarget || trigger.workflowRun || trigger.repositoryDispatch || trigger.workflowCall,
    secrets: jobHasSecrets(block),
    protectedEnvironment: jobUsesProtectedEnvironment(block),
    repositoryWrite: repositoryWrite(block),
    checkout: CHECKOUT.test(block.text),
    containerized: CONTAINER.test(block.text),
    serviceContainers: SERVICES.test(block.text),
    persistentWorkspaceMutation: WORKSPACE_MUTATION.test(block.text),
    hostToolMutation: HOST_TOOL_MUTATION.test(block.text),
    dockerSocket: DOCKER_SOCKET.test(block.text),
  };
}

function location(block: WorkflowJobBlock) { return { file: block.file.repositoryPath, line: block.startLine }; }

function findingsFor(block: WorkflowJobBlock): Finding[] {
  const current = signal(block);
  const findings: Finding[] = [];
  const at = location(block);
  if (current.dynamicRunner) {
    findings.push({ id: 'ci-runner-dynamic-selection', domain: 'security', severity: 'critical', blocking: true, title: 'Workflow dynamically selects its runner trust domain', message: `Job ${block.name} derives runs-on from an expression. Runtime-controlled runner labels can redirect execution across materially different host trust boundaries.`, location: at, remediation: 'Use literal reviewed runner labels. Split trusted and untrusted execution into separate jobs instead of selecting runner identity from inputs, event data, matrix outputs, needs, or vars.', tags: ['ci','runner','expression','trust-boundary'] });
  }
  if (!current.selfHosted) return findings;
  if (current.externalContribution) {
    findings.push({ id: 'ci-runner-self-hosted-external-contribution', domain: 'security', severity: 'critical', blocking: true, title: 'External contribution executes on a persistent self-hosted runner', message: `Job ${block.name} accepts externally influenced execution on self-hosted infrastructure. A contribution can target host state, credentials, caches, sockets, sibling workspaces, or later jobs beyond the repository checkout.`, location: at, remediation: 'Run contribution validation on ephemeral GitHub-hosted or single-use isolated runners. Never expose persistent self-hosted runners to fork or contribution-controlled code.', tags: ['ci','runner','self-hosted','pull-request','persistence'] });
  }
  if ((current.repositoryWrite || current.secrets) && !current.protectedEnvironment) {
    findings.push({ id: 'ci-runner-self-hosted-privilege-without-environment', domain: 'security', severity: 'high', title: 'Privileged self-hosted job lacks a protected environment', message: `Job ${block.name} combines persistent self-hosted execution with repository-write authority or secrets without a literal protected environment boundary.`, location: at, remediation: 'Bind privileged deployment to a protected environment and use ephemeral/single-use runner registration with least-privilege credentials.', tags: ['ci','runner','self-hosted','environment','least-privilege'] });
  }
  if (current.hostToolMutation) {
    findings.push({ id: 'ci-runner-self-hosted-host-tool-mutation', domain: 'security', severity: 'high', title: 'Self-hosted job mutates host-global tooling', message: `Job ${block.name} installs or mutates host-global tooling. Persistent runner mutation can contaminate later jobs and defeats reproducible release assumptions.`, location: at, remediation: 'Bake immutable runner images or install tools into a job-local workspace/container with pinned versions and integrity verification.', tags: ['ci','runner','self-hosted','toolchain','persistence'] });
  }
  if (current.dockerSocket) {
    findings.push({ id: 'ci-runner-self-hosted-container-daemon-authority', domain: 'security', severity: current.externalContribution ? 'critical' : 'high', ...(current.externalContribution ? { blocking: true } : {}), title: 'Self-hosted job reaches container-daemon authority', message: `Job ${block.name} uses Docker host/daemon capabilities on a self-hosted runner. Daemon access is effectively host-level authority on common runner configurations.`, location: at, remediation: 'Use isolated rootless builders or ephemeral runners. Do not expose a shared host Docker socket to repository-controlled execution.', tags: ['ci','runner','self-hosted','docker','host-authority'] });
  }
  if (current.persistentWorkspaceMutation) {
    findings.push({ id: 'ci-runner-self-hosted-persistent-workspace-mutation', domain: 'reliability', severity: 'medium', title: 'Self-hosted job performs broad persistent workspace mutation', message: `Job ${block.name} performs broad cleanup/permission mutation on a persistent runner workspace. This can hide cross-job contamination or damage concurrently reused state.`, location: at, remediation: 'Prefer disposable workspaces/runners. Scope cleanup to the current checkout and fail closed if runner isolation cannot be guaranteed.', tags: ['ci','runner','self-hosted','workspace','reproducibility'] });
  }
  if ((current.repositoryWrite || current.secrets) && current.checkout && !current.containerized && !current.protectedEnvironment) {
    findings.push({ id: 'ci-runner-self-hosted-privileged-checkout-isolation', domain: 'security', severity: 'high', title: 'Privileged self-hosted checkout lacks isolation boundary', message: `Job ${block.name} checks repository code out directly onto a privileged persistent host without a protected environment or job container boundary.`, location: at, remediation: 'Use an ephemeral runner and protected environment; where feasible execute build steps in an isolated container without host sockets or inherited host credentials.', tags: ['ci','runner','self-hosted','checkout','isolation'] });
  }
  return findings;
}

export function auditRunnerTrustBoundaries(inventory: RepositoryInventory): AuditSection<RunnerTrustSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowJobBlocks(file));
  const signals = jobs.map(signal);
  const findings = stableSortFindings(jobs.flatMap(findingsFor));
  return { domain: 'security', title: 'CI runner trust-boundary audit', summary: { workflowFiles: files.length, jobs: jobs.length, selfHostedJobs: signals.filter(item => item.selfHosted).length, externalSelfHostedJobs: signals.filter(item => item.selfHosted && item.externalContribution).length, privilegedSelfHostedJobs: signals.filter(item => item.selfHosted && (item.repositoryWrite || item.secrets)).length, signals, findings }, findings, elapsedMs: Math.max(0, performance.now() - started) };
}
