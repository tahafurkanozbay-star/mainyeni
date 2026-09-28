import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  jobHasSecrets,
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

export interface ArtifactExecutionSignal {
  readonly file: string;
  readonly job: string;
  readonly downloadStep: string;
  readonly artifactName: string;
  readonly downloadPath: string;
  readonly crossRun: boolean;
  readonly externalContribution: boolean;
  readonly privileged: boolean;
  readonly verificationObserved: boolean;
  readonly executionObserved: boolean;
  readonly pathMutationObserved: boolean;
  readonly extractionObserved: boolean;
}

export interface ArtifactExecutionBoundarySummary {
  readonly workflowFiles: number;
  readonly artifactDownloads: number;
  readonly crossRunDownloads: number;
  readonly executedDownloads: number;
  readonly verifiedBeforeExecution: number;
  readonly signals: readonly ArtifactExecutionSignal[];
  readonly findings: readonly Finding[];
}

const DOWNLOAD_ARTIFACT = /^actions\/download-artifact@[0-9a-f]{40}$/i;
const CROSS_RUN_EXPRESSION = /\$\{\{\s*(?:github\.event\.workflow_run\.id|inputs\.run_id|github\.event\.client_payload\.)/i;
const VERIFY = /(?:\bsha(?:256|512)sum\s+(?:--check|-c)\b|\bshasum\s+-a\s+(?:256|512)\s+-c\b|\bgh\s+attestation\s+verify\b|\bcosign\s+verify(?:-blob)?\b|\bopenssl\s+dgst\s+-sha(?:256|512)\b)/i;
const EXECUTE = /(?:^|[;&|]\s*)(?:\.\/|bash\s+|sh\s+|zsh\s+|node\s+|python(?:3)?\s+|pwsh\s+(?:-File\s+)?|powershell\s+(?:-File\s+)?|dotnet\s+|java\s+-jar\s+|\.\s+|source\s+)/im;
const CHMOD_EXEC = /\bchmod\s+(?:[^\n]*\+x|[0-7]*[1357][0-7]{2})\b/i;
const GITHUB_PATH = /(?:>>?|Out-File[^\n]*)\s*['"]?\$?(?:GITHUB_PATH|env:GITHUB_PATH)\b/i;
const PATH_EXPORT = /\b(?:export\s+PATH\s*=|PATH\s*=)[^\n]*(?:\$PATH|%PATH%)/i;
const EXTRACT = /\b(?:tar\s+(?:-[^\s]*x|--extract)|unzip\b|Expand-Archive\b|7z\s+x\b)/i;

interface DownloadRecord {
  readonly step: WorkflowStepBlock;
  readonly artifactName: string;
  readonly path: string;
  readonly crossRun: boolean;
}

function privileged(block: WorkflowJobBlock): boolean {
  return jobHasWriteAuthority(block) || jobHasSecrets(block) || jobUsesProtectedEnvironment(block);
}

function normalizePath(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/').replace(/\/+$/g, '');
}

function downloadRecord(step: WorkflowStepBlock): DownloadRecord | undefined {
  const identity = stepUsesIdentity(step);
  if (!identity || !DOWNLOAD_ARTIFACT.test(identity.raw)) return undefined;
  const withMap = stepNestedMapping(step, 'with');
  const artifactName = withMap.get('name') ?? withMap.get('pattern') ?? '';
  const path = normalizePath(withMap.get('path') ?? '.');
  const selectors = [
    withMap.get('run-id') ?? '',
    withMap.get('repository') ?? '',
    withMap.get('github-token') ?? '',
  ].join('\n');
  return {
    step,
    artifactName,
    path,
    crossRun: CROSS_RUN_EXPRESSION.test(selectors) || withMap.has('run-id'),
  };
}

function pathReferenced(run: string, path: string): boolean {
  if (!run.trim()) return false;
  if (!path || path === '.' || path === './') return true;
  const normalizedRun = run.replace(/\\/g, '/');
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s'"./])${escaped}(?:[/\\s'"$]|$)`, 'i').test(normalizedRun);
}

function executionEvidence(run: string, path: string): boolean {
  if (!pathReferenced(run, path)) return false;
  return EXECUTE.test(run) || CHMOD_EXEC.test(run);
}

function verificationEvidence(run: string, path: string): boolean {
  if (!VERIFY.test(run)) return false;
  return pathReferenced(run, path) || /artifact|dist|bundle|package|download/i.test(run);
}

function pathMutationEvidence(run: string, path: string): boolean {
  if (!pathReferenced(run, path)) return false;
  return GITHUB_PATH.test(run) || PATH_EXPORT.test(run);
}

function extractionEvidence(run: string, path: string): boolean {
  return pathReferenced(run, path) && EXTRACT.test(run);
}

function subsequentSteps(steps: readonly WorkflowStepBlock[], download: WorkflowStepBlock): WorkflowStepBlock[] {
  return steps.filter(step => step.index > download.index);
}

function signalFor(block: WorkflowJobBlock, steps: readonly WorkflowStepBlock[], record: DownloadRecord): ArtifactExecutionSignal {
  let verificationObserved = false;
  let executionObserved = false;
  let pathMutationObserved = false;
  let extractionObserved = false;
  for (const step of subsequentSteps(steps, record.step)) {
    const run = stepRunText(step);
    if (!run) continue;
    if (verificationEvidence(run, record.path)) verificationObserved = true;
    if (executionEvidence(run, record.path)) executionObserved = true;
    if (pathMutationEvidence(run, record.path)) pathMutationObserved = true;
    if (extractionEvidence(run, record.path)) extractionObserved = true;
  }
  const trigger = workflowTriggerProfile(block.file);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    downloadStep: stepDisplayName(record.step),
    artifactName: record.artifactName,
    downloadPath: record.path,
    crossRun: record.crossRun,
    externalContribution: trigger.externalContribution,
    privileged: privileged(block),
    verificationObserved,
    executionObserved,
    pathMutationObserved,
    extractionObserved,
  };
}

function location(record: DownloadRecord) {
  return { file: record.step.job.file.repositoryPath, line: firstWorkflowStepField(record.step, 'uses')?.line ?? record.step.startLine };
}

function findingsFor(current: ArtifactExecutionSignal, record: DownloadRecord): Finding[] {
  const findings: Finding[] = [];
  const where = location(record);
  const dangerousUse = current.executionObserved || current.pathMutationObserved;

  if (dangerousUse && !current.verificationObserved) {
    const block = current.crossRun || current.privileged || current.externalContribution;
    findings.push({
      id: 'ci-artifact-execution-unverified',
      domain: 'security',
      severity: block ? 'critical' : 'high',
      ...(block ? { blocking: true } : {}),
      title: 'Downloaded CI artifact reaches executable context without verification',
      message: `Job ${current.job} downloads ${current.artifactName || 'an artifact'} to ${current.downloadPath || '.'} and later executes it or adds its content to executable search paths without visible digest/attestation verification.`,
      location: where,
      remediation: 'Verify artifact provenance and digest before any execution. Treat artifact files as untrusted data, keep executable promotion in a trusted job, and pin the expected producer/run identity.',
      tags: ['ci', 'artifact', 'supply-chain', 'execution', 'provenance'],
    });
  }

  if (current.crossRun && current.executionObserved && !current.verificationObserved) {
    findings.push({
      id: 'ci-artifact-cross-run-execution',
      domain: 'security',
      severity: 'critical',
      blocking: true,
      title: 'Cross-run artifact is executed without independent integrity verification',
      message: `Job ${current.job} consumes an artifact from another workflow run and executes downloaded content. Run selection alone is not content integrity evidence.`,
      location: where,
      remediation: 'Bind the producer repository/ref/commit, verify an independently trusted digest or GitHub attestation, and never execute pull-request-produced artifacts in a privileged follow-up workflow.',
      tags: ['ci', 'artifact', 'workflow-run', 'execution', 'provenance'],
    });
  }

  if (current.pathMutationObserved && !current.verificationObserved) {
    findings.push({
      id: 'ci-artifact-path-injection',
      domain: 'security',
      severity: current.crossRun || current.externalContribution ? 'critical' : 'high',
      ...(current.crossRun || current.externalContribution ? { blocking: true } : {}),
      title: 'Downloaded artifact directory is promoted into command search path',
      message: `Job ${current.job} adds downloaded artifact content to PATH/GITHUB_PATH before integrity verification. Subsequent ordinary commands can resolve attacker-supplied executables implicitly.`,
      location: where,
      remediation: 'Never add unverified artifact directories to PATH. Verify content first, invoke expected binaries by exact path, and keep executable directories repository-owned.',
      tags: ['ci', 'artifact', 'path', 'command-hijack', 'supply-chain'],
    });
  }

  if (current.extractionObserved && current.executionObserved && !current.verificationObserved) {
    findings.push({
      id: 'ci-artifact-extract-execute-chain',
      domain: 'security',
      severity: current.privileged ? 'critical' : 'high',
      ...(current.privileged ? { blocking: true } : {}),
      title: 'Artifact archive is extracted and executed without an integrity boundary',
      message: `Job ${current.job} extracts downloaded artifact content and later executes from the artifact path. Archive extraction expands the attacker-controlled filesystem surface before execution.`,
      location: where,
      remediation: 'Verify archive digest/attestation before extraction, extract into an isolated directory with path traversal protections, and execute only an allowlisted expected file.',
      tags: ['ci', 'artifact', 'archive', 'execution', 'supply-chain'],
    });
  }

  if (dangerousUse && current.verificationObserved && current.crossRun) {
    findings.push({
      id: 'ci-artifact-cross-run-verified-execution-review',
      domain: 'security',
      severity: 'medium',
      title: 'Verified cross-run artifact still crosses an executable trust boundary',
      message: `Job ${current.job} verifies then executes a cross-run artifact. Integrity evidence reduces tampering risk but producer authorization and semantic safety still require review.`,
      location: where,
      remediation: 'Also constrain producer repository/ref/workflow identity and ensure the verified artifact subject is the exact file later executed.',
      tags: ['ci', 'artifact', 'workflow-run', 'execution', 'review'],
    });
  }

  return findings;
}

export function auditArtifactExecutionBoundaries(inventory: RepositoryInventory): AuditSection<ArtifactExecutionBoundarySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const signals: ArtifactExecutionSignal[] = [];
  const findings: Finding[] = [];

  for (const file of files) {
    for (const block of workflowJobBlocks(file)) {
      const steps = workflowStepBlocks(block);
      for (const step of steps) {
        const record = downloadRecord(step);
        if (!record) continue;
        const current = signalFor(block, steps, record);
        signals.push(current);
        findings.push(...findingsFor(current, record));
      }
    }
  }

  const canonical = stableSortFindings(findings);
  return {
    domain: 'security',
    title: 'CI artifact execution and executable-promotion boundary audit',
    summary: {
      workflowFiles: files.length,
      artifactDownloads: signals.length,
      crossRunDownloads: signals.filter(item => item.crossRun).length,
      executedDownloads: signals.filter(item => item.executionObserved || item.pathMutationObserved).length,
      verifiedBeforeExecution: signals.filter(item => item.verificationObserved && (item.executionObserved || item.pathMutationObserved)).length,
      signals,
      findings: canonical,
    },
    findings: canonical,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
