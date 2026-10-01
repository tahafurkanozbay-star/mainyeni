import assert from 'node:assert/strict';
import test from 'node:test';
import { auditRepositoryToolchainModernization } from './repository-toolchain-modernization-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(files: readonly FixtureFileInput[]) {
  return auditRepositoryToolchainModernization(fixtureInventory(files));
}

function ids(files: readonly FixtureFileInput[]): string[] {
  return audit(files).findings.map(item => item.id);
}

function packageRoot(
  packageJson: Record<string, unknown>,
  extras: readonly FixtureFileInput[] = [],
): readonly FixtureFileInput[] {
  return [
    { path: 'web/package.json', text: JSON.stringify(packageJson, null, 2) },
    ...extras,
  ];
}

test('accepts exact npm authority with matching lockfile and modern Node engine', () => {
  const result = audit(packageRoot({
    name: 'web',
    type: 'module',
    packageManager: 'npm@11.6.0',
    engines: { node: '>=24 <25' },
  }, [
    { path: 'web/package-lock.json', text: '{"lockfileVersion":3}' },
    { path: 'web/src/index.ts', text: 'export const value = 1;' },
  ]));
  assert.equal(result.findings.some(item => item.id.startsWith('toolchain-package-manager')), false);
  assert.equal(result.findings.some(item => item.id === 'toolchain-lockfile-missing'), false);
  assert.equal(result.findings.some(item => item.id === 'toolchain-esm-package-boundary-missing'), false);
});

test('reports missing package manager authority', () => {
  assert.ok(ids(packageRoot({ name: 'web', type: 'module', engines: { node: '>=24' } }, [
    { path: 'web/package-lock.json', text: '{}' },
  ])).includes('toolchain-package-manager-unpinned'));
});

test('reports non-exact package manager version', () => {
  assert.ok(ids(packageRoot({
    name: 'web',
    type: 'module',
    packageManager: 'npm@^11.0.0',
    engines: { node: '>=24' },
  }, [{ path: 'web/package-lock.json', text: '{}' }])).includes('toolchain-package-manager-version-not-exact'));
});

test('reports missing Node engine contract', () => {
  assert.ok(ids(packageRoot({
    name: 'web',
    type: 'module',
    packageManager: 'npm@11.6.0',
  }, [{ path: 'web/package-lock.json', text: '{}' }])).includes('toolchain-node-engine-missing'));
});

test('reports legacy Node engine range', () => {
  assert.ok(ids(packageRoot({
    name: 'web',
    type: 'module',
    packageManager: 'npm@11.6.0',
    engines: { node: '>=18' },
  }, [{ path: 'web/package-lock.json', text: '{}' }])).includes('toolchain-node-engine-legacy'));
});

test('reports package root without a lockfile', () => {
  assert.ok(ids(packageRoot({
    name: 'web',
    type: 'module',
    packageManager: 'npm@11.6.0',
    engines: { node: '>=24' },
  })).includes('toolchain-lockfile-missing'));
});

test('reports multiple lockfile authorities in one package root', () => {
  const result = ids(packageRoot({
    name: 'web',
    type: 'module',
    packageManager: 'npm@11.6.0',
    engines: { node: '>=24' },
  }, [
    { path: 'web/package-lock.json', text: '{}' },
    { path: 'web/pnpm-lock.yaml', text: 'lockfileVersion: 9' },
  ]));
  assert.ok(result.includes('toolchain-lockfile-multiple'));
});

test('requires package-lock for npm authority', () => {
  const result = ids(packageRoot({
    name: 'web',
    type: 'module',
    packageManager: 'npm@11.6.0',
    engines: { node: '>=24' },
  }, [{ path: 'web/pnpm-lock.yaml', text: 'lockfileVersion: 9' }]));
  assert.ok(result.includes('toolchain-npm-lock-mismatch'));
});

test('requires pnpm lockfile for pnpm authority', () => {
  const result = ids(packageRoot({
    name: 'web',
    type: 'module',
    packageManager: 'pnpm@10.17.0',
    engines: { node: '>=24' },
  }, [{ path: 'web/package-lock.json', text: '{}' }]));
  assert.ok(result.includes('toolchain-pnpm-lock-mismatch'));
});

test('requires yarn lockfile for Yarn authority', () => {
  const result = ids(packageRoot({
    name: 'web',
    type: 'module',
    packageManager: 'yarn@4.9.2',
    engines: { node: '>=24' },
  }, [{ path: 'web/package-lock.json', text: '{}' }]));
  assert.ok(result.includes('toolchain-yarn-lock-mismatch'));
});

