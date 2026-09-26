import { createHash } from 'node:crypto';
import {
  DEFAULT_THRESHOLDS,
  SEVERITIES,
  countSeverities,
  dedupeFindings,
  findingKey,
  riskScore,
  snapshotFinding,
  stableSortFindings,
  type AuditSection,
  type BaselineSnapshot,
  type Finding,
  type FindingSnapshot,
  type RegressionDelta,
  type ReleaseContext,
  type ReleaseGateDecision,
  type ReleaseReport,
  type ReleaseThresholds,
  type RepositoryInventory,
  type Severity,
  type SeverityCounts,
} from './contracts.mts';
import { auditAccessibility } from './accessibility-audit.mts';
import { auditBackendSecurity } from './backend-security-audit.mts';
import { auditCiIntegrity } from './ci-integrity-audit.mts';
import { auditDataIntegrity } from './data-integrity-audit.mts';
import { auditDependencies } from './dependency-audit.mts';
import { auditGisReleaseContracts } from './gis-release-contract-audit.mts';
import { auditLanguageModernization } from './language-modernization-audit.mts';
import { auditGis } from './gis-audit.mts';
import { auditModernization } from './modernization-audit.mts';
import { auditNetwork } from './network-audit.mts';
import { auditPerformance } from './performance-audit.mts';
import { auditObservability } from './observability-audit.mts';
import { auditReleaseEvidenceMatrix } from './release-evidence-matrix.mts';
import { auditResponsive } from './responsive-audit.mts';
import { auditRuntimeResilience } from './runtime-resilience-audit.mts';
import { auditSecurity } from './security-audit.mts';
import { auditValidationIntegrity } from './validation-integrity-audit.mts';
import { auditWorkflowEvidence } from './workflow-evidence-audit.mts';
import { scanSource } from './source-audit.mts';
import { auditTestContracts } from './test-contracts.mts';
import { auditUx } from './ux-audit.mts';

export interface ReleaseEngineOptions {
  readonly thresholds?: Partial<ReleaseThresholds>;
}

export interface ReleaseExecution {
  readonly report: ReleaseReport;
  readonly baseline?: BaselineSnapshot;
  readonly regression?: RegressionDelta;
}

function mergedThresholds(overrides?: Partial<ReleaseThresholds>): ReleaseThresholds {
  return { ...DEFAULT_THRESHOLDS, ...(overrides ?? {}) };
}

function flattenFindings(sections: readonly AuditSection<unknown>[]): Finding[] {
  return stableSortFindings(dedupeFindings(sections.flatMap(section => section.findings)));
}

function blockingIds(findings: readonly Finding[]): string[] {
  return findings
    .filter(finding => finding.blocking === true)
    .map(findingKey)
    .sort((a, b) => a.localeCompare(b, 'en'));
}

function decisionReasons(
  findings: readonly Finding[],
  counts: SeverityCounts,
  score: number,
  thresholds: ReleaseThresholds,
): string[] {
  const reasons: string[] = [];
  const explicitBlocking = findings.filter(finding => finding.blocking === true);
  if (explicitBlocking.length > 0) reasons.push(`${explicitBlocking.length} explicitly blocking finding(s) detected.`);
  if (thresholds.blockOnCritical && counts.critical > 0) reasons.push(`${counts.critical} critical finding(s) detected.`);
  if (counts.high > thresholds.maxHighFindings) reasons.push(`High findings ${counts.high} exceed threshold ${thresholds.maxHighFindings}.`);
  if (counts.medium > thresholds.maxMediumFindings) reasons.push(`Medium findings ${counts.medium} exceed threshold ${thresholds.maxMediumFindings}.`);
  if (score > thresholds.maxRiskScore) reasons.push(`Risk score ${score} exceeds threshold ${thresholds.maxRiskScore}.`);
  return reasons;
}

