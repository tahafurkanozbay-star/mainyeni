import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';

export interface CompilerPolicySignal {
  readonly file: string;
  readonly kind: 'tsconfig' | 'dotnet-props' | 'workflow';
  readonly strictSignals: number;
  readonly escapeHatches: number;
  readonly warningPolicies: number;
}

export interface CompilerPolicySummary {
  readonly signals: readonly CompilerPolicySignal[];
  readonly tsconfigs: number;
  readonly dotnetPolicies: number;
  readonly compilerWorkflows: number;
  readonly findings: readonly Finding[];
}

type JsonObject = Record<string, unknown>;

const TSCONFIG = /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/i;
const DOTNET_POLICY = /(?:^|\/)(?:Directory\.Build\.props|[^/]+\.csproj)$/i;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const TSC_COMMAND = /\b(?:npx\s+)?tsc\b|\btypescript\/bin\/tsc\b/i;
const DOTNET_BUILD = /\bdotnet\s+(?:build|test|publish)\b/i;
const TSC_NOCHECK = /\b--noCheck\b/i;
const TSC_ALLOW_JS = /\b--allowJs\b/i;
const TSC_SKIP_LIB = /\b--skipLibCheck\b/i;
const TSC_NO_EMIT = /\b--noEmit\b/i;
const TSC_PROJECT = /(?:^|\s)(?:-p|--project)\s+([^\s]+)/i;
const TS_COMPILE_ON_ERROR = /TSC_COMPILE_ON_ERROR\s*=\s*(?:true|1)|CI\s*=\s*false/i;
const DOTNET_NOWARN = /(?:\/p:NoWarn=|--property:NoWarn=|<NoWarn>)/i;
const DOTNET_WARN_AS_ERROR_OFF = /(?:TreatWarningsAsErrors\s*=\s*false|<TreatWarningsAsErrors>\s*false\s*<\/TreatWarningsAsErrors>|-warnaserror-)/i;
const DOTNET_ANALYSIS_OFF = /<EnableNETAnalyzers>\s*false\s*<\/EnableNETAnalyzers>|<AnalysisLevel>\s*(?:none|[0-5](?:\.\d+)?)\s*<\/AnalysisLevel>/i;
const DOTNET_UNSAFE = /<AllowUnsafeBlocks>\s*true\s*<\/AllowUnsafeBlocks>/i;
const DOTNET_LANG_PREVIEW = /<LangVersion>\s*preview\s*<\/LangVersion>/i;
const NULLABLE_DISABLE = /<Nullable>\s*disable\s*<\/Nullable>/i;
const WARN_AS_ERROR = /<TreatWarningsAsErrors>\s*true\s*<\/TreatWarningsAsErrors>|-warnaserror\b|TreatWarningsAsErrors=true/i;
const ANALYZERS_ENABLED = /<EnableNETAnalyzers>\s*true\s*<\/EnableNETAnalyzers>|<AnalysisLevel>\s*(?:latest|preview|\d{2,})/i;

function parseObject(file: SourceFile): JsonObject | null {
  try {
    const value = JSON.parse(file.text) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as JsonObject
      : null;
  } catch {
    return null;
  }
}

