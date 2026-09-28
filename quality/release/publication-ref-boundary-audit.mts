import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
} from './contracts.mts';
import {
  firstWorkflowField,
  hasExpression,
  hasUntrustedExpression,
  jobHasSecrets,
  jobHasWriteAuthority,
  jobUsesProtectedEnvironment,
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

export type PublicationKind = 'github-release' | 'package' | 'container' | 'pages' | 'nuget' | 'generic';

export interface PublicationSignal {
  readonly file: string;
  readonly job: string;
  readonly step: string;
  readonly line: number;
  readonly kind: PublicationKind;
  readonly commandOrAction: string;
  readonly target: string;
  readonly externalContribution: boolean;
  readonly push: boolean;
  readonly tagRestrictedPush: boolean;
  readonly branchEnabledPush: boolean;
  readonly workflowDispatch: boolean;
  readonly workflowCall: boolean;
  readonly writeAuthority: boolean;
  readonly secrets: boolean;
  readonly protectedEnvironment: boolean;
  readonly trustedRefGuard: boolean;
}

export interface PublicationRefBoundarySummary {
  readonly workflowFiles: number;
  readonly publicationSteps: number;
  readonly externalPublications: number;
  readonly manualPublications: number;
  readonly callablePublications: number;
  readonly untrustedTargets: number;
  readonly signals: readonly PublicationSignal[];
  readonly findings: readonly Finding[];
}

const GH_RELEASE = /\bgh\s+release\s+(?:create|upload|edit)\b/i;
const NPM_PUBLISH = /\b(?:npm|pnpm)\s+publish\b|\byarn\s+npm\s+publish\b/i;
const NUGET_PUBLISH = /\bdotnet\s+nuget\s+push\b/i;
const CONTAINER_PUSH = /\b(?:docker|podman|buildah)\s+(?:push|buildx\s+build\b[^\n]*--push)\b/i;
const GENERIC_PUBLISH = /\b(?:cargo\s+publish|twine\s+upload|python\s+-m\s+twine\s+upload|mvn\s+deploy|gradle\w*\s+publish)\b/i;
const GITHUB_RELEASE_ACTION = /^(?:softprops\/action-gh-release|ncipollo\/release-action|actions\/create-release)@/i;
const PAGES_ACTION = /^actions\/deploy-pages@/i;
const PYPI_ACTION = /^pypa\/gh-action-pypi-publish@/i;
const DOCKER_PUSH_ACTION = /^docker\/build-push-action@/i;
const TRUSTED_TAG_GUARD = /(?:github\.ref_type\s*==\s*['"]tag['"]|startsWith\s*\(\s*github\.ref\s*,\s*['"]refs\/tags\/['"]\s*\)|github\.ref\s*==\s*['"]refs\/tags\/[A-Za-z0-9._\/-]+['"])/i;
const TRUSTED_BRANCH_GUARD = /(?:github\.ref\s*==\s*['"]refs\/heads\/(?:main|master|release(?:\/[A-Za-z0-9._\/-]+)?)['"]|github\.ref_name\s*==\s*['"](?:main|master)['"])/i;
const INPUT_TARGET = /\$\{\{[\s\S]*?(?:inputs\.|github\.event\.inputs\.)/i;
const EVENT_TARGET = /\$\{\{[\s\S]*?(?:github\.head_ref\b|github\.event\.(?:pull_request|issue|comment|review|discussion)\.)/i;
const INDIRECT_TARGET = /\$\{\{[\s\S]*?(?:needs\.|steps\.|matrix\.|vars\.)/i;
const EXPRESSION_VALUE = /\$\{\{[\s\S]*?\}\}/;

interface PushScope {
  readonly enabled: boolean;
  readonly tagRestricted: boolean;
  readonly branchEnabled: boolean;
}

function pushScope(block: WorkflowJobBlock): PushScope {
  const profile = workflowTriggerProfile(block.file);
  if (!profile.push) return { enabled: false, tagRestricted: false, branchEnabled: false };
  const on = workflowTopLevelBlock(block.file, 'on');
  if (!on) return { enabled: true, tagRestricted: false, branchEnabled: true };
  if (on.value) return { enabled: true, tagRestricted: false, branchEnabled: true };
  const push = on.lines.find(line => /^\s*push\s*:\s*(?:#.*)?$/i.test(line.text));
  if (!push) return { enabled: true, tagRestricted: false, branchEnabled: true };
  const nested = on.lines.filter(line => line.line > push.line && line.indent > push.indent);
  let hasTags = false;
  let hasBranches = false;
  for (const line of nested) {
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

function publicationKind(step: WorkflowStepBlock): PublicationKind | undefined {
  const run = stepRunText(step);
  if (GH_RELEASE.test(run)) return 'github-release';
  if (NPM_PUBLISH.test(run) || PYPI_ACTION.test(stepUsesIdentity(step)?.raw ?? '') || GENERIC_PUBLISH.test(run)) return 'package';
  if (NUGET_PUBLISH.test(run)) return 'nuget';
  if (CONTAINER_PUSH.test(run)) return 'container';
  const identity = stepUsesIdentity(step)?.raw ?? '';
  if (GITHUB_RELEASE_ACTION.test(identity)) return 'github-release';
  if (PAGES_ACTION.test(identity)) return 'pages';
  if (DOCKER_PUSH_ACTION.test(identity)) {
    const push = stepNestedMapping(step, 'with').get('push')?.trim().toLowerCase();
    if (push === 'true' || push === "'true'" || push === '"true"') return 'container';
  }
  return undefined;
}

function expressionOrToken(value: string): string {
  const trimmed = value.trim();
  const expression = trimmed.match(EXPRESSION_VALUE)?.[0];
  if (expression) return expression;
  const quoted = trimmed.match(/^(?:"[^"]*"|'[^']*'|[^\s\\]+)/)?.[0];
  return quoted ?? '';
}

function targetFieldFallback(step: WorkflowStepBlock): string {
  for (const key of ['tag_name', 'tag', 'version', 'tags']) {
    const matcher = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'im');
    const value = step.text.match(matcher)?.[1]?.trim() ?? '';
    if (value && hasExpression(value)) return expressionOrToken(value);
  }
  return '';
}

function targetFor(step: WorkflowStepBlock, kind: PublicationKind): string {
  const withMap = stepNestedMapping(step, 'with');
  for (const key of ['tag_name', 'tag', 'version', 'tags', 'name']) {
    const value = withMap.get(key);
    if (value && hasExpression(value)) return expressionOrToken(value);
  }
  const nestedFallback = targetFieldFallback(step);
  if (nestedFallback) return nestedFallback;
  const run = stepRunText(step);
  if (kind === 'github-release') {
    const tail = run.match(/\bgh\s+release\s+(?:create|upload|edit)\s+([^\n]+)/i)?.[1] ?? '';
    const target = expressionOrToken(tail);
    if (target) return target;
  }
  if (kind === 'container') {
    const tail = run.match(/\b(?:docker|podman|buildah)\s+push\s+([^\n]+)/i)?.[1] ?? '';
    const target = expressionOrToken(tail);
    if (target) return target;
  }
  return '';
}

function refGuard(block: WorkflowJobBlock, step: WorkflowStepBlock): boolean {
  const jobIf = firstWorkflowField(block, 'if')?.value ?? '';
  const stepIf = firstWorkflowStepField(step, 'if')?.value ?? '';
  return TRUSTED_TAG_GUARD.test(jobIf)
    || TRUSTED_TAG_GUARD.test(stepIf)
    || TRUSTED_BRANCH_GUARD.test(jobIf)
    || TRUSTED_BRANCH_GUARD.test(stepIf);
}

function signalFor(block: WorkflowJobBlock, step: WorkflowStepBlock): PublicationSignal | undefined {
  const kind = publicationKind(step);
  if (!kind) return undefined;
  const profile = workflowTriggerProfile(block.file);
  const push = pushScope(block);
  return {
    file: block.file.repositoryPath,
    job: block.name,
    step: stepDisplayName(step),
    line: step.startLine,
    kind,
    commandOrAction: stepUsesIdentity(step)?.raw || stepRunText(step).split('\n')[0]?.trim() || kind,
    target: targetFor(step, kind),
    externalContribution: profile.externalContribution,
    push: push.enabled,
    tagRestrictedPush: push.tagRestricted,
    branchEnabledPush: push.branchEnabled,
    workflowDispatch: profile.workflowDispatch,
    workflowCall: profile.workflowCall,
    writeAuthority: jobHasWriteAuthority(block),
    secrets: jobHasSecrets(block),
    protectedEnvironment: jobUsesProtectedEnvironment(block),
    trustedRefGuard: refGuard(block, step),
  };
}

function location(item: PublicationSignal) {
  return { file: item.file, line: item.line };
}

function finding(
  item: PublicationSignal,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  blocking = false,
): Finding {
  return {
    id,
    domain: 'release',
    severity,
    title,
    message,
    location: location(item),
    evidence: { value: item.target || item.commandOrAction, metadata: { job: item.job, step: item.step, kind: item.kind } },
    remediation,
    ...(blocking ? { blocking: true } : {}),
    tags: ['ci', 'release', 'publication', 'ref', 'trust-boundary'],
  };
}

function targetFindings(item: PublicationSignal): Finding[] {
  if (!item.target) return [];
  const privileged = item.writeAuthority || item.secrets || item.protectedEnvironment;
  if (EVENT_TARGET.test(item.target)) {
    return [finding(
      item,
      'ci-publication-target-event-controlled',
      'critical',
      'Release publication identity is contribution-controlled',
      `Publication target ${item.target} is derived from event/head data. A contributor can steer the tag, release, package, or image identity used by a privileged publication step.`,
      'Derive release identity from a trusted immutable tag/ref selected by protected repository policy. Never use pull-request text or head refs as publication names or tags.',
      true,
    )];
  }
  if (INPUT_TARGET.test(item.target)) {
    return [finding(
      item,
      'ci-publication-target-input-controlled',
      privileged ? 'high' : 'medium',
      'Caller input selects release publication identity',
      `Publication target ${item.target} is selected by workflow/caller input. A typo or untrusted caller can redirect publication to an unintended release identity.`,
      'Validate publication identifiers against a strict version/tag format and require a protected environment or trusted ref before publishing.',
    )];
  }
  if (INDIRECT_TARGET.test(item.target)) {
    return [finding(
      item,
      'ci-publication-target-indirect',
      privileged ? 'high' : 'medium',
      'Release publication identity depends on indirect workflow output',
      `Publication target ${item.target} comes from needs/steps/matrix/vars provenance rather than an explicit trusted ref.`,
      'Validate the producer and map its output to a closed release/tag format before privileged publication.',
    )];
  }
  if (hasUntrustedExpression(item.target)) {
    return [finding(
      item,
      'ci-publication-target-untrusted-expression',
      'critical',
      'Release publication identity uses an unclassified untrusted expression',
      `Publication target ${item.target} contains a dynamic source outside the explicit trusted ref/identity model.`,
      'Reduce publication identity to a trusted repository tag/ref or validate the dynamic source against a strict release identifier allowlist before publication.',
      true,
    )];
  }
  return [];
}

function triggerFindings(item: PublicationSignal): Finding[] {
  const findings: Finding[] = [];
  const privileged = item.writeAuthority || item.secrets || item.protectedEnvironment;

  if (item.externalContribution) {
    findings.push(finding(
      item,
      'ci-publication-external-trigger',
      'critical',
      'Publication step is reachable from an external contribution event',
      `Job ${item.job} can publish ${item.kind} output while the workflow is triggered by contribution-controlled events.`,
      'Never publish from pull_request, pull_request_target, issue/comment/review/discussion events. Split validation from a trusted tag/protected-branch publication workflow.',
      true,
    ));
  }

  if (item.push && item.branchEnabledPush && !item.tagRestrictedPush && !item.trustedRefGuard) {
    findings.push(finding(
      item,
      'ci-publication-push-ref-unbounded',
      privileged ? 'high' : 'medium',
      'Publication push trigger is not restricted to a trusted release ref',
      `Job ${item.job} publishes on push without a tag-only trigger or explicit trusted ref condition. Ordinary branch pushes can enter the publication path.`,
      'Restrict publication workflows to reviewed tag patterns or a protected release branch and keep the ref predicate explicit in source.',
    ));
  }

  if (item.workflowDispatch && !item.protectedEnvironment && !item.trustedRefGuard) {
    findings.push(finding(
      item,
      'ci-publication-manual-unprotected',
      privileged ? 'high' : 'medium',
      'Manual publication lacks protected environment or trusted ref guard',
      `workflow_dispatch can be launched against arbitrary refs unless repository policy constrains the publication job.`,
      'Use a protected environment with required reviewers and/or enforce a trusted tag/release-branch predicate before publication.',
    ));
  }

  if (item.workflowCall && !item.protectedEnvironment && !item.trustedRefGuard) {
    findings.push(finding(
      item,
      'ci-publication-callable-unprotected',
      privileged ? 'high' : 'medium',
      'Callable workflow publishes without an independent trust guard',
      'A reusable publication workflow inherits caller provenance. Without its own environment/ref guard, caller behavior becomes the release authorization boundary.',
      'Require a protected environment and validate github.ref/tag identity inside the called workflow rather than trusting caller intent alone.',
    ));
  }

  return findings;
}

function findingsFor(item: PublicationSignal): Finding[] {
  return [...targetFindings(item), ...triggerFindings(item)];
}

export function auditPublicationRefBoundaries(
  inventory: RepositoryInventory,
): AuditSection<PublicationRefBoundarySummary> {
  const started = performance.now();
  const files = workflowFiles(inventory);
  const signals = files.flatMap(file => workflowJobBlocks(file).flatMap(block =>
    workflowStepBlocks(block)
      .map(step => signalFor(block, step))
      .filter((item): item is PublicationSignal => item !== undefined),
  ));
  const findings = stableSortFindings(signals.flatMap(findingsFor));
  return {
    domain: 'release',
    title: 'Release publication ref and identity trust-boundary audit',
    summary: {
      workflowFiles: files.length,
      publicationSteps: signals.length,
      externalPublications: signals.filter(item => item.externalContribution).length,
      manualPublications: signals.filter(item => item.workflowDispatch).length,
      callablePublications: signals.filter(item => item.workflowCall).length,
      untrustedTargets: signals.filter(item => EVENT_TARGET.test(item.target) || INPUT_TARGET.test(item.target)).length,
      signals,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
