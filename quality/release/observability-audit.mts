import { stableSortFindings, type AuditSection, type Finding, type RepositoryInventory, type SourceFile } from './contracts.mts';
import { createLineIndex, snippetAround } from './inventory.mts';

export interface ObservabilitySignal {
  readonly file: string;
  readonly consoleCalls: number;
  readonly swallowedCatches: number;
  readonly unhandledPromises: number;
  readonly timers: number;
  readonly intervals: number;
  readonly eventListeners: number;
  readonly abortControllers: number;
  readonly telemetrySignals: number;
  readonly correlationSignals: number;
}

export interface ObservabilityAuditSummary {
  readonly signals: readonly ObservabilitySignal[];
  readonly findings: readonly Finding[];
  readonly runtimeFiles: number;
  readonly consoleCalls: number;
  readonly swallowedCatches: number;
  readonly unhandledPromises: number;
  readonly timerCalls: number;
  readonly intervalCalls: number;
  readonly eventListeners: number;
  readonly abortControllers: number;
  readonly telemetrySignals: number;
  readonly correlationSignals: number;
}

const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec|fixture|mock)\.[^/]+$/i;
const GENERATED_PATH = /(^|\/)(dist|build|coverage|node_modules)(\/|$)/i;
const RUNTIME_PATH = /^(?:Webclient\.app|Webclient\.Admin)\/src\//;
const CONSOLE_PATTERN = /\bconsole\.(?:log|debug|info|warn|error|trace)\s*\(/g;
const EMPTY_CATCH_PATTERN = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\s*)?\}/g;
const CALL_STATEMENT_PATTERN = /(?:^|[;{}]\s*)(void\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\([^;\n]*\)\s*;/gm;
const ASYNC_FUNCTION_DECLARATION_PATTERN = /\basync\s+function\s+([A-Za-z_$][\w$]*)\s*\(|\basync\s+([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*async\b/g;
const KNOWN_PROMISE_CALL_PATTERN = /^(?:fetch|queryFeatures|executeQueryJSON|axios(?:\.[A-Za-z_$][\w$]*)?|httpClient(?:\.[A-Za-z_$][\w$]*)?|transport(?:\.[A-Za-z_$][\w$]*)?)$/;
const TIMER_PATTERN = /\bsetTimeout\s*\(/g;
const INTERVAL_PATTERN = /\bsetInterval\s*\(/g;
const LISTENER_PATTERN = /\.addEventListener\s*\(/g;
const ABORT_PATTERN = /\b(?:new\s+AbortController|AbortSignal\.(?:timeout|any))\b/g;
const TELEMETRY_PATTERN = /\b(?:telemetry|metric|metrics|counter|histogram|trace|span|diagnostic|logger|logEvent|recordEvent|recordMetric)\b/gi;
const CORRELATION_PATTERN = /\b(?:correlationId|requestId|traceId|spanId|operationId)\b/gi;

function isRuntime(file: SourceFile): boolean {
  return RUNTIME_PATH.test(file.repositoryPath) && ['javascript', 'typescript'].includes(file.kind) && !TEST_PATH.test(file.repositoryPath) && !GENERATED_PATH.test(file.repositoryPath);
}

function count(text: string, pattern: RegExp): number {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))].length;
}

function declaredAsyncNames(text: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(ASYNC_FUNCTION_DECLARATION_PATTERN)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name) names.add(name);
  }
  return names;
}

function detachedPromiseCandidates(text: string): number {
  const asyncNames = declaredAsyncNames(text);
  let candidates = 0;
  for (const match of text.matchAll(CALL_STATEMENT_PATTERN)) {
    const explicitVoid = Boolean(match[1]);
    const callee = match[2];
    if (!callee) continue;
    const leaf = callee.split('.').at(-1) ?? callee;
    if (
      explicitVoid
      || asyncNames.has(leaf)
      || /Async$/.test(leaf)
      || KNOWN_PROMISE_CALL_PATTERN.test(callee)
    ) {
      candidates += 1;
    }
  }
  return candidates;
}

function signal(file: SourceFile): ObservabilitySignal {
  return {
    file: file.repositoryPath,
    consoleCalls: count(file.text, CONSOLE_PATTERN),
    swallowedCatches: count(file.text, EMPTY_CATCH_PATTERN),
    unhandledPromises: detachedPromiseCandidates(file.text),
    timers: count(file.text, TIMER_PATTERN),
    intervals: count(file.text, INTERVAL_PATTERN),
    eventListeners: count(file.text, LISTENER_PATTERN),
    abortControllers: count(file.text, ABORT_PATTERN),
    telemetrySignals: count(file.text, TELEMETRY_PATTERN),
    correlationSignals: count(file.text, CORRELATION_PATTERN),
  };
}

function matches(file: SourceFile, pattern: RegExp): Array<{ index: number; line: number; excerpt: string }> {
  const index = createLineIndex(file.text);
  const result: Array<{ index: number; line: number; excerpt: string }> = [];
  for (const match of file.text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))) {
    const offset = match.index ?? 0;
    result.push({ index: offset, line: index.lineAt(offset), excerpt: snippetAround(file.text, offset, 120) });
  }
  return result;
}

function consoleFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  for (const match of matches(file, CONSOLE_PATTERN).slice(0, 10)) {
    findings.push({
      id: 'observability-console-runtime',
      domain: 'observability',
      severity: /console\.(?:error|warn)/.test(match.excerpt) ? 'medium' : 'low',
      title: 'Runtime console call bypasses bounded diagnostics',
      message: 'Direct console output is difficult to correlate, redact, sample and bound consistently in production.',
      location: { file: file.repositoryPath, line: match.line },
      evidence: { excerpt: match.excerpt },
      remediation: 'Use the shared bounded diagnostics/logger abstraction and attach stable operation context without secrets or payload dumps.',
      tags: ['logging', 'diagnostics'],
    });
  }
  return findings;
}

function swallowedCatchFindings(file: SourceFile): Finding[] {
  return matches(file, EMPTY_CATCH_PATTERN).slice(0, 10).map(match => ({
    id: 'observability-swallowed-exception',
    domain: 'observability' as const,
    severity: 'high' as const,
    title: 'Exception is silently swallowed',
    message: 'An empty catch block removes failure evidence and can leave runtime state partially updated.',
    location: { file: file.repositoryPath, line: match.line },
    evidence: { excerpt: match.excerpt },
    remediation: 'Handle the expected failure explicitly, preserve state invariants, and record a bounded diagnostic when operationally useful.',
    tags: ['errors', 'reliability'],
  }));
}

function intervalFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  for (const match of matches(file, INTERVAL_PATTERN).slice(0, 8)) {
    const nearby = file.text.slice(match.index, Math.min(file.text.length, match.index + 1800));
    if (/clearInterval\s*\(/.test(nearby) || /return\s*\(\s*\)\s*=>[\s\S]{0,300}clearInterval/.test(nearby)) continue;
    findings.push({
      id: 'observability-interval-cleanup-review',
      domain: 'observability',
      severity: 'medium',
      title: 'Interval has no nearby cleanup evidence',
      message: 'Recurring timers can leak work across route/component/runtime lifecycle changes when cleanup ownership is unclear.',
      location: { file: file.repositoryPath, line: match.line },
      evidence: { excerpt: match.excerpt },
      remediation: 'Bind the interval to explicit lifecycle ownership and clear it deterministically on stop/unmount/abort.',
      tags: ['timer', 'lifecycle', 'memory'],
    });
  }
  return findings;
}

function listenerFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  const listeners = matches(file, LISTENER_PATTERN);
  if (listeners.length === 0 || /removeEventListener\s*\(/.test(file.text)) return findings;
  for (const match of listeners.slice(0, 8)) {
    findings.push({
      id: 'observability-listener-cleanup-review',
      domain: 'observability',
      severity: 'medium',
      title: 'Event listener has no file-local cleanup evidence',
      message: 'Long-lived listeners require deterministic cleanup or a proven process-lifetime owner.',
      location: { file: file.repositoryPath, line: match.line },
      evidence: { excerpt: match.excerpt },
      remediation: 'Return/remove the listener during lifecycle cleanup, or document a process-lifetime singleton owner.',
      tags: ['events', 'lifecycle', 'memory'],
    });
  }
  return findings;
}

function timerPressureFinding(file: SourceFile, item: ObservabilitySignal): Finding[] {
  const total = item.timers + item.intervals;
  if (total < 8) return [];
  return [{
    id: 'observability-timer-pressure',
    domain: 'observability',
    severity: total >= 20 ? 'high' : 'medium',
    title: 'Timer-dense runtime module requires scheduling review',
    message: `The module contains ${total} timer registrations; dense timer usage increases wakeups, race surface and lifecycle complexity.`,
    location: { file: file.repositoryPath, line: 1 },
    evidence: { metadata: { timers: item.timers, intervals: item.intervals } },
    remediation: 'Consolidate scheduling under bounded lifecycle-owned coordination and prefer event-driven invalidation where practical.',
    tags: ['timers', 'performance', 'reliability'],
  }];
}

