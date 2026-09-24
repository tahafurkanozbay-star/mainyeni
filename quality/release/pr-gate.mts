#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_THRESHOLDS,
  type AuditSection,
  type Finding,
  type FindingSnapshot,
  type RegressionDelta,
  type ReleaseContext,
  type ReleaseGateDecision,
} from './contracts.mts';
import { buildRepositoryInventory } from './inventory.mts';
import {
  auditChangeRisk,
  changeRiskMarkdown,
  type ChangeRiskSummary,
} from './change-risk-audit.mts';
import {
  auditProjectContractDelta,
  projectContractDeltaMarkdown,
  type ProjectContractDeltaSummary,
} from './project-contract-delta-audit.mts';
import {
  auditSafetyContractDelta,
  safetyContractDeltaMarkdown,
  type SafetyContractDeltaSummary,
} from './safety-contract-delta-audit.mts';
import {
  compareBaseline,
  createBaseline,
  decideReleaseGate,
  regressionFindings,
  runReleaseEngine,
} from './release-engine.mts';

export interface PullRequestGateResult {
  readonly baselineCommit: string;
  readonly currentCommit: string;
  readonly baselineRiskScore: number;
  readonly currentRiskScore: number;
  readonly delta: RegressionDelta;
  readonly changeRisk: AuditSection<ChangeRiskSummary>;
  readonly safetyDelta: AuditSection<SafetyContractDeltaSummary>;
  readonly projectContractDelta: AuditSection<ProjectContractDeltaSummary>;
  readonly regressionFindings: readonly Finding[];
  readonly decision: ReleaseGateDecision;
}

const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const LANGUAGE_EXTENSIONS = [...JAVASCRIPT_EXTENSIONS, ...TYPESCRIPT_EXTENSIONS]
  .sort((left, right) => right.length - left.length);

function valueAfter(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function environmentContext(commit: string, baselineCommit?: string): ReleaseContext {
  return {
    repository: process.env.GITHUB_REPOSITORY ?? 'tahafurkanozbay-star/mainyeni',
    ...(process.env.GITHUB_REF_NAME ? { branch: process.env.GITHUB_REF_NAME } : {}),
    commit,
    ...(baselineCommit ? { baselineCommit } : {}),
    generatedAt: new Date().toISOString(),
  };
}

function severityEscalationFindings(delta: RegressionDelta): Finding[] {
  const findings: Finding[] = [];
  if (delta.severityDelta.critical > 0 && !delta.added.some(item => item.severity === 'critical')) {
    findings.push({
      id: 'release-critical-severity-escalation',
      domain: 'release',
      severity: 'critical',
      title: 'Critical severity increased relative to baseline',
      message: `Critical finding count increased by ${delta.severityDelta.critical} without a new finding key.`,
      remediation: 'Review severity changes and remove the critical regression before merge.',
      blocking: true,
      tags: ['baseline', 'regression'],
    });
  }
  if (delta.severityDelta.high > 0 && !delta.added.some(item => item.severity === 'high')) {
    findings.push({
      id: 'release-high-severity-escalation',
      domain: 'release',
      severity: 'high',
      title: 'High severity increased relative to baseline',
      message: `High finding count increased by ${delta.severityDelta.high} without a new finding key.`,
      remediation: 'Review severity changes and remove or explicitly resolve the high-risk regression.',
      tags: ['baseline', 'regression'],
    });
  }
  return findings;
}

function findingId(snapshot: FindingSnapshot): string {
  return snapshot.key.split('|', 3)[1] ?? '';
}

function sourceExtension(file: string | undefined): string {
  if (!file) return '';
  const lower = file.toLowerCase();
  return LANGUAGE_EXTENSIONS.find(extension => lower.endsWith(extension)) ?? '';
}

function sourceStem(file: string | undefined): string {
  if (!file) return '';
  const extension = sourceExtension(file);
  return extension ? file.slice(0, -extension.length) : file;
}

function isJavaScriptToTypeScriptPair(
  current: FindingSnapshot,
  baseline: FindingSnapshot,
): boolean {
  const currentExtension = sourceExtension(current.file);
  const baselineExtension = sourceExtension(baseline.file);
  const crossesLanguageBoundary =
    (JAVASCRIPT_EXTENSIONS.has(currentExtension) && TYPESCRIPT_EXTENSIONS.has(baselineExtension)) ||
    (TYPESCRIPT_EXTENSIONS.has(currentExtension) && JAVASCRIPT_EXTENSIONS.has(baselineExtension));
  if (!crossesLanguageBoundary) return false;
  return current.domain === baseline.domain &&
    current.severity === baseline.severity &&
    findingId(current) === findingId(baseline) &&
    sourceStem(current.file) === sourceStem(baseline.file);
}

/**
 * Exact-base auditing intentionally keys findings by file/line/evidence. During a
 * staged JS -> TS migration the same audited behavior can move from foo.js to
 * foo.ts without changing its risk. Pair only one-for-one findings with the
 * same audit id/domain/severity and source stem across the JS/TS boundary.
 *
 * This does not suppress findings newly introduced in TypeScript files: a
 * matching removed JavaScript finding is required, and any unmatched addition
 * remains a regression.
 */
export function reconcileLanguageMigrationDelta(delta: RegressionDelta): RegressionDelta {
  if (!delta.added.length || !delta.removed.length) return delta;

  const removed = [...delta.removed];
  const added: FindingSnapshot[] = [];
  const migrated: FindingSnapshot[] = [];

  for (const current of delta.added) {
    let candidateIndex = -1;
    let candidateDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < removed.length; index += 1) {
      const baseline = removed[index];
      if (!baseline || !isJavaScriptToTypeScriptPair(current, baseline)) continue;
      const distance = Math.abs((current.line ?? 0) - (baseline.line ?? 0));
      if (distance < candidateDistance) {
        candidateIndex = index;
        candidateDistance = distance;
      }
    }

    if (candidateIndex < 0) {
      added.push(current);
      continue;
    }

    removed.splice(candidateIndex, 1);
    migrated.push(current);
  }

  if (!migrated.length) return delta;
  return {
    ...delta,
    added,
    removed,
    unchanged: [...delta.unchanged, ...migrated],
  };
}

