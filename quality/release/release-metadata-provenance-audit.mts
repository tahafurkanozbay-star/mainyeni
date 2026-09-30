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

export interface ReleaseMetadataSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly line: number;
  readonly channel: 'release-action' | 'github-script';
  readonly identity: string;
  readonly metadataFields: readonly string[];
  readonly untrustedFields: readonly string[];
  readonly secretFields: readonly string[];
  readonly stateFields: readonly string[];
  readonly bodyPathFields: readonly string[];
  readonly writeAuthority: boolean;
}

export interface ReleaseMetadataProvenanceSummary {
  readonly workflowFiles: number;
  readonly releaseMutations: number;
  readonly untrustedMutations: number;
  readonly secretBearingMutations: number;
  readonly dynamicStateMutations: number;
  readonly bodyPathMutations: number;
  readonly signals: readonly ReleaseMetadataSignal[];
  readonly findings: readonly Finding[];
}

type RiskKind = 'display' | 'body-path' | 'state';

interface FieldPolicy {
  readonly canonical: string;
  readonly aliases: readonly string[];
  readonly kind: RiskKind;
}

interface FieldRisk {
  readonly field: string;
  readonly value: string;
  readonly kind: RiskKind;
  readonly untrusted: boolean;
  readonly secret: boolean;
  readonly indirect: boolean;
}

