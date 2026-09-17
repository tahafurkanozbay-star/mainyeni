import {
  DEFAULT_PERFORMANCE_BUDGET,
  stableSortFindings,
  type AuditSection,
  type Finding,
  type PerformanceBudget,
  type PerformanceSignal,
  type PerformanceSummary,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { selectWebSource } from './inventory.mts';

export interface PerformanceAuditDetails extends PerformanceSummary {
  readonly synchronousLoopCandidates: number;
  readonly largeJsonFiles: readonly string[];
  readonly lazyImportFiles: readonly string[];
  readonly eagerQueryWindowImports: readonly string[];
  readonly memoizationSignals: number;
  readonly virtualizationSignals: number;
}

const LOOP_PATTERN = /\b(?:for\s*\(|while\s*\(|forEach\s*\(|\.map\s*\(|\.reduce\s*\()/g;
const LOOP_START_PATTERN = /\b(?:for\s*\([^)]*\)|while\s*\([^)]*\)|\.forEach\s*\([^)]*=>)/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(/g;
const REACT_LAZY_PATTERN = /\bReact\.lazy\s*\(|\blazy\s*\(\s*\(\)\s*=>\s*import\s*\(/g;
const MEMO_PATTERN = /\b(?:React\.memo|memo|useMemo|useCallback)\s*\(/g;
const VIRTUAL_PATTERN = /\b(?:virtualiz(?:e|ed|es|ing|ation)?|windowing|react-window|react-virtualized|overscan)\b/gi;
const QUERY_WINDOW_IMPORT_PATTERN = /^\s*import\s+[^;]+from\s+['"][^'"]*(?:Query|Window)[^'"]*['"]/gm;
const LARGE_COLLECTION_LITERAL_PATTERN = /\[(?:[^\[\]]|\[[^\]]*\]){5000,}\]/g;

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))].length;
}

function countNestedLoopCandidates(text: string): number {
  const starts = [...text.matchAll(new RegExp(LOOP_START_PATTERN.source, LOOP_START_PATTERN.flags))];
  let count = 0;
  for (let index = 0; index < starts.length - 1; index += 1) {
    const current = starts[index];
    const next = starts[index + 1];
    if (current.index === undefined || next?.index === undefined) continue;
    const distance = next.index - current.index;
    if (distance > 0 && distance <= 900) count += 1;
  }
  return count;
}

function fileSizeSignals(files: readonly SourceFile[], budget: PerformanceBudget): PerformanceSignal[] {
  const signals: PerformanceSignal[] = [];
  for (const file of files) {
    if (file.bytes > budget.maxSourceFileBytes) signals.push({ id: 'source-file-bytes', file: file.repositoryPath, value: file.bytes, budget: budget.maxSourceFileBytes, unit: 'bytes', description: 'Source file exceeds maintainability/parse-size budget.' });
    if (file.lines > budget.maxSourceFileLines) signals.push({ id: 'source-file-lines', file: file.repositoryPath, value: file.lines, budget: budget.maxSourceFileLines, unit: 'lines', description: 'Source file exceeds maintainability line budget.' });
  }
  return signals;
}

function signalFindings(signals: readonly PerformanceSignal[]): Finding[] {
  return signals.map(signal => ({ id: `performance-${signal.id}`, domain: 'performance', severity: signal.value > signal.budget * 2 ? 'high' : 'medium', title: 'Performance/maintainability budget exceeded', message: signal.description, location: { file: signal.file, line: 1 }, evidence: { metadata: { value: signal.value, budget: signal.budget, unit: signal.unit } }, remediation: 'Split by responsibility and lazy-load or stream heavy data/code where behavior permits.', tags: ['budget'] }));
}

function nestedLoopFindings(files: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const count = countNestedLoopCandidates(file.text);
    if (count === 0) continue;
    findings.push({ id: 'performance-nested-loop-review', domain: 'performance', severity: count >= 4 ? 'high' : 'medium', title: 'Nested synchronous iteration candidate', message: 'Nested iteration in UI/data/GIS code can become quadratic on large result sets.', location: { file: file.repositoryPath, line: 1 }, evidence: { value: count }, remediation: 'Profile representative large datasets; consider indexing/maps, spatial filtering, chunking or server-side work.', tags: ['cpu', 'large-data'] });
  }
  return findings;
}

function largeJsonFindings(files: readonly SourceFile[], budget: PerformanceBudget): { files: string[]; findings: Finding[] } {
  const largeFiles: string[] = []; const findings: Finding[] = [];
  for (const file of files) {
    if (file.kind !== 'json' || file.bytes <= budget.maxInlineJsonBytes || /package-lock\.json$/.test(file.repositoryPath)) continue;
    largeFiles.push(file.repositoryPath);
    findings.push({ id: 'performance-large-json-asset', domain: 'performance', severity: file.bytes > budget.maxInlineJsonBytes * 4 ? 'high' : 'medium', title: 'Large JSON payload in repository', message: 'Large static JSON can inflate startup parse/memory cost if eagerly bundled or fetched.', location: { file: file.repositoryPath, line: 1 }, evidence: { metadata: { bytes: file.bytes, budget: budget.maxInlineJsonBytes } }, remediation: 'Verify loading path; split, compress, lazy-load or move server-side where appropriate.', tags: ['bundle', 'memory'] });
  }
  return { files: largeFiles, findings };
}

function lazyLoadingSignals(files: readonly SourceFile[]): { lazy: string[]; eager: string[] } {
  const lazy: string[] = []; const eager: string[] = [];
  for (const file of files) {
    if (!['javascript', 'typescript'].includes(file.kind)) continue;
    if (countMatches(file.text, DYNAMIC_IMPORT_PATTERN) > 0 || countMatches(file.text, REACT_LAZY_PATTERN) > 0) lazy.push(file.repositoryPath);
    if (countMatches(file.text, QUERY_WINDOW_IMPORT_PATTERN) >= 8) eager.push(file.repositoryPath);
  }
  return { lazy, eager };
}

function eagerImportFindings(files: readonly string[]): Finding[] { return files.map(file => ({ id: 'performance-eager-query-window-imports', domain: 'performance', severity: 'medium', title: 'Dense eager query/window imports', message: 'A module eagerly imports many query/window surfaces and can inflate startup bundle work.', location: { file, line: 1 }, remediation: 'Use the existing lazy query-window registry/factory where behavior remains equivalent.', tags: ['bundle', 'lazy-loading'] })); }

function largeLiteralFindings(files: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (!['javascript', 'typescript'].includes(file.kind)) continue;
    const count = countMatches(file.text, LARGE_COLLECTION_LITERAL_PATTERN); if (count === 0) continue;
    findings.push({ id: 'performance-large-inline-collection', domain: 'performance', severity: 'medium', title: 'Large inline collection literal', message: 'Large inline data structures increase parse cost and can defeat incremental loading.', location: { file: file.repositoryPath, line: 1 }, evidence: { value: count }, remediation: 'Move large data to a dedicated lazy asset/module or server query if it is not critical-path configuration.', tags: ['parse', 'bundle'] });
  }
  return findings;
}

export function auditPerformance(inventory: RepositoryInventory, budget: PerformanceBudget = DEFAULT_PERFORMANCE_BUDGET): AuditSection<PerformanceAuditDetails> {
  const start = performance.now();
  const webFiles = selectWebSource(inventory).filter(file => !file.repositoryPath.startsWith('quality/release/'));
  const codeFiles = webFiles.filter(file => ['javascript', 'typescript'].includes(file.kind));
  const signals = fileSizeSignals(webFiles, budget); const largeJson = largeJsonFindings(webFiles, budget); const loading = lazyLoadingSignals(codeFiles); const nested = nestedLoopFindings(codeFiles);
  const findings: Finding[] = [...signalFindings(signals), ...largeJson.findings, ...nested, ...eagerImportFindings(loading.eager), ...largeLiteralFindings(codeFiles)];
  const synchronousLoopCandidates = codeFiles.reduce((sum, file) => sum + countMatches(file.text, LOOP_PATTERN), 0);
  const memoizationSignals = codeFiles.reduce((sum, file) => sum + countMatches(file.text, MEMO_PATTERN), 0);
  const virtualizationSignals = codeFiles.reduce((sum, file) => sum + countMatches(file.text, VIRTUAL_PATTERN), 0);
  const largestFiles = [...webFiles].sort((left, right) => right.bytes - left.bytes).slice(0, 20).map(file => ({ file: file.repositoryPath, bytes: file.bytes, lines: file.lines }));
  const sorted = stableSortFindings(findings);
  return { domain: 'performance', title: 'Static performance and large-data readiness audit', summary: { signals, findings: sorted, largestFiles, synchronousLoopCandidates, largeJsonFiles: largeJson.files, lazyImportFiles: loading.lazy, eagerQueryWindowImports: loading.eager, memoizationSignals, virtualizationSignals }, findings: sorted, elapsedMs: Math.max(0, performance.now() - start) };
}
