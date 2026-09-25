import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import {
  CHANGE_RISK_POLICIES,
  areaEvidencePaths,
  classifyRiskAreas,
  compareManifestDependencies,
  isDocumentationPath,
  isPackageLockPath,
  isPackageManifestPath,
  isProductionCandidatePath,
  isReleaseCriticalValidationPath,
  isReleaseValidationPath,
  isTestPath,
  packageLockCandidates,
  pathNature,
  policyForArea,
  testSupportsArea,
  type ChangeRiskArea,
} from './change-risk-policy.mts';

export type RepositoryChangeKind = 'added' | 'removed' | 'modified' | 'renamed';

export interface RepositoryChange {
  readonly kind: RepositoryChangeKind;
  readonly path: string;
  readonly previousPath?: string;
  readonly before?: SourceFile;
  readonly after?: SourceFile;
  readonly production: boolean;
  readonly test: boolean;
  readonly documentation: boolean;
  readonly releaseValidation: boolean;
  readonly areas: readonly ChangeRiskArea[];
  readonly lineDelta: number;
  readonly byteDelta: number;
}

export interface ChangeAreaCoverage {
  readonly area: ChangeRiskArea;
  readonly changedProductionFiles: readonly string[];
  readonly changedEvidenceFiles: readonly string[];
  readonly covered: boolean;
  readonly requiresFocusedEvidence: boolean;
}

export interface ChangeRiskSummary {
  readonly changeCount: number;
  readonly added: number;
  readonly removed: number;
  readonly modified: number;
  readonly renamed: number;
  readonly productionChanges: number;
  readonly testChanges: number;
  readonly documentationChanges: number;
  readonly releaseValidationChanges: number;
  readonly changedAreas: readonly ChangeRiskArea[];
  readonly areaCoverage: readonly ChangeAreaCoverage[];
  readonly deletedTests: readonly string[];
  readonly deletedCriticalValidation: readonly string[];
  readonly dependencyManifestChanges: readonly string[];
  readonly dependencyLockChanges: readonly string[];
  readonly crossDomainBreadth: number;
  readonly netLineDelta: number;
  readonly netByteDelta: number;
}

export interface ChangeRiskAuditOptions {
  readonly requireFocusedEvidence?: boolean;
  readonly broadChangeAreaThreshold?: number;
  readonly broadChangeProductionThreshold?: number;
}

interface ChangePairing {
  readonly added: SourceFile[];
  readonly removed: SourceFile[];
  readonly renamed: RepositoryChange[];
}

function fileMap(inventory: RepositoryInventory): Map<string, SourceFile> {
  return new Map(inventory.files.map(file => [file.repositoryPath, file]));
}

function sameFile(left: SourceFile, right: SourceFile): boolean {
  return left.kind === right.kind && left.text === right.text;
}

function renameKey(file: SourceFile): string {
  return `${file.kind}\u0000${file.bytes}\u0000${file.text}`;
}

function pairExactRenames(addedInput: readonly SourceFile[], removedInput: readonly SourceFile[]): ChangePairing {
  const added = [...addedInput];
  const removed = [...removedInput];
  const addedByKey = new Map<string, SourceFile[]>();
  for (const file of added) {
    const key = renameKey(file);
    const bucket = addedByKey.get(key) ?? [];
    bucket.push(file);
    addedByKey.set(key, bucket);
  }

  const renamed: RepositoryChange[] = [];
  const consumedAdded = new Set<string>();
  const consumedRemoved = new Set<string>();

  for (const before of removed) {
    const bucket = addedByKey.get(renameKey(before));
    const after = bucket?.find(candidate => !consumedAdded.has(candidate.repositoryPath));
    if (!after) continue;
    consumedAdded.add(after.repositoryPath);
    consumedRemoved.add(before.repositoryPath);
    const areas = new Set<ChangeRiskArea>([
      ...classifyRiskAreas(before.repositoryPath, before.text),
      ...classifyRiskAreas(after.repositoryPath, after.text),
    ]);
    renamed.push({
      kind: 'renamed',
      path: after.repositoryPath,
      previousPath: before.repositoryPath,
      before,
      after,
      production: isProductionCandidatePath(after.repositoryPath) || isProductionCandidatePath(before.repositoryPath),
      test: isTestPath(after.repositoryPath) || isTestPath(before.repositoryPath),
      documentation: isDocumentationPath(after.repositoryPath) || isDocumentationPath(before.repositoryPath),
      releaseValidation: isReleaseValidationPath(after.repositoryPath) || isReleaseValidationPath(before.repositoryPath),
      areas: [...areas].sort((left, right) => left.localeCompare(right, 'en')),
      lineDelta: after.lines - before.lines,
      byteDelta: after.bytes - before.bytes,
    });
  }

  return {
    added: added.filter(file => !consumedAdded.has(file.repositoryPath)),
    removed: removed.filter(file => !consumedRemoved.has(file.repositoryPath)),
    renamed: renamed.sort((left, right) => left.path.localeCompare(right.path, 'en')),
  };
}