const SOFTPROPS = 'softprops/action-gh-release';
const NICIPOLLO = 'ncipollo/release-action';
const CREATE_RELEASE = 'actions/create-release';
const RELEASE_ACTIONS = new Set([SOFTPROPS, NICIPOLLO, CREATE_RELEASE]);
const SECRET_EXPRESSION = /\$\{\{[\s\S]*?secrets\./i;
const ATTACKER_EXPRESSION = /\$\{\{[\s\S]*?(?:github\.event\.|github\.head_ref\b|inputs\.)/i;
const INDIRECT_EXPRESSION = /\$\{\{[\s\S]*?(?:steps\.|needs\.)/i;
const SECRETISH_PATH = /(?:^|[\/\\])(?:\.env(?:\.[^\/\\]+)?|\.git|id_(?:rsa|ed25519)|credentials?(?:\.[^\/\\]+)?|secrets?(?:\.[^\/\\]+)?)(?:[\/\\]|$)/i;
const TRAVERSAL = /(?:^|[\/\\])\.\.(?:[\/\\]|$)/;
const ABSOLUTE_HOST_PATH = /^(?:\/|[A-Za-z]:[\/\\]|~[\/\\])/;
const CREATE_OR_UPDATE_RELEASE = /\b(?:github\.)?rest\.repos\.(?:createRelease|updateRelease)\s*\(|\b(?:createRelease|updateRelease)\s*\(/i;
const SCRIPT_FIELD = /\b(name|body|draft|prerelease|make_latest|makeLatest|generate_release_notes|generateReleaseNotes|discussion_category_name|discussionCategory)\b\s*:\s*([^,}\n]+)/gi;
const PROCESS_ENV = /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
const CONTEXT_ATTACKER = /\b(?:context|github\.context)\.payload\b|\b(?:pull_request|issue|comment|review|discussion)\b/i;
const STATE_FIELDS = new Set(['draft', 'prerelease', 'make_latest', 'makeLatest', 'generate_release_notes', 'generateReleaseNotes']);

const FIELD_POLICIES: readonly FieldPolicy[] = [
  { canonical: 'name', aliases: ['name', 'release_name'], kind: 'display' },
  { canonical: 'body', aliases: ['body'], kind: 'display' },
  { canonical: 'body_path', aliases: ['body_path', 'bodyFile', 'body_file'], kind: 'body-path' },
  { canonical: 'discussion_category', aliases: ['discussion_category_name', 'discussionCategory'], kind: 'display' },
  { canonical: 'draft', aliases: ['draft'], kind: 'state' },
  { canonical: 'prerelease', aliases: ['prerelease'], kind: 'state' },
  { canonical: 'make_latest', aliases: ['make_latest', 'makeLatest'], kind: 'state' },
  { canonical: 'generate_release_notes', aliases: ['generate_release_notes', 'generateReleaseNotes'], kind: 'state' },
];

function releaseAction(step: WorkflowStepBlock): string | undefined {
  const identity = stepUsesIdentity(step);
  if (!identity?.owner || !identity.repository) return undefined;
  const ownerRepo = `${identity.owner}/${identity.repository}`.toLowerCase();
  return RELEASE_ACTIONS.has(ownerRepo) ? ownerRepo : undefined;
}

function policyValue(mapping: ReadonlyMap<string, string>, policy: FieldPolicy): { key: string; value: string } | undefined {
  for (const alias of policy.aliases) {
    const value = mapping.get(alias);
    if (value !== undefined) return { key: alias, value };
  }
  return undefined;
}

function actionRisks(step: WorkflowStepBlock): FieldRisk[] {
  const mapping = stepNestedMapping(step, 'with');
  const risks: FieldRisk[] = [];
  for (const policy of FIELD_POLICIES) {
    const entry = policyValue(mapping, policy);
    if (!entry) continue;
    const value = entry.value.trim();
    risks.push({
      field: policy.canonical,
      value,
      kind: policy.kind,
      untrusted: ATTACKER_EXPRESSION.test(value) || hasUntrustedExpression(value),
      secret: SECRET_EXPRESSION.test(value),
      indirect: INDIRECT_EXPRESSION.test(value),
    });
  }
  return risks;
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

function scriptRisks(step: WorkflowStepBlock): FieldRisk[] {
  if (!CREATE_OR_UPDATE_RELEASE.test(step.text)) return [];
  const risks: FieldRisk[] = [];
  const untrustedNames = untrustedEnv(step);
  const secretNames = secretEnv(step);
  const matcher = new RegExp(SCRIPT_FIELD.source, SCRIPT_FIELD.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(step.text)) !== null) {
    const field = match[1] ?? 'metadata';
    const value = (match[2] ?? '').trim();
    const refs = envReferences(value);
    risks.push({
      field,
      value,
      kind: STATE_FIELDS.has(field) ? 'state' : 'display',
      untrusted: ATTACKER_EXPRESSION.test(value)
        || hasUntrustedExpression(value)
        || CONTEXT_ATTACKER.test(value)
        || [...refs].some(name => untrustedNames.has(name)),
      secret: SECRET_EXPRESSION.test(value) || [...refs].some(name => secretNames.has(name)),
      indirect: /\b(?:needs|steps)\./i.test(value),
    });
  }
  return risks;
}

function releaseSignal(block: WorkflowJobBlock, step: WorkflowStepBlock): ReleaseMetadataSignal | undefined {
  const action = releaseAction(step);
  const githubScript = stepUsesIdentity(step)?.owner?.toLowerCase() === 'actions'
    && stepUsesIdentity(step)?.repository?.toLowerCase() === 'github-script'
    && CREATE_OR_UPDATE_RELEASE.test(step.text);
  if (!action && !githubScript) return undefined;
  const risks = action ? actionRisks(step) : scriptRisks(step);
  if (risks.length === 0 && !action) return undefined;
  const bodyPaths = risks.filter(item => item.kind === 'body-path').map(item => item.field);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    line: firstWorkflowStepField(step, 'uses')?.line ?? step.startLine,
    channel: action ? 'release-action' : 'github-script',
    identity: action ?? 'actions/github-script',
    metadataFields: [...new Set(risks.map(item => item.field))].sort(),
    untrustedFields: [...new Set(risks.filter(item => item.untrusted).map(item => item.field))].sort(),
    secretFields: [...new Set(risks.filter(item => item.secret).map(item => item.field))].sort(),
    stateFields: [...new Set(risks.filter(item => item.kind === 'state' && (item.untrusted || item.secret)).map(item => item.field))].sort(),
    bodyPathFields: bodyPaths,
    writeAuthority: jobHasWriteAuthority(block),
  };
}

function finding(
  signal: ReleaseMetadataSignal,
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
    domain: 'release',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: signal.file, line: signal.line },
    evidence: {
      value: signal.identity,
      metadata: {
        job: signal.job,
        step: signal.step,
        channel: signal.channel,
        fields: signal.metadataFields.join(','),
      },
    },
    remediation,
    tags,
  };
}

function actionBodyPathFindings(block: WorkflowJobBlock, step: WorkflowStepBlock, signal: ReleaseMetadataSignal): Finding[] {
  if (signal.channel !== 'release-action') return [];
  const mapping = stepNestedMapping(step, 'with');
  const results: Finding[] = [];
  for (const policy of FIELD_POLICIES.filter(item => item.kind === 'body-path')) {
    const entry = policyValue(mapping, policy);
    if (!entry) continue;
    const value = entry.value.trim();
    if (SECRETISH_PATH.test(value)) {
      results.push(finding(
        signal,
        'ci-release-metadata-sensitive-body-path',
        'critical',
        'Release body file points at sensitive repository or credential material',
        `Release metadata reads body content from sensitive-looking path '${value}'. Publishing that content can exfiltrate credentials or repository control data.`,
        'Generate release notes into a dedicated non-sensitive file and publish only that reviewed path.',
        ['ci', 'release', 'metadata', 'exfiltration'],
        true,
      ));
    }
    if (TRAVERSAL.test(value) || ABSOLUTE_HOST_PATH.test(value)) {
      results.push(finding(
        signal,
        'ci-release-metadata-body-path-boundary',
        'high',
        'Release body file escapes the repository note boundary',
        `Release metadata body path '${value}' is absolute or traverses parent directories.`,
        'Use a repository-owned generated release-note path without absolute roots or parent traversal.',
        ['ci', 'release', 'metadata', 'filesystem'],
        signal.writeAuthority,
      ));
    }
    if (ATTACKER_EXPRESSION.test(value) || hasUntrustedExpression(value)) {
      results.push(finding(
        signal,
        'ci-release-metadata-untrusted-body-path',
        'critical',
        'Release body file path is attacker-influenced',
        'External event or manual input data can select which runner file is read into public release metadata.',
        'Keep release body_path/bodyFile literal or derive it only from a trusted fixed producer contract.',
        ['ci', 'release', 'metadata', 'filesystem', 'provenance'],
        true,
      ));
    }
  }
  return results;
}

function findingsFor(block: WorkflowJobBlock, step: WorkflowStepBlock, signal: ReleaseMetadataSignal): Finding[] {
  const results: Finding[] = [];
  if (signal.secretFields.length > 0) {
    results.push(finding(
      signal,
      'ci-release-metadata-secret-exposure',
      'critical',
      'Release metadata contains secret-derived content',
      `Release metadata fields (${signal.secretFields.join(', ')}) are derived from secrets and can become public or persist in GitHub release history.`,
      'Use secrets only for publication authentication. Keep release titles, bodies, discussion metadata, and visibility state non-sensitive.',
      ['ci', 'release', 'metadata', 'secret'],
      true,
    ));
  }

  const untrustedDisplay = signal.untrustedFields.filter(field => !STATE_FIELDS.has(field) && field !== 'body_path');
  if (untrustedDisplay.length > 0) {
    results.push(finding(
      signal,
      'ci-release-metadata-untrusted-display',
      signal.writeAuthority ? 'critical' : 'high',
      'Release display metadata is attacker-influenced',
      `Release fields (${untrustedDisplay.join(', ')}) can be shaped by pull-request/event text or free-form workflow inputs.`,
      'Generate release display metadata from trusted repository history or a reviewed release-notes producer, not external event content or free-form publication inputs.',
      ['ci', 'release', 'metadata', 'provenance'],
      signal.writeAuthority,
    ));
  }

  if (signal.stateFields.length > 0) {
    results.push(finding(
      signal,
      'ci-release-metadata-untrusted-state',
      'critical',
      'Release publication state is attacker-influenced',
      `Release state fields (${signal.stateFields.join(', ')}) can alter draft, prerelease, latest, or generated-notes behavior from untrusted data.`,
      'Keep release visibility/latest-state controls literal and reviewed. Do not let external events or free-form inputs choose publication state.',
      ['ci', 'release', 'metadata', 'state', 'integrity'],
      true,
    ));
  }

  results.push(...actionBodyPathFindings(block, step, signal));
  return results;
}

function analyzeStep(block: WorkflowJobBlock, step: WorkflowStepBlock): { signal: ReleaseMetadataSignal; findings: Finding[] } | undefined {
  const signal = releaseSignal(block, step);
  if (!signal) return undefined;
  return { signal, findings: findingsFor(block, step, signal) };
}

export function auditReleaseMetadataProvenance(
  inventory: RepositoryInventory,
): AuditSection<ReleaseMetadataProvenanceSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const results = files.flatMap(file => workflowJobBlocks(file)
    .flatMap(block => workflowStepBlocks(block)
      .map(step => analyzeStep(block, step))
      .filter((item): item is { signal: ReleaseMetadataSignal; findings: Finding[] } => item !== undefined)));
  const signals = results.map(item => item.signal);
  const findings = stableSortFindings(results.flatMap(item => item.findings));
  return {
    domain: 'release',
    title: 'GitHub release metadata provenance audit',
    summary: {
      workflowFiles: files.length,
      releaseMutations: signals.length,
      untrustedMutations: signals.filter(item => item.untrustedFields.length > 0).length,
      secretBearingMutations: signals.filter(item => item.secretFields.length > 0).length,
      dynamicStateMutations: signals.filter(item => item.stateFields.length > 0).length,
      bodyPathMutations: signals.filter(item => item.bodyPathFields.length > 0).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
