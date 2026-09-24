import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditProjectContractDelta,
  collectProjectContractDeltas,
  projectContractDeltaMarkdown,
} from './project-contract-delta-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function inv(files: readonly FixtureFileInput[]) {
  return fixtureInventory(files);
}

function audit(before: FixtureFileInput, after: FixtureFileInput) {
  return auditProjectContractDelta(inv([before]), inv([after]));
}

function has(before: FixtureFileInput, after: FixtureFileInput, id: string): boolean {
  return audit(before, after).findings.some(finding => finding.id === id);
}

function pkg(value: Record<string, unknown>): FixtureFileInput {
  return { path: 'Webclient.app/package.json', text: JSON.stringify(value, null, 2) };
}

function tsconfig(options: Record<string, unknown>): FixtureFileInput {
  return {
    path: 'Webclient.app/tsconfig.json',
    text: JSON.stringify({ compilerOptions: options }, null, 2),
  };
}

function props(body: string): FixtureFileInput {
  return { path: 'Directory.Build.props', text: `<Project><PropertyGroup>${body}</PropertyGroup></Project>` };
}

function globalJson(sdk: Record<string, unknown>): FixtureFileInput {
  return { path: 'global.json', text: JSON.stringify({ sdk }, null, 2) };
}

test('unchanged package manifest produces no contract deltas', () => {
  const file = pkg({ scripts: { build: 'vite build', test: 'vitest run' }, private: true });
  const section = auditProjectContractDelta(inv([file]), inv([file]));
  assert.equal(section.findings.length, 0);
  assert.equal(section.summary.packageManifestChanges, 0);
});

