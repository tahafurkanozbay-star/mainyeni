import assert from 'node:assert/strict';
import test from 'node:test';
import { auditClientLogPrivacy } from './client-log-privacy-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const path = 'Webclient.app/src/Components/Query/PrivateRecord.tsx';
function review(source: string) {
  return auditClientLogPrivacy(fixtureInventory([{ path, text: source }]));
}
function flag(source: string, reason: string): void {
  const report = review(source);
  assert.equal(report.summary.clientLogCalls, 1);
  assert.equal(report.summary.flaggedCalls, 1, JSON.stringify(report.findings));
  assert.equal(report.findings[0]?.evidence?.metadata?.reason, reason);
}
function clear(source: string): void {
  assert.equal(review(source).summary.flaggedCalls, 0);
}
test('renaming an address property does not sanitize the data', () => {
  flag('const { address: label } = record;\nsafeClientLog(A,"detail",label);',
    'derived-sensitive-property');
});
test('street properties renamed locally retain privacy classification', () => {
  flag('const { street: display } = item;\nsafeClientLog(A,"map",display);',
    'derived-sensitive-property');
});
test('coordinates cannot be logged via renamed destructuring', () => {
  flag('const { coordinates: point } = selection;\nsafeClientLog(A,"map",point);',
    'derived-sensitive-property');
});
test('Admin-style neighborhood properties retain sensitive meaning', () => {
  flag('const { mahalle: district } = params;\nsafeClientLog(A,"search",district);',
    'derived-sensitive-property');
});
test('destructured latitude retains private map position', () => {
  flag('const { latitude: north } = record;\nsafeClientLog(A,"map",north);',
    'derived-sensitive-property');
});
test('destructured longitude retains private map position', () => {
  flag('const { longitude: east } = record;\nsafeClientLog(A,"map",east);',
    'derived-sensitive-property');
});
test('destructured address of unknown object remains privacy sensitive', () => {
  flag('const { address: display } = response;\nsafeClientLog(A,"detail",display);',
    'derived-sensitive-property');
});
test('renamed non-sensitive counter is not automatically tainted', () => {
  clear('const { count: display } = response;\nsafeClientLog(A,"count",display);');
});
test('destructuring literal safe text does not imply live user data', () => {
  clear('const { address: display } = { address: "anonymous" };\nsafeClientLog(A,"safe",display);');
});
test('a rest alias of the entire private record cannot be logged', () => {
  flag('const { count, ...rest } = record;\nsafeClientLog(A,"detail",rest);',
    'derived-raw-record-or-query');
});
test('rest alias from a private query remains sensitive', () => {
  flag('const { safeCount, ...rest } = query;\nsafeClientLog(A,"search",rest);',
    'derived-raw-record-or-query');
});
test('a rest alias from an unrelated statistics object remains safe', () => {
  clear('const { count, ...rest } = stats;\nsafeClientLog(A,"count",rest);');
});
test('first coordinate element cannot be passed under an unrelated name', () => {
  flag('const [first] = coordinates;\nsafeClientLog(A,"map",first);',
    'derived-raw-record-or-query');
});
test('location arrays retain private coordinates when renamed', () => {
  flag('const [north, east] = location;\nsafeClientLog(A,"map",east);',
    'derived-raw-record-or-query');
});
test('a numeric counter array does not automatically taint', () => {
  clear('const [one] = numericCounts;\nsafeClientLog(A,"count",one);');
});
test('destructured mutable alias becomes safe after a proven count assignment', () => {
  clear('let { address: label } = record;\nlabel = resultCount;\nsafeClientLog(A,"count",label);');
});
test('destructured mutable alias becomes unsafe after a later private assignment', () => {
  flag('let { address: label } = record;\nlabel = record.address;\nsafeClientLog(A,"map",label);',
    'derived-sensitive-property');
});
test('a later direct property assignment cannot replace a private alias', () => {
  flag('let { address: label } = record;\nwidget.label = resultCount;\nsafeClientLog(A,"map",label);',
    'derived-sensitive-property');
});
test('a sibling function cannot capture a destructured private alias', () => {
  clear('function a(){const {address: label}=record;}\nfunction b(){safeClientLog(A,"count",label);}');
});
test('a nested child function sees a destructured private parent variable', () => {
  flag('function a(){const {address: label}=record;\nfunction child(){safeClientLog(A,"map",label);}}',
    'derived-sensitive-property');
});
test('literal source evidence is not retained in a privacy finding', () => {
  const report = review('const {address: label}=record;\nsafeClientLog(A,"private-token",label);');
  assert.equal(report.summary.flaggedCalls, 1);
  assert.ok(!JSON.stringify(report.findings).includes('private-token'));
});
test('privacy evidence remains capped for repeated destructured aliases', () => {
  const report = review('const {address: label}=record;\n' +
    Array(12).fill('safeClientLog(A,"map",label);').join('\n'));
  assert.equal(report.summary.flaggedCalls, 12);
  assert.equal(report.summary.retainedFindings, 8);
});