function nestedObject(parent: JsonObject | null, key: string): JsonObject | null {
  if (!parent) return null;
  const value = parent[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function bool(parent: JsonObject | null, key: string): boolean | null {
  if (!parent) return null;
  const value = parent[key];
  return typeof value === 'boolean' ? value : null;
}

function stringValue(parent: JsonObject | null, key: string): string | null {
  if (!parent) return null;
  const value = parent[key];
  return typeof value === 'string' ? value : null;
}

function lineOf(text: string, pattern: RegExp): number {
  const match = text.match(pattern);
  if (!match || match.index === undefined) return 1;
  return text.slice(0, match.index).split('\n').length;
}

function finding(
  file: SourceFile,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  blocking: boolean,
  pattern?: RegExp,
): Finding {
  return {
    id,
    domain: 'build',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: file.repositoryPath, line: pattern ? lineOf(file.text, pattern) : 1 },
    remediation,
    tags: ['compiler', 'typescript', 'dotnet', 'modernization', 'quality-gate'],
  };
}

function tsFindings(file: SourceFile): Finding[] {
  const object = parseObject(file);
  if (!object) return [];
  const options = nestedObject(object, 'compilerOptions');
  const result: Finding[] = [];

  if (bool(options, 'strict') !== true) result.push(finding(file, 'compiler-ts-strict-required', 'high', 'TypeScript strict compiler policy is not enabled', 'A typed root can compile with unsound inference and nullability when strict mode is absent.', 'Enable strict=true and resolve diagnostics.', true, /"strict"/));
  if (bool(options, 'forceConsistentCasingInFileNames') !== true) result.push(finding(file, 'compiler-ts-casing-policy-missing', 'medium', 'TypeScript does not enforce import path casing', 'Case-insensitive developer filesystems can hide imports that fail on Linux CI or production.', 'Enable forceConsistentCasingInFileNames=true.', false));
  if (bool(options, 'noImplicitOverride') !== true) result.push(finding(file, 'compiler-ts-implicit-override-loose', 'low', 'TypeScript override declarations are not explicit', 'Class overrides can silently drift when base APIs change.', 'Enable noImplicitOverride=true for typed application/tooling roots.', false));
  if (bool(options, 'useUnknownInCatchVariables') !== true) result.push(finding(file, 'compiler-ts-catch-any-loose', 'medium', 'Catch variables are not forced to unknown', 'Error handling can assume arbitrary exception shape without narrowing.', 'Enable useUnknownInCatchVariables=true and narrow errors explicitly.', false));
  if (bool(options, 'noImplicitReturns') !== true) result.push(finding(file, 'compiler-ts-implicit-return-loose', 'medium', 'Not all code paths are required to return explicitly', 'Missing return paths can become undefined runtime behavior despite declared intent.', 'Enable noImplicitReturns=true and model optional returns explicitly.', false));
  if (bool(options, 'noFallthroughCasesInSwitch') !== true) result.push(finding(file, 'compiler-ts-switch-fallthrough-loose', 'low', 'Switch fallthrough is not compiler-checked', 'Accidental fallthrough can create state-machine and reducer regressions.', 'Enable noFallthroughCasesInSwitch=true.', false));
  if (bool(options, 'noPropertyAccessFromIndexSignature') !== true) result.push(finding(file, 'compiler-ts-index-signature-access-loose', 'low', 'Index-signature property access is not explicit', 'Dot access can imply a property exists when it is only admitted by a broad index signature.', 'Enable noPropertyAccessFromIndexSignature=true where compatible.', false));
  if (bool(options, 'allowUnreachableCode') === true) result.push(finding(file, 'compiler-ts-unreachable-code-allowed', 'medium', 'TypeScript explicitly allows unreachable code', 'Dead branches can hide failed migrations and obsolete control flow.', 'Remove allowUnreachableCode=true and delete or repair unreachable logic.', false, /"allowUnreachableCode"/));
  if (bool(options, 'allowUnusedLabels') === true) result.push(finding(file, 'compiler-ts-unused-labels-allowed', 'low', 'TypeScript explicitly allows unused labels', 'Unused labels frequently indicate stale control-flow migrations.', 'Remove allowUnusedLabels=true.', false, /"allowUnusedLabels"/));
  if (bool(options, 'skipDefaultLibCheck') === true) result.push(finding(file, 'compiler-ts-default-lib-check-skipped', 'low', 'Default library checking is explicitly skipped', 'Skipping compiler library checks can conceal environment mismatch while upgrading runtimes.', 'Prefer full library checking on authoritative CI; isolate compatibility exceptions.', false));

  const jsx = stringValue(options, 'jsx')?.toLowerCase() ?? '';
  if (jsx === 'react' || jsx === 'react-native') result.push(finding(file, 'compiler-ts-legacy-jsx-transform', 'medium', 'TypeScript uses legacy JSX transform', `jsx=${jsx} is a legacy transform for modern React toolchains.`, 'Use react-jsx/react-jsxdev or the bundler-native modern transform.', false, /"jsx"/));
  return result;
}

function dotnetFindings(file: SourceFile): Finding[] {
  const result: Finding[] = [];
  if (NULLABLE_DISABLE.test(file.text)) result.push(finding(file, 'compiler-dotnet-nullable-disabled', 'high', 'C# nullable analysis is disabled', 'Nullable reference contracts are not enforced by the compiler.', 'Enable nullable analysis centrally and fix diagnostics.', true, NULLABLE_DISABLE));
  if (DOTNET_WARN_AS_ERROR_OFF.test(file.text)) result.push(finding(file, 'compiler-dotnet-warnings-not-errors', 'high', 'C# warnings-as-errors is explicitly disabled', 'Authoritative builds can stay green while compiler/analyzer regressions accumulate.', 'Enable TreatWarningsAsErrors for CI/release builds or use a narrowly documented warning allowlist.', true, DOTNET_WARN_AS_ERROR_OFF));
  if (DOTNET_ANALYSIS_OFF.test(file.text)) result.push(finding(file, 'compiler-dotnet-analyzers-disabled', 'high', '.NET analyzers are disabled or pinned to an obsolete analysis level', 'Disabling analyzers removes modern correctness/security diagnostics from builds.', 'Enable .NET analyzers and use a current stable analysis level.', true, DOTNET_ANALYSIS_OFF));
  if (DOTNET_LANG_PREVIEW.test(file.text)) result.push(finding(file, 'compiler-dotnet-language-preview', 'high', 'C# language version is preview', 'Preview language semantics create a production/toolchain rollback dependency.', 'Use the stable language version matching the stable SDK unless an explicit experiment is isolated from release.', true, DOTNET_LANG_PREVIEW));
  if (DOTNET_UNSAFE.test(file.text)) result.push(finding(file, 'compiler-dotnet-unsafe-enabled', 'medium', 'Project enables unsafe C# blocks', 'Unsafe code bypasses memory-safety guarantees and requires explicit review.', 'Keep AllowUnsafeBlocks disabled unless a measured hotspot requires it; isolate unsafe code behind a narrow tested boundary.', false, DOTNET_UNSAFE));
  return result;
}

interface RunCommand {
  readonly text: string;
  readonly line: number;
}

function runCommands(file: SourceFile): RunCommand[] {
  const result: RunCommand[] = [];
  const lines = file.text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] ?? '';
    const match = text.match(/^\s*run\s*:\s*(.+)$/i);
    if (!match?.[1]) continue;
    result.push({ text: match[1].trim(), line: index + 1 });
  }
  return result;
}

