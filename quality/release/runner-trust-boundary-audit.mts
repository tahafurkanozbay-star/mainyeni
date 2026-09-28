import { stableSortFindings, type AuditSection, type Finding, type RepositoryInventory } from './contracts.mts';
import { workflowFiles, workflowJobBlocks, workflowTopLevelBlock, workflowTriggerProfile, jobHasSecrets, jobUsesProtectedEnvironment, type WorkflowJobBlock } from './workflow-structure.mts';

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
  readonly privilegedContainer: boolean;
  readonly hostNetwork: boolean;
  readonly hostPid: boolean;
  readonly hostMount: boolean;
}

export interface RunnerTrustSummary {
  readonly workflowFiles: number;
  readonly jobs: number;
  readonly selfHostedJobs: number;
  readonly externalSelfHostedJobs: number;
  readonly privilegedSelfHostedJobs: number;
  readonly hostAuthorityJobs: number;
  readonly signals: readonly RunnerTrustSignal[];
  readonly findings: readonly Finding[];
}

const RUNS_ON = /^\s*runs-on\s*:\s*([^\n#]+).*$/im;
const RUNS_ON_START = /^(\s*)runs-on\s*:\s*(.*)$/i;
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
const PRIVILEGED_CONTAINER = /(?:--privileged\b|options\s*:\s*[^\n]*--privileged\b)/i;
const HOST_NETWORK = /(?:--network(?:=|\s+)host\b|network_mode\s*:\s*host\b)/i;
const HOST_PID = /(?:--pid(?:=|\s+)host\b|pid\s*:\s*host\b)/i;
const HOST_MOUNT = /(?:-v|--volume|--mount)\s+(?:type=bind,)?(?:source=|src=)?\/(?:etc|root|home|var|usr|opt|run)(?:[\/:,\s]|$)/i;

function runnerValue(block: WorkflowJobBlock): string {
  const lines = block.lines;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = line.text.match(RUNS_ON_START);
    if (!match) continue;
    const indent = match[1]!.length;
    const values = [match[2] ?? ''];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor]!;
      if (next.trimmed && next.indent <= indent) break;
      values.push(next.text);
    }
    return values.join('\n').trim();
  }
  return block.text.match(RUNS_ON)?.[1]?.trim() ?? '';
}

function permissionText(block: WorkflowJobBlock): string {
  const lines = block.lines;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!/^\s*permissions\s*:/i.test(line.text)) continue;
    const collected = [line.text];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor]!;
      if (next.trimmed && next.indent <= line.indent) break;
      collected.push(next.text);
    }
    return collected.join('\n');
  }
  return workflowTopLevelBlock(block.file, 'permissions')?.text ?? '';
}

function repositoryWrite(block: WorkflowJobBlock): boolean {
  const permissions = permissionText(block);
  return WRITE_ALL.test(permissions) || WRITE_PERMISSION.test(permissions);
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
    privilegedContainer: PRIVILEGED_CONTAINER.test(block.text),
    hostNetwork: HOST_NETWORK.test(block.text),
    hostPid: HOST_PID.test(block.text),
    hostMount: HOST_MOUNT.test(block.text),
  };
}

function location(block: WorkflowJobBlock) { return { file: block.file.repositoryPath, line: block.startLine }; }

