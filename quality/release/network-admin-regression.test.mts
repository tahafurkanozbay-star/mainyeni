import assert from 'node:assert/strict';
import test from 'node:test';
import { auditNetwork } from './network-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const admin = 'Webclient.admin/src/features/reports/ReportPanel.ts';
const app = 'Webclient.app/src/features/map/MapPanel.ts';

function inspect(...files: { path: string; text: string; kind?: 'typescript' | 'css' }[]) {
  return auditNetwork(fixtureInventory(files));
}

test('Admin SPA HTTP references are reviewed alongside ordinary Webclient sources', () => {
  const report = inspect(
    { path: admin, text: 'export const service = "http://example.test/service";' },
    { path: app, text: 'export const service = "https://example.test/service";' },
  );
  assert.equal(report.summary.insecureCount, 1);
  assert.equal(report.summary.references.length, 2);
  assert.equal(report.findings.find(item => item.id === 'network-insecure-http')?.location?.file, admin);
});

test('Admin remote assets, fonts and third-party analytics remain visible', () => {
  const report = inspect(
    { path: 'Webclient.admin/src/theme.css', kind: 'css', text: '@import url("https://fonts.googleapis.com/css2?family=Inter");' },
    { path: admin, text: 'const endpoint = "https://analytics.example.test/collect";' },
    { path: 'Webclient.admin/src/ui/Icon.ts', text: 'const icon = "https://cdn.example.test/pin.svg";' },
  );
  assert.ok(report.findings.some(item => item.id === 'network-remote-font'));
  assert.ok(report.findings.some(item => item.id === 'network-third-party-analytics'));
  assert.ok(report.findings.some(item => item.id === 'network-remote-runtime-asset'));
});

test('Admin direct fetch outside centralized transport is audited', () => {
  const report = inspect(
    { path: admin, text: "const load = () => fetch('/api/reports');" },
    { path: 'Webclient.admin/src/platform/http/client.ts', text: "const load = () => fetch('/api/reports');" },
  );
  assert.equal(report.summary.directFetchCalls, 2);
  assert.equal(report.findings.filter(item => item.id === 'network-direct-fetch-outside-transport').length, 1);
  assert.equal(report.findings.find(item => item.id === 'network-direct-fetch-outside-transport')?.location?.file, admin);
});

test('Admin test code and generated assets are excluded from runtime network evidence', () => {
  const insecure = 'const endpoint = "http://example.test/leak";';
  const report = inspect(
    { path: 'Webclient.admin/src/__tests__/network.ts', text: insecure },
    { path: 'Webclient.admin/src/features/network.test.ts', text: insecure },
    { path: 'Webclient.admin/src/fixtures/network.ts', text: insecure },
    { path: 'Webclient.admin/src/features/network.ts', text: "const endpoint = '/api';" },
  );
  assert.equal(report.summary.insecureCount, 0);
  assert.equal(report.summary.references.length, 0);
});
