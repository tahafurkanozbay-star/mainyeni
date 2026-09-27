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

interface Step { readonly text: string; readonly offset: number }
interface ActionIdentity { readonly ownerRepo: string; readonly ref: string }

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const STEP_START = /^\s*-\s+(?:name\s*:|uses\s*:|run\s*:)/i;
const USES = /^\s*(?:-\s+)?uses\s*:\s*([^\s#]+)(?:\s+#.*)?$/im;
const SHA40 = /^[0-9a-f]{40}$/i;
const EXPRESSION = /\$\{\{[\s\S]*?\}\}/;
const UNTRUSTED_NAME_SOURCE = /\$\{\{\s*(?:github\.event\.|github\.head_ref\b|inputs\.)/i;
const BROAD_PATH = /^(?:\.|\.\/|\*|\*\*|\.\/\*\*|\$\{\{\s*github\.workspace\s*\}\}\/?(?:\*\*)?)$/i;
// Dotenv variants such as .env.production and .env.local are sensitive files too.
// Keep the segment boundary after the optional suffix rather than immediately after `.env`.
const SECRETISH_PATH = /(?:^|[\/\\])(?:\.env(?:\.[^\/\\]+)?|\.git|id_(?:rsa|ed25519)|credentials?|secrets?)(?:[\/\\]|$)/i;
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
function indentation(text: string): number { return text.match(/^\s*/)?.[0].length ?? 0 }
function steps(file: SourceFile): Step[] {
  const lines = physicalLines(file.text); const result: Step[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!; if (!STEP_START.test(line.text)) continue;
    const indent = indentation(line.text); let end = index + 1;
    while (end < lines.length) {
      const candidate = lines[end]!;
      if (candidate.text.trim() && indentation(candidate.text) <= indent && /^\s*-\s+/.test(candidate.text)) break;
      end += 1;
    }
    result.push({ text: lines.slice(index, end).map(item => item.text).join('\n'), offset: line.offset }); index = end - 1;
  }
  return result;
}
function actionIdentity(step: Step): ActionIdentity | undefined {
  const value = step.text.match(USES)?.[1];
  if (!value || value.startsWith('./') || value.startsWith('docker://')) return undefined;
  const at = value.lastIndexOf('@');
  return { ownerRepo: at > 0 ? value.slice(0, at).toLowerCase() : value.toLowerCase(), ref: at > 0 ? value.slice(at + 1) : '' };
}
function isAction(step: Step, name: string): boolean { return actionIdentity(step)?.ownerRepo === name }
function field(step: Step, key: string): string | undefined {
  const matcher = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*:\\s*(.*?)\\s*$`, 'im');
  return step.text.match(matcher)?.[1]?.replace(/^['"]|['"]$/g, '').trim();
}
function finding(file: SourceFile, step: Step, data: Omit<Finding, 'location'>): Finding {
  return { ...data, location: { file: file.repositoryPath, line: createLineIndex(file.text).lineAt(step.offset) }, evidence: data.evidence ?? { excerpt: snippetAround(file.text, step.offset, 180) } };
}
function add(file: SourceFile, step: Step, id: string, domain: 'security' | 'release', severity: 'low' | 'medium' | 'high' | 'critical', title: string, message: string, remediation: string, blocking = false, tags: string[] = ['ci','artifact']): Finding {
  return finding(file, step, { id, domain, severity, title, message, remediation, blocking, tags });
}
function uploadFindings(file: SourceFile, step: Step): Finding[] {
  if (!isAction(step, 'actions/upload-artifact')) return [];
  const out: Finding[] = []; const identity = actionIdentity(step)!; const name = field(step,'name') ?? ''; const path = field(step,'path') ?? '';
  if (!SHA40.test(identity.ref)) out.push(add(file,step,'ci-artifact-upload-mutable-action','security','high','Artifact upload action is not immutable','Release evidence must not depend on mutable executable action code.','Pin actions/upload-artifact to a reviewed 40-character commit SHA.',true,['ci','artifact','supply-chain']));
  if (!name) out.push(add(file,step,'ci-artifact-name-implicit','release','medium','Artifact upload relies on an implicit name','Implicit artifact naming weakens deterministic evidence lookup and cross-lane provenance.','Set a stable explicit artifact name that identifies the producing lane.'));
  else if (UNTRUSTED_NAME_SOURCE.test(name)) out.push(add(file,step,'ci-artifact-name-untrusted','security','high','Artifact name is derived from untrusted event data','Attacker-controlled artifact names can confuse downstream evidence selection and provenance.','Use a literal lane-specific name or a trusted immutable commit identifier.',true));
  if (!path) out.push(add(file,step,'ci-artifact-path-missing','release','high','Artifact upload has no explicit path','Release evidence uploads must identify the exact files intended for publication.','Set path to a narrow generated evidence directory or explicit file list.',true));
  else if (BROAD_PATH.test(path)) out.push(add(file,step,'ci-artifact-path-broad','security','critical','Artifact upload captures the workspace broadly','Broad workspace uploads can exfiltrate credentials, repository metadata, caches, or unrelated build material.','Upload only the exact generated evidence or distributable paths.',true,['ci','artifact','exfiltration']));
  else if (SECRETISH_PATH.test(path)) out.push(add(file,step,'ci-artifact-path-sensitive','security','critical','Artifact path can include sensitive files','Credential-like and repository-control files must never be exported as workflow artifacts.','Remove sensitive paths and generate a dedicated sanitized evidence directory.',true,['ci','artifact','secret']));
  if (step.text.match(IF_NO_FILES)?.[1]?.toLowerCase() !== 'error') out.push(add(file,step,'ci-artifact-missing-not-fatal','release','high','Missing release artifact is not fail-closed','A green producer job can otherwise publish no evidence while downstream release logic assumes it exists.','Set if-no-files-found: error for release and QA evidence uploads.',true));
  const retention = Number(step.text.match(RETENTION_DAYS)?.[1] ?? 0);
  if (retention > 90) out.push(add(file,step,'ci-artifact-retention-excessive','security','low','Artifact retention is unusually long',`Artifact retention is ${retention} days, increasing exposure and storage lifetime.`,'Use the shortest retention period compatible with release audit requirements.'));
  if (INCLUDE_HIDDEN.test(step.text)) out.push(add(file,step,'ci-artifact-hidden-files','security','high','Artifact upload includes hidden files','Hidden workspace files commonly contain repository metadata, environment files, and tool credentials.','Keep include-hidden-files disabled and enumerate required evidence explicitly.',true));
  if (OVERWRITE.test(step.text)) out.push(add(file,step,'ci-artifact-overwrite','release','medium','Artifact upload allows replacement','Overwriting an artifact weakens immutable evidence semantics inside a workflow run.','Publish uniquely named immutable evidence and reject duplicate producers.'));
  return out;
}
function downloadFindings(file: SourceFile, step: Step): Finding[] {
  if (!isAction(step,'actions/download-artifact')) return [];
  const out: Finding[] = []; const identity = actionIdentity(step)!; const name = field(step,'name'); const pattern = field(step,'pattern');
  if (!SHA40.test(identity.ref)) out.push(add(file,step,'ci-artifact-download-mutable-action','security','high','Artifact download action is not immutable','Evidence consumption must not execute mutable action code.','Pin actions/download-artifact to a reviewed 40-character commit SHA.',true));
  if (!name && !pattern) out.push(add(file,step,'ci-artifact-download-unscoped','release','high','Artifact download is not scoped to expected evidence','Downloading every artifact permits unrelated producers to enter a release evidence directory.','Select a literal trusted artifact name or a narrowly controlled pattern.',true));
  if ((name && UNTRUSTED_NAME_SOURCE.test(name)) || (pattern && UNTRUSTED_NAME_SOURCE.test(pattern))) out.push(add(file,step,'ci-artifact-download-untrusted-selector','security','critical','Artifact selector is derived from untrusted data','Attacker-controlled selectors can redirect release consumers toward unintended artifacts.','Use a literal producer contract or trusted immutable commit-derived selector.',true));
  if (RUN_ID_REFERENCE.test(step.text)) {
    if (!REPOSITORY_REFERENCE.test(step.text)) out.push(add(file,step,'ci-artifact-cross-run-repository-implicit','security','high','Cross-run artifact download leaves repository identity implicit','Cross-run evidence retrieval should bind both the workflow run and repository identity.','Set repository explicitly and validate the selected run belongs to the expected trusted producer.',true));
    if (MERGE_COMMIT_REFERENCE.test(step.text) || PR_HEAD_REFERENCE.test(step.text)) out.push(add(file,step,'ci-artifact-cross-run-pr-ref','security','critical','Cross-run artifact lookup is coupled to pull-request-controlled provenance','Release evidence must bind to a verified workflow run identity, not a PR-controlled source revision alone.','Resolve a trusted completed producer run and verify repository, workflow, event, conclusion, and exact commit before download.',true));
  }
  return out;
}
function attestationFindings(file: SourceFile, step: Step): Finding[] {
  if (!isAction(step,'actions/attest-build-provenance')) return [];
  const out: Finding[] = []; const identity = actionIdentity(step)!;
  if (!SHA40.test(identity.ref)) out.push(add(file,step,'ci-attestation-mutable-action','security','critical','Build provenance attestation action is mutable','The component asserting provenance must itself be immutable and reviewable.','Pin actions/attest-build-provenance to a reviewed 40-character commit SHA.',true,['ci','attestation','supply-chain']));
  if (!PERMISSIONS_ATTESTATION.test(file.text) || !PERMISSIONS_ID_TOKEN.test(file.text)) out.push(add(file,step,'ci-attestation-permissions-incomplete','release','high','Provenance attestation permissions are incomplete','GitHub artifact attestations require explicit attestations: write and id-token: write authority.','Grant attestation permissions only to the trusted attestation job and keep other jobs read-only.',true,['ci','attestation','least-privilege']));
  if (!field(step,'subject-path') && !field(step,'subject-digest')) out.push(add(file,step,'ci-attestation-subject-missing','release','critical','Build provenance attestation has no explicit subject','An attestation must bind to the exact distributable bytes or digest being released.','Provide a narrow subject-path or verified subject-digest for the release artifact.',true,['ci','attestation','provenance']));
  return out;
}
function releasePublishFindings(file: SourceFile, step: Step): Finding[] {
  const identity = actionIdentity(step); const runPublishes = /^\s*(?:-\s+)?run\s*:[\s\S]*?\bgh\s+release\s+(?:create|upload)\b/im.test(step.text); const actionPublishes = identity?.ownerRepo === 'softprops/action-gh-release' || identity?.ownerRepo === 'ncipollo/release-action';
  if (!runPublishes && !actionPublishes) return [];
  const out: Finding[] = [];
  if (!RELEASE_WRITE.test(file.text)) out.push(add(file,step,'ci-release-publish-permission-implicit','security','high','Release publication lacks explicit contents write authority','Release publishing should have explicit narrowly reviewed token authority rather than depending on repository defaults.','Grant contents: write only to the trusted release publication job.',true,['ci','release','least-privilege']));
  if (!DIGEST_REFERENCE.test(file.text) && !/attest-build-provenance/i.test(file.text)) out.push(add(file,step,'ci-release-publish-without-provenance','release','high','Release publication has no visible digest or attestation boundary','Published binaries should be bound to verifiable integrity evidence before they become release assets.','Generate and verify cryptographic digests or provenance attestations for the exact published bytes.',true,['ci','release','artifact','provenance']));
  return out;
}
function signal(file: SourceFile): ArtifactProvenanceSignal {
  const s = steps(file); return { file:file.repositoryPath, uploads:s.filter(x=>isAction(x,'actions/upload-artifact')).length, downloads:s.filter(x=>isAction(x,'actions/download-artifact')).length, attestations:s.filter(x=>isAction(x,'actions/attest-build-provenance')).length, releasePublishes:s.filter(x=>/^\s*(?:-\s+)?run\s*:[\s\S]*?\bgh\s+release\s+(?:create|upload)\b/im.test(x.text)||['softprops/action-gh-release','ncipollo/release-action'].includes(actionIdentity(x)?.ownerRepo??'')).length, mutableArtifactNames:s.filter(x=>(isAction(x,'actions/upload-artifact')||isAction(x,'actions/download-artifact'))&&EXPRESSION.test(field(x,'name')??'')).length, broadArtifactPaths:s.filter(x=>isAction(x,'actions/upload-artifact')&&BROAD_PATH.test(field(x,'path')??'')).length, crossRunDownloads:s.filter(x=>isAction(x,'actions/download-artifact')&&RUN_ID_REFERENCE.test(x.text)).length };
}
export function auditArtifactProvenance(inventory: RepositoryInventory): AuditSection<ArtifactProvenanceSummary> {
  const start = performance.now(); const files = workflowFiles(inventory); const workflows = files.map(signal); const findings = stableSortFindings(files.flatMap(file=>steps(file).flatMap(step=>[...uploadFindings(file,step),...downloadFindings(file,step),...attestationFindings(file,step),...releasePublishFindings(file,step)])));
  return { domain:'release', title:'CI artifact provenance and publication boundary audit', summary:{ workflows, workflowFiles:workflows.length, uploads:workflows.reduce((n,x)=>n+x.uploads,0), downloads:workflows.reduce((n,x)=>n+x.downloads,0), attestations:workflows.reduce((n,x)=>n+x.attestations,0), releasePublishes:workflows.reduce((n,x)=>n+x.releasePublishes,0), findings }, findings, elapsedMs:Math.max(0,performance.now()-start) };
}
