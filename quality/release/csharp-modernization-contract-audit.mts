import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { createLineIndex, snippetAround } from './inventory.mts';

export interface CSharpModernizationSignal {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly excerpt: string;
}

export interface CSharpCompilerContract {
  readonly targetFramework: string | null;
  readonly languageVersion: string | null;
  readonly nullable: string | null;
  readonly analyzers: boolean | null;
  readonly analysisLevel: string | null;
  readonly deterministic: boolean | null;
  readonly restoreAuditMode: string | null;
  readonly restoreAuditLevel: string | null;
}

export interface CSharpModernizationSummary {
  readonly files: number;
  readonly signals: readonly CSharpModernizationSignal[];
  readonly compiler: CSharpCompilerContract;
  readonly syncOverAsync: number;
  readonly asyncVoid: number;
  readonly directHttpClient: number;
  readonly blockingSleep: number;
  readonly forcedGc: number;
  readonly throwEx: number;
  readonly emptyCatch: number;
  readonly findings: readonly Finding[];
}

interface PatternRule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly severity: Finding['severity'];
  readonly title: string;
  readonly message: string;
  readonly remediation: string;
  readonly tags: readonly string[];
  readonly blocking?: boolean;
}

const TEST_OR_GENERATED = /(?:^|\/)(?:tests?|bin|obj|generated|migrations)(?:\/|$)|\.Designer\.cs$/i;
const PRODUCTION_CS = /\.cs$/i;
const EVENT_HANDLER = /\basync\s+void\s+[A-Za-z_$][\w$]*\s*\([^)]*(?:EventArgs|RoutedEventArgs|EventHandler)[^)]*\)/i;
const ASYNC_VOID = /\basync\s+void\s+[A-Za-z_$][\w$]*\s*\(/g;
const SYNC_RESULT = /(?:\.Result\b(?!\s*=(?!=))|\.Wait\s*\(\s*\))/g;
const GET_RESULT = /\.GetAwaiter\s*\(\s*\)\s*\.GetResult\s*\(\s*\)/g;
const DIRECT_HTTP = /\bnew\s+HttpClient\s*\(/g;
const THREAD_SLEEP = /\bThread\.Sleep\s*\(/g;
const GC_COLLECT = /\bGC\.Collect\s*\(/g;
const THROW_EX = /\bthrow\s+[A-Za-z_$][\w$]*\s*;/g;
const EMPTY_CATCH = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g;
const LOCK_THIS = /\block\s*\(\s*this\s*\)/g;
const TASK_RUN_REQUEST = /\bTask\.Run\s*\(/g;
const CONTROLLER_OR_SERVICE = /(?:Controller|Service|Business|Repository|Manager)\.cs$/i;

const RULES: readonly PatternRule[] = [
  {
    id: 'csharp-sync-over-async',
    pattern: SYNC_RESULT,
    severity: 'high',
    title: 'Synchronous wait on asynchronous work',
    message: 'Blocking on Task.Result/Wait can consume request threads, hide cancellation and create deadlock-prone ownership patterns.',
    remediation: 'Make the call chain async end-to-end and await the task while propagating CancellationToken where applicable.',
    tags: ['csharp', 'async', 'performance'],
  },
  {
    id: 'csharp-getawaiter-getresult',
    pattern: GET_RESULT,
    severity: 'high',
    title: 'GetAwaiter().GetResult() blocks asynchronous work',
    message: 'Synchronous completion of async work bypasses normal cancellation/backpressure and can exhaust server request capacity.',
    remediation: 'Await the operation from an async caller instead of synchronously extracting the result.',
    tags: ['csharp', 'async', 'performance'],
  },
  {
    id: 'csharp-direct-httpclient',
    pattern: DIRECT_HTTP,
    severity: 'medium',
    title: 'Direct HttpClient construction bypasses managed transport lifetime',
    message: 'Creating HttpClient ad hoc can fragment connection pools and bypass centralized timeout, handler and resilience configuration.',
    remediation: 'Use IHttpClientFactory/typed clients with bounded timeout, cancellation and handler lifetime policy.',
    tags: ['csharp', 'network', 'httpclient'],
  },
  {
    id: 'csharp-thread-sleep',
    pattern: THREAD_SLEEP,
    severity: 'high',
    title: 'Thread.Sleep blocks server worker capacity',
    message: 'Blocking a worker thread delays unrelated requests and ignores cancellation.',
    remediation: 'Use await Task.Delay(delay, cancellationToken) or a timer/scheduler owned by a bounded background service.',
    tags: ['csharp', 'performance', 'async'],
  },
  {
    id: 'csharp-forced-gc',
    pattern: GC_COLLECT,
    severity: 'high',
    title: 'Application code forces a full garbage collection',
    message: 'GC.Collect introduces stop-the-world latency and usually indicates an ownership/allocation problem that should be fixed at the source.',
    remediation: 'Remove forced collection and use disposal, pooling, bounded caches and allocation profiling to address memory pressure.',
    tags: ['csharp', 'performance', 'memory'],
    blocking: true,
  },
  {
    id: 'csharp-throw-variable',
    pattern: THROW_EX,
    severity: 'medium',
    title: 'Exception is rethrown through a variable',
    message: 'throw ex-style rethrow resets stack provenance and makes production diagnostics less actionable.',
    remediation: 'Use bare throw; inside the original catch block, or wrap with an intentional domain exception while preserving the inner exception.',
    tags: ['csharp', 'observability', 'exceptions'],
  },
  {
    id: 'csharp-empty-catch',
    pattern: EMPTY_CATCH,
    severity: 'high',
    title: 'Exception is silently swallowed',
    message: 'An empty catch block removes failure evidence and can leave request/data state inconsistent.',
    remediation: 'Handle the expected exception explicitly, preserve cancellation, and emit bounded structured diagnostics for unexpected failures.',
    tags: ['csharp', 'observability', 'exceptions'],
  },
  {
    id: 'csharp-lock-this',
    pattern: LOCK_THIS,
    severity: 'medium',
    title: 'lock(this) exposes synchronization authority',
    message: 'External code can acquire the same object monitor, causing hidden contention or deadlocks.',
    remediation: 'Use a private readonly lock object or an async-compatible coordination primitive with explicit ownership.',
    tags: ['csharp', 'concurrency'],
  },
];

function productionFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => PRODUCTION_CS.test(file.repositoryPath) && !TEST_OR_GENERATED.test(file.repositoryPath));
}

function signalsFor(file: SourceFile): CSharpModernizationSignal[] {
  const result: CSharpModernizationSignal[] = [];
  const index = createLineIndex(file.text);
  for (const rule of RULES) {
    const matcher = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');
    let match: RegExpExecArray | null;
    let emitted = 0;
    while ((match = matcher.exec(file.text)) !== null) {
      // Task.Result is a read-only property. A writable '.Result = ...'
      // target is MVC/action metadata, not a synchronous Task wait.
      // Keep every actual Task.Result read and Task.Wait() reportable.
      if (rule.id === 'csharp-sync-over-async'
        && match[0] === '.Result'
        && /^\s*=(?!=|>)/u.test(file.text.slice(match.index + match[0].length))) continue;
      if (rule.id === 'csharp-throw-variable' && /\bthrow\s+new\b/.test(match[0])) continue;
      result.push({
        file: file.repositoryPath,
        line: index.lineAt(match.index),
        rule: rule.id,
        excerpt: snippetAround(file.text, match.index, 120),
      });
      emitted += 1;
      if (emitted >= 8) break;
      if (match[0].length === 0) matcher.lastIndex += 1;
    }
  }

  const asyncMatcher = new RegExp(ASYNC_VOID.source, ASYNC_VOID.flags);
  let asyncMatch: RegExpExecArray | null;
  let asyncCount = 0;
  while ((asyncMatch = asyncMatcher.exec(file.text)) !== null) {
    const excerpt = snippetAround(file.text, asyncMatch.index, 220);
    if (EVENT_HANDLER.test(excerpt)) continue;
    result.push({ file: file.repositoryPath, line: index.lineAt(asyncMatch.index), rule: 'csharp-async-void', excerpt });
    asyncCount += 1;
    if (asyncCount >= 8) break;
  }

  if (CONTROLLER_OR_SERVICE.test(file.repositoryPath)) {
    const taskMatcher = new RegExp(TASK_RUN_REQUEST.source, TASK_RUN_REQUEST.flags);
    let taskMatch: RegExpExecArray | null;
    let taskCount = 0;
    while ((taskMatch = taskMatcher.exec(file.text)) !== null) {
      result.push({
        file: file.repositoryPath,
        line: index.lineAt(taskMatch.index),
        rule: 'csharp-task-run-request-path',
        excerpt: snippetAround(file.text, taskMatch.index, 120),
      });
      taskCount += 1;
      if (taskCount >= 6) break;
    }
  }
  return result;
}

function xmlValue(text: string, tag: string): string | null {
  const match = text.match(new RegExp('<' + tag + '[^>]*>([^<]+)</' + tag + '>', 'i'));
  return match?.[1]?.trim() ?? null;
}

function boolValue(value: string | null): boolean | null {
  if (value === null) return null;
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  return null;
}

function compilerContract(inventory: RepositoryInventory): CSharpCompilerContract {
  const props = inventory.files.find(file => file.repositoryPath === 'Directory.Build.props');
  const text = props?.text ?? '';
  return {
    targetFramework: xmlValue(text, 'TargetFramework'),
    languageVersion: xmlValue(text, 'LangVersion'),
    nullable: xmlValue(text, 'Nullable'),
    analyzers: boolValue(xmlValue(text, 'EnableNETAnalyzers')),
    analysisLevel: xmlValue(text, 'AnalysisLevel'),
    deterministic: boolValue(xmlValue(text, 'Deterministic')),
    restoreAuditMode: xmlValue(text, 'RestoreAuditMode'),
    restoreAuditLevel: xmlValue(text, 'RestoreAuditLevel'),
  };
}

function compilerFindings(contract: CSharpCompilerContract): Finding[] {
  const findings: Finding[] = [];
  const at = { file: 'Directory.Build.props', line: 1 };
  if (contract.targetFramework !== 'net10.0') findings.push({
    id: 'csharp-target-framework-modernization', domain: 'architecture', severity: 'high',
    title: 'Backend target framework is outside the net10.0 baseline',
    message: 'The repository backend modernization contract requires the stable .NET 10 target.',
    location: at, evidence: { value: contract.targetFramework },
    remediation: 'Move projects to net10.0 only after dependency/API compatibility is verified and keep restore/build/test/publish green.',
    tags: ['csharp', 'dotnet', 'runtime'], blocking: true,
  });
  const languageMajor = Number(contract.languageVersion?.split('.', 1)[0]);
  if (!Number.isFinite(languageMajor) || languageMajor < 14) findings.push({
    id: 'csharp-language-version-modernization', domain: 'architecture', severity: 'medium',
    title: 'C# language baseline is below C# 14',
    message: 'The solution should use the stable language level paired with .NET 10 while avoiding preview-only syntax.',
    location: at, evidence: { value: contract.languageVersion },
    remediation: 'Set LangVersion to 14.0 and keep allowPrerelease=false in global.json.',
    tags: ['csharp', 'language-modernization'],
  });
  if (!contract.nullable || /^disable$/i.test(contract.nullable)) findings.push({
    id: 'csharp-nullable-contract-missing', domain: 'architecture', severity: 'high',
    title: 'Nullable reference analysis is disabled',
    message: 'Nullability must be compiler-visible so API/data contracts do not rely on runtime NullReferenceException discovery.',
    location: at, evidence: { value: contract.nullable },
    remediation: 'Enable nullable annotations/warnings incrementally and repair diagnostics at contract boundaries.',
    tags: ['csharp', 'nullability'],
  });
  if (contract.analyzers !== true) findings.push({
    id: 'csharp-analyzers-disabled', domain: 'build', severity: 'high',
    title: '.NET analyzers are not enabled',
    message: 'Compiler analyzers are required to catch correctness, performance and API-usage regressions during modernization.',
    location: at, remediation: 'Set EnableNETAnalyzers=true and keep AnalysisLevel on latest stable.',
    tags: ['csharp', 'analyzers'], blocking: true,
  });
  if (contract.deterministic !== true) findings.push({
    id: 'csharp-deterministic-build-disabled', domain: 'build', severity: 'medium',
    title: 'Deterministic .NET builds are not enabled',
    message: 'Non-deterministic build output weakens release provenance and reproducibility.',
    location: at, remediation: 'Set Deterministic=true and keep CI builds reproducible.',
    tags: ['csharp', 'build', 'provenance'],
  });
  if (contract.restoreAuditMode?.toLowerCase() !== 'all') findings.push({
    id: 'csharp-restore-audit-incomplete', domain: 'dependencies', severity: 'medium',
    title: 'NuGet restore audit is not scanning the full graph',
    message: 'Restore auditing should include transitive dependencies, not only direct packages.',
    location: at, evidence: { value: contract.restoreAuditMode },
    remediation: 'Set RestoreAuditMode=all and retain vulnerability reporting in CI.',
    tags: ['csharp', 'nuget', 'supply-chain'],
  });
  return findings;
}

function signalFinding(signal: CSharpModernizationSignal): Finding {
  if (signal.rule === 'csharp-async-void') return {
    id: signal.rule, domain: 'architecture', severity: 'high',
    title: 'async void method is not an event handler',
    message: 'async void prevents callers from awaiting completion and makes exception/cancellation propagation unreliable.',
    location: { file: signal.file, line: signal.line }, evidence: { excerpt: signal.excerpt },
    remediation: 'Return Task/ValueTask and propagate cancellation; reserve async void only for framework event-handler signatures.',
    tags: ['csharp', 'async', 'reliability'], blocking: true,
  };
  if (signal.rule === 'csharp-task-run-request-path') return {
    id: signal.rule, domain: 'performance', severity: 'medium',
    title: 'Task.Run is used in a request/service path',
    message: 'Wrapping server work in Task.Run consumes another thread-pool work item and usually hides blocking or CPU ownership.',
    location: { file: signal.file, line: signal.line }, evidence: { excerpt: signal.excerpt },
    remediation: 'Await naturally asynchronous I/O. For CPU-bound background work, use a bounded hosted worker/queue with explicit capacity.',
    tags: ['csharp', 'performance', 'threadpool'],
  };
  const rule = RULES.find(item => item.id === signal.rule);
  if (!rule) throw new Error('Unknown C# modernization rule: ' + signal.rule);
  return {
    id: rule.id, domain: rule.id.includes('httpclient') ? 'network' : rule.id.includes('forced-gc') || rule.id.includes('thread-sleep') || rule.id.includes('sync-over') ? 'performance' : 'architecture',
    severity: rule.severity, ...(rule.blocking ? { blocking: true } : {}),
    title: rule.title, message: rule.message,
    location: { file: signal.file, line: signal.line }, evidence: { excerpt: signal.excerpt },
    remediation: rule.remediation, tags: rule.tags,
  };
}

export function auditCSharpModernizationContracts(
  inventory: RepositoryInventory,
): AuditSection<CSharpModernizationSummary> {
  const started = performance.now();
  const files = productionFiles(inventory);
  const signals = files.flatMap(signalsFor);
  const compiler = compilerContract(inventory);
  const findings = stableSortFindings([
    ...signals.map(signalFinding),
    ...compilerFindings(compiler),
  ]);
  const count = (rule: string): number => signals.filter(item => item.rule === rule).length;
  return {
    domain: 'architecture',
    title: '.NET 10 and C# 14 modernization contract audit',
    summary: {
      files: files.length,
      signals,
      compiler,
      syncOverAsync: count('csharp-sync-over-async') + count('csharp-getawaiter-getresult'),
      asyncVoid: count('csharp-async-void'),
      directHttpClient: count('csharp-direct-httpclient'),
      blockingSleep: count('csharp-thread-sleep'),
      forcedGc: count('csharp-forced-gc'),
      throwEx: count('csharp-throw-variable'),
      emptyCatch: count('csharp-empty-catch'),
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
