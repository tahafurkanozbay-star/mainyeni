import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { createLineIndex, snippetAround } from './inventory.mts';

export interface CiWorkflowSignal {
  readonly file: string;
  readonly actions: number;
  readonly shaPinnedActions: number;
  readonly mutableActions: number;
  readonly hasPermissions: boolean;
  readonly pullRequestTarget: boolean;
  readonly checkoutCount: number;
  readonly scriptDownloadPipes: number;
}

export interface CiIntegritySummary {
  readonly workflows: readonly CiWorkflowSignal[];
  readonly workflowFiles: number;
  readonly mutableActionReferences: number;
  readonly shaPinnedActionReferences: number;
  readonly findings: readonly Finding[];
}

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const USES = /^\s*-?\s*uses\s*:\s*([^\s#]+)(?:\s+#.*)?$/gim;
const PERMISSIONS = /^permissions\s*:/m;
const PULL_REQUEST_TARGET = /^\s*pull_request_target\s*:/m;
const CHECKOUT = /uses\s*:\s*actions\/checkout@/gi;
const DOWNLOAD_PIPE = /\b(?:curl|wget)\b[^\n|]{0,300}\|\s*(?:sudo\s+)?(?:ba)?sh\b/gi;
const WRITE_PERMISSION = /^\s*(?:contents|actions|checks|deployments|issues|packages|pages|pull-requests|security-events|statuses)\s*:\s*write\s*$/gim;
const TOP_LEVEL_WRITE_ALL = /^permissions\s*:\s*write-all\s*$/m;
const PERSIST_CREDENTIALS_FALSE = /persist-credentials\s*:\s*false/i;
const PR_HEAD_CHECKOUT = /ref\s*:\s*\$\{\{\s*github\.event\.pull_request\.head\.(?:sha|ref)\s*\}\}/i;
const SECRET_REFERENCE = /\$\{\{\s*secrets\./i;
const SHA40 = /^[0-9a-f]{40}$/i;

function workflowFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => WORKFLOW_PATH.test(file.repositoryPath));
}

interface ActionUse {
  readonly value: string;
  readonly index: number;
  readonly ownerRepo: string;
  readonly ref: string;
  readonly local: boolean;
  readonly docker: boolean;
}

function actionUses(file: SourceFile): ActionUse[] {
  const uses: ActionUse[] = [];
  const matcher = new RegExp(USES.source, USES.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(file.text)) !== null) {
    const value = match[1] ?? '';
    const local = value.startsWith('./');
    const docker = value.startsWith('docker://');
    const at = value.lastIndexOf('@');
    uses.push({
      value,
      index: match.index,
      ownerRepo: at > 0 ? value.slice(0, at) : value,
      ref: at > 0 ? value.slice(at + 1) : '',
      local,
      docker,
    });
  }
  return uses;
}

function signal(file: SourceFile): CiWorkflowSignal {
  const uses = actionUses(file).filter(item => !item.local && !item.docker);
  return {
    file: file.repositoryPath,
    actions: uses.length,
    shaPinnedActions: uses.filter(item => SHA40.test(item.ref)).length,
    mutableActions: uses.filter(item => !SHA40.test(item.ref)).length,
    hasPermissions: PERMISSIONS.test(file.text),
    pullRequestTarget: PULL_REQUEST_TARGET.test(file.text),
    checkoutCount: (file.text.match(CHECKOUT) ?? []).length,
    scriptDownloadPipes: (file.text.match(DOWNLOAD_PIPE) ?? []).length,
  };
}

function mutableActionFindings(file: SourceFile): Finding[] {
  const index = createLineIndex(file.text);
  const findings: Finding[] = [];
  for (const action of actionUses(file)) {
    if (action.local || action.docker || SHA40.test(action.ref)) continue;
    findings.push({
      id: 'ci-action-mutable-ref',
      domain: 'security',
      severity: 'medium',
      title: 'CI action uses a mutable ref',
      message: `${action.ownerRepo} is referenced by mutable ref ${action.ref || '(missing)'}. A moved tag or branch changes executable CI code without a repository diff.`,
      location: { file: file.repositoryPath, line: index.lineAt(action.index) },
      evidence: { excerpt: snippetAround(file.text, action.index, 100) },
      remediation: 'Pin third-party and GitHub Actions to a reviewed full commit SHA; optionally retain the release tag in a comment for update tooling.',
      tags: ['ci', 'supply-chain', 'actions'],
    });
  }
  return findings;
}

function permissionFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  if (!PERMISSIONS.test(file.text)) {
    findings.push({
      id: 'ci-permissions-implicit',
      domain: 'security',
      severity: 'high',
      title: 'Workflow relies on implicit token permissions',
      message: 'Workflow token authority should be explicit so repository defaults cannot silently broaden CI privileges.',
      location: { file: file.repositoryPath, line: 1 },
      remediation: 'Declare top-level permissions: contents: read, then grant narrowly scoped job-level writes only where required.',
      tags: ['ci', 'least-privilege', 'token'],
    });
  }
  if (TOP_LEVEL_WRITE_ALL.test(file.text)) {
    findings.push({
      id: 'ci-permissions-write-all',
      domain: 'security',
      severity: 'critical',
      blocking: true,
      title: 'Workflow grants write-all token authority',
      message: 'Repository-wide write-all permissions materially increase impact if a step or dependency is compromised.',
      location: { file: file.repositoryPath, line: 1 },
      remediation: 'Replace write-all with the minimum named permission required by the specific job.',
      tags: ['ci', 'least-privilege', 'token'],
    });
  }
  const matcher = new RegExp(WRITE_PERMISSION.source, WRITE_PERMISSION.flags);
  const lineIndex = createLineIndex(file.text);
  let match: RegExpExecArray | null;
  let emitted = 0;
  while ((match = matcher.exec(file.text)) !== null) {
    findings.push({
      id: 'ci-write-permission-review',
      domain: 'security',
      severity: 'low',
      title: 'CI workflow has write permission',
      message: 'Write-capable workflow tokens require a narrow job purpose and trusted execution boundary.',
      location: { file: file.repositoryPath, line: lineIndex.lineAt(match.index) },
      evidence: { excerpt: match[0].trim() },
      remediation: 'Keep write permission job-scoped and ensure untrusted pull-request code cannot execute with that token.',
      tags: ['ci', 'least-privilege'],
    });
    if (++emitted >= 8) break;
  }
  return findings;
}

