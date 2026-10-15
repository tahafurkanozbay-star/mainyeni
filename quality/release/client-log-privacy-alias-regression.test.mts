import assert from 'node:assert/strict';
import test from 'node:test';
import { auditClientLogPrivacy } from './client-log-privacy-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const app = 'Webclient.app/src/Components/Query/PrivacyLogger.tsx';
const admin = 'Webclient.admin/src/Components/Query/PrivacyLogger.ts';

function review(text: string, path = app) {
  return auditClientLogPrivacy(fixtureInventory([{ path, text }]));
}
function unsafe(text: string, expected: string, path = app): void {
  const result = review(text, path);
  assert.equal(result.summary.clientLogCalls, 1);
  assert.equal(result.summary.flaggedCalls, 1);
  assert.equal(result.findings[0]?.evidence?.metadata?.reason, expected);
}
function safe(text: string): void {
  const result = review(text);
  assert.equal(result.summary.clientLogCalls, 1);
  assert.equal(result.summary.flaggedCalls, 0, JSON.stringify(result.findings));
}
test('constant alias retains private address source', () => {
  unsafe('const detail = record.address;\nsafeClientLog(A, "map", detail);', 'derived-sensitive-property');
});
test('optional property chain is still private', () => {
  unsafe('const detail = item?.address;\nsafeClientLog(A, "map", detail);', 'derived-sensitive-property');
});
test('three-hop alias chain retains private provenance', () => {
  unsafe('const value = item.address;\nconst one = value;\nconst two = one;\nsafeClientLog(A, "map", two);',
    'derived-derived-derived-sensitive-property');
});
test('a serialized search behind a variable remains blocked', () => {
  unsafe('const detail = JSON.stringify(query);\nsafeClientLog(A, "search", detail);',
    'derived-serialized-record-or-query');
});
test('nested object payloads retain sensitive properties', () => {
  unsafe('const metadata = { count: 1, detail: { address: record.address } };\nsafeClientLog(A, "map", metadata);',
    'derived-sensitive-object-key');
});
test('an alias used through String() is reviewed', () => {
  unsafe('const detail = record.address;\nsafeClientLog(A, "map", String(detail));',
    'derived-sensitive-property');
});
test('Admin runtime has the same protections', () => {
  unsafe('const detail = record.address;\nsafeClientLog(A, "map", detail);', 'derived-sensitive-property', admin);
});
test('constant service labels never become sensitive data', () => {
  safe('const serviceLabel = "address inspected";\nsafeClientLog(A, "event", serviceLabel);');
});
test('numeric count aliases are not flagged', () => {
  safe('const count = Number(resultCount);\nconst detail = count;\nsafeClientLog(A, "count", detail);');
});
test('a string containing a fake declaration is not executable', () => {
  safe('const comment = "const detail = record.address;";\nsafeClientLog(A, "count", detail);');
});
test('comments cannot introduce aliases', () => {
  safe('// const detail = record.address;\n/* const detail = query; */\nsafeClientLog(A, "count", detail);');
});
test('future declarations do not retroactively taint a call', () => {
  safe('safeClientLog(A, "count", detail);\nconst detail = record.address;');
});
test('function siblings do not share private locals', () => {
  safe('function other(){const detail = record.address;}\nfunction logger(){safeClientLog(A, "count", detail);}');
});
test('local shadowing of private parent name with bounded count is respected', () => {
  safe('const detail = record.address;\nfunction report(){const detail = resultCount; safeClientLog(A, "count", detail);}');
});
test('a nested function inherits a private outer local alias', () => {
  unsafe('function outer(){const detail = record.address;\nfunction log(){safeClientLog(A, "map", detail);}}',
    'derived-sensitive-property');
});
test('a sibling closure cannot taint the other closure', () => {
  safe('function outer(){function a(){const detail = record.address;}function b(){safeClientLog(A,"count",detail);}}');
});
test('two distinct scopes with the same identifier have distinct findings', () => {
  const result = review('function a(){const detail = record.address;safeClientLog(A,"map",detail);}\n' +
    'function b(){const detail = resultCount;safeClientLog(A,"count",detail);}');
  assert.equal(result.summary.clientLogCalls, 2);
  assert.equal(result.summary.flaggedCalls, 1);
});
test('large declaration expression stays bounded', () => {
  const result = review('const detail = ' + 'x'.repeat(12_000) + ';\nsafeClientLog(A, "count", resultCount);');
  assert.equal(result.summary.clientLogCalls, 1);
  assert.equal(result.summary.flaggedCalls, 0);
});
test('retained evidence stays bounded while all unsafe aliases are counted', () => {
  const text = 'const detail = record.address;\n' +
    Array(12).fill('safeClientLog(A, "map", detail);').join('\n');
  const result = review(text);
  assert.equal(result.summary.flaggedCalls, 12);
  assert.equal(result.summary.retainedFindings, 8);
  assert.equal(result.findings.find(x => x.id.endsWith('overflow'))?.evidence?.value, 5);
});
test('finding metadata never stores original sensitive expression values', () => {
  const result = review('const detail = { address: "private-secret-marker" };\nsafeClientLog(A,"map",detail);');
  assert.equal(result.summary.flaggedCalls, 1);
  assert.ok(!JSON.stringify(result.findings).includes('private-secret-marker'));
});

test('mutable local aliases are re-evaluated after a safe assignment', () => {
  safe('let detail = record.address;\ndetail = resultCount;\nsafeClientLog(A, "count", detail);');
});
test('a mutable safe counter becomes unsafe when assigned a private source', () => {
  unsafe('let detail = resultCount;\ndetail = record.address;\nsafeClientLog(A, "map", detail);',
    'derived-sensitive-property');
});
test('a var alias is tracked through a later private assignment', () => {
  unsafe('var detail = resultCount;\ndetail = selection?.address;\nsafeClientLog(A, "map", detail);',
    'derived-sensitive-property');
});
test('mutable alias chaining retains the latest assigned value', () => {
  unsafe('let detail = resultCount;\nconst privateValue = record.address;\ndetail = privateValue;\n' +
    'safeClientLog(A, "map", detail);', 'derived-derived-sensitive-property');
});
test('property assignment cannot replace a plain mutable local', () => {
  unsafe('let detail = record.address;\nsettings.detail = resultCount;\nsafeClientLog(A, "map", detail);',
    'derived-sensitive-property');
});
test('a conditional inner assignment does not prove an outer private value safe', () => {
  unsafe('let detail = record.address;\nif (flag) { detail = resultCount; }\n' +
    'safeClientLog(A, "map", detail);', 'derived-sensitive-property');
});
test('inside the assignment block, later safe calls see the updated local', () => {
  safe('let detail = record.address;\nif (flag) { detail = resultCount;\n' +
    'safeClientLog(A, "count", detail); }');
});
test('immutable local values cannot be overridden by a spurious assignment', () => {
  unsafe('const detail = record.address;\ndetail = resultCount;\nsafeClientLog(A, "map", detail);',
    'derived-sensitive-property');
});
test('a property receiving private data does not invent a local binding', () => {
  safe('settings.detail = record.address;\nsafeClientLog(A, "count", detail);');
});
