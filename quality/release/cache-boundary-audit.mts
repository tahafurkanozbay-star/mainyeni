import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  expressionSources,
  hasExpression,
  hasUntrustedExpression,
  jobHasSecrets,
  jobHasWriteAuthority,
  workflowFiles,
  workflowJobBlocks,
  workflowTriggerProfile,
  type WorkflowJobBlock,
} from './workflow-structure.mts';
import {
  firstWorkflowStepField,
  stepDisplayName,
  stepNestedMapping,
  stepUsesIdentity,
  workflowStepBlocks,
  type WorkflowStepBlock,
  type WorkflowUsesIdentity,
} from './workflow-step-structure.mts';

export type CacheOperationKind = 'combined' | 'restore' | 'save' | 'setup';

export interface CacheOperationSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly line: number;
  readonly action: string;
  readonly kind: CacheOperationKind;
  readonly immutable: boolean;
  readonly key: string;
  readonly restoreKeys: string;
  readonly path: string;
  readonly cacheMode: string;
  readonly dependencyPath: string;
  readonly externalContribution: boolean;
  readonly privilegedExternalTrigger: boolean;
  readonly writeAuthority: boolean;
  readonly secrets: boolean;
  readonly saveCapable: boolean;
}

export interface CacheBoundarySummary {
  readonly workflowFiles: number;
  readonly cacheOperations: number;
  readonly restoreOperations: number;
  readonly saveOperations: number;
  readonly setupCacheOperations: number;
  readonly externalCacheOperations: number;
  readonly privilegedCacheOperations: number;
  readonly signals: readonly CacheOperationSignal[];
  readonly findings: readonly Finding[];
}

