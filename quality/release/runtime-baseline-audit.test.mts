import assert from 'node:assert/strict';
import test from 'node:test';
import { auditRuntimeBaseline } from './runtime-baseline-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(files: readonly FixtureFileInput[]) {
  return auditRuntimeBaseline(fixtureInventory(files));
}

function ids(files: readonly FixtureFileInput[]): string[] {
  return audit(files).findings.map(item => item.id);
}

test('accepts stable Node 24 package engine', () => {
  const result = ids([{
    path: 'app/package.json',
    text: JSON.stringify({ engines: { node: '>=24 <25' }, packageManager: 'npm@11.6.0' }),
  }]);
  assert.equal(result.includes('runtime-node-below-modern-baseline'), false);
  assert.equal(result.includes('runtime-floating-version'), false);
});

test('reports Node 20 engine as below baseline', () => {
  assert.ok(ids([{
    path: 'app/package.json',
    text: JSON.stringify({ engines: { node: '>=20' } }),
  }]).includes('runtime-node-below-modern-baseline'));
});

test('reports Node latest as floating', () => {
  assert.ok(ids([{
    path: '.nvmrc',
    text: 'latest\n',
  }]).includes('runtime-floating-version'));
});

test('reports Node current as floating', () => {
  assert.ok(ids([{
    path: '.node-version',
    text: 'current\n',
  }]).includes('runtime-floating-version'));
});

test('reports wildcard Node version as floating', () => {
  assert.ok(ids([{
    path: '.nvmrc',
    text: '24.x\n',
  }]).includes('runtime-floating-version'));
});

test('reports canary Node version as prerelease', () => {
  assert.ok(ids([{
    path: '.node-version',
    text: '25.0.0-canary.2\n',
  }]).includes('runtime-prerelease-version'));
});

test('reads nodejs entry from .tool-versions', () => {
  const result = audit([{
    path: '.tool-versions',
    text: 'nodejs 24.9.0\ndotnet 10.0.100\n',
  }]);
  assert.ok(result.summary.nodeVersions.includes('24.9.0'));
});

test('package manager version is not treated as Node runtime major', () => {
  const result = ids([{
    path: 'app/package.json',
    text: JSON.stringify({ packageManager: 'npm@11.6.0', engines: { node: '>=24' } }),
  }]);
  assert.equal(result.includes('runtime-node-below-modern-baseline'), false);
});

test('reports prerelease package-manager selector as prerelease signal', () => {
  assert.ok(ids([{
    path: 'app/package.json',
    text: JSON.stringify({ packageManager: 'pnpm@11.0.0-rc.1', engines: { node: '>=24' } }),
  }]).includes('runtime-prerelease-version'));
});

test('accepts net10 target framework', () => {
  const result = ids([{
    path: 'Api/Api.csproj',
    text: '<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
  }]);
  assert.equal(result.includes('runtime-dotnet-framework-below-baseline'), false);
});

test('reports net6 target framework', () => {
  assert.ok(ids([{
    path: 'Api/Api.csproj',
    text: '<Project><PropertyGroup><TargetFramework>net6.0</TargetFramework></PropertyGroup></Project>',
  }]).includes('runtime-dotnet-framework-below-baseline'));
});

test('reads multi-target framework list', () => {
  const result = audit([{
    path: 'Library/Library.csproj',
    text: '<Project><PropertyGroup><TargetFrameworks>net8.0;net10.0</TargetFrameworks></PropertyGroup></Project>',
  }]);
  assert.deepEqual(result.summary.dotnetVersions.sort(), ['net10.0', 'net8.0']);
});

test('reports multiple dotnet major baselines for review', () => {
  assert.ok(ids([{
    path: 'Library/Library.csproj',
    text: '<Project><PropertyGroup><TargetFrameworks>net8.0;net10.0</TargetFrameworks></PropertyGroup></Project>',
  }]).includes('runtime-dotnet-major-drift'));
});

test('accepts stable global.json SDK', () => {
  const result = ids([{
    path: 'global.json',
    text: JSON.stringify({ sdk: { version: '10.0.100', rollForward: 'latestPatch' } }),
  }]);
  assert.equal(result.includes('runtime-prerelease-version'), false);
  assert.equal(result.includes('runtime-floating-version'), false);
});

test('reports preview global.json SDK', () => {
  assert.ok(ids([{
    path: 'global.json',
    text: JSON.stringify({ sdk: { version: '11.0.100-preview.3' } }),
  }]).includes('runtime-prerelease-version'));
});

