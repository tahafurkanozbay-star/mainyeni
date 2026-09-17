import assert from 'node:assert/strict';
import test from 'node:test';
import { auditPerformance } from './performance-audit.mts';
import type { FileKind, RepositoryInventory, SourceFile } from './contracts.mts';

function kind(path: string): FileKind {
  if (/\.tsx?$/.test(path)) return 'typescript';
  if (/\.jsx?$/.test(path)) return 'javascript';
  if (/\.json$/.test(path)) return 'json';
  if (/\.css$/.test(path)) return 'css';
  return 'other';
}

function source(path: string, text: string): SourceFile {
  const lastDot = path.lastIndexOf('.');
  return { absolutePath: `/repo/${path}`, repositoryPath: path, extension: lastDot >= 0 ? path.slice(lastDot) : '', kind: kind(path), bytes: new TextEncoder().encode(text).byteLength, lines: text.split('\n').length, text };
}

function inventory(entries: readonly [string, string][]): RepositoryInventory {
  const files = entries.map(([path, text]) => source(path, text));
  return { root: '/repo', files, ignoredDirectories: [], languageStats: [], totalFiles: files.length, totalLines: files.reduce((sum, file) => sum + file.lines, 0), totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), generatedAt: '2026-09-17T00:00:00.000Z' };
}

function ids(entries: readonly [string, string][]): string[] { return auditPerformance(inventory(entries)).findings.map(finding => finding.id); }

