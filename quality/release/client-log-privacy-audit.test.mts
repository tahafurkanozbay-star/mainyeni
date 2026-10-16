import assert from 'node:assert/strict';
import test from 'node:test';
import { auditClientLogPrivacy } from './client-log-privacy-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const userPath = 'Webclient.app/src/Components/Query/NumberingQuery/NumberingQueryWindow.tsx';
const adminPath = 'Webclient.admin/src/runtime/AdminQuery.ts';

function source(text: string, path = userPath): FixtureFileInput {
  return { path, text, kind: 'typescript' };
}

function audit(...files: FixtureFileInput[]) {
  return auditClientLogPrivacy(fixtureInventory(files));
}

test('flags raw query, address-path and optional-chaining payloads', () => {
  const values = ['query', 'record', 'address', 'pathForLog(path)',
    'numberingPathLabelV11(path)', 'JSON.stringify(query)', 'path?.mahalle',
    'record.address', 'geometry.longitude', '`x=${latitude}`', 'latestQuery', 'String(latestQuery.districtName ?? "")',
    'item.Title', 'item?.Title', '`x=${item.Title}`',
    'mapEvent.mapPoint.latitude', 'mapPoint'];
  for (const value of values) {
    const result = audit(source(`safeClientLog(LoggingBusiness, "Query", ${value});`));
    assert.equal(result.summary.clientLogCalls, 1, value);
    assert.equal(result.summary.flaggedCalls, 1, value);
    assert.equal(result.findings[0]?.severity, 'high', value);
  }
});

test('scans both user and admin production files, excluding tests and fixtures', () => {
  const result = audit(
    source('safeClientLog(A, B, record.address);'),
    source('safeClientLog(A, B, JSON.stringify(query));', adminPath),
    source('safeClientLog(A, B, record.address);', 'Webclient.app/src/tests/sample.ts'),
    source('safeClientLog(A, B, record.address);', 'Webclient.admin/src/runtime/sample.test.ts'),
  );
  assert.equal(result.summary.runtimeFiles, 2);
  assert.equal(result.summary.clientLogCalls, 2);
  assert.equal(result.summary.flaggedCalls, 2);
});

test('bounds findings to eight per file but counts every logger call', () => {
  const text = Array.from({ length: 15 }, () =>
    'safeClientLog(LoggingBusiness, "Map", record.address);').join('\n');
  const result = audit(source(text));
  assert.equal(result.summary.clientLogCalls, 15);
  assert.equal(result.summary.flaggedCalls, 15);
  assert.equal(result.summary.retainedFindings, 8);
  assert.equal(result.findings[0]?.location?.line, 1);
  assert.equal(result.findings.at(-1)?.location?.line, 8);
});

test('does not flag static service identifiers or literal examples', () => {
  const text = [
    '// safeClientLog(A, B, record.address);',
    '/* safeClientLog(A, B, JSON.stringify(query)); */',
    'const example = "safeClientLog(A, B, record.address)";',
    'safeClientLog(LoggingBusiness, "Query", serviceKey);',
    'safeClientLog(LoggingBusiness, "Count", String(resultCount));',
  ].join('\n');
  const result = audit(source(text));
  assert.equal(result.summary.clientLogCalls, 2);
  assert.equal(result.summary.flaggedCalls, 0);
});

test('reports deterministic line evidence for multiline expressions', () => {
  const text = ['const ready = true;', 'safeClientLog(', '  LoggingBusiness,',
    '  "Query",', '  JSON.stringify(query),', ');'].join('\n');
  const first = audit(source(text));
  const second = audit(source(text));
  assert.deepEqual(first.findings, second.findings);
  assert.equal(first.findings[0]?.location?.line, 2);
});


test('rejects nested and shorthand private payload objects but accepts bounded counters', () => {
  const cases = [
    '{ query }',
    '{query}',
    '({ payload, resultCount })',
    '{ metadata: { record } }',
    '{ query: latestQuery }',
    "{ 'address': streetLabel }",
    '{ result: { coordinates } }',
    '[{ geometry }]',
    '{ ...query }',
  ];
  for (const value of cases) {
    const result = audit(source(`safeClientLog(LoggingBusiness, "Query", ${value});`));
    assert.equal(result.summary.clientLogCalls, 1, value);
    assert.equal(result.summary.flaggedCalls, 1, value);
    assert.equal(result.findings[0]?.severity, 'high', value);
    assert.ok(!JSON.stringify(result.findings).includes('streetLabel'), value);
  }

  for (const value of [
    '{ resultCount }',
    '{ queryCount: 4 }',
    '{ event: "query-submitted", count: resultCount }',
    '[resultCount]',
  ]) {
    const result = audit(source(`safeClientLog(LoggingBusiness, "Count", ${value});`));
    assert.equal(result.summary.flaggedCalls, 0, value);
  }
});

test('private shorthand after destructuring and renamed bindings remains unsafe', () => {
  const text = [
    'function report(record: Record<string, unknown>) {',
    '  const { address: streetLabel } = record;',
    '  safeClientLog(LoggingBusiness, "Query", { streetLabel });',
    '}',
  ].join('\\n');
  const result = audit(source(text));
  assert.equal(result.summary.flaggedCalls, 1);
  assert.equal(result.findings[0]?.location?.line, 3);
});
