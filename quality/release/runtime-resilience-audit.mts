import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { createLineIndex, snippetAround } from './inventory.mts';

export interface RuntimeResilienceSignal {
  readonly file: string;
  readonly line: number;
  readonly kind: 'timer' | 'listener' | 'promise' | 'abort' | 'retry' | 'storage';
  readonly excerpt: string;
}

export interface RuntimeResilienceSummary {
  readonly signals: readonly RuntimeResilienceSignal[];
  readonly timerFiles: number;
  readonly listenerFiles: number;
  readonly abortAwareFiles: number;
  readonly retryFiles: number;
  readonly storageFiles: number;
  readonly findings: readonly Finding[];
}

const RUNTIME_PATH = /^(?:Webclient\.app\/src|Webclient\.Admin\/src|backend\/|server\/|api\/)/;
const TEST_PATH = /(?:^|\/)(?:__tests__|test|tests|fixtures)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const TIMER = /\b(setInterval|setTimeout)\s*\(/g;
const TIMER_CLEANUP = /\b(clearInterval|clearTimeout)\s*\(/;
const LISTENER = /\.addEventListener\s*\(/g;
const LISTENER_CLEANUP = /\.removeEventListener\s*\(/;
const ABORT = /\b(?:AbortController|AbortSignal|signal\s*:|\.abort\s*\()/g;
// Retry vocabulary commonly appears as camelCase symbols (retryRequest/retryFetch),
// not only as standalone prose. Keep the trailing word boundary so unrelated words
// such as "retrystyle" do not become release findings while still recognizing the
// executable retry helpers that matter for boundedness review.
const RETRY = /\b(?:retry(?:[A-Z_]\w*)?|retries|backoff|attempts?|maxAttempts)\b/gi;
const BOUNDED_RETRY = /\b(?:maxRetries|maxAttempts|retryLimit|attemptLimit|Math\.min|backoff|maxDelay|deadline|timeout)\b/i;
const STORAGE = /\b(?:localStorage|sessionStorage)\b/g;
const PROMISE_CONSTRUCTOR = /new\s+Promise\s*\(/g;
const EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;

function runtimeFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file =>
    RUNTIME_PATH.test(file.repositoryPath) &&
    !TEST_PATH.test(file.repositoryPath) &&
    ['javascript', 'typescript'].includes(file.kind),
  );
}

function signalsFor(file: SourceFile): RuntimeResilienceSignal[] {
  const result: RuntimeResilienceSignal[] = [];
  const index = createLineIndex(file.text);
  const rules: readonly [RuntimeResilienceSignal['kind'], RegExp][] = [
    ['timer', TIMER], ['listener', LISTENER], ['abort', ABORT], ['retry', RETRY],
    ['storage', STORAGE], ['promise', PROMISE_CONSTRUCTOR],
  ];
  for (const [kind, pattern] of rules) {
    const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let match: RegExpExecArray | null;
    let emitted = 0;
    while ((match = matcher.exec(file.text)) !== null) {
      result.push({ file: file.repositoryPath, line: index.lineAt(match.index), kind, excerpt: snippetAround(file.text, match.index, 100) });
      emitted += 1;
      if (emitted >= 12) break;
      if (match[0].length === 0) matcher.lastIndex += 1;
    }
  }
  return result;
}

function firstLocation(file: SourceFile, pattern: RegExp): { file: string; line: number } {
  const matcher = new RegExp(pattern.source, pattern.flags.replace('g', ''));
  const match = matcher.exec(file.text);
  return { file: file.repositoryPath, line: createLineIndex(file.text).lineAt(match?.index ?? 0) };
}

function lifecycleFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  TIMER.lastIndex = 0;
  if (TIMER.test(file.text) && !TIMER_CLEANUP.test(file.text) && /(?:Component|Runtime|Manager|Provider|useEffect|mount|start)/i.test(file.text)) {
    findings.push({
      id: 'runtime-timer-without-cleanup', domain: 'observability', severity: 'medium',
      title: 'Runtime timer has no visible cleanup contract',
      message: 'Long-lived timers without explicit teardown can survive component/runtime ownership and amplify work after navigation.',
      location: firstLocation(file, TIMER),
      remediation: 'Return or register deterministic clearTimeout/clearInterval cleanup with the owning lifecycle.',
      tags: ['lifecycle', 'memory', 'timer'],
    });
  }
  LISTENER.lastIndex = 0;
  if (LISTENER.test(file.text) && !LISTENER_CLEANUP.test(file.text) && /(?:Component|Runtime|Manager|Provider|useEffect|mount|start)/i.test(file.text)) {
    findings.push({
      id: 'runtime-listener-without-cleanup', domain: 'observability', severity: 'medium',
      title: 'Event listener has no visible removal contract',
      message: 'Long-lived listeners should have deterministic ownership and teardown to avoid duplicate handlers and retained state.',
      location: firstLocation(file, LISTENER),
      remediation: 'Pair listener registration with removeEventListener or an equivalent disposable owner.',
      tags: ['lifecycle', 'memory', 'listener'],
    });
  }
  return findings;
}

function retryFindings(file: SourceFile): Finding[] {
  RETRY.lastIndex = 0;
  if (!RETRY.test(file.text) || BOUNDED_RETRY.test(file.text)) return [];
  if (!/(?:fetch|request|query|load|execute|network|service|transport)/i.test(file.text)) return [];
  return [{
    id: 'runtime-retry-without-bound', domain: 'performance', severity: 'high',
    title: 'Retry-oriented runtime code lacks an obvious bound',
    message: 'Network/runtime retry behavior without a visible attempt, deadline or delay ceiling can create retry storms and resource exhaustion.',
    location: firstLocation(file, RETRY),
    remediation: 'Use bounded attempts, capped backoff, cancellation and a hard deadline; expose exhaustion as a terminal outcome.',
    tags: ['retry', 'network', 'boundedness'],
  }];
}

function swallowedFailureFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  const matcher = new RegExp(EMPTY_CATCH.source, 'g');
  const index = createLineIndex(file.text);
  let match: RegExpExecArray | null;
  let emitted = 0;
  while ((match = matcher.exec(file.text)) !== null) {
    findings.push({
      id: 'runtime-empty-catch', domain: 'observability', severity: 'medium',
      title: 'Runtime failure is silently swallowed',
      message: 'An empty catch block removes failure evidence and can leave lifecycle or user-visible state inconsistent.',
      location: { file: file.repositoryPath, line: index.lineAt(match.index) },
      evidence: { excerpt: snippetAround(file.text, match.index, 100) },
      remediation: 'Handle the expected failure explicitly, preserve cancellation semantics, and report unexpected failures through bounded diagnostics.',
      tags: ['errors', 'diagnostics'],
    });
    emitted += 1;
    if (emitted >= 6) break;
  }
  return findings;
}

function storageFindings(file: SourceFile): Finding[] {
  STORAGE.lastIndex = 0;
  if (!STORAGE.test(file.text)) return [];
  if (!/(?:token|secret|credential|authorization|bearer|password|jwt)/i.test(file.text)) return [];
  return [{
    id: 'runtime-sensitive-web-storage', domain: 'security', severity: 'critical', blocking: true,
    title: 'Sensitive credential material may use browser Web Storage',
    message: 'Persistent or session Web Storage is script-readable and must not be used for bearer credentials or secrets.',
    location: firstLocation(file, STORAGE),
    remediation: 'Keep credentials server-side or use an approved HttpOnly/SameSite cookie/session design with CSRF controls.',
    tags: ['credentials', 'storage', 'xss'],
  }];
}

export function auditRuntimeResilience(inventory: RepositoryInventory): AuditSection<RuntimeResilienceSummary> {
  const start = performance.now();
  const files = runtimeFiles(inventory);
  const signals = files.flatMap(signalsFor);
  const findings = stableSortFindings(files.flatMap(file => [
    ...lifecycleFindings(file), ...retryFindings(file), ...swallowedFailureFindings(file), ...storageFindings(file),
  ]));
  const has = (file: SourceFile, pattern: RegExp): boolean => { pattern.lastIndex = 0; return pattern.test(file.text); };
  return {
    domain: 'observability',
    title: 'Runtime resilience and lifecycle audit',
    summary: {
      signals,
      timerFiles: files.filter(file => has(file, TIMER)).length,
      listenerFiles: files.filter(file => has(file, LISTENER)).length,
      abortAwareFiles: files.filter(file => has(file, ABORT)).length,
      retryFiles: files.filter(file => has(file, RETRY)).length,
      storageFiles: files.filter(file => has(file, STORAGE)).length,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - start),
  };
}
