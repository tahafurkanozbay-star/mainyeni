import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_THRESHOLDS,
  SEVERITY_WEIGHT,
  asString,
  clamp,
  compareSeverity,
  countSeverities,
  dedupeFindings,
  findingKey,
  isRecord,
  normalizeRepositoryPath,
  percentile,
  riskScore,
  safeInteger,
  safeJsonParse,
  safePositiveInteger,
  snapshotFinding,
  stableSortFindings,
  uniqueStrings,
  type Finding,
} from './contracts.mts';
import { classifyFile, countLines, createLineIndex, snippetAround } from './inventory.mts';

const sample = (overrides: Partial<Finding> = {}): Finding => ({
  id: 'sample',
  domain: 'release',
  severity: 'medium',
  title: 'Sample',
  message: 'Sample message',
  location: { file: 'src/sample.js', line: 2 },
  ...overrides,
});

test('severity weights preserve critical > high > medium > low > info', () => {
  assert.ok(SEVERITY_WEIGHT.critical > SEVERITY_WEIGHT.high);
  assert.ok(SEVERITY_WEIGHT.high > SEVERITY_WEIGHT.medium);
  assert.ok(SEVERITY_WEIGHT.medium > SEVERITY_WEIGHT.low);
  assert.ok(SEVERITY_WEIGHT.low > SEVERITY_WEIGHT.info);
});

test('default thresholds block critical findings', () => {
  assert.equal(DEFAULT_THRESHOLDS.blockOnCritical, true);
});

test('compareSeverity sorts more severe values first', () => {
  assert.ok(compareSeverity('critical', 'low') < 0);
  assert.ok(compareSeverity('info', 'high') > 0);
  assert.equal(compareSeverity('medium', 'medium'), 0);
});

test('countSeverities counts every category deterministically', () => {
  const counts = countSeverities([
    sample({ severity: 'critical' }),
    sample({ severity: 'critical', id: 'c2' }),
    sample({ severity: 'high', id: 'h' }),
    sample({ severity: 'medium', id: 'm' }),
    sample({ severity: 'low', id: 'l' }),
    sample({ severity: 'info', id: 'i' }),
  ]);
  assert.deepEqual(counts, { critical: 2, high: 1, medium: 1, low: 1, info: 1 });
});

test('riskScore adds stable severity weights', () => {
  assert.equal(riskScore([
    sample({ severity: 'critical' }),
    sample({ severity: 'high', id: 'h' }),
    sample({ severity: 'low', id: 'l' }),
  ]), 143);
});

test('normalizeRepositoryPath normalizes separators and repeated slashes', () => {
  assert.equal(normalizeRepositoryPath('.\\src\\foo//bar.js'), 'src/foo/bar.js');
});

test('findingKey incorporates location and evidence', () => {
  const key = findingKey(sample({ evidence: { value: 'abc' } }));
  assert.match(key, /release\|sample\|src\/sample\.js:2\|abc/);
});

test('dedupeFindings keeps only identical first finding key', () => {
  const finding = sample();
  const unique = dedupeFindings([finding, finding, sample({ id: 'other' })]);
  assert.equal(unique.length, 2);
  assert.equal(unique[0]?.id, 'sample');
});

test('stableSortFindings sorts by severity then domain/file/line/id', () => {
  const sorted = stableSortFindings([
    sample({ id: 'low', severity: 'low' }),
    sample({ id: 'high-b', severity: 'high', location: { file: 'z.js', line: 1 } }),
    sample({ id: 'high-a', severity: 'high', location: { file: 'a.js', line: 1 } }),
  ]);
  assert.deepEqual(sorted.map(item => item.id), ['high-a', 'high-b', 'low']);
});

test('snapshotFinding removes verbose message data', () => {
  const snapshot = snapshotFinding(sample({ evidence: { excerpt: 'large evidence' } }));
  assert.equal(snapshot.key.includes('release|sample'), true);
  assert.equal(snapshot.file, 'src/sample.js');
  assert.equal(snapshot.line, 2);
});

test('clamp handles boundaries and non-finite input', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(50, 0, 10), 10);
  assert.equal(clamp(Number.NaN, 2, 10), 2);
});

test('safeInteger parses finite values only', () => {
  assert.equal(safeInteger('12.8'), 12);
  assert.equal(safeInteger(Infinity, 7), 7);
  assert.equal(safeInteger('bad', 4), 4);
});

test('safePositiveInteger rejects zero and negative values', () => {
  assert.equal(safePositiveInteger('15', 2), 15);
  assert.equal(safePositiveInteger('0', 2), 2);
  assert.equal(safePositiveInteger('-2', 2), 2);
});

test('percentile computes deterministic nearest-rank percentile', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 1), 5);
  assert.equal(percentile([], 0.95), 0);
});

test('uniqueStrings removes empty and duplicate strings then sorts', () => {
  assert.deepEqual(uniqueStrings(['b', 'a', 'b', '', 'c']), ['a', 'b', 'c']);
});

test('isRecord excludes null and arrays', () => {
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
});

test('asString safely normalizes nullish values', () => {
  assert.equal(asString(null), '');
  assert.equal(asString(undefined), '');
  assert.equal(asString(12), '12');
});

test('safeJsonParse returns structured success', () => {
  const result = safeJsonParse<{ value: number }>(' { "value": 3 } ');
  assert.equal(result.ok, true);
  assert.equal(result.value?.value, 3);
});

test('safeJsonParse returns error instead of throwing', () => {
  const result = safeJsonParse('{broken');
  assert.equal(result.ok, false);
  assert.ok(Boolean(result.error));
});

test('classifyFile maps repository extensions', () => {
  assert.equal(classifyFile('src/a.js'), 'javascript');
  assert.equal(classifyFile('src/a.ts'), 'typescript');
  assert.equal(classifyFile('Api/A.cs'), 'csharp');
  assert.equal(classifyFile('x.json'), 'json');
  assert.equal(classifyFile('x.yml'), 'yaml');
});

test('countLines handles empty and multiline text', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\nb\n'), 3);
});

test('createLineIndex maps offsets to line and column', () => {
  const index = createLineIndex('abc\ndef\nghi');
  assert.equal(index.lineAt(0), 1);
  assert.equal(index.lineAt(4), 2);
  assert.equal(index.columnAt(4), 1);
  assert.equal(index.lineAt(8), 3);
});

test('snippetAround collapses whitespace and bounds evidence', () => {
  const snippet = snippetAround('hello    world\nsecond line', 8, 8);
  assert.match(snippet, /world/);
  assert.ok(snippet.length <= 16);
});
