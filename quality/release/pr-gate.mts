#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_THRESHOLDS,
  type Finding,
  type RegressionDelta,
  type ReleaseContext,
  type ReleaseGateDecision,
} from './contracts.mts';
import { buildRepositoryInventory } from './inventory.mts';
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
  readonly regressionFindings: readonly Finding[];
  readonly decision: ReleaseGateDecision;
}

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

export function decidePullRequestRegression(delta: RegressionDelta): {
  readonly findings: readonly Finding[];
  readonly decision: ReleaseGateDecision;
} {
  const findings = [...regressionFindings(delta), ...severityEscalationFindings(delta)];
  const decision = decideReleaseGate(findings, {
    ...DEFAULT_THRESHOLDS,
    maxMediumFindings: 0,
    maxRiskScore: 80,
  });
  return { findings, decision };
}

function markdown(result: PullRequestGateResult): string {
  const { delta, decision } = result;
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
    `- Gate: **${decision.state.toUpperCase()}**`,
    '',
  ];
  if (decision.reasons.length > 0) {
    lines.push('## Gate reasons', '');
    for (const reason of decision.reasons) lines.push(`- ${reason}`);
    lines.push('');
  }
  lines.push('## New critical/high findings', '');
  const severe = delta.added.filter(item => item.severity === 'critical' || item.severity === 'high');
  if (severe.length === 0) lines.push('No new critical/high static findings relative to the exact base SHA.');
  else for (const item of severe) lines.push(`- **${item.severity.toUpperCase()}** \`${item.key}\``);
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
  const delta = compareBaseline(currentExecution.report, baseline);
  const gate = decidePullRequestRegression(delta);
  const result: PullRequestGateResult = {
    baselineCommit: options.baselineCommit,
    currentCommit: options.currentCommit,
    baselineRiskScore: baselineExecution.report.decision.riskScore,
    currentRiskScore: currentExecution.report.decision.riskScore,
    delta,
    regressionFindings: gate.findings,
    decision: gate.decision,
  };

  mkdirSync(options.outputDirectory, { recursive: true });
  writeFileSync(resolve(options.outputDirectory, 'pr-regression-gate.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  writeFileSync(resolve(options.outputDirectory, 'pr-regression-gate.md'), markdown(result), 'utf8');
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
    process.stderr.write('PR regression gate blocked by new critical/high or material risk regression.\n');
    return 1;
  }
  return 0;
}

if (process.argv[1]?.endsWith('pr-gate.mts')) {
  process.exitCode = await main();
}
