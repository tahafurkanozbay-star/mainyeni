import assert from 'node:assert/strict';
import test from 'node:test';
import { auditClientBrowserTransferPrivacy } from './client-browser-transfer-privacy-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const app = 'Webclient.app/src/Components/Query/BrowserTransfer.tsx';
const admin = 'Webclient.admin/src/platform/browserTransfer.ts';

function review(source: string, path = app) {
  return auditClientBrowserTransferPrivacy(fixtureInventory([{ path, text: source }]));
}
function risky(source: string, reason: string, sink: string, path = app): void {
  const report = review(source, path);
  assert.equal(report.summary.transferCalls, 1);
  assert.equal(report.summary.sensitiveCalls, 1, JSON.stringify(report.findings));
  assert.equal(report.findings[0]?.evidence?.metadata?.sink, sink);
  assert.equal(report.findings[0]?.evidence?.metadata?.reason, reason);
}
function safe(source: string): void {
  const report = review(source);
  assert.equal(report.summary.sensitiveCalls, 0, JSON.stringify(report.findings));
}
test('cross-window postMessage may not forward a private record', () => {
  risky('window.postMessage(record, "*");', 'raw-record-or-query', 'message');
});
test('postMessage to a named origin still must not carry raw coordinates', () => {
  risky('parent.postMessage(selection.coordinates, "https://trusted.test");',
    'sensitive-property', 'message');
});
test('opener messaging has the same privacy boundary', () => {
  risky('opener.postMessage(record.address, "*");', 'sensitive-property', 'message');
});
test('optional postMessage invocation remains visible', () => {
  risky('window?.postMessage?.(record.address, "*");', 'sensitive-property', 'message');
});
test('bare postMessage with a private argument is visible', () => {
  risky('postMessage(query, "*");', 'raw-record-or-query', 'message');
});
test('sendBeacon only inspects the data argument, not the destination label', () => {
  risky('navigator.sendBeacon("/api", record.address);', 'sensitive-property', 'beacon');
});
test('optional navigator.sendBeacon preserves the data privacy boundary', () => {
  risky('navigator?.sendBeacon?.("/api", query);', 'raw-record-or-query', 'beacon');
});
test('sessionStorage cannot persist private address payloads', () => {
  risky('sessionStorage.setItem("history", record.address);', 'sensitive-property', 'storage');
});
test('localStorage cannot persist raw query records', () => {
  risky('localStorage.setItem("query", JSON.stringify(query));',
    'serialized-record-or-query', 'storage');
});
test('optional storage invocation remains a sink', () => {
  risky('sessionStorage?.setItem?.("state", selection.coordinates);',
    'sensitive-property', 'storage');
});
test('browser history URL parameter must not embed user address data', () => {
  risky('history.pushState({}, "", record.address);', 'sensitive-property', 'url-history');
});
test('history replacement must protect location query values', () => {
  risky('window.history.replaceState(null, "", query);', 'raw-record-or-query', 'url-history');
});
test('history metadata values are separate from the URL transfer argument', () => {
  safe('history.replaceState({ query: record.address }, "", "/map");');
});
test('safe static browser message markers are allowed', () => {
  safe('window.postMessage("ready", "*");');
});
test('safe bounded numeric messages are allowed', () => {
  safe('postMessage(Number(resultCount), "*");');
});
test('beacon destination strings are not mistaken for payloads', () => {
  safe('navigator.sendBeacon("/logs?address=schema", "ready");');
});
test('storage of a fixed UI preference is not flagged', () => {
  safe('localStorage.setItem("theme", "dark");');
});
test('a static URL does not become a false history privacy finding', () => {
  safe('history.replaceState({}, "", "/map?theme=dark");');
});
test('an address alias used through a transfer remains sensitive', () => {
  risky('const detail = record.address;\nwindow.postMessage(detail, "*");',
    'derived-sensitive-property', 'message');
});
test('a three-step private alias chain cannot evade storage checks', () => {
  risky('const source = record.address;\nconst one = source;\nconst two = one;\n' +
    'sessionStorage.setItem("recent", two);',
    'derived-derived-derived-sensitive-property', 'storage');
});
test('renamed destructured coordinates remain private in a beacon', () => {
  risky('const { coordinates: point } = selection;\nnavigator.sendBeacon("/api", point);',
    'derived-sensitive-property', 'beacon');
});
test('mutably reassigned private data still gets flagged', () => {
  risky('let data = resultCount;\ndata = record.address;\npostMessage(data, "*");',
    'derived-sensitive-property', 'message');
});
test('proven safe local assignment replaces a prior private source', () => {
  safe('let data = record.address;\ndata = resultCount;\npostMessage(data, "*");');
});
test('a nested closure can inherit a private outer alias', () => {
  risky('function outer(){const detail=record.address;\nfunction inner(){postMessage(detail, "*");}}',
    'derived-sensitive-property', 'message');
});
test('sibling functions cannot share unowned local aliases', () => {
  safe('function a(){const data=record.address;}\nfunction b(){postMessage(data, "*");}');
});
test('the Admin SPA is included under the same classifier', () => {
  risky('window.postMessage(query, "*");', 'raw-record-or-query', 'message', admin);
});
test('comments cannot introduce a fake private browser transfer', () => {
  safe('// window.postMessage(record.address, "*");\n/* sendBeacon("/x", query); */');
});
test('quoted documentation examples are never treated as calls', () => {
  safe('const example = "localStorage.setItem(\\"history\\", record.address)";');
});
test('inert template text does not introduce transfer calls', () => {
  safe('const example = ' + '\x60history.pushState({}, "", record.address)\x60;');
});
test('interpolated expressions can execute a private transfer', () => {
  risky('const value = ' + '\x60map $' + '{postMessage(record.address, "*")}\x60;',
    'sensitive-property', 'message');
});
test('the same expression must not count twice through two rules', () => {
  const report = review('window.postMessage(record.address, "*");');
  assert.equal(report.summary.transferCalls, 1);
  assert.equal(report.summary.messageCalls, 1);
});
test('different browser sinks are counted separately', () => {
  const report = review('postMessage(record.address, "*");\n' +
    'navigator.sendBeacon("/api", query);\n' +
    'sessionStorage.setItem("map", selection.coordinates);\n' +
    'history.pushState({}, "", record.address);');
  assert.equal(report.summary.transferCalls, 4);
  assert.equal(report.summary.sensitiveCalls, 4);
  assert.equal(report.summary.messageCalls, 1);
  assert.equal(report.summary.beaconCalls, 1);
  assert.equal(report.summary.storageCalls, 1);
  assert.equal(report.summary.urlHistoryCalls, 1);
});
test('malformed transfer arguments fail closed', () => {
  const report = review('window.postMessage({ address: record.address );');
  assert.equal(report.summary.sensitiveCalls, 1);
  assert.equal(report.findings[0]?.evidence?.metadata?.reason, 'unreviewable-transfer-call');
});
test('oversized transfer call does not retain private payloads in findings', () => {
  const source = 'window.postMessage(record.address' + ' '.repeat(9000) + ', "*");';
  const report = review(source);
  assert.equal(report.summary.sensitiveCalls, 1);
  assert.ok(!JSON.stringify(report.findings).includes('record.address'));
});
test('exact source positions survive Unicode before an unsafe transfer', () => {
  const report = review('const marker = "🌐";\npostMessage(record.address, "*");');
  assert.equal(report.findings[0]?.location?.line, 2);
});
test('per-file evidence budget never suppresses risk counts', () => {
  const report = review(Array(12).fill('window.postMessage(record.address, "*");').join('\n'));
  assert.equal(report.summary.transferCalls, 12);
  assert.equal(report.summary.sensitiveCalls, 12);
  assert.equal(report.summary.retainedFindings, 8);
  assert.equal(report.findings.find(x => x.id.endsWith('overflow'))?.evidence?.value, 5);
});
test('overflow from one file cannot suppress another file report', () => {
  const report = auditClientBrowserTransferPrivacy(fixtureInventory([
    { path: app, text: Array(10).fill('postMessage(record.address, "*");').join('\n') },
    { path: admin, text: 'sessionStorage.setItem("query", query);' },
  ]));
  assert.equal(report.summary.sensitiveCalls, 11);
  assert.equal(report.summary.retainedFindings, 9);
});
test('test and fixture directories cannot generate production findings', () => {
  const report = auditClientBrowserTransferPrivacy(fixtureInventory([
    { path: 'Webclient.app/src/__tests__/browser.test.ts', text: 'postMessage(record.address, "*");' },
    { path: 'Webclient.admin/src/fixtures/external.ts', text: 'navigator.sendBeacon("/x", query);' },
  ]));
  assert.equal(report.summary.runtimeFiles, 0);
});
test('JSON config files cannot masquerade as source code', () => {
  const report = auditClientBrowserTransferPrivacy(fixtureInventory([
    { path: 'Webclient.app/src/settings.json', kind: 'json', text: 'postMessage(record.address, "*");' },
  ]));
  assert.equal(report.summary.runtimeFiles, 0);
});
test('the classifier never serializes private URL, query or location payloads', () => {
  const report = review('const location = record.address;\npostMessage(location, "*");');
  assert.equal(report.findings.length, 1);
  assert.ok(!JSON.stringify(report.findings).includes('record.address'));
  assert.ok(!JSON.stringify(report.findings).includes('location ='));
});
test('safe identifiers that resemble field names remain safe after masking', () => {
  safe('const label = "record.address";\npostMessage(label, "*");');
});
test('a later private assignment cannot taint an earlier safe transfer', () => {
  safe('postMessage(data, "*");\nconst data = record.address;');
});
