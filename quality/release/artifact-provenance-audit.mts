import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { createLineIndex, snippetAround } from './inventory.mts';

export interface ArtifactProvenanceSignal {
  readonly file: string;
  readonly uploads: number;
  readonly downloads: number;
  readonly attestations: number;
  readonly releasePublishes: number;
  readonly mutableArtifactNames: number;
  readonly broadArtifactPaths: number;
  readonly crossRunDownloads: number;
}

export interface ArtifactProvenanceSummary {
  readonly workflows: readonly ArtifactProvenanceSignal[];
  readonly workflowFiles: number;
  readonly uploads: number;
  readonly downloads: number;
  readonly attestations: number;
  readonly releasePublishes: number;
  readonly findings: readonly Finding[];
}

interface Step {
  readonly text: string;
  readonly offset: number;
}

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const STEP_START = /^\s*-\s+(?:name\s*:|uses\s*:|run\s*:)/i;
const USES = /^\s*(?:-\s+)?uses\s*:\s*([^\s#]+)(?:\s+#.*)?$/im;
const SHA40 = /^[0-9a-f]{40}$/i;
const EXPRESSION = /\$\{\{[\s\S]*?\}\}/;
const UNTRUSTED_NAME_SOURCE = /\$\{\{\s*(?:github\.event\.|github\.head_ref\b|inputs\.)/i;
const BROAD_PATH = /^(?:\.|\.\/|\*|\*\*|\.\/\*\*|\$\{\{\s*github\.workspace\s*\}\}\/?(?:\*\*)?)$/i;
const SECRETISH_PATH = /(?:^|[\/\\])(?:\.env(?:\.|$)|\.git(?:[\/\\]|$)|id_(?:rsa|ed25519)|credentials?|secrets?)(?:[\/\\]|$)/i;
const EXECUTABLE_PATH = /(?:^|[\/\\])(?:node_modules|bin|obj|dist|build|publish|out)(?:[\/\\]|$)/i;
const DIGEST_REFERENCE = /(?:sha256|digest|checksum|hash-files|artifact-digest)/i;
const RUN_ID_REFERENCE = /\brun-id\s*:/i;
const REPOSITORY_REFERENCE = /\brepository\s*:/i;
const MERGE_COMMIT_REFERENCE = /github\.event\.pull_request\.merge_commit_sha/i;
const PR_HEAD_REFERENCE = /github\.event\.pull_request\.head\.sha/i;
const RETENTION_DAYS = /\bretention-days\s*:\s*(\d+)/i;
const IF_NO_FILES = /\bif-no-files-found\s*:\s*([A-Za-z]+)/i;
const OVERWRITE = /\boverwrite\s*:\s*true\b/i;
const INCLUDE_HIDDEN = /\binclude-hidden-files\s*:\s*true\b/i;
const PERMISSIONS_ATTESTATION = /^\s*attestations\s*:\s*write\s*$/im;
const PERMISSIONS_ID_TOKEN = /^\s*id-token\s*:\s*write\s*$/im;
const RELEASE_WRITE = /^\s*contents\s*:\s*write\s*$/im;

function workflowFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => WORKFLOW_PATH.test(file.repositoryPath));
}

function physicalLines(text: string): Array<{ text: string; offset: number }> {
  const result: Array<{ text: string; offset: number }> = [];
  let offset = 0;
  for (const raw of text.split('\n')) {
    result.push({ text: raw.endsWith('\r') ? raw.slice(0, -1) : raw, offset });
    offset += raw.length + 1;
  }
  return result;
}

function indentation(text: string): number {
  return text.match(/^\s*/)?.[0].length ?? 0;
}

function steps(file: SourceFile): Step[] {
  const lines = physicalLines(file.text);
  const result: Step[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!STEP_START.test(line.text)) continue;
    const indent = indentation(line.text);
    let end = index + 1;
    while (end < lines.length) {
      const candidate = lines[end]!;
      if (candidate.text.trim() && indentation(candidate.text) <= indent && /^\s*-\s+/.test(candidate.text)) break;
      end += 1;
    }
    result.push({
      text: lines.slice(index, end).map(item => item.text).join('\n'),
      offset: line.offset,
    });
    index = end - 1;
  }
  return result;
}

interface ActionIdentity {
  readonly ownerRepo: string;
  readonly ref: string;
}

function actionIdentity(step: Step): ActionIdentity | undefined {
  const match = step.text.match(USES);
  const value = match?.[1];
  if (!value || value.startsWith('./') || value.startsWith('docker://')) return undefined;
  const at = value.lastIndexOf('@');
  return { ownerRepo: at > 0 ? value.slice(0, at).toLowerCase() : value.toLowerCase(), ref: at > 0 ? value.slice(at + 1) : '' };
}

function isAction(step: Step, name: string): boolean {
  return actionIdentity(step)?.ownerRepo === name;
}

function field(step: Step, key: string): string | undefined {
  const matcher = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*:\\s*(.*?)\\s*$`, 'im');
  return step.text.match(matcher)?.[1]?.replace(/^['"]|['"]$/g, '').trim();
}

function finding(file: SourceFile, step: Step, data: Omit<Finding, 'location'>): Finding {
  const lineIndex = createLineIndex(file.text);
  return {
    ...data,
    location: { file: file.repositoryPath, line: lineIndex.lineAt(step.offset) },
    evidence: data.evidence ?? { excerpt: snippetAround(file.text, step.offset, 180) },
  };
}

function uploadFindings(file: SourceFile, step: Step): Finding[] {
  if (!isAction(step, 'actions/upload-artifact')) return [];
  const findings: Finding[] = [];
  const name = field(step, 'name') ?? '';
  const path = field(step, 'path') ?? '';
  const identity = actionIdentity(step)!;
  if (!SHA40.test(identity.ref)) {
    findings.push(finding(file, step, {
      id: 'ci-artifact-upload-mutable-action', domain: 'security', severity: 'high', blocking: true,
      title: 'Artifact upload action is not immutable',
      message: 'Release evidence must not depend on mutable executable action code.',
      remediation: 'Pin actions/upload-artifact to a reviewed 40-character commit SHA.',
      tags: ['ci', 'artifact', 'supply-chain'],
    }));
  }
  if (!name) {
    findings.push(finding(file, step, {
      id: 'ci-artifact-name-implicit', domain: 'release', severity: 'medium',
      title: 'Artifact upload relies on an implicit name',
      message: 'Implicit artifact naming weakens deterministic evidence lookup and cross-lane provenance.',
      remediation: 'Set a stable explicit artifact name that identifies the producing lane.',
      tags: ['ci', 'artifact', 'provenance'],
    }));
  } else if (UNTRUSTED_NAME_SOURCE.test(name)) {
    findings.push(finding(file, step, {
      id: 'ci-artifact-name-untrusted', domain: 'security', severity: 'high', blocking: true,
      title: 'Artifact name is derived from untrusted event data',
      message: 'Attacker-controlled artifact names can confuse downstream evidence selection and provenance.',
      remediation: 'Use a literal lane-specific name or a trusted immutable commit identifier.',
      tags: ['ci', 'artifact', 'provenance'],
    }));
  }
  if (!path) {
    findings.push(finding(file, step, {
      id: 'ci-artifact-path-missing', domain: 'release', severity: 'high', blocking: true,
      title: 'Artifact upload has no explicit path',
      message: 'Release evidence uploads must identify the exact files intended for publication.',
      remediation: 'Set path to a narrow generated evidence directory or explicit file list.',
      tags: ['ci', 'artifact', 'scope'],
    }));
  } else if (BROAD_PATH.test(path)) {
    findings.push(finding(file, step, {
      id: 'ci-artifact-path-broad', domain: 'security', severity: 'critical', blocking: true,
      title: 'Artifact upload captures the workspace broadly',
      message: 'Broad workspace uploads can exfiltrate credentials, repository metadata, caches, or unrelated build material.',
      remediation: 'Upload only the exact generated evidence or distributable paths.',
      tags: ['ci', 'artifact', 'exfiltration'],
    }));
  } else if (SECRETISH_PATH.test(path)) {
    findings.push(finding(file, step, {
      id: 'ci-artifact-path-sensitive', domain: 'security', severity: 'critical', blocking: true,
      title: 'Artifact path can include sensitive files',
      message: 'Credential-like and repository-control files must never be exported as workflow artifacts.',
      remediation: 'Remove sensitive paths and generate a dedicated sanitized evidence directory.',
      tags: ['ci', 'artifact', 'secret'],
    }));
  }
  const missing = step.text.match(IF_NO_FILES)?.[1]?.toLowerCase();
  if (missing !== 'error') {
    findings.push(finding(file, step, {
      id: 'ci-artifact-missing-not-fatal', domain: 'release', severity: 'high', blocking: true,
      title: 'Missing release artifact is not fail-closed',
      message: 'A green producer job can otherwise publish no evidence while downstream release logic assumes it exists.',
      remediation: 'Set if-no-files-found: error for release and QA evidence uploads.',
      tags: ['ci', 'artifact', 'fail-closed'],
    }));
  }
  const retention = Number(step.text.match(RETENTION_DAYS)?.[1] ?? 0);
  if (retention > 90) {
    findings.push(finding(file, step, {
      id: 'ci-artifact-retention-excessive', domain: 'security', severity: 'low',
      title: 'Artifact retention is unusually long',
      message: `Artifact retention is ${retention} days, increasing exposure and storage lifetime.`,
      remediation: 'Use the shortest retention period compatible with release audit requirements.',
      tags: ['ci', 'artifact', 'retention'],
    }));
  }
  if (INCLUDE_HIDDEN.test(step.text)) {
    findings.push(finding(file, step, {
      id: 'ci-artifact-hidden-files', domain: 'security', severity: 'high', blocking: true,
      title: 'Artifact upload includes hidden files',
      message: 'Hidden workspace files commonly contain repository metadata, environment files, and tool credentials.',
      remediation: 'Keep include-hidden-files disabled and enumerate required evidence explicitly.',
      tags: ['ci', 'artifact', 'exfiltration'],
    }));
  }
  if (OVERWRITE.test(step.text)) {
    findings.push(finding(file, step, {
      id: 'ci-artifact-overwrite', domain: 'release', severity: 'medium',
      title: 'Artifact upload allows replacement',
      message: 'Overwriting an artifact weakens immutable evidence semantics inside a workflow run.',
      remediation: 'Publish uniquely named immutable evidence and reject duplicate producers.',
      tags: ['ci', 'artifact', 'provenance'],
    }));
  }
  return findings;
}

function downloadFindings(file: SourceFile, step: Step): Finding[] {
  if (!isAction(step, 'actions/download-artifact')) return [];
  const findings: Finding[] = [];
  const identity = actionIdentity(step)!;
  if (!SHA40.test(identity.ref)) {
    findings.push(finding(file, step, {
      id: 'ci-artifact-download-mutable-action', domain: 'security', severity: 'high', blocking: true,
      title: 'Artifact download action is not immutable',
      message: 'Evidence consumption must not execute mutable action code.',
      remediation: 'Pin actions/download-artifact to a reviewed 40-character commit SHA.',
      tags: ['ci', 'artifact', 'supply-chain'],
    }));
  }
  const name = field(step, 'name');
  const pattern = field(step, 'pattern');
  if (!name && !pattern) {
    findings.push(finding(file, step, {
      id: 'ci-artifact-download-unscoped', domain: 'release', severity: 'high', blocking: true,
      title: 'Artifact download is not scoped to expected evidence',
      message: 'Downloading every artifact permits unrelated producers to enter a release evidence directory.',
      remediation: 'Select a literal trusted artifact name or a narrowly controlled pattern.',
      tags: ['ci', 'artifact', 'provenance'],
    }));
  }
  if ((name && UNTRUSTED_NAME_SOURCE.test(name)) || (pattern && UNTRUSTED_NAME_SOURCE.test(pattern))) {
    findings.push(finding(file, step, {
      id: 'ci-artifact-download-untrusted-selector', domain: 'security', severity: 'critical', blocking: true,
      title: 'Artifact selector is derived from untrusted data',
      message: 'Attacker-controlled selectors can redirect release consumers toward unintended artifacts.',
      remediation: 'Use a literal producer contract or trusted immutable commit-derived selector.',
      tags: ['ci', 'artifact', 'provenance'],
    }));
  }
  if (RUN_ID_REFERENCE.test(step.text)) {
    if (!REPOSITORY_REFERENCE.test(step.text)) {
      findings.push(finding(file, step, {
        id: 'ci-artifact-cross-run-repository-implicit', domain: 'security', severity: 'high', blocking: true,
        title: 'Cross-run artifact download leaves repository identity implicit',
        message: 'Cross-run evidence retrieval should bind both the workflow run and repository identity.',
        remediation: 'Set repository explicitly and validate the selected run belongs to the expected trusted producer.',
        tags: ['ci', 'artifact', 'cross-run'],
      }));
    }
    if (MERGE_COMMIT_REFERENCE.test(step.text) || PR_HEAD_REFERENCE.test(step.text)) {
      findings.push(finding(file, step, {
        id: 'ci-artifact-cross-run-pr-ref', domain: 'security', severity: 'critical', blocking: true,
        title: 'Cross-run artifact lookup is coupled to pull-request-controlled provenance',
        message: 'Release evidence must bind to a verified workflow run identity, not a PR-controlled source revision alone.',
        remediation: 'Resolve a trusted completed producer run and verify repository, workflow, event, conclusion, and exact commit before download.',
        tags: ['ci', 'artifact', 'cross-run', 'provenance'],
      }));
    }
  }
  return findings;
}

function attestationFindings(file: SourceFile, step: Step): Finding[] {
  if (!isAction(step, 'actions/attest-build-provenance')) return [];
  const findings: Finding[] = [];
  const identity = actionIdentity(step)!;
  if (!SHA40.test(identity.ref)) {
    findings.push(finding(file, step, {
      id: 'ci-attestation-mutable-action', domain: 'security', severity: 'critical', blocking: true,
      title: 'Build provenance attestation action is mutable',
      message: 'The component asserting provenance must itself be immutable and reviewable.',
      remediation: 'Pin actions/attest-build-provenance to a reviewed 40-character commit SHA.',
      tags: ['ci', 'attestation', 'supply-chain'],
    }));
  }
  if (!PERMISSIONS_ATTESTATION.test(file.text) || !PERMISSIONS_ID_TOKEN.test(file.text)) {
    findings.push(finding(file, step, {
      id: 'ci-attestation-permissions-incomplete', domain: 'release', severity: 'high', blocking: true,
      title: 'Provenance attestation permissions are incomplete',
      message: 'GitHub artifact attestations require explicit attestations: write and id-token: write authority.',
      remediation: 'Grant attestation permissions only to the trusted attestation job and keep other jobs read-only.',
      tags: ['ci', 'attestation', 'least-privilege'],
    }));
  }
  const subjectPath = field(step, 'subject-path');
  const subjectDigest = field(step, 'subject-digest');
  if (!subjectPath && !subjectDigest) {
    findings.push(finding(file, step, {
      id: 'ci-attestation-subject-missing', domain: 'release', severity: 'critical', blocking: true,
      title: 'Build provenance attestation has no explicit subject',
      message: 'An attestation must bind to the exact distributable bytes or digest being released.',
      remediation: 'Provide a narrow subject-path or verified subject-digest for the release artifact.',
      tags: ['ci', 'attestation', 'provenance'],
    }));
  }
  return findings;
}

function releasePublishFindings(file: SourceFile, step: Step): Finding[] {
  const identity = actionIdentity(step);
  const runPublishes = /^\s*(?:-\s+)?run\s*:[\s\S]*?\bgh\s+release\s+(?:create|upload)\b/im.test(step.text);
  const actionPublishes = identity?.ownerRepo === 'softprops/action-gh-release' || identity?.ownerRepo === 'ncipollo/release-action';
  if (!runPublishes && !actionPublishes) return [];
  const findings: Finding[] = [];
  if (!RELEASE_WRITE.test(file.text)) {
    findings.push(finding(file, step, {
      id: 'ci-release-publish-permission-implicit', domain: 'security', severity: 'high', blocking: true,
      title: 'Release publication lacks explicit contents write authority',
      message: 'Release publishing should have explicit narrowly reviewed token authority rather than depending on repository defaults.',
      remediation: 'Grant contents: write only to the trusted release publication job.',
      tags: ['ci', 'release', 'least-privilege'],
    }));
  }
  if (!DIGEST_REFERENCE.test(file.text) && !/attest-build-provenance/i.test(file.text)) {
    findings.push(finding(file, step, {
      id: 'ci-release-publish-without-provenance', domain: 'release', severity: 'high', blocking: true,
      title: 'Release publication has no visible digest or attestation boundary',
      message: 'Published binaries should be bound to verifiable integrity evidence before they become release assets.',
      remediation: 'Generate and verify cryptographic digests or provenance attestations for the exact published bytes.',
      tags: ['ci', 'release', 'artifact', 'provenance'],
    }));
  }
  return findings;
}

function signal(file: SourceFile): ArtifactProvenanceSignal {
  const fileSteps = steps(file);
  const uploads = fileSteps.filter(step => isAction(step, 'actions/upload-artifact')).length;
  const downloads = fileSteps.filter(step => isAction(step, 'actions/download-artifact')).length;
  const attestations = fileSteps.filter(step => isAction(step, 'actions/attest-build-provenance')).length;
  const releasePublishes = fileSteps.filter(step => /^\s*(?:-\s+)?run\s*:[\s\S]*?\bgh\s+release\s+(?:create|upload)\b/im.test(step.text) || ['softprops/action-gh-release','ncipollo/release-action'].includes(actionIdentity(step)?.ownerRepo ?? '')).length;
  return {
    file: file.repositoryPath,
    uploads,
    downloads,
    attestations,
    releasePublishes,
    mutableArtifactNames: fileSteps.filter(step => (isAction(step, 'actions/upload-artifact') || isAction(step, 'actions/download-artifact')) && EXPRESSION.test(field(step, 'name') ?? '')).length,
    broadArtifactPaths: fileSteps.filter(step => isAction(step, 'actions/upload-artifact') && BROAD_PATH.test(field(step, 'path') ?? '')).length,
    crossRunDownloads: fileSteps.filter(step => isAction(step, 'actions/download-artifact') && RUN_ID_REFERENCE.test(step.text)).length,
  };
}

export function auditArtifactProvenance(inventory: RepositoryInventory): AuditSection<ArtifactProvenanceSummary> {
  const start = performance.now();
  const files = workflowFiles(inventory);
  const workflows = files.map(signal);
  const findings = stableSortFindings(files.flatMap(file => steps(file).flatMap(step => [
    ...uploadFindings(file, step),
    ...downloadFindings(file, step),
    ...attestationFindings(file, step),
    ...releasePublishFindings(file, step),
  ])));
  return {
    domain: 'release',
    title: 'CI artifact provenance and publication boundary audit',
    summary: {
      workflows,
      workflowFiles: workflows.length,
      uploads: workflows.reduce((sum, item) => sum + item.uploads, 0),
      downloads: workflows.reduce((sum, item) => sum + item.downloads, 0),
      attestations: workflows.reduce((sum, item) => sum + item.attestations, 0),
      releasePublishes: workflows.reduce((sum, item) => sum + item.releasePublishes, 0),
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - start),
  };
}
