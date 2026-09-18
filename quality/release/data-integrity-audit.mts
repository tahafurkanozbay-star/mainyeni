import { stableSortFindings, type AuditSection, type Finding, type RepositoryInventory, type SourceFile } from './contracts.mts';
import { createLineIndex, snippetAround } from './inventory.mts';

export interface DataIntegritySummary {
  readonly jsonFiles: number;
  readonly parseFailures: number;
  readonly duplicateIdentitySignals: number;
  readonly unsafeNumericIdentitySignals: number;
  readonly unboundedCollectionSignals: number;
  readonly findings: readonly Finding[];
}

const RUNTIME_PATH = /^(?:Webclient\.app\/src|Webclient\.Admin\/src|Api\.|Webclient\.Business)/;
const GENERATED_OR_TEST = /(?:^|\/)(?:node_modules|dist|build|coverage|quality\/release\/fixtures)(?:\/|$)|(?:\.test|\.spec)\.[cm]?[jt]sx?$/;
const DUPLICATE_IDENTITY = /\b(?:objectId|OBJECTID|globalId|GlobalID|recordId|featureId)\b/gi;
const UNSAFE_NUMERIC_IDENTITY = /(?:parseInt|Number)\s*\([^)]*(?:objectId|OBJECTID|globalId|GlobalID|recordId|featureId)[^)]*\)/gi;
const UNBOUNDED_COLLECTION = /\b(?:push|unshift|splice)\s*\([^)]*\)/g;
const BOUNDED_HINT = /\b(?:max(?:imum)?|limit|capacity|budget|pageSize|slice|truncate|bounded|evict)\b/i;

function runtimeFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => RUNTIME_PATH.test(file.repositoryPath) && !GENERATED_OR_TEST.test(file.repositoryPath));
}

function jsonFindings(files: readonly SourceFile[]): { findings: Finding[]; failures: number } {
  const findings: Finding[] = [];
  let failures = 0;
  for (const file of files) {
    if (file.kind !== 'json') continue;
    try { JSON.parse(file.text); }
    catch (error) {
      failures += 1;
      findings.push({ id: 'data-invalid-json', domain: 'data', severity: 'critical', blocking: true, title: 'Invalid runtime JSON', message: 'Runtime JSON must parse deterministically before release.', location: { file: file.repositoryPath, line: 1 }, evidence: { value: error instanceof Error ? error.message : String(error) }, remediation: 'Repair the JSON document and add a schema/fixture regression test.', tags: ['json', 'schema', 'release'] });
    }
  }
  return { findings, failures };
}

function regexSignals(file: SourceFile, pattern: RegExp, id: string, severity: 'low' | 'medium' | 'high', title: string, message: string, remediation: string, max = 5): Finding[] {
  const findings: Finding[] = [];
  const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const lines = createLineIndex(file.text);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(file.text)) !== null && findings.length < max) {
    findings.push({ id, domain: 'data', severity, title, message, location: { file: file.repositoryPath, line: lines.lineAt(match.index) }, evidence: { excerpt: snippetAround(file.text, match.index, 120) }, remediation, tags: ['data-integrity'] });
    if (match[0].length === 0) matcher.lastIndex += 1;
  }
  return findings;
}

function collectionFindings(file: SourceFile): Finding[] {
  if (BOUNDED_HINT.test(file.text)) return [];
  const matches = [...file.text.matchAll(new RegExp(UNBOUNDED_COLLECTION.source, 'g'))];
  if (matches.length < 4) return [];
  const first = matches[0];
  if (!first) return [];
  const lines = createLineIndex(file.text);
  return [{ id: 'data-unbounded-runtime-collection', domain: 'data', severity: 'medium', title: 'Potentially unbounded runtime collection', message: 'Repeated collection growth without an obvious capacity/eviction hint can amplify large GIS/data workloads.', location: { file: file.repositoryPath, line: lines.lineAt(first.index ?? 0) }, evidence: { value: matches.length, excerpt: snippetAround(file.text, first.index ?? 0, 120) }, remediation: 'Introduce an explicit capacity/budget, eviction policy, pagination/windowing, or document why lifetime is inherently bounded.', tags: ['memory', 'large-data', 'performance'] }];
}

export function auditDataIntegrity(inventory: RepositoryInventory): AuditSection<DataIntegritySummary> {
  const start = performance.now();
  const files = runtimeFiles(inventory);
  const jsonFiles = files.filter(file => file.kind === 'json');
  const parsed = jsonFindings(jsonFiles);
  const findings: Finding[] = [...parsed.findings];
  let duplicateIdentitySignals = 0;
  let unsafeNumericIdentitySignals = 0;
  let unboundedCollectionSignals = 0;
  for (const file of files) {
    if (!['javascript', 'typescript', 'csharp'].includes(file.kind)) continue;
    const identityMatches = file.text.match(DUPLICATE_IDENTITY)?.length ?? 0;
    if (identityMatches >= 12 && !/\b(?:dedup|unique|distinct|Set|Map)\b/i.test(file.text)) {
      duplicateIdentitySignals += 1;
      findings.push(...regexSignals(file, DUPLICATE_IDENTITY, 'data-identity-without-dedupe-signal', 'low', 'Identity-heavy flow lacks dedupe signal', 'Identity-heavy data code should make duplicate handling explicit.', 'Use a stable identity map/set or document the upstream uniqueness guarantee.', 1));
    }
    const unsafe = file.text.match(UNSAFE_NUMERIC_IDENTITY)?.length ?? 0;
    if (unsafe > 0) {
      unsafeNumericIdentitySignals += unsafe;
      findings.push(...regexSignals(file, UNSAFE_NUMERIC_IDENTITY, 'data-lossy-identity-coercion', 'high', 'Potentially lossy record identity coercion', 'String/global identifiers must not be coerced to numbers without a verified numeric contract.', 'Preserve identifiers as strings or validate the numeric schema and safe-integer range before conversion.'));
    }
    const collection = collectionFindings(file);
    if (collection.length > 0) unboundedCollectionSignals += 1;
    findings.push(...collection);
  }
  const sorted = stableSortFindings(findings);
  return { domain: 'data', title: 'Runtime data integrity and boundedness audit', summary: { jsonFiles: jsonFiles.length, parseFailures: parsed.failures, duplicateIdentitySignals, unsafeNumericIdentitySignals, unboundedCollectionSignals, findings: sorted }, findings: sorted, elapsedMs: Math.max(0, performance.now() - start) };
}
