import { createHash } from 'node:crypto';
import type {
  AuditDomain,
  ReleaseReport,
  Severity,
  SeverityCounts,
} from './contracts.mts';

export interface PublicRuleAggregate {
  readonly domain: AuditDomain;
  readonly severity: Severity;
  readonly ruleId: string;
  readonly count: number;
}
export interface PublicReleaseEvidence {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly commit: string;
  readonly generatedAt: string;
  readonly gate: 'pass' | 'review' | 'block';
  readonly riskScore: number;
  readonly counts: SeverityCounts;
  readonly inventory: {
    readonly files: number;
    readonly lines: number;
    readonly bytes: number;
  };
  readonly sectionsByDomain: Readonly<Record<string, number>>;
  readonly issueGroups: readonly PublicRuleAggregate[];
  readonly omittedGroups: number;
  readonly fingerprint: string;
}

function boundedNonnegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value)))
    : 0;
}
function safeRuleId(value: unknown): string {
  if (typeof value !== 'string') return 'unknown-rule';
  const text = value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 96);
  return text || 'unknown-rule';
}
function safeRepository(value: unknown): string {
  return typeof value === 'string' &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
    ? value.slice(0, 160)
    : 'unknown/repository';
}
function safeCommit(value: unknown): string {
  return typeof value === 'string' && /^[a-fA-F0-9]{7,64}$/.test(value)
    ? value
    : 'unknown';
}
function safeTimestamp(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'unknown';
  const canonical = new Date(parsed).toISOString();
  return canonical === value ? canonical : 'unknown';
}
function countSeverities(report: ReleaseReport): SeverityCounts {
  const input = report.decision.counts;
  return {
    critical: boundedNonnegative(input.critical),
    high: boundedNonnegative(input.high),
    medium: boundedNonnegative(input.medium),
    low: boundedNonnegative(input.low),
    info: boundedNonnegative(input.info),
  };
}
function publicIssueAggregates(report: ReleaseReport): {
  groups: readonly PublicRuleAggregate[];
  omittedGroups: number;
} {
  const counts = new Map<string, PublicRuleAggregate>();
  for (const item of report.findings) {
    const ruleId = safeRuleId(item.id);
    const key = [item.domain, item.severity, ruleId].join('|');
    const existing = counts.get(key);
    counts.set(key, {
      domain: item.domain,
      severity: item.severity,
      ruleId,
      count: boundedNonnegative((existing?.count ?? 0) + 1),
    });
  }
  const sorted = [...counts.values()].sort((a, b) =>
    a.domain.localeCompare(b.domain, 'en') ||
    a.severity.localeCompare(b.severity, 'en') ||
    a.ruleId.localeCompare(b.ruleId, 'en'));
  return {
    groups: sorted.slice(0, 512),
    omittedGroups: Math.max(0, sorted.length - 512),
  };
}
function domainSections(report: ReleaseReport): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const section of report.sections) {
    counts[section.domain] = boundedNonnegative((counts[section.domain] ?? 0) + 1);
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b, 'en')));
}

/**
 * Create a source- and payload-free JSON contract suitable for publishing.
 * Never copy inventory.files, sections.summary, evidence, request URLs,
 * line snippets, baseline keys, branch names or backend error descriptions.
 */
export function publicReleaseEvidence(report: ReleaseReport): PublicReleaseEvidence {
  const issues = publicIssueAggregates(report);
  const publicFields = {
    schemaVersion: 1 as const,
    repository: safeRepository(report.context.repository),
    commit: safeCommit(report.context.commit),
    generatedAt: safeTimestamp(report.context.generatedAt),
    gate: report.decision.state,
    riskScore: boundedNonnegative(report.decision.riskScore),
    counts: countSeverities(report),
    inventory: {
      files: boundedNonnegative(report.inventory.totalFiles),
      lines: boundedNonnegative(report.inventory.totalLines),
      bytes: boundedNonnegative(report.inventory.totalBytes),
    },
    sectionsByDomain: domainSections(report),
    issueGroups: issues.groups,
    omittedGroups: issues.omittedGroups,
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(publicFields))
    .digest('hex');
  return { ...publicFields, fingerprint };
}
