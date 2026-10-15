import assert from 'node:assert/strict';
import test from 'node:test';
import { auditClientConsolePrivacy } from './client-console-privacy-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const app = 'Webclient.app/src/Components/Query/ConsoleOwner.tsx';
const admin = 'Webclient.admin/src/Components/Logs/AdminLogger.ts';
function review(text: string, path = app) {
  return auditClientConsolePrivacy(fixtureInventory([{ path, text }]));
}
function risky(text: string, reason: string, path = app): void {
  const report = review(text, path);
  assert.equal(report.summary.consoleCalls, 1);
  assert.equal(report.summary.unsafeCalls, 1);
  assert.equal(report.findings[0]?.evidence?.metadata?.reason, reason);
}
function safe(text: string): void {
  const report = review(text);
  assert.equal(report.summary.unsafeCalls, 0, JSON.stringify(report.findings));
}
test('direct address must not reach console.log', () => {
  risky('console.log(record.address);', 'sensitive-property');
});
test('private coordinates must not reach console.info', () => {
  risky('console.info("map", selection.coordinates);', 'sensitive-property');
});
test('query serialization must not reach console.warn', () => {
  risky('console.warn(JSON.stringify(query));', 'serialized-record-or-query');
});
test('query object cannot be passed as console.error detail', () => {
  risky('console.error("request failed", query);', 'raw-record-or-query');
});
test('optional console.debug calls are still executable data sinks', () => {
  risky('console?.debug?.(record.address);', 'sensitive-property');
});
test('console.table does not exempt potentially identifying records', () => {
  risky('console.table(record);', 'raw-record-or-query');
});
test('Admin console logging shares privacy guardrails', () => {
  risky('console.log(item.address);', 'sensitive-property', admin);
});
test('direct client logs and console logs are not counted as identical sinks', () => {
  const report = review('safeClientLog(A,"map",record.address);');
  assert.equal(report.summary.consoleCalls, 0);
});
test('constant event markers can be logged', () => {
  safe('console.info("bounded-cache-hit");');
});
test('bounded count values remain safe diagnostics', () => {
  safe('console.debug("records", Number(resultCount));');
});
test('an exception identifier does not automatically count as raw address data', () => {
  safe('console.error("service failed", error);');
});
test('data hidden behind a local alias remains unsafe', () => {
  risky('const detail = record.address;\nconsole.log(detail);', 'derived-sensitive-property');
});
test('renamed destructured address cannot evade console privacy', () => {
  risky('const { address: label } = record;\nconsole.info(label);', 'derived-sensitive-property');
});
test('mutably reassigned aliases use the latest source', () => {
  risky('let detail = resultCount;\ndetail = item.address;\nconsole.warn(detail);',
    'derived-sensitive-property');
});
test('proven safe replacement of a mutable private alias remains allowed', () => {
  safe('let detail = record.address;\ndetail = resultCount;\nconsole.info(detail);');
});
test('a string mentioning an unsafe console call is not executable', () => {
  safe('const example = "console.log(record.address)";');
});
test('a source comment mentioning unsafe console calls is not executable', () => {
  safe('/* console.log(record.address) */\n// console.error(query);');
});
test('template literal text containing console logging is inert', () => {
  safe('const guide = ' + '\x60console.log(record.address)\x60;');
});
test('template interpolation can execute a console call', () => {
  risky('const report = ' + '\x60result $' + '{console.log(record.address)}\x60;',
    'sensitive-property');
});
test('nested console arguments are parsed without splitting object values', () => {
  risky('console.warn({ count: 1, metadata: { address: record.address } });',
    'sensitive-object-key');
});
test('a quoted field name with an address payload is unsafe', () => {
  risky('console.warn({ "address": record.address });', 'sensitive-object-key');
});
test('mixed safe and unsafe arguments preserve privacy classification', () => {
  risky('console.info("metrics", resultCount, selection.coordinates);', 'sensitive-property');
});
test('the audit never stores sensitive payloads in finding evidence', () => {
  const report = review('const detail = { address: "private-token-value" };\nconsole.info(detail);');
  assert.equal(report.summary.unsafeCalls, 1);
  assert.ok(!JSON.stringify(report.findings).includes('private-token-value'));
});
test('per-file evidence is capped while unsafe calls remain counted', () => {
  const report = review(Array(12).fill('console.log(record.address);').join('\n'));
  assert.equal(report.summary.consoleCalls, 12);
  assert.equal(report.summary.unsafeCalls, 12);
  assert.equal(report.summary.retainedFindings, 8);
  assert.equal(report.findings.filter(item => item.id.endsWith('overflow')).length, 1);
  assert.equal(report.findings.find(item => item.id.endsWith('overflow'))?.evidence?.value, 5);
});
test('malformed logging calls cannot silently disappear', () => {
  const report = review('console.log({ address: record.address );');
  assert.equal(report.summary.unsafeCalls, 1);
  assert.equal(report.findings[0]?.evidence?.metadata?.reason, 'unreviewable-console-call');
});
test('a nested log in a different function cannot inherit a sibling alias', () => {
  safe('function a(){const detail = record.address;}\nfunction b(){console.log(detail);}');
});
test('an inherited parent alias inside a nested function remains sensitive', () => {
  risky('function outer(){const detail=record.address;\nfunction inner(){console.log(detail);}}',
    'derived-sensitive-property');
});
test('runtime-only scope excludes test directories', () => {
  const report = review('console.log(record.address);',
    'Webclient.app/src/Components/Query/ConsoleOwner.test.tsx');
  assert.equal(report.summary.runtimeFiles, 0);
  assert.equal(report.summary.unsafeCalls, 0);
});
test('unexpected file kinds cannot impersonate runtime logging', () => {
  const report = auditClientConsolePrivacy(fixtureInventory([
    { path: 'Webclient.app/src/style.css', text: 'console.log(record.address)', kind: 'css' },
  ]));
  assert.equal(report.summary.runtimeFiles, 0);
});
