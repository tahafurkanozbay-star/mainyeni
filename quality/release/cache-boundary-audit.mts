import type { AuditSection, Finding, RepositoryInventory, SourceFile } from './contracts.mts';

export interface CacheBoundarySummary {
  readonly workflowFiles: number;
  readonly cacheOperations: number;
  readonly restoreOperations: number;
  readonly saveOperations: number;
  readonly findings: readonly Finding[];
}

interface CacheOperation {
  readonly file: SourceFile;
  readonly action: 'cache' | 'restore' | 'save';
  readonly line: number;
  readonly block: string;
}

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const CACHE_ACTION = /uses\s*:\s*actions\/(cache|cache\/restore|cache\/save)@([^\s#]+)/i;
const IMMUTABLE_SHA = /^[0-9a-f]{40}$/i;
const UNTRUSTED_TRIGGER = /\b(?:pull_request_target|issues|issue_comment|pull_request_review|pull_request_review_comment|discussion|discussion_comment)\s*:/i;
const UNTRUSTED_EXPR = /\$\{\{\s*(?:github\.head_ref|github\.event\.pull_request\.head\.(?:ref|sha)|github\.event\.(?:issue|comment|review|discussion)\.|inputs\.|github\.event\.inputs\.)/i;
const PRIVILEGE = /\b(?:contents|packages|actions|deployments|pages|id-token|security-events)\s*:\s*write\b/i;
const EXECUTABLE_PATH = /(?:^|[\/\\])(?:node_modules\/\.bin|\.bin|bin|scripts?|tools?|vendor|plugins?|\.cargo\/bin|\.local\/bin)(?:[\/\\]|$)/i;
const BROAD_PATH = /(?:^|\n)\s*path\s*:\s*["']?(?:\.|\.\/|\$\{\{\s*github\.workspace\s*\}\}|~)["']?\s*(?:#.*)?$/im;
const RESTORE_KEYS = /(?:^|\n)\s*restore-keys\s*:/im;
const LOOKUP_ONLY_FALSE = /(?:^|\n)\s*lookup-only\s*:\s*(?:false|['"]false['"])/im;

function workflows(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => WORKFLOW_PATH.test(file.repositoryPath));
}

function lineAt(text: string, index: number): number {
  return text.slice(0, Math.max(0, index)).split('\n').length;
}

function stepBlock(text: string, index: number): string {
  const start = text.lastIndexOf('\n      - ', index);
  const from = start >= 0 ? start + 1 : Math.max(0, text.lastIndexOf('\n', index) + 1);
  const next = text.indexOf('\n      - ', index + 1);
  return text.slice(from, next >= 0 ? next : text.length);
}

function operations(file: SourceFile): CacheOperation[] {
  const result: CacheOperation[] = [];
  for (const match of file.text.matchAll(new RegExp(CACHE_ACTION.source, 'gi'))) {
    const index = match.index ?? 0;
    const raw = (match[1] ?? 'cache').toLowerCase();
    const action: CacheOperation['action'] = raw.endsWith('/restore') ? 'restore' : raw.endsWith('/save') ? 'save' : 'cache';
    result.push({ file, action, line: lineAt(file.text, index), block: stepBlock(file.text, index) });
  }
  return result;
}

function finding(op: CacheOperation, id: string, severity: Finding['severity'], title: string, message: string, remediation: string, blocking = false): Finding {
  return {
    id,
    domain: 'security',
    severity,
    title,
    message,
    location: { file: op.file.repositoryPath, line: op.line },
    evidence: { excerpt: op.block.slice(0, 320), metadata: { cacheAction: op.action } },
    remediation,
    ...(blocking ? { blocking: true } : {}),
    tags: ['ci-cd', 'cache', 'supply-chain', 'trust-boundary'],
  };
}

function actionRef(op: CacheOperation): string {
  return CACHE_ACTION.exec(op.block)?.[2] ?? '';
}

function keyValue(block: string): string {
  return block.match(/(?:^|\n)\s*key\s*:\s*([^\n#]+)/im)?.[1]?.trim() ?? '';
}

function pathValue(block: string): string {
  return block.match(/(?:^|\n)\s*path\s*:\s*([^\n#]+)/im)?.[1]?.trim() ?? '';
}

function auditOperation(op: CacheOperation, triggerPrefix: string): Finding[] {
  const findings: Finding[] = [];
  const ref = actionRef(op);
  const key = keyValue(op.block);
  const path = pathValue(op.block);
  const untrustedWorkflow = UNTRUSTED_TRIGGER.test(triggerPrefix);
  const privilegedWorkflow = PRIVILEGE.test(op.file.text);

  if (!IMMUTABLE_SHA.test(ref)) {
    findings.push(finding(op, 'ci-cache-mutable-action', 'high', 'Cache action is not immutable-SHA pinned', `Workflow cache operation uses mutable action reference ${ref || '(missing)'}.`, 'Pin actions/cache and its restore/save variants to a reviewed full 40-character commit SHA.'));
  }

  if (!key) {
    findings.push(finding(op, 'ci-cache-key-missing', 'high', 'Cache operation has no explicit key', 'Cache identity is implicit or absent, preventing deterministic trust-boundary review.', 'Set an explicit cache key derived only from trusted dependency manifests, platform facts, and immutable repository state.'));
  } else if (UNTRUSTED_EXPR.test(key)) {
    findings.push(finding(op, 'ci-cache-key-untrusted-input', untrustedWorkflow || privilegedWorkflow ? 'critical' : 'high', 'Cache key contains attacker-controlled input', `Cache key ${key} is derived from an event or input value that an external actor can influence.`, 'Remove PR-head, issue/comment/review, dispatch-input and other attacker-controlled values from cache identity. Use trusted lockfile hashes and runner/platform facts.', untrustedWorkflow || privilegedWorkflow));
  }

  if (RESTORE_KEYS.test(op.block) && (untrustedWorkflow || privilegedWorkflow)) {
    findings.push(finding(op, 'ci-cache-privileged-prefix-restore', 'high', 'Privileged or untrusted workflow uses prefix cache restore', 'restore-keys permits fallback to older or broader cache namespaces across a sensitive trust boundary.', 'Use an exact cache key for privileged jobs. If fallback restoration is required, isolate it in an unprivileged build job and never promote cached executable output as trusted evidence.'));
  }

  if (!path) {
    findings.push(finding(op, 'ci-cache-path-missing', 'medium', 'Cache path is not explicit', 'Cache operation does not expose a reviewable path boundary.', 'Declare the narrow dependency/download cache directory explicitly.'));
  } else {
    if (BROAD_PATH.test(op.block)) {
      findings.push(finding(op, 'ci-cache-broad-workspace-path', 'critical', 'Cache includes workspace or home root', `Cache path ${path} is broad enough to persist source, generated scripts, credentials, or executable state across runs.`, 'Cache only package-manager download stores or other narrow non-executable dependency data; never cache the repository workspace or home root.', true));
    }
    if (EXECUTABLE_PATH.test(path)) {
      findings.push(finding(op, 'ci-cache-executable-path', privilegedWorkflow ? 'critical' : 'high', 'Cache includes executable/tooling path', `Cache path ${path} can restore executable content that later steps may trust or execute.`, 'Do not restore executable directories across trust boundaries. Recreate tools from immutable lockfiles/packages and verify provenance before execution.', privilegedWorkflow));
    }
  }

  if (untrustedWorkflow && op.action !== 'restore' && !LOOKUP_ONLY_FALSE.test(op.block)) {
    findings.push(finding(op, 'ci-cache-untrusted-event-can-save', 'critical', 'Untrusted event can populate shared cache', 'An externally influenced workflow can write cache content that later trusted jobs may restore.', 'Make untrusted-event cache access restore-only/lookup-only or disable caching; populate trusted caches only from protected branch workflows.', true));
  }

  if (untrustedWorkflow && privilegedWorkflow) {
    findings.push(finding(op, 'ci-cache-untrusted-privileged-boundary', 'critical', 'Cache crosses untrusted event and privileged workflow boundary', 'The workflow combines an externally influenced trigger, write-level privilege and mutable persisted cache state.', 'Separate untrusted validation from privileged release workflows. Do not share writable caches across those trust domains.', true));
  }

  return findings;
}

function triggerPrefix(file: SourceFile): string {
  const jobs = file.text.search(/^jobs\s*:/m);
  return jobs >= 0 ? file.text.slice(0, jobs) : file.text;
}

export function auditCacheBoundaries(inventory: RepositoryInventory): AuditSection<CacheBoundarySummary> {
  const started = performance.now();
  const files = workflows(inventory);
  const ops = files.flatMap(operations);
  const findings = files.flatMap(file => {
    const prefix = triggerPrefix(file);
    return operations(file).flatMap(op => auditOperation(op, prefix));
  });
  return {
    domain: 'security',
    title: 'Workflow cache trust-boundary audit',
    summary: {
      workflowFiles: files.length,
      cacheOperations: ops.length,
      restoreOperations: ops.filter(op => op.action === 'restore').length,
      saveOperations: ops.filter(op => op.action === 'save' || op.action === 'cache').length,
      findings,
    },
    findings,
    elapsedMs: performance.now() - started,
  };
}
