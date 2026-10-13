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

test('sensitive object keys and shorthand cannot hide under aliases', () => {
  for (const payload of [
    '{ address: value }',
    '{ latitude, longitude }',
    '{ query: input }',
    '{ meta: { mahalle: district } }',
    '{ "adres": data }',
  ]) assert.equal(findings(payload), 1, payload);
});

test('renamed records, computed properties and wrapped coordinates are sensitive', () => {
  for (const payload of [
    'row.address',
    'result?.coordinates',
    "selectedRow['address']",
    'row?.["mahalle"]',
    'String(latitude)',
    'String(searchText)',
  ]) assert.equal(findings(payload), 1, payload);
});

test('bounded counts and event identifiers remain safe', () => {
  for (const payload of ['{ addressCount: 2, queryCount: 1 }', '{ count: 3 }', 'String(resultCount)', 'serviceKey']) {
    assert.equal(findings(payload), 0, payload);
  }
});
