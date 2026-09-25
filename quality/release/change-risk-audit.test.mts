import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditChangeRisk,
  changeRiskMarkdown,
  collectRepositoryChanges,
  summarizeChangeRisk,
} from './change-risk-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function inv(files: readonly FixtureFileInput[]) {
  return fixtureInventory(files);
}

function ids(baseline: readonly FixtureFileInput[], current: readonly FixtureFileInput[]) {
  return auditChangeRisk(inv(baseline), inv(current)).findings.map(finding => finding.id);
}

function has(
  baseline: readonly FixtureFileInput[],
  current: readonly FixtureFileInput[],
  id: string,
): boolean {
  return ids(baseline, current).includes(id);
}

const GIS_RUNTIME = {
  path: 'Webclient.app/src/gis/runtime/LayerBudget.ts',
  text: 'export const budget = 4;\n',
};
const GIS_TEST = {
  path: 'Webclient.app/src/gis/runtime/LayerBudget.test.ts',
  text: 'test("budget", () => {});\n',
};
const FRONTEND = {
  path: 'Webclient.app/src/components/Card.tsx',
  text: 'export function Card() { return null; }\n',
};
const FRONTEND_TEST = {
  path: 'Webclient.app/src/components/Card.test.tsx',
  text: 'test("card", () => {});\n',
};
const SECURITY = {
  path: 'Webclient.app/src/auth/sessionRuntime.ts',
  text: 'export const session = true;\n',
};
const SECURITY_TEST = {
  path: 'Webclient.app/src/auth/session.security.test.ts',
  text: 'test("session", () => {});\n',
};
const RELEASE_QA = {
  path: '.github/workflows/release-qa.yml',
  text: 'name: Release QA\npermissions:\n  contents: read\n',
};
const WORKFLOW_TEST = {
  path: 'Webclient.app/scripts/workflow-security-contract.test.mjs',
  text: 'test("workflow", () => {});\n',
};
const PR_GATE = {
  path: 'quality/release/pr-gate.mts',
  text: 'export const gate = true;\n',
};
const PR_GATE_TEST = {
  path: 'quality/release/pr-gate.test.mts',
  text: 'test("gate", () => {});\n',
};

test('unchanged inventories produce no changes or findings', () => {
  const baseline = inv([GIS_RUNTIME, GIS_TEST]);
  const current = inv([GIS_RUNTIME, GIS_TEST]);
  assert.deepEqual(collectRepositoryChanges(baseline, current), []);
  const section = auditChangeRisk(baseline, current);
  assert.equal(section.findings.length, 0);
  assert.equal(section.summary.changeCount, 0);
});

test('added production file is modeled as added', () => {
  const changes = collectRepositoryChanges(inv([]), inv([FRONTEND]));
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.kind, 'added');
  assert.equal(changes[0]?.path, FRONTEND.path);
  assert.equal(changes[0]?.production, true);
});

test('removed production file is modeled as removed', () => {
  const changes = collectRepositoryChanges(inv([FRONTEND]), inv([]));
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.kind, 'removed');
  assert.equal(changes[0]?.lineDelta, -2);
});

test('modified file carries before and after snapshots', () => {
  const changes = collectRepositoryChanges(
    inv([{ ...FRONTEND, text: 'export const value = 1;\n' }]),
    inv([{ ...FRONTEND, text: 'export const value = 2;\n' }]),
  );
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.kind, 'modified');
  assert.equal(changes[0]?.before?.text.includes('1'), true);
  assert.equal(changes[0]?.after?.text.includes('2'), true);
});

test('exact-content move is recognized as rename instead of add plus remove', () => {
  const before = { path: 'Webclient.app/src/gis/OldLayer.ts', text: 'export const layer = 1;\n' };
  const after = { path: 'Webclient.app/src/gis/NewLayer.ts', text: 'export const layer = 1;\n' };
  const changes = collectRepositoryChanges(inv([before]), inv([after]));
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.kind, 'renamed');
  assert.equal(changes[0]?.previousPath, before.path);
  assert.equal(changes[0]?.path, after.path);
});