function changeFromSingle(kind: 'added' | 'removed', file: SourceFile): RepositoryChange {
  const after = kind === 'added' ? file : undefined;
  const before = kind === 'removed' ? file : undefined;
  const text = file.text;
  const path = file.repositoryPath;
  return {
    kind,
    path,
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    production: isProductionCandidatePath(path),
    test: isTestPath(path),
    documentation: isDocumentationPath(path),
    releaseValidation: isReleaseValidationPath(path),
    areas: classifyRiskAreas(path, text),
    lineDelta: kind === 'added' ? file.lines : -file.lines,
    byteDelta: kind === 'added' ? file.bytes : -file.bytes,
  };
}

function changeFromModified(before: SourceFile, after: SourceFile): RepositoryChange {
  const areas = new Set<ChangeRiskArea>([
    ...classifyRiskAreas(before.repositoryPath, before.text),
    ...classifyRiskAreas(after.repositoryPath, after.text),
  ]);
  return {
    kind: 'modified',
    path: after.repositoryPath,
    before,
    after,
    production: isProductionCandidatePath(after.repositoryPath),
    test: isTestPath(after.repositoryPath),
    documentation: isDocumentationPath(after.repositoryPath),
    releaseValidation: isReleaseValidationPath(after.repositoryPath),
    areas: [...areas].sort((left, right) => left.localeCompare(right, 'en')),
    lineDelta: after.lines - before.lines,
    byteDelta: after.bytes - before.bytes,
  };
}

export function collectRepositoryChanges(
  baseline: RepositoryInventory,
  current: RepositoryInventory,
): readonly RepositoryChange[] {
  const baselineFiles = fileMap(baseline);
  const currentFiles = fileMap(current);
  const modified: RepositoryChange[] = [];
  const added: SourceFile[] = [];
  const removed: SourceFile[] = [];

  for (const [path, after] of currentFiles) {
    const before = baselineFiles.get(path);
    if (!before) {
      added.push(after);
      continue;
    }
    if (!sameFile(before, after)) modified.push(changeFromModified(before, after));
  }

  for (const [path, before] of baselineFiles) {
    if (!currentFiles.has(path)) removed.push(before);
  }

  const pairing = pairExactRenames(added, removed);
  const changes = [
    ...modified,
    ...pairing.renamed,
    ...pairing.added.map(file => changeFromSingle('added', file)),
    ...pairing.removed.map(file => changeFromSingle('removed', file)),
  ];
  return changes.sort((left, right) =>
    left.path.localeCompare(right.path, 'en') || left.kind.localeCompare(right.kind, 'en'));
}

function changedPaths(changes: readonly RepositoryChange[]): readonly string[] {
  const paths = new Set<string>();
  for (const change of changes) {
    paths.add(change.path);
    if (change.previousPath) paths.add(change.previousPath);
  }
  return [...paths].sort((left, right) => left.localeCompare(right, 'en'));
}

