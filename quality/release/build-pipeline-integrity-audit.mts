import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';

export interface BuildWorkflowSignal {
  readonly file: string;
  readonly installCommands: number;
  readonly typecheckCommands: number;
  readonly testCommands: number;
  readonly lintCommands: number;
  readonly buildCommands: number;
  readonly publishCommands: number;
  readonly frozenInstalls: number;
  readonly unsafeInstalls: number;
  readonly noRestoreBuilds: number;
  readonly noBuildTests: number;
}

export interface BuildPipelineIntegritySummary {
  readonly workflows: readonly BuildWorkflowSignal[];
  readonly workflowFiles: number;
  readonly buildWorkflows: number;
  readonly publishWorkflows: number;
  readonly findings: readonly Finding[];
}

interface CommandLine {
  readonly text: string;
  readonly line: number;
}

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const INSTALL = /\b(?:npm\s+(?:ci|install)|pnpm\s+install|yarn\s+install|bun\s+install|dotnet\s+restore)\b/i;
const FROZEN_INSTALL = /\bnpm\s+ci\b|\bpnpm\s+install\b[^\n]*(?:--frozen-lockfile|--lockfile-only=false)|\byarn\s+install\b[^\n]*(?:--immutable|--frozen-lockfile)|\bbun\s+install\b[^\n]*--frozen-lockfile|\bdotnet\s+restore\b[^\n]*(?:--locked-mode|RestoreLockedMode=true)/i;
const NPM_INSTALL = /\bnpm\s+install\b(?!\s+-g\b)/i;
const TYPECHECK = /\b(?:tsc\b[^\n]*(?:--noEmit|-p\s+\S+)|npm\s+run\s+(?:typecheck|check:types|types)|pnpm\s+(?:typecheck|check:types)|yarn\s+(?:typecheck|check:types)|dotnet\s+build\b[^\n]*(?:TreatWarningsAsErrors|warnaserror))\b/i;
const TEST = /\b(?:npm\s+(?:test|run\s+(?:test|test:ci|test:unit|test:regression))|pnpm\s+(?:test|run\s+test)|yarn\s+(?:test|run\s+test)|node\s+--test|vitest\b|dotnet\s+test\b|pytest\b|cargo\s+test\b|go\s+test\b)/i;
const LINT = /\b(?:npm\s+run\s+lint|pnpm\s+lint|yarn\s+lint|eslint\b|oxlint\b|dotnet\s+format\b)/i;
const BUILD = /\b(?:npm\s+run\s+build|pnpm\s+build|yarn\s+build|vite\s+build|next\s+build|dotnet\s+build\b|dotnet\s+publish\b|cargo\s+build\b|go\s+build\b)/i;
const PUBLISH = /\b(?:dotnet\s+publish\b|npm\s+publish\b|pnpm\s+publish\b|yarn\s+npm\s+publish\b|gh\s+release\b|docker\s+(?:push|buildx\s+build[^\n]*--push)|cosign\s+sign\b)/i;
const NO_RESTORE = /\bdotnet\s+(?:build|test|publish)\b[^\n]*--no-restore\b/i;
const NO_BUILD = /\bdotnet\s+test\b[^\n]*--no-build\b/i;
const CONTINUE_ON_ERROR = /^\s*continue-on-error\s*:\s*true\s*$/im;
const FAILURE_MASK = /(?:\|\|\s*true\b|;\s*true\s*$|\bset\s+\+e\b)/im;
const SHELL_CURL_INSTALL = /\b(?:curl|wget)\b[^\n|]*(?:\||-o\s+-)[^\n]*\b(?:sh|bash|node|python|pwsh|powershell)\b/i;
const SKIP_TEST_FLAG = /\b(?:--skip-tests?|--no-tests?|SKIP_TESTS?\s*=\s*(?:1|true))\b/i;
const FORCE_SUCCESS = /\b(?:exit\s+0|return\s+0)\b/i;

function runCommands(file: SourceFile): CommandLine[] {
  const result: CommandLine[] = [];
  const lines = file.text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = line.match(/^\s*run\s*:\s*(.*)$/i);
    if (!match) continue;
    const inline = (match[1] ?? '').trim();
    if (inline && !/^[>|][+-]?$/.test(inline)) {
      result.push({ text: inline, line: index + 1 });
      continue;
    }
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const block: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor] ?? '';
      const candidateIndent = candidate.match(/^\s*/)?.[0].length ?? 0;
      if (candidate.trim() && candidateIndent <= indent) break;
      block.push(candidate.trim());
    }
    result.push({ text: block.join('\n'), line: index + 1 });
  }
  return result;
}

function indexOfCommand(commands: readonly CommandLine[], pattern: RegExp): number {
  return commands.findIndex(command => pattern.test(command.text));
}

function commandCount(commands: readonly CommandLine[], pattern: RegExp): number {
  return commands.filter(command => pattern.test(command.text)).length;
}

function commandLine(commands: readonly CommandLine[], pattern: RegExp): number {
  return commands.find(command => pattern.test(command.text))?.line ?? 1;
}

