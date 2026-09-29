import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  jobHasSecrets,
  jobHasWriteAuthority,
  workflowFiles,
  workflowJobBlocks,
  workflowTriggerProfile,
  type WorkflowJobBlock,
} from './workflow-structure.mts';
import {
  stepDisplayName,
  stepRunText,
  stepUsesIdentity,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export interface ArchiveExtractionSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly extractionCommands: number;
  readonly remoteDownload: boolean;
  readonly artifactDownloadEarlier: boolean;
  readonly verification: boolean;
  readonly rootDestination: boolean;
  readonly overwrite: boolean;
  readonly externalContribution: boolean;
  readonly privileged: boolean;
}

export interface ArchiveExtractionBoundarySummary {
  readonly workflowFiles: number;
  readonly extractionSteps: number;
  readonly remoteExtractionSteps: number;
  readonly artifactExtractionSteps: number;
  readonly unverifiedExtractionSteps: number;
  readonly rootDestinationSteps: number;
  readonly signals: readonly ArchiveExtractionSignal[];
  readonly findings: readonly Finding[];
}

const EXTRACT = /(?:^|[;&|]\s*)(?:tar\s+[^\n]*(?:-[A-Za-z]*x[A-Za-z]*|--extract)\b|unzip\b|7z\s+x\b|bsdtar\s+[^\n]*(?:-[A-Za-z]*x[A-Za-z]*|--extract)\b|Expand-Archive\b)/im;
const REMOTE_DOWNLOAD = /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer)\b/i;
const VERIFY = /\b(?:sha256sum\s+-c|shasum\s+-a\s+256\s+-c|cosign\s+verify(?:-blob)?|gh\s+attestation\s+verify|Get-FileHash\b)/i;
const ROOT_DESTINATION = /(?:\s-C\s+['"]?\/['"]?(?:\s|$)|\s-d\s+['"]?\/['"]?(?:\s|$)|-DestinationPath\s+['"]?(?:\/|[A-Za-z]:\\)['"]?(?:\s|$)|\b(?:usr\/local|etc|opt|Program Files|Windows\\System32)\b)/i;
const OVERWRITE = /(?:\bunzip\s+-[^\n]*o\b|\btar\b[^\n]*--overwrite\b|\b7z\s+x\b[^\n]*-aoa\b|\bExpand-Archive\b[^\n]*-Force\b)/i;
const DANGEROUS_TAR = /\btar\b[^\n]*(?:--absolute-names|-[A-Za-z]*P[A-Za-z]*\b|--overwrite-dir\b)/i;
const PRIVILEGED_DESTINATION = /(?:\/usr\/|\/etc\/|\/opt\/|\/var\/|[A-Za-z]:\\(?:Program Files|Windows))/i;

function privileged(block: WorkflowJobBlock): boolean {
  return jobHasWriteAuthority(block) || jobHasSecrets(block);
}

function artifactDownloadedBefore(block: WorkflowJobBlock, step: WorkflowStepBlock): boolean {
  for (const candidate of workflowStepBlocks(block)) {
    if (candidate.index >= step.index) break;
    const identity = stepUsesIdentity(candidate);
    if (identity?.owner?.toLowerCase() === 'actions' && identity.repository?.toLowerCase() === 'download-artifact') return true;
  }
  return false;
}

function signal(block: WorkflowJobBlock, step: WorkflowStepBlock): ArchiveExtractionSignal | undefined {
  const run = stepRunText(step);
  if (!EXTRACT.test(run)) return undefined;
  const trigger = workflowTriggerProfile(block.file);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    extractionCommands: run.split('\n').filter(line => EXTRACT.test(line)).length,
    remoteDownload: REMOTE_DOWNLOAD.test(run),
    artifactDownloadEarlier: artifactDownloadedBefore(block, step),
    verification: VERIFY.test(run) || block.text.slice(0, block.text.indexOf(step.text)).split('\n').slice(-30).some(line => VERIFY.test(line)),
    rootDestination: ROOT_DESTINATION.test(run),
    overwrite: OVERWRITE.test(run),
    externalContribution: trigger.externalContribution,
    privileged: privileged(block),
  };
}

