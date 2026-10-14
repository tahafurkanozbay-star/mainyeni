import assert from 'node:assert/strict';
import test from 'node:test';
import { auditClientLogPrivacy } from './client-log-privacy-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const userPath = 'Webclient.app/src/Components/Query/Managed.tsx';
const adminPath = 'Webclient.admin/src/runtime/Logger.js';

function audit(files: readonly FixtureFileInput[]) {
  return auditClientLogPrivacy(fixtureInventory(files));
}

test('balanced nested payload expressions preserve the third logging argument', () => {
  const text = [
    'safeClientLog(',
    '  LoggingBusiness,',
    '  "Query, Detail",',
    '  { meta: { address: record.address, count: 1 }, tags: ["a", "b"] },',
    '  DebugHelper.Log,',
    ');',
  ].join('\n');
  const result = audit([{ path: userPath, text }]);
  assert.equal(result.summary.clientLogCalls, 1);
  assert.equal(result.summary.flaggedCalls, 1);
  assert.equal(result.findings[0]?.evidence?.metadata?.reason, 'sensitive-object-key');
  assert.equal(result.findings[0]?.location?.line, 1);
});

test('direct address property retains its own privacy classification', () => {
  const result = audit([{ path: userPath, text: 'safeClientLog(A, "Query", row.address);' }]);
  assert.equal(result.summary.flaggedCalls, 1);
  assert.equal(result.findings[0]?.evidence?.metadata?.reason, 'sensitive-property');
});

test('escaped quotes, template literals and comments are not executable logging calls', () => {
  const text = [
    'const example = "escaped \\"safeClientLog(A, B, record.address)\\"";',
    'const template = `safeClientLog(A, B, record.address)`;',
    '/* safeClientLog(A, B, record.address); */',
    '// safeClientLog(A, B, record.address);',
    'safeClientLog(LoggingBusiness, "Query", serviceKey);',
  ].join('\n');
  const result = audit([{ path: userPath, text }]);
  assert.equal(result.summary.clientLogCalls, 1);
  assert.equal(result.summary.flaggedCalls, 0);
});

test('per-file finding bounds do not suppress later calls or another file', () => {
  const sensitive = 'safeClientLog(A, "Query", record.address);';
  const safe = 'safeClientLog(A, "Query", serviceKey);';
  const files: FixtureFileInput[] = [
    { path: userPath, text: [...Array(11).fill(sensitive), safe].join('\n') },
    { path: adminPath, kind: 'javascript', text: [...Array(9).fill(sensitive), safe].join('\n') },
  ];
  const result = audit(files);
  assert.equal(result.summary.runtimeFiles, 2);
  assert.equal(result.summary.clientLogCalls, 22);
  assert.equal(result.summary.flaggedCalls, 16);
  assert.equal(result.findings.filter(item => item.location?.file === userPath).length, 8);
  assert.equal(result.findings.filter(item => item.location?.file === adminPath).length, 8);
});

test('non-runtime file kinds and test fixtures cannot produce release findings', () => {
  const text = 'safeClientLog(A, "Query", record.address);';
  const result = audit([
    { path: 'Webclient.app/src/component.test.ts', text, kind: 'typescript' },
    { path: 'Webclient.admin/src/__tests__/Logger.ts', text, kind: 'typescript' },
    { path: 'Webclient.app/src/style.css', text, kind: 'css' },
    { path: 'tools/logger.ts', text, kind: 'typescript' },
    { path: adminPath, text, kind: 'javascript' },
  ]);
  assert.equal(result.summary.runtimeFiles, 1);
  assert.equal(result.summary.clientLogCalls, 1);
  assert.equal(result.summary.flaggedCalls, 1);
  assert.equal(result.findings[0]?.location?.file, adminPath);
});

test('bounded non-identifying metadata is not mistaken for raw query data', () => {
  const text = [
    'safeClientLog(A, "Count", queryCount);',
    'safeClientLog(A, "Count", String(resultCount));',
    'safeClientLog(A, "Count", pathCount);',
    'safeClientLog(A, "Count", JSON.stringify({ count: 3 }));',
  ].join('\n');
  const result = audit([{ path: userPath, text }]);
  assert.equal(result.summary.clientLogCalls, 4);
  assert.equal(result.summary.flaggedCalls, 0);
});
