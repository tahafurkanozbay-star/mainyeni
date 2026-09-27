import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { createLineIndex, snippetAround } from './inventory.mts';

export interface OidcTrustSignal {
  readonly file: string;
  readonly idTokenWrite: boolean;
  readonly cloudLoginSteps: number;
  readonly provenanceSteps: number;
  readonly externalTriggers: number;
  readonly environmentJobs: number;
  readonly findings: number;
}

export interface OidcTrustSummary {
  readonly workflows: readonly OidcTrustSignal[];
  readonly workflowFiles: number;
  readonly privilegedWorkflows: number;
  readonly findings: readonly Finding[];
}

interface LocatedBlock {
  readonly text: string;
  readonly offset: number;
}

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const ID_TOKEN_WRITE = /^\s*id-token\s*:\s*write\s*(?:#.*)?$/im;
const CONTENTS_WRITE = /^\s*contents\s*:\s*write\s*(?:#.*)?$/im;
const PACKAGES_WRITE = /^\s*packages\s*:\s*write\s*(?:#.*)?$/im;
const ATTESTATIONS_WRITE = /^\s*attestations\s*:\s*write\s*(?:#.*)?$/im;
const PULL_REQUEST_TARGET = /^\s*pull_request_target\s*:/im;
const PULL_REQUEST = /^\s*pull_request\s*:/im;
const ISSUE_LIKE_TRIGGER = /^\s*(?:issues|issue_comment|pull_request_review|pull_request_review_comment|discussion|discussion_comment)\s*:/im;
const WORKFLOW_DISPATCH = /^\s*workflow_dispatch\s*:/im;
const SHA40 = /^[0-9a-f]{40}$/i;
const EXPRESSION = /\$\{\{[\s\S]*?\}\}/;
const UNTRUSTED_EXPRESSION = /\$\{\{\s*(?:github\.event\.|github\.head_ref\b|inputs\.)/i;
const CLOUD_LOGIN_ACTION = /^(?:aws-actions\/configure-aws-credentials|azure\/login|google-github-actions\/auth)@(.+)$/i;
const ATTEST_ACTION = /^(?:actions\/attest-build-provenance|actions\/attest-sbom)@(.+)$/i;
const CHECKOUT_ACTION = /^actions\/checkout@(.+)$/i;
const CHECKOUT_REF = /^\s*ref\s*:\s*(.+?)\s*(?:#.*)?$/im;
const CHECKOUT_PERSIST = /^\s*persist-credentials\s*:\s*(true|false)\s*(?:#.*)?$/im;
const ENVIRONMENT = /^\s*environment\s*:\s*(.+?)\s*(?:#.*)?$/im;
const ROLE_OR_PROVIDER = /\b(?:role-to-assume|audience|workload_identity_provider|service_account|client-id|tenant-id|subscription-id)\s*:\s*(.+?)\s*(?:#.*)?$/gim;
const PERMISSIONS = /^\s*permissions\s*:/im;

function workflowFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => WORKFLOW_PATH.test(file.repositoryPath));
}

function physicalLines(text: string): Array<{ text: string; offset: number }> {
  const lines: Array<{ text: string; offset: number }> = [];
  let offset = 0;
  for (const raw of text.split('\n')) {
    lines.push({ text: raw.endsWith('\r') ? raw.slice(0, -1) : raw, offset });
    offset += raw.length + 1;
  }
  return lines;
}

function indentation(text: string): number {
  return text.match(/^\s*/)?.[0].length ?? 0;
}

function jobBlocks(file: SourceFile): LocatedBlock[] {
  const lines = physicalLines(file.text);
  const jobsIndex = lines.findIndex(line => /^\s*jobs\s*:\s*(?:#.*)?$/.test(line.text));
  if (jobsIndex < 0) return [];
  const jobsIndent = indentation(lines[jobsIndex]!.text);
  const result: LocatedBlock[] = [];
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.text.trim() && indentation(line.text) <= jobsIndent) break;
    if (!line.text.trim() || indentation(line.text) !== jobsIndent + 2 || !/^\s*[A-Za-z0-9_.-]+\s*:\s*(?:#.*)?$/.test(line.text)) continue;
    const start = index;
    let end = index + 1;
    while (end < lines.length) {
      const candidate = lines[end]!;
      if (candidate.text.trim() && indentation(candidate.text) <= jobsIndent) break;
      if (candidate.text.trim() && indentation(candidate.text) === jobsIndent + 2 && /^\s*[A-Za-z0-9_.-]+\s*:/.test(candidate.text)) break;
      end += 1;
    }
    result.push({ text: lines.slice(start, end).map(item => item.text).join('\n'), offset: line.offset });
    index = end - 1;
  }
  return result;
}

function stepBlocks(job: LocatedBlock): LocatedBlock[] {
  const lines = physicalLines(job.text);
  const result: LocatedBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!/^\s*-\s+(?:name\s*:|uses\s*:|run\s*:)/i.test(line.text)) continue;
    const indent = indentation(line.text);
    let end = index + 1;
    while (end < lines.length) {
      const candidate = lines[end]!;
      if (candidate.text.trim() && indentation(candidate.text) <= indent && /^\s*-\s+/.test(candidate.text)) break;
      end += 1;
    }
    result.push({
      text: lines.slice(index, end).map(item => item.text).join('\n'),
      offset: job.offset + line.offset,
    });
    index = end - 1;
  }
  return result;
}

function usesIdentity(step: LocatedBlock): string | undefined {
  return step.text.match(/^\s*(?:-\s+)?uses\s*:\s*([^\s#]+)(?:\s+#.*)?$/im)?.[1];
}

function lineFor(file: SourceFile, offset: number): number {
  return createLineIndex(file.text).lineAt(offset);
}

function finding(
  file: SourceFile,
  offset: number,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  blocking = true,
): Finding {
  return {
    id,
    domain: 'ci',
    severity,
    title,
    message,
    location: { file: file.repositoryPath, line: lineFor(file, offset) },
    evidence: { value: snippetAround(file.text, offset, 180) },
    remediation,
    blocking,
  };
}

function countExternalTriggers(text: string): number {
  return [PULL_REQUEST_TARGET, PULL_REQUEST, ISSUE_LIKE_TRIGGER].filter(pattern => pattern.test(text)).length;
}

function hasProtectedEnvironment(job: LocatedBlock): boolean {
  const value = job.text.match(ENVIRONMENT)?.[1]?.trim();
  return Boolean(value && !EXPRESSION.test(value));
}

function inspectCloudIdentityInputs(file: SourceFile, step: LocatedBlock, findings: Finding[]): void {
  for (const match of step.text.matchAll(ROLE_OR_PROVIDER)) {
    const value = match[1]?.trim() ?? '';
    if (!UNTRUSTED_EXPRESSION.test(value)) continue;
    findings.push(finding(
      file,
      step.offset + (match.index ?? 0),
      'ci-oidc-untrusted-cloud-identity',
      'critical',
      'Untrusted event data controls cloud federation identity',
      'A cloud-login identity boundary is derived from pull-request, event, or dispatch input data. An attacker-controlled identity selector can redirect federation to an unintended role/provider/account.',
      'Use repository/environment configuration for role, provider, tenant, subscription, audience, and service-account identity. Never derive these values from untrusted event payloads.',
    ));
  }
}

function inspectCheckout(file: SourceFile, job: LocatedBlock, privileged: boolean, findings: Finding[]): void {
  if (!privileged) return;
  for (const step of stepBlocks(job)) {
    const uses = usesIdentity(step);
    const checkout = uses?.match(CHECKOUT_ACTION);
    if (!checkout) continue;
    const ref = step.text.match(CHECKOUT_REF)?.[1]?.trim();
    const persist = step.text.match(CHECKOUT_PERSIST)?.[1]?.toLowerCase();
    if (ref && UNTRUSTED_EXPRESSION.test(ref)) {
      findings.push(finding(
        file,
        step.offset,
        'ci-oidc-untrusted-checkout',
        'critical',
        'OIDC-privileged job checks out attacker-controlled ref',
        'A job with id-token: write checks out a ref derived from untrusted event data. Subsequent repository scripts can execute with federated-cloud privileges.',
        'Never execute pull-request head code in an OIDC-privileged job. Separate untrusted build/test from trusted deployment and pass only verified immutable artifacts across the boundary.',
      ));
    }
    if (persist !== 'false') {
      findings.push(finding(
        file,
        step.offset,
        'ci-oidc-checkout-credentials-persisted',
        'high',
        'OIDC-privileged checkout does not disable persisted Git credentials',
        'A privileged deployment job uses checkout without explicit persist-credentials: false, increasing credential exposure to later scripts and dependencies.',
        'Set persist-credentials: false in privileged jobs and grant repository write permissions only to the narrow publication step that requires them.',
      ));
    }
  }
}

function inspectPinnedIdentityActions(file: SourceFile, job: LocatedBlock, findings: Finding[]): { cloud: number; attest: number } {
  let cloud = 0;
  let attest = 0;
  for (const step of stepBlocks(job)) {
    const uses = usesIdentity(step);
    if (!uses) continue;
    const cloudMatch = uses.match(CLOUD_LOGIN_ACTION);
    const attestMatch = uses.match(ATTEST_ACTION);
    if (cloudMatch) {
      cloud += 1;
      if (!SHA40.test(cloudMatch[1] ?? '')) {
        findings.push(finding(
          file,
          step.offset,
          'ci-oidc-cloud-action-mutable',
          'critical',
          'Cloud federation action is not immutable-SHA pinned',
          `Cloud authentication action ${uses} uses a mutable ref. Compromise or retagging of the action can expose an OIDC token or cloud credentials.`,
          'Pin cloud authentication actions to a reviewed 40-character commit SHA and update them through controlled dependency review.',
        ));
      }
      inspectCloudIdentityInputs(file, step, findings);
    }
    if (attestMatch) {
      attest += 1;
      if (!SHA40.test(attestMatch[1] ?? '')) {
        findings.push(finding(
          file,
          step.offset,
          'ci-oidc-attestation-action-mutable',
          'high',
          'Attestation action is not immutable-SHA pinned',
          `Attestation action ${uses} uses a mutable ref while consuming identity-token privileges.`,
          'Pin attestation actions to an immutable reviewed commit SHA.',
        ));
      }
    }
  }
  return { cloud, attest };
}

function inspectWorkflow(file: SourceFile): { signal: OidcTrustSignal; findings: Finding[] } {
  const findings: Finding[] = [];
  const privilegedWorkflow = ID_TOKEN_WRITE.test(file.text);
  const externalTriggers = countExternalTriggers(file.text);
  let cloudLoginSteps = 0;
  let provenanceSteps = 0;
  let environmentJobs = 0;

  if (privilegedWorkflow && !PERMISSIONS.test(file.text)) {
    findings.push(finding(
      file,
      0,
      'ci-oidc-permissions-implicit',
      'critical',
      'OIDC workflow lacks explicit permissions boundary',
      'A workflow capable of minting an OIDC token does not declare an explicit permissions map.',
      'Declare least-privilege workflow or job permissions explicitly and keep id-token: write only on the exact job that performs federation or attestation.',
    ));
  }

  if (privilegedWorkflow && externalTriggers > 0 && PULL_REQUEST_TARGET.test(file.text)) {
    findings.push(finding(
      file,
      file.text.search(PULL_REQUEST_TARGET),
      'ci-oidc-pr-target-privilege',
      'critical',
      'pull_request_target workflow can mint OIDC tokens',
      'pull_request_target executes in the trusted base-repository context. Combining it with id-token: write creates a high-impact federation boundary exposed to pull-request metadata.',
      'Move OIDC federation to a trusted post-merge/workflow_run/release workflow and keep pull_request_target read-only without identity-token permission.',
    ));
  }

  if (privilegedWorkflow && ISSUE_LIKE_TRIGGER.test(file.text)) {
    findings.push(finding(
      file,
      file.text.search(ISSUE_LIKE_TRIGGER),
      'ci-oidc-untrusted-event-trigger',
      'high',
      'OIDC privilege is exposed to an issue/comment/review trigger',
      'An externally influenceable issue, comment, review, or discussion event shares a workflow with identity-token write permission.',
      'Split untrusted event processing from trusted deployment/federation. The event workflow should emit only validated data and must not receive id-token: write.',
    ));
  }

  for (const job of jobBlocks(file)) {
    const privileged = ID_TOKEN_WRITE.test(job.text) || (privilegedWorkflow && !/^\s*permissions\s*:\s*\{?\s*\}?\s*$/im.test(job.text));
    const environment = hasProtectedEnvironment(job);
    if (environment) environmentJobs += 1;
    const counts = inspectPinnedIdentityActions(file, job, findings);
    cloudLoginSteps += counts.cloud;
    provenanceSteps += counts.attest;
    inspectCheckout(file, job, privileged, findings);

    if (privileged && counts.cloud > 0 && externalTriggers > 0 && !environment) {
      findings.push(finding(
        file,
        job.offset,
        'ci-oidc-cloud-login-without-environment',
        'high',
        'Externally triggerable cloud-login job lacks a fixed environment boundary',
        'A job that performs cloud federation can be reached from an externally influenceable trigger without a fixed GitHub Environment declaration.',
        'Bind deployment/federation jobs to a fixed protected environment with reviewers and environment-scoped configuration. Do not make the environment name attacker-controlled.',
      ));
    }

    if (privileged && EXPRESSION.test(job.text.match(ENVIRONMENT)?.[1] ?? '')) {
      findings.push(finding(
        file,
        job.offset,
        'ci-oidc-dynamic-environment',
        'critical',
        'OIDC-privileged job selects environment dynamically',
        'The deployment environment for an identity-token-capable job is expression-derived, which can bypass a fixed environment trust boundary or select unintended credentials.',
        'Use a fixed protected environment name per privileged job. Route environment choice through reviewed workflow structure rather than untrusted expressions.',
      ));
    }
  }

  if (privilegedWorkflow && WORKFLOW_DISPATCH.test(file.text) && /\binputs\s*:/i.test(file.text) && UNTRUSTED_EXPRESSION.test(file.text)) {
    const sensitiveWrites = CONTENTS_WRITE.test(file.text) || PACKAGES_WRITE.test(file.text) || ATTESTATIONS_WRITE.test(file.text);
    if (sensitiveWrites) {
      findings.push(finding(
        file,
        file.text.search(WORKFLOW_DISPATCH),
        'ci-oidc-dispatch-input-privilege-review',
        'medium',
        'Manual OIDC workflow combines dispatch inputs with write privileges',
        'A manually dispatched workflow accepts inputs while combining identity-token and repository/package/attestation write privileges. Inputs must remain data, not identity or executable control.',
        'Keep dispatch inputs strongly constrained and never use them for action identity, shell source, cloud role/provider, environment selection, or unverified artifact provenance.',
        false,
      ));
    }
  }

  return {
    signal: {
      file: file.repositoryPath,
      idTokenWrite: privilegedWorkflow,
      cloudLoginSteps,
      provenanceSteps,
      externalTriggers,
      environmentJobs,
      findings: findings.length,
    },
    findings,
  };
}

export function auditOidcTrust(inventory: RepositoryInventory): AuditSection<OidcTrustSummary> {
  const started = performance.now();
  const workflows = workflowFiles(inventory);
  const inspected = workflows.map(inspectWorkflow);
  const findings = stableSortFindings(inspected.flatMap(item => item.findings));
  const signals = inspected.map(item => item.signal).sort((a, b) => a.file.localeCompare(b.file, 'en'));
  return {
    domain: 'ci',
    title: 'OIDC and cloud federation trust boundaries',
    summary: {
      workflows: signals,
      workflowFiles: workflows.length,
      privilegedWorkflows: signals.filter(signal => signal.idTokenWrite).length,
      findings,
    },
    findings,
    elapsedMs: performance.now() - started,
  };
}
