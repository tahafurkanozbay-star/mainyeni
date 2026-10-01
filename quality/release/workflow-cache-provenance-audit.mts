import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { snippetAround } from './inventory.mts';

export interface CacheProvenanceSignal {
  readonly file: string;
  readonly cacheSteps: number;
  readonly saveCapableSteps: number;
  readonly restoreOnlySteps: number;
  readonly untrustedTriggers: number;
  readonly protectedTriggers: number;
  readonly refIsolatedKeys: number;
  readonly eventIsolatedKeys: number;
  readonly contentAddressedKeys: number;
}

export interface CacheProvenanceSummary {
  readonly workflows: readonly CacheProvenanceSignal[];
  readonly workflowFiles: number;
  readonly cacheSteps: number;
  readonly saveCapableSteps: number;
  readonly restoreOnlySteps: number;
  readonly untrustedTriggerWorkflows: number;
  readonly findings: readonly Finding[];
}

interface PhysicalLine {
  readonly text: string;
  readonly offset: number;
  readonly number: number;
}

interface CacheStep {
  readonly file: SourceFile;
  readonly line: number;
  readonly offset: number;
  readonly action: 'cache' | 'restore' | 'save';
  readonly key: string | undefined;
  readonly restoreKeys: readonly string[];
  readonly lookupOnly: boolean;
  readonly failOnCacheMiss: boolean;
}