function workflowFindings(file: SourceFile): Finding[] {
  const result: Finding[] = [];
  for (const command of runCommands(file)) {
    if (TSC_COMMAND.test(command.text)) {
      if (TSC_NOCHECK.test(command.text)) result.push(finding(file, 'compiler-ci-ts-no-check', 'critical', 'CI invokes TypeScript with --noCheck', 'The compiler command bypasses semantic diagnostics while appearing to run TypeScript.', 'Remove --noCheck and run an authoritative strict semantic typecheck.', true, /--noCheck/));
      if (TSC_ALLOW_JS.test(command.text)) result.push(finding(file, 'compiler-ci-ts-allow-js-override', 'high', 'CI enables allowJs from the command line', 'Command-line allowJs can widen the typed boundary beyond reviewed tsconfig policy.', 'Keep compiler policy in versioned tsconfig and migrate admitted JavaScript deliberately.', true, /--allowJs/));
      if (TSC_SKIP_LIB.test(command.text)) result.push(finding(file, 'compiler-ci-ts-skip-lib-check-override', 'medium', 'CI overrides TypeScript library checking', 'A command-line skipLibCheck override can hide dependency/runtime type incompatibility during upgrades.', 'Keep library-check policy in tsconfig and avoid weakening it in authoritative CI.', false, /--skipLibCheck/));
      if (!TSC_NO_EMIT.test(command.text) && !/npm\s+run\s+build|pnpm\s+build|yarn\s+build/i.test(command.text)) result.push(finding(file, 'compiler-ci-ts-typecheck-may-emit', 'medium', 'CI TypeScript validation can emit files', 'A typecheck step that emits can mutate the workspace and blur validation/build boundaries.', 'Use --noEmit for semantic validation and keep production emission in the build step.', false, TSC_COMMAND));
      if (!TSC_PROJECT.test(command.text) && /quality|release|typed|typecheck/i.test(file.repositoryPath + file.text)) result.push(finding(file, 'compiler-ci-ts-project-implicit', 'low', 'Authoritative TypeScript check relies on implicit config discovery', 'Implicit tsconfig discovery can change as files/configs move.', 'Pass -p/--project for the intended authoritative compiler contract.', false, TSC_COMMAND));
    }
    if (TS_COMPILE_ON_ERROR.test(command.text)) result.push(finding(file, 'compiler-ci-ts-compile-on-error', 'critical', 'CI environment allows TypeScript build despite diagnostics', 'TSC_COMPILE_ON_ERROR/CI=false can convert compiler errors into emitted output.', 'Remove the escape hatch and keep CI fail-closed on diagnostics.', true, /TSC_COMPILE_ON_ERROR|CI\s*=\s*false/));
    if (DOTNET_BUILD.test(command.text)) {
      if (DOTNET_NOWARN.test(command.text)) result.push(finding(file, 'compiler-ci-dotnet-nowarn', 'high', 'CI suppresses .NET warnings from the command line', 'Broad NoWarn use can hide analyzer/compiler regressions from authoritative builds.', 'Fix warnings or use a narrowly documented source-level suppression with tests.', true, /NoWarn/));
      if (DOTNET_WARN_AS_ERROR_OFF.test(command.text)) result.push(finding(file, 'compiler-ci-dotnet-warning-gate-disabled', 'high', 'CI disables .NET warnings-as-errors', 'The release build can pass with new compiler/analyzer warnings.', 'Keep warning gates enabled for authoritative build/test/publish jobs.', true, /TreatWarningsAsErrors|-warnaserror-/));
    }
  }
  return result;
}