test('removing build script is critical and blocking', () => {
  const before = pkg({ scripts: { build: 'vite build', test: 'vitest run' } });
  const after = pkg({ scripts: { test: 'vitest run' } });
  const section = audit(before, after);
  const finding = section.findings.find(item => item.id === 'project-contract-package-script-removed');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('removing test script is critical and blocking', () => {
  const before = pkg({ scripts: { build: 'vite build', test: 'vitest run' } });
  const after = pkg({ scripts: { build: 'vite build' } });
  const section = audit(before, after);
  const finding = section.findings.find(item => item.id === 'project-contract-package-script-removed');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('removing verify script is critical and blocking', () => {
  const before = pkg({ scripts: { verify: 'npm run lint && npm test' } });
  const after = pkg({ scripts: {} });
  assert.equal(has(before, after, 'project-contract-package-script-removed'), true);
});

test('removing test tooling script is critical', () => {
  const before = pkg({ scripts: { 'test:tooling': 'node --test scripts/*.test.mjs' } });
  const after = pkg({ scripts: {} });
  const section = audit(before, after);
  assert.equal(section.findings[0]?.severity, 'critical');
});

test('removing dependency verify script is critical', () => {
  const before = pkg({ scripts: { 'dependency:verify': 'node scripts/dependency-verify.mjs' } });
  const after = pkg({ scripts: {} });
  assert.equal(has(before, after, 'project-contract-package-script-removed'), true);
});

test('removing build verify script is critical', () => {
  const before = pkg({ scripts: { 'build:verify': 'node scripts/build-verify.mjs' } });
  const after = pkg({ scripts: {} });
  assert.equal(has(before, after, 'project-contract-package-script-removed'), true);
});

test('changing build script is critical but not explicitly blocking', () => {
  const before = pkg({ scripts: { build: 'vite build' } });
  const after = pkg({ scripts: { build: 'vite build --mode production' } });
  const section = audit(before, after);
  const finding = section.findings.find(item => item.id === 'project-contract-package-script-changed');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, undefined);
});

test('whitespace-only command change is normalized away', () => {
  const before = pkg({ scripts: { build: 'vite   build' } });
  const after = pkg({ scripts: { build: 'vite build' } });
  assert.equal(audit(before, after).findings.length, 0);
});

test('adding new build script is not weakening', () => {
  const before = pkg({ scripts: {} });
  const after = pkg({ scripts: { build: 'vite build' } });
  assert.equal(audit(before, after).findings.length, 0);
});

test('removing lint strict script is high severity', () => {
  const before = pkg({ scripts: { 'lint:strict': 'oxlint --deny-warnings src' } });
  const after = pkg({ scripts: {} });
  const finding = audit(before, after).findings.find(item => item.id === 'project-contract-package-script-removed');
  assert.equal(finding?.severity, 'high');
});

test('changing typecheck script is high severity', () => {
  const before = pkg({ scripts: { typecheck: 'tsc --noEmit' } });
  const after = pkg({ scripts: { typecheck: 'tsc --noEmit --pretty false' } });
  const finding = audit(before, after).findings.find(item => item.id === 'project-contract-package-script-changed');
  assert.equal(finding?.severity, 'high');
});

test('quality prefixed script change is high severity', () => {
  const before = pkg({ scripts: { 'quality:gis': 'node old.mjs' } });
  const after = pkg({ scripts: { 'quality:gis': 'node new.mjs' } });
  const finding = audit(before, after).findings.find(item => item.id === 'project-contract-package-script-changed');
  assert.equal(finding?.severity, 'high');
});

test('ordinary start script change is outside project gate ownership', () => {
  const before = pkg({ scripts: { start: 'vite' } });
  const after = pkg({ scripts: { start: 'vite --host' } });
  assert.equal(audit(before, after).findings.length, 0);
});

test('removing node engine is high and blocking', () => {
  const before = pkg({ engines: { node: '>=24 <25' } });
  const after = pkg({ engines: {} });
  const finding = audit(before, after).findings.find(item => item.id === 'project-contract-node-engine-removed');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.blocking, true);
});

test('changing node engine is high severity', () => {
  const before = pkg({ engines: { node: '>=24 <25' } });
  const after = pkg({ engines: { node: '>=22 <25' } });
  assert.equal(has(before, after, 'project-contract-node-engine-changed'), true);
});

test('adding node engine is not weakening', () => {
  const before = pkg({});
  const after = pkg({ engines: { node: '>=24 <25' } });
  assert.equal(audit(before, after).findings.length, 0);
});

test('removing packageManager pin is high and blocking', () => {
  const before = pkg({ packageManager: 'npm@11.6.0' });
  const after = pkg({});
  const finding = audit(before, after).findings.find(item => item.id === 'project-contract-package-manager-removed');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.blocking, true);
});

test('changing packageManager pin is high severity', () => {
  const before = pkg({ packageManager: 'npm@11.6.0' });
  const after = pkg({ packageManager: 'npm@11.7.0' });
  assert.equal(has(before, after, 'project-contract-package-manager-changed'), true);
});

test('private true to false is high severity', () => {
  const before = pkg({ private: true });
  const after = pkg({ private: false });
  assert.equal(has(before, after, 'project-contract-package-private-weakened'), true);
});

test('private true removal is visible', () => {
  const before = pkg({ private: true });
  const after = pkg({});
  assert.equal(has(before, after, 'project-contract-package-private-weakened'), true);
});

test('adding private true is not weakening', () => {
  const before = pkg({});
  const after = pkg({ private: true });
  assert.equal(audit(before, after).findings.length, 0);
});

test('ES module type removal is high severity', () => {
  const before = pkg({ type: 'module' });
  const after = pkg({});
  assert.equal(has(before, after, 'project-contract-module-type-weakened'), true);
});

test('ES module type switched to commonjs is high severity', () => {
  const before = pkg({ type: 'module' });
  const after = pkg({ type: 'commonjs' });
  assert.equal(has(before, after, 'project-contract-module-type-weakened'), true);
});

test('strict TypeScript true to false is critical and blocking', () => {
  const before = tsconfig({ strict: true });
  const after = tsconfig({ strict: false });
  const finding = audit(before, after).findings.find(item => item.id === 'project-contract-typescript-strictness-weakened');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('strict TypeScript true removal is critical', () => {
  const before = tsconfig({ strict: true });
  const after = tsconfig({});
  assert.equal(has(before, after, 'project-contract-typescript-strictness-weakened'), true);
});

test('enabling strict TypeScript is not weakening', () => {
  const before = tsconfig({ strict: false });
  const after = tsconfig({ strict: true });
  assert.equal(audit(before, after).findings.length, 0);
});

test('noUncheckedIndexedAccess true removal is high severity', () => {
  const before = tsconfig({ strict: true, noUncheckedIndexedAccess: true });
  const after = tsconfig({ strict: true });
  const finding = audit(before, after).summary.deltas.find(item => item.contract === 'compilerOptions.noUncheckedIndexedAccess');
  assert.equal(finding?.severity, 'high');
});

test('exactOptionalPropertyTypes true to false is high severity', () => {
  const before = tsconfig({ strict: true, exactOptionalPropertyTypes: true });
  const after = tsconfig({ strict: true, exactOptionalPropertyTypes: false });
  const finding = audit(before, after).summary.deltas.find(item => item.contract === 'compilerOptions.exactOptionalPropertyTypes');
  assert.equal(finding?.severity, 'high');
});

test('useUnknownInCatchVariables true removal is high severity', () => {
  const before = tsconfig({ strict: true, useUnknownInCatchVariables: true });
  const after = tsconfig({ strict: true });
  const finding = audit(before, after).summary.deltas.find(item => item.contract === 'compilerOptions.useUnknownInCatchVariables');
  assert.equal(finding?.severity, 'high');
});

test('noEmit true to false is medium severity', () => {
  const before = tsconfig({ strict: true, noEmit: true });
  const after = tsconfig({ strict: true, noEmit: false });
  const finding = audit(before, after).findings.find(item => item.id === 'project-contract-typescript-noemit-weakened');
  assert.equal(finding?.severity, 'medium');
});

test('noEmit removal is not treated as explicit emit enablement', () => {
  const before = tsconfig({ strict: true, noEmit: true });
  const after = tsconfig({ strict: true });
  assert.equal(has(before, after, 'project-contract-typescript-noemit-weakened'), false);
});

test('checkJs true removal is medium severity', () => {
  const before = tsconfig({ checkJs: true });
  const after = tsconfig({});
  const finding = audit(before, after).findings.find(item => item.id === 'project-contract-typescript-checkjs-weakened');
  assert.equal(finding?.severity, 'medium');
});

test('checkJs false to true is strengthening', () => {
  const before = tsconfig({ checkJs: false });
  const after = tsconfig({ checkJs: true });
  assert.equal(audit(before, after).findings.length, 0);
});

test('.NET target framework removal is high severity', () => {
  const before = props('<TargetFramework>net10.0</TargetFramework>');
  const after = props('');
  assert.equal(has(before, after, 'project-contract-dotnet-target-removed'), true);
});

test('.NET target framework major downgrade is high severity', () => {
  const before = props('<TargetFramework>net10.0</TargetFramework>');
  const after = props('<TargetFramework>net8.0</TargetFramework>');
  assert.equal(has(before, after, 'project-contract-dotnet-target-downgraded'), true);
});

test('.NET target framework upgrade is not weakening', () => {
  const before = props('<TargetFramework>net8.0</TargetFramework>');
  const after = props('<TargetFramework>net10.0</TargetFramework>');
  assert.equal(audit(before, after).findings.length, 0);
});

test('.NET target patch/minor text change within major is not marked downgrade', () => {
  const before = props('<TargetFramework>net10.0</TargetFramework>');
  const after = props('<TargetFramework>net10.1</TargetFramework>');
  assert.equal(has(before, after, 'project-contract-dotnet-target-downgraded'), false);
});

test('.NET nullable enable to disable is high severity', () => {
  const before = props('<Nullable>enable</Nullable>');
  const after = props('<Nullable>disable</Nullable>');
  assert.equal(has(before, after, 'project-contract-dotnet-nullable-weakened'), true);
});

test('.NET nullable enable removal is high severity', () => {
  const before = props('<Nullable>enable</Nullable>');
  const after = props('');
  assert.equal(has(before, after, 'project-contract-dotnet-nullable-weakened'), true);
});

test('.NET nullable disable to enable is strengthening', () => {
  const before = props('<Nullable>disable</Nullable>');
  const after = props('<Nullable>enable</Nullable>');
  assert.equal(audit(before, after).findings.length, 0);
});

test('.NET warnings as errors true to false is medium severity', () => {
  const before = props('<TreatWarningsAsErrors>true</TreatWarningsAsErrors>');
  const after = props('<TreatWarningsAsErrors>false</TreatWarningsAsErrors>');
  const finding = audit(before, after).findings.find(item => item.id === 'project-contract-dotnet-warnings-weakened');
  assert.equal(finding?.severity, 'medium');
});

test('.NET analysis latest to lower policy is medium severity', () => {
  const before = props('<AnalysisLevel>latest</AnalysisLevel>');
  const after = props('<AnalysisLevel>8.0</AnalysisLevel>');
  const finding = audit(before, after).findings.find(item => item.id === 'project-contract-dotnet-analysis-level-weakened');
  assert.equal(finding?.severity, 'medium');
});

test('.NET analysis level lower to latest is strengthening', () => {
  const before = props('<AnalysisLevel>8.0</AnalysisLevel>');
  const after = props('<AnalysisLevel>latest</AnalysisLevel>');
  assert.equal(audit(before, after).findings.length, 0);
});

test('global.json SDK pin removal is high severity', () => {
  const before = globalJson({ version: '10.0.100', rollForward: 'latestPatch' });
  const after = globalJson({ rollForward: 'latestPatch' });
  assert.equal(has(before, after, 'project-contract-dotnet-sdk-pin-removed'), true);
});

test('global.json SDK major downgrade is high severity', () => {
  const before = globalJson({ version: '10.0.100' });
  const after = globalJson({ version: '8.0.400' });
  assert.equal(has(before, after, 'project-contract-dotnet-sdk-downgraded'), true);
});

test('global.json SDK patch upgrade is not downgrade', () => {
  const before = globalJson({ version: '10.0.100' });
  const after = globalJson({ version: '10.0.200' });
  assert.equal(audit(before, after).findings.length, 0);
});

test('global.json rollForward change is medium severity', () => {
  const before = globalJson({ version: '10.0.100', rollForward: 'latestPatch' });
  const after = globalJson({ version: '10.0.100', rollForward: 'major' });
  const finding = audit(before, after).findings.find(item => item.id === 'project-contract-dotnet-rollforward-changed');
  assert.equal(finding?.severity, 'medium');
});

test('adding global.json rollForward policy is not weakening', () => {
  const before = globalJson({ version: '10.0.100' });
  const after = globalJson({ version: '10.0.100', rollForward: 'latestPatch' });
  assert.equal(audit(before, after).findings.length, 0);
});

test('malformed changed package JSON is left to dedicated manifest integrity gate', () => {
  const before = pkg({ scripts: { build: 'vite build' } });
  const after = { path: before.path, text: '{' };
  assert.equal(collectProjectContractDeltas(inv([before]), inv([after])).length, 0);
});

test('malformed changed tsconfig JSON does not throw', () => {
  const before = tsconfig({ strict: true });
  const after = { path: before.path, text: '{' };
  const section = audit(before, after);
  assert.equal(section.findings.length, 0);
});

test('added project files are not treated as weakened old contracts', () => {
  const after = pkg({ scripts: { build: 'vite build' }, engines: { node: '>=24' } });
  const section = auditProjectContractDelta(inv([]), inv([after]));
  assert.equal(section.findings.length, 0);
});

test('removed project files are handled by change-risk deletion rules, not contract-delta parser', () => {
  const before = pkg({ scripts: { build: 'vite build' } });
  const section = auditProjectContractDelta(inv([before]), inv([]));
  assert.equal(section.findings.length, 0);
});

test('exact-content rename is not treated as contract weakening', () => {
  const before = { path: 'packages/a/tsconfig.json', text: JSON.stringify({ compilerOptions: { strict: true } }) };
  const after = { path: 'packages/b/tsconfig.json', text: before.text };
  const section = auditProjectContractDelta(inv([before]), inv([after]));
  assert.equal(section.findings.length, 0);
});

test('multiple strictness losses are emitted independently', () => {
  const before = tsconfig({
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    useUnknownInCatchVariables: true,
  });
  const after = tsconfig({
    strict: false,
    noUncheckedIndexedAccess: false,
    exactOptionalPropertyTypes: false,
    useUnknownInCatchVariables: false,
  });
  const section = audit(before, after);
  const strictness = section.findings.filter(item => item.id === 'project-contract-typescript-strictness-weakened');
  assert.equal(strictness.length, 4);
  assert.equal(section.summary.criticalDeltas, 1);
  assert.equal(section.summary.highDeltas, 3);
});

test('multiple critical scripts are emitted independently', () => {
  const before = pkg({ scripts: { build: 'vite build', test: 'vitest run', verify: 'npm test' } });
  const after = pkg({ scripts: {} });
  const section = audit(before, after);
  assert.equal(section.summary.criticalDeltas, 3);
});

test('summary counts package manifest changes even when contract strengthens', () => {
  const before = pkg({ scripts: {} });
  const after = pkg({ scripts: { build: 'vite build' } });
  const section = audit(before, after);
  assert.equal(section.summary.packageManifestChanges, 1);
  assert.equal(section.findings.length, 0);
});

test('summary counts tsconfig changes', () => {
  const before = tsconfig({ strict: false });
  const after = tsconfig({ strict: true });
  assert.equal(audit(before, after).summary.tsconfigChanges, 1);
});

test('summary counts dotnet project changes', () => {
  const before = props('<TargetFramework>net8.0</TargetFramework>');
  const after = props('<TargetFramework>net10.0</TargetFramework>');
  assert.equal(audit(before, after).summary.dotnetProjectChanges, 1);
});

test('summary counts global.json changes', () => {
  const before = globalJson({ version: '8.0.100' });
  const after = globalJson({ version: '10.0.100' });
  assert.equal(audit(before, after).summary.globalJsonChanges, 1);
});

test('deltas are deterministic by file contract and id', () => {
  const before = inv([
    pkg({ scripts: { build: 'vite build', test: 'vitest run' }, engines: { node: '>=24' } }),
    tsconfig({ strict: true, noUncheckedIndexedAccess: true }),
  ]);
  const after = inv([
    pkg({ scripts: {}, engines: {} }),
    tsconfig({ strict: false, noUncheckedIndexedAccess: false }),
  ]);
  const first = auditProjectContractDelta(before, after);
  const second = auditProjectContractDelta(before, after);
  assert.deepEqual(first.summary.deltas, second.summary.deltas);
  assert.deepEqual(first.findings, second.findings);
});

test('findingsByRule is stable lexical key order', () => {
  const before = pkg({ scripts: { build: 'vite build' }, engines: { node: '>=24' }, private: true });
  const after = pkg({ scripts: {}, engines: {}, private: false });
  const section = audit(before, after);
  const keys = Object.keys(section.summary.findingsByRule);
  assert.deepEqual(keys, [...keys].sort((left, right) => left.localeCompare(right, 'en')));
});

test('finding evidence exposes before and after values', () => {
  const before = tsconfig({ strict: true });
  const after = tsconfig({ strict: false });
  const finding = audit(before, after).findings[0];
  assert.equal(finding?.evidence?.value, 'true -> false');
});

test('markdown exposes contract delta counts and findings', () => {
  const before = pkg({ scripts: { build: 'vite build' } });
  const after = pkg({ scripts: {} });
  const markdown = projectContractDeltaMarkdown(audit(before, after));
  assert.match(markdown, /Project Contract Delta/u);
  assert.match(markdown, /Critical deltas: 1/u);
  assert.match(markdown, /project-contract-package-script-removed/u);
});

test('markdown clean path reports no weakened contracts', () => {
  const before = tsconfig({ strict: false });
  const after = tsconfig({ strict: true });
  const markdown = projectContractDeltaMarkdown(audit(before, after));
  assert.match(markdown, /No weakened project contracts/u);
});

test('elapsed time is non-negative', () => {
  const section = auditProjectContractDelta(inv([]), inv([]));
  assert.equal(section.elapsedMs >= 0, true);
});