function dangerousTriggerFindings(file: SourceFile): Finding[] {
  if (!PULL_REQUEST_TARGET.test(file.text)) return [];
  const findings: Finding[] = [];
  if (PR_HEAD_CHECKOUT.test(file.text)) {
    findings.push({
      id: 'ci-pr-target-untrusted-checkout',
      domain: 'security',
      severity: 'critical',
      blocking: true,
      title: 'pull_request_target checks out pull-request head',
      message: 'Executing untrusted PR code in pull_request_target can expose the base repository token and secrets.',
      location: { file: file.repositoryPath, line: 1 },
      remediation: 'Use pull_request for untrusted code execution. Reserve pull_request_target for metadata-only trusted-base workflows.',
      tags: ['ci', 'pull-request-target', 'secrets'],
    });
  }
  if (SECRET_REFERENCE.test(file.text)) {
    findings.push({
      id: 'ci-pr-target-secret-review',
      domain: 'security',
      severity: 'high',
      title: 'pull_request_target workflow references secrets',
      message: 'Secret-bearing target-context workflows must never execute attacker-controlled pull-request code or arguments.',
      location: { file: file.repositoryPath, line: 1 },
      remediation: 'Separate privileged metadata work from PR code execution and validate all untrusted inputs.',
      tags: ['ci', 'pull-request-target', 'secrets'],
    });
  }
  return findings;
}

function shellSupplyChainFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  const matcher = new RegExp(DOWNLOAD_PIPE.source, DOWNLOAD_PIPE.flags);
  const index = createLineIndex(file.text);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(file.text)) !== null) {
    findings.push({
      id: 'ci-download-pipe-shell',
      domain: 'security',
      severity: 'high',
      title: 'CI downloads code directly into a shell',
      message: 'Piping mutable network content directly to a shell bypasses artifact integrity verification and review.',
      location: { file: file.repositoryPath, line: index.lineAt(match.index) },
      evidence: { excerpt: snippetAround(file.text, match.index, 120) },
      remediation: 'Download a versioned artifact, verify its expected digest/signature, then execute the verified local file.',
      tags: ['ci', 'supply-chain', 'shell'],
    });
  }
  return findings;
}

function checkoutCredentialFindings(file: SourceFile): Finding[] {
  if (!CHECKOUT.test(file.text)) return [];
  CHECKOUT.lastIndex = 0;
  if (PERSIST_CREDENTIALS_FALSE.test(file.text)) return [];
  if (!/(?:npm\s+(?:ci|test|run)|node\s|dotnet\s+(?:test|run|build)|pytest|gradle|mvn)/i.test(file.text)) return [];
  return [{
    id: 'ci-checkout-credentials-persist',
    domain: 'security',
    severity: 'low',
    title: 'Checkout credentials persist during executable validation',
    message: 'The checkout token remains in git configuration while repository-controlled build or test code executes.',
    location: { file: file.repositoryPath, line: 1 },
    remediation: 'For read-only validation jobs, set actions/checkout persist-credentials: false unless later authenticated git operations are required.',
    tags: ['ci', 'token', 'checkout'],
  }];
}

export function auditCiIntegrity(inventory: RepositoryInventory): AuditSection<CiIntegritySummary> {
  const start = performance.now();
  const files = workflowFiles(inventory);
  const workflows = files.map(signal);
  const findings = stableSortFindings(files.flatMap(file => [
    ...mutableActionFindings(file),
    ...permissionFindings(file),
    ...dangerousTriggerFindings(file),
    ...shellSupplyChainFindings(file),
    ...checkoutCredentialFindings(file),
  ]));
  return {
    domain: 'security',
    title: 'CI workflow integrity and supply-chain audit',
    summary: {
      workflows,
      workflowFiles: workflows.length,
      mutableActionReferences: workflows.reduce((sum, item) => sum + item.mutableActions, 0),
      shaPinnedActionReferences: workflows.reduce((sum, item) => sum + item.shaPinnedActions, 0),
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - start),
  };
}
