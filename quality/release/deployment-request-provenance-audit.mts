import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  hasUntrustedExpression,
  jobHasWriteAuthority,
  jobUsesProtectedEnvironment,
  workflowFiles,
  workflowJobBlocks,
  workflowTriggerProfile,
  type WorkflowJobBlock,
} from './workflow-structure.mts';
import {
  firstWorkflowStepField,
  stepDisplayName,
  stepNestedMapping,
  stepRunText,
  stepUsesIdentity,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export interface DeploymentRequestSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly line: number;
  readonly channel: 'github-script' | 'gh-api';
  readonly fields: readonly string[];
  readonly untrustedFields: readonly string[];
  readonly secretFields: readonly string[];
  readonly indirectFields: readonly string[];
  readonly explicitRequiredContextsBypass: boolean;
  readonly writeAuthority: boolean;
  readonly protectedEnvironment: boolean;
  readonly externalContribution: boolean;
}

export interface DeploymentRequestProvenanceSummary {
  readonly workflowFiles: number;
  readonly deploymentRequests: number;
  readonly untrustedRequests: number;
  readonly secretBearingRequests: number;
  readonly requiredContextBypasses: number;
  readonly githubScriptRequests: number;
  readonly ghApiRequests: number;
  readonly signals: readonly DeploymentRequestSignal[];
  readonly findings: readonly Finding[];
}

type FieldKind = 'ref' | 'environment' | 'payload' | 'guard' | 'display';

interface ParsedField {
  readonly name: string;
  readonly value: string;
  readonly kind: FieldKind;
  readonly untrusted: boolean;
  readonly secret: boolean;
  readonly indirect: boolean;
}

