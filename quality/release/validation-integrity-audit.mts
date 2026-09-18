import {
  safeJsonParse,
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { createLineIndex, snippetAround } from './inventory.mts';

export interface ValidationWorkflowSignal {
  readonly file: string;
  readonly jobCount: number;
  readonly timeoutCount: number;
  readonly continueOnErrorCount: number;
  readonly npmInstallCount: number;
  readonly npmCiCount: number;
  readonly suppressedFailureCount: number;
  readonly validationCommandCount: number;
}

export interface ValidationIntegritySummary {
  readonly workflowFiles: number;
  readonly packageManifests: number;
  readonly tsconfigFiles: number;
  readonly workflowSignals: readonly ValidationWorkflowSignal[];
  readonly findingsByRule: Readonly<Record<string, number>>;
}

interface Located {
  readonly index: number;
  readonly line: number;
  readonly excerpt: string;
}

interface PackageJsonShape {
  readonly scripts?: Record<string, unknown>;
  readonly engines?: Record<string, unknown>;
  readonly packageManager?: unknown;
  readonly dependencies?: Record<string, unknown>;
  readonly devDependencies?: Record<string, unknown>;
}

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const PACKAGE_JSON = /(^|\/)package\.json$/;
const TSCONFIG = /(^|\/)tsconfig(?:\.[^/]+)?\.json$/;
const GENERATED = /(^|\/)(?:node_modules|dist|build|coverage)(\/|$)/i;
const JOB_HEADER = /^  [a-zA-Z0-9_-]+:\s*$/gm;
const JOBS_BLOCK = /^jobs:\s*$/m;
const TIMEOUT = /^\s{4}timeout-minutes\s*:\s*\d+\s*$/gm;
const CONTINUE_ON_ERROR = /^\s*continue-on-error\s*:\s*true\s*$/gim;
const NPM_INSTALL = /\bnpm\s+install\b(?!\s+-g)/gi;
const NPM_CI = /\bnpm\s+ci\b/gi;
const SUPPRESS_FAILURE = /(?:\|\|\s*true\b|;\s*exit\s+0\b|\|\|\s*exit\s+0\b)/gi;
const VALIDATION_COMMAND = /\b(?:npm\s+(?:test|run\s+(?:test|lint|build|typecheck|check|audit|dependency:verify))|npx\s+(?:tsc|vitest|eslint|oxlint)|dotnet\s+(?:test|build|publish)|pytest|cargo\s+test|go\s+test)\b/gi;
const SET_PLUS_E = /\bset\s+\+e\b/g;
const AUDIT_COMMAND = /\b(?:npm\s+audit|dotnet\s+list\s+[^\n]+package\s+--vulnerable)\b/gi;
const FETCH_DEPTH_ZERO = /fetch-depth\s*:\s*0/i;
const BASELINE_WORKTREE = /(?:git\s+worktree|pull_request\.base\.sha|BASE_SHA|baseline)/i;
const CACHE_NODE_MODULES = /(?:path\s*:\s*[^\n]*node_modules|~\/\.npm[^\n]*node_modules)/i;
const LOCK_NAMES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'] as const;

function locate(file: SourceFile, pattern: RegExp, limit = 50): Located[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  const lines = createLineIndex(file.text);
  const results: Located[] = [];
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(file.text)) !== null) {
    results.push({
      index: match.index,
      line: lines.lineAt(match.index),
      excerpt: snippetAround(file.text, match.index, 140),
    });
    if (results.length >= limit) break;
    if (match[0].length === 0) matcher.lastIndex += 1;
  }
  return results;
}

function finding(
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  file: SourceFile,
  match: Located | undefined,
  remediation: string,
  tags: readonly string[],
  blocking = false,
): Finding {
  return {
    id,
    domain: 'build',
    severity,
    title,
    message,
    location: { file: file.repositoryPath, line: match?.line ?? 1 },
    ...(match ? { evidence: { excerpt: match.excerpt } } : {}),
    remediation,
    tags,
    ...(blocking ? { blocking: true } : {}),
  };
}

function workflowFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => WORKFLOW.test(file.repositoryPath) && !GENERATED.test(file.repositoryPath));
}

function packageFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => PACKAGE_JSON.test(file.repositoryPath) && !GENERATED.test(file.repositoryPath));
}

function tsconfigFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => TSCONFIG.test(file.repositoryPath) && !GENERATED.test(file.repositoryPath));
}