function finding(
  id: string,
  domain: Finding['domain'],
  severity: Finding['severity'],
  title: string,
  message: string,
  path: string | undefined,
  evidence: string | undefined,
  remediation: string,
  tags: readonly string[],
  blocking = false,
): Finding {
  return {
    id,
    domain,
    severity,
    title,
    message,
    ...(path ? { location: { file: path, line: 1 } } : {}),
    ...(evidence ? { evidence: { excerpt: evidence } } : {}),
    remediation,
    tags,
    ...(blocking ? { blocking: true } : {}),
  };
}

function areaCoverage(changes: readonly RepositoryChange[]): readonly ChangeAreaCoverage[] {
  const paths = changedPaths(changes);
  const coverage: ChangeAreaCoverage[] = [];
  for (const policy of CHANGE_RISK_POLICIES) {
    const production = changes
      .filter(change => change.production && change.kind !== 'renamed' && change.areas.includes(policy.area))
      .map(change => change.path)
      .sort((left, right) => left.localeCompare(right, 'en'));
    if (production.length === 0) continue;
    const evidence = areaEvidencePaths(paths, policy.area);
    coverage.push({
      area: policy.area,
      changedProductionFiles: production,
      changedEvidenceFiles: evidence,
      covered: evidence.length > 0,
      requiresFocusedEvidence: policy.requiresFocusedEvidence,
    });
  }
  return coverage.sort((left, right) => left.area.localeCompare(right.area, 'en'));
}

function uncoveredAreaFindings(
  coverage: readonly ChangeAreaCoverage[],
  requireFocusedEvidence: boolean,
): Finding[] {
  const findings: Finding[] = [];
  for (const item of coverage) {
    const policy = policyForArea(item.area);
    if (item.covered) continue;
    if (!policy.requiresFocusedEvidence && !requireFocusedEvidence) continue;
    const path = item.changedProductionFiles[0];
    findings.push(finding(
      `change-risk-${item.area}-evidence-missing`,
      policy.domain,
      policy.uncoveredSeverity,
      policy.title,
      `${item.changedProductionFiles.length} ${item.area} production file(s) changed without a changed focused test or validation contract that owns this risk area.`,
      path,
      item.changedProductionFiles.slice(0, 8).join('\n'),
      `Add or update focused ${item.area} regression tests/validation alongside the behavior change. Do not satisfy this gate with unrelated tests.`,
      ['change-risk', item.area, 'exact-base', 'test-evidence'],
      policy.blockingWhenUncovered === true,
    ));
  }
  return findings;
}

function criticalValidationDeletionFindings(changes: readonly RepositoryChange[]): Finding[] {
  return changes
    .filter(change => change.kind === 'removed' && isReleaseCriticalValidationPath(change.path))
    .map(change => finding(
      'change-risk-critical-validation-removed',
      'release',
      'critical',
      'Release-critical validation authority was removed',
      `The exact-base change set deletes release-critical validation file ${change.path}.`,
      change.path,
      change.path,
      'Restore the validation authority or replace it with an explicitly equivalent gate and focused regression coverage in the same change set.',
      ['change-risk', 'release', 'validation', 'deletion'],
      true,
    ));
}

function deletedTestFindings(changes: readonly RepositoryChange[]): Finding[] {
  const removedTests = changes.filter(change => change.kind === 'removed' && change.test);
  if (removedTests.length === 0) return [];

  const addedTests = changes.filter(change => change.kind === 'added' && change.test);
  const findings: Finding[] = [];
  for (const removed of removedTests) {
    const beforeAreas = CHANGE_RISK_POLICIES
      .filter(policy => testSupportsArea(removed.path, policy.area))
      .map(policy => policy.area);
    const replacement = addedTests.some(added =>
      beforeAreas.some(area => testSupportsArea(added.path, area)) ||
      added.path.split('/').at(-1) === removed.path.split('/').at(-1));
    if (replacement) continue;
    findings.push(finding(
      'change-risk-test-deleted-without-replacement',
      'testing',
      'high',
      'Regression test was deleted without visible replacement',
      `Test file ${removed.path} is removed and no added test in the same risk area is visible in the exact-base change set.`,
      removed.path,
      removed.path,
      'Preserve the regression coverage, move it as an exact-content rename, or add an equivalent focused replacement test.',
      ['change-risk', 'testing', 'deletion', 'coverage'],
    ));
  }
  return findings;
}

