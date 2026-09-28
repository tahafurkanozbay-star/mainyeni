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
  readonly repository: string;
  readonly ref: string;
  readonly path: string;
  readonly persistCredentials: boolean;
  readonly submodules: string;
  readonly clean: boolean;
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

function checkoutSteps(block: WorkflowJobBlock): CheckoutStep[] {
  const result: CheckoutStep[] = [];
  for (let index = 0; index < block.lines.length; index += 1) {
    const current = block.lines[index]!;
    if (!CHECKOUT.test(current.text)) continue;
    const lines: WorkflowLine[] = [];
    for (let next = index + 1; next < block.lines.length; next += 1) {
      const candidate = block.lines[next]!;
      if (candidate.trimmed && candidate.indent <= current.indent && /^\s*-\s+/.test(candidate.text)) break;
      lines.push(candidate);
    }
    result.push({ block, usesLine: current, lines });
  }
  return result;
}

function withFields(step: CheckoutStep): Map<string, string> {
  const fields = new Map<string, string>();
  const withLine = step.lines.find(line => /^\s*with\s*:\s*(?:#.*)?$/i.test(line.text));
  if (!withLine) return fields;

  const candidates: WorkflowLine[] = [];
  for (const line of step.lines) {
    if (line.line <= withLine.line) continue;
    if (line.trimmed && line.indent <= withLine.indent) break;
    if (line.trimmed) candidates.push(line);
  }
  const directIndent = candidates
    .filter(line => FIELD.test(line.text))
    .reduce<number | undefined>((minimum, line) =>
      minimum === undefined || line.indent < minimum ? line.indent : minimum, undefined);
  if (directIndent === undefined) return fields;

  for (const line of candidates) {
    if (line.indent !== directIndent) continue;
    const match = line.text.match(FIELD);
    const key = match?.[1]?.toLowerCase();
    if (!key) continue;
    fields.set(key, stripQuotes(match?.[2] ?? ''));
  }
  return fields;
}

function boolValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value.toLowerCase() === 'true';
}

function signal(step: CheckoutStep): CheckoutBoundarySignal {
  const fields = withFields(step);
  const trigger = workflowTriggerProfile(step.block.file);
  return {
    file: step.block.file.repositoryPath,
    job: step.block.name,
    line: step.usesLine.line,
    repository: fields.get('repository') ?? '${{ github.repository }}',
    ref: fields.get('ref') ?? '',
    path: fields.get('path') ?? '',
    persistCredentials: boolValue(fields.get('persist-credentials'), true),
    submodules: fields.get('submodules') ?? 'false',
    clean: boolValue(fields.get('clean'), true),
    tokenReference: SECRET_REFERENCE.test(fields.get('token') ?? ''),
    sshKeyReference: SECRET_REFERENCE.test(fields.get('ssh-key') ?? ''),
    externalTrigger: trigger.externalContribution,
    writeAuthority: jobHasWriteAuthority(step.block),
    secrets: jobHasSecrets(step.block),
    selfHosted: SELF_HOSTED.test(fieldWithContinuation(step.block, 'runs-on')),
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

function at(current: CheckoutBoundarySignal) {
  return { file: current.file, line: current.line };
}

function repositoryFindings(current: CheckoutBoundarySignal): Finding[] {
  const risk = expressionRisk(current.repository);
  if (risk === 'literal' || risk === 'trusted') return [];
  const blocking = risk === 'event' || risk === 'input';
  return [{
    id: 'ci-checkout-dynamic-repository', domain: 'security',
    severity: blocking ? 'critical' : 'high', ...(blocking ? { blocking: true } : {}),
    title: 'Checkout repository identity is selected dynamically',
    message: `Job ${current.job} selects checkout repository from ${risk}-controlled data. Repository identity determines the executable source tree entering the job.`,
    location: at(current), evidence: { value: current.repository },
    remediation: 'Use a literal owner/repository or github.repository. Map caller inputs to a closed reviewed repository allowlist before checkout.',
    tags: ['ci', 'checkout', 'repository', 'supply-chain'],
  }];
}

function refFindings(current: CheckoutBoundarySignal): Finding[] {
  if (!current.ref) return [];
  const risk = expressionRisk(current.ref);
  if (risk === 'trusted') return [];
  const privileged = current.writeAuthority || current.secrets || current.tokenReference || current.sshKeyReference;
  if (risk === 'event' || risk === 'input') {
    return [{
      id: 'ci-checkout-untrusted-ref', domain: 'security',
      severity: privileged ? 'critical' : 'high', ...(privileged ? { blocking: true } : {}),
      title: 'Checkout ref is controlled outside reviewed workflow source',
      message: `Job ${current.job} checks out a ${risk}-controlled ref${privileged ? ' while privileged credentials or authority are available' : ''}.`,
      location: at(current), evidence: { value: current.ref },
      remediation: 'Use github.sha/base SHA or a validated immutable 40-character commit. Never combine caller/event refs with privileged credentials.',
      tags: ['ci', 'checkout', 'ref', 'provenance'],
    }];
  }
  if (risk === 'upstream') {
    return [{
      id: 'ci-checkout-upstream-ref-review', domain: 'security', severity: privileged ? 'high' : 'medium',
      title: 'Checkout ref comes from an upstream job or matrix value',
      message: `Job ${current.job} relies on computed ref ${current.ref}; upstream provenance must be constrained before it becomes executable source.`,
      location: at(current), evidence: { value: current.ref },
      remediation: 'Validate upstream outputs as immutable commit SHAs and bind them to the expected repository before checkout.',
      tags: ['ci', 'checkout', 'ref', 'provenance'],
    }];
  }
  if (!COMMIT_SHA.test(current.ref) && !/^refs\/(?:heads|tags)\/[A-Za-z0-9._\/-]+$/.test(current.ref)) {
    return [{
      id: 'ci-checkout-mutable-literal-ref', domain: 'build', severity: 'low',
      title: 'Checkout uses a mutable or ambiguous literal ref',
      message: `Job ${current.job} checks out ${current.ref}; release-critical source can move without a workflow diff.`,
      location: at(current), evidence: { value: current.ref },
      remediation: 'Prefer the triggering immutable commit SHA or a reviewed full commit for release-critical source selection.',
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
    id: 'ci-checkout-dynamic-path', domain: 'security', severity: risk === 'event' || risk === 'input' ? 'high' : 'medium',
    title: 'Checkout destination path is selected dynamically',
    message: `Job ${current.job} allows ${risk}-controlled data to choose where source is materialized in the runner workspace.`,
    location: at(current), evidence: { value: current.path },
    remediation: 'Use a literal isolated checkout directory so untrusted values cannot overwrite tooling, evidence, or sibling source trees.',
    tags: ['ci', 'checkout', 'path', 'workspace'],
  }];
}

function credentialFindings(current: CheckoutBoundarySignal): Finding[] {
  const findings: Finding[] = [];
  if (current.externalTrigger && current.persistCredentials) {
    const blocking = current.writeAuthority || current.tokenReference || current.sshKeyReference;
    findings.push({
      id: 'ci-checkout-external-credentials-persist', domain: 'security',
      severity: blocking ? 'critical' : 'high', ...(blocking ? { blocking: true } : {}),
      title: 'Contribution-triggered checkout persists git credentials',
      message: `Job ${current.job} leaves checkout credentials in git configuration while handling externally influenced code.`,
      location: at(current),
      remediation: 'Set persist-credentials: false for validation. Keep authenticated git mutation in a separate trusted job.',
      tags: ['ci', 'checkout', 'credentials', 'pull-request'],
    });
  }
  if (current.externalTrigger && (current.tokenReference || current.sshKeyReference)) {
    findings.push({
      id: 'ci-checkout-external-secret-credential', domain: 'security', severity: 'critical', blocking: true,
      title: 'Contribution-triggered checkout receives an explicit secret credential',
      message: `Job ${current.job} supplies ${current.sshKeyReference ? 'an SSH key' : 'a secret token'} to checkout on an externally influenced workflow.`,
      location: at(current),
      remediation: 'Do not expose deploy keys or elevated tokens to contribution validation; use read-only checkout with credentials disabled.',
      tags: ['ci', 'checkout', 'secrets', 'credentials'],
    });
  }
  return findings;
}

function submoduleFindings(current: CheckoutBoundarySignal): Finding[] {
  if (!current.externalTrigger || !/^(?:true|recursive)$/i.test(current.submodules)) return [];
  const blocking = current.secrets || current.tokenReference || current.sshKeyReference || current.writeAuthority;
  return [{
    id: 'ci-checkout-external-submodules', domain: 'security', severity: blocking ? 'critical' : 'high',
    ...(blocking ? { blocking: true } : {}),
    title: 'Contribution-triggered checkout recursively materializes submodules',
    message: `Job ${current.job} follows repository-controlled submodule metadata on an external event.`,
    location: at(current),
    remediation: 'Disable submodules for untrusted validation or allowlist .gitmodules before a credential-free isolated fetch.',
    tags: ['ci', 'checkout', 'submodules', 'supply-chain'],
  }];
}

function cleanFindings(current: CheckoutBoundarySignal): Finding[] {
  if (current.clean || !current.selfHosted) return [];
  return [{
    id: 'ci-checkout-self-hosted-clean-disabled', domain: 'security',
    severity: current.externalTrigger ? 'critical' : 'high', ...(current.externalTrigger ? { blocking: true } : {}),
    title: 'Self-hosted checkout disables workspace cleaning',
    message: `Job ${current.job} preserves prior workspace state on persistent infrastructure.`,
    location: at(current),
    remediation: 'Keep clean: true on persistent runners and use ephemeral isolated workspaces for contribution-controlled jobs.',
    tags: ['ci', 'checkout', 'self-hosted', 'persistence'],
  }];
}

function findings(current: CheckoutBoundarySignal): Finding[] {
  return [...repositoryFindings(current), ...refFindings(current), ...pathFindings(current),
    ...credentialFindings(current), ...submoduleFindings(current), ...cleanFindings(current)];
}

export function auditCheckoutBoundaries(inventory: RepositoryInventory): AuditSection<CheckoutBoundarySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const signals = files.flatMap(file => workflowJobBlocks(file))
    .flatMap(block => checkoutSteps(block).map(signal));
  const allFindings = stableSortFindings(signals.flatMap(findings));
  return {
    domain: 'security', title: 'GitHub Actions checkout provenance and credential audit',
    summary: {
      workflowFiles: files.length,
      checkoutSteps: signals.length,
      dynamicRepositorySteps: signals.filter(item => !['literal', 'trusted'].includes(expressionRisk(item.repository))).length,
      dynamicRefSteps: signals.filter(item => item.ref && !['literal', 'trusted'].includes(expressionRisk(item.ref))).length,
      credentialedExternalSteps: signals.filter(item => item.externalTrigger && (item.persistCredentials || item.tokenReference || item.sshKeyReference)).length,
      signals, findings: allFindings,
    },
    findings: allFindings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
