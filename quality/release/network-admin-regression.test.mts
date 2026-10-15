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


test('App test fixtures cannot manufacture production plain-HTTP regressions', () => {
  const literal = 'const url = "http://user:secret@gis.example.test/arcgis/MapServer";';
  const report = inspect(
    { path: 'Webclient.app/src/gis-engine/serviceCatalog.test.ts', text: literal },
    { path: 'Webclient.app/src/platform/platform.spec.ts', text: literal },
    { path: 'Webclient.app/src/Toolbox/__tests__/RecordSchemaRuntime.ts', text: literal },
    { path: 'Webclient.app/src/fixtures/gis/network.ts', text: literal },
    { path: 'Webclient.app/src/data/mock/mockService.ts', text: literal },
    { path: 'Webclient.admin/src/gis/network.test.ts', text: literal },
    { path: 'Webclient.app/src/gis-engine/serviceCatalog.ts', text: 'const url = "/gis/safe";' },
  );
  assert.equal(report.summary.insecureCount, 0);
  assert.equal(report.summary.references.length, 0);
  assert.equal(report.findings.filter(item => item.id === 'network-insecure-http').length, 0);
});

test('App and Admin production sources still fail closed on insecure HTTP', () => {
  const report = inspect(
    { path: 'Webclient.app/src/gis-engine/serviceCatalog.ts', text: 'const url = "http://gis.example.test/arcgis/MapServer";' },
    { path: 'Webclient.admin/src/gis/network.ts', text: 'const url = "http://admin.example.test/api";' },
    { path: 'Webclient.app/src/gis-engine/serviceCatalog.test.ts', text: 'const url = "http://example.test/fake";' },
  );
  assert.equal(report.summary.insecureCount, 2);
  assert.equal(report.summary.references.length, 2);
  const insecure = report.findings.filter(item => item.id === 'network-insecure-http');
  assert.equal(insecure.length, 2);
  assert.deepEqual(insecure.map(item => item.location?.file).sort(), [
    'Webclient.admin/src/gis/network.ts',
    'Webclient.app/src/gis-engine/serviceCatalog.ts',
  ]);
});

test('App test fixtures cannot inflate fetch or third-party analytics counters', () => {
  const report = inspect(
    { path: 'Webclient.app/src/queries/query.test.tsx', text: 'fetch("https://analytics.example.test/collect")' },
    { path: 'Webclient.app/src/queries/fixture/index.ts', text: 'fetch("https://analytics.example.test/collect")' },
    { path: 'Webclient.app/src/queries/query.ts', text: 'const safe = () => fetch("/api/search");' },
  );
  assert.equal(report.summary.directFetchCalls, 1);
  assert.equal(report.summary.absoluteFetchCalls, 0);
  assert.ok(!report.findings.some(item => item.id === 'network-third-party-analytics'));
});
