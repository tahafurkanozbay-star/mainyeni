import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  workflowFiles,
  workflowJobBlocks,
  type WorkflowJobBlock,
} from './workflow-structure.mts';
import {
  firstWorkflowStepField,
  stepDisplayName,
  stepNestedBlockLines,
  stepNestedMapping,
  stepRunText,
  stepUsesIdentity,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export interface ReleaseAssetMutationSignal {
  readonly file: string;
  readonly job: string;
  readonly asset: string;
  readonly evidenceStep: string;
  readonly mutationStep: string;
  readonly publicationStep: string;
  readonly mutationCommand: string;
  readonly evidenceKind: string;
  readonly publicationKind: string;
  readonly line: number;
}

export interface ReleaseAssetMutationSummary {
  readonly workflowFiles: number;
  readonly integritySubjects: number;
  readonly publishedAssets: number;
  readonly mutationRecords: number;
  readonly staleIntegrityBindings: number;
  readonly signals: readonly ReleaseAssetMutationSignal[];
  readonly findings: readonly Finding[];
}

interface OrderedRecord {
  readonly step: WorkflowStepBlock;
  readonly position: number;
  readonly asset: string;
  readonly kind: string;
}

interface MutationRecord extends OrderedRecord {
  readonly command: string;
}

const ATTEST_ACTION = /^actions\/attest-build-provenance@[0-9a-f]{40}$/i;
const SOFTPROPS_RELEASE = /^softprops\/action-gh-release@/i;
const NICIPOLLO_RELEASE = /^ncipollo\/release-action@/i;
const UPLOAD_RELEASE_ASSET = /^actions\/upload-release-asset@/i;
const GH_ATTEST_VERIFY = /\bgh\s+attestation\s+verify\s+([^\n]+)/gi;
const COSIGN_VERIFY_BLOB = /\bcosign\s+verify-blob\b([^\n]*)/gi;
const GH_RELEASE = /\bgh\s+release\s+(?:upload|create)\s+([^\n]+)/gi;
const WORKSPACE_EXPRESSION = /^\$\{\{\s*github\.workspace\s*\}\}[\/\\]?/i;
const WORKSPACE_ENV = /^(?:\$GITHUB_WORKSPACE|\$\{GITHUB_WORKSPACE\}|%GITHUB_WORKSPACE%)[\/\\]?/i;
const EXPRESSION = /\$\{\{/;
const GLOB = /[*?\[\]{}]/;
const EXPRESSION_SPACE_SENTINEL = '\u0007';

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizePath(value: string): string {
  let current = stripQuotes(value).trim();
  current = current.replace(WORKSPACE_EXPRESSION, '').replace(WORKSPACE_ENV, '');
  current = current.replace(/\\/g, '/');
  while (current.startsWith('./')) current = current.slice(2);
  current = current.replace(/\/{2,}/g, '/');
  return current.replace(/\/$/, '');
}

function exactPath(value: string): boolean {
  const residual = stripQuotes(value)
    .replace(WORKSPACE_EXPRESSION, '')
    .replace(WORKSPACE_ENV, '');
  return Boolean(normalizePath(value)) && !EXPRESSION.test(residual) && !GLOB.test(residual);
}

function protectExpressionWhitespace(value: string): string {
  return value.replace(/\$\{\{[\s\S]*?\}\}/g, expression => expression.replace(/\s/g, EXPRESSION_SPACE_SENTINEL));
}

function shellTokens(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const character of protectExpressionWhitespace(value.trim())) {
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
      if (current) tokens.push(current.replaceAll(EXPRESSION_SPACE_SENTINEL, ' '));
      current = '';
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current.replaceAll(EXPRESSION_SPACE_SENTINEL, ' '));
  return tokens;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitValues(value: string): string[] {
  return value.split(/\r?\n|\s*,\s*/).map(stripQuotes).filter(Boolean);
}

function withValues(step: WorkflowStepBlock, key: string): string[] {
  const mapping = stepNestedMapping(step, 'with');
  const scalar = mapping.get(key)?.trim();
  if (scalar === undefined) return [];
  if (!/^[>|][+-]?$/.test(scalar)) return splitValues(scalar);
  const lines = stepNestedBlockLines(step, 'with');
  const matcher = new RegExp(`^\\s*${escapeRegex(key)}\\s*:\\s*(.*)$`, 'i');
  const field = lines.find(line => matcher.test(line.text));
  if (!field) return [];
  const values: string[] = [];
  for (const line of lines) {
    if (line.line <= field.line) continue;
    if (line.trimmed && line.indent <= field.indent) break;
    if (!line.trimmed || line.trimmed.startsWith('#')) continue;
    values.push(...splitValues(line.trimmed));
  }
  return values;
}

function firstCommandSubject(tail: string): string {
  for (const token of shellTokens(tail)) {
    if (token.startsWith('-')) break;
    if (token) return token;
  }
  return '';
}

function lastCommandSubject(tail: string): string {
  const tokens = shellTokens(tail);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index] ?? '';
    if (token && !token.startsWith('-')) return token;
  }
  return '';
}

function evidenceRecords(block: WorkflowJobBlock, step: WorkflowStepBlock): OrderedRecord[] {
  const records: OrderedRecord[] = [];
  const identity = stepUsesIdentity(step)?.raw ?? '';
  if (ATTEST_ACTION.test(identity)) {
    for (const raw of withValues(step, 'subject-path')) {
      if (exactPath(raw)) records.push({ step, position: 0, asset: normalizePath(raw), kind: 'attestation' });
    }
  }

  const run = stepRunText(step);
  if (!run) return records;
  const gh = new RegExp(GH_ATTEST_VERIFY.source, GH_ATTEST_VERIFY.flags);
  let match: RegExpExecArray | null;
  while ((match = gh.exec(run)) !== null) {
    const raw = firstCommandSubject(match[1] ?? '');
    if (exactPath(raw)) records.push({ step, position: match.index, asset: normalizePath(raw), kind: 'gh-attestation-verify' });
  }
  const cosign = new RegExp(COSIGN_VERIFY_BLOB.source, COSIGN_VERIFY_BLOB.flags);
  while ((match = cosign.exec(run)) !== null) {
    const raw = lastCommandSubject(match[1] ?? '');
    if (exactPath(raw)) records.push({ step, position: match.index, asset: normalizePath(raw), kind: 'cosign-verify-blob' });
  }
  return records;
}

function ghReleaseAssets(tail: string): string[] {
  const tokens = shellTokens(tail);
  if (tokens.length === 0) return [];
  const result: string[] = [];
  for (const token of tokens.slice(1)) {
    if (token.startsWith('-')) break;
    const asset = token.replace(/#(?:[^#]*)$/, '');
    if (exactPath(asset)) result.push(normalizePath(asset));
  }
  return result;
}

function publicationRecords(step: WorkflowStepBlock): OrderedRecord[] {
  const records: OrderedRecord[] = [];
  const run = stepRunText(step);
  if (run) {
    const matcher = new RegExp(GH_RELEASE.source, GH_RELEASE.flags);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(run)) !== null) {
      for (const asset of ghReleaseAssets(match[1] ?? '')) {
        records.push({ step, position: match.index, asset, kind: 'gh-release' });
      }
    }
  }

  const identity = stepUsesIdentity(step)?.raw ?? '';
  const pairs: readonly [RegExp, string, string][] = [
    [SOFTPROPS_RELEASE, 'files', 'softprops-release'],
    [NICIPOLLO_RELEASE, 'artifacts', 'ncipollo-release'],
    [UPLOAD_RELEASE_ASSET, 'asset_path', 'upload-release-asset'],
  ];
  for (const [pattern, key, kind] of pairs) {
    if (!pattern.test(identity)) continue;
    for (const raw of withValues(step, key)) {
      if (exactPath(raw)) records.push({ step, position: 0, asset: normalizePath(raw), kind });
    }
  }
  return records;
}

