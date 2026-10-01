import assert from 'node:assert/strict';
import test from 'node:test';
import { auditReproducibleBuildContract } from './reproducible-build-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(files: readonly FixtureFileInput[]) {
  return auditReproducibleBuildContract(fixtureInventory(files));
}

function ids(files: readonly FixtureFileInput[]): string[] {
  return audit(files).findings.map(item => item.id);
}

test('requires deterministic central .NET build', () => {
  assert.ok(ids([{
    path: 'Directory.Build.props',
    text: '<Project><PropertyGroup><Nullable>enable</Nullable></PropertyGroup></Project>',
  }]).includes('repro-dotnet-deterministic-missing'));
});

test('requires continuous integration build policy centrally', () => {
  assert.ok(ids([{
    path: 'Directory.Build.props',
    text: '<Project><PropertyGroup><Deterministic>true</Deterministic></PropertyGroup></Project>',
  }]).includes('repro-dotnet-ci-build-missing'));
});

test('reviews portable symbol policy when absent', () => {
  assert.ok(ids([{
    path: 'Directory.Build.props',
    text: '<Project><PropertyGroup><Deterministic>true</Deterministic><ContinuousIntegrationBuild>true</ContinuousIntegrationBuild></PropertyGroup></Project>',
  }]).includes('repro-dotnet-portable-symbols-missing'));
});

test('reviews path-map policy when absent', () => {
  assert.ok(ids([{
    path: 'Directory.Build.props',
    text: '<Project><PropertyGroup><Deterministic>true</Deterministic><ContinuousIntegrationBuild>true</ContinuousIntegrationBuild><DebugType>portable</DebugType></PropertyGroup></Project>',
  }]).includes('repro-dotnet-path-map-review'));
});

test('accepts hardened deterministic central build policy', () => {
  const result = ids([{
    path: 'Directory.Build.props',
    text: '<Project><PropertyGroup><Deterministic>true</Deterministic><ContinuousIntegrationBuild>true</ContinuousIntegrationBuild><DebugType>portable</DebugType><PathMap>$(MSBuildProjectDirectory)=/src</PathMap></PropertyGroup></Project>',
  }]);
  assert.equal(result.includes('repro-dotnet-deterministic-missing'), false);
  assert.equal(result.includes('repro-dotnet-ci-build-missing'), false);
  assert.equal(result.includes('repro-dotnet-portable-symbols-missing'), false);
  assert.equal(result.includes('repro-dotnet-path-map-review'), false);
});

test('blocks wall-clock build metadata in dotnet policy', () => {
  assert.ok(ids([{
    path: 'Directory.Build.props',
    text: '<Project><PropertyGroup><Version>System.DateTime.UtcNow</Version></PropertyGroup></Project>',
  }]).includes('repro-dotnet-build-time-input'));
});

test('blocks random build metadata in dotnet policy', () => {
  assert.ok(ids([{
    path: 'Directory.Build.props',
    text: '<Project><PropertyGroup><BuildId>New-Guid</BuildId></PropertyGroup></Project>',
  }]).includes('repro-dotnet-random-build-input'));
});

test('blocks local file dependency', () => {
  assert.ok(ids([{
    path: 'app/package.json',
    text: JSON.stringify({ dependencies: { internal: 'file:../internal' } }),
  }]).includes('repro-package-local-dependency'));
});

test('blocks link dependency', () => {
  assert.ok(ids([{
    path: 'app/package.json',
    text: JSON.stringify({ dependencies: { internal: 'link:../internal' } }),
  }]).includes('repro-package-local-dependency'));
});

test('blocks unpinned Git dependency', () => {
  assert.ok(ids([{
    path: 'app/package.json',
    text: JSON.stringify({ dependencies: { plugin: 'git+https://github.com/example/plugin.git#main' } }),
  }]).includes('repro-package-git-dependency-unpinned'));
});

test('accepts Git dependency pinned to immutable commit', () => {
  const result = ids([{
    path: 'app/package.json',
    text: JSON.stringify({ dependencies: { plugin: 'git+https://github.com/example/plugin.git#0123456789abcdef0123456789abcdef01234567' } }),
  }]);
  assert.equal(result.includes('repro-package-git-dependency-unpinned'), false);
});

test('reviews floating semver range while relying on lockfile', () => {
  assert.ok(ids([{
    path: 'app/package.json',
    text: JSON.stringify({ dependencies: { react: '^19.2.0' } }),
  }]).includes('repro-package-range-review'));
});

test('does not review exact package version as floating range', () => {
  const result = ids([{
    path: 'app/package.json',
    text: JSON.stringify({ dependencies: { react: '19.2.0' } }),
  }]);
  assert.equal(result.includes('repro-package-range-review'), false);
});

test('reviews unlocked dotnet restore in build workflow', () => {
  assert.ok(ids([{
    path: '.github/workflows/build.yml',
    text: 'jobs:\n  build:\n    steps:\n      - run: dotnet restore\n      - run: dotnet build -c Release',
  }]).includes('repro-workflow-dotnet-restore-unlocked'));
});

test('accepts locked dotnet restore', () => {
  const result = ids([{
    path: '.github/workflows/build.yml',
    text: 'jobs:\n  build:\n    steps:\n      - run: dotnet restore --locked-mode\n      - run: dotnet build -c Release',
  }]);
  assert.equal(result.includes('repro-workflow-dotnet-restore-unlocked'), false);
});

test('blocks unlocked npm install in build workflow', () => {
  assert.ok(ids([{
    path: '.github/workflows/build.yml',
    text: 'jobs:\n  build:\n    steps:\n      - run: npm install\n      - run: npm run build',
  }]).includes('repro-workflow-node-install-unlocked'));
});