const CREATE_DEPLOYMENT = /\b(?:github\.)?rest\.repos\.createDeployment\s*\(|\bcreateDeployment\s*\(/i;
const GH_API = /\bgh\s+api\b/i;
const GH_API_DEPLOYMENT = /(?:^|[\s'"`])(?:https:\/\/api\.github\.com\/repos\/[^\s'"`]+\/deployments|repos\/[^\s'"`]+\/deployments|\/repos\/[^\s'"`]+\/deployments)(?:[\s'"`]|$)/i;
const POST_METHOD = /(?:--method|-X)\s+POST\b/i;
const FIELD = /\b(ref|task|environment|description|payload|auto_merge|autoMerge|required_contexts|requiredContexts|transient_environment|transientEnvironment|production_environment|productionEnvironment)\b\s*:\s*([^,}\n]+)/gi;
const CLI_FIELD = /(?:^|\s)(?:-f|--field|-F|--raw-field)\s+([A-Za-z_][A-Za-z0-9_-]*)=([^\s\\]+)/g;
const SECRET_EXPRESSION = /\$\{\{[\s\S]*?secrets\./i;
const ATTACKER_EXPRESSION = /\$\{\{[\s\S]*?(?:github\.event\.|github\.head_ref\b|inputs\.)/i;
const INDIRECT_EXPRESSION = /\$\{\{[\s\S]*?(?:steps\.|needs\.|matrix\.)/i;
const CONTEXT_ATTACKER = /\b(?:context|github\.context)\.payload\b|\b(?:pull_request|issue|comment|review|discussion)\b/i;
const PROCESS_ENV = /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
const SHELL_ENV = /\$(?:\{)?([A-Za-z_][A-Za-z0-9_]*)(?:\})?/g;
const SAFE_REF = /^['"](?:[A-Za-z0-9._\/-]+)['"]$|^['"]?\$\{\{\s*github\.(?:sha|ref|ref_name)\s*\}\}['"]?$/i;
const EMPTY_CONTEXTS = /^\s*(?:\[\s*\]|['"]\[\]['"]|['"]?['"]?)\s*$/;
const BOOLEAN_LITERAL = /^(?:true|false|'true'|'false'|"true"|"false")$/i;
const SAFE_TASK = /^['"][A-Za-z0-9._-]+['"]$/;
const SAFE_ENVIRONMENT = /^['"][A-Za-z0-9._ /-]+['"]$/;

function githubScript(step: WorkflowStepBlock): boolean {
  const identity = stepUsesIdentity(step);
  return identity?.owner?.toLowerCase() === 'actions'
    && identity.repository?.toLowerCase() === 'github-script';
}

function untrustedEnv(step: WorkflowStepBlock): Set<string> {
  const result = new Set<string>();
  for (const [name, value] of stepNestedMapping(step, 'env')) {
    if (ATTACKER_EXPRESSION.test(value) || hasUntrustedExpression(value)) result.add(name);
  }
  return result;
}

function secretEnv(step: WorkflowStepBlock): Set<string> {
  const result = new Set<string>();
  for (const [name, value] of stepNestedMapping(step, 'env')) {
    if (SECRET_EXPRESSION.test(value)) result.add(name);
  }
  return result;
}

function envReferences(value: string, shell = false): Set<string> {
  const result = new Set<string>();
  const source = shell ? SHELL_ENV : PROCESS_ENV;
  const matcher = new RegExp(source.source, source.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(value)) !== null) {
    const name = match[1];
    if (name) result.add(name);
  }
  return result;
}

function kind(name: string): FieldKind {
  if (name === 'ref') return 'ref';
  if (name === 'environment') return 'environment';
  if (name === 'payload') return 'payload';
  if (/^(?:auto_merge|autoMerge|required_contexts|requiredContexts|transient_environment|transientEnvironment|production_environment|productionEnvironment)$/.test(name)) return 'guard';
  return 'display';
}

function risk(name: string, value: string, step: WorkflowStepBlock, shell = false): ParsedField {
  const refs = envReferences(value, shell);
  const untrustedNames = untrustedEnv(step);
  const secretNames = secretEnv(step);
  return {
    name,
    value,
    kind: kind(name),
    untrusted: ATTACKER_EXPRESSION.test(value)
      || hasUntrustedExpression(value)
      || (!shell && CONTEXT_ATTACKER.test(value))
      || [...refs].some(item => untrustedNames.has(item)),
    secret: SECRET_EXPRESSION.test(value) || [...refs].some(item => secretNames.has(item)),
    indirect: INDIRECT_EXPRESSION.test(value) || /\b(?:needs|steps|matrix)\./i.test(value),
  };
}

function scriptFields(step: WorkflowStepBlock): ParsedField[] {
  const result: ParsedField[] = [];
  const matcher = new RegExp(FIELD.source, FIELD.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(step.text)) !== null) {
    const name = match[1] ?? 'unknown';
    result.push(risk(name, (match[2] ?? '').trim(), step));
  }
  return result;
}

function cliFields(step: WorkflowStepBlock): ParsedField[] {
  const run = stepRunText(step) ?? '';
  const result: ParsedField[] = [];
  const matcher = new RegExp(CLI_FIELD.source, CLI_FIELD.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(run)) !== null) {
    const name = match[1] ?? 'unknown';
    if (!['ref', 'task', 'environment', 'description', 'payload', 'auto_merge', 'required_contexts', 'transient_environment', 'production_environment'].includes(name)) continue;
    result.push(risk(name, (match[2] ?? '').trim(), step, true));
  }
  return result;
}

function requestChannel(step: WorkflowStepBlock): 'github-script' | 'gh-api' | undefined {
  if (githubScript(step) && CREATE_DEPLOYMENT.test(step.text)) return 'github-script';
  const run = stepRunText(step);
  if (run && GH_API.test(run) && GH_API_DEPLOYMENT.test(run) && POST_METHOD.test(run)) return 'gh-api';
  return undefined;
}

function fieldsFor(step: WorkflowStepBlock, channel: 'github-script' | 'gh-api'): ParsedField[] {
  return channel === 'github-script' ? scriptFields(step) : cliFields(step);
}

function requiredContextsBypass(fields: readonly ParsedField[]): boolean {
  return fields.some(item => (item.name === 'required_contexts' || item.name === 'requiredContexts') && EMPTY_CONTEXTS.test(item.value));
}

function signalFor(block: WorkflowJobBlock, step: WorkflowStepBlock): DeploymentRequestSignal | undefined {
  const channel = requestChannel(step);
  if (!channel) return undefined;
  const fields = fieldsFor(step, channel);
  const trigger = workflowTriggerProfile(block.file);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    line: firstWorkflowStepField(step, channel === 'github-script' ? 'uses' : 'run')?.line ?? step.startLine,
    channel,
    fields: [...new Set(fields.map(item => item.name))].sort(),
    untrustedFields: [...new Set(fields.filter(item => item.untrusted).map(item => item.name))].sort(),
    secretFields: [...new Set(fields.filter(item => item.secret).map(item => item.name))].sort(),
    indirectFields: [...new Set(fields.filter(item => item.indirect).map(item => item.name))].sort(),
    explicitRequiredContextsBypass: requiredContextsBypass(fields),
    writeAuthority: jobHasWriteAuthority(block),
    protectedEnvironment: jobUsesProtectedEnvironment(block),
    externalContribution: trigger.externalContribution,
  };
}

function finding(
  signal: DeploymentRequestSignal,
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
      value: signal.channel,
      metadata: {
        job: signal.job,
        step: signal.step,
        fields: signal.fields.join(','),
      },
    },
    remediation,
    tags,
  };
}

function refFindings(step: WorkflowStepBlock, signal: DeploymentRequestSignal): Finding[] {
  const fields = fieldsFor(step, signal.channel);
  const ref = fields.find(item => item.name === 'ref');
  if (!ref) {
    return [finding(
      signal,
      'ci-deployment-request-missing-ref',
      'critical',
      'Deployment request has no statically visible immutable ref binding',
      'A deployment mutation without a reviewable ref can deploy an opaque or default target with privileged deployment authority.',
      'Bind deployments explicitly to github.sha or a reviewed literal ref after validating producer commit identity.',
      ['ci', 'deployment', 'request', 'ref', 'identity'],
      true,
    )];
  }
  const results: Finding[] = [];
  if (ref.untrusted) {
    results.push(finding(
      signal,
      'ci-deployment-request-untrusted-ref',
      'critical',
      'Deployment target ref is attacker-influenced',
      'External event or free-form input data can select the code ref sent to deployment authority.',
      'Deploy only the validated immutable github.sha or an independently verified producer commit/ref.',
      ['ci', 'deployment', 'request', 'ref', 'provenance'],
      true,
    ));
  } else if (ref.indirect) {
    results.push(finding(
      signal,
      'ci-deployment-request-indirect-ref-review',
      'medium',
      'Deployment target ref comes from an indirect workflow output',
      'needs/steps/matrix output crosses into deployment target identity and requires explicit producer binding.',
      'Verify the output against the expected repository/workflow/commit identity before deployment.',
      ['ci', 'deployment', 'request', 'ref', 'review'],
      false,
    ));
  } else if (!SAFE_REF.test(ref.value)) {
    results.push(finding(
      signal,
      'ci-deployment-request-opaque-ref',
      'high',
      'Deployment target ref is not a canonical reviewed selector',
      `Deployment ref '${ref.value}' is not a literal repository ref or current github.sha/ref/ref_name.`,
      'Use github.sha for immutable deployments or a literal reviewed branch/tag.',
      ['ci', 'deployment', 'request', 'ref', 'canonicalization'],
      signal.writeAuthority,
    ));
  }
  return results;
}

function metadataFindings(step: WorkflowStepBlock, signal: DeploymentRequestSignal): Finding[] {
  const fields = fieldsFor(step, signal.channel);
  const results: Finding[] = [];
  const secret = fields.filter(item => item.secret);
  if (secret.length > 0) {
    results.push(finding(
      signal,
      'ci-deployment-request-secret-payload',
      'critical',
      'Deployment request persists secret-derived metadata',
      `Deployment fields (${[...new Set(secret.map(item => item.name))].join(', ')}) contain secret-derived content. Deployment payload/description/environment metadata is not a credential transport channel.`,
      'Keep deployment metadata non-sensitive and pass credentials only through protected environment secret mechanisms.',
      ['ci', 'deployment', 'request', 'metadata', 'secret'],
      true,
    ));
  }

  const untrustedMetadata = fields.filter(item => item.untrusted && item.kind !== 'ref' && item.kind !== 'guard');
  if (untrustedMetadata.length > 0) {
    results.push(finding(
      signal,
      'ci-deployment-request-untrusted-metadata',
      signal.writeAuthority || signal.protectedEnvironment || signal.externalContribution ? 'critical' : 'high',
      'Deployment request metadata is attacker-influenced',
      `Deployment fields (${[...new Set(untrustedMetadata.map(item => item.name))].join(', ')}) can be shaped by event/input data before crossing into deployment authority.`,
      'Allowlist environment/task/payload metadata from trusted release state and avoid forwarding raw external event content.',
      ['ci', 'deployment', 'request', 'metadata', 'provenance'],
      signal.writeAuthority || signal.protectedEnvironment || signal.externalContribution,
    ));
  }

  for (const item of fields.filter(value => value.name === 'environment' && !value.untrusted && !value.secret && !value.indirect)) {
    if (!SAFE_ENVIRONMENT.test(item.value)) {
      results.push(finding(
        signal,
        'ci-deployment-request-opaque-environment',
        'high',
        'Deployment environment identity is not a reviewed literal',
        `Environment selector '${item.value}' is opaque or dynamically composed.`,
        'Use a literal reviewed environment name so protection rules and operator expectations bind to a stable identity.',
        ['ci', 'deployment', 'request', 'environment', 'identity'],
        signal.writeAuthority,
      ));
    }
  }

  for (const item of fields.filter(value => value.name === 'task' && !value.untrusted && !value.secret && !value.indirect)) {
    if (!SAFE_TASK.test(item.value)) {
      results.push(finding(
        signal,
        'ci-deployment-request-opaque-task',
        'medium',
        'Deployment task is dynamically selected',
        `Task '${item.value}' is not a reviewed literal task identity.`,
        'Use a literal deployment task or validate it against a closed allowlist before request creation.',
        ['ci', 'deployment', 'request', 'task'],
        false,
      ));
    }
  }
  return results;
}

function guardFindings(step: WorkflowStepBlock, signal: DeploymentRequestSignal): Finding[] {
  const fields = fieldsFor(step, signal.channel).filter(item => item.kind === 'guard');
  const results: Finding[] = [];
  const untrusted = fields.filter(item => item.untrusted);
  if (untrusted.length > 0) {
    results.push(finding(
      signal,
      'ci-deployment-request-untrusted-guard',
      'critical',
      'Deployment safety controls are attacker-influenced',
      `Guard fields (${[...new Set(untrusted.map(item => item.name))].join(', ')}) can alter required contexts, auto-merge, or production/transient semantics from untrusted data.`,
      'Keep deployment guard/state controls literal and reviewed; never derive them from external events or free-form inputs.',
      ['ci', 'deployment', 'request', 'guard', 'integrity'],
      true,
    ));
  }

  if (signal.explicitRequiredContextsBypass) {
    results.push(finding(
      signal,
      'ci-deployment-request-required-contexts-bypass',
      'critical',
      'Deployment request explicitly bypasses required status contexts',
      'required_contexts is explicitly empty, allowing deployment creation without the repository status-context barrier expected by default.',
      'Omit required_contexts to preserve repository defaults or supply the reviewed mandatory context list. Do not use an empty bypass for protected/production deployments.',
      ['ci', 'deployment', 'request', 'required-contexts', 'bypass'],
      true,
    ));
  }

  for (const item of fields.filter(value => /^(?:auto_merge|autoMerge|transient_environment|transientEnvironment|production_environment|productionEnvironment)$/.test(value.name) && !value.untrusted && !value.secret && !value.indirect)) {
    if (!BOOLEAN_LITERAL.test(item.value)) {
      results.push(finding(
        signal,
        'ci-deployment-request-nonliteral-guard',
        'high',
        'Deployment boolean guard is not a canonical literal',
        `Field ${item.name} uses '${item.value}' instead of an explicit true/false value.`,
        'Use literal boolean guard values so deployment semantics remain reviewable and deterministic.',
        ['ci', 'deployment', 'request', 'guard', 'canonicalization'],
        signal.writeAuthority,
      ));
    }
  }
  return results;
}

function externalAuthorityFindings(signal: DeploymentRequestSignal): Finding[] {
  if (!signal.externalContribution || !signal.writeAuthority) return [];
  return [finding(
    signal,
    'ci-deployment-request-external-write-authority',
    'critical',
    'External contribution workflow can create deployments',
    'A contribution-controlled trigger reaches deployment write authority, crossing untrusted contribution data into an operator-visible deployment object.',
    'Keep external-contribution workflows read-only. Create deployments only from a trusted follow-up workflow after validating repository, event, workflow, conclusion, ref, and immutable commit identity.',
    ['ci', 'deployment', 'request', 'external-event', 'authority'],
    true,
  )];
}

function analyze(block: WorkflowJobBlock, step: WorkflowStepBlock): { signal: DeploymentRequestSignal; findings: Finding[] } | undefined {
  const signal = signalFor(block, step);
  if (!signal) return undefined;
  return {
    signal,
    findings: [
      ...refFindings(step, signal),
      ...metadataFindings(step, signal),
      ...guardFindings(step, signal),
      ...externalAuthorityFindings(signal),
    ],
  };
}

export function auditDeploymentRequestProvenance(
  inventory: RepositoryInventory,
): AuditSection<DeploymentRequestProvenanceSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const results = files.flatMap(file => workflowJobBlocks(file)
    .flatMap(block => workflowStepBlocks(block)
      .map(step => analyze(block, step))
      .filter((item): item is { signal: DeploymentRequestSignal; findings: Finding[] } => item !== undefined)));
  const signals = results.map(item => item.signal);
  const findings = stableSortFindings(results.flatMap(item => item.findings));
  return {
    domain: 'security',
    title: 'GitHub deployment request provenance audit',
    summary: {
      workflowFiles: files.length,
      deploymentRequests: signals.length,
      untrustedRequests: signals.filter(item => item.untrustedFields.length > 0).length,
      secretBearingRequests: signals.filter(item => item.secretFields.length > 0).length,
      requiredContextBypasses: signals.filter(item => item.explicitRequiredContextsBypass).length,
      githubScriptRequests: signals.filter(item => item.channel === 'github-script').length,
      ghApiRequests: signals.filter(item => item.channel === 'gh-api').length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
