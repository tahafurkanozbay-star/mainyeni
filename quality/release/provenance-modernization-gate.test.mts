import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { auditArtifactDownloadProvenance } from './artifact-download-provenance-audit.mts';
import { buildRepositoryInventory } from './inventory.mts';
import { auditWorkflowCacheProvenance } from './workflow-cache-provenance-audit.mts';

const ROOT = path.resolve(process.cwd());

function blockingIds(findings: readonly { id: string; blocking?: boolean }[]): string[] {
  return findings
    .filter((finding) => finding.blocking === true)
    .map((finding) => finding.id)
    .sort((left, right) => left.localeCompare(right, 'en'));
}

test('repository workflows satisfy artifact download provenance boundary', () => {
  const inventory = buildRepositoryInventory({ root: ROOT, includeTests: true });
  const section = auditArtifactDownloadProvenance(inventory);
  assert.deepEqual(
    blockingIds(section.findings),
    [],
    `blocking artifact-download provenance findings: ${blockingIds(section.findings).join(', ')}`,
  );
});

test('repository workflows satisfy cache producer and namespace provenance boundary', () => {
  const inventory = buildRepositoryInventory({ root: ROOT, includeTests: true });
  const section = auditWorkflowCacheProvenance(inventory);
  assert.deepEqual(
    blockingIds(section.findings),
    [],
    `blocking cache provenance findings: ${blockingIds(section.findings).join(', ')}`,
  );
});

test('provenance audits are deterministic on the exact repository inventory', () => {
  const inventory = buildRepositoryInventory({ root: ROOT, includeTests: true });
  const artifactFirst = auditArtifactDownloadProvenance(inventory).findings;
  const artifactSecond = auditArtifactDownloadProvenance(inventory).findings;
  const cacheFirst = auditWorkflowCacheProvenance(inventory).findings;
  const cacheSecond = auditWorkflowCacheProvenance(inventory).findings;

  assert.deepEqual(
    artifactFirst.map((finding) => ({ id: finding.id, severity: finding.severity, blocking: finding.blocking, location: finding.location })),
    artifactSecond.map((finding) => ({ id: finding.id, severity: finding.severity, blocking: finding.blocking, location: finding.location })),
  );
  assert.deepEqual(
    cacheFirst.map((finding) => ({ id: finding.id, severity: finding.severity, blocking: finding.blocking, location: finding.location })),
    cacheSecond.map((finding) => ({ id: finding.id, severity: finding.severity, blocking: finding.blocking, location: finding.location })),
  );
});
