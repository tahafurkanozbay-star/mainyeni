import assert from 'node:assert/strict';
import test from 'node:test';
import { auditGis, runtimePresence } from './gis-audit.mts';
import { fixtureInventory, minimalIconRegistry, requiredGisRuntimeFiles } from './test-helpers.mts';

const fixtures = () => requiredGisRuntimeFiles();

test('all migrated TypeScript GIS runtimes satisfy the shared module contract', () => {
  const migrated = fixtures().map(file => ({
    ...file,
    path: file.path.replace(/\.js$/, '.ts'),
  }));
  const inventory = fixtureInventory([minimalIconRegistry(), ...migrated]);
  const presence = runtimePresence(inventory);
  assert.equal(presence.length, 13);
  assert.ok(presence.every(runtime => runtime.present));
  assert.equal(auditGis(inventory).findings.filter(finding =>
    finding.id.startsWith('gis-runtime-missing-')).length, 0);
});

test('legacy JavaScript runtimes remain valid during staged migration', () => {
  const presence = runtimePresence(fixtureInventory([minimalIconRegistry(), ...fixtures()]));
  assert.equal(presence.length, 13);
  assert.ok(presence.every(runtime => runtime.present));
});

test('mixed JavaScript and TypeScript runtimes remain valid', () => {
  const mixed = fixtures().map((file, index) => index % 2 === 0
    ? { ...file, path: file.path.replace(/\.js$/, '.ts') }
    : file);
  const presence = runtimePresence(fixtureInventory([minimalIconRegistry(), ...mixed]));
  assert.ok(presence.every(runtime => runtime.present));
});

test('missing both module extensions remains a blocking GIS finding', () => {
  const files = fixtures().filter(file => !file.path.endsWith('/sceneRuntime.js'));
  const inventory = fixtureInventory([minimalIconRegistry(), ...files]);
  const missing = runtimePresence(inventory).filter(runtime => !runtime.present);
  assert.equal(missing.length, 1);
  assert.match(missing[0]?.expectedPath ?? '', /sceneRuntime\.js$/);
  const findings = auditGis(inventory).findings;
  assert.ok(findings.some(finding =>
    finding.id === 'gis-runtime-missing-sceneRuntime-js' && finding.blocking === true));
});

test('backup and test files cannot impersonate a GIS runtime', () => {
  const presence = runtimePresence(fixtureInventory([
    minimalIconRegistry(),
    { path: 'Webclient.app/src/gis-engine/iconResolver.ts.bak', text: 'not a module' },
    { path: 'Webclient.app/src/gis-engine/sceneRuntime.test.ts', text: 'not a runtime' },
  ]));
  assert.equal(presence.filter(runtime => runtime.present).length, 1);
});