function finding(step: WorkflowStepBlock, id: string, severity: Finding['severity'], title: string, message: string, remediation: string, blocking = false): Finding {
  return {
    id,
    domain: 'security',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: step.job.file.repositoryPath, line: step.startLine },
    evidence: { excerpt: stepRunText(step).slice(0, 420), metadata: { job: step.job.name, step: stepDisplayName(step) } },
    remediation,
    tags: ['ci', 'archive', 'filesystem', 'artifact', 'supply-chain'],
  };
}

function auditStep(block: WorkflowJobBlock, step: WorkflowStepBlock): Finding[] {
  const current = signal(block, step);
  if (!current) return [];
  const run = stepRunText(step);
  const findings: Finding[] = [];

  if (current.rootDestination || DANGEROUS_TAR.test(run) || PRIVILEGED_DESTINATION.test(run)) {
    findings.push(finding(
      step,
      'ci-archive-privileged-destination',
      'critical',
      'Archive extraction can write outside the bounded workspace',
      `Step ${current.step} extracts archive content into a filesystem root/system path or enables absolute-name behavior. Archive entries can overwrite runner tooling, configuration, or executable search locations.`,
      'Extract into a newly created workspace-local staging directory with no elevated privileges. Validate the staged file list before any copy/promotion into system locations.',
      true,
    ));
  }

  if ((current.remoteDownload || current.artifactDownloadEarlier) && !current.verification) {
    const critical = current.privileged || current.externalContribution;
    findings.push(finding(
      step,
      'ci-archive-unverified-extraction',
      critical ? 'critical' : 'high',
      'Downloaded artifact is extracted without an integrity boundary',
      `Step ${current.step} extracts bytes obtained from a network/artifact boundary without a visible preceding digest/signature/attestation verification. Extraction expands attacker-controlled filenames, links, permissions, and file contents into the runner filesystem.`,
      'Verify the exact archive digest/provenance before extraction. Extract into a dedicated empty staging directory and validate expected paths/types before use.',
      critical,
    ));
  }

  if (current.overwrite && (current.remoteDownload || current.artifactDownloadEarlier || current.externalContribution)) {
    findings.push(finding(
      step,
      'ci-archive-overwrite-trust-boundary',
      current.privileged ? 'critical' : 'high',
      'Untrusted archive extraction explicitly overwrites existing files',
      `Step ${current.step} enables overwrite semantics while consuming externally sourced archive content. Existing repository/build files can be replaced without a clean staging boundary.`,
      'Remove overwrite flags. Extract into an empty unique staging directory and fail on path collisions before controlled promotion.',
      current.privileged,
    ));
  }

  return findings;
}

export function auditArchiveExtractionBoundaries(inventory: RepositoryInventory): AuditSection<ArchiveExtractionBoundarySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const jobs = files.flatMap(file => workflowJobBlocks(file));
  const pairs = jobs.flatMap(job => workflowStepBlocks(job).map(step => ({ job, step })));
  const signals = pairs.map(({ job, step }) => signal(job, step)).filter((item): item is ArchiveExtractionSignal => item !== undefined);
  const findings = stableSortFindings(pairs.flatMap(({ job, step }) => auditStep(job, step)));
  return {
    domain: 'security',
    title: 'Archive extraction filesystem boundary audit',
    summary: {
      workflowFiles: files.length,
      extractionSteps: signals.length,
      remoteExtractionSteps: signals.filter(item => item.remoteDownload).length,
      artifactExtractionSteps: signals.filter(item => item.artifactDownloadEarlier).length,
      unverifiedExtractionSteps: signals.filter(item => (item.remoteDownload || item.artifactDownloadEarlier) && !item.verification).length,
      rootDestinationSteps: signals.filter(item => item.rootDestination).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
