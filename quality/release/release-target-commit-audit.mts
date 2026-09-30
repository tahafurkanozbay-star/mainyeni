import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  workflowFiles,
  workflowJobBlocks,
  workflowTopLevelBlock,
  workflowTriggerProfile,
  type WorkflowJobBlock,
} from './workflow-structure.mts';
import {
  firstWorkflowStepField,
  stepDisplayName,
  stepNestedMapping,
  stepRunText,
  stepUsesIdentity,
  workflowStepBlocks,
  type WorkflowStepBlock,
} from './workflow-step-structure.mts';

export type ReleaseCreationKind = 'gh-release-create' | 'softprops-release' | 'ncipollo-release';
export type ReleaseTargetSource =
  | 'missing'
  | 'workflow-run-head-sha'
  | 'github-sha'
  | 'literal-sha'
  | 'input'
  | 'indirect'
  | 'branch-or-ref'
  | 'event'
  | 'dynamic'
  | 'literal-ref';

export interface ReleaseTargetCommitSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly line: number;
  readonly kind: ReleaseCreationKind;
  readonly tag: string;
  readonly target: string;
  readonly targetSource: ReleaseTargetSource;
  readonly push: boolean;
  readonly tagRestrictedPush: boolean;
  readonly branchEnabledPush: boolean;
  readonly workflowDispatch: boolean;
  readonly workflowCall: boolean;
  readonly workflowRun: boolean;
  readonly externalContribution: boolean;
}

export interface ReleaseTargetCommitSummary {
  readonly workflowFiles: number;
  readonly releaseCreationSteps: number;
  readonly workflowRunCreations: number;
  readonly manualOrCallableCreations: number;
  readonly missingTargets: number;
  readonly producerBoundTargets: number;
  readonly signals: readonly ReleaseTargetCommitSignal[];
  readonly findings: readonly Finding[];
}

interface PushScope {
  readonly enabled: boolean;
  readonly tagRestricted: boolean;
  readonly branchEnabled: boolean;
}

interface GhCreate {
  readonly tag: string;
  readonly target: string;
}

