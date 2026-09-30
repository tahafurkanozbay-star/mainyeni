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
  type WorkflowJobBlock,
} from './workflow-structure.mts';
import {
  firstWorkflowStepField,
  stepDisplayName,
  stepNestedBlockLines,
  stepRunText,
  stepUsesIdentity,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export type ReleaseIntegrityEvidenceKind = 'attestation' | 'gh-attestation-verify' | 'cosign-verify-blob';
export type ReleasePublicationKind = 'gh-release' | 'softprops-release' | 'ncipollo-release' | 'upload-release-asset';

export interface ReleaseIntegrityEvidence {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly stepIndex: number;
  readonly position: number;
  readonly kind: ReleaseIntegrityEvidenceKind;
  readonly rawSubject: string;
  readonly subject: string;
  readonly exact: boolean;
}

export interface ReleaseAssetSubjectSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly line: number;
  readonly kind: ReleasePublicationKind;
  readonly rawAsset: string;
  readonly asset: string;
  readonly dynamic: boolean;
  readonly broad: boolean;
  readonly privileged: boolean;
  readonly priorEvidenceCount: number;
  readonly exactPriorEvidence: boolean;
  readonly mismatchedPriorEvidence: boolean;
  readonly exactLaterEvidence: boolean;
}

export interface ReleaseAssetSubjectSummary {
  readonly workflowFiles: number;
  readonly publishedAssets: number;
  readonly exactPublishedAssets: number;
  readonly integrityEvidence: number;
  readonly exactSubjectBindings: number;
  readonly dynamicAssetSelectors: number;
  readonly broadAssetSelectors: number;
  readonly signals: readonly ReleaseAssetSubjectSignal[];
  readonly findings: readonly Finding[];
}

interface PublicationRecord {
  readonly step: WorkflowStepBlock;
  readonly position: number;
  readonly kind: ReleasePublicationKind;
  readonly rawAsset: string;
}

const EXPRESSION = /\$\{\{[\s\S]*?\}\}/;
const GLOB = /[*?\[\]{}]/;
const ATTEST_ACTION = /^actions\/attest-build-provenance@[0-9a-f]{40}$/i;
const SOFTPROPS_RELEASE = /^softprops\/action-gh-release@/i;
const NICIPOLLO_RELEASE = /^ncipollo\/release-action@/i;
const UPLOAD_RELEASE_ASSET = /^actions\/upload-release-asset@/i;
const GH_RELEASE = /\bgh\s+release\s+(?:upload|create)\s+([^\n]+)/gi;
const GH_ATTEST_VERIFY = /\bgh\s+attestation\s+verify\s+([^\n]+)/gi;
const COSIGN_VERIFY_BLOB = /\bcosign\s+verify-blob\b([^\n]*)/gi;
const WORKSPACE_EXPRESSION = /^\$\{\{\s*github\.workspace\s*\}\}[\/\\]?/i;
const WORKSPACE_ENV = /^(?:\$GITHUB_WORKSPACE|\$\{GITHUB_WORKSPACE\}|%GITHUB_WORKSPACE%)[\/\\]?/i;

function privileged(block: WorkflowJobBlock): boolean {
  return jobHasWriteAuthority(block) || jobHasSecrets(block) || jobUsesProtectedEnvironment(block);
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeSubject(value: string): string {
  let current = stripQuotes(value).trim();
  current = current.replace(WORKSPACE_EXPRESSION, '').replace(WORKSPACE_ENV, '');
  current = current.replace(/\\/g, '/');
  while (current.startsWith('./')) current = current.slice(2);
  current = current.replace(/\/{2,}/g, '/');
  return current.replace(/\/$/, '');
}

function shellTokens(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote ? undefined : character;
      continue;
    }
    if (/\s/.test(character) && !quote) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (escaped) current += '\\';
  if (current) tokens.push(current);
  return tokens;
}

function fieldValues(step: WorkflowStepBlock, key: string): string[] {
  const field = firstWorkflowStepField(step, key);
  if (!field) return [];
  const scalar = field.value.trim();
  if (/^[>|][+-]?$/.test(scalar)) {
    return stepNestedBlockLines(step, key)
      .map(line => line.trimmed)
      .filter(line => line && !line.startsWith('#'))
      .flatMap(line => line.split(/\s*,\s*/))
      .map(stripQuotes)
      .filter(Boolean);
  }
  return scalar
    .split(/\r?\n|\s*,\s*/)
    .map(stripQuotes)
    .filter(Boolean);
}

function preFlagAssets(commandTail: string): string[] {
  const tokens = shellTokens(commandTail);
  if (tokens.length === 0) return [];
  const afterTag = tokens.slice(1);
  const assets: string[] = [];
  for (const token of afterTag) {
    if (token.startsWith('-')) break;
    const withoutLabel = token.replace(/#(?:[^#]*)$/, '');
    if (withoutLabel) assets.push(withoutLabel);
  }
  return assets;
}

function runPublications(step: WorkflowStepBlock): PublicationRecord[] {
  const run = stepRunText(step);
  if (!run) return [];
  const records: PublicationRecord[] = [];
  const matcher = new RegExp(GH_RELEASE.source, GH_RELEASE.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(run)) !== null) {
    const tail = match[1] ?? '';
    for (const asset of preFlagAssets(tail)) {
      records.push({ step, position: match.index, kind: 'gh-release', rawAsset: asset });
    }
  }
  return records;
}

