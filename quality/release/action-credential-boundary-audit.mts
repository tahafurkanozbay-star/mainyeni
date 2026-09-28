import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  firstWorkflowField,
  hasSecretReference,
  workflowFieldBlockText,
  workflowFiles,
  workflowJobBlocks,
  workflowTopLevelBlock,
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
  type WorkflowUsesIdentity,
} from './workflow-step-structure.mts';

export interface ActionCredentialSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly action: string;
  readonly owner?: string;
  readonly firstParty: boolean;
  readonly immutable: boolean;
  readonly externalContribution: boolean;
  readonly directSecretInputs: number;
  readonly directTokenInputs: number;
  readonly inheritedSecretEnv: boolean;
  readonly customTokenInput: boolean;
}

export interface ActionCredentialBoundarySummary {
  readonly workflowFiles: number;
  readonly remoteActionSteps: number;
  readonly thirdPartyActionSteps: number;
  readonly credentialBearingActionSteps: number;
  readonly externalCredentialBearingSteps: number;
  readonly signals: readonly ActionCredentialSignal[];
  readonly findings: readonly Finding[];
}

const SECRET = /\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/gi;
const GITHUB_TOKEN = /\$\{\{\s*(?:github\.token|secrets\.GITHUB_TOKEN)\s*\}\}/gi;
const TOKENISH_KEY = /(?:^|[-_])(token|secret|password|passwd|api[-_]?key|access[-_]?key|private[-_]?key|credential)(?:$|[-_])/i;
const OFFICIAL_OWNERS = new Set(['actions', 'github']);

function countMatches(text: string, pattern: RegExp): number {
  const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let count = 0;
  while (matcher.exec(text) !== null) count += 1;
  return count;
}

function inheritedSecretEnv(block: WorkflowJobBlock): boolean {
  const workflowEnv = workflowTopLevelBlock(block.file, 'env')?.text ?? '';
  const jobEnv = workflowFieldBlockText(block, 'env');
  return hasSecretReference(workflowEnv) || hasSecretReference(jobEnv);
}

function directMappings(step: WorkflowStepBlock): ReadonlyArray<readonly [string, string]> {
  return [
    ...stepNestedMapping(step, 'with').entries(),
    ...stepNestedMapping(step, 'env').entries(),
  ];
}

function credentialCounts(step: WorkflowStepBlock) {
  let directSecretInputs = 0;
  let directTokenInputs = 0;
  let customTokenInput = false;
  for (const [key, value] of directMappings(step)) {
    directSecretInputs += countMatches(value, SECRET);
    directTokenInputs += countMatches(value, GITHUB_TOKEN);
    if (TOKENISH_KEY.test(key) && value.trim().length > 0) customTokenInput = true;
  }
  return { directSecretInputs, directTokenInputs, customTokenInput };
}

function signal(block: WorkflowJobBlock, step: WorkflowStepBlock, identity: WorkflowUsesIdentity): ActionCredentialSignal {
  const trigger = workflowTriggerProfile(block.file);
  const counts = credentialCounts(step);
  const owner = identity.owner?.toLowerCase();
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    action: identity.raw,
    ...(owner ? { owner } : {}),
    firstParty: Boolean(owner && OFFICIAL_OWNERS.has(owner)),
    immutable: identity.immutable,
    externalContribution: trigger.externalContribution,
    directSecretInputs: counts.directSecretInputs,
    directTokenInputs: counts.directTokenInputs,
    inheritedSecretEnv: inheritedSecretEnv(block),
    customTokenInput: counts.customTokenInput,
  };
}

function credentialBearing(current: ActionCredentialSignal): boolean {
  return current.directSecretInputs > 0 || current.directTokenInputs > 0 || current.inheritedSecretEnv || current.customTokenInput;
}

function where(step: WorkflowStepBlock) {
  return { file: step.job.file.repositoryPath, line: firstWorkflowStepField(step, 'uses')?.line ?? step.startLine };
}

function thirdPartyFindings(current: ActionCredentialSignal, step: WorkflowStepBlock): Finding[] {
  if (current.firstParty || !credentialBearing(current)) return [];
  const findings: Finding[] = [];
  const location = where(step);
  const directCredential = current.directSecretInputs > 0 || current.directTokenInputs > 0 || current.customTokenInput;

  if (!current.immutable && directCredential) {
    findings.push({
      id: 'ci-action-mutable-credential-exposure',
      domain: 'security',
      severity: 'critical',
      blocking: true,
      title: 'Mutable third-party action receives repository credentials',
      message: `Step ${current.step} invokes ${current.action} through a mutable action reference while passing token/secret-shaped credential data. A tag or branch move can immediately exfiltrate the credential.`,
      location,
      remediation: 'Pin the reviewed third-party action to an immutable full commit SHA and minimize its credential scope. Prefer a repository-owned wrapper that passes only a narrowly scoped token when the integration is unavoidable.',
      tags: ['ci', 'actions', 'credentials', 'supply-chain', 'least-privilege'],
    });
  }

  if (current.externalContribution && directCredential) {
    findings.push({
      id: 'ci-action-external-third-party-credential',
      domain: 'security',
      severity: 'critical',
      blocking: true,
      title: 'Contribution-triggered third-party action receives credential material',
      message: `Step ${current.step} runs third-party action ${current.action} in an externally influenced workflow while directly receiving token/secret-shaped inputs. Event-controlled behavior can reach a credential-bearing external execution boundary.`,
      location,
      remediation: 'Remove credentials from contribution validation. Move credential-bearing integration to trusted push/workflow_run code with independently verified provenance and no untrusted checkout or executable inputs.',
      tags: ['ci', 'actions', 'credentials', 'pull-request', 'supply-chain'],
    });
  } else if (directCredential && current.immutable) {
    findings.push({
      id: 'ci-action-third-party-credential-review',
      domain: 'security',
      severity: 'high',
      title: 'Pinned third-party action receives credential material',
      message: `Step ${current.step} passes credentials to ${current.action}. Immutable pinning fixes code identity but does not make an external action a repository-owned trust boundary.`,
      location,
      remediation: 'Document the action owner and reviewed commit, scope the token to the smallest permission set, and prefer short-lived environment-protected credentials. Remove the action if a first-party or local implementation is practical.',
      tags: ['ci', 'actions', 'credentials', 'supply-chain', 'review'],
    });
  }

  if (current.inheritedSecretEnv) {
    findings.push({
      id: 'ci-action-third-party-inherited-secret-env',
      domain: 'security',
      severity: current.externalContribution ? 'critical' : 'high',
      ...(current.externalContribution ? { blocking: true } : {}),
      title: 'Third-party action inherits a secret-bearing workflow environment',
      message: `Step ${current.step} invokes ${current.action} while job/workflow env contains secret expressions. Action processes inherit environment variables even when the secret is not repeated in the step's with block.`,
      location,
      remediation: 'Do not place secrets in workflow- or job-wide env when third-party actions execute. Scope secrets to the smallest trusted step or isolate the external action into a credential-free job.',
      tags: ['ci', 'actions', 'credentials', 'environment', 'least-privilege'],
    });
  }

  return findings;
}

