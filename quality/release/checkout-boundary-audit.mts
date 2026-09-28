import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  fieldWithContinuation,
  jobHasSecrets,
  jobHasWriteAuthority,
  physicalLines,
  workflowFiles,
  workflowJobBlocks,
  workflowTriggerProfile,
  type WorkflowJobBlock,
  type WorkflowLine,
} from './workflow-structure.mts';

export interface CheckoutBoundarySignal {
  readonly file: string;
  readonly job: string;
  readonly line: number;
  readonly actionRef: string;
  readonly repository: string;
  readonly ref: string;
  readonly path: string;
  readonly persistCredentials: boolean;
  readonly persistCredentialsExplicit: boolean;
  readonly submodules: string;
  readonly clean: boolean;
  readonly lfs: boolean;
  readonly tokenReference: boolean;
  readonly sshKeyReference: boolean;
  readonly externalTrigger: boolean;
  readonly writeAuthority: boolean;
  readonly secrets: boolean;
  readonly selfHosted: boolean;
}

export interface CheckoutBoundarySummary {
  readonly workflowFiles: number;
  readonly checkoutSteps: number;
  readonly dynamicRepositorySteps: number;
  readonly dynamicRefSteps: number;
  readonly credentialedExternalSteps: number;
  readonly signals: readonly CheckoutBoundarySignal[];
  readonly findings: readonly Finding[];
}

interface CheckoutStep {
  readonly block: WorkflowJobBlock;
  readonly usesLine: WorkflowLine;
  readonly lines: readonly WorkflowLine[];
}

const CHECKOUT = /^\s*-?\s*uses\s*:\s*actions\/checkout@([^\s#]+)(?:\s+#.*)?$/i;
const FIELD = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*(?:#.*)?$/;
const EXPRESSION = /\$\{\{[\s\S]*?\}\}/;
const EVENT_SOURCE = /\$\{\{[\s\S]*?(?:github\.event\.|github\.head_ref\b)[\s\S]*?\}\}/i;
const INPUT_SOURCE = /\$\{\{[\s\S]*?inputs\.[\s\S]*?\}\}/i;
const UPSTREAM_SOURCE = /\$\{\{[\s\S]*?(?:needs\.|matrix\.)[\s\S]*?\}\}/i;
const TRUSTED_REF = /^\$\{\{\s*(?:github\.sha|github\.ref|github\.ref_name|github\.event\.pull_request\.base\.sha|github\.event\.pull_request\.merge_commit_sha)\s*\}\}$/i;
const TRUSTED_REPOSITORY = /^\$\{\{\s*github\.repository\s*\}\}$/i;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const SECRET_REFERENCE = /\$\{\{\s*secrets\./i;
const SELF_HOSTED = /(?:^|[\s,\[])self-hosted(?:$|[\s,\]])/i;

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stepFields(step: CheckoutStep): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of step.lines) {
    const match = line.text.match(FIELD);
    const key = match?.[1]?.toLowerCase();
    if (!key) continue;
    fields.set(key, stripQuotes(match?.[2] ?? ''));
  }
  return fields;
}

function checkoutSteps(block: WorkflowJobBlock): CheckoutStep[] {
  const steps: CheckoutStep[] = [];
  const lines = block.lines;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!CHECKOUT.test(line.text)) continue;
    const nested: WorkflowLine[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next]!;
      if (candidate.trimmed && candidate.indent <= line.indent && /^\s*-\s+/.test(candidate.text)) break;
      if (candidate.trimmed) nested.push(candidate);
    }
    steps.push({ block, usesLine: line, lines: nested });
  }
  return steps;
}

function boolValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value.toLowerCase() === 'true';
}

function signal(step: CheckoutStep): CheckoutBoundarySignal {
  const fields = stepFields(step);
  const trigger = workflowTriggerProfile(step.block.file);
  const runsOn = fieldWithContinuation(step.block, 'runs-on');
  const checkoutMatch = step.usesLine.text.match(CHECKOUT);
  const persistRaw = fields.get('persist-credentials');
  return {
    file: step.block.file.repositoryPath,
    job: step.block.name,
    line: step.usesLine.line,
    actionRef: checkoutMatch?.[1] ?? '',
    repository: fields.get('repository') ?? '${{ github.repository }}',
    ref: fields.get('ref') ?? '',
    path: fields.get('path') ?? '',
    persistCredentials: boolValue(persistRaw, true),
    persistCredentialsExplicit: persistRaw !== undefined,
    submodules: fields.get('submodules') ?? 'false',
    clean: boolValue(fields.get('clean'), true),
    lfs: boolValue(fields.get('lfs'), false),
    tokenReference: SECRET_REFERENCE.test(fields.get('token') ?? ''),
    sshKeyReference: SECRET_REFERENCE.test(fields.get('ssh-key') ?? ''),
    externalTrigger: trigger.externalContribution,
    writeAuthority: jobHasWriteAuthority(step.block),
    secrets: jobHasSecrets(step.block),
    selfHosted: SELF_HOSTED.test(runsOn),
  };
}

