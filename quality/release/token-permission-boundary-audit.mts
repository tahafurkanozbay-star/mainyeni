import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  firstWorkflowField,
  workflowFieldBlockText,
  workflowFiles,
  workflowJobBlocks,
  workflowTopLevelBlock,
  workflowTriggerProfile,
  type WorkflowJobBlock,
} from './workflow-structure.mts';

export interface TokenPermissionSignal {
  readonly file: string;
  readonly job: string;
  readonly source: 'implicit' | 'workflow' | 'job';
  readonly externalContribution: boolean;
  readonly writeAll: boolean;
  readonly readAll: boolean;
  readonly dynamic: boolean;
  readonly writeScopes: readonly string[];
  readonly readScopes: readonly string[];
  readonly executable: boolean;
  readonly environmentBound: boolean;
}

export interface TokenPermissionBoundarySummary {
  readonly workflowFiles: number;
  readonly jobs: number;
  readonly explicitJobs: number;
  readonly implicitJobs: number;
  readonly writeCapableJobs: number;
  readonly externallyInfluencedWriteJobs: number;
  readonly signals: readonly TokenPermissionSignal[];
  readonly findings: readonly Finding[];
}

type PermissionLevel = 'read' | 'write' | 'none';

const PERMISSION_LINE = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*:\s*(read|write|none)\s*(?:#.*)?$/i;
const EXPRESSION = /\$\{\{/;
const EXECUTABLE_STEP = /^\s*-?\s*(?:run|uses)\s*:/im;
const ENVIRONMENT = /^\s*environment\s*:/im;
const HIGH_IMPACT_SCOPES = new Set(['actions', 'attestations', 'contents', 'deployments', 'packages', 'pages', 'security-events']);
const MUTATION_SCOPES = new Set(['actions', 'attestations', 'checks', 'contents', 'deployments', 'discussions', 'issues', 'packages', 'pages', 'pull-requests', 'security-events', 'statuses']);

interface ParsedPermissions {
  readonly source: TokenPermissionSignal['source'];
  readonly writeAll: boolean;
  readonly readAll: boolean;
  readonly dynamic: boolean;
  readonly scopes: ReadonlyMap<string, PermissionLevel>;
  readonly text: string;
  readonly line: number;
}

function parsePermissionText(text: string, source: TokenPermissionSignal['source'], line: number): ParsedPermissions {
  const trimmed = text.trim();
  const writeAll = /^\s*permissions\s*:\s*write-all\s*(?:#.*)?$/im.test(text);
  const readAll = /^\s*permissions\s*:\s*read-all\s*(?:#.*)?$/im.test(text);
  const dynamic = EXPRESSION.test(text);
  const scopes = new Map<string, PermissionLevel>();
  for (const raw of text.split('\n')) {
    const match = raw.match(PERMISSION_LINE);
    const scope = match?.[1]?.toLowerCase();
    const level = match?.[2]?.toLowerCase() as PermissionLevel | undefined;
    if (!scope || !level || scope === 'permissions') continue;
    scopes.set(scope, level);
  }
  if (/^\s*permissions\s*:\s*\{\s*\}\s*(?:#.*)?$/im.test(text)) scopes.clear();
  return { source, writeAll, readAll, dynamic, scopes, text: trimmed, line };
}

function permissionsFor(block: WorkflowJobBlock): ParsedPermissions {
  const jobField = firstWorkflowField(block, 'permissions');
  if (jobField) {
    return parsePermissionText(workflowFieldBlockText(block, 'permissions'), 'job', jobField.line);
  }
  const workflow = workflowTopLevelBlock(block.file, 'permissions');
  if (workflow) {
    return parsePermissionText(workflow.text, 'workflow', workflow.line.line);
  }
  return { source: 'implicit', writeAll: false, readAll: false, dynamic: false, scopes: new Map<string, PermissionLevel>(), text: '', line: 1 };
}

function writeScopes(parsed: ParsedPermissions): string[] {
  if (parsed.writeAll) return ['write-all'];
  return [...parsed.scopes.entries()].filter(([, level]) => level === 'write').map(([scope]) => scope).sort((a, b) => a.localeCompare(b, 'en'));
}

function readScopes(parsed: ParsedPermissions): string[] {
  if (parsed.readAll) return ['read-all'];
  return [...parsed.scopes.entries()].filter(([, level]) => level === 'read').map(([scope]) => scope).sort((a, b) => a.localeCompare(b, 'en'));
}

function signal(block: WorkflowJobBlock): TokenPermissionSignal {
  const parsed = permissionsFor(block);
  const trigger = workflowTriggerProfile(block.file);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    source: parsed.source,
    externalContribution: trigger.externalContribution,
    writeAll: parsed.writeAll,
    readAll: parsed.readAll,
    dynamic: parsed.dynamic,
    writeScopes: writeScopes(parsed),
    readScopes: readScopes(parsed),
    executable: EXECUTABLE_STEP.test(block.text),
    environmentBound: ENVIRONMENT.test(block.text),
  };
}

function location(block: WorkflowJobBlock, parsed: ParsedPermissions) {
  return { file: block.file.repositoryPath, line: parsed.line || block.startLine };
}

function finding(
  block: WorkflowJobBlock,
  parsed: ParsedPermissions,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  blocking = false,
): Finding {
  return {
    id,
    domain: 'security',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: location(block, parsed),
    evidence: { excerpt: parsed.text.slice(0, 320) || `job: ${block.name}`, metadata: { job: block.name, permissionSource: parsed.source } },
    remediation,
    tags: ['ci', 'token', 'permissions', 'least-privilege', 'trust-boundary'],
  };
}

function auditJob(block: WorkflowJobBlock): Finding[] {
  const parsed = permissionsFor(block);
  const current = signal(block);
  const writes = current.writeScopes;
  const findings: Finding[] = [];

  if (parsed.dynamic) {
    findings.push(finding(
      block,
      parsed,
      'ci-permission-dynamic-authority',
      'critical',
      'Workflow token authority is expression-controlled',
      `Job ${block.name} derives its permission declaration from an expression. Token authority must be reviewable as static policy, not selected by event, input, matrix, or runtime data.`,
      'Use literal permissions at workflow/job scope. Select behavior with validated data, never token authority.',
      true,
    ));
  }

  if (parsed.writeAll) {
    findings.push(finding(
      block,
      parsed,
      'ci-permission-write-all-job',
      'critical',
      'Job receives write-all repository token authority',
      `Job ${block.name} can mutate every GitHub token scope supported by write-all, substantially increasing compromise blast radius.`,
      'Replace write-all with the smallest named write scope needed by this job and set all validation jobs to contents: read or permissions: {}.',
      true,
    ));
  }

  const highImpact = writes.filter(scope => HIGH_IMPACT_SCOPES.has(scope));
  const mutationScopes = writes.filter(scope => MUTATION_SCOPES.has(scope));

  if (current.externalContribution && writes.length > 0) {
    findings.push(finding(
      block,
      parsed,
      'ci-permission-external-write-authority',
      'critical',
      'Externally influenced job has explicit write token authority',
      `Job ${block.name} is reachable from contribution-controlled events and receives write scope(s): ${writes.join(', ')}. Same-repository contributions and privileged event variants can expose mutation authority even when fork tokens are reduced.`,
      'Keep contribution validation read-only. Move mutations into a separate trusted workflow/job that consumes only validated identifiers or immutable artifacts.',
      true,
    ));
  }

  if (current.externalContribution && current.executable && parsed.source === 'workflow' && writes.length > 0) {
    findings.push(finding(
      block,
      parsed,
      'ci-permission-inherited-write-execution',
      'critical',
      'Executable contribution job inherits workflow-level write authority',
      `Job ${block.name} executes steps while inheriting write-capable permissions from workflow scope. Adding a new executable step silently inherits the same mutation authority.`,
      'Default the workflow to contents: read or permissions: {}, then grant the exact write scope only on an isolated trusted mutation job.',
      true,
    ));
  }

  if (mutationScopes.length >= 3) {
    findings.push(finding(
      block,
      parsed,
      'ci-permission-broad-write-surface',
      highImpact.length > 0 ? 'high' : 'medium',
      'Job has a broad write-permission surface',
      `Job ${block.name} receives ${mutationScopes.length} independent mutation scopes (${mutationScopes.join(', ')}). Broad authority makes unrelated repository resources reachable after a single step compromise.`,
      'Split publishing, deployment, issue/PR mutation and repository-content mutation into narrowly scoped jobs with only the permission each job requires.',
    ));
  }

  if (writes.includes('actions')) {
    findings.push(finding(
      block,
      parsed,
      'ci-permission-actions-write',
      current.externalContribution ? 'critical' : 'high',
      'Job can mutate GitHub Actions state',
      `Job ${block.name} has actions: write, which can cancel/delete workflow runs and artifacts and should be rarer than ordinary repository mutation authority.`,
      'Remove actions: write unless the job explicitly manages workflow runs/caches. If required, isolate it in a trusted non-checkout job with fixed inputs.',
      current.externalContribution,
    ));
  }

  if (writes.includes('security-events') && current.externalContribution) {
    findings.push(finding(
      block,
      parsed,
      'ci-permission-external-security-events-write',
      'critical',
      'Externally influenced job can publish security events',
      `Job ${block.name} can write security-events from an externally influenced execution, allowing untrusted code or payloads to affect repository security evidence.`,
      'Generate and upload security evidence only from trusted reviewed code. Keep external validation unable to publish security-events.',
      true,
    ));
  }

  if (writes.includes('deployments') && !current.environmentBound) {
    findings.push(finding(
      block,
      parsed,
      'ci-permission-deployment-write-without-environment',
      'high',
      'Deployment mutation authority is not bound to an environment',
      `Job ${block.name} has deployments: write but no job environment binding, so GitHub environment policy cannot act as an additional release boundary.`,
      'Bind deployment-capable jobs to a fixed repository-controlled environment and configure required protection/review policy there.',
    ));
  }

  return findings;
}

export function auditTokenPermissionBoundaries(inventory: RepositoryInventory): AuditSection<TokenPermissionBoundarySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowJobBlocks(file));
  const signals = jobs.map(signal);
  const findings = stableSortFindings(jobs.flatMap(auditJob));
  return {
    domain: 'security',
    title: 'GitHub token permission boundary audit',
    summary: {
      workflowFiles: files.length,
      jobs: signals.length,
      explicitJobs: signals.filter(item => item.source !== 'implicit').length,
      implicitJobs: signals.filter(item => item.source === 'implicit').length,
      writeCapableJobs: signals.filter(item => item.writeAll || item.writeScopes.length > 0).length,
      externallyInfluencedWriteJobs: signals.filter(item => item.externalContribution && (item.writeAll || item.writeScopes.length > 0)).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