function mutationPatterns(asset: string): readonly RegExp[] {
  const escaped = escapeRegex(asset);
  const boundary = `(?:['"]?\\.?\\/?${escaped}['"]?)`;
  return [
    new RegExp(`(?:^|[;&|]\\s*)touch\\s+[^\\n]*${boundary}(?:\\s|$)`, 'i'),
    new RegExp(`(?:^|[;&|]\\s*)truncate\\s+[^\\n]*${boundary}(?:\\s|$)`, 'i'),
    new RegExp(`(?:^|[;&|]\\s*)rm\\s+[^\\n]*${boundary}(?:\\s|$)`, 'i'),
    new RegExp(`(?:^|[;&|]\\s*)cp\\s+[^\\n]*\\s${boundary}(?:\\s|$)`, 'i'),
    new RegExp(`(?:^|[;&|]\\s*)mv\\s+[^\\n]*\\s${boundary}(?:\\s|$)`, 'i'),
    new RegExp(`(?:^|[;&|]\\s*)zip\\s+[^\\n]*${boundary}(?:\\s|$)`, 'i'),
    new RegExp(`(?:^|[;&|]\\s*)7z\\s+a\\s+[^\\n]*${boundary}(?:\\s|$)`, 'i'),
    new RegExp(`(?:^|[;&|]\\s*)tar\\s+[^\\n]*(?:(?:-[A-Za-z0-9]*f[A-Za-z0-9]*\\s+)|(?:--file(?:=|\\s+)))${boundary}(?:\\s|$)`, 'i'),
    new RegExp(`(?:^|[;&|]\\s*)(?:sed\\s+-i|perl\\s+-pi)\\b[^\\n]*${boundary}(?:\\s|$)`, 'i'),
    new RegExp(`(?:>|>>)\\s*${boundary}(?:\\s|$)`, 'i'),
  ];
}

