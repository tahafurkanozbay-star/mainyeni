import { snapshotFinding, type ReleaseReport } from './contracts.mts';

/**
 * The full in-memory release report holds source text, URL query values and
 * unbounded audit summaries. None of that belongs in uploaded CI artifacts.
 *
 * Return a deliberately allowlisted shape so new audit sections cannot leak
 * source snippets or request payloads by adding summary/evidence properties.
 */
export function releaseReportArtifact(report: ReleaseReport) {
  return {
    schemaVersion: report.schemaVersion,
    context: report.context,
    inventory: {
      totalFiles: report.inventory.totalFiles,
      totalLines: report.inventory.totalLines,
      totalBytes: report.inventory.totalBytes,
      languageStats: report.inventory.languageStats,
    },
    sections: report.sections.map(section => ({
      domain: section.domain,
      title: section.title,
      findingCount: section.findings.length,
      elapsedMs: section.elapsedMs,
    })),
    findings: report.findings.map(snapshotFinding),
    decision: report.decision,
    fingerprint: report.fingerprint,
  };
}
