import assert from 'node:assert/strict';
import test from 'node:test';
import { auditToolchainModernization } from './toolchain-modernization-audit.mts';
import type { FileKind, RepositoryInventory, SourceFile } from './contracts.mts';

interface Fixture {
  readonly path: string;
  readonly text: string;
  readonly kind?: FileKind;
}

function extension(path: string): string {
  const index = path.lastIndexOf('.');
  return index >= 0 ? path.slice(index).toLowerCase() : '';
}

function inferKind(path: string): FileKind {
  if (/\.json$/i.test(path)) return 'json';
  if (/\.csproj$/i.test(path)) return 'xml';
  if (/\.ya?ml$/i.test(path)) return 'yaml';
  return 'other';
}

function source(input: Fixture): SourceFile {
  return {
    absolutePath: `/repo/${input.path}`,
    repositoryPath: input.path,
    extension: extension(input.path),
    kind: input.kind ?? inferKind(input.path),
    bytes: Buffer.byteLength(input.text),
    lines: input.text.split('\n').length,
    text: input.text,
  };
}

function inventory(fixtures: readonly Fixture[]): RepositoryInventory {
  const files = fixtures.map(source);
  return {
    root: '/repo',
    files,
    ignoredDirectories: [],
    languageStats: [],
    totalFiles: files.length,
    totalLines: files.reduce((sum, file) => sum + file.lines, 0),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    generatedAt: '2026-10-02T00:00:00.000Z',
  };
}

function webPackage(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'webclient',
    private: true,
    type: 'module',
    engines: { node: '>=24.0.0', npm: '>=11.0.0' },
    dependencies: { react: '^19.3.0' },
    devDependencies: { typescript: '^7.0.2', vite: '^8.3.0' },
    ...overrides,
  }, null, 2);
}

function tsconfig(options: Record<string, unknown>): string {
  return JSON.stringify({ compilerOptions: options }, null, 2);
}

function ids(report: ReturnType<typeof auditToolchainModernization>): string[] {
  return report.findings.map(finding => finding.id);
}

test('accepts the modern primary web toolchain contract', () => {
  const report = auditToolchainModernization(inventory([
    { path: 'Webclient.app/package.json', text: webPackage({ packageManager: 'npm@11.19.1' }) },
    { path: 'Webclient.app/tsconfig.json', text: tsconfig({ strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, useUnknownInCatchVariables: true, verbatimModuleSyntax: true, moduleResolution: 'Bundler' }) },
    { path: 'Api.User/Api.User.csproj', text: '<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>' },
    { path: '.github/workflows/release.yml', text: 'steps:\n  - uses: actions/setup-node@0123456789012345678901234567890123456789\n    with:\n      node-version: 24' },
  ]));
  assert.equal(report.summary.node24CompatibleManifests, 1);
  assert.equal(report.summary.strictTsconfigs, 1);
  assert.equal(report.findings.filter(item => item.severity === 'high').length, 0);
  assert.equal(report.findings.filter(item => item.severity === 'medium').length, 0);
});

test('blocks a browser package that falls back to CommonJS', () => {
  const report = auditToolchainModernization(inventory([
    { path: 'Webclient.app/package.json', text: webPackage({ type: 'commonjs' }) },
  ]));
  const finding = report.findings.find(item => item.id === 'toolchain-webclient-esm-disabled');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.blocking, true);
});

test('blocks a Node engine below the production LTS floor', () => {
  const report = auditToolchainModernization(inventory([
    { path: 'Webclient.app/package.json', text: webPackage({ engines: { node: '>=20.0.0', npm: '>=10' } }) },
  ]));
  assert.ok(ids(report).includes('toolchain-node-lts-floor'));
  assert.equal(report.findings.find(item => item.id === 'toolchain-node-lts-floor')?.blocking, true);
});

test('reports missing package manager pin without blocking release', () => {
  const report = auditToolchainModernization(inventory([
    { path: 'Webclient.app/package.json', text: webPackage() },
  ]));
  const finding = report.findings.find(item => item.id === 'toolchain-package-manager-unpinned');
  assert.equal(finding?.severity, 'low');
  assert.equal(finding?.blocking, undefined);
});

test('reports stable TypeScript and Vite modernization floors', () => {
  const report = auditToolchainModernization(inventory([
    {
      path: 'Webclient.app/package.json',
      text: webPackage({
        packageManager: 'npm@11.19.1',
        devDependencies: { typescript: '^6.2.0', vite: '^7.5.0' },
      }),
    },
  ]));
  assert.ok(ids(report).includes('toolchain-typescript-modernization-floor'));
  assert.ok(ids(report).includes('toolchain-vite-modernization-floor'));
});

test('reports React versions below the modern root baseline', () => {
  const report = auditToolchainModernization(inventory([
    {
      path: 'Webclient.app/package.json',
      text: webPackage({
        packageManager: 'npm@11.19.1',
        dependencies: { react: '^18.3.1' },
      }),
    },
  ]));
  assert.ok(ids(report).includes('toolchain-react-modernization-floor'));
});

test('rejects prerelease dependency drift from a production manifest', () => {
  const report = auditToolchainModernization(inventory([
    {
      path: 'Webclient.app/package.json',
      text: webPackage({
        packageManager: 'npm@11.19.1',
        devDependencies: { typescript: '7.1.0-beta.2', vite: '8.4.0-rc.1' },
      }),
    },
  ]));
  const prerelease = report.findings.filter(item => item.id === 'toolchain-prerelease-dependency');
  assert.equal(prerelease.length, 2);
  assert.ok(prerelease.every(item => item.severity === 'medium'));
});