function actionPublications(step: WorkflowStepBlock): PublicationRecord[] {
  const identity = stepUsesIdentity(step)?.raw ?? '';
  if (SOFTPROPS_RELEASE.test(identity)) {
    return fieldValues(step, 'files').map(rawAsset => ({ step, position: 0, kind: 'softprops-release' as const, rawAsset }));
  }
  if (NICIPOLLO_RELEASE.test(identity)) {
    return fieldValues(step, 'artifacts').map(rawAsset => ({ step, position: 0, kind: 'ncipollo-release' as const, rawAsset }));
  }
  if (UPLOAD_RELEASE_ASSET.test(identity)) {
    return fieldValues(step, 'asset_path').map(rawAsset => ({ step, position: 0, kind: 'upload-release-asset' as const, rawAsset }));
  }
  return [];
}

function attestationEvidence(block: WorkflowJobBlock, step: WorkflowStepBlock): ReleaseIntegrityEvidence[] {
  const identity = stepUsesIdentity(step)?.raw ?? '';
  if (!ATTEST_ACTION.test(identity)) return [];
  return fieldValues(step, 'subject-path').map(rawSubject => ({
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    stepIndex: step.index,
    position: 0,
    kind: 'attestation' as const,
    rawSubject,
    subject: normalizeSubject(rawSubject),
    exact: !EXPRESSION.test(rawSubject) && !GLOB.test(rawSubject),
  }));
}

function commandSubject(commandTail: string): string {
  const tokens = shellTokens(commandTail);
  for (const token of tokens) {
    if (token.startsWith('-')) break;
    if (token) return token;
  }
  return '';
}

function lastNonFlagToken(commandTail: string): string {
  const tokens = shellTokens(commandTail);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index] ?? '';
    if (token && !token.startsWith('-')) return token;
  }
  return '';
}

function runEvidence(block: WorkflowJobBlock, step: WorkflowStepBlock): ReleaseIntegrityEvidence[] {
  const run = stepRunText(step);
  if (!run) return [];
  const evidence: ReleaseIntegrityEvidence[] = [];

  const ghMatcher = new RegExp(GH_ATTEST_VERIFY.source, GH_ATTEST_VERIFY.flags);
  let match: RegExpExecArray | null;
  while ((match = ghMatcher.exec(run)) !== null) {
    const rawSubject = commandSubject(match[1] ?? '');
    if (!rawSubject) continue;
    evidence.push({
      file: block.file.repositoryPath,
      job: block.name,
      step: stepDisplayName(step),
      stepIndex: step.index,
      position: match.index,
      kind: 'gh-attestation-verify',
      rawSubject,
      subject: normalizeSubject(rawSubject),
      exact: !EXPRESSION.test(rawSubject) && !GLOB.test(rawSubject),
    });
  }

  const cosignMatcher = new RegExp(COSIGN_VERIFY_BLOB.source, COSIGN_VERIFY_BLOB.flags);
  while ((match = cosignMatcher.exec(run)) !== null) {
    const rawSubject = lastNonFlagToken(match[1] ?? '');
    if (!rawSubject) continue;
    evidence.push({
      file: block.file.repositoryPath,
      job: block.name,
      step: stepDisplayName(step),
      stepIndex: step.index,
      position: match.index,
      kind: 'cosign-verify-blob',
      rawSubject,
      subject: normalizeSubject(rawSubject),
      exact: !EXPRESSION.test(rawSubject) && !GLOB.test(rawSubject),
    });
  }

  return evidence;
}

function before(evidence: ReleaseIntegrityEvidence, publication: PublicationRecord): boolean {
  return evidence.stepIndex < publication.step.index
    || (evidence.stepIndex === publication.step.index && evidence.position < publication.position);
}

function after(evidence: ReleaseIntegrityEvidence, publication: PublicationRecord): boolean {
  return evidence.stepIndex > publication.step.index
    || (evidence.stepIndex === publication.step.index && evidence.position > publication.position);
}

function signalFor(
  block: WorkflowJobBlock,
  publication: PublicationRecord,
  evidence: readonly ReleaseIntegrityEvidence[],
): ReleaseAssetSubjectSignal {
  const asset = normalizeSubject(publication.rawAsset);
  const dynamic = EXPRESSION.test(publication.rawAsset);
  const broad = GLOB.test(publication.rawAsset) || asset === '.' || asset === '';
  const prior = evidence.filter(item => before(item, publication));
  const exactPriorEvidence = prior.some(item => item.exact && item.subject === asset);
  const exactLaterEvidence = evidence.some(item => after(item, publication) && item.exact && item.subject === asset);
  const mismatchedPriorEvidence = prior.some(item => item.exact && item.subject !== asset);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(publication.step),
    line: firstWorkflowStepField(publication.step, 'uses')?.line
      ?? firstWorkflowStepField(publication.step, 'run')?.line
      ?? publication.step.startLine,
    kind: publication.kind,
    rawAsset: publication.rawAsset,
    asset,
    dynamic,
    broad,
    privileged: privileged(block),
    priorEvidenceCount: prior.length,
    exactPriorEvidence,
    mismatchedPriorEvidence,
    exactLaterEvidence,
  };
}

