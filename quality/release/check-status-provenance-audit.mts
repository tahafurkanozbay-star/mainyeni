import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  hasUntrustedExpression,
  jobHasWriteAuthority,
  workflowFiles,
  workflowJobBlocks,
  workflowTriggerProfile,
  type WorkflowJobBlock,
} from './workflow-structure.mts';
import {
  firstWorkflowStepField,
  stepDisplayName,
  stepNestedMapping,
  stepUsesIdentity,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export interface CheckStatusSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly line: number;
  readonly mutation: 'check-run' | 'commit-status';
  readonly operation: string;
  readonly fields: readonly string[];
  readonly untrustedFields: readonly string[];
  readonly secretFields: readonly string[];
  readonly indirectStateFields: readonly string[];
  readonly writeAuthority: boolean;
  readonly externalContribution: boolean;
}

export interface CheckStatusProvenanceSummary {
  readonly workflowFiles: number;
  readonly mutations: number;
  readonly checkRunMutations: number;
  readonly commitStatusMutations: number;
  readonly untrustedMutations: number;
  readonly secretBearingMutations: number;
  readonly indirectStateMutations: number;
  readonly signals: readonly CheckStatusSignal[];
  readonly findings: readonly Finding[];
}

type FieldKind = 'target' | 'state' | 'display' | 'url' | 'output';

interface ParsedField {
  readonly name: string;
  readonly value: string;
  readonly kind: FieldKind;
  readonly untrusted: boolean;
  readonly secret: boolean;
  readonly indirect: boolean;
}

