import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  hasUntrustedExpression,
  jobHasSecrets,
  jobUsesProtectedEnvironment,
  workflowFiles,
  workflowJobBlocks,
  workflowTopLevelBlock,
  workflowTriggerProfile,
  type WorkflowJobBlock,
} from './workflow-structure.mts';

export interface OidcAuthoritySignal {
  readonly file: string;
  readonly job: string;
  readonly idTokenWrite: boolean;
  readonly externalContribution: boolean;
  readonly pullRequestTarget: boolean;
  readonly workflowRun: boolean;
  readonly repositoryDispatch: boolean;
  readonly workflowCall: boolean;
  readonly protectedEnvironment: boolean;
  readonly repositoryWriteAuthority: boolean;
  readonly secrets: boolean;
  readonly cloudLogin: boolean;
  readonly untrustedExpression: boolean;
  readonly dynamicAudience: boolean;
  readonly dynamicEnvironment: boolean;
  readonly dynamicCloudIdentity: boolean;
}

export interface OidcAuthoritySummary {
  readonly workflowFiles: number;
  readonly jobs: number;
  readonly oidcJobs: number;
  readonly externalOidcJobs: number;
  readonly unprotectedOidcJobs: number;
  readonly signals: readonly OidcAuthoritySignal[];
  readonly findings: readonly Finding[];
}