function expressionRisk(value: string): 'event' | 'input' | 'upstream' | 'trusted' | 'literal' {
  if (!value || !EXPRESSION.test(value)) return 'literal';
  if (TRUSTED_REF.test(value) || TRUSTED_REPOSITORY.test(value)) return 'trusted';
  if (EVENT_SOURCE.test(value)) return 'event';
  if (INPUT_SOURCE.test(value)) return 'input';
  if (UPSTREAM_SOURCE.test(value)) return 'upstream';
  return 'upstream';
}

function location(current: CheckoutBoundarySignal) {
  return { file: current.file, line: current.line };
}

function repositoryFindings(current: CheckoutBoundarySignal): Finding[] {
  const risk = expressionRisk(current.repository);
  if (risk === 'literal' || risk === 'trusted') return [];
  const critical = risk === 'event' || risk === 'input';
  return [{
    id: 'ci-checkout-dynamic-repository',
    domain: 'security',
    severity: critical ? 'critical' : 'high',
    ...(critical ? { blocking: true } : {}),
    title: 'Checkout repository identity is selected dynamically',
    message: `Job ${current.job} selects checkout repository from ${risk}-controlled data. Repository identity determines the executable source tree entering the job.`,
    location: location(current),
    evidence: { value: current.repository },
    remediation: 'Use a literal owner/repository or github.repository. If a reusable workflow must support multiple repositories, map a validated closed identifier to literal repository names before checkout.',
    tags: ['ci', 'checkout', 'repository', 'supply-chain'],
  }];
}

function refFindings(current: CheckoutBoundarySignal): Finding[] {
  if (!current.ref) return [];
  const risk = expressionRisk(current.ref);
  if (risk === 'trusted') return [];
  const privileged = current.writeAuthority || current.secrets || current.tokenReference || current.sshKeyReference;
  if (risk === 'event' || risk === 'input') {
    const critical = privileged;
    return [{
      id: 'ci-checkout-untrusted-ref',
      domain: 'security',
      severity: critical ? 'critical' : 'high',
      ...(critical ? { blocking: true } : {}),
      title: 'Checkout ref is controlled outside reviewed workflow source',
      message: `Job ${current.job} checks out a ${risk}-controlled ref${privileged ? ' while privileged credentials or authority are available' : ''}.`,
      location: location(current),
      evidence: { value: current.ref },
      remediation: 'Use github.sha/base SHA for validation or map approved inputs to immutable commit SHAs. Never combine caller/event-controlled refs with write tokens, secrets, deploy keys, or release credentials.',
      tags: ['ci', 'checkout', 'ref', 'provenance'],
    }];
  }
  if (risk === 'upstream') {
    return [{
      id: 'ci-checkout-upstream-ref-review',
      domain: 'security',
      severity: privileged ? 'high' : 'medium',
      title: 'Checkout ref comes from an upstream job or matrix value',
      message: `Job ${current.job} relies on computed ref ${current.ref}; upstream provenance must be constrained before it becomes executable source.`,
      location: location(current),
      evidence: { value: current.ref },
      remediation: 'Validate upstream outputs against immutable commit SHA syntax and repository identity before checkout.',
      tags: ['ci', 'checkout', 'ref', 'provenance'],
    }];
  }
  if (!COMMIT_SHA.test(current.ref) && !/^refs\/(?:heads|tags)\/[A-Za-z0-9._\/-]+$/.test(current.ref)) {
    return [{
      id: 'ci-checkout-mutable-literal-ref',
      domain: 'build',
      severity: 'low',
      title: 'Checkout uses a mutable or ambiguous literal ref',
      message: `Job ${current.job} checks out ${current.ref}; release-critical source can move without a workflow diff.`,
      location: location(current),
      evidence: { value: current.ref },
      remediation: 'Prefer the triggering immutable commit SHA or a reviewed full 40-character commit for release-critical source selection.',
      tags: ['ci', 'checkout', 'reproducibility'],
    }];
  }
  return [];
}

function pathFindings(current: CheckoutBoundarySignal): Finding[] {
  if (!current.path) return [];
  const risk = expressionRisk(current.path);
  if (risk === 'literal' || risk === 'trusted') return [];
  return [{
    id: 'ci-checkout-dynamic-path',
    domain: 'security',
    severity: risk === 'event' || risk === 'input' ? 'high' : 'medium',
    title: 'Checkout destination path is selected dynamically',
    message: `Job ${current.job} allows ${risk}-controlled data to choose where source is materialized in the runner workspace.`,
    location: location(current),
    evidence: { value: current.path },
    remediation: 'Use a literal isolated checkout directory. Do not allow event, caller, or upstream values to overwrite tooling, sibling checkouts, generated evidence, or executable paths.',
    tags: ['ci', 'checkout', 'path', 'workspace'],
  }];
}

