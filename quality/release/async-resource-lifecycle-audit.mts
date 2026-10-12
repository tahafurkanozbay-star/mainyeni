import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { createLineIndex, snippetAround } from './inventory.mts';

export type ResourceKind =
  | 'observer'
  | 'animation-frame'
  | 'worker'
  | 'broadcast-channel'
  | 'websocket'
  | 'event-source'
  | 'abort-controller'
  | 'event-listener'
  | 'effect';

export interface AsyncResourceSignal {
  readonly file: string;
  readonly line: number;
  readonly kind: ResourceKind;
  readonly constructor: string;
  readonly cleanup: string | null;
  readonly cleanupVisible: boolean;
  readonly lifecycleOwned: boolean;
  readonly excerpt: string;
}

export interface AsyncResourceLifecycleSummary {
  readonly files: number;
  readonly signals: readonly AsyncResourceSignal[];
  readonly observerResources: number;
  readonly schedulerResources: number;
  readonly transportResources: number;
  readonly abortControllers: number;
  readonly anonymousListeners: number;
  readonly asyncEffects: number;
  readonly findings: readonly Finding[];
}

interface ResourceRule {
  readonly kind: ResourceKind;
  readonly constructor: string;
  readonly create: RegExp;
  readonly cleanup: RegExp | null;
  readonly severity: Finding['severity'];
  readonly title: string;
  readonly message: string;
  readonly remediation: string;
  readonly blockingWhenLifecycleOwned?: boolean;
}