test('ordinary bounded modules remain clean', () => { const result = auditPerformance(inventory([['Webclient.app/src/feature.ts', 'export const value = 1;'], ['Webclient.app/src/feature.css', '.root { display: grid; }']])); assert.deepEqual(result.findings, []); assert.equal(result.summary.synchronousLoopCandidates, 0); });
test('oversized source byte budget is reported', () => { assert.ok(ids([['Webclient.app/src/huge.ts', `export const payload = '${'x'.repeat(450_100)}';`]]).includes('performance-source-file-bytes')); });
test('oversized source line budget is reported', () => { const text = Array.from({ length: 4_010 }, (_, index) => `export const v${index} = ${index};`).join('\n'); assert.ok(ids([['Webclient.app/src/huge-lines.ts', text]]).includes('performance-source-file-lines')); });
test('extreme source bytes escalate to high severity', () => { const result = auditPerformance(inventory([['Webclient.app/src/extreme.ts', `export const payload = '${'x'.repeat(900_100)}';`]])); assert.equal(result.findings.find(item => item.id === 'performance-source-file-bytes')?.severity, 'high'); });
test('large application JSON is detected while lockfiles are excluded', () => { const result = auditPerformance(inventory([['Webclient.app/src/data/catalog.json', JSON.stringify({ payload: 'x'.repeat(250_100) })], ['Webclient.app/package-lock.json', JSON.stringify({ payload: 'x'.repeat(300_000) })]])); assert.deepEqual(result.summary.largeJsonFiles, ['Webclient.app/src/data/catalog.json']); assert.equal(result.findings.filter(item => item.id === 'performance-large-json-asset').length, 1); });
test('dynamic import and React lazy evidence are recorded', () => { const result = auditPerformance(inventory([['Webclient.app/src/routes.ts', "export const load = () => import('./HeavyRoute');"], ['Webclient.app/src/View.tsx', "import { lazy } from 'react'; export const Heavy = lazy(() => import('./Heavy'));" ]])); assert.deepEqual([...result.summary.lazyImportFiles].sort(), ['Webclient.app/src/View.tsx', 'Webclient.app/src/routes.ts']); });
test('dense eager query/window imports are detected at threshold', () => { const eight = Array.from({ length: 8 }, (_, index) => `import Q${index} from './QueryWindow${index}';`).join('\n'); const seven = Array.from({ length: 7 }, (_, index) => `import Q${index} from './QueryWindow${index}';`).join('\n'); assert.ok(ids([['Webclient.app/src/eager.ts', eight]]).includes('performance-eager-query-window-imports')); assert.ok(!ids([['Webclient.app/src/eager.ts', seven]]).includes('performance-eager-query-window-imports')); });
test('nested synchronous loops are detected but single loops remain clean', () => { const nested = 'for (const row of rows) { for (const cell of row.cells) { consume(cell); } }'; assert.ok(ids([['Webclient.app/src/grid.ts', nested]]).includes('performance-nested-loop-review')); assert.ok(!ids([['Webclient.app/src/grid.ts', 'for (const row of rows) { consume(row); }']]).includes('performance-nested-loop-review')); });
test('repeated nested-loop candidates escalate', () => { const candidate = 'for (const row of rows) { for (const cell of row.cells) { consume(cell); } }\n'; const result = auditPerformance(inventory([['Webclient.app/src/grid.ts', candidate.repeat(4)]])); assert.equal(result.findings.find(item => item.id === 'performance-nested-loop-review')?.severity, 'high'); });
test('synchronous iteration telemetry counts common constructs', () => { const result = auditPerformance(inventory([['Webclient.app/src/work.ts', 'items.map(render);\nitems.forEach(index);\nconst total = items.reduce(sum, 0);\nwhile (ready()) { tick(); }']])); assert.equal(result.summary.synchronousLoopCandidates, 4); });
test('memoization and virtualization readiness are observable without findings', () => { const result = auditPerformance(inventory([['Webclient.app/src/View.tsx', "const a = useMemo(build, []); const b = useCallback(run, []); export default memo(View); import { FixedSizeList } from 'react-window'; const overscan = 4; const mode = 'virtualized';"]])); assert.equal(result.summary.memoizationSignals, 3); assert.ok(result.summary.virtualizationSignals >= 3); });
test('release QA implementation excludes itself from application performance findings', () => { const result = auditPerformance(inventory([['quality/release/fixture.ts', `export const payload = '${'x'.repeat(500_000)}';`]])); assert.deepEqual(result.findings, []); assert.deepEqual(result.summary.largestFiles, []); });
test('largest-file diagnostics are sorted and bounded', () => { const entries: [string, string][] = Array.from({ length: 25 }, (_, index) => [`Webclient.app/src/file-${index}.ts`, `export const value = '${'x'.repeat(index + 1)}';`]); const result = auditPerformance(inventory(entries)); assert.equal(result.summary.largestFiles.length, 20); assert.equal(result.summary.largestFiles[0]?.file, 'Webclient.app/src/file-24.ts'); assert.equal(result.summary.largestFiles.at(-1)?.file, 'Webclient.app/src/file-5.ts'); });
test('finding ordering is deterministic across input order', () => { const largeA = `export const payload = '${'a'.repeat(450_100)}';`; const largeB = `export const payload = '${'b'.repeat(450_100)}';`; const first = auditPerformance(inventory([['Webclient.app/src/b.ts', largeB], ['Webclient.app/src/a.ts', largeA]])).findings.map(finding => `${finding.id}:${finding.location?.file}`); const second = auditPerformance(inventory([['Webclient.app/src/a.ts', largeA], ['Webclient.app/src/b.ts', largeB]])).findings.map(finding => `${finding.id}:${finding.location?.file}`); assert.deepEqual(first, second); });
test('custom budgets emit actionable metadata', () => { const result = auditPerformance(inventory([['Webclient.app/src/module.ts', 'export const payload = 123456789;']]), { maxSourceFileBytes: 10, maxSourceFileLines: 100, maxInlineJsonBytes: 100, maxSynchronousLoopLines: 100, maxRemoteAssetHosts: 0, maxDuplicateLiteralOccurrences: 10 }); const finding = result.findings.find(item => item.id === 'performance-source-file-bytes'); assert.ok(finding); assert.deepEqual(finding.evidence?.metadata, { budget: 10, unit: 'bytes' }); assert.equal(typeof finding.remediation, 'string'); assert.ok(finding.remediation?.includes('lazy-load')); });
test('section timing and repository-relative locations remain stable', () => { const result = auditPerformance(inventory([['Webclient.app/src/huge.ts', `export const payload = '${'x'.repeat(450_100)}';`]])); assert.ok(result.elapsedMs >= 0); assert.deepEqual(result.findings[0]?.location, { file: 'Webclient.app/src/huge.ts', line: 1 }); });