function dependencyManifestFindings(
  changes: readonly RepositoryChange[],
  baseline: RepositoryInventory,
  current: RepositoryInventory,
): Finding[] {
  const baselineFiles = fileMap(baseline);
  const currentFiles = fileMap(current);
  const changed = new Set(changedPaths(changes));
  const findings: Finding[] = [];

  for (const change of changes) {
    if (!isPackageManifestPath(change.path) || change.kind === 'renamed') continue;
    const before = baselineFiles.get(change.path)?.text ?? '{}';
    const after = currentFiles.get(change.path)?.text ?? '{}';
    const dependencyChange = compareManifestDependencies(before, after);
    if (dependencyChange.invalidCurrent) {
      findings.push(finding(
        'change-risk-invalid-package-manifest',
        'dependencies',
        'critical',
        'Changed package manifest is not valid JSON',
        `Changed manifest ${change.path} cannot be parsed, so dependency delta evidence is unavailable.`,
        change.path,
        change.path,
        'Restore valid JSON before release and keep dependency changes deterministic.',
        ['change-risk', 'dependencies', 'manifest'],
        true,
      ));
      continue;
    }
    if (!dependencyChange.changed) continue;

    const lockCandidates = packageLockCandidates(change.path);
    const hasLock = lockCandidates.some(path => currentFiles.has(path) || baselineFiles.has(path));
    const changedLock = lockCandidates.some(path => changed.has(path));
    if (hasLock && !changedLock) {
      const detail = [
        ...dependencyChange.added.map(name => `added ${name}`),
        ...dependencyChange.removed.map(name => `removed ${name}`),
        ...dependencyChange.versionChanged.map(name => `changed ${name}`),
      ].slice(0, 12).join('\n');
      findings.push(finding(
        'change-risk-dependency-lockfile-not-updated',
        'dependencies',
        'high',
        'Dependency graph changed without matching lockfile change',
        `Dependency fields changed in ${change.path}, but its workspace lockfile is unchanged in the exact-base change set.`,
        change.path,
        detail,
        'Regenerate and commit the workspace lockfile with lifecycle scripts disabled where appropriate, then re-run dependency and build gates.',
        ['change-risk', 'dependencies', 'lockfile', 'reproducibility'],
      ));
    }
  }
  return findings;
}

function broadChangeFindings(
  summary: ChangeRiskSummary,
  options: Required<Pick<ChangeRiskAuditOptions, 'broadChangeAreaThreshold' | 'broadChangeProductionThreshold'>>,
): Finding[] {
  const findings: Finding[] = [];
  if (
    summary.crossDomainBreadth >= options.broadChangeAreaThreshold &&
    summary.productionChanges >= options.broadChangeProductionThreshold
  ) {
    findings.push(finding(
      'change-risk-broad-cross-domain-surface',
      'release',
      'medium',
      'Change set spans many release-risk domains',
      `${summary.productionChanges} production file changes span ${summary.crossDomainBreadth} risk areas (${summary.changedAreas.join(', ')}).`,
      undefined,
      summary.changedAreas.join('\n'),
      'Keep cross-domain work intentional and ensure every high-risk area has focused evidence. Split unrelated work when it obscures regression ownership.',
      ['change-risk', 'breadth', 'review'],
    ));
  }
  if (summary.productionChanges > 0 && summary.testChanges === 0) {
    findings.push(finding(
      'change-risk-production-without-any-test-change',
      'testing',
      'high',
      'Production change set contains no changed tests',
      `${summary.productionChanges} production file(s) changed but the exact-base diff contains no test additions or modifications.`,
      undefined,
      `${summary.productionChanges} production changes`,
      'Add focused regression coverage for the changed behavior or demonstrate that changed validation contracts directly exercise the affected surface.',
      ['change-risk', 'testing', 'coverage'],
    ));
  }
  return findings;
}