const RUNTIME_PATH = /^(?:Webclient\.app|Webclient\.admin)\/src\//i;
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?)(?:\/|$)|\.(?:test|spec|fixture|mock)\.[cm]?[jt]sx?$/i;
const GENERATED_PATH = /(?:^|\/)(?:generated|dist|build|coverage|vendor)(?:\/|$)/i;
const SCRIPT_KIND = new Set(['typescript', 'javascript']);
const LIFECYCLE_OWNER = /\b(?:useEffect|useLayoutEffect|componentDidMount|componentWillUnmount|dispose|destroy|teardown|cleanup|mount|unmount|Runtime|Controller|Manager|Provider|Bridge|Coordinator|Observer)\b/;
const ASYNC_EFFECT = /\buse(?:Layout)?Effect\s*\(\s*async\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)?\s*=>/g;
const ANONYMOUS_LISTENER = /\.addEventListener\s*\(\s*([^,]+),\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)?\s*=>/g;
const REMOVE_LISTENER = /\.removeEventListener\s*\(/;
const SIGNAL_USE = /\b(?:signal\s*:|\.signal\b|AbortSignal\.)/;
const ABORT_CALL = /\.abort\s*\(/;
const EFFECT_CLEANUP = /\breturn\s+(?:\(\s*\)\s*=>|function\b)|=>\s*\{[\s\S]{0,280}\b(?:disconnect|close|terminate|abort|cancelAnimationFrame|removeEventListener)\b/;

const RESOURCE_RULES: readonly ResourceRule[] = [
  {
    kind: 'observer',
    constructor: 'MutationObserver',
    create: /\bnew\s+MutationObserver\s*\(/g,
    cleanup: /\.disconnect\s*\(/,
    severity: 'medium',
    title: 'MutationObserver has no visible disconnect contract',
    message: 'A MutationObserver can retain DOM nodes and continue scheduling callbacks after its owning surface is gone.',
    remediation: 'Own the observer inside a bounded lifecycle and call disconnect() during teardown.',
  },
  {
    kind: 'observer',
    constructor: 'ResizeObserver',
    create: /\bnew\s+ResizeObserver\s*\(/g,
    cleanup: /\.disconnect\s*\(/,
    severity: 'medium',
    title: 'ResizeObserver has no visible disconnect contract',
    message: 'A ResizeObserver without deterministic teardown can retain elements and keep layout work alive after navigation.',
    remediation: 'Disconnect the observer from the same lifecycle that created it.',
  },
  {
    kind: 'observer',
    constructor: 'IntersectionObserver',
    create: /\bnew\s+IntersectionObserver\s*\(/g,
    cleanup: /\.(?:disconnect|unobserve)\s*\(/,
    severity: 'medium',
    title: 'IntersectionObserver has no visible cleanup contract',
    message: 'Intersection observation should stop when the owning component/runtime is disposed.',
    remediation: 'Call disconnect() or unobserve() for every observed target during teardown.',
  },
  {
    kind: 'animation-frame',
    constructor: 'requestAnimationFrame',
    create: /\brequestAnimationFrame\s*\(/g,
    cleanup: /\bcancelAnimationFrame\s*\(/,
    severity: 'medium',
    title: 'Animation frame scheduling has no cancellation contract',
    message: 'Animation-frame loops can keep CPU/GPU work alive after the visual owner is removed.',
    remediation: 'Retain the frame id and cancel it during teardown; bound recursive scheduling to an active lifecycle flag.',
  },
  {
    kind: 'worker',
    constructor: 'Worker',
    create: /\bnew\s+(?:Shared)?Worker\s*\(/g,
    cleanup: /\.terminate\s*\(|\.port\.close\s*\(/,
    severity: 'high',
    title: 'Worker lifetime has no visible termination contract',
    message: 'A Worker or SharedWorker can retain memory, event loops and network capability beyond the page feature that created it.',
    remediation: 'Terminate dedicated workers or close shared worker ports from deterministic lifecycle cleanup.',
    blockingWhenLifecycleOwned: true,
  },
  {
    kind: 'broadcast-channel',
    constructor: 'BroadcastChannel',
    create: /\bnew\s+BroadcastChannel\s*\(/g,
    cleanup: /\.close\s*\(/,
    severity: 'medium',
    title: 'BroadcastChannel has no visible close contract',
    message: 'Open channels retain cross-context listeners and can continue receiving messages after feature teardown.',
    remediation: 'Close the channel during disposal and avoid retaining user payloads in channel owners.',
  },
  {
    kind: 'websocket',
    constructor: 'WebSocket',
    create: /\bnew\s+WebSocket\s*\(/g,
    cleanup: /\.close\s*\(/,
    severity: 'high',
    title: 'WebSocket lifetime has no visible close contract',
    message: 'Long-lived sockets without deterministic teardown can leak connections, callbacks and authentication context.',
    remediation: 'Close sockets on unmount/dispose, clear reconnect timers, and make cancellation terminal.',
    blockingWhenLifecycleOwned: true,
  },
  {
    kind: 'event-source',
    constructor: 'EventSource',
    create: /\bnew\s+EventSource\s*\(/g,
    cleanup: /\.close\s*\(/,
    severity: 'high',
    title: 'EventSource lifetime has no visible close contract',
    message: 'Server-sent event streams can continue consuming connection and callback resources after the owning UI disappears.',
    remediation: 'Close EventSource during deterministic teardown and bound any reconnect behavior.',
    blockingWhenLifecycleOwned: true,
  },
  {
    kind: 'abort-controller',
    constructor: 'AbortController',
    create: /\bnew\s+AbortController\s*\(/g,
    cleanup: /\.abort\s*\(/,
    severity: 'medium',
    title: 'AbortController is created without a visible abort contract',
    message: 'Creating cancellation authority without terminating it on lifecycle teardown can leave asynchronous work running after ownership ends.',
    remediation: 'Pass controller.signal to the owned operation and call abort() when the owner is disposed or superseded.',
  },
];

function runtimeFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file =>
    RUNTIME_PATH.test(file.repositoryPath)
    && !TEST_PATH.test(file.repositoryPath)
    && !GENERATED_PATH.test(file.repositoryPath)
    && SCRIPT_KIND.has(file.kind),
  );
}

function patternVisible(text: string, pattern: RegExp | null): boolean {
  if (!pattern) return false;
  const matcher = new RegExp(pattern.source, pattern.flags.replace('g', ''));
  return matcher.test(text);
}

function resourceSignals(file: SourceFile): AsyncResourceSignal[] {
  const lineIndex = createLineIndex(file.text);
  const lifecycleOwned = LIFECYCLE_OWNER.test(file.text);
  const result: AsyncResourceSignal[] = [];
  for (const rule of RESOURCE_RULES) {
    const matcher = new RegExp(rule.create.source, rule.create.flags.includes('g') ? rule.create.flags : `${rule.create.flags}g`);
    let match: RegExpExecArray | null;
    let emitted = 0;
    const cleanupVisible = patternVisible(file.text, rule.cleanup);
    while ((match = matcher.exec(file.text)) !== null) {
      result.push({
        file: file.repositoryPath,
        line: lineIndex.lineAt(match.index),
        kind: rule.kind,
        constructor: rule.constructor,
        cleanup: rule.cleanup?.source ?? null,
        cleanupVisible,
        lifecycleOwned,
        excerpt: snippetAround(file.text, match.index, 120),
      });
      emitted += 1;
      if (emitted >= 12) break;
      if (match[0].length === 0) matcher.lastIndex += 1;
    }
  }

  const listenerMatcher = new RegExp(ANONYMOUS_LISTENER.source, ANONYMOUS_LISTENER.flags);
  let listener: RegExpExecArray | null;
  let listenerCount = 0;
  while ((listener = listenerMatcher.exec(file.text)) !== null) {
    result.push({
      file: file.repositoryPath,
      line: lineIndex.lineAt(listener.index),
      kind: 'event-listener',
      constructor: 'addEventListener',
      cleanup: 'removeEventListener',
      cleanupVisible: REMOVE_LISTENER.test(file.text),
      lifecycleOwned,
      excerpt: snippetAround(file.text, listener.index, 120),
    });
    listenerCount += 1;
    if (listenerCount >= 12) break;
  }

  const effectMatcher = new RegExp(ASYNC_EFFECT.source, ASYNC_EFFECT.flags);
  let effect: RegExpExecArray | null;
  let effectCount = 0;
  while ((effect = effectMatcher.exec(file.text)) !== null) {
    result.push({
      file: file.repositoryPath,
      line: lineIndex.lineAt(effect.index),
      kind: 'effect',
      constructor: 'async useEffect callback',
      cleanup: 'synchronous cleanup function',
      cleanupVisible: EFFECT_CLEANUP.test(file.text),
      lifecycleOwned: true,
      excerpt: snippetAround(file.text, effect.index, 140),
    });
    effectCount += 1;
    if (effectCount >= 8) break;
  }
  return result;
}

function findingForSignal(signal: AsyncResourceSignal): Finding | undefined {
  if (signal.kind === 'event-listener') {
    return {
      id: 'runtime-anonymous-event-listener',
      domain: 'observability',
      severity: signal.lifecycleOwned ? 'medium' : 'low',
      title: 'Anonymous event listener weakens deterministic teardown',
      message: 'Inline listener functions cannot be removed by identity unless an owning abort signal or equivalent disposable contract is used.',
      location: { file: signal.file, line: signal.line },
      evidence: { excerpt: signal.excerpt },
      remediation: 'Use a stable callback reference or addEventListener({ signal }) with an owned AbortController, then abort/remove during teardown.',
      tags: ['lifecycle', 'listener', 'memory'],
    };
  }
  if (signal.kind === 'effect') {
    return {
      id: 'react-async-effect-callback',
      domain: 'architecture',
      severity: 'high',
      title: 'React effect callback is directly async',
      message: 'An async useEffect/useLayoutEffect callback returns a Promise instead of the synchronous cleanup function React expects.',
      location: { file: signal.file, line: signal.line },
      evidence: { excerpt: signal.excerpt },
      remediation: 'Keep the effect callback synchronous, start the async operation inside it, and return deterministic cancellation/cleanup.',
      tags: ['react', 'lifecycle', 'async'],
      blocking: true,
    };
  }
  if (signal.cleanupVisible) return undefined;
  const rule = RESOURCE_RULES.find(item => item.kind === signal.kind && item.constructor === signal.constructor);
  if (!rule) return undefined;
  const blocking = rule.blockingWhenLifecycleOwned === true && signal.lifecycleOwned;
  return {
    id: `runtime-${signal.kind}-without-cleanup`,
    domain: signal.kind === 'websocket' || signal.kind === 'event-source' ? 'network' : 'observability',
    severity: rule.severity,
    ...(blocking ? { blocking: true } : {}),
    title: rule.title,
    message: rule.message,
    location: { file: signal.file, line: signal.line },
    evidence: { excerpt: signal.excerpt },
    remediation: rule.remediation,
    tags: ['lifecycle', 'resource', signal.kind],
  };
}

function controllerContractFindings(file: SourceFile): Finding[] {
  if (!/\bnew\s+AbortController\s*\(/.test(file.text)) return [];
  const findings: Finding[] = [];
  const lineIndex = createLineIndex(file.text);
  const match = /\bnew\s+AbortController\s*\(/.exec(file.text);
  if (!SIGNAL_USE.test(file.text)) {
    findings.push({
      id: 'runtime-abort-controller-signal-unused',
      domain: 'observability',
      severity: 'medium',
      title: 'AbortController signal is not visibly consumed',
      message: 'Cancellation authority is created but no signal use is visible in the same owner, so aborting may not cancel any work.',
      location: { file: file.repositoryPath, line: lineIndex.lineAt(match?.index ?? 0) },
      remediation: 'Pass controller.signal into fetch/SDK/runtime operations or remove the unused controller.',
      tags: ['abort', 'cancellation', 'lifecycle'],
    });
  }
  if (LIFECYCLE_OWNER.test(file.text) && !ABORT_CALL.test(file.text)) {
    findings.push({
      id: 'runtime-abort-controller-not-aborted',
      domain: 'observability',
      severity: 'medium',
      title: 'Lifecycle-owned AbortController is never aborted',
      message: 'The owner exposes lifecycle semantics but the controller is not terminated during teardown or supersession.',
      location: { file: file.repositoryPath, line: lineIndex.lineAt(match?.index ?? 0) },
      remediation: 'Abort the controller from dispose/unmount/supersession and treat AbortError as an expected terminal outcome.',
      tags: ['abort', 'cancellation', 'lifecycle'],
    });
  }
  return findings;
}

export function auditAsyncResourceLifecycle(
  inventory: RepositoryInventory,
): AuditSection<AsyncResourceLifecycleSummary> {
  const started = performance.now();
  const files = runtimeFiles(inventory);
  const signals = files.flatMap(resourceSignals);
  const findings = stableSortFindings([
    ...signals.map(findingForSignal).filter((item): item is Finding => item !== undefined),
    ...files.flatMap(controllerContractFindings),
  ]);

  const schedulerKinds = new Set<ResourceKind>(['animation-frame']);
  const transportKinds = new Set<ResourceKind>(['websocket', 'event-source', 'worker', 'broadcast-channel']);
  return {
    domain: 'observability',
    title: 'Async resource ownership and lifecycle audit',
    summary: {
      files: files.length,
      signals,
      observerResources: signals.filter(item => item.kind === 'observer').length,
      schedulerResources: signals.filter(item => schedulerKinds.has(item.kind)).length,
      transportResources: signals.filter(item => transportKinds.has(item.kind)).length,
      abortControllers: signals.filter(item => item.kind === 'abort-controller').length,
      anonymousListeners: signals.filter(item => item.kind === 'event-listener').length,
      asyncEffects: signals.filter(item => item.kind === 'effect').length,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