const CACHE_IDENTITY = /^actions\/cache(?:\/(?:restore|save))?@/i;
const SETUP_CACHE_IDENTITY = /^actions\/setup-(?:node|python|java|dotnet|go)@/i;
const EXECUTABLE_PATH = /(?:^|[\/\\])(?:node_modules\/\.bin|\.bin|bin|scripts?|tools?|vendor|plugins?|\.cargo\/bin|\.local\/bin)(?:[\/\\]|$)/i;
const BROAD_PATH_VALUE = /^(?:\.|\.\/|~|\$\{\{\s*github\.workspace\s*\}\}|\$HOME|\$\{HOME\}|%USERPROFILE%)\/?$/i;
const BROAD_PATH_LINE = /^\s*(?:path|cache-dependency-path)\s*:\s*["']?(?:\.|\.\/|~|\$\{\{\s*github\.workspace\s*\}\}|\$HOME|\$\{HOME\}|%USERPROFILE%)["']?\s*(?:#.*)?$/im;
const PRIVILEGED_EXTERNAL_EVENT = /^(?:pull_request_target|issue_comment|issues|pull_request_review|discussion|discussion_comment)$/i;
const INDIRECT_PROVENANCE = /\$\{\{[\s\S]*?(?:needs\.|matrix\.|vars\.)/i;

function operationKind(identity: WorkflowUsesIdentity): CacheOperationKind | undefined {
  const raw = identity.raw.toLowerCase();
  if (/^actions\/cache\/restore@/.test(raw)) return 'restore';
  if (/^actions\/cache\/save@/.test(raw)) return 'save';
  if (/^actions\/cache@/.test(raw)) return 'combined';
  if (SETUP_CACHE_IDENTITY.test(raw)) return 'setup';
  return undefined;
}

function triggerNames(block: WorkflowJobBlock): string[] {
  const profile = workflowTriggerProfile(block.file);
  const result: string[] = [];
  if (profile.pullRequestTarget) result.push('pull_request_target');
  if (profile.issueComment) result.push('issue_comment');
  if (profile.issues) result.push('issues');
  if (profile.pullRequestReview) result.push('pull_request_review');
  if (profile.discussion) result.push('discussion');
  return result;
}

function privilegedExternal(block: WorkflowJobBlock): boolean {
  return triggerNames(block).some(name => PRIVILEGED_EXTERNAL_EVENT.test(name));
}

function mappingValue(step: WorkflowStepBlock, key: string): string {
  return stepNestedMapping(step, 'with').get(key)?.trim() ?? '';
}

function cachePath(step: WorkflowStepBlock, kind: CacheOperationKind): string {
  return kind === 'setup'
    ? mappingValue(step, 'cache-dependency-path')
    : mappingValue(step, 'path');
}

function setupCacheMode(step: WorkflowStepBlock): string {
  return mappingValue(step, 'cache');
}

function isCacheOperation(step: WorkflowStepBlock, identity: WorkflowUsesIdentity, kind: CacheOperationKind): boolean {
  if (kind !== 'setup') return CACHE_IDENTITY.test(identity.raw);
  return setupCacheMode(step).length > 0;
}

function signalFor(block: WorkflowJobBlock, step: WorkflowStepBlock): CacheOperationSignal | undefined {
  const identity = stepUsesIdentity(step);
  if (!identity) return undefined;
  const kind = operationKind(identity);
  if (!kind || !isCacheOperation(step, identity, kind)) return undefined;
  const profile = workflowTriggerProfile(block.file);
  const key = kind === 'setup' ? '' : mappingValue(step, 'key');
  const restoreKeys = kind === 'setup' ? '' : mappingValue(step, 'restore-keys');
  const path = cachePath(step, kind);
  const cacheMode = kind === 'setup' ? setupCacheMode(step) : '';
  const dependencyPath = kind === 'setup' ? mappingValue(step, 'cache-dependency-path') : '';
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    line: firstWorkflowStepField(step, 'uses')?.line ?? step.startLine,
    action: identity.raw,
    kind,
    immutable: identity.immutable,
    key,
    restoreKeys,
    path,
    cacheMode,
    dependencyPath,
    externalContribution: profile.externalContribution,
    privilegedExternalTrigger: privilegedExternal(block),
    writeAuthority: jobHasWriteAuthority(block),
    secrets: jobHasSecrets(block),
    saveCapable: kind === 'combined' || kind === 'save' || kind === 'setup',
  };
}

function operationSignals(inventory: RepositoryInventory): CacheOperationSignal[] {
  return workflowFiles(inventory).flatMap(file =>
    workflowJobBlocks(file).flatMap(block =>
      workflowStepBlocks(block)
        .map(step => signalFor(block, step))
        .filter((signal): signal is CacheOperationSignal => signal !== undefined),
    ),
  );
}

function location(signal: CacheOperationSignal) {
  return { file: signal.file, line: signal.line };
}

function finding(
  signal: CacheOperationSignal,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  blocking = false,
): Finding {
  return {
    id,
    domain: 'security',
    severity,
    title,
    message,
    location: location(signal),
    evidence: {
      value: signal.action,
      metadata: {
        job: signal.job,
        step: signal.step,
        kind: signal.kind,
      },
    },
    remediation,
    ...(blocking ? { blocking: true } : {}),
    tags: ['ci-cd', 'cache', 'supply-chain', 'trust-boundary'],
  };
}

function mutableActionFinding(signal: CacheOperationSignal): Finding | undefined {
  if (signal.immutable) return undefined;
  const critical = signal.privilegedExternalTrigger || signal.writeAuthority || signal.secrets;
  return finding(
    signal,
    'ci-cache-mutable-action',
    critical ? 'critical' : 'high',
    'Cache-capable action is not immutable-SHA pinned',
    `Job ${signal.job} invokes ${signal.action} through a mutable action reference while the action can restore or persist dependency state.`,
    'Pin cache and setup actions to a reviewed full 40-character commit SHA before allowing them to participate in release validation.',
    critical,
  );
}

function keyFindings(signal: CacheOperationSignal): Finding[] {
  if (signal.kind === 'setup') return [];
  if (!signal.key) {
    return [finding(
      signal,
      'ci-cache-key-missing',
      'high',
      'Cache operation has no explicit key',
      `Job ${signal.job} uses ${signal.action} without an explicit cache key, so cache identity cannot be reviewed deterministically.`,
      'Set an explicit key derived from reviewed platform facts, immutable repository state, and dependency-manifest hashes.',
    )];
  }
  if (hasUntrustedExpression(signal.key)) {
    const critical = signal.privilegedExternalTrigger || signal.writeAuthority || signal.secrets;
    return [finding(
      signal,
      'ci-cache-key-untrusted-input',
      critical ? 'critical' : 'high',
      'Cache key contains attacker- or caller-controlled input',
      `Cache key ${signal.key} is derived from ${expressionSources(signal.key).join(', ') || 'untrusted expression data'} and can split or steer persisted cache namespaces.`,
      'Use lockfile/content hashes, literal toolchain versions, runner facts, and immutable commit identity. Do not use event text, head refs, or free-form inputs as cache namespace authority.',
      critical,
    )];
  }
  if (INDIRECT_PROVENANCE.test(signal.key)) {
    return [finding(
      signal,
      'ci-cache-key-indirect-provenance',
      signal.writeAuthority || signal.secrets ? 'high' : 'medium',
      'Cache key depends on indirect workflow provenance',
      `Cache key ${signal.key} depends on matrix, vars, or upstream job output. The producer must remain a closed, reviewed value domain to avoid cache namespace steering.`,
      'Prefer literal/versioned values and content hashes. If upstream outputs are required, validate them against a closed allowlist before cache use.',
    )];
  }
  return [];
}

function restorePrefixFinding(signal: CacheOperationSignal): Finding | undefined {
  if (!signal.restoreKeys) return undefined;
  const sensitive = signal.privilegedExternalTrigger || signal.writeAuthority || signal.secrets;
  if (!signal.externalContribution && !sensitive) return undefined;
  return finding(
    signal,
    'ci-cache-privileged-prefix-restore',
    sensitive ? 'high' : 'medium',
    'Cache restore uses a broad fallback prefix across a trust boundary',
    `Job ${signal.job} accepts restore prefix ${signal.restoreKeys}; fallback matching can select older or broader cache objects than the exact reviewed dependency state.`,
    'Use exact keys for privileged jobs. Keep broad fallback restoration inside unprivileged build jobs and never execute restored cache content as trusted release evidence.',
  );
}

function pathFindings(signal: CacheOperationSignal): Finding[] {
  const findings: Finding[] = [];
  const path = signal.path;
  if (signal.kind !== 'setup' && !path) {
    findings.push(finding(
      signal,
      'ci-cache-path-missing',
      'medium',
      'Cache path is not explicit',
      `Job ${signal.job} does not expose a reviewable cache path.`,
      'Declare a narrow package-manager download cache or other non-executable dependency-data directory explicitly.',
    ));
    return findings;
  }
  if (!path) return findings;
  if (BROAD_PATH_VALUE.test(path) || BROAD_PATH_LINE.test(path)) {
    findings.push(finding(
      signal,
      'ci-cache-broad-workspace-path',
      'critical',
      'Cache includes workspace or home root',
      `Cache path ${path} is broad enough to persist source, generated scripts, credentials, or executable state across runs.`,
      'Cache only narrow dependency download stores. Never cache the repository workspace, home root, or a parent of executable build output.',
      true,
    ));
  }
  if (EXECUTABLE_PATH.test(path)) {
    const critical = signal.writeAuthority || signal.secrets || signal.privilegedExternalTrigger;
    findings.push(finding(
      signal,
      'ci-cache-executable-path',
      critical ? 'critical' : 'high',
      'Cache includes executable or tooling path',
      `Cache path ${path} can restore executable content that later workflow steps may trust or execute.`,
      'Recreate executable tooling from immutable packages/lockfiles instead of restoring executable directories across trust boundaries.',
      critical,
    ));
  }
  return findings;
}

function setupDependencyPathFinding(signal: CacheOperationSignal): Finding | undefined {
  if (signal.kind !== 'setup' || !signal.dependencyPath) return undefined;
  if (hasUntrustedExpression(signal.dependencyPath)) {
    const critical = signal.privilegedExternalTrigger || signal.writeAuthority || signal.secrets;
    return finding(
      signal,
      'ci-cache-setup-dependency-path-untrusted',
      critical ? 'critical' : 'high',
      'Setup-action cache dependency path is selected from untrusted data',
      `Job ${signal.job} lets ${expressionSources(signal.dependencyPath).join(', ') || 'dynamic input'} choose the manifest used to derive setup-action cache identity.`,
      'Use a repository-owned literal dependency manifest path. Do not let event payloads, refs, or free-form inputs select the cache dependency file.',
      critical,
    );
  }
  if (hasExpression(signal.dependencyPath) && INDIRECT_PROVENANCE.test(signal.dependencyPath)) {
    return finding(
      signal,
      'ci-cache-setup-dependency-path-indirect',
      signal.writeAuthority || signal.secrets ? 'high' : 'medium',
      'Setup-action cache dependency path uses indirect provenance',
      `Job ${signal.job} derives cache-dependency-path from matrix, vars, or upstream output, widening the set of manifests that can control cache identity.`,
      'Use a literal allowlisted dependency manifest path or validate the indirect value against a closed set before the setup action.',
    );
  }
  return undefined;
}

function externalSaveFindings(signal: CacheOperationSignal): Finding[] {
  if (!signal.saveCapable || !signal.externalContribution) return [];
  const findings: Finding[] = [];
  const privileged = signal.privilegedExternalTrigger || signal.writeAuthority || signal.secrets;
  if (privileged) {
    findings.push(finding(
      signal,
      'ci-cache-untrusted-privileged-boundary',
      'critical',
      'Externally influenced privileged job can persist cache state',
      `Job ${signal.job} combines an externally influenced trigger with cache save capability and ${signal.writeAuthority ? 'write authority' : signal.secrets ? 'secret context' : 'a privileged event model'}.`,
      'Separate untrusted validation from privileged release workflows. Use restore-only isolated caches for contribution checks and populate trusted caches only from protected refs.',
      true,
    ));
  } else {
    findings.push(finding(
      signal,
      'ci-cache-external-save-review',
      'medium',
      'Contribution-triggered job can save cache state',
      `Job ${signal.job} can persist cache state from an external contribution context. GitHub cache scoping reduces exposure but cache provenance should remain explicit.`,
      'Prefer restore-only or trust-domain-separated cache namespaces for external contributions, especially for executable build inputs.',
    ));
  }
  if (signal.kind === 'setup' && signal.privilegedExternalTrigger) {
    findings.push(finding(
      signal,
      'ci-cache-setup-privileged-trigger',
      'critical',
      'Privileged external trigger enables built-in setup-action caching',
      `Job ${signal.job} enables ${signal.cacheMode || 'dependency'} caching through ${signal.action} on a privileged external trigger. The setup action owns restore/save behavior implicitly.`,
      'Disable built-in setup-action caching on pull_request_target/comment/review style privileged workflows or move caching to an isolated trusted build workflow.',
      true,
    ));
  }
  return findings;
}

function findingsFor(signal: CacheOperationSignal): Finding[] {
  const findings: Array<Finding | undefined> = [
    mutableActionFinding(signal),
    ...keyFindings(signal),
    restorePrefixFinding(signal),
    ...pathFindings(signal),
    setupDependencyPathFinding(signal),
    ...externalSaveFindings(signal),
  ];
  return findings.filter((item): item is Finding => item !== undefined);
}

export function auditCacheBoundaries(inventory: RepositoryInventory): AuditSection<CacheBoundarySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const signals = operationSignals(inventory);
  const findings = stableSortFindings(signals.flatMap(findingsFor));
  return {
    domain: 'security',
    title: 'Workflow cache trust-boundary audit',
    summary: {
      workflowFiles: files.length,
      cacheOperations: signals.length,
      restoreOperations: signals.filter(signal => signal.kind === 'restore').length,
      saveOperations: signals.filter(signal => signal.saveCapable).length,
      setupCacheOperations: signals.filter(signal => signal.kind === 'setup').length,
      externalCacheOperations: signals.filter(signal => signal.externalContribution).length,
      privilegedCacheOperations: signals.filter(signal => signal.writeAuthority || signal.secrets || signal.privilegedExternalTrigger).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