test('requires Bun lockfile for Bun authority', () => {
  const result = ids(packageRoot({
    name: 'web',
    type: 'module',
    packageManager: 'bun@1.2.22',
    engines: { node: '>=24' },
  }, [{ path: 'web/package-lock.json', text: '{}' }]));
  assert.ok(result.includes('toolchain-bun-lock-mismatch'));
});

test('reports source package without explicit ESM boundary', () => {
  const result = ids(packageRoot({
    name: 'web',
    packageManager: 'npm@11.6.0',
    engines: { node: '>=24' },
  }, [
    { path: 'web/package-lock.json', text: '{}' },
    { path: 'web/src/index.ts', text: 'export const x = 1;' },
  ]));
  assert.ok(result.includes('toolchain-esm-package-boundary-missing'));
});

test('invalid package JSON blocks toolchain proof', () => {
  const result = ids([{ path: 'web/package.json', text: '{invalid' }]);
  assert.ok(result.includes('toolchain-package-json-invalid'));
});

test('accepts strict TypeScript configuration with modern module semantics', () => {
  const result = audit([{
    path: 'web/tsconfig.json',
    text: JSON.stringify({
      compilerOptions: {
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        allowJs: false,
        module: 'ESNext',
        moduleResolution: 'Bundler',
        target: 'ES2024',
      },
    }),
  }]);
  assert.equal(result.findings.length, 0);
});

test('reports strict mode disabled', () => {
  assert.ok(ids([{
    path: 'web/tsconfig.json',
    text: JSON.stringify({ compilerOptions: { strict: false } }),
  }]).includes('toolchain-typescript-strict-disabled'));
});

test('reports missing noUncheckedIndexedAccess', () => {
  assert.ok(ids([{
    path: 'web/tsconfig.json',
    text: JSON.stringify({ compilerOptions: { strict: true, exactOptionalPropertyTypes: true } }),
  }]).includes('toolchain-typescript-indexed-access-loose'));
});

test('reports missing exact optional property types', () => {
  assert.ok(ids([{
    path: 'web/tsconfig.json',
    text: JSON.stringify({ compilerOptions: { strict: true, noUncheckedIndexedAccess: true } }),
  }]).includes('toolchain-typescript-optional-properties-loose'));
});

test('reports unchecked JavaScript bridge in a typed root', () => {
  const result = ids([{
    path: 'web/tsconfig.json',
    text: JSON.stringify({
      compilerOptions: {
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        allowJs: true,
        checkJs: false,
      },
    }),
  }]);
  assert.ok(result.includes('toolchain-typescript-unchecked-js-bridge'));
});

test('permits staged allowJs when checkJs remains enabled', () => {
  const result = ids([{
    path: 'web/tsconfig.json',
    text: JSON.stringify({
      compilerOptions: {
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        allowJs: true,
        checkJs: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
      },
    }),
  }]);
  assert.equal(result.includes('toolchain-typescript-unchecked-js-bridge'), false);
});

test('reports legacy TypeScript module target', () => {
  const result = ids([{
    path: 'web/tsconfig.json',
    text: JSON.stringify({
      compilerOptions: {
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        module: 'CommonJS',
        moduleResolution: 'Node',
      },
    }),
  }]);
  assert.ok(result.includes('toolchain-typescript-module-legacy'));
  assert.ok(result.includes('toolchain-typescript-resolution-legacy'));
});

test('invalid tsconfig is blocking', () => {
  assert.ok(ids([{ path: 'tsconfig.json', text: '{nope' }]).includes('toolchain-tsconfig-invalid'));
});

test('reports legacy .NET target framework', () => {
  assert.ok(ids([{
    path: 'Api/Api.csproj',
    text: '<Project><PropertyGroup><TargetFramework>net6.0</TargetFramework></PropertyGroup></Project>',
  }]).includes('toolchain-dotnet-target-legacy'));
});

test('reports prerelease .NET target framework', () => {
  assert.ok(ids([{
    path: 'Api/Api.csproj',
    text: '<Project><PropertyGroup><TargetFramework>net11.0-preview</TargetFramework></PropertyGroup></Project>',
  }]).includes('toolchain-dotnet-target-prerelease'));
});

test('accepts modern stable .NET target framework', () => {
  const result = ids([{
    path: 'Api/Api.csproj',
    text: '<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
  }]);
  assert.equal(result.includes('toolchain-dotnet-target-legacy'), false);
  assert.equal(result.includes('toolchain-dotnet-target-prerelease'), false);
});

test('requires nullable analysis in central build props', () => {
  assert.ok(ids([{
    path: 'Directory.Build.props',
    text: '<Project><PropertyGroup><Nullable>disable</Nullable></PropertyGroup></Project>',
  }]).includes('toolchain-dotnet-nullable-disabled'));
});