function releaseToolingSelfTestFindings(changes: readonly RepositoryChange[]): Finding[] {
  const releaseImplementation = changes.filter(change =>
    change.production &&
    change.kind !== 'renamed' &&
    /^quality\/release\/.*\.mts$/u.test(change.path) &&
    !change.path.endsWith('.test.mts'));
  if (releaseImplementation.length === 0) return [];
  const changedReleaseTests = changes.filter(change =>
    change.kind !== 'removed' && /^quality\/release\/.*\.test\.mts$/u.test(change.path));
  if (changedReleaseTests.length > 0) return [];
  return [finding(
    'change-risk-release-tooling-self-test-missing',
    'release',
    'high',
    'Release gate implementation changed without typed self-tests',
    `${releaseImplementation.length} release implementation file(s) changed without a corresponding quality/release/*.test.mts change.`,
    releaseImplementation[0]?.path,
    releaseImplementation.map(change => change.path).slice(0, 10).join('\n'),
    'Add adversarial typed tests that fail before the gate implementation change and pass with the intended behavior.',
    ['change-risk', 'release-tooling', 'self-test'],
  )];
}

function workflowContractFindings(changes: readonly RepositoryChange[]): Finding[] {
  const workflowChanges = changes.filter(change => pathNature(change.path).workflow && change.kind !== 'renamed');
  if (workflowChanges.length === 0) return [];
  const contractChanges = changes.filter(change =>
    change.kind !== 'removed' && (
      /^Webclient\.app\/scripts\/workflow-.*\.test\.mjs$/u.test(change.path) ||
      /^Webclient\.app\/scripts\/release-evidence-audit\.test\.mjs$/u.test(change.path) ||
      /^quality\/release\/(?:workflow-evidence-audit|release-evidence-matrix|ci-integrity-audit|validation-integrity-audit)\.test\.mts$/u.test(change.path)
    ));
  if (contractChanges.length > 0) return [];
  return [finding(
    'change-risk-workflow-contract-test-missing',
    'build',
    'high',
    'Workflow changed without adversarial workflow-contract update',
    `${workflowChanges.length} GitHub Actions workflow file(s) changed without a changed workflow security/reliability/evidence contract test.`,
    workflowChanges[0]?.path,
    workflowChanges.map(change => change.path).slice(0, 10).join('\n'),
    'Add or update an adversarial workflow contract test that proves the changed permission, action, shell, timeout, trigger or evidence semantics.',
    ['change-risk', 'ci', 'workflow', 'contract-test'],
  )];
}

function removedProductionFindings(changes: readonly RepositoryChange[]): Finding[] {
  const removedProduction = changes.filter(change => change.kind === 'removed' && change.production);
  if (removedProduction.length < 8) return [];
  return [finding(
    'change-risk-large-production-deletion',
    'architecture',
    'medium',
    'Large production deletion requires explicit regression review',
    `${removedProduction.length} production source/config files are deleted in the exact-base change set.`,
    removedProduction[0]?.path,
    removedProduction.map(change => change.path).slice(0, 12).join('\n'),
    'Confirm deleted capabilities have replacements or are intentionally retired, and preserve regression tests for retained behavior.',
    ['change-risk', 'architecture', 'deletion', 'review'],
  )];
}