function mutationRecords(step: WorkflowStepBlock, assets: readonly string[]): MutationRecord[] {
  const run = stepRunText(step);
  if (!run) return [];
  const records: MutationRecord[] = [];
  const lines = run.split('\n');
  let offset = 0;
  for (const line of lines) {
    for (const asset of assets) {
      for (const pattern of mutationPatterns(asset)) {
        const match = line.match(pattern);
        if (!match) continue;
        records.push({
          step,
          position: offset + (match.index ?? 0),
          asset,
          kind: 'content-mutation',
          command: line.trim(),
        });
        break;
      }
    }
    offset += line.length + 1;
  }
  return records;
}

function point(record: OrderedRecord): readonly [number, number] {
  return [record.step.index, record.position];
}

function before(left: OrderedRecord, right: OrderedRecord): boolean {
  const [leftStep, leftPosition] = point(left);
  const [rightStep, rightPosition] = point(right);
  return leftStep < rightStep || (leftStep === rightStep && leftPosition < rightPosition);
}

function signalsFor(block: WorkflowJobBlock): {
  signals: ReleaseAssetMutationSignal[];
  evidence: number;
  publications: number;
  mutations: number;
} {
  const steps = workflowStepBlocks(block);
  const evidence = steps.flatMap(step => evidenceRecords(block, step));
  const publications = steps.flatMap(publicationRecords);
  const assets = [...new Set([...evidence, ...publications].map(item => item.asset))];
  const mutations = steps.flatMap(step => mutationRecords(step, assets));
  const signals: ReleaseAssetMutationSignal[] = [];

  for (const publication of publications) {
    const priorEvidence = evidence
      .filter(item => item.asset === publication.asset && before(item, publication))
      .sort((left, right) => right.step.index - left.step.index || right.position - left.position)[0];
    if (!priorEvidence) continue;
    const staleMutation = mutations.find(item =>
      item.asset === publication.asset
      && before(priorEvidence, item)
      && before(item, publication));
    if (!staleMutation) continue;
    signals.push({
      file: block.file.repositoryPath,
      job: block.name,
      asset: publication.asset,
      evidenceStep: stepDisplayName(priorEvidence.step),
      mutationStep: stepDisplayName(staleMutation.step),
      publicationStep: stepDisplayName(publication.step),
      mutationCommand: staleMutation.command,
      evidenceKind: priorEvidence.kind,
      publicationKind: publication.kind,
      line: firstWorkflowStepField(staleMutation.step, 'run')?.line ?? staleMutation.step.startLine,
    });
  }

  return { signals, evidence: evidence.length, publications: publications.length, mutations: mutations.length };
}

function finding(signal: ReleaseAssetMutationSignal): Finding {
  return {
    id: 'ci-release-asset-integrity-stale-after-mutation',
    domain: 'release',
    severity: 'critical',
    blocking: true,
    title: 'Release asset is modified after integrity verification',
    message: `Asset ${signal.asset} is covered by ${signal.evidenceKind}, then modified by ${signal.mutationCommand}, and later published by ${signal.publicationKind}. Integrity evidence no longer describes the released bytes.`,
    location: { file: signal.file, line: signal.line },
    evidence: {
      value: signal.mutationCommand,
      metadata: {
        job: signal.job,
        asset: signal.asset,
        evidenceStep: signal.evidenceStep,
        mutationStep: signal.mutationStep,
        publicationStep: signal.publicationStep,
      },
    },
    remediation: 'Perform all content-producing mutations before digest/attestation verification. After the final mutation, verify or attest the exact asset and publish it without rewriting, repacking, copying over, truncating, or regenerating that path.',
    tags: ['ci', 'release', 'artifact', 'provenance', 'mutation', 'ordering'],
  };
}

export function auditReleaseAssetMutations(
  inventory: RepositoryInventory,
): AuditSection<ReleaseAssetMutationSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const signals: ReleaseAssetMutationSignal[] = [];
  let integritySubjects = 0;
  let publishedAssets = 0;
  let mutationRecordsCount = 0;

  for (const file of files) {
    for (const block of workflowJobBlocks(file)) {
      const result = signalsFor(block);
      signals.push(...result.signals);
      integritySubjects += result.evidence;
      publishedAssets += result.publications;
      mutationRecordsCount += result.mutations;
    }
  }

  const findings = stableSortFindings(signals.map(finding));
  return {
    domain: 'release',
    title: 'Post-verification release asset mutation audit',
    summary: {
      workflowFiles: files.length,
      integritySubjects,
      publishedAssets,
      mutationRecords: mutationRecordsCount,
      staleIntegrityBindings: signals.length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