test('content-changing move is not hidden as exact rename', () => {
  const before = { path: 'Webclient.app/src/gis/OldLayer.ts', text: 'export const layer = 1;\n' };
  const after = { path: 'Webclient.app/src/gis/NewLayer.ts', text: 'export const layer = 2;\n' };
  const changes = collectRepositoryChanges(inv([before]), inv([after]));
  assert.equal(changes.length, 2);
  assert.ok(changes.some(change => change.kind === 'added'));
  assert.ok(changes.some(change => change.kind === 'removed'));
});

test('documentation-only change stays outside production count', () => {
  const baseline = inv([{ path: 'docs/runbook.md', text: 'old\n' }]);
  const current = inv([{ path: 'docs/runbook.md', text: 'new\n' }]);
  const section = auditChangeRisk(baseline, current);
  assert.equal(section.summary.productionChanges, 0);
  assert.equal(section.summary.documentationChanges, 1);
  assert.equal(section.findings.length, 0);
});

test('GIS production change without GIS evidence is high risk', () => {
  const baseline = [GIS_RUNTIME];
  const current = [{ ...GIS_RUNTIME, text: 'export const budget = 5;\n' }];
  const section = auditChangeRisk(inv(baseline), inv(current));
  const finding = section.findings.find(item => item.id === 'change-risk-gis-evidence-missing');
  assert.equal(finding?.severity, 'high');
});

test('GIS production change with focused GIS test is covered', () => {
  const baseline = [GIS_RUNTIME, GIS_TEST];
  const current = [
    { ...GIS_RUNTIME, text: 'export const budget = 5;\n' },
    { ...GIS_TEST, text: 'test("budget pressure", () => {});\n' },
  ];
  assert.equal(has(baseline, current, 'change-risk-gis-evidence-missing'), false);
});

test('unrelated frontend test does not satisfy GIS evidence', () => {
  const baseline = [GIS_RUNTIME, FRONTEND_TEST];
  const current = [
    { ...GIS_RUNTIME, text: 'export const budget = 5;\n' },
    { ...FRONTEND_TEST, text: 'test("card changed", () => {});\n' },
  ];
  assert.equal(has(baseline, current, 'change-risk-gis-evidence-missing'), true);
});

test('Webclient quality workflow change can satisfy GIS validation ownership', () => {
  const workflow = {
    path: '.github/workflows/webclient-quality.yml',
    text: 'name: Webclient Quality\n',
  };
  const baseline = [GIS_RUNTIME, workflow];
  const current = [
    { ...GIS_RUNTIME, text: 'export const budget = 5;\n' },
    { ...workflow, text: 'name: Webclient Quality\n# stronger gis gate\n' },
  ];
  assert.equal(has(baseline, current, 'change-risk-gis-evidence-missing'), false);
});

test('security-sensitive change without security test is high risk', () => {
  const baseline = [SECURITY];
  const current = [{ ...SECURITY, text: 'export const session = false;\n' }];
  const section = auditChangeRisk(inv(baseline), inv(current));
  const finding = section.findings.find(item => item.id === 'change-risk-security-evidence-missing');
  assert.equal(finding?.severity, 'high');
});

test('security-sensitive change with security test is covered', () => {
  const baseline = [SECURITY, SECURITY_TEST];
  const current = [
    { ...SECURITY, text: 'export const session = false;\n' },
    { ...SECURITY_TEST, text: 'test("session expiry", () => {});\n' },
  ];
  assert.equal(has(baseline, current, 'change-risk-security-evidence-missing'), false);
});

test('backend API change requires backend evidence', () => {
  const endpoint = {
    path: 'Api.User/Controllers/ParcelController.cs',
    text: '[HttpGet]\npublic IActionResult Get() => Ok();\n',
  };
  const changed = { ...endpoint, text: '[HttpGet]\npublic IActionResult Get() => Ok("v2");\n' };
  assert.equal(has([endpoint], [changed], 'change-risk-backend-api-evidence-missing'), true);
});

test('backend test satisfies backend API evidence', () => {
  const endpoint = {
    path: 'Api.User/Controllers/ParcelController.cs',
    text: '[HttpGet]\npublic IActionResult Get() => Ok();\n',
  };
  const backendTest = {
    path: 'tests/Platform.Security.Tests/ParcelControllerTests.cs',
    text: 'public class ParcelControllerTests {}\n',
  };
  const baseline = [endpoint, backendTest];
  const current = [
    { ...endpoint, text: '[HttpGet]\npublic IActionResult Get() => Ok("v2");\n' },
    { ...backendTest, text: 'public class ParcelControllerTests { /* v2 */ }\n' },
  ];
  assert.equal(has(baseline, current, 'change-risk-backend-api-evidence-missing'), false);
});