test('suggests implicit usings when central policy omits it', () => {
  assert.ok(ids([{
    path: 'Directory.Build.props',
    text: '<Project><PropertyGroup><Nullable>enable</Nullable></PropertyGroup></Project>',
  }]).includes('toolchain-dotnet-implicit-usings-disabled'));
});

test('requires central package-management authority', () => {
  assert.ok(ids([{
    path: 'Directory.Packages.props',
    text: '<Project><PropertyGroup><ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally></PropertyGroup></Project>',
  }]).includes('toolchain-dotnet-central-packages-disabled'));
});

test('accepts central package management when enabled', () => {
  const result = ids([{
    path: 'Directory.Packages.props',
    text: '<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup></Project>',
  }]);
  assert.equal(result.includes('toolchain-dotnet-central-packages-disabled'), false);
});

test('reports legacy setup-node runtime', () => {
  const result = ids([{
    path: '.github/workflows/quality.yml',
    text: 'jobs:\n  test:\n    steps:\n      - uses: actions/setup-node@0123456789abcdef0123456789abcdef01234567\n        with:\n          node-version: 20.19.0',
  }]);
  assert.ok(result.includes('toolchain-ci-node-legacy'));
});

test('reports floating setup-node runtime', () => {
  const result = ids([{
    path: '.github/workflows/quality.yml',
    text: 'jobs:\n  test:\n    steps:\n      - uses: actions/setup-node@0123456789abcdef0123456789abcdef01234567\n        with:\n          node-version: latest',
  }]);
  assert.ok(result.includes('toolchain-ci-node-floating'));
});

test('accepts stable setup-node runtime line', () => {
  const result = ids([{
    path: '.github/workflows/quality.yml',
    text: 'jobs:\n  test:\n    steps:\n      - uses: actions/setup-node@0123456789abcdef0123456789abcdef01234567\n        with:\n          node-version: 24.9.0',
  }]);
  assert.equal(result.includes('toolchain-ci-node-legacy'), false);
  assert.equal(result.includes('toolchain-ci-node-floating'), false);
});

test('reports floating setup-dotnet SDK', () => {
  const result = ids([{
    path: '.github/workflows/quality.yml',
    text: 'jobs:\n  test:\n    steps:\n      - uses: actions/setup-dotnet@0123456789abcdef0123456789abcdef01234567\n        with:\n          dotnet-version: 10.x',
  }]);
  assert.ok(result.includes('toolchain-ci-dotnet-floating'));
});

test('reports prerelease setup-dotnet SDK', () => {
  const result = ids([{
    path: '.github/workflows/quality.yml',
    text: 'jobs:\n  test:\n    steps:\n      - uses: actions/setup-dotnet@0123456789abcdef0123456789abcdef01234567\n        with:\n          dotnet-version: 11.0.100-preview.2',
  }]);
  assert.ok(result.includes('toolchain-ci-dotnet-floating'));
});

test('accepts stable exact setup-dotnet SDK', () => {
  const result = ids([{
    path: '.github/workflows/quality.yml',
    text: 'jobs:\n  test:\n    steps:\n      - uses: actions/setup-dotnet@0123456789abcdef0123456789abcdef01234567\n        with:\n          dotnet-version: 10.0.100',
  }]);
  assert.equal(result.includes('toolchain-ci-dotnet-floating'), false);
});

test('summarizes package, TypeScript and .NET signals deterministically', () => {
  const result = audit([
    { path: 'app/package.json', text: JSON.stringify({ name: 'app', type: 'module', packageManager: 'npm@11.6.0', engines: { node: '>=24' } }) },
    { path: 'app/package-lock.json', text: '{}' },
    { path: 'app/tsconfig.json', text: JSON.stringify({ compilerOptions: { strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true } }) },
    { path: 'Api/Api.csproj', text: '<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>' },
  ]);
  assert.equal(result.summary.packageManifests.length, 1);
  assert.equal(result.summary.tsconfigs.length, 1);
  assert.equal(result.summary.dotnetSignals.length, 1);
});

test('stable sort makes repeated audits deterministic', () => {
  const files: readonly FixtureFileInput[] = [
    { path: 'b/package.json', text: '{}' },
    { path: 'a/tsconfig.json', text: '{}' },
  ];
  const first = audit(files).findings.map(item => `${item.severity}:${item.id}:${item.location?.file ?? ''}`);
  const second = audit(files).findings.map(item => `${item.severity}:${item.id}:${item.location?.file ?? ''}`);
  assert.deepEqual(first, second);
});