function finding(
  file: SourceFile,
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  remediation: string,
  blocking: boolean,
  line = 1,
): Finding {
  return {
    id,
    domain: 'build',
    severity,
    ...(blocking ? { blocking: true } : {}),
    title,
    message,
    location: { file: file.repositoryPath, line },
    remediation,
    tags: ['build', 'ci', 'modernization', 'validation', 'supply-chain'],
  };
}

function signal(file: SourceFile): BuildWorkflowSignal {
  const commands = runCommands(file);
  return {
    file: file.repositoryPath,
    installCommands: commandCount(commands, INSTALL),
    typecheckCommands: commandCount(commands, TYPECHECK),
    testCommands: commandCount(commands, TEST),
    lintCommands: commandCount(commands, LINT),
    buildCommands: commandCount(commands, BUILD),
    publishCommands: commandCount(commands, PUBLISH),
    frozenInstalls: commandCount(commands, FROZEN_INSTALL),
    unsafeInstalls: commands.filter(command => NPM_INSTALL.test(command.text) || (INSTALL.test(command.text) && !FROZEN_INSTALL.test(command.text) && !/dotnet\s+restore/i.test(command.text))).length,
    noRestoreBuilds: commandCount(commands, NO_RESTORE),
    noBuildTests: commandCount(commands, NO_BUILD),
  };
}