test('search change requires focused search test', () => {
  const runtime = { path: 'Webclient.app/src/search/addressSession.ts', text: 'export const limit = 5;\n' };
  const current = { ...runtime, text: 'export const limit = 10;\n' };
  assert.equal(has([runtime], [current], 'change-risk-search-evidence-missing'), true);
});

test('search test covers search change', () => {
  const runtime = { path: 'Webclient.app/src/search/addressSession.ts', text: 'export const limit = 5;\n' };
  const searchTest = { path: 'Webclient.app/src/search/addressSession.test.ts', text: 'test("limit", () => {});\n' };
  const baseline = [runtime, searchTest];
  const current = [
    { ...runtime, text: 'export const limit = 10;\n' },
    { ...searchTest, text: 'test("new limit", () => {});\n' },
  ];
  assert.equal(has(baseline, current, 'change-risk-search-evidence-missing'), false);
});

test('accessibility-sensitive component change requires focused evidence', () => {
  const component = {
    path: 'Webclient.app/src/components/Toolbar.tsx',
    text: '<button aria-label="Open">Open</button>\n',
  };
  const current = { ...component, text: '<button aria-label="Close">Close</button>\n' };
  assert.equal(has([component], [current], 'change-risk-accessibility-evidence-missing'), true);
});

test('accessibility test covers accessibility-sensitive component change', () => {
  const component = {
    path: 'Webclient.app/src/components/dialog/Dialog.tsx',
    text: '<button aria-label="Open">Open</button>\n',
  };
  const a11yTest = {
    path: 'Webclient.app/src/components/dialog/Dialog.accessibility.test.tsx',
    text: 'test("focus", () => {});\n',
  };
  const baseline = [component, a11yTest];
  const current = [
    { ...component, text: '<button aria-label="Close">Close</button>\n' },
    { ...a11yTest, text: 'test("focus restore", () => {});\n' },
  ];
  assert.equal(has(baseline, current, 'change-risk-accessibility-evidence-missing'), false);
});

test('responsive change can produce medium missing-evidence finding', () => {
  const css = { path: 'Webclient.app/src/styles/layout.css', text: '.shell { width: 900px; }\n' };
  const current = { ...css, text: '@media (max-width: 700px) { .shell { width: 100%; } }\n' };
  const section = auditChangeRisk(inv([css]), inv([current]));
  const finding = section.findings.find(item => item.id === 'change-risk-responsive-evidence-missing');
  assert.equal(finding?.severity, 'medium');
});

test('observability change can produce medium missing-evidence finding', () => {
  const file = { path: 'Api.Core/Logging/RequestLogger.cs', text: 'public class RequestLogger {}\n' };
  const current = { ...file, text: 'public class RequestLogger { /* correlation */ }\n' };
  const section = auditChangeRisk(inv([file]), inv([current]));
  const finding = section.findings.find(item => item.id === 'change-risk-observability-evidence-missing');
  assert.equal(finding?.severity, 'medium');
});

test('performance change can produce medium missing-evidence finding', () => {
  const file = { path: 'Webclient.app/src/platform/cache/requestCache.ts', text: 'export const size = 10;\n' };
  const current = { ...file, text: 'export const size = 20;\n' };
  const section = auditChangeRisk(inv([file]), inv([current]));
  const finding = section.findings.find(item => item.id === 'change-risk-performance-evidence-missing');
  assert.equal(finding?.severity, 'medium');
});

test('database schema change requires database evidence', () => {
  const sql = { path: 'database/migrations/001.sql', text: 'CREATE TABLE a(id int);\n' };
  const current = { ...sql, text: 'ALTER TABLE a ADD name text;\n' };
  assert.equal(has([sql], [current], 'change-risk-database-evidence-missing'), true);
});