export function decidePullRequestRegression(
  delta: RegressionDelta,
  supplementalFindings: readonly Finding[] = [],
): {
  readonly findings: readonly Finding[];
  readonly decision: ReleaseGateDecision;
} {
  const findings = [
    ...regressionFindings(delta),
    ...severityEscalationFindings(delta),
    ...supplementalFindings,
  ];
  const decision = decideReleaseGate(findings, {
    ...DEFAULT_THRESHOLDS,
    maxMediumFindings: 5,
    maxRiskScore: 80,
  });
  return { findings, decision };
}

function markdown(result: PullRequestGateResult): string {
  const { delta, decision, changeRisk, safetyDelta, projectContractDelta } = result;
  const lines = [
    '# Kent Rehberi — PR Regression Gate',
    '',
    `- Baseline commit: \`${result.baselineCommit}\``,
    `- Current commit: \`${result.currentCommit}\``,
    `- Baseline risk score: ${result.baselineRiskScore}`,
    `- Current risk score: ${result.currentRiskScore}`,
    `- Risk-score delta: ${delta.riskScoreDelta}`,
    `- Added findings: ${delta.added.length}`,
    `- Removed findings: ${delta.removed.length}`,
    `- Unchanged findings: ${delta.unchanged.length}`,
    `- Critical delta: ${delta.severityDelta.critical}`,
    `- High delta: ${delta.severityDelta.high}`,
    `- Medium delta: ${delta.severityDelta.medium}`,
    `- Exact-base file changes: ${changeRisk.summary.changeCount}`,
    `- Production file changes: ${changeRisk.summary.productionChanges}`,
    `- Test file changes: ${changeRisk.summary.testChanges}`,
    `- Change-risk areas: ${changeRisk.summary.changedAreas.join(', ') || 'none'}`,
    `- Change-risk findings: ${changeRisk.findings.length}`,
    `- Protective safety losses: ${safetyDelta.summary.protectiveLosses}`,
    `- Dangerous safety introductions: ${safetyDelta.summary.dangerousIntroductions}`,
    `- Safety-delta findings: ${safetyDelta.findings.length}`,
    `- Project contract deltas: ${projectContractDelta.summary.deltas.length}`,
    `- Project contract critical/high: ${projectContractDelta.summary.criticalDeltas}/${projectContractDelta.summary.highDeltas}`,
    `- Gate: **${decision.state.toUpperCase()}**`,
    '',
  ];
  if (decision.reasons.length > 0) {
    lines.push('## Gate reasons', '');
    for (const reason of decision.reasons) lines.push(`- ${reason}`);
    lines.push('');
  }
  lines.push('## New critical/high static findings', '');
  const severe = delta.added.filter(item => item.severity === 'critical' || item.severity === 'high');
  if (severe.length === 0) lines.push('No new critical/high static findings relative to the exact base SHA.');
  else for (const item of severe) lines.push(`- **${item.severity.toUpperCase()}** \`${item.key}\``);
  lines.push('', '## Exact-base change-risk findings', '');
  if (changeRisk.findings.length === 0) {
    lines.push('No uncovered changed-surface risk findings.');
  } else {
    for (const item of changeRisk.findings) {
      lines.push(`- **${item.severity.toUpperCase()}** \`${item.id}\`: ${item.title}`);
    }
  }
  lines.push('', '## Exact-base safety-contract findings', '');
  if (safetyDelta.findings.length === 0) {
    lines.push('No removed safety contracts or newly introduced dangerous primitives.');
  } else {
    for (const item of safetyDelta.findings) {
      lines.push(`- **${item.severity.toUpperCase()}** \`${item.id}\`: ${item.title}`);
    }
  }
  lines.push('', '## Exact-base project-contract findings', '');
  if (projectContractDelta.findings.length === 0) {
    lines.push('No weakened package/toolchain/compiler project contracts.');
  } else {
    for (const item of projectContractDelta.findings) {
      lines.push(`- **${item.severity.toUpperCase()}** \`${item.id}\`: ${item.title}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export async function runPullRequestGate(options: {
  readonly currentRoot: string;
  readonly baselineRoot: string;
  readonly currentCommit: string;
  readonly baselineCommit: string;
  readonly outputDirectory: string;
}): Promise<PullRequestGateResult> {
  const baselineInventory = buildRepositoryInventory({ root: options.baselineRoot, includeTests: true });
  const baselineExecution = await runReleaseEngine(
    baselineInventory,
    environmentContext(options.baselineCommit),
  );
  const baseline = createBaseline(baselineExecution.report);

  const currentInventory = buildRepositoryInventory({ root: options.currentRoot, includeTests: true });
  const currentExecution = await runReleaseEngine(
    currentInventory,
    environmentContext(options.currentCommit, options.baselineCommit),
  );
  const rawDelta = compareBaseline(currentExecution.report, baseline);
  const delta = reconcileLanguageMigrationDelta(rawDelta);
  const changeRisk = auditChangeRisk(baselineInventory, currentInventory);
  const safetyDelta = auditSafetyContractDelta(baselineInventory, currentInventory);
  const projectContractDelta = auditProjectContractDelta(baselineInventory, currentInventory);
  const gate = decidePullRequestRegression(delta, [
    ...changeRisk.findings,
    ...safetyDelta.findings,
    ...projectContractDelta.findings,
  ]);
  const result: PullRequestGateResult = {
    baselineCommit: options.baselineCommit,
    currentCommit: options.currentCommit,
    baselineRiskScore: baselineExecution.report.decision.riskScore,
    currentRiskScore: currentExecution.report.decision.riskScore,
    delta,
    changeRisk,
    safetyDelta,
    projectContractDelta,
    regressionFindings: gate.findings,
    decision: gate.decision,
  };

  mkdirSync(options.outputDirectory, { recursive: true });
  writeFileSync(resolve(options.outputDirectory, 'pr-regression-gate.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  writeFileSync(resolve(options.outputDirectory, 'pr-regression-gate.md'), markdown(result), 'utf8');
  writeFileSync(resolve(options.outputDirectory, 'change-risk-gate.json'), `${JSON.stringify(changeRisk, null, 2)}\n`, 'utf8');
  writeFileSync(resolve(options.outputDirectory, 'change-risk-gate.md'), changeRiskMarkdown(changeRisk), 'utf8');
  writeFileSync(resolve(options.outputDirectory, 'safety-contract-delta.json'), `${JSON.stringify(safetyDelta, null, 2)}\n`, 'utf8');
  writeFileSync(resolve(options.outputDirectory, 'safety-contract-delta.md'), safetyContractDeltaMarkdown(safetyDelta), 'utf8');
  writeFileSync(resolve(options.outputDirectory, 'project-contract-delta.json'), `${JSON.stringify(projectContractDelta, null, 2)}\n`, 'utf8');
  writeFileSync(resolve(options.outputDirectory, 'project-contract-delta.md'), projectContractDeltaMarkdown(projectContractDelta), 'utf8');
  return result;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const currentRoot = resolve(valueAfter(args, '--root') ?? process.cwd());
  const baselineRootValue = valueAfter(args, '--baseline-root');
  if (!baselineRootValue) throw new Error('--baseline-root is required for PR regression gating.');
  const baselineRoot = resolve(baselineRootValue);
  const outputDirectory = resolve(currentRoot, valueAfter(args, '--output') ?? 'qa-artifacts/release');
  const currentCommit = valueAfter(args, '--current-commit') ?? process.env.GITHUB_SHA ?? 'unknown-current';
  const baselineCommit = valueAfter(args, '--baseline-commit') ?? process.env.GITHUB_BASE_SHA ?? 'unknown-baseline';
  const result = await runPullRequestGate({ currentRoot, baselineRoot, currentCommit, baselineCommit, outputDirectory });
  process.stdout.write(markdown(result));
  if (result.decision.state === 'block') {
    process.stderr.write('PR regression gate blocked by exact-base static/change-risk/safety/project-contract regression.\n');
    return 1;
  }
  return 0;
}

if (process.argv[1]?.endsWith('pr-gate.mts')) {
  process.exitCode = await main();
}