function officialFindings(current: ActionCredentialSignal, step: WorkflowStepBlock): Finding[] {
  if (!current.firstParty || !credentialBearing(current)) return [];
  const findings: Finding[] = [];
  const location = where(step);

  if (!current.immutable) {
    findings.push({
      id: 'ci-action-official-credential-mutable-ref',
      domain: 'security',
      severity: 'high',
      title: 'Credential-bearing official action is not immutable-pinned',
      message: `Step ${current.step} gives credential context to ${current.action}, but the action identity is mutable. Official ownership reduces but does not remove supply-chain drift risk.`,
      location,
      remediation: 'Pin credential-bearing actions to a reviewed full commit SHA.',
      tags: ['ci', 'actions', 'credentials', 'supply-chain'],
    });
  }

  if (current.externalContribution && current.inheritedSecretEnv) {
    findings.push({
      id: 'ci-action-external-inherited-secret-env',
      domain: 'security',
      severity: 'high',
      title: 'Contribution-triggered action inherits workflow-level secret environment',
      message: `Step ${current.step} inherits secret-bearing env in an externally influenced workflow. Even first-party action code should not receive unrelated credentials implicitly.`,
      location,
      remediation: 'Remove workflow/job-wide secrets and scope credentials only to trusted steps that need them.',
      tags: ['ci', 'actions', 'credentials', 'pull-request', 'environment'],
    });
  }

  return findings;
}

function mappingCredentialFindings(current: ActionCredentialSignal, step: WorkflowStepBlock): Finding[] {
  const findings: Finding[] = [];
  const location = where(step);
  for (const [key, value] of directMappings(step)) {
    if (!TOKENISH_KEY.test(key) || !value.trim()) continue;
    const isSecretExpression = hasSecretReference(value) || GITHUB_TOKEN.test(value);
    GITHUB_TOKEN.lastIndex = 0;
    if (isSecretExpression) continue;
    if (/^\$\{\{\s*(?:vars\.|inputs\.|github\.event\.)/i.test(value)) {
      findings.push({
        id: 'ci-action-credential-shaped-untrusted-input',
        domain: 'security',
        severity: 'high',
        title: 'Credential-shaped action input is populated from non-secret workflow data',
        message: `Step ${current.step} sets credential-shaped input "${key}" from vars/inputs/event data. This can accidentally treat caller-controlled text as authentication material or mutation authority.`,
        location,
        evidence: { value: `${key}: ${value}` },
        remediation: 'Source credentials only from GitHub secrets, environment protection, or OIDC. Validate ordinary caller inputs separately and never map them into token/password/key fields.',
        tags: ['ci', 'actions', 'credentials', 'input-validation'],
      });
    }
  }
  return findings;
}

export function auditActionCredentialBoundaries(inventory: RepositoryInventory): AuditSection<ActionCredentialBoundarySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const signals: ActionCredentialSignal[] = [];
  const findings: Finding[] = [];

  for (const file of files) {
    for (const block of workflowJobBlocks(file)) {
      for (const step of workflowStepBlocks(block)) {
        const identity = stepUsesIdentity(step);
        if (!identity || !identity.remote) continue;
        const current = signal(block, step, identity);
        signals.push(current);
        findings.push(...thirdPartyFindings(current, step));
        findings.push(...officialFindings(current, step));
        findings.push(...mappingCredentialFindings(current, step));
      }
    }
  }

  const canonical = stableSortFindings(findings);
  return {
    domain: 'security',
    title: 'GitHub Action credential exposure and third-party trust audit',
    summary: {
      workflowFiles: files.length,
      remoteActionSteps: signals.length,
      thirdPartyActionSteps: signals.filter(item => !item.firstParty).length,
      credentialBearingActionSteps: signals.filter(credentialBearing).length,
      externalCredentialBearingSteps: signals.filter(item => item.externalContribution && credentialBearing(item)).length,
      signals,
      findings: canonical,
    },
    findings: canonical,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