function findingsFor(block: WorkflowJobBlock): Finding[] {
  const current = signal(block);
  const findings: Finding[] = [];
  const at = location(block);
  if (current.dynamicRunner) findings.push({ id: 'ci-runner-dynamic-selection', domain: 'security', severity: 'critical', blocking: true, title: 'Workflow dynamically selects its runner trust domain', message: `Job ${block.name} derives runs-on from an expression. Runtime-controlled runner labels can redirect execution across materially different host trust boundaries.`, location: at, remediation: 'Use literal reviewed runner labels. Split trusted and untrusted execution into separate jobs instead of selecting runner identity from inputs, event data, matrix outputs, needs, or vars.', tags: ['ci','runner','expression','trust-boundary'] });
  if (!current.selfHosted) return findings;
  if (current.externalContribution) findings.push({ id: 'ci-runner-self-hosted-external-contribution', domain: 'security', severity: 'critical', blocking: true, title: 'External contribution executes on a persistent self-hosted runner', message: `Job ${block.name} accepts externally influenced execution on self-hosted infrastructure. A contribution can target host state, credentials, caches, sockets, sibling workspaces, or later jobs beyond the repository checkout.`, location: at, remediation: 'Run contribution validation on ephemeral GitHub-hosted or single-use isolated runners. Never expose persistent self-hosted runners to fork or contribution-controlled code.', tags: ['ci','runner','self-hosted','pull-request','persistence'] });
  if ((current.repositoryWrite || current.secrets) && !current.protectedEnvironment) findings.push({ id: 'ci-runner-self-hosted-privilege-without-environment', domain: 'security', severity: 'high', title: 'Privileged self-hosted job lacks a protected environment', message: `Job ${block.name} combines persistent self-hosted execution with repository-write authority or secrets without a literal protected environment boundary.`, location: at, remediation: 'Bind privileged deployment to a protected environment and use ephemeral/single-use runner registration with least-privilege credentials.', tags: ['ci','runner','self-hosted','environment','least-privilege'] });
  if (current.hostToolMutation) findings.push({ id: 'ci-runner-self-hosted-host-tool-mutation', domain: 'security', severity: 'high', title: 'Self-hosted job mutates host-global tooling', message: `Job ${block.name} installs or mutates host-global tooling. Persistent runner mutation can contaminate later jobs and defeats reproducible release assumptions.`, location: at, remediation: 'Bake immutable runner images or install tools into a job-local workspace/container with pinned versions and integrity verification.', tags: ['ci','runner','self-hosted','toolchain','persistence'] });
  if (current.dockerSocket) findings.push({ id: 'ci-runner-self-hosted-container-daemon-authority', domain: 'security', severity: current.externalContribution ? 'critical' : 'high', ...(current.externalContribution ? { blocking: true } : {}), title: 'Self-hosted job reaches container-daemon authority', message: `Job ${block.name} uses Docker host/daemon capabilities on a self-hosted runner. Daemon access is effectively host-level authority on common runner configurations.`, location: at, remediation: 'Use isolated rootless builders or ephemeral runners. Do not expose a shared host Docker socket to repository-controlled execution.', tags: ['ci','runner','self-hosted','docker','host-authority'] });
  if (current.privilegedContainer) findings.push({ id: 'ci-runner-self-hosted-privileged-container', domain: 'security', severity: 'critical', blocking: true, title: 'Self-hosted job starts a privileged container', message: `Job ${block.name} enables privileged container execution on a self-hosted runner, collapsing the intended container/host trust boundary.`, location: at, remediation: 'Remove privileged mode. Use narrowly scoped capabilities on an ephemeral isolated runner, or redesign the build so host-level container authority is unnecessary.', tags: ['ci','runner','container','privileged','host-authority'] });
  if (current.hostNetwork) findings.push({ id: 'ci-runner-self-hosted-host-network', domain: 'security', severity: 'high', title: 'Self-hosted container joins the host network namespace', message: `Job ${block.name} requests host networking on persistent infrastructure, exposing host-local listeners and weakening network isolation.`, location: at, remediation: 'Use an isolated job network with explicit service ports. Avoid host networking on shared or persistent release runners.', tags: ['ci','runner','container','network','isolation'] });
  if (current.hostPid) findings.push({ id: 'ci-runner-self-hosted-host-pid', domain: 'security', severity: 'high', title: 'Self-hosted container joins the host PID namespace', message: `Job ${block.name} requests the host PID namespace, allowing repository-controlled execution to observe or interact with host processes.`, location: at, remediation: 'Remove host PID sharing and use an ephemeral runner if process-level diagnostics require host visibility.', tags: ['ci','runner','container','pid','isolation'] });
  if (current.hostMount) findings.push({ id: 'ci-runner-self-hosted-sensitive-host-mount', domain: 'security', severity: 'critical', blocking: true, title: 'Self-hosted container mounts a sensitive host path', message: `Job ${block.name} bind-mounts a sensitive host filesystem path into repository-controlled container execution.`, location: at, remediation: 'Do not mount host system/home/runtime directories. Mount only a disposable job workspace with the minimum required read/write mode.', tags: ['ci','runner','container','filesystem','host-authority'] });
  if (current.persistentWorkspaceMutation) findings.push({ id: 'ci-runner-self-hosted-persistent-workspace-mutation', domain: 'build', severity: 'medium', title: 'Self-hosted job performs broad persistent workspace mutation', message: `Job ${block.name} performs broad cleanup/permission mutation on a persistent runner workspace. This can hide cross-job contamination or damage concurrently reused state.`, location: at, remediation: 'Prefer disposable workspaces/runners. Scope cleanup to the current checkout and fail closed if runner isolation cannot be guaranteed.', tags: ['ci','runner','self-hosted','workspace','reproducibility'] });
  if ((current.repositoryWrite || current.secrets) && current.checkout && !current.containerized && !current.protectedEnvironment) findings.push({ id: 'ci-runner-self-hosted-privileged-checkout-isolation', domain: 'security', severity: 'high', title: 'Privileged self-hosted checkout lacks isolation boundary', message: `Job ${block.name} checks repository code out directly onto a privileged persistent host without a protected environment or job container boundary.`, location: at, remediation: 'Use an ephemeral runner and protected environment; where feasible execute build steps in an isolated container without host sockets or inherited host credentials.', tags: ['ci','runner','self-hosted','checkout','isolation'] });
  return findings;
}

export function auditRunnerTrustBoundaries(inventory: RepositoryInventory): AuditSection<RunnerTrustSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowJobBlocks(file));
  const signals = jobs.map(signal);
  const findings = stableSortFindings(jobs.flatMap(findingsFor));
  return { domain: 'security', title: 'CI runner trust-boundary audit', summary: { workflowFiles: files.length, jobs: jobs.length, selfHostedJobs: signals.filter(item => item.selfHosted).length, externalSelfHostedJobs: signals.filter(item => item.selfHosted && item.externalContribution).length, privilegedSelfHostedJobs: signals.filter(item => item.selfHosted && (item.repositoryWrite || item.secrets)).length, hostAuthorityJobs: signals.filter(item => item.selfHosted && (item.dockerSocket || item.privilegedContainer || item.hostNetwork || item.hostPid || item.hostMount)).length, signals, findings }, findings, elapsedMs: Math.max(0, performance.now() - started) };
}