function workflowSignal(file: SourceFile): ValidationWorkflowSignal {
  const hasJobs = JOBS_BLOCK.test(file.text);
  JOBS_BLOCK.lastIndex = 0;
  return {
    file: file.repositoryPath,
    jobCount: hasJobs ? locate(file, JOB_HEADER, 100).length : 0,
    timeoutCount: locate(file, TIMEOUT, 100).length,
    continueOnErrorCount: locate(file, CONTINUE_ON_ERROR, 100).length,
    npmInstallCount: locate(file, NPM_INSTALL, 100).length,
    npmCiCount: locate(file, NPM_CI, 100).length,
    suppressedFailureCount: locate(file, SUPPRESS_FAILURE, 100).length,
    validationCommandCount: locate(file, VALIDATION_COMMAND, 100).length,
  };
}

function timeoutFindings(file: SourceFile): Finding[] {
  const signal = workflowSignal(file);
  if (signal.jobCount === 0 || signal.timeoutCount >= signal.jobCount) return [];
  return [finding(
    'validation-job-timeout-missing',
    'medium',
    'One or more CI jobs lack an explicit timeout',
    `Workflow declares ${signal.jobCount} job(s) but only ${signal.timeoutCount} job timeout(s).`,
    file,
    undefined,
    'Set a bounded timeout-minutes on every executable CI job so hung package/network/test processes cannot consume runners indefinitely.',
    ['ci', 'timeout', 'reliability'],
  )];
}

function continueOnErrorFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  for (const match of locate(file, CONTINUE_ON_ERROR)) {
    const nearby = snippetAround(file.text, match.index, 260);
    const validationNearby = VALIDATION_COMMAND.test(nearby);
    VALIDATION_COMMAND.lastIndex = 0;
    findings.push(finding(
      'validation-continue-on-error',
      validationNearby ? 'high' : 'medium',
      'CI step explicitly continues after failure',
      validationNearby
        ? 'A validation step can fail without failing the job, weakening the release signal.'
        : 'continue-on-error should be limited to clearly non-authoritative diagnostics.',
      file,
      match,
      'Remove continue-on-error from authoritative checks. If the step is diagnostic-only, name it as such and add a separate enforcing gate.',
      ['ci', 'gate', 'failure-semantics'],
    ));
  }
  return findings;
}

function suppressionFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  for (const match of locate(file, SUPPRESS_FAILURE)) {
    const excerpt = snippetAround(file.text, match.index, 240);
    const validation = VALIDATION_COMMAND.test(excerpt) || AUDIT_COMMAND.test(excerpt);
    VALIDATION_COMMAND.lastIndex = 0;
    AUDIT_COMMAND.lastIndex = 0;
    if (!validation) continue;
    findings.push(finding(
      'validation-command-failure-suppressed',
      'high',
      'Validation command failure is suppressed',
      'Authoritative lint/test/build/audit commands must propagate failure into the release job.',
      file,
      match,
      'Remove || true/forced exit 0 from the enforcing command and keep any diagnostic-only execution in a separate explicitly non-authoritative step.',
      ['ci', 'gate', 'failure-semantics'],
    ));
  }
  return findings;
}

function setPlusEFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  for (const match of locate(file, SET_PLUS_E)) {
    const tail = file.text.slice(match.index, Math.min(file.text.length, match.index + 1200));
    if (!VALIDATION_COMMAND.test(tail)) {
      VALIDATION_COMMAND.lastIndex = 0;
      continue;
    }
    VALIDATION_COMMAND.lastIndex = 0;
    if (/set\s+-e/.test(tail) && /(?:status|exit_code|baseline|regression|diagnostic)/i.test(tail)) continue;
    findings.push(finding(
      'validation-shell-errexit-disabled',
      'medium',
      'Validation shell disables errexit without a visible enforcing status contract',
      'set +e around validation can accidentally turn a hard gate into best-effort diagnostics.',
      file,
      match,
      'Capture the command exit code explicitly and assert the intended regression/gate condition before the step ends.',
      ['ci', 'shell', 'failure-semantics'],
    ));
  }
  return findings;
}

function npmInstallFindings(file: SourceFile): Finding[] {
  return locate(file, NPM_INSTALL).map(match => finding(
    'validation-npm-install-in-ci',
    'high',
    'CI uses npm install instead of lockfile-exact npm ci',
    'npm install can rewrite or resolve dependency ranges differently from the committed lockfile.',
    file,
    match,
    'Use npm ci for repository validation and fail on manifest/lockfile drift.',
    ['dependencies', 'lockfile', 'reproducibility'],
  ));
}