test('database-focused test covers schema change', () => {
  const sql = { path: 'database/migrations/001.sql', text: 'CREATE TABLE a(id int);\n' };
  const dbTest = { path: 'tests/Platform.Security.Tests/DatabaseMigrationTests.cs', text: 'public class DatabaseMigrationTests {}\n' };
  const baseline = [sql, dbTest];
  const current = [
    { ...sql, text: 'ALTER TABLE a ADD name text;\n' },
    { ...dbTest, text: 'public class DatabaseMigrationTests { /* new */ }\n' },
  ];
  assert.equal(has(baseline, current, 'change-risk-database-evidence-missing'), false);
});

test('critical release QA workflow deletion is blocking critical', () => {
  const section = auditChangeRisk(inv([RELEASE_QA]), inv([]));
  const finding = section.findings.find(item => item.id === 'change-risk-critical-validation-removed');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('critical pr-gate implementation deletion is blocking critical', () => {
  const section = auditChangeRisk(inv([PR_GATE, PR_GATE_TEST]), inv([PR_GATE_TEST]));
  const finding = section.findings.find(item => item.id === 'change-risk-critical-validation-removed');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('ordinary release audit deletion does not use critical authority deletion rule', () => {
  const ordinary = { path: 'quality/release/example-audit.mts', text: 'export const audit = true;\n' };
  assert.equal(has([ordinary], [], 'change-risk-critical-validation-removed'), false);
});

test('test deletion without replacement is high severity', () => {
  const section = auditChangeRisk(inv([GIS_TEST]), inv([]));
  const finding = section.findings.find(item => item.id === 'change-risk-test-deleted-without-replacement');
  assert.equal(finding?.severity, 'high');
});

test('exact-content test rename is not treated as deleted coverage', () => {
  const before = { path: 'Webclient.app/src/gis/LayerBudget.test.ts', text: 'test("budget", () => {});\n' };
  const after = { path: 'Webclient.app/src/gis/LayerBudget.contract.test.ts', text: before.text };
  assert.equal(has([before], [after], 'change-risk-test-deleted-without-replacement'), false);
});

test('removed test with added same-area replacement is accepted', () => {
  const before = { path: 'Webclient.app/src/gis/OldLayer.test.ts', text: 'test("old", () => {});\n' };
  const after = { path: 'Webclient.app/src/gis/NewLayer.test.ts', text: 'test("new", () => {});\n' };
  assert.equal(has([before], [after], 'change-risk-test-deleted-without-replacement'), false);
});

test('dependency addition without lockfile update is high risk', () => {
  const manifest = {
    path: 'Webclient.app/package.json',
    text: '{"dependencies":{"react":"1"}}',
  };
  const lock = { path: 'Webclient.app/package-lock.json', text: '{"lockfileVersion":3}' };
  const currentManifest = {
    ...manifest,
    text: '{"dependencies":{"react":"1","axios":"2"}}',
  };
  const section = auditChangeRisk(inv([manifest, lock]), inv([currentManifest, lock]));
  const finding = section.findings.find(item => item.id === 'change-risk-dependency-lockfile-not-updated');
  assert.equal(finding?.severity, 'high');
});

test('dependency removal without lockfile update is high risk', () => {
  const manifest = {
    path: 'Webclient.app/package.json',
    text: '{"dependencies":{"react":"1","axios":"2"}}',
  };
  const lock = { path: 'Webclient.app/package-lock.json', text: '{"lockfileVersion":3}' };
  const currentManifest = { ...manifest, text: '{"dependencies":{"react":"1"}}' };
  assert.equal(has([manifest, lock], [currentManifest, lock], 'change-risk-dependency-lockfile-not-updated'), true);
});

test('dependency version change with lockfile update is accepted', () => {
  const manifest = { path: 'Webclient.app/package.json', text: '{"dependencies":{"react":"1"}}' };
  const lock = { path: 'Webclient.app/package-lock.json', text: '{"lockfileVersion":3,"v":1}' };
  const currentManifest = { ...manifest, text: '{"dependencies":{"react":"2"}}' };
  const currentLock = { ...lock, text: '{"lockfileVersion":3,"v":2}' };
  assert.equal(has([manifest, lock], [currentManifest, currentLock], 'change-risk-dependency-lockfile-not-updated'), false);
});

test('script-only package manifest change does not require lockfile update', () => {
  const manifest = {
    path: 'Webclient.app/package.json',
    text: '{"scripts":{"test":"node a"},"dependencies":{"react":"1"}}',
  };
  const lock = { path: 'Webclient.app/package-lock.json', text: '{"lockfileVersion":3}' };
  const currentManifest = {
    ...manifest,
    text: '{"scripts":{"test":"node b"},"dependencies":{"react":"1"}}',
  };
  assert.equal(has([manifest, lock], [currentManifest, lock], 'change-risk-dependency-lockfile-not-updated'), false);
});

test('invalid changed package manifest is critical and blocking', () => {
  const manifest = { path: 'Webclient.app/package.json', text: '{"dependencies":{}}' };
  const currentManifest = { ...manifest, text: '{' };
  const section = auditChangeRisk(inv([manifest]), inv([currentManifest]));
  const finding = section.findings.find(item => item.id === 'change-risk-invalid-package-manifest');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('root package dependency change pairs with root lockfile', () => {
  const manifest = { path: 'package.json', text: '{"dependencies":{"a":"1"}}' };
  const lock = { path: 'package-lock.json', text: '{"lockfileVersion":3,"v":1}' };
  const currentManifest = { ...manifest, text: '{"dependencies":{"a":"2"}}' };
  assert.equal(has([manifest, lock], [currentManifest, lock], 'change-risk-dependency-lockfile-not-updated'), true);
});

test('workflow change without contract test is high risk', () => {
  const current = { ...RELEASE_QA, text: `${RELEASE_QA.text}# changed\n` };
  const section = auditChangeRisk(inv([RELEASE_QA]), inv([current]));
  const finding = section.findings.find(item => item.id === 'change-risk-workflow-contract-test-missing');
  assert.equal(finding?.severity, 'high');
});

test('workflow change with workflow security contract test is covered', () => {
  const baseline = [RELEASE_QA, WORKFLOW_TEST];
  const current = [
    { ...RELEASE_QA, text: `${RELEASE_QA.text}# changed\n` },
    { ...WORKFLOW_TEST, text: 'test("workflow hardening", () => {});\n' },
  ];
  assert.equal(has(baseline, current, 'change-risk-workflow-contract-test-missing'), false);
});

test('release implementation change without typed test is high risk', () => {
  const current = { ...PR_GATE, text: 'export const gate = false;\n' };
  const section = auditChangeRisk(inv([PR_GATE]), inv([current]));
  const finding = section.findings.find(item => item.id === 'change-risk-release-tooling-self-test-missing');
  assert.equal(finding?.severity, 'high');
});

test('release implementation change with typed self-test is covered', () => {
  const baseline = [PR_GATE, PR_GATE_TEST];
  const current = [
    { ...PR_GATE, text: 'export const gate = false;\n' },
    { ...PR_GATE_TEST, text: 'test("gate changed", () => {});\n' },
  ];
  assert.equal(has(baseline, current, 'change-risk-release-tooling-self-test-missing'), false);
});

test('renamed release implementation with identical content does not demand self-test', () => {
  const before = { path: 'quality/release/old-audit.mts', text: 'export const audit = true;\n' };
  const after = { path: 'quality/release/new-audit.mts', text: before.text };
  assert.equal(has([before], [after], 'change-risk-release-tooling-self-test-missing'), false);
});

test('production change set with no test changes gets aggregate test warning', () => {
  const current = { ...FRONTEND, text: 'export function Card() { return 1; }\n' };
  assert.equal(has([FRONTEND], [current], 'change-risk-production-without-any-test-change'), true);
});

test('any changed test suppresses aggregate no-test finding but not focused area gate', () => {
  const baseline = [GIS_RUNTIME, FRONTEND_TEST];
  const current = [
    { ...GIS_RUNTIME, text: 'export const budget = 8;\n' },
    { ...FRONTEND_TEST, text: 'test("card v2", () => {});\n' },
  ];
  const findings = ids(baseline, current);
  assert.equal(findings.includes('change-risk-production-without-any-test-change'), false);
  assert.equal(findings.includes('change-risk-gis-evidence-missing'), true);
});

test('broad cross-domain change set creates review finding', () => {
  const baseline = [
    { path: 'Webclient.app/src/auth/sessionRuntime.ts', text: 'export const x = 1;\n' },
    { path: 'Webclient.app/src/gis/layerRuntime.ts', text: 'export const x = 1;\n' },
    { path: 'Webclient.app/src/search/addressRuntime.ts', text: 'export const x = 1;\n' },
    { path: 'Webclient.app/src/platform/cache/requestCache.ts', text: 'export const x = 1;\n' },
    { path: 'Webclient.app/src/components/dialog/Dialog.tsx', text: '<button aria-label="x"/>\n' },
    { path: 'database/migrations/001.sql', text: 'CREATE TABLE a(id int);\n' },
  ];
  const current = baseline.map((file, index) => ({ ...file, text: `${file.text}// ${index}\n` }));
  const section = auditChangeRisk(inv(baseline), inv(current), {
    broadChangeAreaThreshold: 4,
    broadChangeProductionThreshold: 4,
  });
  assert.equal(section.findings.some(item => item.id === 'change-risk-broad-cross-domain-surface'), true);
});

test('small focused change set does not create broad review finding', () => {
  const current = { ...GIS_RUNTIME, text: 'export const budget = 9;\n' };
  assert.equal(has([GIS_RUNTIME], [current], 'change-risk-broad-cross-domain-surface'), false);
});

test('large production deletion creates architecture review finding', () => {
  const baseline = Array.from({ length: 8 }, (_, index) => ({
    path: `Webclient.app/src/legacy/Module${index}.ts`,
    text: `export const value${index} = ${index};\n`,
  }));
  const section = auditChangeRisk(inv(baseline), inv([]));
  const finding = section.findings.find(item => item.id === 'change-risk-large-production-deletion');
  assert.equal(finding?.severity, 'medium');
});

test('seven production deletions remain below large deletion threshold', () => {
  const baseline = Array.from({ length: 7 }, (_, index) => ({
    path: `Webclient.app/src/legacy/Module${index}.ts`,
    text: `export const value${index} = ${index};\n`,
  }));
  assert.equal(has(baseline, [], 'change-risk-large-production-deletion'), false);
});

test('summary counts add modify remove and rename separately', () => {
  const baseline = inv([
    { path: 'Webclient.app/src/a.ts', text: 'a\n' },
    { path: 'Webclient.app/src/b.ts', text: 'b\n' },
    { path: 'Webclient.app/src/old.ts', text: 'same\n' },
  ]);
  const current = inv([
    { path: 'Webclient.app/src/a.ts', text: 'a2\n' },
    { path: 'Webclient.app/src/c.ts', text: 'c\n' },
    { path: 'Webclient.app/src/new.ts', text: 'same\n' },
  ]);
  const summary = summarizeChangeRisk(collectRepositoryChanges(baseline, current));
  assert.equal(summary.added, 1);
  assert.equal(summary.modified, 1);
  assert.equal(summary.removed, 1);
  assert.equal(summary.renamed, 1);
  assert.equal(summary.changeCount, 4);
});

test('summary tracks net line and byte delta', () => {
  const baseline = inv([{ path: 'Webclient.app/src/a.ts', text: 'a\n' }]);
  const current = inv([{ path: 'Webclient.app/src/a.ts', text: 'a\nb\nc\n' }]);
  const summary = summarizeChangeRisk(collectRepositoryChanges(baseline, current));
  assert.equal(summary.netLineDelta > 0, true);
  assert.equal(summary.netByteDelta > 0, true);
});

test('summary exposes dependency manifest and lock changes', () => {
  const manifest = { path: 'Webclient.app/package.json', text: '{"dependencies":{"a":"1"}}' };
  const lock = { path: 'Webclient.app/package-lock.json', text: '{"v":1}' };
  const currentManifest = { ...manifest, text: '{"dependencies":{"a":"2"}}' };
  const currentLock = { ...lock, text: '{"v":2}' };
  const summary = summarizeChangeRisk(collectRepositoryChanges(inv([manifest, lock]), inv([currentManifest, currentLock])));
  assert.deepEqual(summary.dependencyManifestChanges, ['Webclient.app/package.json']);
  assert.deepEqual(summary.dependencyLockChanges, ['Webclient.app/package-lock.json']);
});

test('summary exposes deleted critical validation paths', () => {
  const summary = summarizeChangeRisk(collectRepositoryChanges(inv([RELEASE_QA]), inv([])));
  assert.deepEqual(summary.deletedCriticalValidation, ['.github/workflows/release-qa.yml']);
});

test('summary area coverage records changed production and evidence paths', () => {
  const baseline = inv([GIS_RUNTIME, GIS_TEST]);
  const current = inv([
    { ...GIS_RUNTIME, text: 'export const budget = 10;\n' },
    { ...GIS_TEST, text: 'test("budget 10", () => {});\n' },
  ]);
  const summary = summarizeChangeRisk(collectRepositoryChanges(baseline, current));
  const gis = summary.areaCoverage.find(item => item.area === 'gis');
  assert.equal(gis?.covered, true);
  assert.deepEqual(gis?.changedProductionFiles, [GIS_RUNTIME.path]);
  assert.deepEqual(gis?.changedEvidenceFiles, [GIS_TEST.path]);
});

test('summary area coverage reports missing evidence', () => {
  const baseline = inv([GIS_RUNTIME]);
  const current = inv([{ ...GIS_RUNTIME, text: 'export const budget = 10;\n' }]);
  const summary = summarizeChangeRisk(collectRepositoryChanges(baseline, current));
  const gis = summary.areaCoverage.find(item => item.area === 'gis');
  assert.equal(gis?.covered, false);
});

test('exact rename does not count as production behavior change', () => {
  const before = { path: 'Webclient.app/src/gis/OldLayer.ts', text: 'export const x = 1;\n' };
  const after = { path: 'Webclient.app/src/gis/NewLayer.ts', text: before.text };
  const summary = summarizeChangeRisk(collectRepositoryChanges(inv([before]), inv([after])));
  assert.equal(summary.renamed, 1);
  assert.equal(summary.productionChanges, 0);
});

test('requireFocusedEvidence option can enforce non-focused dependency area evidence', () => {
  const manifest = { path: 'Webclient.app/package.json', text: '{"dependencies":{"a":"1"}}' };
  const current = { ...manifest, text: '{"dependencies":{"a":"2"}}' };
  const section = auditChangeRisk(inv([manifest]), inv([current]), { requireFocusedEvidence: true });
  assert.equal(section.findings.some(item => item.id === 'change-risk-dependencies-evidence-missing'), true);
});

test('default dependency behavior relies on dedicated lockfile rule instead of generic focused gate', () => {
  const manifest = { path: 'Webclient.app/package.json', text: '{"dependencies":{"a":"1"}}' };
  const current = { ...manifest, text: '{"dependencies":{"a":"2"}}' };
  const section = auditChangeRisk(inv([manifest]), inv([current]));
  assert.equal(section.findings.some(item => item.id === 'change-risk-dependencies-evidence-missing'), false);
});

test('change findings are deterministic for same inventories', () => {
  const baseline = inv([GIS_RUNTIME, SECURITY, RELEASE_QA]);
  const current = inv([
    { ...GIS_RUNTIME, text: 'export const budget = 11;\n' },
    { ...SECURITY, text: 'export const session = false;\n' },
    { ...RELEASE_QA, text: `${RELEASE_QA.text}# changed\n` },
  ]);
  const first = auditChangeRisk(baseline, current);
  const second = auditChangeRisk(baseline, current);
  assert.deepEqual(first.findings, second.findings);
  assert.deepEqual(first.summary, second.summary);
});

test('markdown exposes core exact-base evidence fields', () => {
  const baseline = inv([GIS_RUNTIME]);
  const current = inv([{ ...GIS_RUNTIME, text: 'export const budget = 12;\n' }]);
  const markdown = changeRiskMarkdown(auditChangeRisk(baseline, current));
  assert.match(markdown, /Exact-Base Change Risk/u);
  assert.match(markdown, /Production changes: 1/u);
  assert.match(markdown, /gis/u);
  assert.match(markdown, /change-risk-gis-evidence-missing/u);
});

test('markdown reports clean change set without findings', () => {
  const baseline = inv([GIS_RUNTIME, GIS_TEST]);
  const current = inv([
    { ...GIS_RUNTIME, text: 'export const budget = 13;\n' },
    { ...GIS_TEST, text: 'test("budget 13", () => {});\n' },
  ]);
  const section = auditChangeRisk(baseline, current);
  const markdown = changeRiskMarkdown(section);
  assert.match(markdown, /Area evidence/u);
  assert.match(markdown, /covered/u);
});

test('elapsed time is non-negative', () => {
  const section = auditChangeRisk(inv([]), inv([]));
  assert.equal(section.elapsedMs >= 0, true);
});
