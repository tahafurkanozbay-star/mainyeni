import assert from 'node:assert/strict';
import test from 'node:test';
import { decideReleaseGate } from './release-engine.mts';
import { releaseReportArtifact } from './release-artifact.mts';
import { fixtureInventory } from './test-helpers.mts';
import type { Finding, ReleaseReport } from './contracts.mts';

const privateValue = 'token=never-export-this-value';
const finding: Finding = {
  id: 'network-insecure-http',
  domain: 'network',
  severity: 'high',
  title: 'Network boundary',
  message: privateValue,
  location: { file: 'Webclient.admin/src/request.ts', line: 2 },
  evidence: { excerpt: privateValue, value: privateValue },
  remediation: privateValue,
};

function privateReport(): ReleaseReport {
  return {
    schemaVersion: 1,
    context: { repository: 'owner/repo', generatedAt: '2026-10-15T00:00:00Z' },
    inventory: fixtureInventory([{
      path: 'Webclient.admin/src/request.ts',
      text: 'export const token = "' + privateValue + '";',
    }]),
    sections: [{
      domain: 'network',
      title: 'Network audit',
      summary: { rawUrl: 'https://example.test/api?' + privateValue },
      findings: [finding],
      elapsedMs: 3,
    }],
    findings: [finding],
    decision: decideReleaseGate([finding]),
    fingerprint: 'deterministic-fingerprint',
  };
}

test('uploaded report never contains scanned source text, raw evidence or audit summaries', () => {
  const report = privateReport();
  const artifact = releaseReportArtifact(report);
  const json = JSON.stringify(artifact);
  assert.ok(JSON.stringify(report).includes(privateValue));
  assert.ok(!json.includes(privateValue));
  assert.ok(!json.includes('rawUrl'));
  assert.ok(!json.includes('absolutePath'));
  assert.ok(!json.includes('export const token'));
  assert.equal(artifact.findings[0]?.file, 'Webclient.admin/src/request.ts');
  assert.equal(artifact.inventory.totalFiles, 1);
  assert.equal(artifact.sections[0]?.findingCount, 1);
  assert.ok(!('id' in (artifact.findings[0] ?? {})));
  assert.equal(artifact.findings[0]?.severity, 'high');
  assert.match(artifact.findings[0]?.key ?? '', /sha256:[a-f0-9]{64}/);
});

test('allowlisted report preserves required release gate and summary metadata', () => {
  const original = privateReport();
  const artifact = releaseReportArtifact(original);
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.context.repository, 'owner/repo');
  assert.equal(artifact.fingerprint, original.fingerprint);
  assert.deepEqual(artifact.decision, original.decision);
  assert.deepEqual(artifact.sections.map(section => [section.domain, section.findingCount]), [['network', 1]]);
});
