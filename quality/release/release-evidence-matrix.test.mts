import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RELEASE_EVIDENCE_REQUIREMENTS,
  auditReleaseEvidenceMatrix,
  releaseEvidenceMatrixMarkdown,
} from './release-evidence-matrix.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  'web-lockfile-install': 'npm ci',
  'web-dependency-contract': 'npm run dependency:verify',
  'web-production-audit': 'npm audit --omit=dev --audit-level=high',
  'web-full-lint': 'npm run lint',
  'web-changed-strict-lint': 'npm run lint:strict',
  'web-full-typecheck': 'npx --no-install tsc --noEmit -p tsconfig.json',
  'web-exact-base-typecheck': 'BASE_SHA=${{ github.event.pull_request.base.sha }}; node scripts/typecheck-regression.mjs',
  'web-full-tests': 'npx --no-install vitest run',
  'web-exact-base-tests': 'BASE_SHA=${{ github.event.pull_request.base.sha }}; node scripts/vitest-regression.mjs',
  'web-tooling-tests': 'npm run test:tooling',
  'web-production-build': 'npm run build',
  'web-build-integrity': 'npm run build:verify',
  'web-build-budget': 'node scripts/web-build-budget.mjs build --strict',
  'typed-release-typecheck': 'npx --no-install tsc -p quality/release/tsconfig.json',
  'typed-release-tests': 'node --test quality/release/*.test.mts',
  'typed-release-scorecard': 'node quality/release/cli.mts --strict',
  'typed-release-exact-base': 'BASE_SHA=${{ github.event.pull_request.base.sha }}; node quality/release/cli.mts --baseline /tmp/base.json',
  'backend-tests': 'dotnet run --project tests/Platform.Security.Tests/Platform.Security.Tests.csproj',
  'backend-user-publish': 'dotnet publish Api.User/Api.User.csproj',
  'backend-admin-publish': 'dotnet publish Api.Admin/Api.Admin.csproj',
  'architecture-module-graph': 'node tools/platform-module-graph.mjs --strict',
  'architecture-language-ratchet': 'node tools/platform-language-ratchet.mjs --strict',
  'architecture-platform-boundary': 'node tools/platform-boundary-audit.mjs --strict',
  'architecture-browser-boundary': 'node tools/browser-runtime-boundary.mjs --strict',
  'platform-tests-typecheck': 'npm run typecheck:platform-tests',
  'platform-focused-tests': 'npx --no-install vitest run src/platform',
  'release-contract-adversarial': 'node --test scripts/release-evidence-audit.test.mjs',
  'release-contract-supply-chain': 'node --test scripts/workflow-security-contract.test.mjs',
  'release-contract-shell': 'node --test scripts/workflow-shell-security-contract.test.mjs',
  'release-contract-permissions': 'node --test scripts/workflow-permissions-contract.test.mjs',
  'release-contract-reliability': 'node --test scripts/workflow-reliability-contract.test.mjs',
});

function jobBlock(name: string, steps: readonly { readonly id: string; readonly name: string }[]): string {
  const rendered = steps.map(({ id, name }) => {
    const command = COMMANDS[id] ?? `echo ${id}`;
    return `      - name: ${name}\n        run: ${command}\n`;
  }).join('');
  return `  ${name}:\n    runs-on: ubuntu-latest\n    timeout-minutes: 30\n    steps:\n${rendered}`;
}

function workflowFixture(path: string): FixtureFileInput {
  const requirements = RELEASE_EVIDENCE_REQUIREMENTS.filter(item => item.workflow === path);
  const byJob = new Map<string, { id: string; name: string }[]>();
  for (const requirement of requirements) {
    const job = requirement.job ?? 'validation';
    const list = byJob.get(job) ?? [];
    list.push({ id: requirement.id, name: requirement.step });
    byJob.set(job, list);
  }
  const jobs = [...byJob.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([job, steps]) => jobBlock(job, steps))
    .join('');
  return {
    path,
    text: `name: ${path}\non:\n  pull_request:\npermissions:\n  contents: read\nconcurrency:\n  group: qa-\${{ github.ref }}\n  cancel-in-progress: true\njobs:\n${jobs}`,
  };
}