const GH_RELEASE_CREATE = /\bgh\s+release\s+create\s+([^\n]+)/i;
const SOFTPROPS_RELEASE = /^softprops\/action-gh-release@/i;
const NICIPOLLO_RELEASE = /^ncipollo\/release-action@/i;
const SHA40 = /^[0-9a-f]{40}$/i;
const WORKFLOW_RUN_HEAD_SHA = /^\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}$/i;
const GITHUB_SHA = /^\$\{\{\s*github\.sha\s*\}\}$/i;
const INPUT = /\$\{\{[\s\S]*?(?:inputs\.|github\.event\.inputs\.)/i;
const INDIRECT = /\$\{\{[\s\S]*?(?:needs\.|steps\.|matrix\.|vars\.)/i;
const EXTERNAL_EVENT = /\$\{\{[\s\S]*?(?:github\.head_ref\b|github\.event\.(?:pull_request|issue|comment|review|discussion)\.)/i;
const BRANCH_OR_REF = /\$\{\{\s*github\.(?:ref|ref_name|head_ref|base_ref)\s*\}\}/i;
const EXPRESSION = /\$\{\{/;

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1);
  }
  return trimmed;
}

function shellTokens(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote ? undefined : character;
      continue;
    }
    if (/\s/.test(character) && !quote) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseGhCreate(step: WorkflowStepBlock): GhCreate | undefined {
  const run = stepRunText(step);
  const tail = run.match(GH_RELEASE_CREATE)?.[1];
  if (!tail) return undefined;
  const tokens = shellTokens(tail);
  const tag = tokens[0] ?? '';
  let target = '';
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === '--target') {
      target = tokens[index + 1] ?? '';
      break;
    }
    if (token.startsWith('--target=')) {
      target = token.slice('--target='.length);
      break;
    }
  }
  return { tag: stripQuotes(tag), target: stripQuotes(target) };
}

function pushScope(block: WorkflowJobBlock): PushScope {
  const profile = workflowTriggerProfile(block.file);
  if (!profile.push) return { enabled: false, tagRestricted: false, branchEnabled: false };
  const on = workflowTopLevelBlock(block.file, 'on');
  if (!on || on.value) return { enabled: true, tagRestricted: false, branchEnabled: true };
  const push = on.lines.find(line => /^\s*push\s*:\s*(?:#.*)?$/i.test(line.text));
  if (!push) return { enabled: true, tagRestricted: false, branchEnabled: true };
  let hasTags = false;
  let hasBranches = false;
  for (const line of on.lines) {
    if (line.line <= push.line) continue;
    if (line.trimmed && line.indent <= push.indent) break;
    if (/^\s*tags\s*:/.test(line.text)) hasTags = true;
    if (/^\s*branches\s*:/.test(line.text)) hasBranches = true;
  }
  return {
    enabled: true,
    tagRestricted: hasTags && !hasBranches,
    branchEnabled: hasBranches || !hasTags,
  };
}

function targetSource(target: string): ReleaseTargetSource {
  const value = stripQuotes(target);
  if (!value) return 'missing';
  if (WORKFLOW_RUN_HEAD_SHA.test(value)) return 'workflow-run-head-sha';
  if (GITHUB_SHA.test(value)) return 'github-sha';
  if (SHA40.test(value)) return 'literal-sha';
  if (INPUT.test(value)) return 'input';
  if (EXTERNAL_EVENT.test(value)) return 'event';
  if (INDIRECT.test(value)) return 'indirect';
  if (BRANCH_OR_REF.test(value)) return 'branch-or-ref';
  if (EXPRESSION.test(value)) return 'dynamic';
  return 'literal-ref';
}

function actionSignal(block: WorkflowJobBlock, step: WorkflowStepBlock): { kind: ReleaseCreationKind; tag: string; target: string } | undefined {
  const identity = stepUsesIdentity(step)?.raw ?? '';
  const withMap = stepNestedMapping(step, 'with');
  if (SOFTPROPS_RELEASE.test(identity)) {
    return {
      kind: 'softprops-release',
      tag: stripQuotes(withMap.get('tag_name') ?? ''),
      target: stripQuotes(withMap.get('target_commitish') ?? ''),
    };
  }
  if (NICIPOLLO_RELEASE.test(identity)) {
    return {
      kind: 'ncipollo-release',
      tag: stripQuotes(withMap.get('tag') ?? ''),
      target: stripQuotes(withMap.get('commit') ?? ''),
    };
  }
  return undefined;
}

function signalFor(block: WorkflowJobBlock, step: WorkflowStepBlock): ReleaseTargetCommitSignal | undefined {
  const gh = parseGhCreate(step);
  const action = actionSignal(block, step);
  if (!gh && !action) return undefined;
  const profile = workflowTriggerProfile(block.file);
  const push = pushScope(block);
  const kind = gh ? 'gh-release-create' as const : action!.kind;
  const tag = gh?.tag ?? action!.tag;
  const target = gh?.target ?? action!.target;
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    line: firstWorkflowStepField(step, 'run')?.line
      ?? firstWorkflowStepField(step, 'uses')?.line
      ?? step.startLine,
    kind,
    tag,
    target,
    targetSource: targetSource(target),
    push: push.enabled,
    tagRestrictedPush: push.tagRestricted,
    branchEnabledPush: push.branchEnabled,
    workflowDispatch: profile.workflowDispatch,
    workflowCall: profile.workflowCall,
    workflowRun: profile.workflowRun,
    externalContribution: profile.externalContribution,
  };
}

function finding(
  signal: ReleaseTargetCommitSignal,
  id: string,
  title: string,
  message: string,
  remediation: string,
  severity: Finding['severity'] = 'critical',
  blocking = true,
): Finding {
  return {
    id,
    domain: 'release',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: signal.file, line: signal.line },
    evidence: {
      value: signal.target || signal.tag,
      metadata: {
        job: signal.job,
        step: signal.step,
        kind: signal.kind,
        targetSource: signal.targetSource,
      },
    },
    remediation,
    tags: ['ci', 'release', 'target-commit', 'provenance', 'supply-chain'],
  };
}

function findingsFor(signal: ReleaseTargetCommitSignal): Finding[] {
  const findings: Finding[] = [];

  if (signal.workflowRun) {
    if (signal.targetSource !== 'workflow-run-head-sha') {
      findings.push(finding(
        signal,
        'ci-release-target-not-producer-sha',
        'workflow_run release target is not bound to the producer head SHA',
        `Release creation step ${signal.step} uses target ${signal.target || '(implicit default target)'} in workflow_run context. github.sha identifies the privileged consumer workflow revision, not the producer bytes being promoted.`,
        'Set the release target commit exactly to github.event.workflow_run.head_sha after separately validating producer repository, event, ref and successful conclusion.',
      ));
    }
    return findings;
  }

  if (signal.externalContribution && signal.targetSource !== 'literal-sha') {
    findings.push(finding(
      signal,
      'ci-release-target-external-context',
      'Contribution-triggered release creation is not pinned to an immutable target commit',
      `Release creation step ${signal.step} is reachable from an externally influenced event and does not use a literal immutable commit target.`,
      'Do not create releases in contribution-triggered workflows. Move release creation to a trusted push/tag/manual workflow and bind it to an immutable reviewed commit.',
    ));
    return findings;
  }

  if (signal.tagRestrictedPush && signal.targetSource === 'missing') {
    return findings;
  }

  if (signal.targetSource === 'missing') {
    findings.push(finding(
      signal,
      'ci-release-target-implicit',
      'Release creation leaves target commit implicit',
      `Release creation step ${signal.step} can create a tag/release without an explicit immutable target. On branch/manual/callable runs the hosting platform can resolve the new tag against the repository default branch rather than the validated commit.`,
      'Use the triggering immutable commit (normally github.sha) as the explicit release target, or create releases only for an already-existing tag-triggered push.',
      'high',
      true,
    ));
    return findings;
  }

  if (signal.targetSource === 'input' || signal.targetSource === 'event' || signal.targetSource === 'dynamic') {
    findings.push(finding(
      signal,
      'ci-release-target-untrusted-selector',
      'Release target commit is selected by mutable event or caller data',
      `Release creation step ${signal.step} selects target ${signal.target} from mutable input/event data. This can retarget a trusted release operation to unreviewed source.`,
      'Resolve the target from trusted immutable run context (github.sha) or a verified literal commit SHA; never accept release commit identity from ordinary inputs or contribution metadata.',
    ));
    return findings;
  }

  if (signal.targetSource === 'indirect') {
    findings.push(finding(
      signal,
      'ci-release-target-indirect-selector',
      'Release target commit comes from an indirect workflow output',
      `Release creation step ${signal.step} trusts ${signal.target} as target commit. Upstream outputs require an independently reviewable immutable-source contract before they can authorize release identity.`,
      'Prefer github.sha for the trusted run. If an upstream resolver is required, verify that it emits a 40-character commit from an allowlisted repository/ref and bind that contract explicitly.',
      'high',
      true,
    ));
    return findings;
  }

  if (signal.targetSource === 'branch-or-ref' || signal.targetSource === 'literal-ref') {
    findings.push(finding(
      signal,
      'ci-release-target-mutable-ref',
      'Release target is a mutable branch/ref rather than an immutable commit',
      `Release creation step ${signal.step} targets ${signal.target}. Mutable refs can move between validation and release creation.`,
      'Resolve and use the exact validated commit SHA. Treat branch/tag names as selectors only; the release target should be immutable at mutation time.',
      'high',
      true,
    ));
  }

  return findings;
}

export function auditReleaseTargetCommits(
  inventory: RepositoryInventory,
): AuditSection<ReleaseTargetCommitSummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const signals: ReleaseTargetCommitSignal[] = [];

  for (const file of files) {
    for (const block of workflowJobBlocks(file)) {
      for (const step of workflowStepBlocks(block)) {
        const signal = signalFor(block, step);
        if (signal) signals.push(signal);
      }
    }
  }

  const findings = stableSortFindings(signals.flatMap(findingsFor));
  return {
    domain: 'release',
    title: 'Release target commit provenance audit',
    summary: {
      workflowFiles: files.length,
      releaseCreationSteps: signals.length,
      workflowRunCreations: signals.filter(item => item.workflowRun).length,
      manualOrCallableCreations: signals.filter(item => item.workflowDispatch || item.workflowCall).length,
      missingTargets: signals.filter(item => item.targetSource === 'missing').length,
      producerBoundTargets: signals.filter(item => item.targetSource === 'workflow-run-head-sha').length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
