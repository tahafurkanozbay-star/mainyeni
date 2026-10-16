import assert from 'node:assert/strict';
import test from 'node:test';
import { auditClientLogPrivacy } from './client-log-privacy-audit.mts';
import { auditClientConsolePrivacy } from './client-console-privacy-audit.mts';
import { auditClientBrowserTransferPrivacy } from './client-browser-transfer-privacy-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const APP_FILE = 'Webclient.app/src/Components/AuthDiagnostics.ts';
const ADMIN_FILE = 'Webclient.admin/src/Components/AuthDiagnostics.ts';
const CREDENTIAL_FIELDS = [
  'token',
  'accessToken',
  'authToken',
  'bearerToken',
  'refreshToken',
  'idToken',
  'sessionToken',
  'authorization',
  'cookie',
  'cookies',
  'password',
  'secret',
  'apiKey',
  'clientSecret',
  'privateKey',
  'jwt',
  'session',
  'access_token',
  'refresh_token',
  'api_key',
  'client_secret',
];

function inspect(source: string, path = APP_FILE) {
  const inventory = fixtureInventory([{ path, text: source }]);
  return {
    log: auditClientLogPrivacy(inventory),
    console: auditClientConsolePrivacy(inventory),
    transfers: auditClientBrowserTransferPrivacy(inventory),
  };
}

for (const path of [APP_FILE, ADMIN_FILE]) {
  for (const field of CREDENTIAL_FIELDS) {
    test(`credential field ${field} is private across all client sinks (${path})`, () => {
      const source = [
        `safeClientLog(A, "auth", { ${field} });`,
        `console.warn({ ${field} });`,
        `window.postMessage({ ${field} }, "*");`,
        `sessionStorage.setItem("auth", JSON.stringify({ ${field} }));`,
      ].join('\n');
      const report = inspect(source, path);

      assert.equal(report.log.summary.flaggedCalls, 1, field);
      assert.equal(report.console.summary.unsafeCalls, 1, field);
      assert.equal(report.transfers.summary.sensitiveCalls, 2, field);
    });
  }
}

test('credential property, bracket access, serialization and renamed destructuring are traced', () => {
  const source = [
    'const { refreshToken: activeCredential } = session;',
    'safeClientLog(A, "auth", { activeCredential });',
    'console.warn(session.accessToken);',
    'window.postMessage({ value: auth["refreshToken"] }, "*");',
    'localStorage.setItem("session", JSON.stringify(session));',
  ].join('\n');
  const report = inspect(source);

  assert.equal(report.log.summary.flaggedCalls, 1);
  assert.equal(report.console.summary.unsafeCalls, 1);
  assert.equal(report.transfers.summary.sensitiveCalls, 2);
});

test('template interpolation containing a credential is classified as sensitive', () => {
  const report = inspect("const header = `Bearer ${session.accessToken}`; console.info(header);");
  assert.equal(report.console.summary.unsafeCalls, 1);
});

test('credential-bearing nested aliases remain sensitive after forwarding', () => {
  const source = [
    'const authSnapshot = { accessToken };',
    'function publish() {',
    '  window.postMessage({ authSnapshot }, "*");',
    '}',
  ].join('\n');
  const report = inspect(source);
  assert.equal(report.transfers.summary.sensitiveCalls, 1);
});

test('credential-like words in counters, labels, comments and inert strings remain safe', () => {
  const source = [
    'safeClientLog(A, "metrics", { tokenCount, sessionCount, apiKeyCount, passwordResetRequired, secretaryName });',
    'console.info("example { accessToken, password, token }");',
    '// window.postMessage({ refreshToken }, "*");',
    'const example = "localStorage.setItem(auth, accessToken)";',
    'window.postMessage({ event: "ready", count: 1 }, "*");',
    'sessionStorage.setItem("theme", "dark");',
  ].join('\n');
  const report = inspect(source);

  assert.equal(report.log.summary.flaggedCalls, 0);
  assert.equal(report.console.summary.unsafeCalls, 0);
  assert.equal(report.transfers.summary.sensitiveCalls, 0);
});

test('credential values never appear in privacy findings', () => {
  const source = [
    'const accessToken = "credential-secret-value-DO-NOT-LOG";',
    'console.warn({ accessToken });',
    'window.postMessage({ accessToken }, "*");',
  ].join('\n');
  const report = inspect(source);
  const serializedFindings = JSON.stringify({
    console: report.console.findings,
    transfers: report.transfers.findings,
  });

  assert.ok(!serializedFindings.includes('credential-secret-value-DO-NOT-LOG'));
});