function dependencyAuditFindings(file: SourceFile): Finding[] {
  if (!/npm\s+ci|dotnet\s+restore|pnpm\s+install|yarn\s+install/i.test(file.text)) return [];
  if (AUDIT_COMMAND.test(file.text)) {
    AUDIT_COMMAND.lastIndex = 0;
    return [];
  }
  AUDIT_COMMAND.lastIndex = 0;
  return [finding(
    'validation-dependency-audit-missing',
    'medium',
    'Dependency installation has no visible vulnerability audit in the workflow',
    'Release validation should make production dependency vulnerabilities visible and enforce the repository severity policy.',
    file,
    undefined,
    'Add npm audit --omit=dev with an approved severity threshold and/or the equivalent .NET vulnerable-package report.',
    ['dependencies', 'security', 'ci'],
  )];
}

function checkoutHistoryFindings(file: SourceFile): Finding[] {
  if (!/(?:exact-base|baseline|regression|git\s+diff|BASE_SHA|pull_request\.base\.sha)/i.test(file.text)) return [];
  if (FETCH_DEPTH_ZERO.test(file.text) || /git\s+(?:fetch|worktree)/i.test(file.text)) return [];
  return [finding(
    'validation-baseline-history-contract',
    'medium',
    'Regression workflow references a base commit without an explicit history-fetch contract',
    'Shallow checkout can make exact-base comparisons nondeterministic when the target commit is not present.',
    file,
    undefined,
    'Use fetch-depth: 0 or explicitly fetch the exact base SHA before diff/worktree/regression operations.',
    ['ci', 'regression', 'git'],
  )];
}

function nodeModulesCacheFindings(file: SourceFile): Finding[] {
  if (!CACHE_NODE_MODULES.test(file.text)) return [];
  return [finding(
    'validation-node-modules-cache',
    'medium',
    'Workflow appears to cache node_modules directly',
    'Caching installed module trees can preserve stale platform-specific artifacts and weakens lockfile-exact reproducibility.',
    file,
    undefined,
    'Cache the package-manager download cache and continue to run npm ci on every validation job.',
    ['dependencies', 'cache', 'reproducibility'],
  )];
}

function parsePackage(file: SourceFile): PackageJsonShape | null {
  const parsed = safeJsonParse<PackageJsonShape>(file.text);
  return parsed.ok && parsed.value ? parsed.value : null;
}

