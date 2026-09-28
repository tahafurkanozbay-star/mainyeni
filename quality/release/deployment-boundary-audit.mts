import type { AuditSection, Finding, RepositoryInventory, SourceFile } from './contracts.mts';

export interface DeploymentBoundarySummary {
  readonly workflowFiles: number;
  readonly deploymentJobs: number;
  readonly protectedJobs: number;
  readonly mutableEnvironmentJobs: number;
  readonly findings: readonly Finding[];
}

interface JobBlock {
  readonly file: SourceFile;
  readonly name: string;
  readonly startLine: number;
  readonly text: string;
}

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const DEPLOYMENT_SIGNAL = /(?:\bdeploy(?:ment|ing)?\b|kubectl\b|helm\b|az\s+(?:webapp|containerapp|functionapp)\b|aws\s+(?:ecs|lambda|cloudformation|s3)\b|gcloud\s+(?:run|functions|app)\b|terraform\s+apply\b|pulumi\s+up\b)/i;
const WRITE_PERMISSION = /\b(?:contents|packages|deployments|pages|id-token)\s*:\s*write\b/i;
const UNTRUSTED_TRIGGER = /\b(?:pull_request_target|issues|issue_comment|pull_request_review|pull_request_review_comment|discussion|discussion_comment)\s*:/i;
const MUTABLE_REF = /\$\{\{\s*(?:github\.head_ref|github\.event\.pull_request\.head\.(?:ref|sha)|github\.event\.issue\.|github\.event\.comment\.|inputs\.|github\.event\.inputs\.)/i;
const ENVIRONMENT_EXPR = /\benvironment\s*:\s*(?:\n\s+name\s*:\s*)?[^\n]*\$\{\{/i;
const FIXED_ENVIRONMENT = /\benvironment\s*:\s*(?:["']?[A-Za-z0-9_.-]+["']?|\n\s+name\s*:\s*["']?[A-Za-z0-9_.-]+["']?)\s*(?:#.*)?$/im;
const CHECKOUT_HEAD = /uses\s*:\s*actions\/checkout@[0-9a-f]{40}[\s\S]{0,500}?\bref\s*:\s*[^\n]*(?:head_ref|pull_request\.head|event\.issue|event\.comment)/i;
const SECRET_REFERENCE = /\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}/i;
const ENV_SECRET_REFERENCE = /\$\{\{\s*(?:vars|env)\.[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL)[A-Za-z0-9_]*\s*\}\}/i;

function indentation(line: string): number {
  return line.match(/^\s*/)?.[0]?.length ?? 0;
}

function workflowFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => WORKFLOW_PATH.test(file.repositoryPath));
}

function lineNumber(text: string, index: number): number {
  return text.slice(0, Math.max(0, index)).split('\n').length;
}

function jobBlocks(file: SourceFile): JobBlock[] {
  const lines = file.text.split('\n');
  const jobsLine = lines.findIndex(line => /^jobs\s*:\s*(?:#.*)?$/.test(line.trim()));
  if (jobsLine < 0) return [];
  const jobsIndent = indentation(lines[jobsLine] ?? '');
  const starts: Array<{ name: string; line: number; indent: number }> = [];
  for (let index = jobsLine + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = indentation(line);
    if (indent <= jobsIndent) break;
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(?:#.*)?$/);
    if (match && indent > jobsIndent) {
      const previous = starts.at(-1);
      if (!previous || indent <= previous.indent) starts.push({ name: match[1] ?? 'unknown', line: index, indent });
    }
  }
  return starts.map((start, position) => {
    const next = starts[position + 1];
    const end = next?.line ?? lines.length;
    return { file, name: start.name, startLine: start.line + 1, text: lines.slice(start.line, end).join('\n') };
  });
}

function location(job: JobBlock, pattern: RegExp) {
  const match = pattern.exec(job.text);
  return { file: job.file.repositoryPath, line: job.startLine + lineNumber(job.text, match?.index ?? 0) - 1 };
}

function finding(job: JobBlock, id: string, severity: Finding['severity'], title: string, message: string, remediation: string, pattern: RegExp, blocking = false): Finding {
  return {
    id,
    domain: 'security',
    severity,
    title,
    message,
    location: location(job, pattern),
    evidence: { excerpt: pattern.exec(job.text)?.[0]?.slice(0, 240) ?? job.name, metadata: { job: job.name } },
    remediation,
    ...(blocking ? { blocking: true } : {}),
    tags: ['deployment', 'ci-cd', 'trust-boundary'],
  };
}

function isDeploymentJob(job: JobBlock): boolean {
  return DEPLOYMENT_SIGNAL.test(job.name) || DEPLOYMENT_SIGNAL.test(job.text);
}

function hasFixedEnvironment(job: JobBlock): boolean {
  return FIXED_ENVIRONMENT.test(job.text) && !ENVIRONMENT_EXPR.test(job.text);
}

function workflowTriggerPrefix(file: SourceFile): string {
  const jobsIndex = file.text.search(/^jobs\s*:/m);
  return jobsIndex >= 0 ? file.text.slice(0, jobsIndex) : file.text;
}

function auditJob(job: JobBlock, triggerPrefix: string): Finding[] {
  if (!isDeploymentJob(job)) return [];
  const findings: Finding[] = [];
  const privileged = WRITE_PERMISSION.test(job.text) || /\bid-token\s*:\s*write\b/i.test(job.file.text);
  const untrusted = UNTRUSTED_TRIGGER.test(triggerPrefix);

  if (!hasFixedEnvironment(job)) {
    const dynamic = ENVIRONMENT_EXPR.test(job.text);
    findings.push(finding(
      job,
      dynamic ? 'deployment-dynamic-environment' : 'deployment-missing-protected-environment',
      privileged || untrusted ? 'critical' : 'high',
      dynamic ? 'Deployment selects its environment dynamically' : 'Deployment job has no fixed protected environment',
      dynamic
        ? `Deployment job ${job.name} derives its environment from an expression, so repository-controlled environment protection can be bypassed or routed unexpectedly.`
        : `Deployment job ${job.name} performs release-like operations without a fixed GitHub environment boundary.`,
      'Bind every deployment job to a fixed, repository-controlled GitHub environment and configure required reviewers/protection rules outside the workflow.',
      dynamic ? ENVIRONMENT_EXPR : DEPLOYMENT_SIGNAL,
      privileged || untrusted,
    ));
  }

  if (untrusted && (privileged || SECRET_REFERENCE.test(job.text))) {
    findings.push(finding(
      job,
      'deployment-untrusted-trigger-privilege',
      'critical',
      'Untrusted event can reach privileged deployment job',
      `Deployment job ${job.name} is reachable from an event whose payload can be influenced by an external contributor while write credentials, OIDC, or secrets are available.`,
      'Move deployment to a trusted push/workflow_run/workflow_dispatch boundary with explicit authorization and keep untrusted-event workflows read-only.',
      UNTRUSTED_TRIGGER.test(job.text) ? UNTRUSTED_TRIGGER : DEPLOYMENT_SIGNAL,
      true,
    ));
  }

  if (MUTABLE_REF.test(job.text) && (privileged || SECRET_REFERENCE.test(job.text))) {
    findings.push(finding(
      job,
      'deployment-attacker-controlled-ref',
      'critical',
      'Privileged deployment consumes attacker-controlled reference',
      `Deployment job ${job.name} uses an event/input-derived ref while privileged credentials or secrets are in scope.`,
      'Deploy only an immutable artifact or commit SHA produced by a trusted build; never checkout or deploy an untrusted PR/input ref in a privileged job.',
      MUTABLE_REF,
      true,
    ));
  }

  if (CHECKOUT_HEAD.test(job.text) && (privileged || SECRET_REFERENCE.test(job.text))) {
    findings.push(finding(
      job,
      'deployment-privileged-pr-head-checkout',
      'critical',
      'Privileged deployment checks out untrusted head code',
      `Deployment job ${job.name} checks out an externally controlled head/ref before privileged deployment operations.`,
      'Separate untrusted build/test from trusted deployment and promote only verified immutable artifacts across the boundary.',
      CHECKOUT_HEAD,
      true,
    ));
  }

  if (ENV_SECRET_REFERENCE.test(job.text)) {
    findings.push(finding(
      job,
      'deployment-secret-like-value-outside-secrets',
      'high',
      'Deployment credential appears to come from env/vars rather than secrets',
      `Deployment job ${job.name} references a credential-shaped value through env/vars, which can weaken secret provenance and reviewability.`,
      'Store credentials in GitHub environment/repository secrets or use short-lived OIDC federation; do not place credential material in vars or committed environment values.',
      ENV_SECRET_REFERENCE,
    ));
  }

  const artifactDownload = /uses\s*:\s*actions\/download-artifact@[0-9a-f]{40}/i.test(job.text);
  const deployCommand = DEPLOYMENT_SIGNAL.test(job.text);
  const digestVerification = /(?:sha256sum\s+-c|cosign\s+verify|attest(?:ation)?\s+verify|gh\s+attestation\s+verify)/i.test(job.text);
  if (artifactDownload && deployCommand && !digestVerification) {
    findings.push(finding(
      job,
      'deployment-artifact-unverified-before-promotion',
      'high',
      'Downloaded artifact is deployed without explicit integrity verification',
      `Deployment job ${job.name} downloads an artifact and performs deployment without an explicit digest or attestation verification step.`,
      'Verify the promoted artifact digest or provenance attestation immediately before deployment, and bind verification to the expected repository/commit.',
      /uses\s*:\s*actions\/download-artifact@[0-9a-f]{40}/i,
    ));
  }

  return findings;
}

export function auditDeploymentBoundaries(inventory: RepositoryInventory): AuditSection<DeploymentBoundarySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => jobBlocks(file));
  const deploymentJobs = jobs.filter(isDeploymentJob);
  const findings = files.flatMap(file => {
    const prefix = workflowTriggerPrefix(file);
    return jobBlocks(file).flatMap(job => auditJob(job, prefix));
  });
  const protectedJobs = deploymentJobs.filter(hasFixedEnvironment).length;
  const mutableEnvironmentJobs = deploymentJobs.filter(job => ENVIRONMENT_EXPR.test(job.text)).length;
  return {
    domain: 'security',
    title: 'Deployment trust-boundary audit',
    summary: {
      workflowFiles: files.length,
      deploymentJobs: deploymentJobs.length,
      protectedJobs,
      mutableEnvironmentJobs,
      findings,
    },
    findings,
    elapsedMs: performance.now() - started,
  };
}
