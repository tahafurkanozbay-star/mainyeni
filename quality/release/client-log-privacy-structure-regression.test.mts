import assert from 'node:assert/strict';
import test from 'node:test';
import { auditClientLogPrivacy } from './client-log-privacy-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const runtime = 'Webclient.app/src/Components/Query/PrivacyBoundary.tsx';
const adminRuntime = 'Webclient.admin/src/features/AddressLookup.ts';

function inspect(payload: string, file = runtime) {
  const report = auditClientLogPrivacy(fixtureInventory([{
    path: file,
    text: `safeClientLog(LoggingBusiness, "query", ${payload});`,
  }]));
  assert.equal(report.summary.runtimeFiles, 1, file);
  assert.equal(report.summary.clientLogCalls, 1, payload);
  return report;
}

test('wrapped raw search and location payloads are not mistaken for safe counters', () => {
  const expressions = [
    'String(query)',
    'String(record)',
    'String(location)',
    'Number(latitude)',
    'Number(queryText)',
    'encodeURIComponent(query)',
    'encodeURIComponent(path)',
    'String(mapPoint)',
    'String(lat)',
    'String(lon)',
  ];
  for (const value of expressions) {
    const result = inspect(value);
    assert.equal(result.summary.flaggedCalls, 1, value);
    assert.equal(result.findings[0]?.evidence?.metadata?.reason, 'wrapped-location-value', value);
  }
});

test('template expressions containing raw query and address data are detected', () => {
  const expressions = [
    '`lookup ${query}`',
    '`selected: ${record}`',
    '`path: ${path}`',
    '`coordinates: ${mapPoint}`',
    '`query text: ${queryText}`',
    '`street: ${item?.address}`',
    '`lat: ${location?.latitude}`',
    '`address: ${searchText}`',
  ];
  for (const value of expressions) {
    const result = inspect(value, adminRuntime);
    assert.equal(result.summary.flaggedCalls, 1, value);
    assert.ok(
      ['sensitive-property', 'sensitive-template', 'location-or-search-value'].includes(
        String(result.findings[0]?.evidence?.metadata?.reason),
      ),
      value,
    );
  }
});

test('objects, arrays, and spreads do not hide a raw record or search query', () => {
  const expressions = [
    '{ detail: record }',
    '{ current: query }',
    '{ meta: { selected: selection } }',
    '{ data: [payload] }',
    '[record]',
    '[query, 2]',
    '{ ...record }',
    '{ metadata: { ...params } }',
    '{ properties: location }',
    '{ item: mapPoint }',
    '{ serialized: searchText }',
  ];
  for (const value of expressions) {
    const result = inspect(value);
    assert.equal(result.summary.flaggedCalls, 1, value);
    const reason = result.findings[0]?.evidence?.metadata?.reason;
    assert.ok(
      reason === 'nested-sensitive-value' ||
        (value === '{ item: mapPoint }' && reason === 'sensitive-object-key'),
      `${value}: ${String(reason)}`,
    );
  }
});

test('safe scalar/count metadata remains permitted in both app and Admin', () => {
  const expressions = [
    'queryCount',
    'String(queryCount)',
    'pathCount',
    'String(resultCount)',
    '{ count: queryCount }',
    '{ detail: String(resultCount) }',
    '{ result: [3, 5] }',
    '{ ...safeCounters }',
    '`items ${queryCount}`',
    '`service ${serviceKey}`',
    'JSON.stringify({ count: resultCount })',
  ];
  for (const file of [runtime, adminRuntime]) {
    for (const value of expressions) {
      const result = inspect(value, file);
      assert.equal(result.summary.flaggedCalls, 0, `${file}: ${value}`);
    }
  }
});

test('sensitive audit retains no raw record or location material in evidence', () => {
  const raw = 'record.address';
  const report = inspect(`{ payload: ${raw} }`, adminRuntime);
  assert.equal(report.summary.flaggedCalls, 1);
  const serialized = JSON.stringify(report.findings);
  assert.ok(!serialized.includes(raw));
  assert.ok(!serialized.includes('record.address'));
  assert.equal(report.findings[0]?.severity, 'high');
  assert.equal(report.findings[0]?.domain, 'security');
});
