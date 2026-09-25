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
  readonly observerLifecycleRiskFiles: readonly string[];
  readonly recurringTimerLifecycleRiskFiles: readonly string[];
  readonly legacyPerformanceJavascriptFiles: readonly string[];
}

interface LoopSpan {
  readonly start: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

const LOOP_PATTERN = /\b(?:for\s*\(|while\s*\(|forEach\s*\(|\.map\s*\(|\.reduce\s*\()/g;
const STRUCTURAL_LOOP_PATTERN = /\bfor\s*\(|\bwhile\s*\(|\.forEach\s*\(/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(/g;
const REACT_LAZY_PATTERN = /\bReact\.lazy\s*\(|\blazy\s*\(\s*\(\)\s*=>\s*import\s*\(/g;
const MEMO_PATTERN = /\b(?:React\.memo|memo|useMemo|useCallback)\s*\(/g;
const VIRTUAL_PATTERN = /\b(?:virtualiz|windowing|react-window|react-virtualized|overscan)\b/gi;
const QUERY_WINDOW_IMPORT_PATTERN = /^\s*import\s+[^;]+from\s+['"][^'"]*(?:Query|Window)[^'"]*['"]/gm;
const LARGE_COLLECTION_LITERAL_PATTERN = /\[(?:[^\[\]]|\[[^\]]*\]){5000,}\]/g;
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec|fixture|mock)\.[^/]+$/i;
const GENERATED_PATH = /(?:^|\/)(?:dist|build|coverage|node_modules)(?:\/|$)/i;
const PERFORMANCE_INSTRUMENTATION_PATH = /(?:^|\/)(?:performance|platform\/performance)(?:\/|$)|(?:^|\/)reportWebVitals\.[^/]+$/i;
const PERFORMANCE_OBSERVER_PATTERN = /\bnew\s+PerformanceObserver\s*\(/g;
const OBSERVER_DISCONNECT_PATTERN = /\.disconnect\s*\(/g;
const RECURRING_TIMER_PATTERN = /\bsetInterval\s*\(/g;
const CLEAR_RECURRING_TIMER_PATTERN = /\bclearInterval\s*\(/g;

function isProductionWebSource(file: SourceFile): boolean {
  return !TEST_PATH.test(file.repositoryPath) && !GENERATED_PATH.test(file.repositoryPath);
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))].length;
}

function maskCommentsAndStrings(text: string): string {
  const output = [...text];
  let index = 0;
  while (index < output.length) {
    const current = text[index];
    const next = text[index + 1];
    if (current === '/' && next === '/') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 2;
      while (index < output.length && text[index] !== '\n') {
        output[index] = ' ';
        index += 1;
      }
      continue;
    }
    if (current === '/' && next === '*') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 2;
      while (index < output.length) {
        if (text[index] === '*' && text[index + 1] === '/') {
          output[index] = ' ';
          output[index + 1] = ' ';
          index += 2;
          break;
        }
        if (text[index] !== '\n') output[index] = ' ';
        index += 1;
      }
      continue;
    }
    if (current === '\'' || current === '"' || current === '`') {
      const quote = current;
      output[index] = ' ';
      index += 1;
      while (index < output.length) {
        const value = text[index];
        if (value === '\\') {
          output[index] = ' ';
          if (index + 1 < output.length && text[index + 1] !== '\n') output[index + 1] = ' ';
          index += 2;
          continue;
        }
        if (value === quote) {
          output[index] = ' ';
          index += 1;
          break;
        }
        if (value !== '\n') output[index] = ' ';
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return output.join('');
}

function matchingDelimiter(text: string, start: number, open: string, close: string): number {
  if (text[start] !== open) return -1;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === open) depth += 1;
    else if (text[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index] ?? '')) index += 1;
  return index;
}

function singleStatementEnd(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === ';' || text[index] === '\n') return index + 1;
  }
  return text.length;
}

function structuralLoopSpans(text: string): readonly LoopSpan[] {
  const source = maskCommentsAndStrings(text);
  const spans: LoopSpan[] = [];
  for (const match of source.matchAll(STRUCTURAL_LOOP_PATTERN)) {
    const start = match.index ?? 0;
    const openParen = source.indexOf('(', start);
    if (openParen < 0) continue;
    const closeParen = matchingDelimiter(source, openParen, '(', ')');
    if (closeParen < 0) continue;

    if (match[0].includes('forEach')) {
      spans.push({ start, bodyStart: openParen + 1, bodyEnd: closeParen });
      continue;
    }

    const statementStart = skipWhitespace(source, closeParen + 1);
    if (source[statementStart] === '{') {
      const closeBrace = matchingDelimiter(source, statementStart, '{', '}');
      if (closeBrace >= 0) {
        spans.push({ start, bodyStart: statementStart + 1, bodyEnd: closeBrace });
        continue;
      }
    }
    spans.push({ start, bodyStart: statementStart, bodyEnd: singleStatementEnd(source, statementStart) });
  }
  return spans;
}

function nestedLoopCount(text: string): number {
  const spans = structuralLoopSpans(text);
  let count = 0;
  for (const outer of spans) {
    for (const inner of spans) {
      if (inner.start > outer.bodyStart && inner.start < outer.bodyEnd) count += 1;
    }
  }
  return count;
}

function fileSizeSignals(files: readonly SourceFile[], budget: PerformanceBudget): PerformanceSignal[] {
  const signals: PerformanceSignal[] = [];
  for (const file of files) {
    if (file.bytes > budget.maxSourceFileBytes) {
      signals.push({
        id: 'source-file-bytes',
        file: file.repositoryPath,
        value: file.bytes,
        budget: budget.maxSourceFileBytes,
        unit: 'bytes',
        description: 'Source file exceeds maintainability/parse-size budget.',
      });
    }
    if (file.lines > budget.maxSourceFileLines) {
      signals.push({
        id: 'source-file-lines',
        file: file.repositoryPath,
        value: file.lines,
        budget: budget.maxSourceFileLines,
        unit: 'lines',
        description: 'Source file exceeds maintainability line budget.',
      });
    }
  }
  return signals;
}

function signalFindings(signals: readonly PerformanceSignal[]): Finding[] {
  return signals.map(signal => ({
    id: `performance-${signal.id}`,
    domain: 'performance',
    severity: signal.value > signal.budget * 2 ? 'high' : 'medium',
    title: 'Performance/maintainability budget exceeded',
    message: signal.description,
    location: { file: signal.file, line: 1 },
    evidence: { metadata: { value: signal.value, budget: signal.budget, unit: signal.unit } },
    remediation: 'Split by responsibility and lazy-load or stream heavy data/code where behavior permits.',
    tags: ['budget'],
  }));
}

function nestedLoopFindings(files: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const count = nestedLoopCount(file.text);
    if (count === 0) continue;
    findings.push({
      id: 'performance-nested-loop-review',
      domain: 'performance',
      severity: count >= 4 ? 'high' : 'medium',
      title: 'Nested synchronous iteration candidate',
      message: 'Structurally nested iteration in UI/data/GIS code can become quadratic on large result sets.',
      location: { file: file.repositoryPath, line: 1 },
      evidence: { value: count },
      remediation: 'Profile representative large datasets; consider indexing/maps, spatial filtering, chunking or server-side work.',
      tags: ['cpu', 'large-data'],
    });
  }
  return findings;
}

function largeJsonFindings(files: readonly SourceFile[], budget: PerformanceBudget): { files: string[]; findings: Finding[] } {
  const largeFiles: string[] = [];
  const findings: Finding[] = [];
  for (const file of files) {
    if (file.kind !== 'json' || file.bytes <= budget.maxInlineJsonBytes) continue;
    if (/package-lock\.json$/.test(file.repositoryPath)) continue;
    largeFiles.push(file.repositoryPath);
    findings.push({
      id: 'performance-large-json-asset',
      domain: 'performance',
      severity: file.bytes > budget.maxInlineJsonBytes * 4 ? 'high' : 'medium',
      title: 'Large JSON payload in repository',
      message: 'Large static JSON can inflate startup parse/memory cost if eagerly bundled or fetched.',
      location: { file: file.repositoryPath, line: 1 },
      evidence: { metadata: { bytes: file.bytes, budget: budget.maxInlineJsonBytes } },
      remediation: 'Verify loading path; split, compress, lazy-load or move server-side where appropriate.',
      tags: ['bundle', 'memory'],
    });
  }
  return { files: largeFiles, findings };
}

function lazyLoadingSignals(files: readonly SourceFile[]): { lazy: string[]; eager: string[] } {
  const lazy: string[] = [];
  const eager: string[] = [];
  for (const file of files) {
    if (!['javascript', 'typescript'].includes(file.kind)) continue;
    if (countMatches(file.text, DYNAMIC_IMPORT_PATTERN) > 0 || countMatches(file.text, REACT_LAZY_PATTERN) > 0) lazy.push(file.repositoryPath);
    if (countMatches(file.text, QUERY_WINDOW_IMPORT_PATTERN) >= 8) eager.push(file.repositoryPath);
  }
  return { lazy, eager };
}

function eagerImportFindings(files: readonly string[]): Finding[] {
  return files.map(file => ({
    id: 'performance-eager-query-window-imports',
    domain: 'performance',
    severity: 'medium',
    title: 'Dense eager query/window imports',
    message: 'A module eagerly imports many query/window surfaces and can inflate startup bundle work.',
    location: { file, line: 1 },
    remediation: 'Use the existing lazy query-window registry/factory where behavior remains equivalent.',
    tags: ['bundle', 'lazy-loading'],
  }));
}

function largeLiteralFindings(files: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (!['javascript', 'typescript'].includes(file.kind)) continue;
    const count = countMatches(file.text, LARGE_COLLECTION_LITERAL_PATTERN);
    if (count === 0) continue;
    findings.push({
      id: 'performance-large-inline-collection',
      domain: 'performance',
      severity: 'medium',
      title: 'Large inline collection literal',
      message: 'Large inline data structures increase parse cost and can defeat incremental loading.',
      location: { file: file.repositoryPath, line: 1 },
      evidence: { value: count },
      remediation: 'Move large data to a dedicated lazy asset/module or server query if it is not critical-path configuration.',
      tags: ['parse', 'bundle'],
    });
  }
  return findings;
}

function instrumentationLifecycleFindings(files: readonly SourceFile[]): {
  observerRisk: string[];
  timerRisk: string[];
  legacyJavascript: string[];
  findings: Finding[];
} {
  const observerRisk: string[] = [];
  const timerRisk: string[] = [];
  const legacyJavascript: string[] = [];
  const findings: Finding[] = [];

  for (const file of files) {
    if (!PERFORMANCE_INSTRUMENTATION_PATH.test(file.repositoryPath)) continue;

    if (
      /(?:^|\/)reportWebVitals\.js$/i.test(file.repositoryPath)
      || /(?:^|\/)performance\/[^/]+\.js$/i.test(file.repositoryPath)
    ) {
      legacyJavascript.push(file.repositoryPath);
      findings.push({
        id: 'performance-legacy-javascript-runtime',
        domain: 'performance',
        severity: 'medium',
        title: 'Legacy JavaScript performance runtime',
        message: 'Performance instrumentation should remain inside the strict TypeScript boundary.',
        location: { file: file.repositoryPath, line: 1 },
        remediation: 'Migrate the performance runtime to TypeScript and include it in the dedicated strict typecheck project.',
        tags: ['typescript', 'instrumentation'],
      });
    }

    const observerCreates = countMatches(file.text, PERFORMANCE_OBSERVER_PATTERN);
    const observerDisconnects = countMatches(file.text, OBSERVER_DISCONNECT_PATTERN);
    if (observerCreates > observerDisconnects) {
      observerRisk.push(file.repositoryPath);
      findings.push({
        id: 'performance-observer-lifecycle-risk',
        domain: 'performance',
        severity: 'medium',
        title: 'PerformanceObserver lifecycle may leak',
        message: 'Performance instrumentation creates more observers than it visibly disconnects.',
        location: { file: file.repositoryPath, line: 1 },
        evidence: { metadata: { observerCreates, observerDisconnects } },
        remediation: 'Retain observer handles and disconnect them on stop, unmount, page lifecycle cleanup, and HMR disposal.',
        tags: ['observer', 'memory', 'lifecycle'],
      });
    }

    const intervals = countMatches(file.text, RECURRING_TIMER_PATTERN);
    const clears = countMatches(file.text, CLEAR_RECURRING_TIMER_PATTERN);
    if (intervals > clears) {
      timerRisk.push(file.repositoryPath);
      findings.push({
        id: 'performance-recurring-timer-lifecycle-risk',
        domain: 'performance',
        severity: 'medium',
        title: 'Recurring performance timer may outlive its owner',
        message: 'Performance instrumentation creates more recurring timers than it visibly clears.',
        location: { file: file.repositoryPath, line: 1 },
        evidence: { metadata: { intervals, clears } },
        remediation: 'Prefer event/observer-driven collection; otherwise clear recurring timers deterministically on disposal.',
        tags: ['timer', 'memory', 'lifecycle'],
      });
    }
  }

  return {
    observerRisk,
    timerRisk,
    legacyJavascript,
    findings,
  };
}

export function auditPerformance(
  inventory: RepositoryInventory,
  budget: PerformanceBudget = DEFAULT_PERFORMANCE_BUDGET,
): AuditSection<PerformanceAuditDetails> {
  const start = performance.now();
  const webFiles = selectWebSource(inventory).filter(file => !file.repositoryPath.startsWith('quality/release/') && isProductionWebSource(file));
  const codeFiles = webFiles.filter(file => ['javascript', 'typescript'].includes(file.kind));
  const signals = fileSizeSignals(webFiles, budget);
  const largeJson = largeJsonFindings(webFiles, budget);
  const loading = lazyLoadingSignals(codeFiles);
  const nested = nestedLoopFindings(codeFiles);
  const instrumentation = instrumentationLifecycleFindings(codeFiles);
  const findings: Finding[] = [
    ...signalFindings(signals),
    ...largeJson.findings,
    ...nested,
    ...eagerImportFindings(loading.eager),
    ...largeLiteralFindings(codeFiles),
    ...instrumentation.findings,
  ];

  const synchronousLoopCandidates = codeFiles.reduce((sum, file) => sum + countMatches(file.text, LOOP_PATTERN), 0);
  const memoizationSignals = codeFiles.reduce((sum, file) => sum + countMatches(file.text, MEMO_PATTERN), 0);
  const virtualizationSignals = codeFiles.reduce((sum, file) => sum + countMatches(file.text, VIRTUAL_PATTERN), 0);
  const largestFiles = [...webFiles]
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 20)
    .map(file => ({ file: file.repositoryPath, bytes: file.bytes, lines: file.lines }));

  const sorted = stableSortFindings(findings);
  return {
    domain: 'performance',
    title: 'Static performance and large-data readiness audit',
    summary: {
      signals,
      findings: sorted,
      largestFiles,
      synchronousLoopCandidates,
      largeJsonFiles: largeJson.files,
      lazyImportFiles: loading.lazy,
      eagerQueryWindowImports: loading.eager,
      memoizationSignals,
      virtualizationSignals,
      observerLifecycleRiskFiles: instrumentation.observerRisk,
      recurringTimerLifecycleRiskFiles: instrumentation.timerRisk,
      legacyPerformanceJavascriptFiles: instrumentation.legacyJavascript,
    },
    findings: sorted,
    elapsedMs: Math.max(0, performance.now() - start),
  };
}