function packageDirectory(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function hasLockfile(inventory: RepositoryInventory, packageFile: SourceFile): boolean {
  const directory = packageDirectory(packageFile.repositoryPath);
  return LOCK_NAMES.some(name => inventory.files.some(file => file.repositoryPath === (directory ? `${directory}/${name}` : name)));
}

function packageFindings(inventory: RepositoryInventory, file: SourceFile): Finding[] {
  const parsed = parsePackage(file);
  if (!parsed) {
    return [finding(
      'validation-package-json-invalid',
      'critical',
      'package.json is invalid JSON',
      'A package manifest used by build/release tooling cannot be parsed.',
      file,
      undefined,
      'Repair package.json syntax and regenerate the authoritative lockfile with the approved package manager.',
      ['manifest', 'build'],
      true,
    )];
  }

  const findings: Finding[] = [];
  const runtimeDeps = Object.keys(parsed.dependencies ?? {});
  const devDeps = Object.keys(parsed.devDependencies ?? {});
  if ((runtimeDeps.length > 0 || devDeps.length > 0) && !hasLockfile(inventory, file)) {
    findings.push(finding(
      'validation-lockfile-missing',
      'high',
      'JavaScript package has dependencies but no lockfile',
      'Dependency ranges without an authoritative lockfile make CI and production builds non-reproducible.',
      file,
      undefined,
      'Commit the approved package-manager lockfile and use its frozen/ci install mode.',
      ['dependencies', 'lockfile', 'reproducibility'],
    ));
  }

  const scripts = parsed.scripts ?? {};
  const isWebclient = /Webclient\.(?:app|Admin)\/package\.json$/.test(file.repositoryPath);
  if (isWebclient && typeof scripts.build !== 'string') {
    findings.push(finding(
      'validation-build-script-missing',
      'high',
      'Webclient package has no build script',
      'Release CI needs one deterministic package-level production build entrypoint.',
      file,
      undefined,
      'Define a deterministic build script used by CI and artifact verification.',
      ['build', 'package-script'],
    ));
  }
  if (isWebclient && typeof scripts.test !== 'string' && typeof scripts['test:run'] !== 'string') {
    findings.push(finding(
      'validation-test-script-missing',
      'medium',
      'Webclient package has no canonical test script',
      'A canonical package test entrypoint reduces drift between local and CI validation.',
      file,
      undefined,
      'Expose the authoritative regression suite through test or test:run and keep CI arguments explicit.',
      ['testing', 'package-script'],
    ));
  }

  if (!parsed.packageManager && !parsed.engines?.node && isWebclient) {
    findings.push(finding(
      'validation-node-version-contract-missing',
      'medium',
      'Webclient manifest does not declare package-manager or Node runtime expectations',
      'Toolchain version drift can make lockfile, build, and test results differ between developers and CI.',
      file,
      undefined,
      'Declare packageManager and/or engines.node aligned with the repository Node toolchain contract.',
      ['node', 'toolchain', 'reproducibility'],
    ));
  }

  return findings;
}

function tsconfigFindings(file: SourceFile): Finding[] {
  const parsed = safeJsonParse<Record<string, unknown>>(file.text);
  if (!parsed.ok || !parsed.value) {
    return [finding(
      'validation-tsconfig-invalid',
      'high',
      'TypeScript configuration cannot be parsed as JSON',
      'Release typechecking cannot reliably consume an invalid TypeScript configuration.',
      file,
      undefined,
      'Repair the TypeScript configuration and keep machine-consumed configs parseable.',
      ['typescript', 'config'],
    )];
  }

  const compiler = typeof parsed.value.compilerOptions === 'object' && parsed.value.compilerOptions !== null
    ? parsed.value.compilerOptions as Record<string, unknown>
    : {};
  const findings: Finding[] = [];
  if (/quality\/release\/tsconfig\.json$/.test(file.repositoryPath) && compiler.strict !== true) {
    findings.push(finding(
      'validation-release-tsconfig-not-strict',
      'critical',
      'Typed release QA is not configured with strict TypeScript',
      'The release audit itself must compile under strict TypeScript so audit blind spots are not hidden by permissive typing.',
      file,
      undefined,
      'Set compilerOptions.strict=true for quality/release and fix resulting diagnostics.',
      ['typescript', 'release-audit'],
      true,
    ));
  }
  if (compiler.skipLibCheck === true && /quality\/release\//.test(file.repositoryPath)) {
    findings.push(finding(
      'validation-release-skip-lib-check',
      'low',
      'Release QA TypeScript skips declaration checking',
      'skipLibCheck can hide incompatible declaration boundaries in the audit toolchain.',
      file,
      undefined,
      'Prefer complete declaration checking for the small release QA project unless a documented upstream defect requires a temporary exception.',
      ['typescript', 'release-audit'],
    ));
  }
  return findings;
}

function workflowFindings(file: SourceFile): Finding[] {
  return [
    ...timeoutFindings(file),
    ...continueOnErrorFindings(file),
    ...suppressionFindings(file),
    ...setPlusEFindings(file),
    ...npmInstallFindings(file),
    ...dependencyAuditFindings(file),
    ...checkoutHistoryFindings(file),
    ...nodeModulesCacheFindings(file),
  ];
}

function countsByRule(findings: readonly Finding[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const item of findings) counts[item.id] = (counts[item.id] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right, 'en')));
}

export function auditValidationIntegrity(inventory: RepositoryInventory): AuditSection<ValidationIntegritySummary> {
  const start = performance.now();
  const workflows = workflowFiles(inventory);
  const packages = packageFiles(inventory);
  const tsconfigs = tsconfigFiles(inventory);
  const workflowSignals = workflows.map(workflowSignal);
  const findings = stableSortFindings([
    ...workflows.flatMap(workflowFindings),
    ...packages.flatMap(file => packageFindings(inventory, file)),
    ...tsconfigs.flatMap(tsconfigFindings),
  ]);
  return {
    domain: 'build',
    title: 'Release validation integrity and reproducibility audit',
    summary: {
      workflowFiles: workflows.length,
      packageManifests: packages.length,
      tsconfigFiles: tsconfigs.length,
      workflowSignals,
      findingsByRule: countsByRule(findings),
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - start),
  };
}