function finding(
  signal: ReleaseAssetSubjectSignal,
  id: string,
  title: string,
  message: string,
  remediation: string,
  severity: Finding['severity'] = 'critical',
  blocking = true,
): Finding {
  return {
    id,
    domain: 'release',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: signal.file, line: signal.line },
    evidence: {
      value: signal.rawAsset,
      metadata: {
        job: signal.job,
        step: signal.step,
        kind: signal.kind,
        priorEvidenceCount: signal.priorEvidenceCount,
      },
    },
    remediation,
    tags: ['ci', 'release', 'artifact', 'subject', 'provenance', 'ordering'],
  };
}

function findingsFor(signal: ReleaseAssetSubjectSignal): Finding[] {
  const findings: Finding[] = [];

  if (signal.dynamic) {
    findings.push(finding(
      signal,
      'ci-release-asset-subject-dynamic',
      'Release asset selector is dynamic and cannot be bound to a reviewed integrity subject',
      `Release step ${signal.step} publishes an expression-derived asset selector. A mutable selector can redirect publication away from the bytes whose provenance was reviewed.`,
      'Resolve release assets to a small literal file list in trusted workflow code and verify/attest each exact file before publication.',
    ));
    return findings;
  }

  if (signal.broad) {
    findings.push(finding(
      signal,
      'ci-release-asset-subject-broad',
      'Release publication uses a broad or wildcard asset selector',
      `Release step ${signal.step} publishes ${signal.rawAsset}, which can expand to bytes not individually bound to integrity evidence.`,
      'Publish an explicit allowlist of exact release files and bind each one to prior attestation or independent verification.',
    ));
    return findings;
  }

  if (signal.exactPriorEvidence) return findings;

  if (signal.exactLaterEvidence) {
    findings.push(finding(
      signal,
      'ci-release-asset-verification-too-late',
      'Release asset integrity evidence is produced only after publication',
      `Asset ${signal.asset} is published before its exact attestation or verification step. Later evidence cannot retroactively authorize already released bytes.`,
      'Move exact subject verification or attestation before the release upload/create action and fail closed on any integrity failure.',
    ));
    return findings;
  }

  if (signal.mismatchedPriorEvidence) {
    findings.push(finding(
      signal,
      'ci-release-asset-subject-mismatch',
      'Release asset does not match the subject covered by prior integrity evidence',
      `Release step ${signal.step} publishes ${signal.asset}, but prior exact integrity evidence in the job refers to different subject paths.`,
      'Verify or attest the exact file path that will be published. Do not treat evidence for neighboring files or manifests as proof for another asset.',
    ));
    return findings;
  }

  findings.push(finding(
    signal,
    'ci-release-asset-subject-unverified',
    'Release asset lacks exact prior integrity subject binding',
    `Release step ${signal.step} publishes ${signal.asset} without an exact prior attestation or independent verification for that subject path.`,
    'Attest or independently verify the exact release file before publication, then publish the same immutable path.',
    signal.privileged ? 'critical' : 'high',
    true,
  ));
  return findings;
}

export function auditReleaseAssetSubjects(
  inventory: RepositoryInventory,
): AuditSection<ReleaseAssetSubjectSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const signals: ReleaseAssetSubjectSignal[] = [];
  const allEvidence: ReleaseIntegrityEvidence[] = [];

  for (const file of files) {
    for (const block of workflowJobBlocks(file)) {
      const steps = workflowStepBlocks(block);
      const evidence = steps.flatMap(step => [
        ...attestationEvidence(block, step),
        ...runEvidence(block, step),
      ]);
      allEvidence.push(...evidence);
      const publications = steps.flatMap(step => [
        ...runPublications(step),
        ...actionPublications(step),
      ]);
      signals.push(...publications.map(publication => signalFor(block, publication, evidence)));
    }
  }

  const findings = stableSortFindings(signals.flatMap(findingsFor));
  return {
    domain: 'release',
    title: 'Release asset exact-subject provenance audit',
    summary: {
      workflowFiles: files.length,
      publishedAssets: signals.length,
      exactPublishedAssets: signals.filter(item => !item.dynamic && !item.broad).length,
      integrityEvidence: allEvidence.length,
      exactSubjectBindings: signals.filter(item => item.exactPriorEvidence).length,
      dynamicAssetSelectors: signals.filter(item => item.dynamic).length,
      broadAssetSelectors: signals.filter(item => item.broad).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