test('reports explicit strict false as a typed contract regression', () => {
  const report = auditToolchainModernization(inventory([
    { path: 'Webclient.app/tsconfig.legacy.json', text: tsconfig({ strict: false }) },
  ]));
  assert.ok(ids(report).includes('toolchain-typescript-strict-disabled'));
});

test('keeps optional strictness ratchets informational while migration is staged', () => {
  const report = auditToolchainModernization(inventory([
    { path: 'Webclient.app/tsconfig.json', text: tsconfig({ strict: true }) },
  ]));
  const indexed = report.findings.find(item => item.id === 'toolchain-indexed-access-ratchet-missing');
  const exact = report.findings.find(item => item.id === 'toolchain-exact-optional-ratchet-missing');
  assert.equal(indexed?.severity, 'info');
  assert.equal(exact?.severity, 'info');
});

test('reports unchecked JavaScript islands admitted by a TypeScript project', () => {
  const report = auditToolchainModernization(inventory([
    { path: 'Webclient.app/tsconfig.compat.json', text: tsconfig({ strict: true, allowJs: true, checkJs: false }) },
  ]));
  assert.ok(ids(report).includes('toolchain-unchecked-javascript-island'));
});

test('reports preview C# language adoption', () => {
  const report = auditToolchainModernization(inventory([
    { path: 'Api.Core/Api.Core.csproj', text: '<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework><LangVersion>preview</LangVersion></PropertyGroup></Project>' },
  ]));
  assert.ok(ids(report).includes('toolchain-dotnet-preview'));
});

test('reports older target frameworks as staged modernization debt', () => {
  const report = auditToolchainModernization(inventory([
    { path: 'Legacy/Legacy.csproj', text: '<Project><PropertyGroup><TargetFrameworks>net8.0;net10.0</TargetFrameworks></PropertyGroup></Project>' },
  ]));
  const finding = report.findings.find(item => item.id === 'toolchain-dotnet-modernization-floor');
  assert.equal(finding?.severity, 'low');
  assert.match(finding?.message ?? '', /net8\.0/);
});

test('captures multiple workflow runtime pins deterministically', () => {
  const report = auditToolchainModernization(inventory([
    {
      path: '.github/workflows/matrix.yml',
      text: `jobs:\n  test:\n    steps:\n      - uses: actions/setup-node@0123456789012345678901234567890123456789\n        with:\n          node-version: 22\n      - uses: actions/setup-node@0123456789012345678901234567890123456789\n        with:\n          node-version: 24\n      - uses: actions/setup-dotnet@0123456789012345678901234567890123456789\n        with:\n          dotnet-version: 10.0.x`,
    },
  ]));
  assert.deepEqual(report.summary.workflows[0]?.nodeVersions, ['22', '24']);
  assert.deepEqual(report.summary.workflows[0]?.dotnetVersions, ['10.0.x']);
  assert.ok(ids(report).includes('toolchain-workflow-node-floor'));
});

test('marks a Current-only Node lane as review information rather than a production upgrade', () => {
  const report = auditToolchainModernization(inventory([
    { path: '.github/workflows/current.yml', text: 'node-version: 26' },
  ]));
  const finding = report.findings.find(item => item.id === 'toolchain-workflow-node-current-review');
  assert.equal(finding?.severity, 'info');
});

test('ignores package manifests inside generated directories', () => {
  const report = auditToolchainModernization(inventory([
    { path: 'Webclient.app/node_modules/pkg/package.json', text: JSON.stringify({ type: 'commonjs', engines: { node: '12' } }) },
    { path: 'Webclient.app/dist/package.json', text: JSON.stringify({ type: 'commonjs', engines: { node: '12' } }) },
  ]));
  assert.equal(report.summary.packageManifests.length, 0);
});

test('ignores malformed JSON rather than crashing the release engine', () => {
  const report = auditToolchainModernization(inventory([
    { path: 'Webclient.app/package.json', text: '{ not-json' },
    { path: 'Webclient.app/tsconfig.json', text: '{ also-bad' },
  ]));
  assert.equal(report.summary.packageManifests.length, 0);
  assert.equal(report.summary.tsconfigs.length, 0);
});

test('sorts package, tsconfig, project, workflow and finding output deterministically', () => {
  const fixtures: readonly Fixture[] = [
    { path: 'z/package.json', text: JSON.stringify({}) },
    { path: 'a/package.json', text: JSON.stringify({}) },
    { path: 'z/tsconfig.json', text: tsconfig({ strict: false }) },
    { path: 'a/tsconfig.json', text: tsconfig({ strict: false }) },
    { path: 'z/Z.csproj', text: '<Project><TargetFramework>net8.0</TargetFramework></Project>' },
    { path: 'a/A.csproj', text: '<Project><TargetFramework>net8.0</TargetFramework></Project>' },
    { path: '.github/workflows/z.yml', text: 'node-version: 22' },
    { path: '.github/workflows/a.yml', text: 'node-version: 22' },
  ];
  const first = auditToolchainModernization(inventory(fixtures));
  const second = auditToolchainModernization(inventory([...fixtures].reverse()));
  assert.deepEqual(first.summary.packageManifests.map(item => item.file), ['a/package.json', 'z/package.json']);
  assert.deepEqual(first.summary.tsconfigs.map(item => item.file), ['a/tsconfig.json', 'z/tsconfig.json']);
  assert.deepEqual(first.summary.dotnetProjects.map(item => item.file), ['a/A.csproj', 'z/Z.csproj']);
  assert.deepEqual(first.summary.workflows.map(item => item.file), ['.github/workflows/a.yml', '.github/workflows/z.yml']);
  assert.deepEqual(
    first.findings.map(item => ({ id: item.id, location: item.location, severity: item.severity })),
    second.findings.map(item => ({ id: item.id, location: item.location, severity: item.severity })),
  );
});