function allFixtures(): FixtureFileInput[] {
  return [...new Set(RELEASE_EVIDENCE_REQUIREMENTS.map(item => item.workflow))]
    .map(workflowFixture);
}

function audit(overrides: readonly FixtureFileInput[] = []) {
  const replacement = new Map(overrides.map(item => [item.path, item]));
  const inputs = allFixtures().map(item => replacement.get(item.path) ?? item);
  return auditReleaseEvidenceMatrix(fixtureInventory(inputs));
}

function removeStep(path: string, step: string): FixtureFileInput {
  const fixture = workflowFixture(path);
  const lines = fixture.text.split('\n');
  const nameIndex = lines.findIndex(line => line.trim() === `- name: ${step}`);
  if (nameIndex < 0) throw new Error(`step not found: ${step}`);
  lines.splice(nameIndex, 2);
  return { path, text: lines.join('\n') };
}

function replaceCommand(path: string, step: string, command: string): FixtureFileInput {
  const fixture = workflowFixture(path);
  const lines = fixture.text.split('\n');
  const nameIndex = lines.findIndex(line => line.trim() === `- name: ${step}`);
  if (nameIndex < 0) throw new Error(`step not found: ${step}`);
  lines[nameIndex + 1] = `        run: ${command}`;
  return { path, text: lines.join('\n') };
}

test('canonical evidence matrix has complete coverage', () => {
  const section = audit();
  assert.deepEqual(section.findings, []);
  assert.equal(section.summary.requiredEvidence, RELEASE_EVIDENCE_REQUIREMENTS.length);
  assert.equal(section.summary.satisfiedEvidence, RELEASE_EVIDENCE_REQUIREMENTS.length);
  assert.equal(section.summary.criticalSatisfied, section.summary.criticalEvidence);
  assert.equal(section.summary.coverageRatio, 1);
  assert.match(section.summary.fingerprint, /^[0-9a-f]{16}$/u);
});

