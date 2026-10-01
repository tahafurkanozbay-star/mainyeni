import assert from 'node:assert/strict';
import test from 'node:test';
import { auditCompilerPolicy } from './compiler-policy-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(files: readonly FixtureFileInput[]) {
  return auditCompilerPolicy(fixtureInventory(files));
}

function ids(files: readonly FixtureFileInput[]): string[] {
  return audit(files).findings.map(item => item.id);
}

function tsconfig(options: Record<string, unknown>): FixtureFileInput {
  return { path: 'app/tsconfig.json', text: JSON.stringify({ compilerOptions: options }) };
}

function workflow(command: string): FixtureFileInput {
  return {
    path: '.github/workflows/typed.yml',
    text: `name: typed quality\njobs:\n  test:\n    steps:\n      - run: ${command}\n`,
  };
}

test('accepts hardened TypeScript compiler policy', () => {
  const result = audit([tsconfig({
    strict: true,
    forceConsistentCasingInFileNames: true,
    noImplicitOverride: true,
    useUnknownInCatchVariables: true,
    noImplicitReturns: true,
    noFallthroughCasesInSwitch: true,
    noPropertyAccessFromIndexSignature: true,
    allowUnreachableCode: false,
    allowUnusedLabels: false,
    jsx: 'react-jsx',
  })]);
  assert.equal(result.findings.length, 0);
});

test('requires TypeScript strict mode', () => {
  assert.ok(ids([tsconfig({ strict: false })]).includes('compiler-ts-strict-required'));
});

test('requires forceConsistentCasingInFileNames', () => {
  assert.ok(ids([tsconfig({ strict: true })]).includes('compiler-ts-casing-policy-missing'));
});

test('recommends explicit override declarations', () => {
  assert.ok(ids([tsconfig({ strict: true, forceConsistentCasingInFileNames: true })]).includes('compiler-ts-implicit-override-loose'));
});

test('requires unknown catch variables', () => {
  assert.ok(ids([tsconfig({ strict: true, forceConsistentCasingInFileNames: true, noImplicitOverride: true })]).includes('compiler-ts-catch-any-loose'));
});

test('requires explicit return paths', () => {
  assert.ok(ids([tsconfig({ strict: true, forceConsistentCasingInFileNames: true, noImplicitOverride: true, useUnknownInCatchVariables: true })]).includes('compiler-ts-implicit-return-loose'));
});

test('checks switch fallthrough policy', () => {
  assert.ok(ids([tsconfig({ strict: true, forceConsistentCasingInFileNames: true, noImplicitOverride: true, useUnknownInCatchVariables: true, noImplicitReturns: true })]).includes('compiler-ts-switch-fallthrough-loose'));
});

test('checks index-signature property access policy', () => {
  assert.ok(ids([tsconfig({ strict: true, forceConsistentCasingInFileNames: true, noImplicitOverride: true, useUnknownInCatchVariables: true, noImplicitReturns: true, noFallthroughCasesInSwitch: true })]).includes('compiler-ts-index-signature-access-loose'));
});

test('reports explicit allowance of unreachable code', () => {
  assert.ok(ids([tsconfig({ strict: true, allowUnreachableCode: true })]).includes('compiler-ts-unreachable-code-allowed'));
});

test('reports explicit allowance of unused labels', () => {
  assert.ok(ids([tsconfig({ strict: true, allowUnusedLabels: true })]).includes('compiler-ts-unused-labels-allowed'));
});

test('reviews skipped default library checks', () => {
  assert.ok(ids([tsconfig({ strict: true, skipDefaultLibCheck: true })]).includes('compiler-ts-default-lib-check-skipped'));
});

test('reports legacy React JSX transform', () => {
  assert.ok(ids([tsconfig({ strict: true, jsx: 'react' })]).includes('compiler-ts-legacy-jsx-transform'));
});

test('accepts react-jsx transform', () => {
  const result = ids([tsconfig({
    strict: true,
    forceConsistentCasingInFileNames: true,
    noImplicitOverride: true,
    useUnknownInCatchVariables: true,
    noImplicitReturns: true,
    noFallthroughCasesInSwitch: true,
    noPropertyAccessFromIndexSignature: true,
    jsx: 'react-jsx',
  })]);
  assert.equal(result.includes('compiler-ts-legacy-jsx-transform'), false);
});

test('blocks nullable disable in C# project', () => {
  assert.ok(ids([{
    path: 'Api/Api.csproj',
    text: '<Project><PropertyGroup><Nullable>disable</Nullable></PropertyGroup></Project>',
  }]).includes('compiler-dotnet-nullable-disabled'));
});

test('blocks explicit warnings-as-errors disable', () => {
  assert.ok(ids([{
    path: 'Directory.Build.props',
    text: '<Project><PropertyGroup><TreatWarningsAsErrors>false</TreatWarningsAsErrors></PropertyGroup></Project>',
  }]).includes('compiler-dotnet-warnings-not-errors'));
});

