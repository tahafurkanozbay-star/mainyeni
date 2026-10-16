import assert from 'node:assert/strict';
import test from 'node:test';
import { auditClientLogPrivacy } from './client-log-privacy-audit.mts';
import { auditClientConsolePrivacy } from './client-console-privacy-audit.mts';
import { auditClientBrowserTransferPrivacy } from './client-browser-transfer-privacy-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const app = 'Webclient.app/src/Components/Query/ShorthandLogger.tsx';
const admin = 'Webclient.admin/src/Components/Query/ShorthandLogger.ts';

function review(text: string, path = app) {
  const inventory = fixtureInventory([{ path, text }]);
  return {
    log: auditClientLogPrivacy(inventory),
    console: auditClientConsolePrivacy(inventory),
    transfers: auditClientBrowserTransferPrivacy(inventory),
  };
}

test('shorthand query is rejected at first-party client logger', () => {
  const report = review('safeClientLog(A, "search", { query });');
  assert.equal(report.log.summary.flaggedCalls, 1);
  assert.equal(report.log.findings[0]?.evidence?.metadata?.reason, 'shorthand-sensitive-value');
});

test('nested shorthand query remains a private client log payload', () => {
  const report = review('safeClientLog(A, "search", { meta: { query } });');
  assert.equal(report.log.summary.flaggedCalls, 1);
  assert.equal(report.log.findings[0]?.severity, 'high');
});

test('renamed local object alias cannot hide shorthand payload', () => {
  const report = review('const data = { record }; safeClientLog(A, "search", data);');
  assert.equal(report.log.summary.flaggedCalls, 1);
  assert.ok(String(report.log.findings[0]?.evidence?.metadata?.reason).includes('shorthand'));
});

test('console.info cannot publish shorthand coordinates', () => {
  const report = review('console.info("map", { coordinates });');
  assert.equal(report.console.summary.unsafeCalls, 1);
  assert.equal(report.console.findings[0]?.evidence?.metadata?.reason, 'shorthand-sensitive-value');
});

test('Admin console shares the shorthand security classification', () => {
  const report = review('console.log({ payload });', admin);
  assert.equal(report.console.summary.unsafeCalls, 1);
  assert.equal(report.console.findings[0]?.location?.file, admin);
});

test('postMessage cannot broadcast shorthand private record', () => {
  const report = review('window.postMessage({ record }, "*");');
  assert.equal(report.transfers.summary.sensitiveCalls, 1);
  assert.equal(report.transfers.findings[0]?.evidence?.metadata?.sink, 'message');
});

test('sendBeacon JSON wrapper does not sanitize location shorthand', () => {
  const report = review('navigator.sendBeacon("/events", JSON.stringify({ location }));');
  assert.equal(report.transfers.summary.sensitiveCalls, 1);
  assert.equal(report.transfers.findings[0]?.evidence?.metadata?.sink, 'beacon');
});

test('sessionStorage cannot save shorthand raw query', () => {
  const report = review('sessionStorage.setItem("recent", JSON.stringify({ query }));');
  assert.equal(report.transfers.summary.sensitiveCalls, 1);
  assert.equal(report.transfers.findings[0]?.evidence?.metadata?.sink, 'storage');
});

test('history URL still catches wrapped query strings', () => {
  const report = review('history.pushState({}, "", String(query));');
  assert.equal(report.transfers.summary.sensitiveCalls, 1);
  assert.equal(report.transfers.findings[0]?.evidence?.metadata?.sink, 'url-history');
});

test('object metadata with safe bounded counters is not private', () => {
  const report = review('console.debug({ count: resultCount });');
  assert.equal(report.console.summary.unsafeCalls, 0);
});

test('message only carrying a literal readiness marker is safe', () => {
  const report = review('window.postMessage({ event: "ready" }, "*");');
  assert.equal(report.transfers.summary.sensitiveCalls, 0);
});

test('storage of a static theme marker is not a private transfer', () => {
  const report = review('localStorage.setItem("theme", "dark");');
  assert.equal(report.transfers.summary.sensitiveCalls, 0);
});

test('a quoted shorthand example is not a data transfer', () => {
  const report = review('console.info({ message: "example { query }" });');
  assert.equal(report.console.summary.unsafeCalls, 0);
});

test('comments and strings do not create executable privacy sinks', () => {
  const report = review('// console.log({ record });\nconst example = "postMessage({ query })";');
  assert.equal(report.console.summary.consoleCalls, 0);
  assert.equal(report.transfers.summary.transferCalls, 0);
});

test('runtime security evidence reports only reason codes, never user payload', () => {
  const report = review('const record = { address: "non-public-location" }; console.warn({ record });');
  assert.equal(report.console.summary.unsafeCalls, 1);
  assert.ok(!JSON.stringify(report.console.findings).includes('non-public-location'));
});

test('test and fixture files cannot create production privacy findings', () => {
  const report = review('console.log({ query });', 'Webclient.app/src/features/query.test.ts');
  assert.equal(report.console.summary.runtimeFiles, 0);
  assert.equal(report.console.summary.unsafeCalls, 0);
});