export function summarizeChangeRisk(changes: readonly RepositoryChange[]): ChangeRiskSummary {
  const coverage = areaCoverage(changes);
  const areas = [...new Set(changes.flatMap(change => change.areas))]
    .sort((left, right) => left.localeCompare(right, 'en'));
  const deletedTests = changes
    .filter(change => change.kind === 'removed' && change.test)
    .map(change => change.path)
    .sort((left, right) => left.localeCompare(right, 'en'));
  const deletedCriticalValidation = changes
    .filter(change => change.kind === 'removed' && isReleaseCriticalValidationPath(change.path))
    .map(change => change.path)
    .sort((left, right) => left.localeCompare(right, 'en'));
  const dependencyManifestChanges = changes
    .filter(change => isPackageManifestPath(change.path))
    .map(change => change.path)
    .sort((left, right) => left.localeCompare(right, 'en'));
  const dependencyLockChanges = changes
    .filter(change => isPackageLockPath(change.path))
    .map(change => change.path)
    .sort((left, right) => left.localeCompare(right, 'en'));
  return {
    changeCount: changes.length,
    added: changes.filter(change => change.kind === 'added').length,
    removed: changes.filter(change => change.kind === 'removed').length,
    modified: changes.filter(change => change.kind === 'modified').length,
    renamed: changes.filter(change => change.kind === 'renamed').length,
    productionChanges: changes.filter(change => change.production && change.kind !== 'renamed').length,
    testChanges: changes.filter(change => change.test && change.kind !== 'renamed').length,
    documentationChanges: changes.filter(change => change.documentation && change.kind !== 'renamed').length,
    releaseValidationChanges: changes.filter(change => change.releaseValidation && change.kind !== 'renamed').length,
    changedAreas: areas,
    areaCoverage: coverage,
    deletedTests,
    deletedCriticalValidation,
    dependencyManifestChanges,
    dependencyLockChanges,
    crossDomainBreadth: areas.length,
    netLineDelta: changes.reduce((sum, change) => sum + change.lineDelta, 0),
    netByteDelta: changes.reduce((sum, change) => sum + change.byteDelta, 0),
  };
}

export function auditChangeRisk(
  baseline: RepositoryInventory,
  current: RepositoryInventory,
  options: ChangeRiskAuditOptions = {},
): AuditSection<ChangeRiskSummary> {
  const startedAt = Date.now();
  const changes = collectRepositoryChanges(baseline, current);
  const summary = summarizeChangeRisk(changes);
  const requireFocusedEvidence = options.requireFocusedEvidence ?? false;
  const broadOptions = {
    broadChangeAreaThreshold: options.broadChangeAreaThreshold ?? 6,
    broadChangeProductionThreshold: options.broadChangeProductionThreshold ?? 12,
  };
  const findings = stableSortFindings([
    ...criticalValidationDeletionFindings(changes),
    ...deletedTestFindings(changes),
    ...dependencyManifestFindings(changes, baseline, current),
    ...releaseToolingSelfTestFindings(changes),
    ...workflowContractFindings(changes),
    ...uncoveredAreaFindings(summary.areaCoverage, requireFocusedEvidence),
    ...broadChangeFindings(summary, broadOptions),
    ...removedProductionFindings(changes),
  ]);
  return {
    domain: 'release',
    title: 'Exact-base change-risk audit',
    summary,
    findings,
    elapsedMs: Math.max(0, Date.now() - startedAt),
  };
}

export function changeRiskMarkdown(section: AuditSection<ChangeRiskSummary>): string {
  const summary = section.summary;
  const lines = [
    '# Kent Rehberi — Exact-Base Change Risk',
    '',
    `- Changes: ${summary.changeCount}`,
    `- Added / modified / removed / renamed: ${summary.added} / ${summary.modified} / ${summary.removed} / ${summary.renamed}`,
    `- Production changes: ${summary.productionChanges}`,
    `- Test changes: ${summary.testChanges}`,
    `- Release-validation changes: ${summary.releaseValidationChanges}`,
    `- Risk-area breadth: ${summary.crossDomainBreadth}`,
    `- Net line delta: ${summary.netLineDelta}`,
    `- Net byte delta: ${summary.netByteDelta}`,
    `- Findings: ${section.findings.length}`,
    '',
    '## Area evidence',
    '',
  ];
  if (summary.areaCoverage.length === 0) lines.push('No changed production risk area requires focused evidence.');
  else {
    for (const item of summary.areaCoverage) {
      lines.push(`- **${item.area}**: ${item.covered ? 'covered' : 'missing evidence'} — ${item.changedProductionFiles.length} production / ${item.changedEvidenceFiles.length} evidence file(s)`);
    }
  }
  lines.push('', '## Findings', '');
  if (section.findings.length === 0) lines.push('No change-risk regression findings.');
  else {
    for (const item of section.findings) {
      lines.push(`- **${item.severity.toUpperCase()}** \`${item.id}\`: ${item.title}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}