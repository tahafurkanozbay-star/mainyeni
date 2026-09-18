import assert from 'node:assert/strict';
import test from 'node:test';
import { auditSecurity } from './security-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

function audit(path: string, text: string) {
  return auditSecurity(fixtureInventory([{ path, text }]));
}

function ids(path: string, text: string): string[] {
  return audit(path, text).findings.map(finding => finding.id);
}

test('flags raw HTML sinks in browser source', () => {
  assert.ok(ids(
    'Webclient.app/src/View.tsx',
    '<div dangerouslySetInnerHTML={{ __html: html }} />',
  ).includes('security-unsafe-html-sink'));
});

test('flags dynamic execution as blocking', () => {
  const section = audit(
    'Webclient.app/src/run.ts',
    'const output = eval(code);',
  );
  const finding = section.findings.find(item => item.id === 'security-dynamic-code-execution');
  assert.ok(finding);
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.blocking, true);
});

test('flags bearer token persistence in local storage', () => {
  assert.ok(ids(
    'Webclient.app/src/auth.ts',
    'localStorage.setItem("accessToken", token);',
  ).includes('security-browser-token-storage'));
});

test('does not flag non-sensitive preference storage', () => {
  assert.ok(!ids(
    'Webclient.app/src/theme.ts',
    'localStorage.setItem("theme", theme);',
  ).includes('security-browser-token-storage'));
});

test('flags wildcard backend CORS', () => {
  assert.ok(ids(
    'Webclient.Business/Program.cs',
    'policy.AllowAnyOrigin();',
  ).includes('security-permissive-cors'));
});

test('flags disabled certificate validation', () => {
  const text = [
    'handler.ServerCertificateCustomValidationCallback =',
    '  (_, certificate, chain, errors) => true;',
  ].join('\n');
  const section = audit('Webclient.Business/Http.cs', text);
  const finding = section.findings.find(item => item.id === 'security-tls-validation-disabled');
  assert.ok(finding);
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.blocking, true);
});

test('flags interpolated SQL command candidates', () => {
  const text = 'var cmd = new SqlCommand($"select * from x where id={id}");';
  const section = audit('Webclient.Business/Repo.cs', text);
  const finding = section.findings.find(item => item.id === 'security-sql-interpolation');
  assert.ok(finding);
  assert.equal(finding.blocking, true);
});

test('ignores typed release audit implementation fixtures', () => {
  const section = audit(
    'quality/release/fixture.ts',
    'const output = eval(code);',
  );
  assert.equal(section.findings.length, 0);
});

test('ignores regular test files', () => {
  const section = audit(
    'Webclient.app/src/__tests__/x.ts',
    'const output = eval(code);',
  );
  assert.equal(section.findings.length, 0);
});

test('reports deterministic per-rule counts', () => {
  const section = audit(
    'Webclient.app/src/a.ts',
    'eval(a);\neval(b);',
  );
  assert.deepEqual(section.summary.findingsByRule, {
    'security-dynamic-code-execution': 2,
  });
});

test('caps repeated source findings to bounded diagnostics', () => {
  const source = Array.from({ length: 20 }, (_, index) => `eval(code${index});`).join('\n');
  const section = audit('Webclient.app/src/repeated.ts', source);
  const findings = section.findings.filter(item => item.id === 'security-dynamic-code-execution');
  assert.ok(findings.length > 0);
  assert.ok(findings.length <= 12);
});

test('records scanned-file and unsafe-html summary metrics', () => {
  const section = auditSecurity(fixtureInventory([
    {
      path: 'Webclient.app/src/a.tsx',
      text: '<div dangerouslySetInnerHTML={{ __html: html }} />',
    },
    {
      path: 'Webclient.app/src/b.ts',
      text: 'export const b = 1;',
    },
  ]));
  assert.equal(section.summary.scannedFiles, 2);
  assert.equal(section.summary.unsafeHtmlCandidates, 1);
});

test('records dynamic execution summary metrics', () => {
  const section = auditSecurity(fixtureInventory([
    {
      path: 'Webclient.app/src/a.ts',
      text: 'eval(code);',
    },
    {
      path: 'Webclient.app/src/b.ts',
      text: 'Function(source);',
    },
  ]));
  assert.equal(section.summary.dynamicExecutionCandidates, 2);
});

test('records browser storage summary metrics', () => {
  const section = auditSecurity(fixtureInventory([
    {
      path: 'Webclient.app/src/auth.ts',
      text: 'localStorage.setItem("refreshToken", token);',
    },
  ]));
  assert.equal(section.summary.insecureStorageCandidates, 1);
});

test('records permissive CORS summary metrics', () => {
  const section = auditSecurity(fixtureInventory([
    {
      path: 'Api.Core/Program.cs',
      text: 'policy.AllowAnyOrigin();',
    },
  ]));
  assert.equal(section.summary.permissiveCorsCandidates, 1);
});

test('clean browser and backend fixtures remain finding-free', () => {
  const section = auditSecurity(fixtureInventory([
    {
      path: 'Webclient.app/src/safe.tsx',
      text: 'export const View = ({ label }) => <span>{label}</span>;',
    },
    {
      path: 'Api.Core/Safe.cs',
      text: 'builder.WithOrigins("https://example.invalid");',
    },
  ]));
  assert.equal(section.findings.length, 0);
});
