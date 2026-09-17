import { stableSortFindings, type AuditSection, type Finding, type RepositoryInventory, type SourceFile } from './contracts.mts';

export interface CiIntegritySignal {
  readonly file: string;
  readonly pullRequestTrigger: boolean;
  readonly explicitPermissions: boolean;
  readonly jobTimeouts: number;
  readonly actionReferences: number;
  readonly npmCiCommands: number;
  readonly dependencyChecks: number;
  readonly buildChecks: number;
  readonly testChecks: number;
  readonly typeChecks: number;
  readonly artifactUploads: number;
}

export interface CiIntegritySummary {
  readonly workflowFiles: number;
  readonly releaseWorkflowFiles: number;
  readonly signals: readonly CiIntegritySignal[];
  readonly findings: readonly Finding[];
}

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const RELEASE_HINT = /release|quality|audit|build|test/i;
function count(text: string, pattern: RegExp): number { return [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))].length; }
function isWorkflow(file: SourceFile): boolean { return WORKFLOW_PATH.test(file.repositoryPath); }
function isRelease(file: SourceFile): boolean { return RELEASE_HINT.test(file.repositoryPath) || RELEASE_HINT.test(/^name:\s*([^\r\n]+)/m.exec(file.text)?.[1] ?? ''); }
function signal(file: SourceFile): CiIntegritySignal {
  return {
    file: file.repositoryPath,
    pullRequestTrigger: /^\s*pull_request:\s*$/m.test(file.text),
    explicitPermissions: /^permissions:\s*$/m.test(file.text),
    jobTimeouts: count(file.text, /^\s*timeout-minutes:\s*\d+/gmi),
    actionReferences: count(file.text, /^\s*-?\s*uses:\s*[^\s#]+/gmi),
    npmCiCommands: count(file.text, /\bnpm\s+ci\b/g),
    dependencyChecks: count(file.text, /\bnpm\s+audit\b|dependency[^\r\n]*(?:audit|verify)|\bvulnerable\b/gi),
    buildChecks: count(file.text, /\b(?:npm\s+(?:run\s+)?build|dotnet\s+(?:build|publish))\b/gi),
    testChecks: count(file.text, /\b(?:node\s+--test|vitest\s+run|npm\s+(?:run\s+)?test|dotnet\s+(?:test|run))\b/gi),
    typeChecks: count(file.text, /\btsc\b|typecheck/gi),
    artifactUploads: count(file.text, /actions\/upload-artifact@/gi),
  };
}
function finding(file: SourceFile, id: string, severity: Finding['severity'], title: string, message: string, remediation: string, blocking = false): Finding {
  return { id, domain: 'release', severity, title, message, location: { file: file.repositoryPath, line: 1 }, remediation, tags: ['ci', 'release'], ...(blocking ? { blocking: true } : {}) };
}
function auditFile(file: SourceFile, item: CiIntegritySignal): Finding[] {
  const findings: Finding[] = [];
  if (isRelease(file) && !item.pullRequestTrigger) findings.push(finding(file, 'ci-pr-validation-missing', 'high', 'Release workflow lacks pull-request validation', 'Release-oriented CI should execute against pull-request heads before integration.', 'Add pull_request execution and retain exact base/head evidence.', true));
  if (!item.explicitPermissions) findings.push(finding(file, 'ci-permissions-implicit', 'medium', 'Workflow permissions are implicit', 'Validation workflows should declare their repository permissions explicitly.', 'Declare least-privilege top-level permissions.'));
  if (isRelease(file) && item.jobTimeouts === 0) findings.push(finding(file, 'ci-timeout-contract-missing', 'medium', 'Release workflow lacks job timeouts', 'Release jobs should have bounded execution time so stalled tooling cannot occupy runners indefinitely.', 'Set timeout-minutes on release validation jobs.'));
  if (isRelease(file) && item.dependencyChecks === 0) findings.push(finding(file, 'ci-dependency-check-missing', 'medium', 'Release workflow lacks dependency verification', 'Release validation should verify active dependency ecosystems for policy and vulnerability regressions.', 'Add ecosystem-appropriate dependency verification.'));
  if (isRelease(file) && item.buildChecks === 0) findings.push(finding(file, 'ci-build-evidence-missing', 'high', 'Release workflow lacks build evidence', 'A release gate should prove that production artifacts compile or publish successfully.', 'Run the authoritative production build or publish command.'));
  if (isRelease(file) && item.testChecks === 0) findings.push(finding(file, 'ci-test-evidence-missing', 'high', 'Release workflow lacks executable regression tests', 'A release gate should execute automated regression tests rather than relying on static inspection alone.', 'Run the authoritative unit and regression suites.'));
  return findings;
}
export function auditCiIntegrity(inventory: RepositoryInventory): AuditSection<CiIntegritySummary> {
  const started = performance.now();
  const files = inventory.files.filter(isWorkflow);
  const signals = files.map(signal);
  const findings = stableSortFindings(files.flatMap((file, index) => auditFile(file, signals[index] ?? signal(file))));
  return { domain: 'release', title: 'CI integrity and release evidence audit', summary: { workflowFiles: files.length, releaseWorkflowFiles: files.filter(isRelease).length, signals, findings }, findings, elapsedMs: performance.now() - started };
}