const CHECK_MUTATION = /\b(?:github\.)?rest\.checks\.(create|update)\s*\(/i;
const STATUS_MUTATION = /\b(?:github\.)?rest\.repos\.createCommitStatus\s*\(/i;
const SECRET_EXPRESSION = /\$\{\{[\s\S]*?secrets\./i;
const ATTACKER_EXPRESSION = /\$\{\{[\s\S]*?(?:github\.event\.|github\.head_ref\b|inputs\.)/i;
const INDIRECT_EXPRESSION = /\$\{\{[\s\S]*?(?:steps\.|needs\.|matrix\.)/i;
const CONTEXT_ATTACKER = /\b(?:context|github\.context)\.payload\b|\b(?:pull_request|issue|comment|review|discussion)\b/i;
const PROCESS_ENV = /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
const FIELD = /\b(name|head_sha|headSha|status|conclusion|details_url|detailsUrl|external_id|externalId|sha|state|target_url|targetUrl|description|context|title|summary|text)\b\s*:\s*([^,}\n]+)/gi;
const SAFE_CHECK_STATUS = /^(?:['"])?(?:queued|in_progress|completed)(?:['"])?$/i;
const SAFE_CHECK_CONCLUSION = /^(?:['"])?(?:success|failure|neutral|cancelled|skipped|timed_out|action_required|stale)(?:['"])?$/i;
const SAFE_COMMIT_STATE = /^(?:['"])?(?:error|failure|pending|success)(?:['"])?$/i;
const HTTP_SCHEME = /^['"]?http:\/\//i;
const DANGEROUS_SCHEME = /^['"]?(?:javascript|data|file|vbscript):/i;
const URL_CREDENTIALS = /^['"]?https?:\/\/[^/@\s]+:[^/@\s]+@/i;

function githubScript(step: WorkflowStepBlock): boolean {
  const identity = stepUsesIdentity(step);
  return identity?.owner?.toLowerCase() === 'actions'
    && identity.repository?.toLowerCase() === 'github-script';
}

function untrustedEnv(step: WorkflowStepBlock): Set<string> {
  const names = new Set<string>();
  for (const [name, value] of stepNestedMapping(step, 'env')) {
    if (ATTACKER_EXPRESSION.test(value) || hasUntrustedExpression(value)) names.add(name);
  }
  return names;
}

function secretEnv(step: WorkflowStepBlock): Set<string> {
  const names = new Set<string>();
  for (const [name, value] of stepNestedMapping(step, 'env')) {
    if (SECRET_EXPRESSION.test(value)) names.add(name);
  }
  return names;
}

function envReferences(value: string): Set<string> {
  const names = new Set<string>();
  const matcher = new RegExp(PROCESS_ENV.source, PROCESS_ENV.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(value)) !== null) {
    const name = match[1];
    if (name) names.add(name);
  }
  return names;
}

function fieldKind(name: string): FieldKind {
  switch (name) {
    case 'head_sha':
    case 'headSha':
    case 'sha':
      return 'target';
    case 'status':
    case 'conclusion':
    case 'state':
      return 'state';
    case 'details_url':
    case 'detailsUrl':
    case 'target_url':
    case 'targetUrl':
      return 'url';
    case 'title':
    case 'summary':
    case 'text':
      return 'output';
    default:
      return 'display';
  }
}

function parsedFields(step: WorkflowStepBlock): ParsedField[] {
  const untrustedNames = untrustedEnv(step);
  const secretNames = secretEnv(step);
  const fields: ParsedField[] = [];
  const matcher = new RegExp(FIELD.source, FIELD.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(step.text)) !== null) {
    const name = match[1] ?? 'metadata';
    const value = (match[2] ?? '').trim();
    const refs = envReferences(value);
    fields.push({
      name,
      value,
      kind: fieldKind(name),
      untrusted: ATTACKER_EXPRESSION.test(value)
        || hasUntrustedExpression(value)
        || CONTEXT_ATTACKER.test(value)
        || [...refs].some(item => untrustedNames.has(item)),
      secret: SECRET_EXPRESSION.test(value) || [...refs].some(item => secretNames.has(item)),
      indirect: INDIRECT_EXPRESSION.test(value) || /\b(?:needs|steps|matrix)\./i.test(value),
    });
  }
  return fields;
}

function signalFor(block: WorkflowJobBlock, step: WorkflowStepBlock): CheckStatusSignal | undefined {
  if (!githubScript(step)) return undefined;
  const check = step.text.match(CHECK_MUTATION);
  const status = step.text.match(STATUS_MUTATION);
  if (!check && !status) return undefined;
  const fields = parsedFields(step);
  const trigger = workflowTriggerProfile(block.file);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    line: firstWorkflowStepField(step, 'uses')?.line ?? step.startLine,
    mutation: check ? 'check-run' : 'commit-status',
    operation: check ? `checks.${check[1] ?? 'mutate'}` : 'repos.createCommitStatus',
    fields: [...new Set(fields.map(item => item.name))].sort(),
    untrustedFields: [...new Set(fields.filter(item => item.untrusted).map(item => item.name))].sort(),
    secretFields: [...new Set(fields.filter(item => item.secret).map(item => item.name))].sort(),
    indirectStateFields: [...new Set(fields.filter(item => item.kind === 'state' && item.indirect).map(item => item.name))].sort(),
    writeAuthority: jobHasWriteAuthority(block),
    externalContribution: trigger.externalContribution,
  };
}

function finding(
  signal: CheckStatusSignal,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  tags: readonly string[],
  blocking = false,
): Finding {
  return {
    id,
    domain: 'security',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: signal.file, line: signal.line },
    evidence: {
      value: signal.operation,
      metadata: {
        job: signal.job,
        step: signal.step,
        mutation: signal.mutation,
        fields: signal.fields.join(','),
      },
    },
    remediation,
    tags,
  };
}

function fieldByName(step: WorkflowStepBlock, names: readonly string[]): ParsedField[] {
  const wanted = new Set(names);
  return parsedFields(step).filter(item => wanted.has(item.name));
}

function targetFindings(step: WorkflowStepBlock, signal: CheckStatusSignal): Finding[] {
  const targets = fieldByName(step, ['head_sha', 'headSha', 'sha']);
  const untrusted = targets.filter(item => item.untrusted);
  if (untrusted.length === 0) return [];
  return [finding(
    signal,
    'ci-check-status-untrusted-target',
    'critical',
    'Check or commit-status target SHA is attacker-influenced',
    'An attacker-controlled event/input can redirect checks:write or statuses:write authority onto an unintended commit.',
    'Bind check/status mutations to github.sha or a separately verified immutable producer commit. Never accept free-form target SHAs from external events or workflow inputs.',
    ['ci', 'checks', 'status', 'sha', 'provenance'],
    true,
  )];
}

function stateFindings(step: WorkflowStepBlock, signal: CheckStatusSignal): Finding[] {
  const state = fieldByName(step, ['status', 'conclusion', 'state']);
  const results: Finding[] = [];
  const untrusted = state.filter(item => item.untrusted);
  if (untrusted.length > 0) {
    results.push(finding(
      signal,
      'ci-check-status-untrusted-state',
      'critical',
      'Check or commit-status result state is attacker-influenced',
      `Result fields (${untrusted.map(item => item.name).join(', ')}) can be selected by event/input data instead of an enforcing validation outcome.`,
      'Map trusted local validation outcomes to a closed literal state/conclusion allowlist inside the privileged mutation step.',
      ['ci', 'checks', 'status', 'result', 'integrity'],
      true,
    ));
  }
  const indirect = state.filter(item => item.indirect && !item.untrusted);
  if (indirect.length > 0) {
    results.push(finding(
      signal,
      'ci-check-status-indirect-state-review',
      'medium',
      'Check or commit-status state is inherited from an indirect output',
      `Result fields (${indirect.map(item => item.name).join(', ')}) come from needs/steps/matrix output and require an explicit closed-state mapping review.`,
      'Convert producer outcomes to a local allowlisted check/status state before mutation rather than forwarding arbitrary output text.',
      ['ci', 'checks', 'status', 'result', 'review'],
      false,
    ));
  }
  for (const item of state.filter(value => !value.untrusted && !value.indirect && !value.secret)) {
    const safe = item.name === 'status'
      ? SAFE_CHECK_STATUS.test(item.value)
      : item.name === 'conclusion'
        ? SAFE_CHECK_CONCLUSION.test(item.value)
        : SAFE_COMMIT_STATE.test(item.value);
    if (!safe && !/^(?:undefined|null)$/i.test(item.value)) {
      results.push(finding(
        signal,
        'ci-check-status-noncanonical-state',
        'high',
        'Check or commit-status state is not a canonical literal',
        `Field ${item.name} uses '${item.value}', which is not in the documented closed state set.`,
        'Use only canonical GitHub check/status states and derive them from trusted validation outcomes.',
        ['ci', 'checks', 'status', 'result', 'canonicalization'],
        signal.writeAuthority,
      ));
    }
  }
  return results;
}

function metadataFindings(step: WorkflowStepBlock, signal: CheckStatusSignal): Finding[] {
  const fields = parsedFields(step);
  const results: Finding[] = [];
  const secret = fields.filter(item => item.secret);
  if (secret.length > 0) {
    results.push(finding(
      signal,
      'ci-check-status-secret-metadata',
      'critical',
      'Check or commit-status metadata contains secret-derived data',
      `Fields (${[...new Set(secret.map(item => item.name))].join(', ')}) can persist or render secret material in GitHub status UI.`,
      'Use secrets only for API authentication. Keep names, descriptions, URLs, output summaries, and state metadata non-sensitive.',
      ['ci', 'checks', 'status', 'metadata', 'secret'],
      true,
    ));
  }

  const display = fields.filter(item => item.untrusted && (item.kind === 'display' || item.kind === 'output'));
  if (display.length > 0) {
    results.push(finding(
      signal,
      'ci-check-status-untrusted-display',
      signal.writeAuthority || signal.externalContribution ? 'critical' : 'high',
      'Check/status display metadata is attacker-influenced',
      `Fields (${[...new Set(display.map(item => item.name))].join(', ')}) can shape authoritative-looking CI status text from external content.`,
      'Generate check names, contexts, descriptions, titles, and summaries from trusted validation data. Bound and sanitize any diagnostic text before publication.',
      ['ci', 'checks', 'status', 'metadata', 'provenance'],
      signal.writeAuthority || signal.externalContribution,
    ));
  }

  const urls = fields.filter(item => item.kind === 'url');
  const untrustedUrls = urls.filter(item => item.untrusted);
  if (untrustedUrls.length > 0) {
    results.push(finding(
      signal,
      'ci-check-status-untrusted-url',
      'critical',
      'Check/status navigation URL is attacker-influenced',
      'An attacker-controlled details_url/target_url can turn trusted CI status UI into a redirect toward an untrusted destination.',
      'Bind status URLs to a reviewed HTTPS CI/deployment origin or trusted producer output; never use event/input text as URL authority.',
      ['ci', 'checks', 'status', 'url', 'provenance'],
      true,
    ));
  }
  for (const item of urls.filter(value => !value.untrusted && !value.secret)) {
    const value = item.value.trim();
    if (DANGEROUS_SCHEME.test(value) || URL_CREDENTIALS.test(value)) {
      results.push(finding(
        signal,
        'ci-check-status-unsafe-url',
        'critical',
        'Check/status navigation URL is unsafe',
        `Field ${item.name} uses an executable/local/data scheme or embeds credentials.`,
        'Use a credential-free HTTPS URL on a reviewed CI or deployment origin.',
        ['ci', 'checks', 'status', 'url'],
        true,
      ));
    } else if (HTTP_SCHEME.test(value)) {
      results.push(finding(
        signal,
        'ci-check-status-plaintext-url',
        'high',
        'Check/status navigation URL uses plaintext HTTP',
        'Status links are operator-facing trust signals and should not downgrade transport security.',
        'Use an absolute HTTPS target URL.',
        ['ci', 'checks', 'status', 'url', 'transport'],
        signal.writeAuthority,
      ));
    }
  }
  return results;
}

function externalAuthorityFindings(signal: CheckStatusSignal): Finding[] {
  if (!signal.externalContribution || !signal.writeAuthority) return [];
  return [finding(
    signal,
    'ci-check-status-external-write-authority',
    'critical',
    'External contribution workflow can publish check/status state',
    'A contribution-controlled trigger reaches explicit GitHub write authority capable of creating authoritative checks or commit statuses.',
    'Keep pull-request validation read-only. Publish privileged check/status mutations only from a trusted follow-up workflow after verifying repository, workflow, event, conclusion, and immutable commit identity.',
    ['ci', 'checks', 'status', 'external-event', 'authority'],
    true,
  )];
}

function analyze(block: WorkflowJobBlock, step: WorkflowStepBlock): { signal: CheckStatusSignal; findings: Finding[] } | undefined {
  const signal = signalFor(block, step);
  if (!signal) return undefined;
  return {
    signal,
    findings: [
      ...targetFindings(step, signal),
      ...stateFindings(step, signal),
      ...metadataFindings(step, signal),
      ...externalAuthorityFindings(signal),
    ],
  };
}

export function auditCheckStatusProvenance(
  inventory: RepositoryInventory,
): AuditSection<CheckStatusProvenanceSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const results = files.flatMap(file => workflowJobBlocks(file)
    .flatMap(block => workflowStepBlocks(block)
      .map(step => analyze(block, step))
      .filter((item): item is { signal: CheckStatusSignal; findings: Finding[] } => item !== undefined)));
  const signals = results.map(item => item.signal);
  const findings = stableSortFindings(results.flatMap(item => item.findings));
  return {
    domain: 'security',
    title: 'GitHub check-run and commit-status provenance audit',
    summary: {
      workflowFiles: files.length,
      mutations: signals.length,
      checkRunMutations: signals.filter(item => item.mutation === 'check-run').length,
      commitStatusMutations: signals.filter(item => item.mutation === 'commit-status').length,
      untrustedMutations: signals.filter(item => item.untrustedFields.length > 0).length,
      secretBearingMutations: signals.filter(item => item.secretFields.length > 0).length,
      indirectStateMutations: signals.filter(item => item.indirectStateFields.length > 0).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
