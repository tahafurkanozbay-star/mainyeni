import { stableSortFindings, type AuditSection, type Finding, type RepositoryInventory, type SourceFile } from './contracts.mts';
import { createLineIndex, snippetAround } from './inventory.mts';

export interface EnvironmentApprovalSignal {
  readonly file: string;
  readonly deploymentJobs: number;
  readonly protectedEnvironmentJobs: number;
  readonly dynamicEnvironmentJobs: number;
  readonly externalDeploymentJobs: number;
}
export interface EnvironmentApprovalSummary {
  readonly workflows: readonly EnvironmentApprovalSignal[];
  readonly findings: readonly Finding[];
}

type EventClass = 'trusted' | 'external' | 'manual' | 'reusable' | 'unknown';
interface JobBlock { readonly name: string; readonly text: string; readonly offset: number; }
const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const DEPLOYMENT = /\b(?:deploy|deployment|publish|release|production|prod|pages|package|registry|sign|attest)\b/i;
const MUTATION = /\b(?:gh\s+release\s+(?:create|upload)|npm\s+publish|dotnet\s+nuget\s+push|docker\s+(?:push|buildx)|helm\s+(?:push|upgrade)|kubectl\s+(?:apply|set|rollout)|az\s+(?:webapp|containerapp)|aws\s+(?:s3\s+sync|ecs\s+update)|gcloud\s+(?:run\s+deploy|app\s+deploy))\b/i;
const EXTERNAL_TRIGGER = /\b(?:pull_request_target|pull_request|issue_comment|issues|discussion|discussion_comment|workflow_run)\s*:/i;
const MANUAL_TRIGGER = /\bworkflow_dispatch\s*:/i;
const REUSABLE_TRIGGER = /\bworkflow_call\s*:/i;
const DYNAMIC = /\$\{\{/;
const TRUSTED_ENV = /^(?:production|prod|release|staging|stage|preview)$/i;

function workflows(inventory: RepositoryInventory) { return inventory.files.filter(file => WORKFLOW_PATH.test(file.repositoryPath)); }
function lines(text: string) { const out: Array<{ text: string; offset: number }> = []; let offset = 0; for (const raw of text.split('\n')) { out.push({ text: raw, offset }); offset += raw.length + 1; } return out; }
function indent(line: string) { return line.match(/^\s*/)?.[0].length ?? 0; }
function eventClass(file: SourceFile): EventClass {
  const on = file.text.match(/(?:^|\n)on\s*:\s*([\s\S]*?)(?=\n\S|$)/m)?.[0] ?? file.text;
  if (EXTERNAL_TRIGGER.test(on)) return 'external';
  if (MANUAL_TRIGGER.test(on)) return 'manual';
  if (REUSABLE_TRIGGER.test(on)) return 'reusable';
  if (/\b(?:push|schedule)\s*:/i.test(on)) return 'trusted';
  return 'unknown';
}
function jobBlocks(file: SourceFile): JobBlock[] {
  const physical = lines(file.text); const result: JobBlock[] = [];
  let jobsIndent = -1; let current: { name: string; start: number; line: number; indent: number } | undefined;
  for (let i = 0; i < physical.length; i++) {
    const line = physical[i]!.text; const trimmed = line.trim(); const level = indent(line);
    if (/^jobs\s*:\s*$/.test(trimmed)) { jobsIndent = level; continue; }
    if (jobsIndent < 0) continue;
    if (trimmed && level <= jobsIndent && !/^jobs\s*:/.test(trimmed)) break;
    const match = line.match(/^(\s*)([A-Za-z0-9_-]+)\s*:\s*(?:#.*)?$/);
    if (match && level === jobsIndent + 2) {
      if (current) result.push({ name: current.name, offset: current.start, text: file.text.slice(current.start, physical[i]!.offset) });
      current = { name: match[2]!, start: physical[i]!.offset, line: i, indent: level };
    }
  }
  if (current) result.push({ name: current.name, offset: current.start, text: file.text.slice(current.start) });
  return result;
}
function environmentValue(job: JobBlock): { value: string; offset: number } | undefined {
  const physical = lines(job.text);
  for (const line of physical) {
    const match = line.text.match(/^\s*environment\s*:\s*(.+?)\s*(?:#.*)?$/i);
    if (match) return { value: match[1]!.trim().replace(/^['"]|['"]$/g, ''), offset: job.offset + line.offset + line.text.indexOf(match[1]!) };
    if (/^\s*environment\s*:\s*$/.test(line.text)) {
      const tail = job.text.slice(line.offset + line.text.length + 1);
      const name = tail.match(/^\s+name\s*:\s*(.+?)\s*(?:#.*)?$/m);
      if (name) return { value: name[1]!.trim().replace(/^['"]|['"]$/g, ''), offset: job.offset + line.offset + line.text.length + 1 + (name.index ?? 0) + name[0].indexOf(name[1]!) };
    }
  }
  return undefined;
}
function deploymentJob(job: JobBlock) { return DEPLOYMENT.test(job.name) || MUTATION.test(job.text) || /\b(?:environment|deployment)\s*:/i.test(job.text); }
function privileged(job: JobBlock) { return /permissions\s*:[\s\S]*?\b(?:contents|packages|pages|id-token|deployments)\s*:\s*write/i.test(job.text) || /\b(?:secrets\.|environment\s*:)/i.test(job.text); }
function location(file: SourceFile, index: number) { return { file: file.repositoryPath, line: createLineIndex(file.text).lineAt(index) }; }
function finding(file: SourceFile, index: number, id: string, title: string, message: string, remediation: string, severity: Finding['severity'] = 'critical'): Finding {
  return { id, domain: 'security', severity, blocking: severity === 'critical' || severity === 'high', title, message, location: location(file, index), evidence: { excerpt: snippetAround(file.text, index, 160) }, remediation, tags: ['ci', 'deployment', 'environment', 'approval'] };
}
function findingsFor(file: SourceFile): Finding[] {
  const trigger = eventClass(file); const result: Finding[] = [];
  for (const job of jobBlocks(file)) {
    if (!deploymentJob(job)) continue;
    const env = environmentValue(job); const isPrivileged = privileged(job);
    if (!env && isPrivileged) result.push(finding(file, job.offset, 'ci-deployment-missing-environment', 'Privileged deployment job has no environment approval boundary', 'A release/deployment job with mutation authority is not attached to a GitHub Environment, so repository environment protection cannot gate the mutation.', 'Attach the job to a protected, literal GitHub Environment and configure required reviewers/deployment protection in repository settings.'));
    if (!env) continue;
    if (DYNAMIC.test(env.value)) result.push(finding(file, env.offset, 'ci-deployment-dynamic-environment', 'Deployment environment identity is expression-derived', 'Expression-derived environment names can route privileged deployment around the reviewed protection boundary.', 'Use a literal protected environment identity for privileged release jobs.'));
    if (trigger === 'external' && isPrivileged) result.push(finding(file, env.offset, 'ci-external-deployment-environment', 'External-event workflow reaches a privileged deployment environment', 'External event material reaches a job with deployment authority. Environment approval alone must not be treated as input trust.', 'Split external validation from trusted promotion; consume only verified immutable artifacts from a trusted upstream workflow.'));
    if ((trigger === 'manual' || trigger === 'reusable') && DYNAMIC.test(job.text) && isPrivileged) result.push(finding(file, env.offset, 'ci-input-controlled-deployment', 'Callable deployment job combines dynamic input with privileged environment authority', 'Manual/reusable inputs are present in a privileged deployment job and can influence release behavior.', 'Validate inputs against a closed allowlist before the privileged job and keep environment/ref/artifact identities literal or verified.'));
    if (isPrivileged && !DYNAMIC.test(env.value) && !TRUSTED_ENV.test(env.value)) result.push(finding(file, env.offset, 'ci-unrecognized-deployment-environment', 'Privileged deployment uses a non-canonical environment identity', `Environment '${env.value}' is not a recognized production/staging/release boundary.`, 'Use a canonical protected environment or explicitly extend the audited environment policy.', 'high'));
  }
  return result;
}
function signal(file: SourceFile): EnvironmentApprovalSignal {
  const jobs = jobBlocks(file).filter(deploymentJob); const envs = jobs.map(job => environmentValue(job));
  return { file: file.repositoryPath, deploymentJobs: jobs.length, protectedEnvironmentJobs: envs.filter(Boolean).length, dynamicEnvironmentJobs: envs.filter(env => env && DYNAMIC.test(env.value)).length, externalDeploymentJobs: eventClass(file) === 'external' ? jobs.length : 0 };
}
export function auditWorkflowEnvironmentApprovals(inventory: RepositoryInventory): AuditSection<EnvironmentApprovalSummary> {
  const start = performance.now(); const files = workflows(inventory); const workflowSignals = files.map(signal); const findings = stableSortFindings(files.flatMap(findingsFor));
  return { domain: 'security', title: 'Workflow deployment environment approval boundary audit', summary: { workflows: workflowSignals, findings }, findings, elapsedMs: Math.max(0, performance.now() - start) };
}