function asyncBoundaryFinding(file: SourceFile, item: ObservabilitySignal): Finding[] {
  if (item.unhandledPromises < 12) return [];
  if (/\.catch\s*\(|try\s*\{|await\s+/.test(file.text)) return [];
  return [{
    id: 'observability-async-boundary-review',
    domain: 'observability',
    severity: 'medium',
    title: 'Async-heavy module lacks visible failure boundary',
    message: 'Many detached Promise-returning call statements were detected without obvious await/catch/try evidence.',
    location: { file: file.repositoryPath, line: 1 },
    evidence: { value: item.unhandledPromises },
    remediation: 'Use explicit void only for intentionally detached work and route failures to the bounded runtime error/diagnostic boundary.',
    tags: ['async', 'errors'],
  }];
}

function cancellationFinding(file: SourceFile, item: ObservabilitySignal): Finding[] {
  const networkPattern = /\b(?:fetch|queryFeatures|executeQueryJSON)\s*\(|\baxios(?:\.[A-Za-z_$][\w$]*)?\s*\(|\b(?:httpClient|transport)\b/g;
  const networkCalls = count(file.text, networkPattern);
  if (networkCalls < 3 || item.abortControllers > 0 || /\bAbortSignal\b|\bsignal\s*[:=]/.test(file.text)) return [];
  return [{
    id: 'observability-cancellation-contract-review',
    domain: 'observability',
    severity: 'medium',
    title: 'Network-heavy module lacks visible cancellation contract',
    message: 'Repeated remote work without AbortSignal evidence can outlive navigation, superseding searches or GIS view lifecycle.',
    location: { file: file.repositoryPath, line: 1 },
    remediation: 'Thread AbortSignal through the shared transport/query boundary and treat cancellation separately from operational failures.',
    tags: ['network', 'cancellation', 'lifecycle'],
  }];
}

function correlationFinding(file: SourceFile, item: ObservabilitySignal): Finding[] {
  if (item.telemetrySignals < 6 || item.correlationSignals > 0) return [];
  return [{
    id: 'observability-correlation-review',
    domain: 'observability',
    severity: 'low',
    title: 'Diagnostic-rich module lacks correlation signal',
    message: 'A module with substantial diagnostics/telemetry vocabulary has no request/trace/operation correlation identifier evidence.',
    location: { file: file.repositoryPath, line: 1 },
    evidence: { metadata: { telemetrySignals: item.telemetrySignals } },
    remediation: 'Propagate a non-sensitive operation/request correlation identifier where it materially improves troubleshooting.',
    tags: ['diagnostics', 'correlation'],
  }];
}

export function auditObservability(inventory: RepositoryInventory): AuditSection<ObservabilityAuditSummary> {
  const started = performance.now();
  const files = inventory.files.filter(isRuntime);
  const signals = files.map(signal);
  const findings: Finding[] = [];
  for (const file of files) {
    const item = signals.find(candidate => candidate.file === file.repositoryPath) ?? signal(file);
    findings.push(...consoleFindings(file));
    findings.push(...swallowedCatchFindings(file));
    findings.push(...intervalFindings(file));
    findings.push(...listenerFindings(file));
    findings.push(...timerPressureFinding(file, item));
    findings.push(...asyncBoundaryFinding(file, item));
    findings.push(...cancellationFinding(file, item));
    findings.push(...correlationFinding(file, item));
  }
  const sorted = stableSortFindings(findings);
  const sum = (pick: (item: ObservabilitySignal) => number): number => signals.reduce((total, item) => total + pick(item), 0);
  return {
    domain: 'observability',
    title: 'Runtime observability, cancellation and lifecycle audit',
    summary: {
      signals,
      findings: sorted,
      runtimeFiles: files.length,
      consoleCalls: sum(item => item.consoleCalls),
      swallowedCatches: sum(item => item.swallowedCatches),
      unhandledPromises: sum(item => item.unhandledPromises),
      timerCalls: sum(item => item.timers),
      intervalCalls: sum(item => item.intervals),
      eventListeners: sum(item => item.eventListeners),
      abortControllers: sum(item => item.abortControllers),
      telemetrySignals: sum(item => item.telemetrySignals),
      correlationSignals: sum(item => item.correlationSignals),
    },
    findings: sorted,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
