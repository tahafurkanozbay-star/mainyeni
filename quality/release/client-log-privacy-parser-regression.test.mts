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


test('optional calls remain visible and sensitive payloads still block release', () => {
  const result = audit([{
    path: userPath,
    text: [
      'logger?.safeClientLog?.(A, "Map", record?.address);',
      'safeClientLog?.(A, "Count", queryCount);',
    ].join('\n'),
  }]);
  assert.equal(result.summary.clientLogCalls, 2);
  assert.equal(result.summary.flaggedCalls, 1);
  assert.equal(result.findings[0]?.evidence?.metadata?.reason, 'sensitive-property');
});

test('oversized logger payloads fail closed without retaining sensitive contents', () => {
  const sensitivePayload = 'record.address' + ' '.repeat(9_000);
  const result = audit([{
    path: adminPath,
    text: `safeClientLog(A, "Detail", ${sensitivePayload});`,
  }]);
  assert.equal(result.summary.clientLogCalls, 1);
  assert.equal(result.summary.flaggedCalls, 1);
  assert.equal(result.findings[0]?.evidence?.metadata?.reason, 'unreviewable-client-log-call');
  assert.ok(!JSON.stringify(result.findings).includes('record.address'));
});

test('malformed logging arguments cannot silently evade release privacy audit', () => {
  const result = audit([{
    path: userPath,
    text: 'safeClientLog(A, "Map", { location: record.address );',
  }]);
  assert.equal(result.summary.clientLogCalls, 1);
  assert.equal(result.summary.flaggedCalls, 1);
  assert.equal(result.findings[0]?.evidence?.metadata?.reason, 'unreviewable-client-log-call');
});


test('the ninth sensitive call changes exact-base evidence without exceeding eight findings', () => {
  const unsafe = 'safeClientLog(A, "Map", record.address);';
  const inspect = (count: number) => audit([{ path: userPath, text: Array(count).fill(unsafe).join('\n') }]);
  const eight = inspect(8);
  const nine = inspect(9);
  const ten = inspect(10);
  assert.equal(eight.summary.flaggedCalls, 8);
  assert.equal(nine.summary.flaggedCalls, 8);
  assert.equal(ten.summary.flaggedCalls, 8);
  assert.ok(!eight.findings.some(f => f.id.endsWith('overflow')));
  const overflow9 = nine.findings.find(f => f.id.endsWith('overflow'));
  const overflow10 = ten.findings.find(f => f.id.endsWith('overflow'));
  assert.equal(overflow9?.evidence?.value, 2);
  assert.equal(overflow10?.evidence?.value, 3);
  assert.notDeepEqual(overflow9?.evidence, overflow10?.evidence);
  assert.ok(!JSON.stringify(nine.findings).includes('record.address'));
});

test('safe calls between the eighth and ninth sensitive payload cannot mask overflow', () => {
  const unsafe = 'safeClientLog(A, "Map", record.address);';
  const safe = 'safeClientLog(A, "Count", queryCount);';
  const report = audit([{ path: adminPath, text: [
    ...Array(8).fill(unsafe),
    ...Array(25).fill(safe),
    unsafe,
  ].join('\n') }]);
  assert.equal(report.summary.clientLogCalls, 34);
  assert.equal(report.summary.flaggedCalls, 8);
  assert.equal(report.findings.filter(f => f.id.endsWith('overflow')).length, 1);
  assert.equal(report.findings.find(f => f.id.endsWith('overflow'))?.evidence?.value, 2);
});