test('accepts npm ci in build workflow', () => {
  const result = ids([{
    path: '.github/workflows/build.yml',
    text: 'jobs:\n  build:\n    steps:\n      - run: npm ci\n      - run: npm run build',
  }]);
  assert.equal(result.includes('repro-workflow-node-install-unlocked'), false);
});

test('accepts pnpm frozen install in build workflow', () => {
  const result = ids([{
    path: '.github/workflows/build.yml',
    text: 'jobs:\n  build:\n    steps:\n      - run: pnpm install --frozen-lockfile\n      - run: pnpm build',
  }]);
  assert.equal(result.includes('repro-workflow-node-install-unlocked'), false);
});

test('blocks wall-clock derived workflow output', () => {
  assert.ok(ids([{
    path: '.github/workflows/build.yml',
    text: 'jobs:\n  build:\n    steps:\n      - run: npm ci\n      - run: echo "BUILD=$(date +%s)" >> $GITHUB_ENV\n      - run: npm run build',
  }]).includes('repro-workflow-time-derived-output'));
});

test('blocks random workflow output identity', () => {
  assert.ok(ids([{
    path: '.github/workflows/build.yml',
    text: 'jobs:\n  build:\n    steps:\n      - run: npm ci\n      - run: echo "ID=$(uuidgen)" >> $GITHUB_ENV\n      - run: npm run build',
  }]).includes('repro-workflow-random-derived-output'));
});

test('blocks floating external git source', () => {
  assert.ok(ids([{
    path: '.github/workflows/build.yml',
    text: 'jobs:\n  build:\n    steps:\n      - run: git clone --depth 1 https://github.com/example/tool.git\n      - run: npm run build',
  }]).includes('repro-workflow-git-floating-source'));
});

test('accepts git checkout bound to immutable commit', () => {
  const result = ids([{
    path: '.github/workflows/build.yml',
    text: 'jobs:\n  build:\n    steps:\n      - run: git clone https://github.com/example/tool.git && cd tool && git checkout 0123456789abcdef0123456789abcdef01234567\n      - run: npm run build',
  }]);
  assert.equal(result.includes('repro-workflow-git-floating-source'), false);
});

test('blocks external download without checksum verification', () => {
  assert.ok(ids([{
    path: '.github/workflows/build.yml',
    text: 'jobs:\n  build:\n    steps:\n      - run: curl -fLo tool.tgz https://example.invalid/tool.tgz\n      - run: npm run build',
  }]).includes('repro-workflow-download-without-checksum'));
});

test('accepts external download followed by sha256 verification', () => {
  const result = ids([{
    path: '.github/workflows/build.yml',
    text: 'jobs:\n  build:\n    steps:\n      - run: curl -fLo tool.tgz https://example.invalid/tool.tgz && echo "abc  tool.tgz" | sha256sum -c -\n      - run: npm run build',
  }]);
  assert.equal(result.includes('repro-workflow-download-without-checksum'), false);
});

test('blocks container base image without digest', () => {
  assert.ok(ids([{
    path: 'Dockerfile',
    text: 'FROM node:24-alpine\nRUN node --version',
  }]).includes('repro-container-base-image-not-digest-pinned'));
});

test('blocks latest container tag', () => {
  const result = ids([{
    path: 'Dockerfile',
    text: 'FROM node:latest\nRUN node --version',
  }]);
  assert.ok(result.includes('repro-container-base-image-not-digest-pinned'));
  assert.ok(result.includes('repro-container-floating-tag'));
});

test('accepts digest-pinned container base image', () => {
  const result = ids([{
    path: 'Dockerfile',
    text: `FROM node:24-alpine@sha256:${'a'.repeat(64)}\nRUN node --version`,
  }]);
  assert.equal(result.includes('repro-container-base-image-not-digest-pinned'), false);
  assert.equal(result.includes('repro-container-floating-tag'), false);
});

test('accepts scratch container base', () => {
  const result = ids([{
    path: 'Dockerfile',
    text: 'FROM scratch\nCOPY app /app',
  }]);
  assert.equal(result.includes('repro-container-base-image-not-digest-pinned'), false);
});

test('summarizes deterministic and locked policy signals', () => {
  const result = audit([
    { path: 'Directory.Build.props', text: '<Project><PropertyGroup><Deterministic>true</Deterministic><ContinuousIntegrationBuild>true</ContinuousIntegrationBuild></PropertyGroup></Project>' },
    { path: '.github/workflows/build.yml', text: 'jobs:\n  build:\n    steps:\n      - run: npm ci\n      - run: npm run build' },
  ]);
  assert.ok(result.summary.deterministicPolicies >= 2);
  assert.ok(result.summary.lockedDependencyPolicies >= 1);
});

test('ignores workflows without build commands for workflow-specific risks', () => {
  const result = audit([{
    path: '.github/workflows/docs.yml',
    text: 'jobs:\n  docs:\n    steps:\n      - run: echo hello',
  }]);
  assert.equal(result.findings.some(item => item.id.startsWith('repro-workflow-')), false);
});

test('stable output is deterministic', () => {
  const files: readonly FixtureFileInput[] = [
    { path: 'Dockerfile', text: 'FROM node:latest' },
    { path: 'app/package.json', text: JSON.stringify({ dependencies: { react: '^19.2.0' } }) },
  ];
  const first = audit(files).findings.map(item => `${item.severity}:${item.id}:${item.location?.file ?? ''}`);
  const second = audit(files).findings.map(item => `${item.severity}:${item.id}:${item.location?.file ?? ''}`);
  assert.deepEqual(first, second);
});
