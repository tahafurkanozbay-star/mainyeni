import assert from 'node:assert/strict';
import test from 'node:test';
import { auditArchiveExtractionBoundaries } from './archive-extraction-boundary-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const sha = '0123456789abcdef0123456789abcdef01234567';

function audit(text: string) {
  return auditArchiveExtractionBoundaries(fixtureInventory([{ path: '.github/workflows/archive.yml', text }] as readonly FixtureFileInput[]));
}

function workflow(steps: string, permissions = 'contents: read', on = '[push]'): string {
  return `name: archive\non: ${on}\npermissions:\n  ${permissions}\njobs:\n  extract:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
}

test('accepts verified remote archive extracted into staging directory', () => {
  const result = audit(workflow(`      - run: |\n          curl -fsSL https://example.test/v1/tool.tar.gz -o tool.tar.gz\n          sha256sum -c tool.sha256\n          mkdir -p staging\n          tar -xzf tool.tar.gz -C staging\n`));
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.extractionSteps, 1);
});

test('flags remote archive extraction without verification', () => {
  const result = audit(workflow(`      - run: |\n          curl -fsSL https://example.test/v1/tool.tar.gz -o tool.tar.gz\n          mkdir -p staging\n          tar -xzf tool.tar.gz -C staging\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-archive-unverified-extraction'));
});

test('blocks unverified remote extraction in privileged job', () => {
  const result = audit(workflow(`      - run: |\n          curl -fsSL https://example.test/v1/tool.tar.gz -o tool.tar.gz\n          tar -xzf tool.tar.gz -C staging\n`, 'contents: write'));
  const finding = result.findings.find(item => item.id === 'ci-archive-unverified-extraction');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks extraction to filesystem root', () => {
  const result = audit(workflow(`      - run: tar -xf tool.tar -C /\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-archive-privileged-destination' && item.blocking));
});

test('blocks tar absolute names mode', () => {
  const result = audit(workflow(`      - run: tar -xPf tool.tar\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-archive-privileged-destination'));
});

test('blocks Windows system extraction target', () => {
  const result = audit(workflow(`      - shell: pwsh\n        run: Expand-Archive tool.zip -DestinationPath 'C:\\Program Files\\Tool' -Force\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-archive-privileged-destination'));
});

test('flags overwrite extraction of remote archive', () => {
  const result = audit(workflow(`      - run: |\n          curl -fsSL https://example.test/v1/tool.zip -o tool.zip\n          unzip -o tool.zip -d staging\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-archive-overwrite-trust-boundary'));
});

test('detects earlier actions download artifact before extraction', () => {
  const result = audit(workflow(`      - uses: actions/download-artifact@${sha}\n        with:\n          name: build\n      - run: tar -xf build.tar -C staging\n`));
  assert.equal(result.summary.artifactExtractionSteps, 1);
  assert.ok(result.findings.some(item => item.id === 'ci-archive-unverified-extraction'));
});

test('accepts artifact verified between download and extraction', () => {
  const result = audit(workflow(`      - uses: actions/download-artifact@${sha}\n        with:\n          name: build\n      - run: |\n          sha256sum -c build.sha256\n          tar -xf build.tar -C staging\n`));
  assert.equal(result.findings.some(item => item.id === 'ci-archive-unverified-extraction'), false);
});

test('does not treat artifact download after extraction as producer', () => {
  const result = audit(workflow(`      - run: tar -xf local.tar -C staging\n      - uses: actions/download-artifact@${sha}\n        with:\n          name: build\n`));
  assert.equal(result.summary.artifactExtractionSteps, 0);
});

test('supports unzip extraction', () => {
  const result = audit(workflow(`      - run: unzip local.zip -d staging\n`));
  assert.equal(result.summary.extractionSteps, 1);
});

test('supports 7z extraction', () => {
  const result = audit(workflow(`      - run: 7z x local.7z -ostaging\n`));
  assert.equal(result.summary.extractionSteps, 1);
});

test('supports PowerShell Expand-Archive', () => {
  const result = audit(workflow(`      - shell: pwsh\n        run: Expand-Archive local.zip -DestinationPath staging\n`));
  assert.equal(result.summary.extractionSteps, 1);
});

test('external contribution makes unverified extraction blocking', () => {
  const result = audit(workflow(`      - run: |\n          wget https://example.test/archive.tar -O archive.tar\n          tar -xf archive.tar -C staging\n`, 'contents: read', '[pull_request]'));
  assert.ok(result.findings.some(item => item.id === 'ci-archive-unverified-extraction' && item.blocking));
});

test('reports deterministic extraction counts', () => {
  const result = audit(workflow(`      - run: |\n          curl -fsSL https://example.test/a.zip -o a.zip\n          unzip -o a.zip -d staging\n`));
  assert.equal(result.summary.extractionSteps, 1);
  assert.equal(result.summary.remoteExtractionSteps, 1);
  assert.equal(result.summary.unverifiedExtractionSteps, 1);
});

test('ignores non-workflow extraction script', () => {
  const result = auditArchiveExtractionBoundaries(fixtureInventory([{ path: 'scripts/archive.yml', text: 'run: tar -xf bad.tar -C /' }] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
});