interface TriggerProfile {
  readonly pullRequest: boolean;
  readonly pullRequestTarget: boolean;
  readonly workflowRun: boolean;
  readonly issueLike: boolean;
  readonly push: boolean;
  readonly release: boolean;
  readonly workflowDispatch: boolean;
}

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const CACHE_ACTION = /^\s*-\s+uses\s*:\s*actions\/cache(?:\/(restore|save))?@[0-9a-f]{40}(?:\s+#.*)?$/i;
const HASH_FILES = /\$\{\{[^}]*\bhashFiles\s*\(/i;
const REF_IDENTITY = /\$\{\{[^}]*\b(?:github\.ref|github\.ref_name|github\.sha|github\.event\.pull_request\.head\.sha)\b/i;
const EVENT_IDENTITY = /\$\{\{[^}]*\b(?:github\.event_name|github\.event\.pull_request\.number|github\.event\.workflow_run\.id)\b/i;
const RUNNER_IDENTITY = /\$\{\{[^}]*\b(?:runner\.os|runner\.arch)\b/i;

function physicalLines(text: string): PhysicalLine[] {
  const result: PhysicalLine[] = [];
  let offset = 0;
  for (const [index, raw] of text.split('\n').entries()) {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    result.push({ text, offset, number: index + 1 });
    offset += raw.length + 1;
  }
  return result;
}

function indentation(text: string): number {
  return text.match(/^\s*/)?.[0].length ?? 0;
}

function workflowFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => WORKFLOW_PATH.test(file.repositoryPath));
}

function scalar(
  lines: readonly PhysicalLine[],
  stepIndex: number,
  stepIndent: number,
  name: string,
): { readonly value: string | undefined; readonly values: readonly string[] } {
  const pattern = new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`, 'i');
  for (let cursor = stepIndex + 1; cursor < lines.length; cursor += 1) {
    const current = lines[cursor]!;
    if (current.text.trim() && indentation(current.text) <= stepIndent && /^\s*-\s+/.test(current.text)) break;
    const match = current.text.match(pattern);
    if (!match) continue;
    const raw = (match[1] ?? '').trim();
    if (raw && !/^[>|][+-]?$/.test(raw)) {
      const value = raw.replace(/^['"]|['"]$/g, '');
      return { value, values: [value] };
    }
    const fieldIndent = indentation(current.text);
    const values: string[] = [];
    for (let next = cursor + 1; next < lines.length; next += 1) {
      const candidate = lines[next]!;
      if (candidate.text.trim() && indentation(candidate.text) <= fieldIndent) break;
      const value = candidate.text.trim();
      if (!value || value.startsWith('#')) continue;
      values.push(value.replace(/^[-]\s*/, '').replace(/^['"]|['"]$/g, ''));
    }
    return { value: values.length > 0 ? values.join('\n') : undefined, values };
  }
  return { value: undefined, values: [] };
}

function booleanScalar(value: string | undefined): boolean {
  return /^(?:true|yes|on|1)$/i.test(value?.trim() ?? '');
}

function cacheSteps(file: SourceFile): CacheStep[] {
  const lines = physicalLines(file.text);
  const result: CacheStep[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index]!;
    const match = current.text.match(CACHE_ACTION);
    if (!match) continue;
    const stepIndent = indentation(current.text);
    const key = scalar(lines, index, stepIndent, 'key').value;
    const restoreKeys = scalar(lines, index, stepIndent, 'restore-keys').values;
    const lookupOnly = booleanScalar(scalar(lines, index, stepIndent, 'lookup-only').value);
    const failOnCacheMiss = booleanScalar(scalar(lines, index, stepIndent, 'fail-on-cache-miss').value);
    const action = (match[1]?.toLowerCase() ?? 'cache') as CacheStep['action'];
    result.push({ file, line: current.number, offset: current.offset, action, key, restoreKeys, lookupOnly, failOnCacheMiss });
  }
  return result;
}

function triggerProfile(file: SourceFile): TriggerProfile {
  const text = file.text;
  const event = (name: string): boolean => new RegExp(`(?:^|\\n)\\s{0,4}${name}\\s*:`, 'im').test(text)
    || new RegExp(`(?:^|\\n)\\s*on\\s*:\\s*\\[[^\\]]*\\b${name}\\b`, 'im').test(text)
    || new RegExp(`(?:^|\\n)\\s*on\\s*:\\s*${name}\\s*(?:$|#)`, 'im').test(text);
  return {
    pullRequest: event('pull_request'),
    pullRequestTarget: event('pull_request_target'),
    workflowRun: event('workflow_run'),
    issueLike: event('issues') || event('issue_comment') || event('pull_request_review') || event('pull_request_review_comment') || event('discussion') || event('discussion_comment'),
    push: event('push'),
    release: event('release'),
    workflowDispatch: event('workflow_dispatch'),
  };
}

function untrustedTrigger(profile: TriggerProfile): boolean {
  return profile.pullRequest || profile.pullRequestTarget || profile.issueLike;
}

function protectedTrigger(profile: TriggerProfile): boolean {
  return profile.push || profile.release || profile.workflowRun || profile.workflowDispatch;
}

function saveCapable(step: CacheStep): boolean {
  if (step.action === 'save') return true;
  if (step.action === 'restore') return false;
  return !step.lookupOnly;
}

function refIsolated(step: CacheStep): boolean {
  return REF_IDENTITY.test(step.key ?? '');
}

function eventIsolated(step: CacheStep): boolean {
  return EVENT_IDENTITY.test(step.key ?? '');
}

function contentAddressed(step: CacheStep): boolean {
  return HASH_FILES.test(step.key ?? '');
}

function platformIsolated(step: CacheStep): boolean {
  return RUNNER_IDENTITY.test(step.key ?? '');
}

function finding(
  step: CacheStep,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  blocking: boolean,
): Finding {
  return {
    id,
    domain: 'security',
    severity,
    blocking,
    title,
    message,
    location: { file: step.file.repositoryPath, line: step.line },
    evidence: { excerpt: snippetAround(step.file.text, step.offset, 220) },
    remediation,
    tags: ['ci', 'workflow', 'cache', 'provenance', 'supply-chain'],
  };
}

function findingsFor(file: SourceFile, step: CacheStep): Finding[] {
  const result: Finding[] = [];
  const profile = triggerProfile(file);
  const untrusted = untrustedTrigger(profile);
  const protectedPath = protectedTrigger(profile);
  const canSave = saveCapable(step);
  const isolatedByRef = refIsolated(step);
  const isolatedByEvent = eventIsolated(step);
  const addressed = contentAddressed(step);

  if (untrusted && canSave && !isolatedByRef && !isolatedByEvent) {
    result.push(finding(
      step,
      'ci-cache-untrusted-writer-shared-namespace',
      'critical',
      'Untrusted workflow can write a shared cache namespace',
      'A pull-request or issue-derived workflow can populate a cache key that is not isolated by trusted ref, immutable head identity, or event namespace.',
      'Use restore-only cache access for untrusted events, or isolate writable keys with immutable ref/event identity and never consume that namespace from privileged jobs.',
      true,
    ));
  }

  if (untrusted && canSave && step.restoreKeys.length > 0) {
    result.push(finding(
      step,
      'ci-cache-untrusted-writer-fallback-namespace',
      'critical',
      'Untrusted workflow writes while using fallback cache namespaces',
      'Fallback restore prefixes make cache provenance ambiguous when the same workflow is also allowed to save cache content.',
      'Split restore and save responsibilities. Untrusted workflows should restore exact reviewed keys and must not publish fallback-compatible executable state.',
      true,
    ));
  }

  if (protectedPath && canSave && step.key && !addressed) {
    result.push(finding(
      step,
      'ci-cache-protected-writer-not-content-addressed',
      'high',
      'Protected workflow cache key is not content-addressed',
      'A privileged or release-adjacent cache writer without a dependency/content hash can silently reuse stale mutable state across source changes.',
      'Include hashFiles(...) or another immutable reviewed content digest in the cache key.',
      false,
    ));
  }

  if (protectedPath && step.restoreKeys.length > 0 && !addressed) {
    result.push(finding(
      step,
      'ci-cache-protected-fallback-without-content-address',
      'high',
      'Protected workflow restores fallback cache without a content-addressed primary key',
      'Fallback selection combined with a mutable primary namespace weakens provenance for build and release dependencies.',
      'Use a content-addressed primary key and narrowly scoped fallback prefixes that cannot cross trust domains.',
      false,
    ));
  }

  if (protectedPath && canSave && step.key && !platformIsolated(step)) {
    result.push(finding(
      step,
      'ci-cache-platform-identity-missing',
      'medium',
      'Cache writer does not isolate runner platform identity',
      'Native dependencies or generated outputs can be restored on an incompatible runner platform when the key omits runner OS/architecture identity.',
      'Include runner.os and, where architecture-specific artifacts are cached, runner.arch in the key.',
      false,
    ));
  }

  if (step.action === 'restore' && step.lookupOnly) {
    result.push(finding(
      step,
      'ci-cache-restore-lookup-only-redundant',
      'low',
      'Restore-only cache action redundantly enables lookup-only mode',
      'The restore subaction already avoids automatic save behavior; redundant mode flags make intent harder to review.',
      'Prefer one explicit restore-only mechanism and keep cache semantics minimal.',
      false,
    ));
  }

  if (step.failOnCacheMiss && step.restoreKeys.length > 0) {
    result.push(finding(
      step,
      'ci-cache-required-hit-with-fallback',
      'medium',
      'Required cache hit still permits fallback selection',
      'A job that treats cache presence as mandatory should not accept provenance-ambiguous fallback entries.',
      'Remove restore-keys when fail-on-cache-miss is enabled and require the exact content-addressed key.',
      false,
    ));
  }

  return result;
}

function signal(file: SourceFile): CacheProvenanceSignal {
  const steps = cacheSteps(file);
  const profile = triggerProfile(file);
  return {
    file: file.repositoryPath,
    cacheSteps: steps.length,
    saveCapableSteps: steps.filter(saveCapable).length,
    restoreOnlySteps: steps.filter(step => !saveCapable(step)).length,
    untrustedTriggers: untrustedTrigger(profile) ? 1 : 0,
    protectedTriggers: protectedTrigger(profile) ? 1 : 0,
    refIsolatedKeys: steps.filter(refIsolated).length,
    eventIsolatedKeys: steps.filter(eventIsolated).length,
    contentAddressedKeys: steps.filter(contentAddressed).length,
  };
}

export function auditWorkflowCacheProvenance(
  inventory: RepositoryInventory,
): AuditSection<CacheProvenanceSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const workflows = files.map(signal);
  const findings = stableSortFindings(files.flatMap(file => cacheSteps(file).flatMap(step => findingsFor(file, step))));
  return {
    domain: 'security',
    title: 'Workflow cache provenance audit',
    summary: {
      workflows,
      workflowFiles: workflows.length,
      cacheSteps: workflows.reduce((sum, item) => sum + item.cacheSteps, 0),
      saveCapableSteps: workflows.reduce((sum, item) => sum + item.saveCapableSteps, 0),
      restoreOnlySteps: workflows.reduce((sum, item) => sum + item.restoreOnlySteps, 0),
      untrustedTriggerWorkflows: workflows.reduce((sum, item) => sum + item.untrustedTriggers, 0),
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
