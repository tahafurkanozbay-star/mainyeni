import assert from 'node:assert/strict';
import test from 'node:test';
import { auditClientLogPrivacy } from './client-log-privacy-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const runtimePath = 'Webclient.app/src/Components/Query/PrivacyAudit.ts';

function findings(payload: string): number {
  const audit = auditClientLogPrivacy(fixtureInventory([{
    path: runtimePath,
    text: `safeClientLog(A, "query", ${payload});`,
  }]));
  assert.equal(audit.summary.clientLogCalls, 1, payload);
  return audit.summary.flaggedCalls;
}

test('renamed records cannot bypass sensitive property detection', () => {
  for (const payload of [
    'row.address',
    'result?.coordinates',
    'selectedRow.latitude',
    'candidate?.mahalle',
    'feature.street',
    'marker?.longitude',
  ]) assert.equal(findings(payload), 1, payload);
});

test('bounded counters and non-identifying metadata remain permitted', () => {
  for (const payload of [
    '{ count: 3 }',
    'String(resultCount)',
    'serviceKey',
    'queryCount',
    'pathCount',
  ]) assert.equal(findings(payload), 0, payload);
});

test('explicit location keys in nested metadata cannot bypass the audit', () => {
  for (const payload of [
    '{ address: alias }',
    '{ latitude: y, longitude: x }',
    '{ meta: { mahalle: value } }',
  ]) assert.equal(findings(payload), 1, payload);
});

test('static literal field examples do not disclose record values', () => {
  for (const payload of [
    '"row.address"',
    "'result.coordinates'",
    '`record.address`',
  ]) assert.equal(findings(payload), 0, payload);
});
