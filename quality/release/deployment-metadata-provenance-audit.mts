import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  blockScalarLines,
  expressionSources,
  firstWorkflowField,
  hasUntrustedExpression,
  jobHasSecrets,
  jobHasWriteAuthority,
  jobUsesProtectedEnvironment,
  unquoteYamlScalar,
  workflowFiles,
  workflowJobBlocks,
  workflowTriggerProfile,
  type WorkflowJobBlock,
  type WorkflowLine,
} from './workflow-structure.mts';
import {
  firstWorkflowStepField,
  stepNestedMapping,
  stepRunText,
  stepUsesIdentity,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export interface DeploymentMetadataSignal {
  readonly file: string;
  readonly job: string;
  readonly environmentName?: string;
  readonly environmentUrl?: string;
  readonly environmentUrlSources: readonly string[];
  readonly privileged: boolean;
  readonly externalContribution: boolean;
  readonly statusMutations: number;
  readonly untrustedStatusMutations: number;
}

export interface DeploymentMetadataProvenanceSummary {
  readonly workflowFiles: number;
  readonly deploymentJobs: number;
  readonly environmentUrls: number;
  readonly dynamicEnvironmentUrls: number;
  readonly statusMutations: number;
  readonly untrustedStatusMutations: number;
  readonly signals: readonly DeploymentMetadataSignal[];
  readonly findings: readonly Finding[];
}

interface LocatedValue {
  readonly value: string;
  readonly line: number;
  readonly offset: number;
}

interface StatusMutation {
  readonly line: number;
  readonly text: string;
  readonly untrustedFields: readonly string[];
  readonly secretFields: readonly string[];
  readonly dynamicState: boolean;
}

const DEPLOYMENT_JOB = /\b(?:deploy|deployment|publish|release|production|prod|pages)\b/i;
const DANGEROUS_SCHEME = /^(?:javascript|data|file|vbscript):/i;
const HTTP_SCHEME = /^http:\/\//i;
const HTTPS_SCHEME = /^https:\/\//i;
const URL_CREDENTIALS = /^https?:\/\/[^/@\s]+:[^/@\s]+@/i;
const SECRET_EXPRESSION = /\$\{\{[\s\S]*?secrets\./i;
const ATTACKER_EXPRESSION = /\$\{\{[\s\S]*?(?:github\.event\.|github\.head_ref\b|inputs\.)/i;
const INDIRECT_EXPRESSION = /\$\{\{[\s\S]*?(?:steps\.|needs\.)/i;
const DYNAMIC_EXPRESSION = /\$\{\{/;
const DEPLOYMENT_STATUS_ENDPOINT = /(?:^|[\s'"`])(?:https:\/\/api\.github\.com\/repos\/[^\s'"`]+\/deployments\/[^\s'"`]+\/statuses|repos\/[^\s'"`]+\/deployments\/[^\s'"`]+\/statuses|\/repos\/[^\s'"`]+\/deployments\/[^\s'"`]+\/statuses)(?:[\s'"`]|$)/i;
const GH_API = /\bgh\s+api\b/i;
const STATUS_METHOD = /(?:--method|-X)\s+(?:POST|PUT|PATCH)\b/i;
const CREATE_DEPLOYMENT_STATUS = /\b(?:github\.)?rest\.repos\.createDeploymentStatus\s*\(|\bcreateDeploymentStatus\s*\(/i;
const STATE_FIELD = /\bstate\b\s*(?:=|:)\s*([^,}\n]+)/i;
const SAFE_LITERAL_STATE = /^(?:['"])?(?:queued|in_progress|success|failure|error|inactive|pending)(?:['"])?$/i;
const CONTEXT_ATTACKER = /\b(?:context|github\.context)\.payload\b|\b(?:issue|pullRequest|pull_request|comment|review|discussion)\b/i;
const PROCESS_ENV = /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
const FIELD_VALUE = /\b(state|environment_url|environmentUrl|log_url|logUrl|description|environment)\b\s*(?:=|:)\s*([^,}\n]+)/gi;

function scalarFromLine(line: WorkflowLine, key: string): LocatedValue | undefined {
  const match = line.text.match(new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*(?:#.*)?$`, 'i'));
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  const value = unquoteYamlScalar(raw);
  const column = line.text.indexOf(raw);
  return { value, line: line.line, offset: line.offset + Math.max(0, column) };
}

function nestedEnvironmentValue(block: WorkflowJobBlock, key: 'name' | 'url'): LocatedValue | undefined {
  const environment = firstWorkflowField(block, 'environment');
  if (!environment) return undefined;
  if (key === 'name' && environment.value) {
    return { value: environment.value, line: environment.line, offset: environment.offset };
  }
  for (const line of blockScalarLines(block, environment)) {
    if (!line.trimmed || line.trimmed.startsWith('#')) continue;
    const candidate = scalarFromLine(line, key);
    if (candidate) return candidate;
    if (line.indent <= environment.indent) break;
  }
  return undefined;
}

function deploymentJob(block: WorkflowJobBlock): boolean {
  return DEPLOYMENT_JOB.test(block.name)
    || Boolean(firstWorkflowField(block, 'environment'))
    || /\b(?:gh\s+api|createDeploymentStatus)\b/i.test(block.text);
}

function privileged(block: WorkflowJobBlock): boolean {
  return jobHasWriteAuthority(block) || jobHasSecrets(block) || jobUsesProtectedEnvironment(block);
}

function urlSources(value: string): string[] {
  const sources = new Set(expressionSources(value));
  if (/\$\{\{[\s\S]*?steps\./i.test(value)) sources.add('steps');
  if (/\$\{\{[\s\S]*?github\.(?:sha|repository|ref_name|server_url)\b/i.test(value)) sources.add('github');
  return [...sources].sort((left, right) => left.localeCompare(right, 'en'));
}

function finding(
  block: WorkflowJobBlock,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  line: number,
  evidence: string,
  tags: readonly string[],
  blocking = severity === 'critical',
): Finding {
  return {
    id,
    domain: 'security',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: block.file.repositoryPath, line },
    evidence: { value: evidence, metadata: { job: block.name } },
    remediation,
    tags,
  };
}

function environmentUrlFindings(block: WorkflowJobBlock, url: LocatedValue): Finding[] {
  const value = url.value.trim();
  const results: Finding[] = [];
  const isPrivileged = privileged(block);
  const trigger = workflowTriggerProfile(block.file);
  const sources = urlSources(value);

  if (SECRET_EXPRESSION.test(value)) {
    results.push(finding(
      block,
      'ci-deployment-url-secret-exposure',
      'critical',
      'Deployment environment URL contains secret-derived data',
      'Environment URLs are rendered as deployment metadata and must never carry credentials or secret material.',
      'Remove secret interpolation from environment.url. Publish a non-sensitive canonical HTTPS deployment URL instead.',
      url.line,
      value,
      ['ci', 'deployment', 'environment', 'metadata', 'secret'],
      true,
    ));
  }

  if (URL_CREDENTIALS.test(value)) {
    results.push(finding(
      block,
      'ci-deployment-url-embedded-credentials',
      'critical',
      'Deployment environment URL embeds userinfo credentials',
      'Credential-bearing URLs can leak authentication material through GitHub deployment metadata, logs, notifications, and browser history.',
      'Use a credential-free HTTPS URL and keep authentication in the destination service, not the deployment link.',
      url.line,
      value,
      ['ci', 'deployment', 'url', 'credential'],
      true,
    ));
  }

  if (DANGEROUS_SCHEME.test(value)) {
    results.push(finding(
      block,
      'ci-deployment-url-dangerous-scheme',
      'critical',
      'Deployment environment URL uses an unsafe scheme',
      'Deployment links must not use executable, local-file, or data URL schemes.',
      'Use a reviewed HTTPS origin for deployment metadata.',
      url.line,
      value,
      ['ci', 'deployment', 'url', 'scheme'],
      true,
    ));
  } else if (HTTP_SCHEME.test(value)) {
    results.push(finding(
      block,
      'ci-deployment-url-plaintext-http',
      'high',
      'Deployment environment URL uses plaintext HTTP',
      'GitHub deployment links should not direct operators to an unauthenticated plaintext transport.',
      'Publish the canonical HTTPS deployment URL.',
      url.line,
      value,
      ['ci', 'deployment', 'url', 'transport'],
      isPrivileged,
    ));
  }

  if (ATTACKER_EXPRESSION.test(value) || hasUntrustedExpression(value)) {
    results.push(finding(
      block,
      'ci-deployment-url-untrusted-provenance',
      isPrivileged || trigger.externalContribution ? 'critical' : 'high',
      'Deployment environment URL is derived from attacker-influenced workflow data',
      'Pull-request, issue, comment, event payload, or manual input data can shape the authoritative deployment link shown in GitHub.',
      'Bind environment.url to a trusted deployment producer output or a reviewed literal HTTPS origin. Never use external event text or free-form inputs as URL authority.',
      url.line,
      value,
      ['ci', 'deployment', 'environment', 'url', 'provenance'],
      isPrivileged || trigger.externalContribution,
    ));
  }

  if (DYNAMIC_EXPRESSION.test(value)
      && !ATTACKER_EXPRESSION.test(value)
      && !SECRET_EXPRESSION.test(value)
      && !INDIRECT_EXPRESSION.test(value)
      && !/\$\{\{[\s\S]*?(?:github\.(?:sha|repository|ref_name|server_url)|vars\.)/i.test(value)) {
    results.push(finding(
      block,
      'ci-deployment-url-opaque-expression',
      'medium',
      'Deployment environment URL uses an unclassified dynamic expression',
      `The URL expression sources (${sources.join(', ') || 'unknown'}) are not a recognized trusted deployment-output contract.`,
      'Use a literal HTTPS URL or a narrowly scoped trusted step/needs output whose producer is covered by release provenance checks.',
      url.line,
      value,
      ['ci', 'deployment', 'url', 'dynamic'],
      false,
    ));
  }

  if (!DYNAMIC_EXPRESSION.test(value)
      && value
      && !HTTPS_SCHEME.test(value)
      && !HTTP_SCHEME.test(value)
      && !DANGEROUS_SCHEME.test(value)) {
    results.push(finding(
      block,
      'ci-deployment-url-noncanonical',
      'medium',
      'Deployment environment URL is not a canonical absolute HTTPS URL',
      'Relative or scheme-less deployment metadata can be ambiguous and does not provide an explicit transport boundary.',
      'Publish an absolute HTTPS deployment URL.',
      url.line,
      value,
      ['ci', 'deployment', 'url', 'canonicalization'],
      false,
    ));
  }

  return results;
}

function untrustedEnvNames(step: WorkflowStepBlock): Set<string> {
  const result = new Set<string>();
  for (const [name, value] of stepNestedMapping(step, 'env')) {
    if (hasUntrustedExpression(value) || ATTACKER_EXPRESSION.test(value)) result.add(name);
  }
  return result;
}

function secretEnvNames(step: WorkflowStepBlock): Set<string> {
  const result = new Set<string>();
  for (const [name, value] of stepNestedMapping(step, 'env')) {
    if (SECRET_EXPRESSION.test(value)) result.add(name);
  }
  return result;
}

function referencedEnvNames(value: string): Set<string> {
  const names = new Set<string>();
  const matcher = new RegExp(PROCESS_ENV.source, PROCESS_ENV.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(value)) !== null) {
    const name = match[1];
    if (name) names.add(name);
  }
  return names;
}

function fieldRisks(text: string, step: WorkflowStepBlock): {
  untrusted: string[];
  secret: string[];
  dynamicState: boolean;
} {
  const untrusted = new Set<string>();
  const secret = new Set<string>();
  const untrustedEnv = untrustedEnvNames(step);
  const secretEnv = secretEnvNames(step);
  const matcher = new RegExp(FIELD_VALUE.source, FIELD_VALUE.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const field = match[1] ?? 'metadata';
    const value = (match[2] ?? '').trim();
    if (ATTACKER_EXPRESSION.test(value) || hasUntrustedExpression(value) || CONTEXT_ATTACKER.test(value)) untrusted.add(field);
    if (SECRET_EXPRESSION.test(value)) secret.add(field);
    for (const name of referencedEnvNames(value)) {
      if (untrustedEnv.has(name)) untrusted.add(field);
      if (secretEnv.has(name)) secret.add(field);
    }
  }
  const state = text.match(STATE_FIELD)?.[1]?.trim() ?? '';
  const dynamicState = Boolean(state && !SAFE_LITERAL_STATE.test(state) && (DYNAMIC_EXPRESSION.test(state) || CONTEXT_ATTACKER.test(state) || referencedEnvNames(state).size > 0));
  return { untrusted: [...untrusted].sort(), secret: [...secret].sort(), dynamicState };
}

function statusMutations(block: WorkflowJobBlock): StatusMutation[] {
  const mutations: StatusMutation[] = [];
  for (const step of workflowStepBlocks(block)) {
    const run = stepRunText(step);
    if (run && GH_API.test(run) && DEPLOYMENT_STATUS_ENDPOINT.test(run) && (STATUS_METHOD.test(run) || /\b-f\s+state=|--field\s+state=/i.test(run))) {
      const risks = fieldRisks(run, step);
      mutations.push({
        line: firstWorkflowStepField(step, 'run')?.line ?? step.startLine,
        text: run,
        untrustedFields: risks.untrusted,
        secretFields: risks.secret,
        dynamicState: risks.dynamicState,
      });
    }

    const identity = stepUsesIdentity(step);
    if (identity?.owner?.toLowerCase() !== 'actions' || identity.repository?.toLowerCase() !== 'github-script') continue;
    const script = step.text;
    if (!CREATE_DEPLOYMENT_STATUS.test(script)) continue;
    const risks = fieldRisks(script, step);
    mutations.push({
      line: firstWorkflowStepField(step, 'uses')?.line ?? step.startLine,
      text: script,
      untrustedFields: risks.untrusted,
      secretFields: risks.secret,
      dynamicState: risks.dynamicState,
    });
  }
  return mutations;
}

function statusMutationFindings(block: WorkflowJobBlock, mutation: StatusMutation): Finding[] {
  const results: Finding[] = [];
  if (mutation.secretFields.length > 0) {
    results.push(finding(
      block,
      'ci-deployment-status-secret-metadata',
      'critical',
      'Deployment status metadata contains secret-derived fields',
      `Deployment status fields (${mutation.secretFields.join(', ')}) are derived from secret material and can be persisted or rendered by GitHub.`,
      'Keep deployment status metadata non-sensitive. Use secrets only for transport authentication, never for state, URL, description, or environment fields.',
      mutation.line,
      mutation.text,
      ['ci', 'deployment', 'status', 'metadata', 'secret'],
      true,
    ));
  }
  if (mutation.untrustedFields.length > 0) {
    results.push(finding(
      block,
      'ci-deployment-status-untrusted-metadata',
      'critical',
      'Deployment status metadata is attacker-influenced',
      `Deployment status fields (${mutation.untrustedFields.join(', ')}) are derived from event/input data and can shape GitHub deployment state or links.`,
      'Derive deployment status metadata only from trusted deployment results. Validate any external data before it crosses into deployment-status mutation authority.',
      mutation.line,
      mutation.text,
      ['ci', 'deployment', 'status', 'provenance'],
      true,
    ));
  }
  if (mutation.dynamicState) {
    results.push(finding(
      block,
      'ci-deployment-status-dynamic-state',
      'high',
      'Deployment status state is dynamically selected',
      'A dynamic state value can report success/failure independently of an explicit reviewed promotion result.',
      'Map trusted command outcomes to a closed allowlist of deployment states and keep success/failure selection local to the enforcing deployment step.',
      mutation.line,
      mutation.text,
      ['ci', 'deployment', 'status', 'state', 'integrity'],
      privileged(block),
    ));
  }
  return results;
}

function signalFor(block: WorkflowJobBlock): { signal: DeploymentMetadataSignal; findings: Finding[] } {
  const environmentName = nestedEnvironmentValue(block, 'name');
  const environmentUrl = nestedEnvironmentValue(block, 'url');
  const mutations = statusMutations(block);
  const findings = [
    ...(environmentUrl ? environmentUrlFindings(block, environmentUrl) : []),
    ...mutations.flatMap(mutation => statusMutationFindings(block, mutation)),
  ];
  const trigger = workflowTriggerProfile(block.file);
  const signal: DeploymentMetadataSignal = {
    file: block.file.repositoryPath,
    job: block.name,
    ...(environmentName?.value ? { environmentName: environmentName.value } : {}),
    ...(environmentUrl?.value ? { environmentUrl: environmentUrl.value } : {}),
    environmentUrlSources: environmentUrl ? urlSources(environmentUrl.value) : [],
    privileged: privileged(block),
    externalContribution: trigger.externalContribution,
    statusMutations: mutations.length,
    untrustedStatusMutations: mutations.filter(item => item.untrustedFields.length > 0 || item.secretFields.length > 0 || item.dynamicState).length,
  };
  return { signal, findings };
}

export function auditDeploymentMetadataProvenance(
  inventory: RepositoryInventory,
): AuditSection<DeploymentMetadataProvenanceSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const results = files.flatMap(file => workflowJobBlocks(file).filter(deploymentJob).map(signalFor));
  const signals = results.map(result => result.signal);
  const findings = stableSortFindings(results.flatMap(result => result.findings));
  return {
    domain: 'security',
    title: 'Deployment metadata and environment URL provenance audit',
    summary: {
      workflowFiles: files.length,
      deploymentJobs: signals.length,
      environmentUrls: signals.filter(item => item.environmentUrl !== undefined).length,
      dynamicEnvironmentUrls: signals.filter(item => item.environmentUrl?.includes('${{')).length,
      statusMutations: signals.reduce((sum, item) => sum + item.statusMutations, 0),
      untrustedStatusMutations: signals.reduce((sum, item) => sum + item.untrustedStatusMutations, 0),
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
