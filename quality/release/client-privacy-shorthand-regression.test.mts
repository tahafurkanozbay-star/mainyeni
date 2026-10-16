import assert from 'node:assert/strict';
import test from 'node:test';
import { auditClientLogPrivacy } from './client-log-privacy-audit.mts';
import { auditClientConsolePrivacy } from './client-console-privacy-audit.mts';
import { auditClientBrowserTransferPrivacy } from './client-browser-transfer-privacy-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const app = 'Webclient.app/src/features/PrivacyBoundary.ts';
const admin = 'Webclient.admin/src/features/PrivacyBoundary.ts';

function audit(source: string, path: string) {
  const input = fixtureInventory([{ path, text: source }]);
  return {
    log: auditClientLogPrivacy(input),
    console: auditClientConsolePrivacy(input),
    browser: auditClientBrowserTransferPrivacy(input),
  };
}

test('first, later and nested shorthand fields cannot hide sensitive client-log records', () => {
  const cases = [
    '{ query }',
    '{ record, count: resultCount }',
    '{ count: resultCount, location }',
    '{ outer: { coordinates } }',
    '{ count: 2, detail: { address, result: 3 } }',
    'JSON.stringify({ query })',
    'Object.freeze({ record })',
    '{ ...safeCount, item }',
  ];
  for (const path of [app, admin]) {
    for (const payload of cases) {
      const result = audit(`safeClientLog(LoggingBusiness, "search", ${payload});`, path);
      assert.equal(result.log.summary.flaggedCalls, 1, `${path}: ${payload}`);
      assert.equal(result.log.findings[0]?.evidence?.metadata?.reason,
        'shorthand-sensitive-value', payload);
      assert.equal(result.log.findings[0]?.severity, 'high');
    }
  }
});

test('shorthand private values remain unsafe across browser console and transfer sinks', () => {
  const expressions = [
    ['console.info({ query });', 'console'],
    ['console.warn("search", { payload, count: 2 });', 'console'],
    ['console.table(Object.freeze({ item }));', 'console'],
    ['window.postMessage({ query }, "*");', 'browser'],
    ['navigator.sendBeacon("/api", JSON.stringify({ record }));', 'browser'],
    ['sessionStorage.setItem("recent", JSON.stringify({ location }));', 'browser'],
    ['history.replaceState(null, "", stringify({ address }));', 'browser'],
  ] as const;
  for (const path of [app, admin]) {
    for (const [source, sink] of expressions) {
      const result = audit(source, path);
      const report = sink === 'console' ? result.console : result.browser;
      const count = sink === 'console'
        ? result.console.summary.unsafeCalls : result.browser.summary.sensitiveCalls;
      assert.equal(count, 1, `${path}: ${source}`);
      assert.equal(report.findings[0]?.evidence?.metadata?.reason, 'shorthand-sensitive-value');
      assert.equal(JSON.stringify(report.findings).includes('JSON.stringify({'), false);
    }
  }
});

test('quoted shorthand examples, property names and safe counters are not classified as private', () => {
  const safePayloads = [
    '{ queryCount, resultCount }',
    '{ count: queryCount }',
    '{ label: "{ query }" }',
    '{ requestCount: resultCount }',
    '{ activeCount: 7 }',
    '{ note: "record, location, address" }',
    'JSON.stringify({ count: resultCount })',
    'Object.freeze({ serviceKey, count: resultCount })',
    '{ count: resultCount, text: "sensitive { record }" }',
  ];
  for (const payload of safePayloads) {
    const source = [
      `safeClientLog(LoggingBusiness, "safe", ${payload});`,
      `console.log(${payload});`,
      `window.postMessage(${payload}, "*");`,
    ].join('\n');
    const result = audit(source, app);
    assert.equal(result.log.summary.flaggedCalls, 0, payload);
    assert.equal(result.console.summary.unsafeCalls, 0, payload);
    assert.equal(result.browser.summary.sensitiveCalls, 0, payload);
  }
});

test('aliased sensitive shorthand retains provenance and source-free findings', () => {
  const source = [
    'const redactedLabel = record.address;',
    'console.info({ redactedLabel });',
    'safeClientLog(LoggingBusiness, "map", { redactedLabel });',
    'window.postMessage({ redactedLabel }, "*");',
  ].join('\n');
  const result = audit(source, app);
  assert.equal(result.console.summary.unsafeCalls, 1);
  assert.equal(result.log.summary.flaggedCalls, 1);
  assert.equal(result.browser.summary.sensitiveCalls, 1);
  for (const findings of [result.console.findings, result.log.findings, result.browser.findings]) {
    assert.equal(findings.length, 1);
    assert.ok(!JSON.stringify(findings).includes('record.address'));
  }
});

test('shorthand examples inside comments never become executable sink calls', () => {
  const result = audit('// console.warn({ query });\n/* window.postMessage({ record }); */', admin);
  assert.equal(result.console.summary.consoleCalls, 0);
  assert.equal(result.browser.summary.transferCalls, 0);
});
