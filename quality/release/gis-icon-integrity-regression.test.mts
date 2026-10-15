import assert from 'node:assert/strict';
import test from 'node:test';
import { auditGis } from './gis-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const registryPath = 'Webclient.app/src/gis-engine/iconRegistry.json';

interface IconRow {
  readonly id: string;
  readonly type?: string;
  readonly category?: string;
  readonly aliases?: readonly string[];
  readonly icon?: string;
}

function inspect(rows: readonly IconRow[]) {
  return auditGis(fixtureInventory([
    { path: registryPath, text: JSON.stringify(rows), kind: 'json' },
  ]));
}

function iconFindings(rows: readonly IconRow[]) {
  return inspect(rows).findings.filter(finding => finding.domain === 'icons');
}

test('missing default icon is a blocking release integrity violation', () => {
  const findings = iconFindings([{ id: 'park', icon: 'images/park.svg' }]);
  const missing = findings.find(item => item.id === 'gis-icon-default-missing');
  assert.equal(missing?.severity, 'critical');
  assert.equal(missing?.blocking, true);
  assert.equal(missing?.location?.file, registryPath);
});

test('default entry without an asset remains blocking', () => {
  const findings = iconFindings([{ id: 'default' }]);
  const missing = findings.find(item => item.id === 'gis-icon-entry-missing-asset');
  assert.equal(missing?.severity, 'critical');
  assert.equal(missing?.blocking, true);
});

test('normalization detects duplicate identifiers with case and accents', () => {
  const result = inspect([
    { id: 'Kütüphane', icon: 'images/library.svg' },
    { id: 'KUTUPHANE', icon: 'images/alternate-library.svg' },
    { id: 'default', icon: 'images/default.svg' },
  ]);
  assert.ok(result.summary.iconRegistry.duplicateKeys.includes('kutuphane'));
  assert.ok(result.findings.some(item =>
    item.id === 'gis-icon-duplicate-key' && item.severity === 'high'));
});

test('conflicting normalized aliases across different assets are reported', () => {
  const findings = iconFindings([
    { id: 'library-a', aliases: ['Kütüphane'], icon: 'images/library-a.svg' },
    { id: 'library-b', aliases: ['kutuphane'], icon: 'images/library-b.svg' },
    { id: 'default', icon: 'images/default.svg' },
  ]);
  assert.ok(findings.some(item =>
    item.id === 'gis-icon-alias-collision' && item.severity === 'medium'));
});

test('shared alias with the same icon asset is not a false collision', () => {
  const findings = iconFindings([
    { id: 'park-a', aliases: ['Yeşil Alan'], icon: 'images/park.svg' },
    { id: 'park-b', aliases: ['Yesil Alan'], icon: 'images/park.svg' },
    { id: 'default', icon: 'images/default.svg' },
  ]);
  assert.ok(!findings.some(item => item.id === 'gis-icon-alias-collision'));
});

test('malformed registry JSON is blocking rather than silently empty', () => {
  const result = auditGis(fixtureInventory([
    { path: registryPath, text: '{"entries":[', kind: 'json' },
  ]));
  const invalid = result.findings.find(item => item.id === 'gis-icon-registry-invalid-json');
  assert.equal(invalid?.severity, 'critical');
  assert.equal(invalid?.blocking, true);
});

test('registry object entries retain their stable keys', () => {
  const result = auditGis(fixtureInventory([
    {
      path: registryPath,
      kind: 'json',
      text: JSON.stringify({
        default: { icon: 'images/default.svg' },
        park: { icon: 'images/park.svg', aliases: ['parklar'] },
      }),
    },
  ]));
  assert.deepEqual(result.summary.iconRegistry.entries.map(item => item.key), [
    'default',
    'park',
  ]);
  assert.ok(!result.findings.some(item => item.id === 'gis-icon-default-missing'));
});

test('missing registry is a blocking finding and not a second icon authority', () => {
  const result = auditGis(fixtureInventory([]));
  const missing = result.findings.find(item => item.id === 'gis-icon-registry-missing');
  assert.equal(missing?.severity, 'critical');
  assert.equal(missing?.blocking, true);
  assert.equal(result.summary.iconRegistry.entries.length, 0);
});