test('blocks disabled .NET analyzers', () => {
  assert.ok(ids([{
    path: 'Directory.Build.props',
    text: '<Project><PropertyGroup><EnableNETAnalyzers>false</EnableNETAnalyzers></PropertyGroup></Project>',
  }]).includes('compiler-dotnet-analyzers-disabled'));
});

test('blocks obsolete analysis level', () => {
  assert.ok(ids([{
    path: 'Directory.Build.props',
    text: '<Project><PropertyGroup><AnalysisLevel>5.0</AnalysisLevel></PropertyGroup></Project>',
  }]).includes('compiler-dotnet-analyzers-disabled'));
});

test('blocks preview C# language version', () => {
  assert.ok(ids([{
    path: 'Directory.Build.props',
    text: '<Project><PropertyGroup><LangVersion>preview</LangVersion></PropertyGroup></Project>',
  }]).includes('compiler-dotnet-language-preview'));
});

test('reviews AllowUnsafeBlocks', () => {
  assert.ok(ids([{
    path: 'Api/Api.csproj',
    text: '<Project><PropertyGroup><AllowUnsafeBlocks>true</AllowUnsafeBlocks></PropertyGroup></Project>',
  }]).includes('compiler-dotnet-unsafe-enabled'));
});

test('blocks tsc --noCheck in CI', () => {
  assert.ok(ids([workflow('npx tsc -p tsconfig.json --noCheck')]).includes('compiler-ci-ts-no-check'));
});

test('blocks command-line allowJs widening', () => {
  assert.ok(ids([workflow('npx tsc -p tsconfig.json --noEmit --allowJs')]).includes('compiler-ci-ts-allow-js-override'));
});

test('reviews command-line skipLibCheck weakening', () => {
  assert.ok(ids([workflow('npx tsc -p tsconfig.json --noEmit --skipLibCheck')]).includes('compiler-ci-ts-skip-lib-check-override'));
});

test('requires noEmit for authoritative typecheck command', () => {
  assert.ok(ids([workflow('npx tsc -p tsconfig.json')]).includes('compiler-ci-ts-typecheck-may-emit'));
});

test('accepts noEmit semantic validation', () => {
  const result = ids([workflow('npx tsc -p tsconfig.json --noEmit')]);
  assert.equal(result.includes('compiler-ci-ts-typecheck-may-emit'), false);
});

test('reviews implicit tsconfig discovery in authoritative workflow', () => {
  assert.ok(ids([workflow('npx tsc --noEmit')]).includes('compiler-ci-ts-project-implicit'));
});

test('accepts explicit project config in authoritative workflow', () => {
  const result = ids([workflow('npx tsc -p quality/tsconfig.json --noEmit')]);
  assert.equal(result.includes('compiler-ci-ts-project-implicit'), false);
});

test('blocks TSC_COMPILE_ON_ERROR', () => {
  assert.ok(ids([workflow('TSC_COMPILE_ON_ERROR=true npm run build')]).includes('compiler-ci-ts-compile-on-error'));
});

test('blocks CI=false compiler escape hatch', () => {
  assert.ok(ids([workflow('CI=false npm run build')]).includes('compiler-ci-ts-compile-on-error'));
});

test('blocks command-line NoWarn in dotnet build', () => {
  assert.ok(ids([workflow('dotnet build -c Release /p:NoWarn=CS8600')]).includes('compiler-ci-dotnet-nowarn'));
});

test('blocks command-line warning gate disable', () => {
  assert.ok(ids([workflow('dotnet build -c Release /p:TreatWarningsAsErrors=false')]).includes('compiler-ci-dotnet-warning-gate-disabled'));
});

test('accepts warning-as-error dotnet build', () => {
  const result = ids([workflow('dotnet build -c Release -warnaserror')]);
  assert.equal(result.includes('compiler-ci-dotnet-warning-gate-disabled'), false);
  assert.equal(result.includes('compiler-ci-dotnet-nowarn'), false);
});

test('summarizes compiler policy surfaces', () => {
  const result = audit([
    tsconfig({ strict: true }),
    { path: 'Directory.Build.props', text: '<Project><PropertyGroup><TreatWarningsAsErrors>true</TreatWarningsAsErrors><EnableNETAnalyzers>true</EnableNETAnalyzers></PropertyGroup></Project>' },
    workflow('npx tsc -p tsconfig.json --noEmit'),
  ]);
  assert.equal(result.summary.tsconfigs, 1);
  assert.equal(result.summary.dotnetPolicies, 1);
  assert.equal(result.summary.compilerWorkflows, 1);
});

test('ignores unrelated YAML files outside workflows', () => {
  const result = audit([{ path: 'config/build.yml', text: 'run: npx tsc --noCheck' }]);
  assert.equal(result.summary.compilerWorkflows, 0);
});

test('stable sorting makes repeated scans deterministic', () => {
  const files = [
    tsconfig({ strict: false, allowUnreachableCode: true }),
    workflow('npx tsc --noCheck'),
  ];
  const first = audit(files).findings.map(item => `${item.severity}:${item.id}:${item.location?.file ?? ''}`);
  const second = audit(files).findings.map(item => `${item.severity}:${item.id}:${item.location?.file ?? ''}`);
  assert.deepEqual(first, second);
});