function findingsFor(file: SourceFile): Finding[] {
  const commands = runCommands(file);
  const result: Finding[] = [];
  const buildIndex = indexOfCommand(commands, BUILD);
  const publishIndex = indexOfCommand(commands, PUBLISH);
  const installIndex = indexOfCommand(commands, INSTALL);
  const typecheckIndex = indexOfCommand(commands, TYPECHECK);
  const testIndex = indexOfCommand(commands, TEST);
  const lintIndex = indexOfCommand(commands, LINT);

  for (const command of commands) {
    if (NPM_INSTALL.test(command.text)) {
      result.push(finding(
        file,
        'build-npm-install-nonreproducible',
        'high',
        'CI uses npm install instead of npm ci',
        'npm install can mutate the lockfile resolution and admits dependency drift inside validation/release jobs.',
        'Use npm ci for CI/release installs and keep package-lock.json authoritative.',
        true,
        command.line,
      ));
    }
    if (/\bpnpm\s+install\b/i.test(command.text) && !/--frozen-lockfile\b/i.test(command.text)) {
      result.push(finding(file, 'build-pnpm-install-not-frozen', 'high', 'CI pnpm install is not frozen', 'pnpm may resolve dependency changes not represented by the reviewed lockfile.', 'Add --frozen-lockfile to CI/release installs.', true, command.line));
    }
    if (/\byarn\s+install\b/i.test(command.text) && !/(?:--immutable|--frozen-lockfile)\b/i.test(command.text)) {
      result.push(finding(file, 'build-yarn-install-not-immutable', 'high', 'CI Yarn install is not immutable', 'Yarn may update or reinterpret dependency state during validation.', 'Use --immutable (or the supported frozen equivalent) in CI.', true, command.line));
    }
    if (/\bbun\s+install\b/i.test(command.text) && !/--frozen-lockfile\b/i.test(command.text)) {
      result.push(finding(file, 'build-bun-install-not-frozen', 'high', 'CI Bun install is not frozen', 'Bun may resolve dependency changes outside the reviewed lockfile.', 'Use bun install --frozen-lockfile in CI.', true, command.line));
    }
    if (/\bdotnet\s+restore\b/i.test(command.text) && !/(?:--locked-mode|RestoreLockedMode=true)/i.test(command.text)) {
      result.push(finding(file, 'build-dotnet-restore-not-locked', 'medium', '.NET restore is not locked', 'Release validation can resolve package graph changes not represented by a package lock when locked mode is absent.', 'Use packages.lock.json with dotnet restore --locked-mode where lockfiles are part of the repository contract.', false, command.line));
    }
    if (SHELL_CURL_INSTALL.test(command.text)) {
      result.push(finding(file, 'build-download-execute-pipeline', 'critical', 'Workflow downloads and executes remote code in one shell pipeline', 'Piping curl/wget output directly to a shell or interpreter bypasses reviewed package and checksum provenance.', 'Install tools from pinned package/action authorities or download a versioned artifact and verify its cryptographic digest before execution.', true, command.line));
    }
    if (SKIP_TEST_FLAG.test(command.text) && (BUILD.test(command.text) || PUBLISH.test(command.text))) {
      result.push(finding(file, 'build-explicit-test-bypass', 'critical', 'Build or publish command explicitly bypasses tests', 'A release-producing command contains a test bypass flag/environment switch.', 'Remove the bypass and make test evidence a prerequisite of the release-producing job.', true, command.line));
    }
    if ((BUILD.test(command.text) || PUBLISH.test(command.text) || TEST.test(command.text)) && (FAILURE_MASK.test(command.text) || FORCE_SUCCESS.test(command.text))) {
      result.push(finding(file, 'build-command-failure-masked', 'critical', 'Validation/build command masks its exit status', 'Failure masking can turn a broken test/build/publish command into a green workflow step.', 'Propagate the real exit status; use explicit cleanup in a separate always() step instead of forcing success.', true, command.line));
    }
    if (NO_RESTORE.test(command.text) && installIndex < 0) {
      result.push(finding(file, 'build-no-restore-without-restore', 'high', '--no-restore is used without an earlier restore step', 'The job assumes restore state that is not established inside the reviewed workflow.', 'Run an explicit locked restore in the same job before commands that use --no-restore.', true, command.line));
    }
    if (NO_BUILD.test(command.text) && buildIndex < 0) {
      result.push(finding(file, 'build-no-build-without-build', 'high', 'dotnet test --no-build has no earlier build evidence', 'Tests depend on preexisting binaries whose source and build provenance is not established in the job.', 'Build the exact commit in the same job before --no-build tests, or remove --no-build.', true, command.line));
    }
  }

  if (buildIndex >= 0 && installIndex >= 0 && installIndex > buildIndex) {
    result.push(finding(file, 'build-install-after-build', 'high', 'Dependency installation occurs after build', 'Build output can be produced before the reviewed dependency graph is installed.', 'Install from the locked dependency graph before any compilation/build step.', true, commandLine(commands, BUILD)));
  }
  if (publishIndex >= 0 && testIndex < 0) {
    result.push(finding(file, 'build-publish-without-tests', 'critical', 'Publish workflow has no test command', 'Release publication has no same-workflow test evidence.', 'Make tests a mandatory prerequisite before publish/deploy/release mutation.', true, commandLine(commands, PUBLISH)));
  }
  if (publishIndex >= 0 && testIndex >= 0 && testIndex > publishIndex) {
    result.push(finding(file, 'build-tests-after-publish', 'critical', 'Tests run after publication', 'Publication can mutate external release state before tests prove the commit is valid.', 'Run tests before every publish/deploy/release mutation.', true, commandLine(commands, PUBLISH)));
  }
  if (publishIndex >= 0 && buildIndex < 0 && !/gh\s+release\b/i.test(commands[publishIndex]?.text ?? '')) {
    result.push(finding(file, 'build-publish-without-build', 'high', 'Publish workflow has no explicit build step', 'Publication consumes binaries without a same-workflow build provenance signal.', 'Build the exact commit before publication or consume an independently attested immutable artifact.', true, commandLine(commands, PUBLISH)));
  }
  if (buildIndex >= 0 && typecheckIndex < 0 && /(?:node|npm|pnpm|yarn|vite|typescript|tsx|react)/i.test(file.text)) {
    result.push(finding(file, 'build-js-build-without-typecheck', 'high', 'JavaScript/TypeScript build workflow has no explicit typecheck', 'Bundlers can transpile code while skipping TypeScript semantic diagnostics.', 'Run a strict no-emit TypeScript check before the production build.', true, commandLine(commands, BUILD)));
  }
  if (buildIndex >= 0 && typecheckIndex >= 0 && typecheckIndex > buildIndex) {
    result.push(finding(file, 'build-typecheck-after-build', 'high', 'Typecheck runs after build', 'Build artifacts can be produced before compiler diagnostics are validated.', 'Run strict typecheck before the production build.', true, commandLine(commands, BUILD)));
  }
  if (publishIndex >= 0 && lintIndex >= 0 && lintIndex > publishIndex) {
    result.push(finding(file, 'build-lint-after-publish', 'medium', 'Lint runs after publish', 'Static quality evidence is collected after external release state can already be mutated.', 'Move lint/static analysis before publication.', false, commandLine(commands, PUBLISH)));
  }

  if (file.text.match(CONTINUE_ON_ERROR) && (buildIndex >= 0 || testIndex >= 0 || publishIndex >= 0)) {
    result.push(finding(file, 'build-workflow-continue-on-error-review', 'high', 'Validation workflow contains continue-on-error', 'A release validation workflow contains a fail-open step and must prove it cannot mask build/test/publication evidence.', 'Remove continue-on-error from authoritative validation steps or isolate non-gating diagnostics in a clearly separate job.', true, lineOf(file.text, /continue-on-error/)));
  }
  return result;
}

function lineOf(text: string, pattern: RegExp): number {
  const match = text.match(pattern);
  if (!match || match.index === undefined) return 1;
  return text.slice(0, match.index).split('\n').length;
}

export function auditBuildPipelineIntegrity(
  inventory: RepositoryInventory,
): AuditSection<BuildPipelineIntegritySummary> {
  const started = performance.now();
  const files = inventory.files.filter(file => WORKFLOW.test(file.repositoryPath));
  const signals = files.map(signal);
  const findings = stableSortFindings(files.flatMap(findingsFor));
  return {
    domain: 'build',
    title: 'Build and validation pipeline integrity audit',
    summary: {
      workflows: signals,
      workflowFiles: files.length,
      buildWorkflows: signals.filter(item => item.buildCommands > 0).length,
      publishWorkflows: signals.filter(item => item.publishCommands > 0).length,
      findings,
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