export function decideReleaseGate(
  findings: readonly Finding[],
  thresholds: ReleaseThresholds = DEFAULT_THRESHOLDS,
): ReleaseGateDecision {
  const counts = countSeverities(findings);
  const score = riskScore(findings);
  const reasons = decisionReasons(findings, counts, score, thresholds);
  const explicitBlocking = findings.some(finding => finding.blocking === true);
  const criticalBlocked = thresholds.blockOnCritical && counts.critical > 0;
  const highBlocked = counts.high > thresholds.maxHighFindings;
  const mediumBlocked = counts.medium > thresholds.maxMediumFindings;
  const scoreBlocked = score > thresholds.maxRiskScore;
  const state = explicitBlocking || criticalBlocked || highBlocked || mediumBlocked || scoreBlocked
    ? 'block'
    : findings.some(finding => finding.severity === 'high' || finding.severity === 'medium')
      ? 'review'
      : 'pass';
  return {
    state,
    reasons,
    riskScore: score,
    counts,
    blockingFindingIds: blockingIds(findings),
  };
}

function stableSerializable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSerializable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, nested]) => [key, stableSerializable(nested)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableSerializable(value));
}

export function fingerprintReportData(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function reportFingerprint(
  context: ReleaseContext,
  inventory: RepositoryInventory,
  findings: readonly Finding[],
): string {
  const payload = {
    repository: context.repository,
    commit: context.commit ?? null,
    totalFiles: inventory.totalFiles,
    totalLines: inventory.totalLines,
    findings: findings.map(snapshotFinding),
  };
  return fingerprintReportData(payload);
}

export function createBaseline(report: ReleaseReport): BaselineSnapshot {
  return {
    schemaVersion: 1,
    ...(report.context.commit ? { commit: report.context.commit } : {}),
    generatedAt: report.context.generatedAt,
    fingerprint: report.fingerprint,
    findings: report.findings.map(snapshotFinding),
    counts: report.decision.counts,
    riskScore: report.decision.riskScore,
  };
}

function snapshotMap(findings: readonly FindingSnapshot[]): Map<string, FindingSnapshot> {
  return new Map(findings.map(finding => [finding.key, finding]));
}

function emptySeverityDelta(): Record<Severity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

export function compareBaseline(report: ReleaseReport, baseline: BaselineSnapshot): RegressionDelta {
  const current = report.findings.map(snapshotFinding);
  const currentMap = snapshotMap(current);
  const baselineMap = snapshotMap(baseline.findings);
  const added = current.filter(finding => !baselineMap.has(finding.key));
  const removed = baseline.findings.filter(finding => !currentMap.has(finding.key));
  const unchanged = current.filter(finding => baselineMap.has(finding.key));
  const severityDelta = emptySeverityDelta();
  for (const severity of SEVERITIES) {
    severityDelta[severity] = report.decision.counts[severity] - baseline.counts[severity];
  }
  return {
    added,
    removed,
    unchanged,
    riskScoreDelta: report.decision.riskScore - baseline.riskScore,
    severityDelta,
  };
}

export function regressionFindings(delta: RegressionDelta): Finding[] {
  const findings: Finding[] = [];
  const newCritical = delta.added.filter(item => item.severity === 'critical');
  const newHigh = delta.added.filter(item => item.severity === 'high');
  if (newCritical.length > 0) {
    findings.push({
      id: 'release-new-critical-regression',
      domain: 'release',
      severity: 'critical',
      title: 'New critical release regression',
      message: `${newCritical.length} critical finding(s) are new compared with the baseline.`,
      evidence: { value: newCritical.map(item => item.key).join('\n') },
      remediation: 'Resolve the new critical findings before release.',
      blocking: true,
    });
  }
  if (newHigh.length > 0) {
    findings.push({
      id: 'release-new-high-regression',
      domain: 'release',
      severity: 'high',
      title: 'New high-severity release regression',
      message: `${newHigh.length} high finding(s) are new compared with the baseline.`,
      evidence: { value: newHigh.map(item => item.key).join('\n') },
      remediation: 'Fix or explicitly review the new high-severity findings before release.',
    });
  }
  if (delta.riskScoreDelta > 100) {
    findings.push({
      id: 'release-risk-score-regression',
      domain: 'release',
      severity: 'high',
      title: 'Static release risk increased materially',
      message: `Risk score increased by ${delta.riskScoreDelta} relative to baseline.`,
      evidence: { value: delta.riskScoreDelta },
      remediation: 'Inspect the added findings and reduce the regression before release.',
    });
  }
  return findings;
}

export async function runReleaseEngine(
  inventory: RepositoryInventory,
  context: ReleaseContext,
  options: ReleaseEngineOptions = {},
  baseline?: BaselineSnapshot,
): Promise<ReleaseExecution> {
  const thresholds = mergedThresholds(options.thresholds);
  const sections: AuditSection<unknown>[] = [
    auditModernization(inventory),
    auditLanguageModernization(inventory),
    scanSource(inventory),
    auditSecurity(inventory),
    auditBackendSecurity(inventory),
    auditDependencies(inventory),
    auditCiIntegrity(inventory),
    auditWorkflowEvidence(inventory),
    auditReleaseEvidenceMatrix(inventory),
    auditValidationIntegrity(inventory),
    auditNetwork(inventory),
    auditGis(inventory),
    auditGisReleaseContracts(inventory),
    auditUx(inventory),
    auditAccessibility(inventory),
    auditResponsive(inventory),
    auditPerformance(inventory),
    auditDataIntegrity(inventory),
    auditRuntimeResilience(inventory),
    auditObservability(inventory),
    auditTestContracts(inventory),
  ];

  let findings = flattenFindings(sections);
  let decision = decideReleaseGate(findings, thresholds);
  let report: ReleaseReport = {
    schemaVersion: 1,
    context,
    inventory,
    sections,
    findings,
    decision,
    fingerprint: reportFingerprint(context, inventory, findings),
  };

  if (!baseline) return { report };
  const regression = compareBaseline(report, baseline);
  const regressionSectionFindings = regressionFindings(regression);
  if (regressionSectionFindings.length > 0) {
    const releaseSection: AuditSection<{ regression: RegressionDelta }> = {
      domain: 'release',
      title: 'Baseline release regression delta',
      summary: { regression },
      findings: regressionSectionFindings,
      elapsedMs: 0,
    };
    sections.push(releaseSection);
    findings = flattenFindings(sections);
    decision = decideReleaseGate(findings, thresholds);
    report = {
      ...report,
      sections,
      findings,
      decision,
      fingerprint: reportFingerprint(context, inventory, findings),
    };
  }
  return { report, baseline, regression };
}

function findingLine(finding: Finding): string {
  const location = finding.location ? `${finding.location.file}:${finding.location.line}` : 'repository';
  return `- **${finding.severity.toUpperCase()}** \`${finding.id}\` — ${finding.title} (${location})`;
}

function countsLine(counts: SeverityCounts): string {
  return `critical=${counts.critical}, high=${counts.high}, medium=${counts.medium}, low=${counts.low}, info=${counts.info}`;
}

export function releaseReportMarkdown(execution: ReleaseExecution): string {
  const { report, regression } = execution;
  const lines: string[] = [
    '# Kent Rehberi — Typed Release QA',
    '',
    `- Repository: \`${report.context.repository}\``,
    `- Branch: \`${report.context.branch ?? 'unknown'}\``,
    `- Commit: \`${report.context.commit ?? 'unknown'}\``,
    `- Generated: ${report.context.generatedAt}`,
    `- Files: ${report.inventory.totalFiles}`,
    `- Lines: ${report.inventory.totalLines}`,
    `- Gate: **${report.decision.state.toUpperCase()}**`,
    `- Risk score: ${report.decision.riskScore}`,
    `- Findings: ${countsLine(report.decision.counts)}`,
    `- Fingerprint: \`${report.fingerprint}\``,
    '',
    '## Sections',
    '',
  ];
  for (const section of report.sections) {
    lines.push(`### ${section.title}`);
    lines.push('');
    lines.push(`- Domain: ${section.domain}`);
    lines.push(`- Findings: ${section.findings.length}`);
    lines.push(`- Elapsed: ${section.elapsedMs.toFixed(1)} ms`);
    lines.push('');
  }
  if (report.decision.reasons.length > 0) {
    lines.push('## Gate reasons', '');
    for (const reason of report.decision.reasons) lines.push(`- ${reason}`);
    lines.push('');
  }
  if (regression) {
    lines.push('## Baseline delta', '');
    lines.push(`- Added findings: ${regression.added.length}`);
    lines.push(`- Removed findings: ${regression.removed.length}`);
    lines.push(`- Unchanged findings: ${regression.unchanged.length}`);
    lines.push(`- Risk-score delta: ${regression.riskScoreDelta}`);
    lines.push('');
  }
  lines.push('## Findings', '');
  if (report.findings.length === 0) lines.push('No static release findings.');
  else for (const finding of report.findings) lines.push(findingLine(finding));
  lines.push('');
  return `${lines.join('\n')}\n`;
}