const ID_TOKEN_WRITE = /^\s*id-token\s*:\s*write\s*(?:#.*)?$/im;
const WRITE_ALL = /^\s*permissions\s*:\s*write-all\s*(?:#.*)?$/im;
const PERMISSIONS_FIELD = /^\s*permissions\s*:/im;
const REPOSITORY_WRITE_PERMISSION = /^\s*(?:contents|actions|checks|deployments|issues|packages|pages|pull-requests|security-events|statuses)\s*:\s*write\s*(?:#.*)?$/im;
const CLOUD_LOGIN = /^\s*-?\s*uses\s*:\s*(?:aws-actions\/configure-aws-credentials|azure\/login|google-github-actions\/auth|hashicorp\/vault-action)@/im;
const OIDC_REQUEST = /(?:ACTIONS_ID_TOKEN_REQUEST_URL|ACTIONS_ID_TOKEN_REQUEST_TOKEN|getIDToken\s*\(|core\.getIDToken\s*\()/i;
const AUDIENCE_EXPRESSION = /(?:audience|id-token-audience)\s*:\s*[^\n]*\$\{\{/i;
const ENVIRONMENT_EXPRESSION = /^\s*environment\s*:\s*[^\n]*\$\{\{/im;
const CLOUD_IDENTITY_FIELD = /^\s*(?:role-to-assume|role_arn|client-id|client_id|workload_identity_provider|service_account|subscription-id|tenant-id|vault-namespace|path)\s*:\s*[^\n]*$/im;
const CLOUD_IDENTITY_EXPRESSION = /^\s*(?:role-to-assume|role_arn|client-id|client_id|workload_identity_provider|service_account|subscription-id|tenant-id|vault-namespace|path)\s*:\s*[^\n]*\$\{\{/im;
const UNTRUSTED_IDENTITY_SOURCE = /(?:github\.event\.|github\.head_ref\b|inputs\.|matrix\.|needs\.|vars\.)/i;
const TRUSTED_BRANCH_GUARD = /github\.ref\s*==\s*['"]refs\/heads\/[A-Za-z0-9._\/-]+['"]/i;
const TRUSTED_REPOSITORY_GUARD = /github\.repository\s*==\s*['"][A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+['"]/i;

function permissionText(block: WorkflowJobBlock): string {
  const lines = block.lines;
  let start = -1;
  let indent = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (PERMISSIONS_FIELD.test(line.text)) {
      start = index;
      indent = line.indent;
      break;
    }
  }
  if (start >= 0) {
    const collected = [lines[start]!.text];
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.trimmed && line.indent <= indent) break;
      collected.push(line.text);
    }
    return collected.join('\n');
  }
  return workflowTopLevelBlock(block.file, 'permissions')?.text ?? '';
}

function hasIdTokenWrite(block: WorkflowJobBlock): boolean {
  const permissions = permissionText(block);
  return ID_TOKEN_WRITE.test(permissions) || WRITE_ALL.test(permissions);
}

function hasRepositoryWriteAuthority(block: WorkflowJobBlock): boolean {
  const permissions = permissionText(block);
  return WRITE_ALL.test(permissions) || REPOSITORY_WRITE_PERMISSION.test(permissions);
}

function dynamicIdentityIsUntrusted(block: WorkflowJobBlock): boolean {
  const candidates = block.text.match(new RegExp(CLOUD_IDENTITY_FIELD.source, 'gim')) ?? [];
  return candidates.some(candidate => candidate.includes('${{') && UNTRUSTED_IDENTITY_SOURCE.test(candidate));
}

function signal(block: WorkflowJobBlock): OidcAuthoritySignal {
  const trigger = workflowTriggerProfile(block.file);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    idTokenWrite: hasIdTokenWrite(block),
    externalContribution: trigger.externalContribution,
    pullRequestTarget: trigger.pullRequestTarget,
    workflowRun: trigger.workflowRun,
    repositoryDispatch: trigger.repositoryDispatch,
    workflowCall: trigger.workflowCall,
    protectedEnvironment: jobUsesProtectedEnvironment(block),
    repositoryWriteAuthority: hasRepositoryWriteAuthority(block),
    secrets: jobHasSecrets(block),
    cloudLogin: CLOUD_LOGIN.test(block.text) || OIDC_REQUEST.test(block.text),
    untrustedExpression: hasUntrustedExpression(block.text),
    dynamicAudience: AUDIENCE_EXPRESSION.test(block.text),
    dynamicEnvironment: ENVIRONMENT_EXPRESSION.test(block.text),
    dynamicCloudIdentity: CLOUD_IDENTITY_EXPRESSION.test(block.text),
  };
}

function where(block: WorkflowJobBlock) { return { file: block.file.repositoryPath, line: block.startLine }; }

function findingsFor(block: WorkflowJobBlock): Finding[] {
  const current = signal(block);
  if (!current.idTokenWrite) return [];
  const findings: Finding[] = [];
  const location = where(block);
  if (current.externalContribution) findings.push({ id: 'ci-oidc-external-contribution-authority', domain: 'security', severity: 'critical', blocking: true, title: 'Contribution-triggered job can mint an OIDC identity token', message: `Job ${block.name} grants id-token: write on an externally influenced event. OIDC federation can exchange that token for cloud authority even when no long-lived cloud secret is present in GitHub.`, location, remediation: 'Remove id-token: write from contribution validation. Mint OIDC tokens only in trusted deployment jobs constrained by protected environments and provider-side repository/ref/environment claims.', tags: ['ci', 'oidc', 'federation', 'pull-request', 'least-privilege'] });
  if (!current.protectedEnvironment && (current.cloudLogin || current.repositoryWriteAuthority || current.secrets)) findings.push({ id: 'ci-oidc-unprotected-privileged-job', domain: 'security', severity: 'high', title: 'OIDC-capable privileged job lacks a literal protected environment', message: `Job ${block.name} can mint an identity token and also reaches cloud login, repository write authority, or secret-bearing execution without a literal protected environment boundary.`, location, remediation: 'Bind release federation to a protected environment with reviewers/branch policy, and mirror the same repository/ref/environment restrictions in the cloud provider trust policy.', tags: ['ci', 'oidc', 'environment', 'deployment', 'least-privilege'] });
  if (current.dynamicEnvironment) findings.push({ id: 'ci-oidc-dynamic-environment', domain: 'security', severity: current.untrustedExpression ? 'critical' : 'high', ...(current.untrustedExpression ? { blocking: true } : {}), title: 'OIDC job selects its environment dynamically', message: `Job ${block.name} derives the environment name from an expression while holding id-token: write. Dynamic environment selection weakens the reviewable binding between GitHub environment protection and federated cloud identity.`, location, remediation: 'Map deployment targets to literal environment names in separate reviewed jobs; never let event, input, matrix, needs, or vars data directly select an OIDC trust environment.', tags: ['ci', 'oidc', 'environment', 'expression', 'trust-boundary'] });
  if (current.dynamicAudience) findings.push({ id: 'ci-oidc-dynamic-audience', domain: 'security', severity: 'high', title: 'OIDC token audience is expression-derived', message: `Job ${block.name} derives an OIDC audience from workflow expressions. Audience is part of the federation trust contract and should not be steerable by runtime data.`, location, remediation: 'Use a literal provider-specific audience and validate provider trust policy against the exact expected audience and subject claims.', tags: ['ci', 'oidc', 'audience', 'federation', 'trust-boundary'] });
  if (current.dynamicCloudIdentity && dynamicIdentityIsUntrusted(block)) findings.push({ id: 'ci-oidc-untrusted-cloud-identity-selector', domain: 'security', severity: 'critical', blocking: true, title: 'Untrusted workflow data selects federated cloud identity', message: `Job ${block.name} lets event/input/matrix/needs/vars data participate in a cloud role, client, provider, service-account, tenant, subscription, namespace, or authentication path selector.`, location, remediation: 'Use literal cloud identity selectors per deployment job, or map validated closed identifiers to reviewed literals before authentication. Do not pass untrusted expressions directly to cloud login actions.', tags: ['ci', 'oidc', 'cloud', 'identity', 'expression-injection'] });
  if (current.workflowRun && (current.cloudLogin || current.repositoryWriteAuthority || current.secrets)) { const guarded = TRUSTED_BRANCH_GUARD.test(block.text) && TRUSTED_REPOSITORY_GUARD.test(block.text); if (!guarded) findings.push({ id: 'ci-oidc-workflow-run-trust-guard-missing', domain: 'security', severity: 'high', title: 'OIDC workflow_run job lacks explicit repository/ref trust guards', message: `Job ${block.name} can mint an OIDC token from workflow_run while privileged but does not prove a literal trusted repository and branch before federation.`, location, remediation: 'Require the expected repository and a literal trusted branch before cloud authentication, keep execution on default-branch code, and enforce equivalent provider-side subject claims.', tags: ['ci', 'oidc', 'workflow-run', 'provenance', 'federation'] }); }
  if (!current.cloudLogin && !current.repositoryWriteAuthority && !current.secrets) findings.push({ id: 'ci-oidc-unused-authority', domain: 'security', severity: 'medium', title: 'Job grants OIDC authority without an observable federation consumer', message: `Job ${block.name} grants id-token: write but the release audit cannot identify a cloud login, direct OIDC request, repository write authority, or secret-bearing deployment need.`, location, remediation: 'Remove id-token: write unless the job demonstrably needs federation. Grant the permission only to the smallest deployment job that performs authentication.', tags: ['ci', 'oidc', 'least-privilege', 'permissions'] });
  return findings;
}

export function auditOidcAuthority(inventory: RepositoryInventory): AuditSection<OidcAuthoritySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowJobBlocks(file));
  const signals = jobs.map(signal);
  const findings = stableSortFindings(jobs.flatMap(findingsFor));
  return { domain: 'security', title: 'CI OIDC federation authority audit', summary: { workflowFiles: files.length, jobs: signals.length, oidcJobs: signals.filter(item => item.idTokenWrite).length, externalOidcJobs: signals.filter(item => item.idTokenWrite && item.externalContribution).length, unprotectedOidcJobs: signals.filter(item => item.idTokenWrite && !item.protectedEnvironment).length, signals, findings }, findings, elapsedMs: Math.max(0, performance.now() - started) };
}