function credentialFindings(current: CheckoutBoundarySignal): Finding[] {
  const findings: Finding[] = [];
  if (current.externalTrigger && current.persistCredentials) {
    const critical = current.writeAuthority || current.tokenReference || current.sshKeyReference;
    findings.push({
      id: 'ci-checkout-external-credentials-persist',
      domain: 'security',
      severity: critical ? 'critical' : 'high',
      ...(critical ? { blocking: true } : {}),
      title: 'Contribution-triggered checkout persists git credentials',
      message: `Job ${current.job} leaves checkout credentials in git configuration while handling externally influenced code${critical ? ' with elevated credential authority' : ''}.`,
      location: location(current),
      remediation: 'Set persist-credentials: false for validation jobs. Perform authenticated git mutation only in a separate trusted job that does not execute contribution-controlled code.',
      tags: ['ci', 'checkout', 'credentials', 'pull-request'],
    });
  }
  if (current.externalTrigger && (current.tokenReference || current.sshKeyReference)) {
    findings.push({
      id: 'ci-checkout-external-secret-credential',
      domain: 'security',
      severity: 'critical',
      blocking: true,
      title: 'Contribution-triggered checkout receives an explicit secret credential',
      message: `Job ${current.job} supplies ${current.sshKeyReference ? 'an SSH key' : 'a secret token'} to checkout on an externally influenced workflow.`,
      location: location(current),
      remediation: 'Do not provide deploy keys or elevated tokens to contribution validation. Use the read-only default token with persist-credentials disabled or move privileged checkout to a trusted protected workflow.',
      tags: ['ci', 'checkout', 'secrets', 'credentials'],
    });
  }
  return findings;
}

function submoduleFindings(current: CheckoutBoundarySignal): Finding[] {
  if (!/^(?:true|recursive)$/i.test(current.submodules)) return [];
  if (!current.externalTrigger) return [];
  const privileged = current.secrets || current.tokenReference || current.sshKeyReference || current.writeAuthority;
  return [{
    id: 'ci-checkout-external-submodules',
    domain: 'security',
    severity: privileged ? 'critical' : 'high',
    ...(privileged ? { blocking: true } : {}),
    title: 'Contribution-triggered checkout recursively materializes submodules',
    message: `Job ${current.job} follows repository-controlled submodule metadata on an external event${privileged ? ' while privileged credentials are present' : ''}.`,
    location: location(current),
    remediation: 'Disable submodules for untrusted contribution validation or validate .gitmodules against an allowlist before a credential-free isolated submodule fetch.',
    tags: ['ci', 'checkout', 'submodules', 'supply-chain'],
  }];
}

function cleanFindings(current: CheckoutBoundarySignal): Finding[] {
  if (current.clean || !current.selfHosted) return [];
  return [{
    id: 'ci-checkout-self-hosted-clean-disabled',
    domain: 'security',
    severity: current.externalTrigger ? 'critical' : 'high',
    ...(current.externalTrigger ? { blocking: true } : {}),
    title: 'Self-hosted checkout disables workspace cleaning',
    message: `Job ${current.job} preserves prior workspace state on persistent infrastructure${current.externalTrigger ? ' reachable from external events' : ''}.`,
    location: location(current),
    remediation: 'Keep clean: true on persistent runners and use ephemeral isolated workspaces for contribution-controlled jobs.',
    tags: ['ci', 'checkout', 'self-hosted', 'persistence'],
  }];
}

function findings(current: CheckoutBoundarySignal): Finding[] {
  return [
    ...repositoryFindings(current),
    ...refFindings(current),
    ...pathFindings(current),
    ...credentialFindings(current),
    ...submoduleFindings(current),
    ...cleanFindings(current),
  ];
}

export function auditCheckoutBoundaries(inventory: RepositoryInventory): AuditSection<CheckoutBoundarySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const blocks = files.flatMap(file => workflowJobBlocks(file));
  const checkoutSignals = blocks.flatMap(block => checkoutSteps(block).map(signal));
  const allFindings = stableSortFindings(checkoutSignals.flatMap(findings));
  return {
    domain: 'security',
    title: 'GitHub Actions checkout provenance and credential audit',
    summary: {
      workflowFiles: files.length,
      checkoutSteps: checkoutSignals.length,
      dynamicRepositorySteps: checkoutSignals.filter(item => expressionRisk(item.repository) !== 'literal' && expressionRisk(item.repository) !== 'trusted').length,
      dynamicRefSteps: checkoutSignals.filter(item => item.ref && expressionRisk(item.ref) !== 'literal' && expressionRisk(item.ref) !== 'trusted').length,
      credentialedExternalSteps: checkoutSignals.filter(item => item.externalTrigger && (item.persistCredentials || item.tokenReference || item.sshKeyReference)).length,
      signals: checkoutSignals,
      findings: allFindings,
    },
    findings: allFindings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
