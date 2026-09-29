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
  stepRunText,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export interface WorkflowNetworkSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly remoteCommands: number;
  readonly insecureUrls: number;
  readonly dynamicUrls: number;
  readonly directExecutionPipes: number;
  readonly downloadedExecutables: number;
  readonly verifiedDownloads: number;
  readonly externalContribution: boolean;
  readonly privileged: boolean;
}

export interface WorkflowNetworkProvenanceSummary {
  readonly workflowFiles: number;
  readonly networkSteps: number;
  readonly insecureDownloads: number;
  readonly dynamicDownloads: number;
  readonly directRemoteExecutions: number;
  readonly unverifiedExecutedDownloads: number;
  readonly signals: readonly WorkflowNetworkSignal[];
  readonly findings: readonly Finding[];
}

interface DownloadTarget {
  readonly name: string;
  readonly latestAlias: boolean;
}

const REMOTE_COMMAND = /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer)\b/i;
const INSECURE_URL = /http:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/gi;
const DYNAMIC_SOURCE = /\$\{\{[\s\S]*?(?:github\.event\.|github\.head_ref\b|inputs\.|github\.event\.inputs\.|matrix\.|needs\.)[\s\S]*?\}\}/i;
const URL_EXPRESSION = /https?:\/\/[^\n]*\$\{\{/i;
const DIRECT_PIPE = /\b(?:curl|wget)\b[^\n|]{0,500}\|\s*(?:sudo\s+)?(?:bash|sh|zsh|pwsh|powershell|python(?:3)?|node)\b/i;
const POWERSHELL_IEX = /\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^\n|]{0,500}\|\s*(?:iex|Invoke-Expression)\b/i;
const COMMAND_SUBSTITUTION = /(?:\$\(|`)[^\n]*(?:curl|wget)\b/i;
const VERIFY = /\b(?:sha256sum\s+-c|shasum\s+-a\s+256\s+-c|openssl\s+dgst\s+-sha256|cosign\s+verify(?:-blob)?|gh\s+attestation\s+verify|Get-FileHash\b)[^\n]*/i;
const LATEST_ALIAS = /(?:\/releases\/latest\/|\/latest\/download\/|\/latest(?:\.[A-Za-z0-9]+)?(?:\?|$)|\bdownload\/latest\b)/i;
const PRIVILEGED_COMMAND = /\b(?:gh\s+(?:release|api)|docker\s+(?:push|login)|npm\s+publish|dotnet\s+nuget\s+push|nuget\s+push|twine\s+upload|kubectl\b|helm\b|terraform\s+apply|az\s+|aws\s+|gcloud\s+)\b/i;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function downloadTargets(run: string): DownloadTarget[] {
  const targets: DownloadTarget[] = [];
  for (const line of run.split('\n')) {
    if (!REMOTE_COMMAND.test(line)) continue;
    const curl = line.match(/\bcurl\b[^\n]*(?:-o|--output(?:=|\s+))\s*['"]?([^'"\s]+)/i);
    const wget = line.match(/\bwget\b[^\n]*(?:-O\s+|--output-document(?:=|\s+))['"]?([^'"\s]+)/i);
    const powershell = line.match(/\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer)\b[^\n]*-(?:OutFile|Destination)\s+['"]?([^'"\s]+)/i);
    const name = curl?.[1] ?? wget?.[1] ?? powershell?.[1];
    if (!name) continue;
    targets.push({ name, latestAlias: LATEST_ALIAS.test(line) });
  }
  return targets;
}

function targetExecuted(run: string, target: string): boolean {
  const escaped = escapeRegex(target.replace(/^\.\//, ''));
  const patterns = [
    new RegExp(`(?:^|\\s)(?:bash|sh|zsh|pwsh|powershell|python(?:3)?|node)\\s+['"]?(?:\\./)?${escaped}(?:['"\\s]|$)`, 'im'),
    new RegExp(`^\\s*(?:\\./)?${escaped}(?:['"\\s]|$)`, 'im'),
    new RegExp(`chmod\\s+[^\\n]*\\+x[^\\n]*${escaped}`, 'im'),
  ];
  return patterns.some(pattern => pattern.test(run));
}

function targetVerifiedBeforeExecution(run: string, target: string): boolean {
  if (!VERIFY.test(run)) return false;
  const verifyIndex = run.search(VERIFY);
  const escaped = escapeRegex(target.replace(/^\.\//, ''));
  const execute = new RegExp(`(?:bash|sh|zsh|pwsh|powershell|python(?:3)?|node)\\s+['"]?(?:\\./)?${escaped}|^\\s*(?:\\./)?${escaped}(?:['"\\s]|$)|chmod\\s+[^\\n]*${escaped}`, 'im');
  const executeIndex = run.search(execute);
  return verifyIndex >= 0 && executeIndex >= 0 && verifyIndex < executeIndex;
}

function privileged(block: WorkflowJobBlock, run: string): boolean {
  return jobHasWriteAuthority(block) || jobHasSecrets(block) || PRIVILEGED_COMMAND.test(run);
}

function signal(block: WorkflowJobBlock, step: WorkflowStepBlock): WorkflowNetworkSignal | undefined {
  const run = stepRunText(step);
  if (!REMOTE_COMMAND.test(run) && !DIRECT_PIPE.test(run) && !POWERSHELL_IEX.test(run)) return undefined;
  const trigger = workflowTriggerProfile(block.file);
  const targets = downloadTargets(run);
  const executed = targets.filter(target => targetExecuted(run, target.name));
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    remoteCommands: run.split('\n').filter(line => REMOTE_COMMAND.test(line)).length,
    insecureUrls: (run.match(INSECURE_URL) ?? []).length,
    dynamicUrls: run.split('\n').filter(line => REMOTE_COMMAND.test(line) && (DYNAMIC_SOURCE.test(line) || URL_EXPRESSION.test(line))).length,
    directExecutionPipes: Number(DIRECT_PIPE.test(run)) + Number(POWERSHELL_IEX.test(run)) + Number(COMMAND_SUBSTITUTION.test(run)),
    downloadedExecutables: executed.length,
    verifiedDownloads: executed.filter(target => targetVerifiedBeforeExecution(run, target.name)).length,
    externalContribution: trigger.externalContribution,
    privileged: privileged(block, run),
  };
}

function where(step: WorkflowStepBlock) {
  return { file: step.job.file.repositoryPath, line: step.startLine };
}

function finding(
  step: WorkflowStepBlock,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  blocking = false,
): Finding {
  return {
    id,
    domain: 'security',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: where(step),
    evidence: { excerpt: stepRunText(step).slice(0, 420), metadata: { job: step.job.name, step: stepDisplayName(step) } },
    remediation,
    tags: ['ci', 'network', 'download', 'supply-chain', 'provenance'],
  };
}

function auditStep(block: WorkflowJobBlock, step: WorkflowStepBlock): Finding[] {
  const run = stepRunText(step);
  if (!REMOTE_COMMAND.test(run) && !DIRECT_PIPE.test(run) && !POWERSHELL_IEX.test(run)) return [];
  const trigger = workflowTriggerProfile(block.file);
  const isPrivileged = privileged(block, run);
  const findings: Finding[] = [];

  if (DIRECT_PIPE.test(run) || POWERSHELL_IEX.test(run) || COMMAND_SUBSTITUTION.test(run)) {
    findings.push(finding(
      step,
      'ci-network-direct-remote-execution',
      'critical',
      'Workflow executes network content without a local verification boundary',
      `Step ${stepDisplayName(step)} directly feeds downloaded network content into an interpreter or command substitution. Transport encryption does not establish artifact identity or immutability.`,
      'Download to a local file, verify a repository-reviewed digest/signature/attestation, then execute the verified file in a separate command.',
      true,
    ));
  }

  if (INSECURE_URL.test(run)) {
    INSECURE_URL.lastIndex = 0;
    findings.push(finding(
      step,
      'ci-network-insecure-http-download',
      isPrivileged || trigger.externalContribution ? 'critical' : 'high',
      'Workflow downloads build or release input over plaintext HTTP',
      `Step ${stepDisplayName(step)} uses an http:// download path. Network intermediaries can replace the fetched content before validation or execution.`,
      'Use HTTPS plus an independently reviewed digest/signature. Prefer immutable package registries or repository-controlled artifacts when possible.',
      isPrivileged || trigger.externalContribution,
    ));
  }

  const dynamicLines = run.split('\n').filter(line => REMOTE_COMMAND.test(line) && (DYNAMIC_SOURCE.test(line) || URL_EXPRESSION.test(line)));
  if (dynamicLines.length > 0) {
    findings.push(finding(
      step,
      'ci-network-dynamic-download-origin',
      isPrivileged || trigger.externalContribution ? 'critical' : 'high',
      'Workflow download origin is selected by runtime or event data',
      `Step ${stepDisplayName(step)} constructs a remote fetch using expression-controlled input. An attacker-controlled host/path can replace executable or build input.`,
      'Map validated identifiers to a closed repository-owned URL allowlist. Do not let event/input/matrix/output data directly select network origins.',
      isPrivileged || trigger.externalContribution,
    ));
  }

  const targets = downloadTargets(run);
  for (const target of targets) {
    if (target.latestAlias) {
      findings.push(finding(
        step,
        'ci-network-mutable-latest-download',
        isPrivileged ? 'high' : 'medium',
        'Workflow downloads from a mutable latest alias',
        `Step ${stepDisplayName(step)} fetches a URL containing a latest alias. The bytes can change without any repository diff even when the hostname is trusted.`,
        'Use an immutable version/digest URL and verify the downloaded bytes before use.',
      ));
    }
    if (!targetExecuted(run, target.name)) continue;
    if (targetVerifiedBeforeExecution(run, target.name)) continue;
    findings.push(finding(
      step,
      'ci-network-unverified-downloaded-executable',
      isPrivileged || trigger.externalContribution ? 'critical' : 'high',
      'Downloaded file is executed before integrity verification',
      `Step ${stepDisplayName(step)} downloads ${target.name} and executes or marks it executable without a preceding digest/signature/attestation verification command.`,
      'Verify the exact downloaded file against a repository-reviewed SHA-256, signature, or provenance attestation before chmod/interpreter/direct execution.',
      isPrivileged || trigger.externalContribution,
    ));
  }

  return findings;
}

export function auditWorkflowNetworkProvenance(inventory: RepositoryInventory): AuditSection<WorkflowNetworkProvenanceSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowJobBlocks(file));
  const pairs = jobs.flatMap(job => workflowStepBlocks(job).map(step => ({ job, step })));
  const signals = pairs.map(({ job, step }) => signal(job, step)).filter((item): item is WorkflowNetworkSignal => item !== undefined);
  const findings = stableSortFindings(pairs.flatMap(({ job, step }) => auditStep(job, step)));
  return {
    domain: 'security',
    title: 'Workflow network download provenance audit',
    summary: {
      workflowFiles: files.length,
      networkSteps: signals.length,
      insecureDownloads: signals.reduce((sum, item) => sum + item.insecureUrls, 0),
      dynamicDownloads: signals.reduce((sum, item) => sum + item.dynamicUrls, 0),
      directRemoteExecutions: signals.reduce((sum, item) => sum + item.directExecutionPipes, 0),
      unverifiedExecutedDownloads: signals.reduce((sum, item) => sum + Math.max(0, item.downloadedExecutables - item.verifiedDownloads), 0),
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