test('reports old global.json SDK', () => {
  assert.ok(ids([{
    path: 'global.json',
    text: JSON.stringify({ sdk: { version: '7.0.410' } }),
  }]).includes('runtime-dotnet-sdk-below-baseline'));
});

test('reads stable setup-node workflow version', () => {
  const result = audit([{
    path: '.github/workflows/quality.yml',
    text: 'steps:\n  - uses: actions/setup-node@0123456789abcdef0123456789abcdef01234567\n    with:\n      node-version: 24.9.0',
  }]);
  assert.ok(result.summary.nodeVersions.includes('24.9.0'));
});

test('reports floating setup-node workflow version', () => {
  assert.ok(ids([{
    path: '.github/workflows/quality.yml',
    text: 'steps:\n  - uses: actions/setup-node@0123456789abcdef0123456789abcdef01234567\n    with:\n      node-version: latest',
  }]).includes('runtime-floating-version'));
});

test('reads setup-dotnet workflow version', () => {
  const result = audit([{
    path: '.github/workflows/backend.yml',
    text: 'steps:\n  - uses: actions/setup-dotnet@0123456789abcdef0123456789abcdef01234567\n    with:\n      dotnet-version: 10.0.100',
  }]);
  assert.ok(result.summary.dotnetVersions.includes('10.0.100'));
});

test('reports preview setup-dotnet version', () => {
  assert.ok(ids([{
    path: '.github/workflows/backend.yml',
    text: 'steps:\n  - uses: actions/setup-dotnet@0123456789abcdef0123456789abcdef01234567\n    with:\n      dotnet-version: 11.0.100-preview.1',
  }]).includes('runtime-prerelease-version'));
});

test('reports Node major drift between package and workflow', () => {
  const result = ids([
    { path: 'app/package.json', text: JSON.stringify({ engines: { node: '>=24 <25' } }) },
    { path: '.github/workflows/quality.yml', text: 'steps:\n  - uses: actions/setup-node@0123456789abcdef0123456789abcdef01234567\n    with:\n      node-version: 22.12.0' },
  ]);
  assert.ok(result.includes('runtime-node-major-drift'));
});

test('accepts consistent Node major declarations', () => {
  const result = ids([
    { path: 'app/package.json', text: JSON.stringify({ engines: { node: '>=24 <25' } }) },
    { path: '.github/workflows/quality.yml', text: 'steps:\n  - uses: actions/setup-node@0123456789abcdef0123456789abcdef01234567\n    with:\n      node-version: 24.9.0' },
    { path: '.nvmrc', text: '24.9.0' },
  ]);
  assert.equal(result.includes('runtime-node-major-drift'), false);
});

test('summarizes prerelease and floating selectors', () => {
  const result = audit([
    { path: '.nvmrc', text: 'latest' },
    { path: 'global.json', text: JSON.stringify({ sdk: { version: '11.0.100-preview.1' } }) },
  ]);
  assert.ok(result.summary.floatingVersions.includes('latest'));
  assert.ok(result.summary.prereleaseVersions.includes('11.0.100-preview.1'));
});

test('ignores unrelated configuration files', () => {
  const result = audit([{ path: 'config/runtime.txt', text: 'node 18' }]);
  assert.equal(result.summary.signals.length, 0);
  assert.equal(result.findings.length, 0);
});

test('invalid package json does not crash runtime scan', () => {
  const result = audit([{ path: 'app/package.json', text: '{invalid' }]);
  assert.equal(result.summary.signals.length, 1);
});

test('invalid global json does not crash runtime scan', () => {
  const result = audit([{ path: 'global.json', text: '{invalid' }]);
  assert.equal(result.summary.signals.length, 1);
});

test('stable sort makes repeated runtime scans deterministic', () => {
  const files: readonly FixtureFileInput[] = [
    { path: '.nvmrc', text: 'latest' },
    { path: 'Api/Api.csproj', text: '<Project><PropertyGroup><TargetFramework>net6.0</TargetFramework></PropertyGroup></Project>' },
  ];
  const first = audit(files).findings.map(item => `${item.severity}:${item.id}:${item.location?.file ?? ''}`);
  const second = audit(files).findings.map(item => `${item.severity}:${item.id}:${item.location?.file ?? ''}`);
  assert.deepEqual(first, second);
});