function signal(file: SourceFile): CompilerPolicySignal {
  if (TSCONFIG.test(file.repositoryPath)) {
    const findings = tsFindings(file);
    return {
      file: file.repositoryPath,
      kind: 'tsconfig',
      strictSignals: /"strict"\s*:\s*true/.test(file.text) ? 1 : 0,
      escapeHatches: findings.filter(item => item.blocking === true).length,
      warningPolicies: findings.length,
    };
  }
  if (DOTNET_POLICY.test(file.repositoryPath)) {
    const findings = dotnetFindings(file);
    return {
      file: file.repositoryPath,
      kind: 'dotnet-props',
      strictSignals: (WARN_AS_ERROR.test(file.text) ? 1 : 0) + (ANALYZERS_ENABLED.test(file.text) ? 1 : 0),
      escapeHatches: findings.filter(item => item.blocking === true).length,
      warningPolicies: findings.length,
    };
  }
  const findings = workflowFindings(file);
  return {
    file: file.repositoryPath,
    kind: 'workflow',
    strictSignals: runCommands(file).filter(command => TSC_COMMAND.test(command.text) || DOTNET_BUILD.test(command.text)).length,
    escapeHatches: findings.filter(item => item.blocking === true).length,
    warningPolicies: findings.length,
  };
}

export function auditCompilerPolicy(
  inventory: RepositoryInventory,
): AuditSection<CompilerPolicySummary> {
  const started = performance.now();
  const files = inventory.files.filter(file =>
    TSCONFIG.test(file.repositoryPath)
    || DOTNET_POLICY.test(file.repositoryPath)
    || WORKFLOW.test(file.repositoryPath));
  const tsconfigs = files.filter(file => TSCONFIG.test(file.repositoryPath));
  const dotnet = files.filter(file => DOTNET_POLICY.test(file.repositoryPath));
  const workflows = files.filter(file => WORKFLOW.test(file.repositoryPath));
  const findings = stableSortFindings([
    ...tsconfigs.flatMap(tsFindings),
    ...dotnet.flatMap(dotnetFindings),
    ...workflows.flatMap(workflowFindings),
  ]);
  return {
    domain: 'build',
    title: 'Compiler hardening and diagnostic integrity audit',
    summary: {
      signals: files.map(signal),
      tsconfigs: tsconfigs.length,
      dotnetPolicies: dotnet.length,
      compilerWorkflows: workflows.filter(file => TSC_COMMAND.test(file.text) || DOTNET_BUILD.test(file.text)).length,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
