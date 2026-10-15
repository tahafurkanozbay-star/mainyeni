import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';

/** CI uploads must never expose the raw release-report.json inventory. */
export interface ReleaseArtifactPrivacySummary {
  readonly workflowFiles: number;
  readonly uploadSteps: number;
  readonly releaseUploadSteps: number;
  readonly safeReleasePaths: number;
  readonly unsafeReleasePaths: number;
}
interface UploadStep {
  readonly file: string;
  readonly line: number;
  readonly paths: readonly string[];
  readonly artifactName: string | null;
}
const WORKFLOW = /^\.github\/workflows\/[^/]+\.(?:yaml|yml)$/i;
const UPLOAD = /^\s*uses:\s*['"]?actions\/upload-artifact@/i;
const PATH_FIELD = /^(\s*)path:\s*(.*)$/;
const RELEASE_ROOT = /(?:^|\/)qa-artifacts\/release(?:\/|$)/i;
const CANONICAL_RELEASE_ARTIFACT = /^typed-release-qa(?:$|[-_])/i;
const APPROVED = new Set([
  'qa-artifacts/release/release-report.md',
  'qa-artifacts/release/pr-regression-gate.md',
  'qa-artifacts/release/*.md',
]);
function indentation(line: string): number {
  return /^\s*/.exec(line)?.[0].length ?? 0;
}
function cleanPath(value: string): string {
  return value.trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/^\.\/+/, '')
    .replace(/\\/g, '/');
}
function readPaths(lines: readonly string[], field: number): readonly string[] {
  const match = PATH_FIELD.exec(lines[field] ?? '');
  if (!match) return [];
  const inline = (match[2] ?? '').trim();
  if (inline && !/^[|>][-+0-9]*$/.test(inline)) {
    return inline.split(/\s+/).map(cleanPath).filter(Boolean);
  }
  const indent = (match[1] ?? '').length;
  const result: string[] = [];
  for (let index = field + 1; index < lines.length && result.length < 128; index += 1) {
    const line = lines[index] ?? '';
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (indentation(line) <= indent) break;
    const path = cleanPath(line.replace(/\s+#.*$/, ''));
    if (path) result.push(path);
  }
  return result;
}
function collectUploadSteps(file: SourceFile): readonly UploadStep[] {
  const lines = file.text.split(/\r?\n/);
  const steps: UploadStep[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!UPLOAD.test(lines[index] ?? '')) continue;
    const useIndent = indentation(lines[index] ?? '');
    const markerIndent = Math.max(0, useIndent - 2);
    let start = index;
    while (start > 0 && index - start < 48) {
      const line = lines[start - 1] ?? '';
      if (/^\s*-\s+(?:name|id|uses|run):/.test(line) &&
          indentation(line) <= markerIndent) break;
      start -= 1;
    }
    let end = index + 1;
    while (end < lines.length && end - index < 64) {
      const line = lines[end] ?? '';
      if (/^\s*-\s+(?:name|id|uses|run):/.test(line) &&
          indentation(line) <= markerIndent) break;
      end += 1;
    }
    const stepLines = lines.slice(start, end);
    const paths = stepLines.flatMap((line, at) =>
      PATH_FIELD.test(line) ? readPaths(stepLines, at) : []);
    const withIndex = stepLines.findIndex(line => /^\s*with:\s*$/.test(line));
    let artifactName: string | null = null;
    if (withIndex >= 0) {
      const withIndent = indentation(stepLines[withIndex] ?? '');
      for (let at = withIndex + 1; at < stepLines.length; at += 1) {
        const line = stepLines[at] ?? '';
        if (!line.trim() || line.trim().startsWith('#')) continue;
        if (indentation(line) <= withIndent) break;
        const nameMatch = /^\s*name:\s*(.*?)\s*$/.exec(line);
        if (nameMatch) {
          artifactName = (nameMatch[1] ?? '').replace(/^['"]|['"]$/g, '');
          break;
        }
      }
    }
    steps.push({ file: file.repositoryPath, line: index + 1, paths, artifactName });
  }
  return steps;
}
function isUnsafeReleasePath(path: string): boolean {
  if (!RELEASE_ROOT.test(path)) return false;
  if (path.split('/').includes('..')) return true;
  return !APPROVED.has(path);
}
function finding(step: UploadStep): Finding {
  return {
    id: 'qa-release-artifact-sensitive-upload',
    domain: 'security',
    severity: 'high',
    title: 'Release QA artifact upload can disclose private evidence',
    message: 'Raw inventories and JSON finding keys must not leave the ephemeral release job.',
    location: { file: step.file, line: step.line },
    evidence: { metadata: { reason: 'unreviewed-release-artifact-path' } },
    remediation: 'Publish only the reviewed release-report.md and pr-regression-gate.md summaries.',
    tags: ['ci', 'release', 'privacy', 'artifact-minimization'],
  };
}
export function auditReleaseArtifactPrivacy(
  inventory: RepositoryInventory,
): AuditSection<ReleaseArtifactPrivacySummary> {
  const started = performance.now();
  const workflows = inventory.files.filter(file =>
    WORKFLOW.test(file.repositoryPath) && file.kind === 'yaml');
  const uploads = workflows.flatMap(collectUploadSteps);
  const findings: Finding[] = [];
  let releaseUploadSteps = 0;
  let safeReleasePaths = 0;
  let unsafeReleasePaths = 0;
  for (const step of uploads) {
    const releasePaths = step.paths.filter(path => RELEASE_ROOT.test(path));
    const namedReleaseUpload = CANONICAL_RELEASE_ARTIFACT.test(step.artifactName ?? '');
    if (!releasePaths.length && !namedReleaseUpload) continue;
    releaseUploadSteps += 1;
    const unsafe = releasePaths.filter(isUnsafeReleasePath);
    safeReleasePaths += releasePaths.length - unsafe.length;
    // A known release artifact uploader with no literal approved source
    // must fail closed; a dynamic env/path expression cannot establish safety.
    const missingApprovedSource = namedReleaseUpload && releasePaths.length === 0;
    unsafeReleasePaths += unsafe.length + (missingApprovedSource ? 1 : 0);
    if (unsafe.length || missingApprovedSource) findings.push(finding(step));
  }
  return {
    domain: 'security',
    title: 'Release artifact data-minimization boundary',
    summary: { workflowFiles: workflows.length, uploadSteps: uploads.length,
      releaseUploadSteps, safeReleasePaths, unsafeReleasePaths },
    findings: stableSortFindings(findings),
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