test('requirement identifiers are unique', () => {
  const ids = RELEASE_EVIDENCE_REQUIREMENTS.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('each requirement has explicit purpose and canonical workflow', () => {
  for (const requirement of RELEASE_EVIDENCE_REQUIREMENTS) {
    assert.ok(requirement.purpose.length >= 20);
    assert.match(requirement.workflow, /^\.github\/workflows\/.*\.yml$/u);
    assert.ok(requirement.step.length > 3);
  }
});

test('matrix covers every intended release evidence domain', () => {
  const domains = new Set(RELEASE_EVIDENCE_REQUIREMENTS.map(item => item.domain));
  assert.deepEqual([...domains].sort(), [
    'architecture',
    'backend',
    'build',
    'dependencies',
    'regression',
    'security',
    'static-analysis',
    'testing',
  ]);
});

test('critical evidence dominates the release matrix', () => {
  const critical = RELEASE_EVIDENCE_REQUIREMENTS.filter(item => item.critical);
  assert.ok(critical.length > RELEASE_EVIDENCE_REQUIREMENTS.length / 2);
});

test('missing critical Webclient exact-base type evidence is high severity', () => {
  const section = audit([
    removeStep('.github/workflows/webclient-quality.yml', 'Exact-base TypeScript regression gate'),
  ]);
  const finding = section.findings.find(item => item.id === 'release-critical-evidence-missing');
  assert.equal(finding?.severity, 'high');
  assert.match(finding?.message ?? '', /web-exact-base-typecheck/u);
});

test('missing non-critical full lint visibility is medium severity', () => {
  const section = audit([
    removeStep('.github/workflows/webclient-quality.yml', 'Full lint visibility'),
  ]);
  const finding = section.findings.find(item => item.id === 'release-evidence-missing');
  assert.equal(finding?.severity, 'medium');
});

test('missing production build evidence reduces coverage', () => {
  const section = audit([
    removeStep('.github/workflows/webclient-quality.yml', 'Production Vite build and integrity manifest'),
  ]);
  assert.equal(section.summary.satisfiedEvidence, section.summary.requiredEvidence - 1);
  assert.ok(section.summary.coverageRatio < 1);
});

test('missing integrity verification is independently visible', () => {
  const section = audit([
    removeStep('.github/workflows/webclient-quality.yml', 'Verify production bundle integrity'),
  ]);
  assert.ok(section.findings.some(item => item.message.includes('web-build-integrity')));
});

test('missing budget enforcement is independently visible', () => {
  const section = audit([
    removeStep('.github/workflows/webclient-quality.yml', 'Enforce production build budgets'),
  ]);
  assert.ok(section.findings.some(item => item.message.includes('web-build-budget')));
});

test('missing typed release scorecard blocks critical coverage completeness', () => {
  const section = audit([
    removeStep('.github/workflows/release-qa.yml', 'Generate whole-repository release scorecard'),
  ]);
  assert.ok(section.summary.criticalSatisfied < section.summary.criticalEvidence);
  assert.ok(section.findings.some(item => item.message.includes('typed-release-scorecard')));
});

test('missing backend test evidence is visible separately from publish evidence', () => {
  const section = audit([
    removeStep('.github/workflows/release-qa.yml', 'Run xUnit v3 tests through Microsoft.Testing.Platform'),
  ]);
  assert.ok(section.findings.some(item => item.message.includes('backend-tests')));
  assert.equal(section.summary.observations.find(item => item.requirement.id === 'backend-user-publish')?.present, true);
});

test('missing User API publish evidence is detected', () => {
  const section = audit([removeStep('.github/workflows/release-qa.yml', 'Publish User API')]);
  assert.ok(section.findings.some(item => item.message.includes('backend-user-publish')));
});

test('missing Admin API publish evidence is detected', () => {
  const section = audit([removeStep('.github/workflows/release-qa.yml', 'Publish Admin API')]);
  assert.ok(section.findings.some(item => item.message.includes('backend-admin-publish')));
});

test('missing architecture module graph evidence is detected', () => {
  const section = audit([
    removeStep('.github/workflows/platform-architecture-audit.yml', 'Enforce typed module graph'),
  ]);
  assert.ok(section.findings.some(item => item.message.includes('architecture-module-graph')));
});

test('missing architecture boundary evidence is detected', () => {
  const section = audit([
    removeStep('.github/workflows/platform-architecture-audit.yml', 'Enforce Platform responsibility boundaries'),
  ]);
  assert.ok(section.findings.some(item => item.message.includes('architecture-platform-boundary')));
});

test('missing browser runtime boundary evidence is detected', () => {
  const section = audit([
    removeStep('.github/workflows/platform-architecture-audit.yml', 'Enforce browser runtime boundary'),
  ]);
  assert.ok(section.findings.some(item => item.message.includes('architecture-browser-boundary')));
});

test('missing strict Platform test typecheck evidence is detected', () => {
  const section = audit([
    removeStep('.github/workflows/platform-typed-test-validation.yml', 'Strict Platform test TypeScript'),
  ]);
  assert.ok(section.findings.some(item => item.message.includes('platform-tests-typecheck')));
});

test('missing focused Platform regression tests are detected', () => {
  const section = audit([
    removeStep('.github/workflows/platform-typed-test-validation.yml', 'Focused migrated Platform tests'),
  ]);
  assert.ok(section.findings.some(item => item.message.includes('platform-focused-tests')));
});

test('missing release contract supply-chain test is detected', () => {
  const section = audit([
    removeStep('.github/workflows/release-evidence-contract.yml', 'Workflow supply-chain security contract'),
  ]);
  assert.ok(section.findings.some(item => item.message.includes('release-contract-supply-chain')));
});

test('missing release shell security contract is detected', () => {
  const section = audit([
    removeStep('.github/workflows/release-evidence-contract.yml', 'Workflow shell security contract'),
  ]);
  assert.ok(section.findings.some(item => item.message.includes('release-contract-shell')));
});

test('missing release permission contract is detected', () => {
  const section = audit([
    removeStep('.github/workflows/release-evidence-contract.yml', 'Workflow permission and trigger contract'),
  ]);
  assert.ok(section.findings.some(item => item.message.includes('release-contract-permissions')));
});

test('lane summaries account for all requirements exactly once', () => {
  const section = audit();
  const requirements = section.summary.lanes.reduce((sum, lane) => sum + lane.requirements, 0);
  const satisfied = section.summary.lanes.reduce((sum, lane) => sum + lane.satisfied, 0);
  assert.equal(requirements, section.summary.requiredEvidence);
  assert.equal(satisfied, section.summary.satisfiedEvidence);
});

test('lane summary critical counters are internally consistent', () => {
  const section = audit();
  assert.equal(
    section.summary.lanes.reduce((sum, lane) => sum + lane.criticalRequirements, 0),
    section.summary.criticalEvidence,
  );
  assert.equal(
    section.summary.lanes.reduce((sum, lane) => sum + lane.criticalSatisfied, 0),
    section.summary.criticalSatisfied,
  );
});

test('matrix observations retain canonical workflow and job ownership', () => {
  const section = audit();
  const observation = section.summary.observations.find(item => item.requirement.id === 'typed-release-tests');
  assert.equal(observation?.workflow, '.github/workflows/release-qa.yml');
  assert.equal(observation?.job, 'typed-release-audit');
  assert.ok((observation?.line ?? 0) > 0);
});

test('renaming a canonical job makes its evidence absent', () => {
  const fixture = workflowFixture('.github/workflows/release-qa.yml');
  const changed = fixture.text.replace('  typed-release-audit:', '  combined-validation:');
  const section = audit([{ path: fixture.path, text: changed }]);
  assert.ok(section.findings.some(item => item.message.includes('typed-release-typecheck')));
  assert.ok(section.findings.some(item => item.id === 'release-lane-separation-missing'));
});

test('collapsing backend lane under webclient job violates lane separation', () => {
  const fixture = workflowFixture('.github/workflows/release-qa.yml');
  const changed = fixture.text.replace('  backend-release-validation:', '  backend-release-validation-renamed:');
  const section = audit([{ path: fixture.path, text: changed }]);
  assert.ok(section.findings.some(item => item.id === 'release-lane-separation-missing'));
});

test('step name alone cannot fake lockfile installation evidence', () => {
  const section = audit([
    replaceCommand('.github/workflows/webclient-quality.yml', 'Install from lockfile', 'echo skipped'),
  ]);
  assert.ok(section.findings.some(item => item.id === 'release-evidence-command-drift'));
  assert.match(section.findings.find(item => item.id === 'release-evidence-command-drift')?.message ?? '', /lockfile/u);
});

test('step name alone cannot fake dependency vulnerability evidence', () => {
  const section = audit([
    replaceCommand('.github/workflows/webclient-quality.yml', 'Production dependency audit', 'echo safe'),
  ]);
  assert.ok(section.findings.some(item => item.id === 'release-evidence-command-drift'));
});

test('step name alone cannot fake production build evidence', () => {
  const section = audit([
    replaceCommand('.github/workflows/webclient-quality.yml', 'Production Vite build and integrity manifest', 'echo build'),
  ]);
  assert.ok(section.findings.some(item => item.id === 'release-evidence-command-drift'));
});

test('step name alone cannot fake bundle integrity evidence', () => {
  const section = audit([
    replaceCommand('.github/workflows/webclient-quality.yml', 'Verify production bundle integrity', 'echo integrity'),
  ]);
  assert.ok(section.findings.some(item => item.id === 'release-evidence-command-drift'));
});

test('step name alone cannot fake typed release test evidence', () => {
  const section = audit([
    replaceCommand('.github/workflows/release-qa.yml', 'Typed QA unit and regression tests', 'echo tests'),
  ]);
  assert.ok(section.findings.some(item => item.id === 'release-evidence-command-drift'));
});

test('step name alone cannot fake typed release scorecard evidence', () => {
  const section = audit([
    replaceCommand('.github/workflows/release-qa.yml', 'Generate whole-repository release scorecard', 'echo scorecard'),
  ]);
  assert.ok(section.findings.some(item => item.id === 'release-evidence-command-drift'));
});

test('step name alone cannot fake backend xUnit evidence', () => {
  const section = audit([
    replaceCommand('.github/workflows/release-qa.yml', 'Run xUnit v3 tests through Microsoft.Testing.Platform', 'dotnet --info'),
  ]);
  assert.ok(section.findings.some(item => item.id === 'release-evidence-command-drift'));
});

test('step name alone cannot fake User API publish evidence', () => {
  const section = audit([
    replaceCommand('.github/workflows/release-qa.yml', 'Publish User API', 'echo user'),
  ]);
  assert.ok(section.findings.some(item => item.id === 'release-evidence-command-drift'));
});

test('step name alone cannot fake Admin API publish evidence', () => {
  const section = audit([
    replaceCommand('.github/workflows/release-qa.yml', 'Publish Admin API', 'echo admin'),
  ]);
  assert.ok(section.findings.some(item => item.id === 'release-evidence-command-drift'));
});

test('exact-base evidence commands retain pull-request base semantics', () => {
  const section = audit();
  for (const id of ['web-exact-base-typecheck', 'web-exact-base-tests', 'typed-release-exact-base']) {
    const observation = section.summary.observations.find(item => item.requirement.id === id);
    assert.match(observation?.command ?? '', /pull_request\.base\.sha/u);
  }
});

test('moving exact-base command to a branch ref is command drift', () => {
  const section = audit([
    replaceCommand('.github/workflows/webclient-quality.yml', 'Exact-base TypeScript regression gate', 'BASE_SHA=${{ github.ref }}; node scripts/typecheck-regression.mjs'),
  ]);
  assert.ok(section.findings.some(item => item.id === 'release-evidence-command-drift'));
});

test('matrix fingerprint is deterministic', () => {
  const first = audit().summary.fingerprint;
  const second = audit().summary.fingerprint;
  assert.equal(second, first);
});

test('matrix fingerprint changes when evidence disappears', () => {
  const first = audit().summary.fingerprint;
  const second = audit([
    removeStep('.github/workflows/webclient-quality.yml', 'Exact-base Vitest regression gate'),
  ]).summary.fingerprint;
  assert.notEqual(second, first);
});

test('matrix markdown exposes coverage, lanes, fingerprint and evidence status', () => {
  const markdown = releaseEvidenceMatrixMarkdown(audit());
  assert.match(markdown, /# Release Evidence Matrix/u);
  assert.match(markdown, /Coverage: 100\.00%/u);
  assert.match(markdown, /Critical evidence:/u);
  assert.match(markdown, /Fingerprint:/u);
  assert.match(markdown, /web-exact-base-typecheck/u);
  assert.match(markdown, /\*\*PASS\*\*/u);
});

test('matrix markdown exposes missing evidence after regression', () => {
  const markdown = releaseEvidenceMatrixMarkdown(audit([
    removeStep('.github/workflows/webclient-quality.yml', 'Verify production bundle integrity'),
  ]));
  assert.match(markdown, /\*\*MISSING\*\*/u);
  assert.match(markdown, /web-build-integrity/u);
});

test('missing entire workflow marks every owned requirement missing', () => {
  const fixtures = allFixtures().filter(item => item.path !== '.github/workflows/platform-typed-test-validation.yml');
  const section = auditReleaseEvidenceMatrix(fixtureInventory(fixtures));
  const owned = RELEASE_EVIDENCE_REQUIREMENTS.filter(item => item.workflow === '.github/workflows/platform-typed-test-validation.yml');
  const missing = section.summary.observations.filter(item =>
    item.requirement.workflow === '.github/workflows/platform-typed-test-validation.yml' && !item.present);
  assert.equal(missing.length, owned.length);
});

test('observations are emitted in stable policy order', () => {
  const ids = audit().summary.observations.map(item => item.requirement.id);
  assert.deepEqual(ids, RELEASE_EVIDENCE_REQUIREMENTS.map(item => item.id));
});

test('all critical missing evidence yields high findings rather than silent coverage loss', () => {
  const fixtures = allFixtures().map(item => ({ ...item, text: item.text.replace(/      - name:[\s\S]*/u, '') }));
  const section = auditReleaseEvidenceMatrix(fixtureInventory(fixtures));
  const criticalMissing = section.summary.observations.filter(item => item.requirement.critical && !item.present).length;
  const highMissing = section.findings.filter(item => item.id === 'release-critical-evidence-missing').length;
  assert.equal(highMissing, criticalMissing);
  assert.ok(criticalMissing > 0);
});
